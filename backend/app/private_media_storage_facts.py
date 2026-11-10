"""One approved, fixed-project bucket metadata GET; no media admission implied.

Only the returned bucket settings and acceptance of this metadata GET are
observed. Object permissions, effective global capacity, persistent volume and
retention remain unknown. Never converts the result to StorageProtectionEvidence.
"""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import math
import os
import re
from threading import RLock
import time
from urllib.error import HTTPError
from urllib.request import HTTPSHandler, ProxyHandler, Request, build_opener

from .supabase_private_media_store import (
    APPROVED_ORIGIN, SupabasePrivateMediaStore, _RejectRedirects, _verified_tls_context,
)

SERVER_KEY_ENV = "SUPABASE_SERVICE_ROLE_KEY"
MAX_RESPONSE_BYTES = 16 * 1024
_UNKNOWN = ("media_credential_verified", "object_read_permission", "object_upload_permission",
            "global_file_size_limit", "effective_file_size_limit", "remaining_quota",
            "protected_persistent_volume", "retention")


@dataclass(frozen=True, repr=False)
class StorageMetadataApproval:
    """Root-reviewed one-GET authorization; never accepted from a public API."""
    approved: bool = False
    operation_id: str = ""
    receipt_id: str = ""
    source_sha256: str = ""
    bucket: str = ""
    key_sha256: str = ""
    approved_at: float | None = None
    expires_at: float | None = None
    max_seconds: float = 5


@dataclass(frozen=True, repr=False)
class StorageBucketMetadata:
    origin: str
    bucket: str
    bucket_private: bool | None
    public_field_present: bool
    allowed_mime_types: tuple[str, ...] | None
    mime_policy_state: str
    bucket_file_size_limit: int | None
    file_size_policy_state: str
    credential_get_accepted: bool
    # These are UNKNOWN, not false/denied or implicitly granted.
    unknown: tuple[str, ...] = _UNKNOWN
    evidence_scope: str = "bucket-metadata-get-only"


@dataclass(frozen=True, repr=False)
class StorageMetadataReceipt:
    operation_id: str
    approval_receipt_id: str
    source_sha256: str
    key_binding_sha256: str
    started_at: float
    observed_at: float
    elapsed_seconds: float
    response_sha256: str
    facts: StorageBucketMetadata
    transport_kind: str
    deployment_source_verified: bool = False
    schema: str = "private-storage-bucket-observation/v1"


class _Rejected(Exception):
    def __init__(self, status):
        self.status = status


def _number(value):
    if type(value) not in (int, float):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        return False


def _matches(pattern, value):
    return type(value) is str and re.fullmatch(pattern, value) is not None


def _approved(value):
    return (type(value) is StorageMetadataApproval and value.approved is True
        and _matches(r"[A-Za-z0-9_-]{1,128}", value.operation_id)
        and _matches(r"[A-Za-z0-9_-]{1,128}", value.receipt_id)
        and _matches(r"[0-9a-f]{64}", value.source_sha256)
        and _matches(r"[0-9a-f]{64}", value.key_sha256)
        and _matches(r"[a-z0-9][a-z0-9_-]{2,62}", value.bucket)
        and _number(value.approved_at) and _number(value.expires_at)
        and 0 < value.expires_at - value.approved_at <= 300
        and _number(value.max_seconds) and 1 <= value.max_seconds <= 10)


def _parse(raw, bucket):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise _Rejected("invalid-metadata")
            result[key] = value
        return result
    def constant(_):
        raise _Rejected("invalid-metadata")
    try:
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=pairs, parse_constant=constant)
        if (type(value) is not dict or value.get("id") != bucket
                or type(value.get("name")) is not str or not 1 <= len(value["name"]) <= 256):
            raise _Rejected("invalid-metadata")
        present = "public" in value
        public = value.get("public")
        if present and type(public) is not bool:
            raise _Rejected("invalid-metadata")
        mime = value.get("allowed_mime_types")
        if "allowed_mime_types" not in value:
            mime_state = "missing"
        elif mime is None:
            mime_state = "null-no-bucket-restriction"
        else:
            if (type(mime) is not list or len(mime) > 64
                    or not all(type(v) is str and 1 <= len(v) <= 128
                               and re.fullmatch(r"[A-Za-z0-9!#$&^_.+*\-/]+", v) for v in mime)):
                raise _Rejected("invalid-metadata")
            mime = tuple(mime)
            mime_state = "explicit-bucket-list"
        size = value.get("file_size_limit")
        if "file_size_limit" not in value:
            size_state = "missing"
        elif size is None:
            size_state = "null-no-bucket-limit"
        else:
            if type(size) is not int or not 0 <= size <= 2**63-1:
                raise _Rejected("invalid-metadata")
            size_state = "explicit-bucket-limit"
        # Owner IDs, arbitrary extra metadata, timestamps and raw body are not
        # exported. The bucket limit says nothing about the global project limit.
        return StorageBucketMetadata(APPROVED_ORIGIN, bucket, not public if present else None,
            present, mime, mime_state, size, size_state, True)
    except _Rejected:
        raise
    except Exception:
        raise _Rejected("invalid-metadata") from None


