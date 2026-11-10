"""Default-closed server composition with explicit, bounded runtime facts refresh.

A trusted operator supplies expiring evidence and a PURE, bounded schema_guard.
Neither client input, environment booleans nor local tests establish these facts.
configure_private_media(..., readiness=None) imports/constructs no services.
No cache: admission precedes every dependency, key read, session and store action.
"""
from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass, field, replace
import math
from pathlib import Path
import re
import time
from typing import Callable

from fastapi import HTTPException
from app.supabase_private_media_store import (
    APPROVED_ORIGIN, MAX_OBJECT_BYTES, MEDIA_MIME_TYPES,
    StorageProtectionEvidence, SupabasePrivateMediaStore,
)

from app.supabase_archive_object_store import (RuntimeObjectArchiveAttestation,
    SupabaseArchiveObjectStore, object_archive_facts_valid)

_RECEIPT = re.compile(r"[A-Za-z0-9_-]{1,128}")
_DIGEST = re.compile(r"[0-9a-f]{64}")
_MARKERS = frozenset({"20261006_0012", "20261006_0013"})
_CONTRACT = "private-media-five-tables/v1"
_CLOSED = "Protected media server evidence is unavailable; local originals retained"


@dataclass(frozen=True, repr=False)
class SchemaAdmission:
    # Factory identity binds the proof to the already selected server connection.
    session_factory: object = field(default=None, repr=False)
    origin: str = ""
    epoch: int = 0
    receipt_id: str = ""
    verified_at: float | None = None
    expires_at: float | None = None
    contract: str = ""
    definition_sha256: str = ""
    marker: str = ""
    shape_verified: bool = False
    backend_permissions_verified: bool = False
    client_access_denied: bool = False


@dataclass(frozen=True, repr=False)
class ArchiveReadiness:
    enabled: bool = False
    origin: str = ""
    epoch: int = 0
    receipt_id: str = ""
    verified_at: float | None = None
    expires_at: float | None = None
    root: Path | None = None
    directory_protected: bool = False
    directory_durability_verified: bool = False
    # "unknown", temporary/serverless/scratch storage are never admitted.
    filesystem_kind: str = "unknown"
    persistent_copy_root: Path | None = None
    persistence_verified: bool = False
    persistent_copy_protected: bool = False
    persistent_copy_receipt_id: str | None = None
    retention_policy_id: str | None = None
    retention_policy_verified: bool = False
    retention_receipt_id: str | None = None


@dataclass(frozen=True, repr=False)
class ObjectArchiveReadiness:
    enabled: bool=False
    origin: str=""
    epoch: int=0
    receipt_id: str=""
    verified_at: float | None=None
    expires_at: float | None=None
    evidence: RuntimeObjectArchiveAttestation | None=None


@dataclass(frozen=True, repr=False)
class RuntimeArchiveAttestation:
    """Operator evidence without a caller-selected runtime generation.

    These fields are reviewed external facts, not measurements performed here.
    Only explicit activation binds them to the current media epoch/expiry.
    """
    origin: str = ""
    receipt_id: str = ""
    verified_at: float | None = None
    expires_at: float | None = None
    root: Path | None = None
    directory_protected: bool = False
    directory_durability_verified: bool = False
    filesystem_kind: str = "unknown"
    persistent_copy_root: Path | None = None
    persistence_verified: bool = False
    persistent_copy_protected: bool = False
    persistent_copy_receipt_id: str | None = None
    retention_policy_id: str | None = None
    retention_policy_verified: bool = False
    retention_receipt_id: str | None = None


@dataclass(frozen=True, repr=False)
class MediaReadiness:
    enabled: bool = False
    auth_mode: str = ""
    origin: str = ""
    epoch: int = 0
    receipt_id: str = ""
    verified_at: float | None = None
    expires_at: float | None = None
    storage: StorageProtectionEvidence | None = None
    schema_guard: Callable[[], SchemaAdmission | None] | None = field(default=None, repr=False)
    key_provider: Callable[[], str] | None = field(default=None, repr=False)
    archive: ArchiveReadiness | ObjectArchiveReadiness | None = None


def _closed():
    # No exception interpolation, raw provider error or evidence/key repr.
    raise HTTPException(503, _CLOSED) from None


def _receipt(value):
    return isinstance(value, str) and _RECEIPT.fullmatch(value) is not None


def _window(verified_at, expires_at, now):
    return (type(verified_at) in (int, float) and type(expires_at) in (int, float)
            and math.isfinite(verified_at) and math.isfinite(expires_at)
            and verified_at <= now < expires_at <= verified_at + 86400)


def _facts(value, epoch, now):
    return (value.origin == APPROVED_ORIGIN and type(value.epoch) is int
            and value.epoch > 0 and value.epoch == epoch and _receipt(value.receipt_id)
            and _window(value.verified_at, value.expires_at, now))


def _admit_media(readiness, session_factory, clock):
    try:
        now = clock()
        if (not callable(session_factory)
                or not callable(getattr(session_factory, "begin", None))):
            _closed()
        if type(now) not in (int, float) or not math.isfinite(now):
            _closed()
        if (not isinstance(readiness, MediaReadiness) or readiness.enabled is not True
                or readiness.auth_mode != "supabase"
                or not _facts(readiness, readiness.epoch, now)
                or not callable(readiness.schema_guard) or not callable(readiness.key_provider)):
            _closed()
        p = readiness.storage
        if (not isinstance(p, StorageProtectionEvidence) or p.origin != APPROVED_ORIGIN
                or not isinstance(p.bucket, str)
                or re.fullmatch(r"[a-z0-9][a-z0-9_-]{2,62}", p.bucket) is None
                or p.bucket_private is not True or p.credential_verified is not True
                or p.allowed_mime_types != MEDIA_MIME_TYPES
                or type(p.max_file_bytes) is not int or p.max_file_bytes < MAX_OBJECT_BYTES
                or not _receipt(p.receipt_id) or not _window(p.verified_at, p.expires_at, now)):
            _closed()
        # Caller contract: pure read of a trusted snapshot; never a cloud query.
        schema = readiness.schema_guard()
        now = clock()  # Guard callback cannot consume the remaining expiry window.
        if (not isinstance(schema, SchemaAdmission)
                or not _facts(readiness, readiness.epoch, now)
                or not _window(p.verified_at, p.expires_at, now)
                or not _facts(schema, readiness.epoch, now)
                or schema.session_factory is not session_factory
                or schema.contract != _CONTRACT or schema.marker not in _MARKERS
                or not isinstance(schema.definition_sha256, str)
                or _DIGEST.fullmatch(schema.definition_sha256) is None
                or schema.shape_verified is not True
                or schema.backend_permissions_verified is not True
                or schema.client_access_denied is not True):
            _closed()
    except Exception:
        _closed()


