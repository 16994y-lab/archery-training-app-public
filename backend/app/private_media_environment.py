"""Fixed private-service configuration for the existing expiring media runtime.

Configuration carries reviewed assertions; it performs no provider verification.
Root must separately approve/pin the exact operation and receipt bytes. No public
endpoint, file/URL loader, caller-selected key name, upload or training consent.
"""
from __future__ import annotations

from contextlib import asynccontextmanager
from dataclasses import asdict, dataclass
import hashlib
import json
import logging
import math
import os
from pathlib import Path
import re
from threading import RLock
import time

from .private_media_activation_lifespan import (
    MediaActivationEvidence, make_private_media_activation_lifespan,
    parse_media_activation_scope,
)
from .private_media_bootstrap import RuntimeArchiveAttestation,RuntimeObjectArchiveAttestation
from .supabase_archive_object_store import object_archive_facts_valid
from .supabase_private_media_store import (
    APPROVED_ORIGIN, MAX_OBJECT_BYTES, MEDIA_MIME_TYPES, StorageProtectionEvidence,
)

OPERATION_ENV = "GONGXINGJI_PRIVATE_MEDIA_OPERATION"
EVIDENCE_ENV = "GONGXINGJI_PRIVATE_MEDIA_EVIDENCE"
SERVER_KEY_ENV = "SUPABASE_SERVICE_ROLE_KEY"
_LIMITS = {OPERATION_ENV: 4096, EVIDENCE_ENV: 16384, SERVER_KEY_ENV: 8192}
_RECEIPT = re.compile(r"[A-Za-z0-9_-]{1,128}")
_SHA = re.compile(r"[0-9a-f]{64}")


@dataclass(frozen=True, repr=False)
class ReviewedMediaConfiguration:
    """Root-owned approval data, NEVER loaded from the operation/evidence JSON.

    Digests bind exact UTF-8 text (including whitespace). The record must be
    produced after independent role/Storage/volume evidence and protected log
    access are reviewed. Setting approved=True is not that factual verification.
    """
    approved: bool = False
    receipt_id: str = ""
    operation_id: str = ""
    source_sha256: str = ""
    operation_sha256: str = ""
    evidence_sha256: str = ""
    approved_at: float | None = None
    expires_at: float | None = None


class MediaConfigurationUnavailable(Exception):
    """Fixed classification only; no raw configuration, key or exception text."""


def _closed():
    raise MediaConfigurationUnavailable("private-media-configuration-unavailable") from None


def _number(value):
    if type(value) not in (int, float):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        return False


def _id(value):
    return type(value) is str and _RECEIPT.fullmatch(value) is not None


def _sha(value):
    return type(value) is str and _SHA.fullmatch(value) is not None


def _window(start, end, maximum):
    return (_number(start) and _number(end) and 0 < end - start <= maximum)


def _review_valid(review):
    return (type(review) is ReviewedMediaConfiguration and review.approved is True
        and _id(review.receipt_id) and _id(review.operation_id)
        and all(_sha(value) for value in (review.source_sha256, review.operation_sha256, review.evidence_sha256))
        and _window(review.approved_at, review.expires_at, 300))


def _object(raw, fields):
    def pairs(values):
        result = {}
        for key, value in values:
            if key in result:
                _closed()
            result[key] = value
        return result
    def constant(_):
        _closed()
    try:
        value = json.loads(raw, object_pairs_hook=pairs, parse_constant=constant)
        if type(value) is not dict or set(value) != set(fields):
            _closed()
        return value
    except Exception:
        _closed()


def _path(value):
    if (type(value) is not str or not value or len(value) > 512 or "\x00" in value
            or "://" in value or ".." in Path(value).parts):
        _closed()
    path = Path(value)
    if not path.is_absolute():
        _closed()
    return path


def _fact_window(start, end, scope, now):
    return (_window(start, end, 86400) and start <= now < end
            and scope.expires_at <= end)