class StorageBucketMetadataReader:
    """At most one GET per reader instance, explicit approval, zero retries.

    Default construction/collect performs no environment or network reads.
    With a valid Root approval, omitted transport uses verified HTTPS, no proxy
    discovery and no redirects. transport/environment are synthetic test seams.
    Revocation/expiry rejects late replies; synchronous I/O is not force-killed.
    The caller controls whether and when a NEW separately approved reader runs.
    """
    def __init__(self, *, environment=None, transport=None, clock=time.time, monotonic=time.monotonic):
        self._environment, self._transport = environment, transport
        self._clock, self._monotonic = clock, monotonic
        self._lock = RLock()
        self._generation = 0
        self._attempted = False
        self._revoked = False
        self._status = "disabled"

    @property
    def status(self):
        with self._lock:
            return self._status

    def revoke(self):
        with self._lock:
            self._generation += 1
            self._revoked = True
            self._status = "revoked"

    def _check(self, approval, generation, started_wall, started_mono):
        now, mono = self._clock(), self._monotonic()
        with self._lock:
            if self._revoked or generation != self._generation:
                raise _Rejected("revoked")
            if (not _number(now) or not _number(mono) or now < started_wall or mono < started_mono
                    or not approval.approved_at <= now < approval.expires_at
                    or mono - started_mono >= approval.max_seconds):
                raise _Rejected("expired-or-timed-out")
        return now, mono

    def _open(self, request, remaining_time):
        if self._transport is not None:
            return self._transport(request, timeout=remaining_time())
        opener = build_opener(ProxyHandler({}), HTTPSHandler(context=_verified_tls_context()), _RejectRedirects())
        # TLS/trust-store/opener construction may wait. Recheck the operation
        # immediately before issuing the GET, not only after its reply.
        return opener.open(request, timeout=remaining_time())

    def collect(self, approval=None):
        if not _approved(approval):
            return None
        with self._lock:
            if self._attempted or self._revoked:
                return None
            self._attempted = True
            generation = self._generation
            self._status = "reading"
        response = request = None
        try:
            started_wall, started_mono = self._clock(), self._monotonic()
            if not _number(started_wall) or not _number(started_mono):
                raise _Rejected("expired-or-timed-out")
            self._check(approval, generation, started_wall, started_mono)
            environment = os.environ if self._environment is None else self._environment
            key = environment.get(SERVER_KEY_ENV)
            self._check(approval, generation, started_wall, started_mono)
            if (type(key) is not str or not key or len(key) > 8192
                    or hashlib.sha256(key.encode("utf-8")).hexdigest() != approval.key_sha256):
                raise _Rejected("key-binding-unavailable")
            # Reuse the existing reject-only server-key format filter and header
            # construction. This makes NO assertion that its Storage proof passed.
            store = SupabasePrivateMediaStore(APPROVED_ORIGIN, approval.bucket, key,
                protection=None, clock=self._clock)
            headers = store._headers()
            headers["Accept"] = "application/json"
            headers["User-Agent"] = "Gongxingji-Storage-Metadata/1"
            del store, key
            url = f"{APPROVED_ORIGIN}/storage/v1/bucket/{approval.bucket}"
            request = Request(url, headers=headers, method="GET")
            headers.clear()
            def remaining_time():
                now, mono = self._check(approval, generation, started_wall, started_mono)
                return min(approval.max_seconds - (mono-started_mono), approval.expires_at-now)
            try:
                response = self._open(request, remaining_time)
            except HTTPError as error:
                response = error
            self._check(approval, generation, started_wall, started_mono)
            if response.geturl() != url:
                raise _Rejected("redirect-or-target-rejected")
            if type(response.status) is not int or response.status != 200:
                raise _Rejected("provider-rejected")
            header = lambda name: SupabasePrivateMediaStore._header(response, name)
            content_type = header("Content-Type")
            if (type(content_type) is not str or len(content_type)>128
                    or content_type.split(";",1)[0].strip().lower() != "application/json"
                    or header("Content-Encoding") not in (None,"identity")
                    or header("Content-Range") is not None):
                raise _Rejected("invalid-response")
            length = header("Content-Length")
            if length is not None:
                if not _matches(r"[0-9]{1,6}",length) or int(length)>MAX_RESPONSE_BYTES:
                    raise _Rejected("response-too-large-or-invalid")
                length = int(length)
            body = bytearray()
            while True:
                self._check(approval, generation, started_wall, started_mono)
                limit = min(4096, MAX_RESPONSE_BYTES+1-len(body))
                part = response.read(limit)
                self._check(approval, generation, started_wall, started_mono)
                if type(part) is not bytes or len(part)>limit:
                    raise _Rejected("invalid-response")
                if not part:
                    break
                body.extend(part)
                if len(body)>MAX_RESPONSE_BYTES:
                    raise _Rejected("response-too-large-or-invalid")
            if length is not None and len(body)!=length:
                raise _Rejected("invalid-response-length")
            facts = _parse(bytes(body),approval.bucket)
            response_hash = hashlib.sha256(body).hexdigest()
            del body
            # Closing may block/fail too: no success is returned before it and
            # the final generation/deadline check have completed.
            closing, response = response, None
            closing.close()
            now, mono = self._check(approval, generation, started_wall, started_mono)
            result = StorageMetadataReceipt(approval.operation_id,approval.receipt_id,
                approval.source_sha256,approval.key_sha256,started_wall,now,mono-started_mono,
                response_hash,facts,"default-https" if self._transport is None else "injected-test")
            with self._lock:
                if self._revoked or generation != self._generation:
                    raise _Rejected("revoked")
                self._status = "metadata-observed"
                return result
        except _Rejected as error:
            with self._lock:
                if generation == self._generation:
                    self._status = error.status
            return None
        except Exception:
            with self._lock:
                if generation == self._generation:
                    self._status = "unconfirmed"
            return None
        finally:
            if request is not None:
                request.headers.clear()
                request.unredirected_hdrs.clear()
            if response is not None:
                try:
                    response.close()
                except Exception:
                    pass