def _admit_archive(readiness, session_factory, clock):
    _admit_media(readiness, session_factory, clock)
    _admit_archive_facts(readiness.archive, readiness.epoch, clock)


def _admit_archive_facts(a, epoch, clock):
    # Separate object facts never assert a filesystem volume.
    if type(a) is ObjectArchiveReadiness:
        if a.enabled is not True or not _facts(a,epoch,clock()) or not object_archive_facts_valid(a.evidence,clock()) or a.expires_at>a.evidence.expires_at:
            _closed()
        return
    # Pure facts/path-shape admission; no key, directory read or provider probe.
    try:
        if (not isinstance(a, ArchiveReadiness) or a.enabled is not True
                or not _facts(a, epoch, clock())
                or a.directory_protected is not True
                or a.directory_durability_verified is not True
                or a.filesystem_kind != "protected-persistent-volume"
                or not isinstance(a.root, Path) or not a.root.is_absolute()):
            _closed()
        # Unknown optional facts stay absent/false; do not invent durable copies.
        if a.persistence_verified is True:
            if (not isinstance(a.persistent_copy_root, Path)
                    or not a.persistent_copy_root.is_absolute()
                    or a.persistent_copy_protected is not True
                    or not _receipt(a.persistent_copy_receipt_id)):
                _closed()
        elif (a.persistence_verified is not False or a.persistent_copy_root is not None
              or a.persistent_copy_protected is not False
              or a.persistent_copy_receipt_id is not None):
            _closed()
        if a.retention_policy_verified is True:
            if not _receipt(a.retention_policy_id) or not _receipt(a.retention_receipt_id):
                _closed()
        elif (a.retention_policy_verified is not False or a.retention_policy_id is not None
              or a.retention_receipt_id is not None):
            _closed()
    except Exception:
        _closed()


def _bind_runtime_archive(attestation, epoch, expires_at, clock):
    if attestation is None:
        return None
    if type(attestation) is RuntimeObjectArchiveAttestation:
        bound=ObjectArchiveReadiness(True,attestation.origin,epoch,attestation.receipt_id,
            attestation.verified_at,min(attestation.expires_at,expires_at),attestation)
        _admit_archive_facts(bound,epoch,clock)
        return bound
    if type(attestation) is not RuntimeArchiveAttestation:
        _closed()
    facts = {name: getattr(attestation, name)
             for name in RuntimeArchiveAttestation.__dataclass_fields__}
    bound = ArchiveReadiness(enabled=True, epoch=epoch, **facts)
    bound = replace(bound, expires_at=min(bound.expires_at, expires_at))
    _admit_archive_facts(bound, epoch, clock)
    return bound


class _GuardedFactory:
    def __init__(self, factory, guard):
        self._factory, self._guard = factory, guard

    def __call__(self, *args, **kwargs):
        self._guard()
        return self._context(lambda: self._factory(*args, **kwargs))

    def begin(self, *args, **kwargs):
        self._guard()
        return self._context(lambda: self._factory.begin(*args, **kwargs))

    @contextmanager
    def _context(self, create):
        # Opening and entering a session can wait. A rejection inside the
        # delegate's context propagates to its rollback/close implementation.
        self._guard()
        with create() as session:
            self._guard()
            yield session
            self._guard()  # Before a successful transaction context commits.
        # Commit/close may also wait. Reject a stale return without claiming
        # that an already completed durable commit has been undone.
        self._guard()


class _GuardedStore:
    def __init__(self, store, guard):
        self._store, self._guard = store, guard

    @property
    def mode(self):
        return self._store.mode

    @property
    def protection_verified(self):
        self._guard()
        return self._store.protection_verified

    def exists(self, object_id):
        self._guard()
        result = self._store.exists(object_id)
        self._guard()
        return result

    def read(self, object_id, expected_size):
        self._guard()
        result = self._store.read(object_id, expected_size)
        self._guard()
        return result

    def put(self, object_id, content):
        self._guard()
        result = self._store.put(object_id, content)
        self._guard()
        return result  # A rejected late reply does not delete an uploaded copy.


def _build_media(readiness, session_factory, clock):
    guard = lambda: _admit_media(readiness, session_factory, clock)
    guard()
    try:
        key = readiness.key_provider()  # Lazy: only after all admission facts.
        guard()  # Account for revocation/expiry while retrieving the server key.
        store = SupabasePrivateMediaStore(
            readiness.origin, readiness.storage.bucket, key,
            protection=readiness.storage, clock=clock)
        del key
        from app.private_media import PrivateMediaService, MediaPolicy
        class _GuardedMediaService(PrivateMediaService):
            def verified_content(self, owner, object_id):
                result = super().verified_content(owner, object_id)
                guard()  # Container validation after read can also take time.
                return result

        # Existing public methods already call require_enabled. The wrapped
        # factory/store additionally fence session/provider actions after waits.
        service = _GuardedMediaService(_GuardedFactory(session_factory, guard),
                                      _GuardedStore(store, guard), MediaPolicy(enabled=True), clock)
        service.require_enabled()
        return service
    except Exception:
        _closed()


def _build_archive(readiness, session_factory, clock):
    archive_guard = lambda: _admit_archive(readiness, session_factory, clock)
    archive_guard()  # Before key retrieval, service construction or path I/O.
    try:
        media = _build_media(readiness, session_factory, clock)
        archive_guard()
        from app.media_archive import MediaArchiveService, ArchivePolicy
        a = readiness.archive

        class _GuardedArchiveService(MediaArchiveService):
            def require_enabled(self):
                archive_guard()
                return super().require_enabled()

            def path_for(self, archive_id):
                archive_guard()
                path = super().path_for(archive_id)
                archive_guard()
                return path

            def _verified_archive(self, record, **kwargs):
                archive_guard()
                result = super()._verified_archive(record, **kwargs)
                archive_guard()
                return result

            def _restore_root(self, receipt):
                archive_guard()
                root = super()._restore_root(receipt)
                archive_guard()
                return root

            def _verify_restore_copy(self, row, receipt, collected):
                archive_guard()
                result = super()._verify_restore_copy(row, receipt, collected)
                archive_guard()
                return result

            def _verify_existing_persistent_copy(self, row):
                archive_guard()
                result = super()._verify_existing_persistent_copy(row)
                archive_guard()
                return result

            def _persistent_copy(self, archive_id, expected_hash, **kwargs):
                archive_guard()
                result = super()._persistent_copy(archive_id, expected_hash, **kwargs)
                archive_guard()
                return result  # Existing filesystem writes are retained.

        if type(a) is ObjectArchiveReadiness:
            evidence=a.evidence
            key=readiness.key_provider();archive_guard()
            storage=SupabaseArchiveObjectStore(evidence,key,admission=archive_guard,clock=clock)
            del key
            service=_GuardedArchiveService(media,None,ArchivePolicy(enabled=True,protection_verified=True,
                persistence_verified=evidence.independent_copy_verified,retention_policy_id=evidence.retention_policy_id,
                retention_policy_verified=evidence.retention_policy_verified,object_storage=True),clock,
                archive_storage=storage,lease_expires_at=min(readiness.expires_at,a.expires_at),
                lease_scope=evidence.operation_id+":"+evidence.source_sha256+":"+storage.binding_id)
            service.factory=_GuardedFactory(session_factory,archive_guard)
            service.require_enabled();return service
        service = _GuardedArchiveService(media, a.root, ArchivePolicy(
            enabled=True, protection_verified=True,
            persistent_copy_root=a.persistent_copy_root,
            persistence_verified=a.persistence_verified,
            retention_policy_id=a.retention_policy_id,
            retention_policy_verified=a.retention_policy_verified), clock)
        service.factory = _GuardedFactory(session_factory, archive_guard)
        service.require_enabled()
        return service
    except Exception:
        _closed()


