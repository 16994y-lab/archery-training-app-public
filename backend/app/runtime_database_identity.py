"""Unwired, one-attempt database identity evidence for trusted server operators.

Default construction/collection does no I/O. Explicit approval permits only a
fixed read-only pg_catalog query through the already loaded app.db.SessionLocal.
No endpoint, environment/DSN access, logger, migration, user-row query or retry.
A factory identity match is NOT proof of the deployment or database target.
The caller must bind the reviewed source digest to its actual deployment using
independent platform evidence and keep the receipt in its protected audit store.
"""
from __future__ import annotations

from dataclasses import dataclass
import math
import re
import sys
from threading import RLock
import time

_DIGEST = re.compile(r"[0-9a-f]{64}")
_OPERATION = re.compile(r"[A-Za-z0-9_-]{1,128}")
_IDENTIFIER = re.compile(r"[A-Za-z_][A-Za-z0-9_.-]{0,62}")
_ROLE_KEYS = frozenset({"superuser", "inherit", "create_role", "create_database",
                        "can_login", "replication", "bypass_rls"})
_FACT_KEYS = frozenset({"current_user", "session_user", "database", "version_num",
                       "read_only", "isolation", "current_role", "session_role",
                       "database_connect", "database_create", "database_temporary",
                       "public_usage", "public_create"})
_SETTINGS_SQL = (
    "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
    "SET LOCAL statement_timeout = '1500ms'",
    "SET LOCAL lock_timeout = '500ms'",
    "SET LOCAL search_path = pg_catalog",
)
IDENTITY_SQL = """
SELECT pg_catalog.json_build_object(
  'current_user', current_user::text,
  'session_user', session_user::text,
  'database', pg_catalog.current_database()::text,
  'version_num', pg_catalog.current_setting('server_version_num')::integer,
  'read_only', pg_catalog.current_setting('transaction_read_only') = 'on',
  'isolation', pg_catalog.current_setting('transaction_isolation'),
  'current_role', (SELECT pg_catalog.json_build_object(
    'superuser', r.rolsuper, 'inherit', r.rolinherit,
    'create_role', r.rolcreaterole, 'create_database', r.rolcreatedb,
    'can_login', r.rolcanlogin, 'replication', r.rolreplication,
    'bypass_rls', r.rolbypassrls)
    FROM pg_catalog.pg_roles AS r WHERE r.rolname = current_user),
  'session_role', (SELECT pg_catalog.json_build_object(
    'superuser', r.rolsuper, 'inherit', r.rolinherit,
    'create_role', r.rolcreaterole, 'create_database', r.rolcreatedb,
    'can_login', r.rolcanlogin, 'replication', r.rolreplication,
    'bypass_rls', r.rolbypassrls)
    FROM pg_catalog.pg_roles AS r WHERE r.rolname = session_user),
  'database_connect', pg_catalog.has_database_privilege(current_user, pg_catalog.current_database(), 'CONNECT'),
  'database_create', pg_catalog.has_database_privilege(current_user, pg_catalog.current_database(), 'CREATE'),
  'database_temporary', pg_catalog.has_database_privilege(current_user, pg_catalog.current_database(), 'TEMPORARY'),
  'public_usage', pg_catalog.has_schema_privilege(current_user, 'public', 'USAGE'),
  'public_create', pg_catalog.has_schema_privilege(current_user, 'public', 'CREATE')
)
"""


@dataclass(frozen=True, repr=False)
class IdentityCollectionScope:
    operation_id: str
    source_sha256: str
    approved_at: float
    expires_at: float
    max_seconds: float = 5


@dataclass(frozen=True)
class RoleAttributes:
    superuser: bool
    inherit: bool
    create_role: bool
    create_database: bool
    can_login: bool
    replication: bool
    bypass_rls: bool


@dataclass(frozen=True)
class DatabaseIdentityFacts:
    current_user: str
    session_user: str
    database: str
    version_num: int
    read_only: bool
    isolation: str
    current_role: RoleAttributes
    session_role: RoleAttributes
    database_connect: bool
    database_create: bool
    database_temporary: bool
    public_usage: bool
    public_create: bool


@dataclass(frozen=True)
class DatabaseIdentityReceipt:
    operation_id: str
    source_sha256: str
    started_at: float
    observed_at: float
    elapsed_seconds: float
    facts: DatabaseIdentityFacts
    same_loaded_factory: bool = True
    target_verified: bool = False
    deployment_source_verified: bool = False
    source_digest_basis: str = "trusted-caller-attestation"
    schema: str = "runtime-database-identity/v1"


class _Stopped(Exception):
    pass


def _number(value):
    return type(value) in (int, float) and math.isfinite(value)


