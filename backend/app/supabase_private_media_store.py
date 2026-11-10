"""Unwired immutable Supabase Storage candidate. Construction never does I/O.

Only trusted server composition may provide StorageProtectionEvidence. Evidence
is an expiring operator attestation, never a client flag or automatic proof.
The existing service remains responsible for owner, intent, SHA and full media
container validation. This adapter has no deletion/list/public/signing API.
"""
from __future__ import annotations

import base64
from contextlib import contextmanager
from dataclasses import dataclass
import hashlib
import hmac
import json
import math
import re
import ssl
import time
from typing import Callable
from urllib.error import HTTPError
from urllib.request import HTTPSHandler, HTTPRedirectHandler, ProxyHandler, Request, build_opener

from fastapi import HTTPException

APPROVED_PROJECT_REF = "jsezgjgfftzkkxhidswk"
APPROVED_ORIGIN = f"https://{APPROVED_PROJECT_REF}.supabase.co"
MAX_OBJECT_BYTES = 50 * 1024 * 1024
MEDIA_MIME_TYPES = frozenset({"image/png", "image/jpeg", "image/webp", "video/mp4"})
CHUNK_BYTES = 64 * 1024
MAX_ACK_BYTES = 64 * 1024


@dataclass(frozen=True)
class StorageProtectionEvidence:
    """Server-only facts backed by a separately reviewed operator receipt.

    None is the default. Tests may inject synthetic evidence; that does not
    establish hosted protection, RLS, bucket capacity, retention or key validity.
    allowed_mime_types is the known effective set for this service (all four).
    """
    origin: str
    bucket: str
    bucket_private: bool
    credential_verified: bool
    allowed_mime_types: frozenset[str]
    max_file_bytes: int
    verified_at: float
    expires_at: float
    receipt_id: str


class _RejectRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Returning None makes urllib surface HTTPError without following it.
        return None


def _verified_tls_context():
    """Verified system-trust TLS without the SSLKEYLOGFILE convenience hook.

    System trust loading retains its normal platform/OpenSSL configuration;
    this does not claim to suppress all native certificate environment inputs.
    """
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    context.verify_mode = ssl.CERT_REQUIRED
    context.check_hostname = True
    context.load_default_certs(ssl.Purpose.SERVER_AUTH)
    return context