def _parse_evidence(raw, review, scope, now):
    """Parse only after exact review digest match; never probes asserted facts."""
    fields = {"schema", "receipt_id", "operation_id", "source_sha256", "verified_at", "expires_at",
              "approved_backend_role", "storage", "storage_receipt_id", "key_sha256", "archive"}
    value = _object(raw, fields)
    if (value["schema"] != "private-media-reviewed-facts/v1"
            or value["receipt_id"] != review.receipt_id
            or value["operation_id"] != review.operation_id
            or value["source_sha256"] != review.source_sha256
            or not _fact_window(value["verified_at"], value["expires_at"], scope, now)
            or type(value["approved_backend_role"]) is not str
            or re.fullmatch(r"[a-zA-Z_][a-zA-Z0-9_]{0,62}", value["approved_backend_role"]) is None
            or value["approved_backend_role"] in {"anon", "authenticated", "PUBLIC"}
            or not _id(value["storage_receipt_id"]) or not _sha(value["key_sha256"])):
        _closed()
    p = value["storage"]
    if type(p) is not dict or set(p) != set(StorageProtectionEvidence.__dataclass_fields__):
        _closed()
    mime = p["allowed_mime_types"]
    if (p["origin"] != APPROVED_ORIGIN or type(p["bucket"]) is not str
            or re.fullmatch(r"[a-z0-9][a-z0-9_-]{2,62}", p["bucket"]) is None
            or p["bucket_private"] is not True or p["credential_verified"] is not True
            or type(mime) is not list or not all(type(v) is str for v in mime)
            or len(mime) != len(MEDIA_MIME_TYPES) or frozenset(mime) != MEDIA_MIME_TYPES
            or type(p["max_file_bytes"]) is not int or not MAX_OBJECT_BYTES <= p["max_file_bytes"] <= 2**63-1
            or not _id(p["receipt_id"]) or not _fact_window(p["verified_at"], p["expires_at"], scope, now)
            or p["expires_at"] > value["expires_at"]):
        _closed()
    storage = StorageProtectionEvidence(**{**p, "allowed_mime_types": frozenset(mime)})
    archive = value["archive"]
    if archive is not None:
        if type(archive) is dict and set(archive)==set(RuntimeObjectArchiveAttestation.__dataclass_fields__):
            fields=dict(archive);mimes=fields["allowed_mime_types"]
            if type(mimes) is not list or not all(type(m) is str for m in mimes) or len(mimes)!=len(set(mimes)):_closed()
            fields["allowed_mime_types"]=frozenset(mimes)
            archive=RuntimeObjectArchiveAttestation(**fields)
            if (not object_archive_facts_valid(archive,now) or archive.operation_id!=scope.operation_id
                or archive.source_sha256!=scope.source_sha256 or archive.key_sha256!=value["key_sha256"]
                or not _fact_window(archive.verified_at,archive.expires_at,scope,now)
                or archive.expires_at>value["expires_at"]):_closed()
        else:
            if type(archive) is not dict or set(archive) != set(RuntimeArchiveAttestation.__dataclass_fields__):
                _closed()
            if (archive["origin"] != APPROVED_ORIGIN or not _id(archive["receipt_id"])
                    or not _fact_window(archive["verified_at"], archive["expires_at"], scope, now)
                    or archive["expires_at"] > value["expires_at"]
                    or archive["directory_protected"] is not True
                    or archive["directory_durability_verified"] is not True
                    or archive["filesystem_kind"] != "protected-persistent-volume"):
                _closed()
            archive = dict(archive)
            archive["root"] = _path(archive["root"])
            if archive["persistence_verified"] is True:
                if archive["persistent_copy_protected"] is not True or not _id(archive["persistent_copy_receipt_id"]):
                    _closed()
                archive["persistent_copy_root"] = _path(archive["persistent_copy_root"])
            elif (archive["persistence_verified"] is not False or archive["persistent_copy_root"] is not None
                  or archive["persistent_copy_protected"] is not False or archive["persistent_copy_receipt_id"] is not None):
                _closed()
            if archive["retention_policy_verified"] is True:
                if not _id(archive["retention_policy_id"]) or not _id(archive["retention_receipt_id"]):
                    _closed()
            elif (archive["retention_policy_verified"] is not False or archive["retention_policy_id"] is not None
                  or archive["retention_receipt_id"] is not None):
                _closed()
            archive = RuntimeArchiveAttestation(**archive)
    if scope.archive_enabled and archive is None:
        _closed()
    return MediaActivationEvidence(review.operation_id, review.source_sha256,
        value["approved_backend_role"], storage, value["storage_receipt_id"], value["key_sha256"], archive)