def configure_private_media(app, session_factory, readiness=None, *, clock=time.time, runtime_facts=None) -> bool:
    """Install bounded server dependencies, never an environment facts producer.

    False means no dependency was changed; True means dependencies installed,
    not credential validity, hosted connectivity, durable restore or acceptance.
    Existing auth/owner dependencies and routes remain untouched. Repeated calls
    on the same app are rejected so an old installed proof is never overwritten.
    Root calls this once using its existing SessionLocal. None is the shipped
    default. There is deliberately no automatic evidence or key loader.
    """
    if runtime_facts is not None:
        if readiness is not None or not isinstance(runtime_facts, RuntimeMediaFacts):
            return False
        if runtime_facts.session_factory is not session_factory:
            return False
        return runtime_facts.install(app)
    if readiness is None:
        return False
    try:
        _admit_media(readiness, session_factory, clock)
        from app.private_media import get_private_media_service
        from app.media_archive import get_media_archive_service
        dependencies = app.dependency_overrides
        if (get_private_media_service in dependencies
                or get_media_archive_service in dependencies):
            return False
        if type(dependencies) is not dict:
            return False
        # The original archive dependency remains untouched when its independent
        # facts/switch are absent. This never infers persistence from a bucket.
        archive_ready = False
        try:
            _admit_archive(readiness, session_factory, clock)
            archive_ready = True
        except HTTPException:
            pass
        dependencies[get_private_media_service] = lambda: _build_media(readiness, session_factory, clock)
        if archive_ready:
            dependencies[get_media_archive_service] = lambda: _build_archive(readiness, session_factory, clock)
        return True
    except Exception:
        return False


# Runtime admission is opt-in server composition. These imports do not load
# app.db, read the environment, obtain a key, connect to PG or contact Storage.
import hashlib
import json
import sys
from threading import RLock, Lock

_MEDIA_COLUMNS = {
    "private_media_owners": (("owner_id", "character varying(128)", True), ("used_bytes", "bigint", True), ("reserved_bytes", "bigint", True)),
    "private_media_objects": (
        ("id", "character varying(32)", True), ("owner_id", "character varying(128)", True),
        ("client_object_id", "character varying(160)", True), ("selection_id", "character varying(160)", True),
        ("kind", "character varying(16)", True), ("mime", "character varying(64)", True),
        ("sha256", "character varying(64)", True), ("byte_size", "bigint", True),
        ("idempotency_key", "character varying(160)", True), ("intent_digest", "character varying(64)", True),
        ("status", "character varying(24)", True), ("attempts", "integer", True),
        ("created_at", "bigint", True), ("expires_at", "bigint", True), ("stored_at", "bigint", False),
        ("save_consent", "json", True), ("training_consent", "json", True)),
    "private_media_consent_events": (
        ("id", "character varying(32)", True), ("owner_id", "character varying(128)", True),
        ("object_id", "character varying(32)", True), ("happened_at", "bigint", True),
        ("scope", "character varying(16)", True), ("consent", "json", True)),
    "private_media_access": (("token_hash", "character varying(64)", True), ("owner_id", "character varying(128)", True),
        ("object_id", "character varying(32)", True), ("expires_at", "bigint", True)),
    "media_archive_records": (
        ("id", "character varying(32)", True), ("owner_id", "character varying(128)", True),
        ("idempotency_key", "character varying(160)", True), ("selection_digest", "character varying(64)", True),
        ("status", "character varying(24)", True), ("manifest", "json", True),
        ("manifest_sha256", "character varying(64)", True), ("archive_sha256", "character varying(64)", True),
        ("byte_size", "bigint", True), ("created_at", "bigint", True), ("restore_receipt", "json", False),
        ("durable_copy_verified", "boolean", True), ("retention_policy_id", "character varying(160)", False)),
}
_MEDIA_CHECKS = {
    "ck_private_media_quota_nonnegative": "CHECK (((used_bytes >= 0) AND (reserved_bytes >= 0)))",
    "ck_private_media_object_size": "CHECK (((byte_size > 0) AND (attempts >= 0)))",
    "ck_private_media_object_status": "CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'stored'::character varying, 'expired'::character varying, 'repair-required'::character varying])::text[])))",
}
_MEDIA_UNIQUES = {"private_media_objects": "uq_private_media_idempotency", "media_archive_records": "uq_media_archive_idempotency"}
_MEDIA_INDEX_COLUMNS = {
    "private_media_objects": ("owner_id",), "private_media_consent_events": ("owner_id", "object_id"),
    "private_media_access": ("object_id",), "media_archive_records": ("owner_id",),
}


def _runtime_shape(table_name):
    """Pinned five-table contract, not an operator-supplied hash/SQL template."""
    pk = _MEDIA_COLUMNS[table_name][0][0]
    constraints = [(table_name + "_pkey", "p", [pk], "PRIMARY KEY (" + pk + ")")]
    indexes = [(table_name + "_pkey", [pk], True, True)]
    if table_name in _MEDIA_UNIQUES:
        name = _MEDIA_UNIQUES[table_name]
        constraints.append((name, "u", ["owner_id", "idempotency_key"], "UNIQUE (owner_id, idempotency_key)"))
        indexes.append((name, ["owner_id", "idempotency_key"], True, False))
    checks = ("ck_private_media_quota_nonnegative",) if table_name == "private_media_owners" else (
        ("ck_private_media_object_size", "ck_private_media_object_status") if table_name == "private_media_objects" else ())
    for name in checks:
        columns = ["used_bytes", "reserved_bytes"] if name.endswith("nonnegative") else (
            ["byte_size", "attempts"] if name.endswith("size") else ["status"])
        constraints.append((name, "c", columns, _MEDIA_CHECKS[name]))
    for column in _MEDIA_INDEX_COLUMNS.get(table_name, ()):
        indexes.append(("ix_" + table_name + "_" + column, [column], False, False))
    return sorted(constraints), sorted(indexes)