class SupabasePrivateMediaStore:
    mode = "supabase-private-candidate"

    def __init__(self, origin: str, bucket: str, server_key: str, *,
                 protection: StorageProtectionEvidence | None = None,
                 transport: Callable | None = None, clock: Callable = time.time,
                 monotonic: Callable = time.monotonic, timeout_seconds: float = 30):
        if origin != APPROVED_ORIGIN:
            raise ValueError("Only the reviewed existing HTTPS project origin is allowed")
        if not isinstance(bucket, str) or not re.fullmatch(r"[a-z0-9][a-z0-9_-]{2,62}", bucket):
            raise ValueError("An explicit safe private bucket identifier is required")
        if protection is not None and not isinstance(protection, StorageProtectionEvidence):
            raise ValueError("Protection requires server-side evidence, not a boolean")
        if isinstance(timeout_seconds, bool) or not isinstance(timeout_seconds, (int, float)) or not math.isfinite(timeout_seconds) or not 1 <= timeout_seconds <= 30:
            raise ValueError("Transfer deadline must be between 1 and 30 seconds")
        self.origin, self.bucket = origin, bucket
        self._clock, self._monotonic = clock, monotonic
        self._timeout = float(timeout_seconds)
        self._protection = protection
        self._transport = transport
        self._opener = None
        self._key = server_key
        self._legacy_expiry = self._validate_key(server_key)

    def __repr__(self):
        return f"<{type(self).__name__} mode={self.mode}>"

    def _validate_key(self, key):
        if not isinstance(key, str) or len(key) > 8192 or re.search(r"[^\x21-\x7e]", key):
            raise ValueError("A server-only key is required")
        if re.fullmatch(r"sb_secret_[A-Za-z0-9_-]{20,512}", key):
            return None
        try:
            header, payload, signature = key.split(".")
            if not all(re.fullmatch(r"[A-Za-z0-9_-]+", part) for part in (header, payload, signature)):
                raise ValueError
            decode = lambda value: json.loads(base64.urlsafe_b64decode(value + "=" * (-len(value) % 4)))
            claims, meta = decode(payload), decode(header)
            expiry = claims.get("exp")
            if (meta.get("alg") != "HS256" or claims.get("role") != "service_role"
                    or claims.get("ref") != APPROVED_PROJECT_REF or claims.get("iss") != "supabase"
                    or isinstance(expiry, bool) or not isinstance(expiry, (int, float))
                    or not math.isfinite(expiry) or expiry <= self._clock() + 60):
                raise ValueError
            # Parsing is a reject-only filter. Signature/provider validity is a
            # separate operator fact in protection, not established by decoding.
            return float(expiry)
        except Exception:
            raise ValueError("Key format, project, role or expiry is not acceptable") from None

    @property
    def protection_verified(self):
        p = self._protection
        try:
            now = self._clock()
            return bool(p is not None and p.origin == self.origin and p.bucket == self.bucket
                        and p.bucket_private is True and p.credential_verified is True
                        and p.allowed_mime_types == MEDIA_MIME_TYPES
                        and isinstance(p.max_file_bytes, int) and not isinstance(p.max_file_bytes, bool)
                        and p.max_file_bytes >= MAX_OBJECT_BYTES
                        and isinstance(p.verified_at, (int, float)) and not isinstance(p.verified_at, bool)
                        and isinstance(p.expires_at, (int, float)) and not isinstance(p.expires_at, bool)
                        and math.isfinite(p.verified_at) and math.isfinite(p.expires_at)
                        and p.verified_at <= now < p.expires_at <= p.verified_at + 86400
                        and isinstance(p.receipt_id, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,128}", p.receipt_id)
                        and (self._legacy_expiry is None or self._legacy_expiry > now + 60))
        except (TypeError, ValueError, AttributeError):
            return False

    def _require_protection(self):
        if not self.protection_verified:
            raise HTTPException(503, "Private storage facts are unknown, expired or not verified; local media retained")

    @staticmethod
    def _path(object_id):
        if not isinstance(object_id, str) or not re.fullmatch(r"[0-9a-f]{32}", object_id):
            raise ValueError("Only the service-generated random object identifier is allowed")
        return f"objects/{object_id[:2]}/{object_id}"

    @staticmethod
    def _mime(content):
        # Service validates the entire container before put; this only chooses
        # an explicit wire MIME because its existing put signature has no MIME.
        if content.startswith(b"\x89PNG\r\n\x1a\n"):
            return "image/png"
        if content.startswith(b"\xff\xd8\xff"):
            return "image/jpeg"
        if len(content) >= 12 and content[:4] == b"RIFF" and content[8:12] == b"WEBP":
            return "image/webp"
        if len(content) >= 12 and content[4:8] == b"ftyp":
            return "video/mp4"
        raise HTTPException(422, "Media wire MIME cannot be determined; no upload performed")

    @staticmethod
    def _size(value):
        if not isinstance(value, int) or isinstance(value, bool) or not 1 <= value <= MAX_OBJECT_BYTES:
            raise HTTPException(413, "Object size exceeds the bounded media contract")
        return value

    def _headers(self):
        headers = {"apikey": self._key, "Accept-Encoding": "identity", "Cache-Control": "no-store",
                   "User-Agent": "Gongxingji-Private-Media-Candidate"}
        if self._legacy_expiry is not None:
            headers["Authorization"] = "Bearer " + self._key
        return headers

    def _open(self, request):
        if self._transport is not None:
            return self._transport(request, timeout=self._timeout)
        if self._opener is None:
            # Lazy construction; no environment proxy, redirects, SDK retries,
            # custom certificate bypass or account discovery.
            self._opener = build_opener(ProxyHandler({}), HTTPSHandler(context=_verified_tls_context()), _RejectRedirects())
        return self._opener.open(request, timeout=self._timeout)

    def _deadline(self, deadline):
        self._require_protection()
        if self._monotonic() >= deadline:
            raise HTTPException(503, "Storage transfer deadline expired; result not accepted")

    @staticmethod
    def _header(response, name):
        headers = response.headers
        if hasattr(headers, "get_all"):
            values = headers.get_all(name)
            if values is not None and len(values) != 1:
                raise HTTPException(409, "Ambiguous storage response headers; result not accepted")
        return headers.get(name)

    @contextmanager
    def _response(self, method, path, *, content=None, mime=None):
        self._require_protection()
        if method not in ("HEAD", "GET", "POST"):
            raise ValueError("Only immutable object operations are allowed")
        # All paths come from _path; no external URLs, query, signing or listing.
        route = "object/" if method == "POST" else "object/authenticated/"
        url = f"{self.origin}/storage/v1/{route}{self.bucket}/{path}"
        headers = self._headers()
        if method == "POST":
            headers.update({"Content-Type": mime, "Content-Length": str(len(content)), "x-upsert": "false"})
        request = Request(url, data=content, headers=headers, method=method)
        deadline = self._monotonic() + self._timeout
        response = None
        try:
            try:
                response = self._open(request)
            except HTTPError as error:
                response = error
            except Exception:
                raise HTTPException(503, "Storage transport unconfirmed; no automatic retry; local media retained") from None
            self._deadline(deadline)
            if response.geturl() != url:
                raise HTTPException(502, "Redirected or external storage response rejected")
            status = response.status
            if not isinstance(status, int) or isinstance(status, bool) or not 100 <= status <= 599:
                raise HTTPException(502, "Storage response status is unconfirmed")
            if 300 <= status < 400:
                raise HTTPException(502, "Storage redirect rejected; no follow-up request")
            if self._header(response, "Content-Encoding") not in (None, "identity") or self._header(response, "Content-Range") is not None:
                raise HTTPException(409, "Transformed or partial storage response rejected")
            yield response, deadline
        except HTTPException:
            raise
        except Exception:
            raise HTTPException(503, "Storage result could not be confirmed; local media retained") from None
        finally:
            if response is not None:
                try:
                    response.close()
                except Exception:
                    pass

    def _bounded(self, response, maximum, deadline, *, exact=None):
        length = self._header(response, "Content-Length")
        if length is not None:
            if not isinstance(length, str) or not re.fullmatch(r"[0-9]+", length) or int(length) > maximum or (exact is not None and int(length) != exact):
                raise HTTPException(409, "Storage response length is invalid or inconsistent")
        result = bytearray()
        while True:
            self._deadline(deadline)
            remaining = maximum + 1 - len(result)
            requested = min(CHUNK_BYTES, remaining)
            chunk = response.read(requested)
            self._deadline(deadline)
            if not isinstance(chunk, bytes) or len(chunk) > requested:
                raise HTTPException(409, "Storage response stream violated the byte bound")
            if not chunk:
                break
            if len(result) + len(chunk) > maximum:
                raise HTTPException(409, "Storage response exceeds the exact object byte bound")
            result.extend(chunk)
        if exact is not None and len(result) != exact:
            raise HTTPException(409, "Storage object was truncated or has an inconsistent size")
        return bytes(result)

    def _json(self, response, deadline):
        try:
            raw = self._bounded(response, MAX_ACK_BYTES, deadline)
            value = json.loads(raw.decode("utf-8", errors="strict"))
            if not isinstance(value, dict):
                raise ValueError
            return value
        except HTTPException:
            raise
        except Exception:
            raise HTTPException(503, "Storage acknowledgement is unconfirmed") from None

    def exists(self, object_id):
        path = self._path(object_id)
        with self._response("HEAD", path) as (response, deadline):
            self._deadline(deadline)
            if response.status != 200:
                # Official NoSuchKey/404 can also hide permission failures. An
                # expiry sweep must not release quota based on such ambiguity.
                raise HTTPException(503, "Storage existence is unknown; absence was not established")
            length = self._header(response, "Content-Length")
            mime = (self._header(response, "Content-Type") or "").split(";", 1)[0].strip().lower()
            if not isinstance(length, str) or not re.fullmatch(r"[0-9]+", length) or not 1 <= int(length) <= MAX_OBJECT_BYTES or mime not in MEDIA_MIME_TYPES:
                raise HTTPException(503, "Storage existence metadata is incomplete; absence was not established")
            return True

    def read(self, object_id, expected_size):
        path, expected = self._path(object_id), self._size(expected_size)
        with self._response("GET", path) as (response, deadline):
            if response.status != 200:
                raise HTTPException(503, "Private object read is unconfirmed; no content returned")
            mime = (self._header(response, "Content-Type") or "").split(";", 1)[0].strip().lower()
            if mime not in MEDIA_MIME_TYPES:
                raise HTTPException(409, "Storage object MIME is inconsistent; no content returned")
            content = self._bounded(response, expected, deadline, exact=expected)
            if self._mime(content) != mime:
                raise HTTPException(409, "Storage object content and MIME disagree; no content returned")
            self._deadline(deadline)
            return content

    def put(self, object_id, content):
        path = self._path(object_id)
        self._require_protection()
        if not isinstance(content, bytes):
            raise HTTPException(422, "The immutable object must be bytes")
        self._size(len(content))
        mime = self._mime(content)
        with self._response("POST", path, content=content, mime=mime) as (response, deadline):
            if response.status in (200, 201):
                ack = self._json(response, deadline)
                if ack.get("Key") != f"{self.bucket}/{path}" or not isinstance(ack.get("Id"), str) or not re.fullmatch(r"[0-9a-fA-F-]{32,36}", ack["Id"]):
                    raise HTTPException(503, "Storage upload acknowledgement does not match the fixed object")
            elif response.status in (400, 409):
                ack = self._json(response, deadline)
                tags = {ack[name] for name in ("code", "error") if isinstance(ack.get(name), str)}
                if not tags or not tags <= {"Duplicate", "ResourceAlreadyExists"}:
                    raise HTTPException(409, "Storage duplicate status is unconfirmed; no overwrite or retry")
            else:
                raise HTTPException(503, "Storage upload is unconfirmed; no automatic retry; local media retained")
        # A successful HTTP acknowledgement or duplicate alone never establishes
        # success. Re-read the original fixed object only; never replay POST.
        saved = self.read(object_id, len(content))
        if not hmac.compare_digest(hashlib.sha256(saved).digest(), hashlib.sha256(content).digest()) or saved != content:
            raise HTTPException(409, "Existing storage bytes differ; no overwrite or success reported")