def _protected_event(event):
    # Only existing adapter's fixed event dataclass. This does not establish
    # that platform service logs are protected; Root must verify that separately.
    logging.getLogger("gongxingji.audit.private_media_activation").warning(
        "private-media-activation %s", json.dumps(asdict(event), ensure_ascii=True,
            allow_nan=False, separators=(",", ":")))


def make_environment_media_lifespan(runtime_provider, *, reviewed=None, environment=None,
                                   clock=time.time, protected_event_sink=None):
    """Actual fixed-field service loader; no handwritten config/key callbacks.

    Default None/invalid/unapproved review reads no environment, clock or log.
    environment is a test seam; production omission uses only the fixed names
    above in the service process. It never falls back to files, URLs or other
    secret fields. Root approval is independent immutable composition data.

    One returned object attempts once per process. Context exit/cancellation
    revokes via the existing runtime token. Editing environment is not a global
    cross-worker revocation signal; explicitly withdraw active runtime leases or
    stop their instances. Synchronous environment providers cannot be force-killed.
    """
    if not _review_valid(reviewed):
        return make_private_media_activation_lifespan(runtime_provider)
    gate = RLock()
    used = False
    active = False
    scope_snapshot = evidence_snapshot = None
    last_clock = None

    def alive():
        nonlocal last_clock
        with gate:
            if not active:
                _closed()
            now = clock()
            if (not _number(now) or not reviewed.approved_at <= now < reviewed.expires_at
                    or (last_clock is not None and now < last_clock)):
                _closed()
            last_clock = now
            return now

    def read(name):
        alive()
        try:
            raw = (os.environ if environment is None else environment).get(name)
        except Exception:
            _closed()
        alive()
        if type(raw) is not str or not raw or len(raw) > _LIMITS[name]:
            _closed()
        return raw

    def bound_text(name, expected):
        raw = read(name)
        if hashlib.sha256(raw.encode("utf-8")).hexdigest() != expected:
            _closed()
        return raw

    def scope_provider():
        nonlocal scope_snapshot
        raw = bound_text(OPERATION_ENV, reviewed.operation_sha256)
        scope = parse_media_activation_scope(raw)
        now = alive()
        if (scope is None or scope.operation_id != reviewed.operation_id
                or scope.source_sha256 != reviewed.source_sha256
                or not reviewed.approved_at <= scope.approved_at <= now < scope.expires_at <= reviewed.expires_at):
            _closed()
        with gate:
            alive()
            scope_snapshot = scope
        return raw

    def evidence_provider(scope):
        nonlocal evidence_snapshot
        if scope_snapshot is None or scope != scope_snapshot:
            _closed()
        bound_text(OPERATION_ENV, reviewed.operation_sha256)
        raw = bound_text(EVIDENCE_ENV, reviewed.evidence_sha256)
        evidence = _parse_evidence(raw, reviewed, scope, alive())
        bound_text(OPERATION_ENV, reviewed.operation_sha256)
        with gate:
            alive()
            evidence_snapshot = evidence
        return evidence

    def key_provider():
        if evidence_snapshot is None or scope_snapshot is None:
            _closed()
        # Revalidate exact operation and receipt before and after the sole fixed
        # secret read. No key value enters logs, repr, evidence or exceptions.
        bound_text(OPERATION_ENV, reviewed.operation_sha256)
        bound_text(EVIDENCE_ENV, reviewed.evidence_sha256)
        key = read(SERVER_KEY_ENV)
        bound_text(OPERATION_ENV, reviewed.operation_sha256)
        bound_text(EVIDENCE_ENV, reviewed.evidence_sha256)
        if hashlib.sha256(key.encode("utf-8")).hexdigest() != evidence_snapshot.key_sha256:
            _closed()
        alive()
        return key

    inner = make_private_media_activation_lifespan(runtime_provider, scope_provider=scope_provider,
        operator_approved=True, evidence_provider=evidence_provider, key_provider=key_provider,
        reviewed_source_sha256=reviewed.source_sha256,
        protected_event_sink=protected_event_sink if protected_event_sink is not None else _protected_event)

    @asynccontextmanager
    async def lifespan(application):
        nonlocal used, active
        with gate:
            owns = not used
            used = True
            if owns:
                active = True
        if not owns:
            yield
            return
        try:
            async with inner(application) as state:
                yield state
        finally:
            with gate:
                active = False

    return lifespan