def _definition(value):
    # Only whitespace OUTSIDE string literals is normalized. Parentheses,
    # casts, operators, order and literal bytes remain exact; unknown PG output
    # stays closed until it is independently reviewed, never regex-simplified.
    if not isinstance(value, str) or len(value) > 2048:
        raise ValueError("definition")
    parts = re.split(r"('(?:[^']|'')*')", value)
    return "".join(part if number % 2 else re.sub(r"\s+", "", part) for number, part in enumerate(parts))


def _validate_runtime_catalog(data, expected_role):
    """Pure validator; its result alone is not evidence of an executed query."""
    if not isinstance(data, dict) or set(data) != {"identity", "markers", "tables", "client_roles"}:
        raise ValueError("catalog")
    identity = data["identity"]
    if (set(identity) != {"role", "session_role", "database", "version", "super", "bypass", "schema_usage"}
            or identity["role"] != expected_role or identity["session_role"] != expected_role
            or identity["database"] != "postgres" or type(identity["version"]) is not int
            or not 170000 <= identity["version"] < 180000 or identity["super"] is not False
            or type(identity["bypass"]) is not bool or identity["schema_usage"] is not True
            or data["markers"] not in (["20261006_0012"], ["20261006_0013"])):
        raise ValueError("connection_identity")
    if (not isinstance(data["client_roles"], list) or len(data["client_roles"]) != 2
            or {r.get("role") for r in data["client_roles"]} != {"anon", "authenticated"}):
        raise ValueError("client_roles")
    for role in data["client_roles"]:
        if (set(role) != {"role", "super", "bypass", "assume_backend", "schema_create"}
                or any(role[k] is not False for k in ("super", "bypass", "assume_backend", "schema_create"))):
            raise ValueError("client_role_capability")
    tables = data["tables"]
    if (not isinstance(tables, list) or len(tables) != 5
            or {t.get("name") for t in tables} != set(_MEDIA_COLUMNS)):
        raise ValueError("tables")
    for table in tables:
        name = table["name"]
        if (set(table) != {"name", "kind", "persistence", "rls", "force_rls", "owner", "policies", "triggers", "rules", "parents", "columns", "constraints", "indexes", "backend", "clients"}
                or table["kind"] != "r" or table["persistence"] != "p" or table["rls"] is not True
                or type(table["force_rls"]) is not bool
                or any(type(table[k]) is not int or table[k] != 0 for k in ("policies", "triggers", "rules", "parents"))
                or not (identity["bypass"] is True or (table["owner"] == expected_role and table["force_rls"] is False))
                or set(table["backend"]) != {"select", "insert", "update"}
                or any(v is not True for v in table["backend"].values())):
            raise ValueError("table_protection")
        expected_columns = [{"name": n, "type": t, "not_null": nn, "default": None,
            "identity": "", "generated": "", "dropped": False,
            "collation": "default" if t.startswith("character varying") else None} for n,t,nn in _MEDIA_COLUMNS[name]]
        if (any(type(c.get("not_null")) is not bool or c.get("dropped") is not False for c in table["columns"])
                or table["columns"] != expected_columns):
            raise ValueError("columns")
        expected_constraints, expected_indexes = _runtime_shape(name)
        actual_constraints = []
        for item in table["constraints"]:
            if (set(item) != {"name", "kind", "columns", "definition", "valid", "deferrable", "deferred", "local", "parents"}
                    or any(item[k] is not False for k in ("deferrable", "deferred"))
                    or item["valid"] is not True or item["local"] is not True
                    or type(item["parents"]) is not int or item["parents"] != 0):
                raise ValueError("constraint_state")
            actual_constraints.append((item["name"], item["kind"], item["columns"], _definition(item["definition"])))
        if sorted(actual_constraints) != [(n,k,c,_definition(d)) for n,k,c,d in expected_constraints]:
            raise ValueError("constraints")
        actual_indexes = []
        for item in table["indexes"]:
            if (set(item) != {"name", "columns", "unique", "primary", "valid", "ready", "live", "immediate", "nulls_not_distinct", "method", "partial", "expressions", "key_count", "column_count", "options", "opclasses", "collations"}
                    or any(item[k] is not True for k in ("valid", "ready", "live", "immediate"))
                    or any(item[k] is not False for k in ("nulls_not_distinct", "partial", "expressions"))
                    or type(item["unique"]) is not bool or type(item["primary"]) is not bool
                    or item["method"] != "btree" or type(item["key_count"]) is not int
                    or type(item["column_count"]) is not int or item["key_count"] != len(item["columns"])
                    or item["column_count"] != len(item["columns"])
                    or any(type(v) is not int for v in item["options"])
                    or item["options"] != [0] * len(item["columns"])
                    or item["collations"] != ["pg_catalog.default"] * len(item["columns"])
                    or item["opclasses"] != ["pg_catalog.text_ops"] * len(item["columns"])):
                raise ValueError("index_state")
            actual_indexes.append((item["name"], item["columns"], item["unique"], item["primary"]))
        if sorted(actual_indexes) != expected_indexes:
            raise ValueError("indexes")
        clients = table["clients"]
        if (not isinstance(clients,list) or len(clients) != 2
                or {c.get("role") for c in clients} != {"anon", "authenticated"}):
            raise ValueError("client_permissions")
        for client in clients:
            if (set(client) != {"role", "table", "columns", "assume_owner"}
                    or len(client["table"]) != 8 or len(client["columns"]) != 4
                    or any(v is not False for v in client["table"] + client["columns"])
                    or client["assume_owner"] is not False):
                raise ValueError("effective_client_permissions")
    canonical = json.dumps(data, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


_RUNTIME_CATALOG_SQL = """
SELECT pg_catalog.jsonb_build_object(
 'identity', (SELECT pg_catalog.jsonb_build_object('role',current_user,'session_role',session_user,
   'database',pg_catalog.current_database(),'version',pg_catalog.current_setting('server_version_num')::int,
   'super',r.rolsuper,'bypass',r.rolbypassrls,'schema_usage',pg_catalog.has_schema_privilege(current_user,'public','USAGE'))
   FROM pg_catalog.pg_roles r WHERE r.rolname=current_user),
 'markers',(SELECT COALESCE(pg_catalog.jsonb_agg(version_num ORDER BY version_num),'[]'::jsonb)
   FROM (SELECT version_num FROM public.alembic_version ORDER BY version_num LIMIT 2) m),
 'client_roles',(SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
   'role',r.rolname,'super',r.rolsuper,'bypass',r.rolbypassrls,
   'assume_backend',(pg_catalog.pg_has_role(r.oid,current_user,'USAGE') OR pg_catalog.pg_has_role(r.oid,current_user,'SET')),
   'schema_create',pg_catalog.has_schema_privilege(r.oid,'public','CREATE')) ORDER BY r.rolname),'[]'::jsonb)
   FROM pg_catalog.pg_roles r WHERE r.rolname IN ('anon','authenticated')),
 'tables',(SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
   'name',c.relname,'kind',c.relkind,'persistence',c.relpersistence,'rls',c.relrowsecurity,
   'force_rls',c.relforcerowsecurity,'owner',pg_catalog.pg_get_userbyid(c.relowner),
   'policies',(SELECT COUNT(*)::int FROM pg_catalog.pg_policy q WHERE q.polrelid=c.oid),
   'triggers',(SELECT COUNT(*)::int FROM pg_catalog.pg_trigger q WHERE q.tgrelid=c.oid AND NOT q.tgisinternal),
   'rules',(SELECT COUNT(*)::int FROM pg_catalog.pg_rewrite q WHERE q.ev_class=c.oid),
   'parents',(SELECT COUNT(*)::int FROM pg_catalog.pg_inherits q WHERE q.inhrelid=c.oid),
   'columns',(SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
     'name',a.attname,'type',pg_catalog.format_type(a.atttypid,a.atttypmod),'not_null',a.attnotnull,
     'default',pg_catalog.pg_get_expr(d.adbin,d.adrelid,false),'identity',a.attidentity,
     'generated',a.attgenerated,'dropped',a.attisdropped,'collation',co.collname) ORDER BY a.attnum),'[]'::jsonb)
     FROM pg_catalog.pg_attribute a LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
     LEFT JOIN pg_catalog.pg_collation co ON co.oid=a.attcollation WHERE a.attrelid=c.oid AND a.attnum>0),
   'constraints',(SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
     'name',q.conname,'kind',q.contype,'columns',(SELECT COALESCE(pg_catalog.jsonb_agg(a.attname ORDER BY u.n),'[]'::jsonb)
       FROM pg_catalog.unnest(q.conkey) WITH ORDINALITY u(k,n)
       JOIN pg_catalog.pg_attribute a ON a.attrelid=q.conrelid AND a.attnum=u.k),
     'definition',pg_catalog.pg_get_constraintdef(q.oid,false),'valid',q.convalidated,
     'deferrable',q.condeferrable,'deferred',q.condeferred,'local',q.conislocal,'parents',q.coninhcount) ORDER BY q.conname),'[]'::jsonb)
     FROM pg_catalog.pg_constraint q WHERE q.conrelid=c.oid),
   'indexes',(SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
     'name',ic.relname,'columns',(SELECT COALESCE(pg_catalog.jsonb_agg(a.attname ORDER BY u.n),'[]'::jsonb)
       FROM pg_catalog.unnest(i.indkey::int2[]) WITH ORDINALITY u(k,n)
       LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=u.k),
     'unique',i.indisunique,'primary',i.indisprimary,'valid',i.indisvalid,'ready',i.indisready,
     'live',i.indislive,'immediate',i.indimmediate,'nulls_not_distinct',i.indnullsnotdistinct,
     'method',am.amname,'partial',i.indpred IS NOT NULL,'expressions',i.indexprs IS NOT NULL,
     'key_count',i.indnkeyatts,'column_count',i.indnatts,'options',pg_catalog.to_jsonb(i.indoption::int2[]),
     'collations',(SELECT COALESCE(pg_catalog.jsonb_agg(cn.nspname||'.'||cc.collname ORDER BY u.n),'[]'::jsonb)
       FROM pg_catalog.unnest(i.indcollation::oid[]) WITH ORDINALITY u(k,n)
       LEFT JOIN pg_catalog.pg_collation cc ON cc.oid=u.k LEFT JOIN pg_catalog.pg_namespace cn ON cn.oid=cc.collnamespace),
     'opclasses',(SELECT COALESCE(pg_catalog.jsonb_agg(onsp.nspname||'.'||oc.opcname ORDER BY u.n),'[]'::jsonb)
       FROM pg_catalog.unnest(i.indclass::oid[]) WITH ORDINALITY u(k,n)
       JOIN pg_catalog.pg_opclass oc ON oc.oid=u.k JOIN pg_catalog.pg_namespace onsp ON onsp.oid=oc.opcnamespace)) ORDER BY ic.relname),'[]'::jsonb)
     FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class ic ON ic.oid=i.indexrelid
     JOIN pg_catalog.pg_am am ON am.oid=ic.relam WHERE i.indrelid=c.oid),
   'backend',pg_catalog.jsonb_build_object('select',pg_catalog.has_table_privilege(current_user,c.oid,'SELECT'),
      'insert',pg_catalog.has_table_privilege(current_user,c.oid,'INSERT'),'update',pg_catalog.has_table_privilege(current_user,c.oid,'UPDATE')),
   'clients',(SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'role',r.rolname,'assume_owner',(pg_catalog.pg_has_role(r.oid,c.relowner,'USAGE') OR pg_catalog.pg_has_role(r.oid,c.relowner,'SET')),
      'table',pg_catalog.jsonb_build_array(pg_catalog.has_table_privilege(r.oid,c.oid,'SELECT'),
        pg_catalog.has_table_privilege(r.oid,c.oid,'INSERT'),pg_catalog.has_table_privilege(r.oid,c.oid,'UPDATE'),
        pg_catalog.has_table_privilege(r.oid,c.oid,'DELETE'),pg_catalog.has_table_privilege(r.oid,c.oid,'TRUNCATE'),
        pg_catalog.has_table_privilege(r.oid,c.oid,'REFERENCES'),pg_catalog.has_table_privilege(r.oid,c.oid,'TRIGGER'),
        pg_catalog.has_table_privilege(r.oid,c.oid,'MAINTAIN')),
      'columns',pg_catalog.jsonb_build_array(pg_catalog.has_any_column_privilege(r.oid,c.oid,'SELECT'),
        pg_catalog.has_any_column_privilege(r.oid,c.oid,'INSERT'),pg_catalog.has_any_column_privilege(r.oid,c.oid,'UPDATE'),
        pg_catalog.has_any_column_privilege(r.oid,c.oid,'REFERENCES'))) ORDER BY r.rolname),'[]'::jsonb)
      FROM pg_catalog.pg_roles r WHERE r.rolname IN ('anon','authenticated'))) ORDER BY c.relname),'[]'::jsonb)
 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='public' AND c.relname = ANY(:table_names)))
"""


@dataclass(frozen=True, repr=False)
class StorageKeyAttestation:
    """Reviewed SERVER operator proof plus a pin to its selected server key.

    Neither its presence, SHA, JWT parsing nor a bucket name is a new provider
    measurement. No loader queries Storage or manufactures credential_verified.
    The key callback is never invoked on the default/invalid admission path.
    """
    protection: StorageProtectionEvidence | None = None
    receipt_id: str = ""
    key_sha256: str = ""
    key_provider: Callable[[], str] | None = field(default=None, repr=False)


def _attestation_valid(attestation, now):
    try:
        a = attestation
        p = a.protection
        return (isinstance(a, StorageKeyAttestation) and _receipt(a.receipt_id)
            and isinstance(a.key_sha256,str) and _DIGEST.fullmatch(a.key_sha256) is not None
            and callable(a.key_provider) and isinstance(p,StorageProtectionEvidence)
            and p.origin == APPROVED_ORIGIN and isinstance(p.bucket,str)
            and re.fullmatch(r"[a-z0-9][a-z0-9_-]{2,62}",p.bucket) is not None
            and p.bucket_private is True and p.credential_verified is True
            and p.allowed_mime_types == MEDIA_MIME_TYPES and type(p.max_file_bytes) is int
            and p.max_file_bytes >= MAX_OBJECT_BYTES and _receipt(p.receipt_id)
            and _window(p.verified_at,p.expires_at,now))
    except (AttributeError,TypeError,ValueError):
        return False


class RuntimeMediaFacts:
    """Default-off same-SessionLocal PG producer with atomic snapshot leases.

    Explicit refresh is the ONLY fact-loading action. Optional request-triggered
    refresh is enabled only after successful explicit admission and opt-in; it
    runs outside schema_guard, at most once each >=30 seconds, with no retry on
    failure. No thread, external probe, env reader or DDL exists. ZIP needs its own proof.
    A query/wall deadline rejects late admission, not a promise to cancel a
    blocked network connection or undo a completed provider/DB/FS operation.
    """
    def __init__(self, session_factory, *, clock=time.time, monotonic=time.monotonic):
        self.session_factory = session_factory
        self._engine = getattr(session_factory,"kw",{}).get("bind")
        self._clock,self._monotonic = clock,monotonic
        self._lock,self._refresh_lock = RLock(),Lock()
        self._generation = 0
        self._operator_token = None
        self._readiness = self._schema = None
        self._refresh_settings = None
        self._next_refresh = None
        self._installed = False
        self._installed_app = None
        self._archive_installed = False
        self._media_dependency = self._service
        self._archive_dependency = self._archive_service
        self._last_status = "disabled"

    @property
    def status(self):
        # This is state of local admission, never a production acceptance claim.
        with self._lock:
            return self._last_status

    def _same_root_binding(self):
        db = sys.modules.get("app.db")
        return (db is not None and getattr(db,"SessionLocal",None) is self.session_factory
            and self._engine is not None and getattr(self.session_factory,"kw",{}).get("bind") is self._engine)

    def _generation_guard(self, generation):
        try:
            with self._lock:
                now = self._clock()
                if (type(now) not in (int,float) or not math.isfinite(now)
                        or generation != self._generation or self._readiness is None
                        or not self._same_root_binding()
                        or not _window(self._readiness.verified_at,self._readiness.expires_at,now)):
                    _closed()
        except Exception:
            _closed()

    def _refresh_ticket_alive(self, generation):
        with self._lock:
            return generation == self._generation and self._same_root_binding()

    def revoke(self):
        with self._lock:
            self._generation += 1
            self._operator_token = None
            self._readiness = self._schema = self._refresh_settings = self._next_refresh = None
            self._last_status = "disabled"

    def claim_operator(self, token):
        # Memory-only reservation. A lifespan must hold its cancellation gate
        # here, before starting blocking providers in a worker thread.
        with self._lock:
            if token is None or not self._same_root_binding():
                return None
            self.revoke()
            self._operator_token = token
            return self._generation

    def renew_operator(self, token):
        """Close the old lease without revoking its still-owned service policy.

        This cannot reclaim a revoked/replaced token and performs no I/O. Only
        the private continuous-service coordinator uses it before fresh probes.
        """
        with self._lock:
            if not self.operator_owned(token) or not self._same_root_binding():
                return None
            self.revoke()
            self._operator_token = token
            return self._generation

    def install_continuous_dependency(self, app, token, request_refresh, *, archive_requested=False):
        """Install an owned, initially CLOSED request path; no readiness forged.

        Fresh evidence must be collected by the private coordinator before the
        original _service guard can succeed. Archive is added only on explicit shared-coordinator opt-in; it stays CLOSED until matching facts refresh.
        """
        with self._lock:
            if (not self.operator_owned(token) or not self._same_root_binding()
                    or not callable(request_refresh)):
                return False
            try:
                from app.private_media import get_private_media_service
                from app.media_archive import get_media_archive_service
                dependencies = app.dependency_overrides
                if type(dependencies) is not dict:
                    return False
                if self._installed:
                    if (app is not self._installed_app
                            or dependencies.get(get_private_media_service) is not self._media_dependency):
                        return False
                    if self._archive_installed:
                        if dependencies.get(get_media_archive_service) is not self._archive_dependency:
                            return False
                    elif get_media_archive_service in dependencies:
                        return False
                elif get_private_media_service in dependencies or get_media_archive_service in dependencies:
                    return False
                def media_dependency():
                    # A saved dependency from a former operator cannot borrow
                    # replacement readiness or invoke another service policy.
                    with self._lock:
                        if not self.operator_owned(token):
                            _closed()
                    if request_refresh() is not True:
                        _closed()
                    with self._lock:
                        if not self.operator_owned(token):
                            _closed()
                        readiness, generation = self._readiness, self._generation
                    # Build from this captured epoch without holding the runtime
                    # lock across key/provider work (which may take its own gate).
                    self._generation_guard(generation)
                    service = _build_media(readiness, self.session_factory, self._clock)
                    self._generation_guard(generation)
                    return service
                def archive_dependency():
                    with self._lock:
                        if not self.operator_owned(token):_closed()
                    if request_refresh() is not True:_closed()
                    with self._lock:
                        if not self.operator_owned(token):_closed()
                        readiness,generation=self._readiness,self._generation
                    self._generation_guard(generation)
                    service=_build_archive(readiness,self.session_factory,self._clock)
                    self._generation_guard(generation)
                    return service
                self._media_dependency = media_dependency
                dependencies[get_private_media_service] = self._media_dependency
                if archive_requested is True:
                    self._archive_dependency=archive_dependency
                    dependencies[get_media_archive_service]=self._archive_dependency
                    self._archive_installed=True
                self._installed, self._installed_app = True, app
                return True
            except Exception:
                return False

    def operator_owned(self, token):
        # Opaque server-side identity, never a serialized client permission.
        with self._lock:
            return token is not None and self._operator_token is token

    def revoke_operator(self, token):
        # An old lifespan's shutdown cannot revoke a replacement operator.
        with self._lock:
            if token is None or self._operator_token is not token:
                return False
            self.revoke()
            return True

    def _schema_snapshot(self, generation):
        self._generation_guard(generation)
        with self._lock:
            return self._schema if generation == self._generation else None

    def _collect_pg(self, expected_role, deadline, generation):
        # Never import real app.db to create an alternative factory. index must
        # already have loaded it, and both its sessionmaker AND bound engine
        # must still be the identical live objects provided to this producer.
        def require_ticket():
            # The captured refresh generation is checked before each NEW SQL
            # and again after every waiting stage. An already-entered I/O is
            # retained; no claim of cancellation/undo is made by this guard.
            if self._monotonic() >= deadline or not self._refresh_ticket_alive(generation):
                raise ValueError("catalog_ticket_or_deadline")
        require_ticket()
        engine = self._engine
        url = engine.url
        project = "jsezgjgfftzkkxhidswk"
        if (engine.dialect.name != "postgresql" or url.drivername != "postgresql+psycopg"
                or url.database != "postgres" or url.query.get("sslmode") != "require"
                or not (url.host == "db." + project + ".supabase.co"
                    or (isinstance(url.host,str) and url.host.endswith(".auth-5.example.invalidm")
                        and url.username == "postgres." + project))):
            raise ValueError("selected_target")
        from sqlalchemy import text
        require_ticket()  # Do not create a new session after revocation.
        with self.session_factory.begin() as session:
            require_ticket()  # Entering the session/context may have waited.
            if session.get_bind() is not engine:
                raise ValueError("session_engine")
            statements = ("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
                "SET LOCAL statement_timeout = '1500ms'", "SET LOCAL lock_timeout = '500ms'",
                "SET LOCAL search_path = pg_catalog")
            for sql in statements:
                require_ticket()
                session.execute(text(sql))
                require_ticket()  # A withdrawal while waiting blocks next SQL.
            require_ticket()
            result = session.execute(text(_RUNTIME_CATALOG_SQL), {"table_names": sorted(_MEDIA_COLUMNS)})
            require_ticket()  # Do not adopt/fetch a revoked SELECT result.
            data = result.scalar_one()
            require_ticket()  # Fetching/materializing the result can also wait.
            # No user/media rows read: only pg_catalog and the migration marker.
            encoded = json.dumps(data,sort_keys=True,separators=(",",":"),ensure_ascii=True)
            if len(encoded.encode("utf-8")) > 128 * 1024:
                raise ValueError("catalog_size")
            digest = _validate_runtime_catalog(data,expected_role)
            require_ticket()
        require_ticket()  # Reject proof after a late context exit/close.
        return data["markers"][0],digest

    def refresh(self, *, enabled=False, approved_backend_role=None, receipt_id=None,
                storage_attestation=None, ttl_seconds=120, max_admission_seconds=5,
                refresh_on_request=False, archive_attestation=None,
                _expected_generation=None, _operator_generation=None):
        # An operator ticket precedes admission, unlike a request-refresh lease.
        # Check it before pure-revoke paths and again after taking refresh lock.
        with self._lock:
            if _operator_generation is not None and not self._refresh_ticket_alive(_operator_generation):
                return False
            # Disabled/default path is a pure revoke; no import/env/key/session/I/O.
            if enabled is not True:
                self.revoke()
                return False
        if not self._refresh_lock.acquire(blocking=False):
            with self._lock:
                if _operator_generation is None or self._refresh_ticket_alive(_operator_generation):
                    self.revoke()  # Competing refresh cannot revive the old lease.
            return False
        try:
            with self._lock:
                if _operator_generation is not None:
                    if (_expected_generation is not None
                            or not self._refresh_ticket_alive(_operator_generation)):
                        return False
                if _expected_generation is not None:
                    if _expected_generation != self._generation:
                        return False
                    self._generation_guard(_expected_generation)
                owner = self._operator_token if (_operator_generation is not None
                    or _expected_generation is not None) else None
                self.revoke()
                self._operator_token = owner
                generation = self._generation
                self._last_status = "closed"
            now = self._clock()
            if (not _receipt(receipt_id) or not isinstance(approved_backend_role,str)
                    or re.fullmatch(r"[a-zA-Z_][a-zA-Z0-9_]{0,62}",approved_backend_role) is None
                    or approved_backend_role in {"anon","authenticated","PUBLIC"}
                    or type(ttl_seconds) is not int or not 60 <= ttl_seconds <= 300
                    or type(max_admission_seconds) not in (int,float)
                    or not math.isfinite(max_admission_seconds) or not 1 <= max_admission_seconds <= 10
                    or type(refresh_on_request) is not bool or not _attestation_valid(storage_attestation,now)
                    or not self._same_root_binding()):
                return False
            # Invalid archive facts reject before catalog/key I/O. Rebind after
            # all waits as well; operator input never chooses the runtime epoch.
            _bind_runtime_archive(archive_attestation,generation,
                min(now + ttl_seconds,storage_attestation.protection.expires_at),self._clock)
            deadline = self._monotonic() + max_admission_seconds
            marker,digest = self._collect_pg(approved_backend_role,deadline,generation)
            # Credential verification is an external reviewed fact. This only
            # proves the selected key is the SAME key named in that attestation.
            if not self._refresh_ticket_alive(generation):
                return False
            key = storage_attestation.key_provider()
            if (not isinstance(key,str) or not key or len(key)>8192
                    or hashlib.sha256(key.encode("utf-8")).hexdigest() != storage_attestation.key_sha256):
                return False
            del key
            now = self._clock()
            if (not self._refresh_ticket_alive(generation) or self._monotonic() >= deadline
                    or not _attestation_valid(storage_attestation,now)
                    or not self._same_root_binding()):
                return False
            expires = min(now + ttl_seconds,storage_attestation.protection.expires_at)
            if expires <= now:
                return False
            schema = SchemaAdmission(self.session_factory,APPROVED_ORIGIN,generation,receipt_id,
                now,expires,_CONTRACT,digest,marker,True,True,True)
            def key_provider():
                self._generation_guard(generation)
                value = storage_attestation.key_provider()
                self._generation_guard(generation)
                if (not isinstance(value,str) or not value or len(value)>8192
                        or hashlib.sha256(value.encode("utf-8")).hexdigest() != storage_attestation.key_sha256):
                    self.revoke()
                    _closed()
                return value
            archive = _bind_runtime_archive(archive_attestation,generation,expires,self._clock)
            readiness = MediaReadiness(True,"supabase",APPROVED_ORIGIN,generation,receipt_id,
                now,expires,storage_attestation.protection,lambda:self._schema_snapshot(generation),key_provider,archive)
            with self._lock:
                if generation != self._generation:
                    return False
                self._schema,self._readiness = schema,readiness
                self._last_status = "admitted-local-snapshot"
                if refresh_on_request:
                    self._refresh_settings = {"enabled":True,"approved_backend_role":approved_backend_role,
                        "receipt_id":receipt_id,"storage_attestation":storage_attestation,"ttl_seconds":ttl_seconds,
                        "max_admission_seconds":max_admission_seconds,"refresh_on_request":True,
                        "archive_attestation":archive_attestation}
                    self._next_refresh = now + max(30,ttl_seconds//2)
            return True
        except Exception:
            # No exception repr, DSN, SQL error, evidence or key reaches callers.
            with self._lock:
                self._last_status = "closed"
            return False
        finally:
            self._refresh_lock.release()

    def apply_operator_settings(self, settings_provider=None, *, approved=False,
                                operator_token=None, _operator_generation=None):
        # A reserved ticket never claims again: late/cancelled workers cannot
        # revoke a newer operator before their provider notices cancellation.
        with self._lock:
            if _operator_generation is not None:
                if (not self.operator_owned(operator_token)
                        or not self._refresh_ticket_alive(_operator_generation)):
                    return False
                operator_generation = _operator_generation
                if approved is not True or settings_provider is None:
                    self.revoke()
                    return False
            else:
                # Preserve existing explicit operator-call semantics.
                if approved is not True or settings_provider is None:
                    return self.refresh(enabled=False)
                self.revoke()
                self._operator_token = operator_token
                operator_generation = self._generation
        try:
            if not callable(settings_provider):
                raise ValueError("operator_settings")
            settings = settings_provider()
            if not isinstance(settings, RuntimeMediaActivation):
                raise ValueError("operator_settings")
            if not self._refresh_ticket_alive(operator_generation):
                return False
            return self.refresh(enabled=settings.enabled,
                approved_backend_role=settings.approved_backend_role,
                receipt_id=settings.receipt_id, storage_attestation=settings.storage_attestation,
                ttl_seconds=settings.ttl_seconds,max_admission_seconds=settings.max_admission_seconds,
                refresh_on_request=settings.refresh_on_request,
                archive_attestation=settings.archive_attestation,
                _operator_generation=operator_generation)
        except Exception:
            with self._lock:
                if operator_generation == self._generation:
                    self.revoke()
            return False

    def refresh_if_due(self):
        try:
            with self._lock:
                now = self._clock()
                if type(now) not in (int,float) or not math.isfinite(now):
                    raise ValueError("clock")
                settings = self._refresh_settings
                generation = self._generation
                due = settings is not None and self._next_refresh is not None and now >= self._next_refresh
                if due:
                    self._generation_guard(generation)  # Expired/closed requests never probe.
                if due:
                    self._refresh_settings = self._next_refresh = None
            if due:
                return self.refresh(_expected_generation=generation,**settings)
            return False
        except Exception:
            self.revoke()
            return False

    def _service(self):
        with self._lock:
            generation = self._generation
        self._generation_guard(generation)
        self.refresh_if_due()  # Only a still-live explicit pre-refresh opt-in.
        with self._lock:
            readiness,generation = self._readiness,self._generation
        self._generation_guard(generation)
        return _build_media(readiness,self.session_factory,self._clock)

    def _archive_service(self):
        with self._lock:
            generation = self._generation
        self._generation_guard(generation)
        self.refresh_if_due()
        with self._lock:
            readiness,generation = self._readiness,self._generation
        self._generation_guard(generation)
        # This core binds all filesystem/service actions to the admitted epoch.
        return _build_archive(readiness,self.session_factory,self._clock)

    def install(self, app):
        # Preserve original one-install semantics for existing callers.
        return self._install_dependencies(app, allow_existing=False)

    def ensure_installed(self, app, *, operator_token=None):
        """Operator activation only: install/update this runtime's own overrides.

        Existing ZIP overrides remain installed but closed when new readiness
        omits ZIP. Never delete or replace another composition's dependency.
        """
        return self._install_dependencies(app, allow_existing=True, operator_token=operator_token)

    def _install_dependencies(self, app, *, allow_existing, operator_token=None):
        with self._lock:
            if operator_token is not None and not self.operator_owned(operator_token):
                return False
            if not self._same_root_binding() or self._readiness is None:
                return False
            if self._installed and not allow_existing:
                return False
            try:
                self._generation_guard(self._generation)
                from app.private_media import get_private_media_service
                from app.media_archive import get_media_archive_service
                dependencies = app.dependency_overrides
                if type(dependencies) is not dict:
                    return False
                if self._installed:
                    if (app is not self._installed_app
                            or dependencies.get(get_private_media_service) is not self._media_dependency):
                        return False
                    if self._archive_installed:
                        if dependencies.get(get_media_archive_service) is not self._archive_dependency:
                            return False
                    elif get_media_archive_service in dependencies:
                        return False
                elif get_private_media_service in dependencies or get_media_archive_service in dependencies:
                    return False
                self._generation_guard(self._generation)
                if self._readiness.archive is not None:
                    _admit_archive_facts(self._readiness.archive,self._generation,self._clock)
                dependencies[get_private_media_service] = self._media_dependency
                if self._readiness.archive is not None:
                    dependencies[get_media_archive_service] = self._archive_dependency
                    self._archive_installed = True
                self._installed,self._installed_app = True,app
                return True
            except Exception:
                return False


@dataclass(frozen=True, repr=False)
class RuntimeMediaActivation:
    """Only Root's reviewed server configuration can supply this object.

    enabled/approved control invocation; they establish NONE of the required PG
    or Storage facts. No public API accepts this type or its key callback.
    """
    enabled: bool = False
    approved_backend_role: str | None = None
    receipt_id: str | None = None
    storage_attestation: StorageKeyAttestation | None = None
    ttl_seconds: int = 120
    max_admission_seconds: float = 5
    refresh_on_request: bool = False
    archive_attestation: RuntimeArchiveAttestation | RuntimeObjectArchiveAttestation | None = None


def install_runtime_private_media(app, session_factory, *, settings_provider=None,
                                  approved=False, clock=time.time, monotonic=time.monotonic):
    """Real index composition: explicit default refresh, unchanged closed dependencies.

    Missing/unapproved server provider causes zero env/file/key/DB/HTTP reads.
    Root retains this returned object for explicit revocation/operator refresh.
    This function creates no engine and changes no Auth. ZIP additionally needs
    explicit archive attestation. Installation is not production acceptance.
    """
    runtime = RuntimeMediaFacts(session_factory,clock=clock,monotonic=monotonic)
    runtime.apply_operator_settings(settings_provider,approved=approved)
    configure_private_media(app,session_factory,runtime_facts=runtime,clock=clock)
    return runtime