def _facts(value):
    # Do not forward arbitrary result columns, string representations or errors.
    if type(value) is not dict or set(value) != _FACT_KEYS:
        raise _Stopped()
    if any(type(value[k]) is not str or _IDENTIFIER.fullmatch(value[k]) is None
           for k in ("current_user", "session_user", "database")):
        raise _Stopped()
    if type(value["version_num"]) is not int or not 100000 <= value["version_num"] < 1000000:
        raise _Stopped()
    if value["read_only"] is not True or value["isolation"] != "repeatable read":
        raise _Stopped()
    for name in ("database_connect", "database_create", "database_temporary", "public_usage", "public_create"):
        if type(value[name]) is not bool:
            raise _Stopped()
    roles = {}
    for name in ("current_role", "session_role"):
        role = value[name]
        if type(role) is not dict or set(role) != _ROLE_KEYS or any(type(v) is not bool for v in role.values()):
            raise _Stopped()
        roles[name] = RoleAttributes(**role)
    return DatabaseIdentityFacts(**{**value, **roles})


class RuntimeDatabaseIdentity:
    """One reviewed attempt per instance; revoke permanently cancels this instance.

    Time limits reject late evidence. They do not promise cancellation of a
    blocked connection checkout, driver call, context exit or cleanup. Database
    statement and lock timeouts bound SQL once the connection is available.
    A caller must not create replacement instances as an automatic retry.
    Returned facts are an observation, not permission to enable any feature.
    """
    def __init__(self, session_factory, *, reviewed_source_sha256=None,
                 clock=time.time, monotonic=time.monotonic):
        self._factory = session_factory
        self._engine = getattr(session_factory, "kw", {}).get("bind")
        self._source_sha256 = reviewed_source_sha256
        self._clock, self._monotonic = clock, monotonic
        self._lock = RLock()
        self._generation = 0
        self._attempted = self._revoked = False
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

    def _same_binding(self):
        loaded = sys.modules.get("app.db")
        return (loaded is not None and getattr(loaded, "SessionLocal", None) is self._factory
                and self._engine is not None
                and getattr(self._factory, "kw", {}).get("bind") is self._engine
                and getattr(getattr(self._engine, "dialect", None), "name", None) == "postgresql")

    def _guard(self, scope, generation, started_at, started_mono):
        with self._lock:
            now, mono = self._clock(), self._monotonic()
            if (self._revoked or generation != self._generation or not self._same_binding()
                    or not _number(now) or not _number(mono)
                    or now < started_at or not scope.approved_at <= now < scope.expires_at
                    or mono < started_mono or mono - started_mono >= scope.max_seconds):
                raise _Stopped()
            return now, mono

    def collect(self, scope=None, *, approved=False):
        # This default path does not call clocks, import DB, inspect URLs or query.
        if approved is not True:
            return None
        with self._lock:
            if self._attempted or self._revoked:
                return None
            self._attempted = True
            generation = self._generation
            self._status = "collecting"
        session = None
        facts = None
        cleanup_ok = True
        try:
            if (not isinstance(scope, IdentityCollectionScope)
                    or type(self._source_sha256) is not str or not _DIGEST.fullmatch(self._source_sha256)
                    or scope.source_sha256 != self._source_sha256
                    or type(scope.operation_id) is not str or not _OPERATION.fullmatch(scope.operation_id)
                    or not _number(scope.approved_at) or not _number(scope.expires_at)
                    or not 0 < scope.expires_at - scope.approved_at <= 300
                    or not _number(scope.max_seconds) or not 1 <= scope.max_seconds <= 10):
                raise _Stopped()
            started_at, started_mono = self._clock(), self._monotonic()
            if not _number(started_at) or not _number(started_mono):
                raise _Stopped()
            self._guard(scope, generation, started_at, started_mono)
            from sqlalchemy import text
            self._guard(scope, generation, started_at, started_mono)
            session = self._factory()
            self._guard(scope, generation, started_at, started_mono)
            if session.get_bind() is not self._engine:
                raise _Stopped()
            with session.begin():
                self._guard(scope, generation, started_at, started_mono)
                for sql in _SETTINGS_SQL:
                    self._guard(scope, generation, started_at, started_mono)
                    session.execute(text(sql))
                    self._guard(scope, generation, started_at, started_mono)
                self._guard(scope, generation, started_at, started_mono)
                result = session.execute(text(IDENTITY_SQL))
                self._guard(scope, generation, started_at, started_mono)
                payload = result.scalar_one()
                self._guard(scope, generation, started_at, started_mono)
                facts = _facts(payload)
                self._guard(scope, generation, started_at, started_mono)
            self._guard(scope, generation, started_at, started_mono)
        except Exception:
            # Never return/log str(error), repr(error), a DSN, SQL parameters or
            # unvalidated database output, even for driver and cleanup failures.
            facts = None
        finally:
            if session is not None:
                try:
                    session.close()
                except Exception:
                    cleanup_ok = False
                    facts = None
        with self._lock:
            try:
                if facts is None or not cleanup_ok:
                    raise _Stopped()
                now, mono = self._guard(scope, generation, started_at, started_mono)
                receipt = DatabaseIdentityReceipt(scope.operation_id, self._source_sha256,
                    started_at, now, mono - started_mono, facts)
                self._status = "observed"
                return receipt
            except Exception:
                if not self._revoked:
                    self._status = "failed" if cleanup_ok else "cleanup-failed"
                return None
