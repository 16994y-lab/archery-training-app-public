"""Trusted team API. No startup DDL, public bootstrap, demo identity, or cloud I/O.

Register create_team_router(SessionLocal) only behind the production configuration
and schema-readiness gates. All reads/writes serialize on one bounded transaction
lock so revocation and in-flight writes have a definite order.
"""
from contextlib import contextmanager
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import csv
import hashlib
import io
import json
import os
import re
import secrets
from uuid import UUID, uuid4
import jwt

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from fastapi.exceptions import RequestValidationError
from sqlalchemy import select, text
from sqlalchemy.exc import SQLAlchemyError

from app.auth import authenticated_user_id
from app.account_deletion_barrier import OPTIONAL_BARRIER_SQL, PROTECTED_PUBLIC_TABLES
from app.team_workspace_models import (WorkspaceOwner, CoachApplication, Team, TeamMember,
    TeamInvitation, TeamGrant, TeamSession, TeamGroup, TeamNote, TeamAudit)
from app.team_workspace_projection import (BOWS, STANDARD_TARGETS, exact, integer, number,
    identifier, day, digest, invalid, project_source)

_LOCK = 621662560617158019


_PRIVATE_SETTINGS = (
    'log_destination', 'log_min_messages', 'log_error_verbosity',
    'log_statement', 'log_min_duration_statement', 'log_min_duration_sample',
    'log_transaction_sample_rate', 'log_parameter_max_length_on_error',
    'debug_print_parse', 'debug_print_rewritten', 'debug_print_plan',
    'auto_explain.log_min_duration', 'pgaudit.log', 'pgaudit.role',
    'statement_timeout', 'lock_timeout', 'idle_in_transaction_session_timeout',
    'transaction_timeout', 'exit_on_error',
)
_PRIVATE_SETUP = (
    "SET LOCAL statement_timeout='1000ms'", "SET LOCAL lock_timeout='200ms'",
    "SET LOCAL idle_in_transaction_session_timeout='1000ms'",
    "SET LOCAL transaction_timeout='2000ms'",
    "SET LOCAL log_parameter_max_length_on_error='0'",
    'SET LOCAL debug_print_parse=off', 'SET LOCAL debug_print_rewritten=off',
    'SET LOCAL debug_print_plan=off',
)
# Fixed source and relation lists are part of the reviewed product contract.
# A new product SQL path/table requires a new source review, never an HTTP flag.
_PRIVATE_SCOPE_FILES = ('team_workspace.py', 'team_workspace_models.py', 'team_workspace_projection.py', 'team_workspace_installation.py', 'rewards.py', 'rewards_models.py', 'rewards_installation.py', 'registration_rewards.py', 'registration_models.py', 'admin_operations.py', 'admin_user_directory.py', 'admin_sms_usage.py', 'admin_provider_sms.py', 'admin_provider_bss.py', 'sms_send_gate_models.py', 'admin_operations_models.py', 'operations_telemetry.py', 'photo_contributions.py', 'photo_contribution_manifest.py', 'photo_contribution_models.py', 'db.py', 'photo_contribution_storage.py', 'photo_contribution_retention.py', 'photo_contribution_bootstrap.py', 'photo_contribution_installation.py', 'photo_contribution_cleanup_routes.py', 'product_operations_bootstrap.py', 'auth.py', 'account_auth.py', 'email_enrollment.py', 'email_security.py', 'account_next_compat.py', 'account_next_contract.py', 'email_delivery.py', 'sms_hook.py', 'sms_send_gate.py', 'aliyun_sms_transport.py', 'mobile_documents.py', 'mobile_document_models.py', 'manual_backup_gate.py', 'manual_backup_transport.py', 'mobile_document_privacy.py', 'native_session_relay.py', 'sms_retry_operation.py', 'sms_relay_transport.py', 'account_deletion.py', 'account_deletion_models.py', 'account_deletion_installation.py', 'account_deletion_data.py', 'account_deletion_storage.py', 'account_deletion_barrier.py', 'models.py', 'score_backup_models.py', 'private_media_models.py', 'community_models.py', 'supabase_private_media_store.py', '__init__.py', 'private_media.py', 'score_backup.py', 'scoring.py', 'target_contracts.py')
_PRIVATE_TABLES = PROTECTED_PUBLIC_TABLES
_PRIVATE_SNAPSHOT_COLUMNS = ('pid', 'role', 'session_role', 'version', 'database_oid',
                             'settings', 'function_fingerprint', 'no_user_triggers')
_PRIVATE_SNAPSHOT_SQL = """SELECT pg_backend_pid() AS pid,
 current_user::text AS role, session_user::text AS session_role,
 current_setting('server_version_num') AS version,
 (SELECT oid::text FROM pg_catalog.pg_database WHERE datname=current_database()) AS database_oid,
 (SELECT jsonb_object_agg(name,setting) FROM pg_catalog.pg_settings
  WHERE name IN (""" + ','.join("'" + name + "'" for name in _PRIVATE_SETTINGS) + """)) AS settings,
 (SELECT CASE WHEN count(*)=2 THEN md5(string_agg(
    p.proname || ':' || pg_catalog.pg_get_functiondef(p.oid), E'\\n' ORDER BY p.proname)) ELSE NULL END
  FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname IN
   ('team_workspace_session_active','team_workspace_contact_hint')) AS function_fingerprint,
 """ + OPTIONAL_BARRIER_SQL + " AS no_user_triggers"


def _private_unavailable():
    raise HTTPException(503, "私密数据通道尚未就绪")


def _private_batch(cursor, sequence):
    """Only source-fixed parameter-free SQL, on the Session's existing driver.

    psycopg simple query returns every command. Consume/check every result here;
    SQLAlchemy CursorResult may auto-close an initial SET result without rows.
    Private business statements never enter this function.
    """
    cursor.execute('; '.join(sql for sql, _ in sequence), prepare=False, binary=False)
    snapshots = []
    for index, (_, tag) in enumerate(sequence):
        if index and cursor.nextset() is not True:
            _private_unavailable()
        if cursor.statusmessage != tag:
            _private_unavailable()
        if tag == 'SELECT 1':
            if tuple(column.name for column in (cursor.description or ())) != _PRIVATE_SNAPSHOT_COLUMNS:
                _private_unavailable()
            row = cursor.fetchone()
            if type(row) is not tuple or len(row) != len(_PRIVATE_SNAPSHOT_COLUMNS) or cursor.fetchone() is not None:
                _private_unavailable()
            value = dict(zip(_PRIVATE_SNAPSHOT_COLUMNS, row))
            if type(value['settings']) is not dict or not set(value['settings']) <= set(_PRIVATE_SETTINGS):
                _private_unavailable()
            snapshots.append(value)
        elif cursor.description is not None:
            _private_unavailable()
    if cursor.nextset() is not None:
        _private_unavailable()
    return snapshots


def _private_channels_ready(rows):
    try:
        return (rows.get('log_statement') in ('none', 'ddl')
            and int(rows['log_min_duration_statement']) < 0
            and int(rows['log_min_duration_sample']) < 0
            and float(rows['log_transaction_sample_rate']) == 0
            and rows.get('log_parameter_max_length_on_error') == '0'
            and all(rows.get(name) == 'off' for name in
                    ('debug_print_parse', 'debug_print_rewritten', 'debug_print_plan'))
            and (int(rows.get('auto_explain.log_min_duration', '-1')) < 0
                 or int(rows['auto_explain.log_min_duration']) > 1000)
            and (('pgaudit.log' not in rows and 'pgaudit.role' not in rows)
                 or (rows.get('pgaudit.log') == 'none' and rows.get('pgaudit.role') == ''))
            and rows.get('statement_timeout') == '1000'
            and rows.get('lock_timeout') == '200'
            and rows.get('idle_in_transaction_session_timeout') == '1000'
            and rows.get('transaction_timeout') == '2000'
            and rows.get('exit_on_error') == 'off')
    except (KeyError, ValueError, TypeError):
        return False


def _private_identity(snapshot):
    return tuple(snapshot[key] for key in ('pid', 'role', 'session_role', 'version', 'database_oid'))


def _private_destinations(rows):
    value = rows.get('log_destination')
    if not isinstance(value, str):
        return frozenset()
    items = value.split(',')
    if any(not item.strip() for item in items):
        return frozenset()
    return frozenset(item.strip() for item in items)


def _private_scope_digest():
    # Deployment-local immutable files. Do not read an env proof, a caller's
    # trusted flag, a DB URL, or an external receipt during private operations.
    from pathlib import Path
    root = Path(__file__).resolve().parent
    digest = hashlib.sha256()
    for name in _PRIVATE_SCOPE_FILES:
        digest.update(name.encode('ascii') + b'\0')
        digest.update(hashlib.sha256((root / name).read_bytes()).digest())
    return digest.hexdigest()


def _reviewed_log_matches(snapshot, factory):
    from app.team_privacy_review import REVIEWED_LOG_PROFILE
    # This record is deployed only after an operator has reviewed server logs
    # and the fixed SQL/catalog contract. Default None retains the original gate.
    profile = REVIEWED_LOG_PROFILE
    fields = {'schema', 'serverLogEvidenceSHA256', 'catalogEvidenceSHA256',
              'sourceScopeSHA256', 'serverVersion', 'role', 'sessionRole',
              'databaseOID', 'destinations', 'functionFingerprint',
              'ordinaryErrorVerdict', 'allDestinationsCovered',
              'fatalScopeReview', 'reviewedAtUTC'}
    if type(profile) is not dict or set(profile) != fields:
        return False
    if (profile['schema'] != 'team-private-log-reviewed-v1'
        or profile['ordinaryErrorVerdict'] != 'PASS_23505_CONTROL_DETAIL_AND_PROTECTED_ABSENCE'
        or profile['allDestinationsCovered'] is not True
        or profile['fatalScopeReview'] != 'FIXED_SQL_NO_UNREVIEWED_RAISE_OR_CONTEXT'
        or any(not isinstance(profile[key], str) or not re.fullmatch('[a-f0-9]{64}', profile[key])
               for key in ('serverLogEvidenceSHA256', 'catalogEvidenceSHA256', 'sourceScopeSHA256'))
        or type(profile['destinations']) is not tuple
        or not re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z', str(profile['reviewedAtUTC']))):
        return False
    try:
        # Only the original configured SessionLocal may use this actual review.
        if factory is not _default_factory() or profile['sourceScopeSHA256'] != _private_scope_digest():
            return False
    except (OSError, ValueError):
        return False
    destinations = _private_destinations(snapshot['settings'])
    return (destinations and destinations <= {'stderr', 'csvlog', 'jsonlog', 'syslog', 'eventlog'}
        and destinations == frozenset(profile['destinations'])
        and snapshot['version'] == profile['serverVersion']
        and snapshot['role'] == profile['role'] and snapshot['session_role'] == profile['sessionRole']
        and snapshot['database_oid'] == profile['databaseOID']
        and isinstance(snapshot['function_fingerprint'], str)
        and re.fullmatch('[a-f0-9]{32}', snapshot['function_fingerprint']) is not None
        and snapshot['function_fingerprint'] == profile['functionFingerprint']
        and snapshot['no_user_triggers'] is True)


def _require_private_transaction(db, factory=None):
    """Fail closed before ANY account/business value, on this transaction only."""
    engine = db.get_bind()
    if engine.echo or engine.hide_parameters is not True:
        _private_unavailable()
    # No new engine, connection, transaction, role, or autocommit state.
    # Native driver failure is normalized here because SQLAlchemy did not wrap it.
    from psycopg import Error as DriverError, pq
    from psycopg.rows import tuple_row
    sa_connection = db.connection()
    connection = sa_connection.connection.driver_connection
    if (type(connection).__module__ != 'psycopg'
        or connection.autocommit is not False
        or connection.info.pipeline_status != pq.PipelineStatus.OFF
        or connection.info.transaction_status not in (pq.TransactionStatus.IDLE, pq.TransactionStatus.INTRANS)):
        _private_unavailable()
    try:
        with connection.cursor(row_factory=tuple_row) as cursor:
            sequence = tuple((sql, 'SET') for sql in _PRIVATE_SETUP) + ((_PRIVATE_SNAPSHOT_SQL, 'SELECT 1'),)
            after, = _private_batch(cursor, sequence)
            if (type(after['pid']) is not int or after['pid'] < 1
                or not _private_channels_ready(after['settings'])
                or after['no_user_triggers'] is not True):
                _private_unavailable()
            destinations = _private_destinations(after['settings'])
            # Keep the terse guard, but structured CSV/JSON writers retain DETAIL
            # independently of verbosity. Unknown destinations are not accepted.
            if (after['settings'].get('log_error_verbosity') == 'terse'
                and destinations and destinations <= {'stderr', 'syslog', 'eventlog'}):
                return
            if not _reviewed_log_matches(after, factory):
                _private_unavailable()
            # No role elevation or ignored SET error. Review is necessary but this
            # connection must still set and read LOG before any private bind.
            checked, = _private_batch(cursor, (("SET LOCAL log_min_messages='log'", 'SET'),
                                                (_PRIVATE_SNAPSHOT_SQL, 'SELECT 1')))
            if (_private_identity(checked) != _private_identity(after)
                or not _private_channels_ready(checked['settings'])
                or checked['settings'].get('log_min_messages') != 'log'
                or not _reviewed_log_matches(checked, factory)):
                _private_unavailable()
    except DriverError:
        # Raw-driver errors bypass SQLAlchemy's usual disconnect detection.
        # Discard a terminated connection; never replay this transaction.
        if connection.closed or connection.broken:
            sa_connection.invalidate()
        raise HTTPException(503, "私密数据通道尚未就绪") from None


_MAX_BODY = 4 * 1024 * 1024
_DIMENSIONS = ("bow", "distance", "size", "targetId", "rulesVersion")


def denied():
    raise HTTPException(403, "当前账号没有此操作权限")


def absent():
    raise HTTPException(404, "该团队或共享记录当前不可访问")


def conflict():
    raise HTTPException(409, "状态或版本已变化，请重新读取核对")


def _uid(value):
    try:
        if not isinstance(value, str) or str(UUID(value)) != value:
            invalid()
    except ValueError:
        invalid()
    return value


def _string(value, maximum, required=False):
    if not isinstance(value, str) or len(value) > maximum or any(ord(c) < 32 and c not in "\n\t" for c in value) or (required and not value.strip()):
        invalid()
    return value.strip()


def _version(value):
    if not integer(value):
        invalid()
    return value


def _default_factory():
    from app.db import SessionLocal
    return SessionLocal


@contextmanager
def _transaction(factory):
    """Same connection for authorization, data, mutation, audit and commit."""
    try:
        with factory() as db:
            with db.begin():
                dialect = db.get_bind().dialect.name
                if dialect == "postgresql":
                    _require_private_transaction(db, factory=factory)
                    db.execute(text("SELECT pg_advisory_xact_lock(:lock)"), {"lock": _LOCK})
                elif dialect == "sqlite":
                    db.execute(text("BEGIN IMMEDIATE"))
                else:
                    raise HTTPException(503, "团队存储尚未就绪")
                yield db
    except SQLAlchemyError:
        # No SQL parameters, object names, submitted values or driver messages.
        raise HTTPException(503, "团队存储暂不可用，请读取状态后核对") from None


def bootstrap_owner(session_factory, verified_uid):
    """Operator-only, one-time binding. Input must be an independently verified UID.

    This is deliberately not an HTTP endpoint. PostgreSQL additionally verifies
    the existing, non-anonymous, phone-confirmed Auth account in this transaction.
    SQLite is exclusively an isolated test/local persistence backend.
    """
    uid = _uid(verified_uid)
    with _transaction(session_factory) as db:
        current = db.get(WorkspaceOwner, 1)
        if current:
            if current.user_id != uid:
                conflict()
            return {"initialized": True, "replayed": True}
        if db.get_bind().dialect.name == "postgresql":
            user = db.execute(text("SELECT id::text AS id, is_anonymous, phone_confirmed_at, banned_until, deleted_at, (phone IS NOT NULL AND phone <> '') AS has_phone FROM auth.users WHERE id=CAST(:uid AS uuid)"), {"uid": uid}).mappings().one_or_none()
            if not user or user["is_anonymous"] or user["deleted_at"] or not user["has_phone"] or not user["phone_confirmed_at"] or (user["banned_until"] and user["banned_until"] > datetime.now(timezone.utc)):
                denied()
        db.add(WorkspaceOwner(slot=1, user_id=uid))
        return {"initialized": True, "replayed": False}


class _TeamActor(str):
    """Internal principal: UID from team_verified_user_id, session from that same JWT."""
    def __new__(cls, owner, session_id):
        value = str.__new__(cls, owner)
        value.session_id = session_id
        return value


@contextmanager
def _phone_status_session():
    # The inherited phone/email status query receives this same protected
    # connection. Do not take the team lock before the original email guard.
    factory = _default_factory()
    with factory() as db:
        with db.begin():
            if db.get_bind().dialect.name != "postgresql":
                _private_unavailable()
            _require_private_transaction(db, factory=factory)
            yield db


def team_verified_user_id(authorization: str | None = Header(default=None)) -> str:
    # Admission of an already-confirmed phone is independent of enabling the
    # account-maintenance routes. Keep all original phone and email checks.
    if os.getenv("AUTH_MODE") != "supabase":
        raise HTTPException(503, "团队身份验证尚未接入")
    owner = authenticated_user_id(authorization)
    from app.account_auth import PostgresAccountStore
    from app.sms_send_gate import SmsSendBudget
    if not PostgresAccountStore(_phone_status_session, SmsSendBudget.from_env()).status(owner)["phoneVerified"]:
        raise HTTPException(403, "请先绑定并验证中国大陆手机号")
    return owner


def team_actor(owner: str = Depends(team_verified_user_id), authorization: str | None = Header(default=None)) -> str:
    # Existing development auth's local-dev fallback must never confer team roles.
    if os.getenv("AUTH_MODE") != "supabase":
        raise HTTPException(503, "团队身份验证尚未接入")
    try:
        if not authorization or not authorization.startswith("Bearer "):
            raise ValueError()
        # Verification already occurred in the dependency against the SAME Header.
        # This decode only extracts session_id; no metadata supplies authorization.
        claims = jwt.decode(authorization.removeprefix("Bearer "), options={"verify_signature": False})
        session_id = claims.get("session_id")
        if claims.get("sub") != owner or str(UUID(owner)) != owner or not isinstance(session_id, str) or str(UUID(session_id)) != session_id:
            raise ValueError()
    except (jwt.PyJWTError, ValueError, TypeError, AttributeError):
        raise HTTPException(401, "登录会话无效，请重新登录") from None
    return _TeamActor(owner, session_id)


def _session_active(db, owner, session_id):
    # Root supplies a restricted function; absent function/permissions fail closed.
    return db.execute(text("SELECT public.team_workspace_session_active(CAST(:owner AS uuid),CAST(:session_id AS uuid))"),
                      {"owner": str(owner), "session_id": session_id}).scalar_one() is True


class TeamWorkspace:
    def __init__(self, session_factory=None, clock=None, session_verifier=None):
        self.factory = session_factory or _default_factory()
        self.clock = clock or (lambda: datetime.now(timezone.utc))
        self.session_verifier = session_verifier or _session_active

    @contextmanager
    def transaction(self, actor):
        if not isinstance(actor, _TeamActor):
            raise HTTPException(401, "登录会话无效，请重新登录")
        with _transaction(self.factory) as db:
            if self.session_verifier(db, str(actor), actor.session_id) is not True:
                raise HTTPException(401, "登录会话已失效，请重新登录")
            yield db

    def now(self):
        value = self.clock()
        if not isinstance(value, datetime) or value.tzinfo is None:
            raise HTTPException(503, "团队时间服务暂不可用")
        return value.astimezone(timezone.utc)

    def stamp(self):
        return self.now().isoformat(timespec="microseconds")

    def today(self):
        return (self.now() + timedelta(hours=8)).date().isoformat()

    def _audit(self, db, actor, action, subject, version, reason=""):
        db.add(TeamAudit(id=str(uuid4()), actor_id=actor, action=action, subject_id=subject, version=version, at=self.stamp(), reason=reason))

    @staticmethod
    def _admin(db, actor):
        row = db.get(WorkspaceOwner, 1)
        if not row or row.user_id != actor:
            denied()

    @staticmethod
    def _coach(db, actor):
        row = db.get(CoachApplication, actor)
        if not row or row.status != "approved":
            denied()
        return row

    def _team(self, db, team_id, actor=None):
        if not identifier(team_id):
            absent()
        row = db.get(Team, team_id)
        if not row:
            absent()
        if actor is not None:
            self._coach(db, actor)
            if row.coach_id != actor:
                absent()
        return row

    @staticmethod
    def _member(db, team_id, actor, active=False):
        row = db.scalar(select(TeamMember).where(TeamMember.team_id == team_id, TeamMember.user_id == actor))
        if not row or (active and row.status != "active"):
            absent()
        return row

    def _grant_json(self, row):
        return {"version": row.version, "active": row.active, "sessionIds": row.session_ids,
                "includeFuture": row.include_future, "futureFrom": row.future_from, "expiresOn": row.expires_on,
                "effectiveActive": row.active and (not row.expires_on or row.expires_on >= self.today())} if row else None

    def _grant_active(self, row, team):
        return bool(row and row.active and row.recipient_id == team.coach_id and (not row.expires_on or row.expires_on >= self.today()))

    def _scope(self, grant, team, projection):
        return self._grant_active(grant, team) and (projection["id"] in grant.session_ids or (grant.include_future and grant.future_from is not None and projection["date"] >= grant.future_from))

    @staticmethod
    def _invalidate_grant(row):
        if row and row.active:
            row.active = False
            row.version += 1

    @staticmethod
    def _application(row):
        return {"status": row.status, "version": row.version, "name": row.name, "organisation": row.organisation, "reason": row.reason} if row else None

    def _team_json(self, db, team, member=None):
        coach = db.get(CoachApplication, team.coach_id)
        groups = [g.value for g in db.scalars(select(TeamGroup).where(TeamGroup.team_id == team.id)).all()]
        if member:
            groups = [g for g in groups if member.id in g["memberIds"]]
        grant = self._grant_json(db.get(TeamGrant, (team.id, member.id))) if member else None
        if grant:
            grant["effectiveActive"] = grant["effectiveActive"] and member.status == "active" and bool(coach and coach.status == "approved")
        return {"id": team.id, "name": team.name, "coachId": team.coach_id,
                "coachName": coach.name if coach else "", "memberId": member.id if member else None,
                "memberStatus": member.status if member else None, "memberVersion": member.version if member else None,
                "grant": grant, "groups": groups}

    def me(self, actor, params, body):
        with self.transaction(actor) as db:
            roles = ["user"]
            owner, coach = db.get(WorkspaceOwner, 1), db.get(CoachApplication, actor)
            if owner and owner.user_id == actor:
                roles.append("admin")
            if coach and coach.status == "approved":
                roles.append("coach")
            memberships = {m.team_id: m for m in db.scalars(select(TeamMember).where(TeamMember.user_id == actor)).all()}
            team_ids = set(memberships)
            if "coach" in roles:
                team_ids.update(t.id for t in db.scalars(select(Team).where(Team.coach_id == actor)).all())
            teams = [self._team_json(db, db.get(Team, tid), memberships.get(tid)) for tid in sorted(team_ids)]
            return {"roles": roles, "coach": self._application(coach), "teams": teams}

    def apply(self, actor, params, body):
        exact(body, ("name", "organisation", "note"))
        name, organisation, note = _string(body["name"], 80, True), _string(body["organisation"], 120), _string(body["note"], 1000)
        with self.transaction(actor) as db:
            row = db.get(CoachApplication, actor)
            if row and row.status in ("approved", "suspended"):
                denied()
            if row and row.status == "pending" and (row.name, row.organisation, row.note) == (name, organisation, note):
                return self._application(row)
            version = row.version + 1 if row else 1
            if not row:
                row = CoachApplication(user_id=actor)
                db.add(row)
            row.name, row.organisation, row.note, row.status, row.version, row.reason, row.updated_at = name, organisation, note, "pending", version, "", self.stamp()
            self._audit(db, actor, "coach-applied", actor, version)
            return self._application(row)

    def admin_list(self, actor, params, body):
        with self.transaction(actor) as db:
            self._admin(db, actor)
            items = []
            for c in db.scalars(select(CoachApplication).order_by(CoachApplication.updated_at.desc())).all():
                hint = db.execute(text("SELECT public.team_workspace_contact_hint(CAST(:owner AS uuid))"), {"owner": c.user_id}).scalar_one() if db.get_bind().dialect.name == "postgresql" else "本地合成账号"
                items.append({"userId": c.user_id, **self._application(c), "applicationNote": c.note, "reason": c.reason, "phoneDisplay": hint or "已验证账号", "updatedAt": c.updated_at})
            return {"items": items}

    def admin_update(self, actor, params, body):
        uid = _uid(params["user_id"])
        exact(body, ("status", "expectedVersion", "reason"))
        if body["status"] not in ("approved", "suspended", "rejected"):
            invalid()
        version, reason = _version(body["expectedVersion"]), _string(body["reason"], 500)
        with self.transaction(actor) as db:
            self._admin(db, actor)
            row = db.get(CoachApplication, uid)
            if not row:
                absent()
            if row.version != version:
                conflict()
            row.status, row.version, row.reason, row.updated_at = body["status"], version+1, reason, self.stamp()
            team = db.scalar(select(Team).where(Team.coach_id == uid))
            if row.status == "approved" and not team:
                db.add(Team(id=str(uuid4()), coach_id=uid, name=(row.name + "的训练队")[:100]))
            elif row.status != "approved" and team:
                for grant in db.scalars(select(TeamGrant).where(TeamGrant.team_id == team.id)).all():
                    self._invalidate_grant(grant)
            self._audit(db, actor, "coach-"+body["status"], uid, row.version, row.reason)
            return {"userId": uid, **self._application(row), "updatedAt": row.updated_at}

    def coach_teams(self, actor, params, body):
        with self.transaction(actor) as db:
            self._coach(db, actor)
            return {"items": [self._team_json(db, t) for t in db.scalars(select(Team).where(Team.coach_id == actor)).all()]}

    def invite(self, actor, params, body):
        exact(body, ("requestId", "label", "category"))
        if not identifier(body["requestId"]) or body["category"] not in ("men", "women", "unknown"):
            invalid()
        label = _string(body["label"], 80, True)
        request_hash = digest({"label": label, "category": body["category"]})
        with self.transaction(actor) as db:
            team = self._team(db, params["team_id"], actor)
            old = db.scalar(select(TeamInvitation).where(TeamInvitation.team_id == team.id, TeamInvitation.request_id == body["requestId"]))
            if old:
                if old.request_hash != request_hash:
                    conflict()
                return {"invitationId": old.id, "inviteToken": None, "expiresAt": old.expires_at, "replayed": True, "tokenUnavailable": True}
            token, mid = secrets.token_urlsafe(32), str(uuid4())
            row = TeamInvitation(id=str(uuid4()), team_id=team.id, member_id=mid, request_id=body["requestId"], request_hash=request_hash,
                                 token_hash=hashlib.sha256(token.encode()).hexdigest(), expires_at=(self.now()+timedelta(hours=24)).isoformat(timespec="microseconds"), accepted_by=None)
            db.add(TeamMember(id=mid, team_id=team.id, user_id=None, label=label, category=body["category"], status="invited", version=1))
            db.add(row)
            self._audit(db, actor, "invitation-created", row.id, 1)
            return {"invitationId": row.id, "inviteToken": token, "expiresAt": row.expires_at, "replayed": False}

    def accept(self, actor, params, body):
        exact(body, ("inviteToken",))
        token = body["inviteToken"]
        if not isinstance(token, str) or not re.fullmatch(r"[A-Za-z0-9_-]{43}", token):
            invalid()
        hashed = hashlib.sha256(token.encode()).hexdigest()
        with self.transaction(actor) as db:
            invite = db.scalar(select(TeamInvitation).where(TeamInvitation.token_hash == hashed))
            if not invite or invite.expires_at <= self.stamp():
                absent()
            team = self._team(db, invite.team_id)
            self._coach(db, team.coach_id)
            if team.coach_id == actor:
                denied()
            if invite.accepted_by:
                if invite.accepted_by != actor:
                    absent()
                return {"teamId": team.id, "memberId": invite.member_id, "status": db.get(TeamMember, invite.member_id).status, "replayed": True}
            if db.scalar(select(TeamMember).where(TeamMember.team_id == team.id, TeamMember.user_id == actor)):
                conflict()
            member = db.get(TeamMember, invite.member_id)
            if not member or member.status != "invited" or member.user_id is not None:
                conflict()
            member.user_id, member.status, member.version = actor, "pending", member.version+1
            invite.accepted_by = actor
            self._audit(db, actor, "invitation-accepted", member.id, member.version)
            return {"teamId": team.id, "memberId": member.id, "status": "pending", "replayed": False}

    def member_update(self, actor, params, body):
        exact(body, ("status", "expectedVersion"))
        if body["status"] not in ("active", "inactive"):
            invalid()
        expected = _version(body["expectedVersion"])
        with self.transaction(actor) as db:
            team = self._team(db, params["team_id"], actor)
            row = db.get(TeamMember, params["member_id"])
            if not row or row.team_id != team.id or not row.user_id:
                absent()
            if row.version != expected:
                conflict()
            row.status, row.version = body["status"], expected+1
            if row.status == "inactive":
                self._invalidate_grant(db.get(TeamGrant, (team.id, row.id)))
            self._audit(db, actor, "member-"+row.status, row.id, row.version)
            return {"id": row.id, "status": row.status, "version": row.version}

    def sharing(self, actor, params, body):
        with self.transaction(actor) as db:
            team = self._team(db, params["team_id"])
            member = self._member(db, team.id, actor)
            grant = db.get(TeamGrant, (team.id, member.id))
            coach = db.get(CoachApplication, team.coach_id)
            grant_value = self._grant_json(grant)
            if grant_value:
                grant_value["effectiveActive"] = grant_value["effectiveActive"] and member.status == "active" and coach.status == "approved"
            records = [r.projection for r in db.scalars(select(TeamSession).where(TeamSession.team_id == team.id, TeamSession.member_id == member.id)).all()]
            return {"team": {"id": team.id, "name": team.name}, "recipient": {"id": team.coach_id, "label": coach.name}, "grant": grant_value,
                    "records": [{"id": r["id"], "date": r["date"], "arrows": r["summary"]["arrows"], "total": r["summary"]["total"], "status": "completed", "shared": member.status == "active" and coach.status == "approved" and self._scope(grant, team, r)} for r in records]}

    def save_sharing(self, actor, params, body):
        exact(body, ("expectedVersion", "sessionIds", "includeFuture", "futureFrom", "expiresOn"))
        version = _version(body["expectedVersion"])
        ids, future, start, expiry = body["sessionIds"], body["includeFuture"], body["futureFrom"], body["expiresOn"]
        if type(ids) is not list or len(ids) > 5000 or any(not identifier(i) for i in ids) or len(set(ids)) != len(ids) or type(future) is not bool or (not ids and not future):
            invalid()
        if (future and start is None) or (not future and start is not None):
            invalid()
        if start is not None:
            day(start)
        if expiry is not None:
            day(expiry)
            if expiry < self.today() or (start and expiry < start):
                invalid()
        with self.transaction(actor) as db:
            team = self._team(db, params["team_id"])
            self._coach(db, team.coach_id)
            member = self._member(db, team.id, actor, True)
            row = db.get(TeamGrant, (team.id, member.id))
            if (row.version if row else 0) != version:
                conflict()
            unchanged_start = bool(row and self._grant_active(row, team) and row.include_future and row.future_from == start)
            if start and start < self.today() and not unchanged_start:
                invalid()
            if not row:
                row = TeamGrant(team_id=team.id, member_id=member.id)
                db.add(row)
            row.recipient_id, row.version, row.active, row.session_ids = team.coach_id, version+1, True, sorted(ids)
            row.include_future, row.future_from, row.expires_on = future, start, expiry
            self._audit(db, actor, "sharing-updated", member.id, row.version)
            return {"grant": self._grant_json(row)}

    def revoke(self, actor, params, body):
        exact(body, ("expectedVersion",))
        expected = _version(body["expectedVersion"])
        with self.transaction(actor) as db:
            team = self._team(db, params["team_id"])
            member = self._member(db, team.id, actor)
            row = db.get(TeamGrant, (team.id, member.id))
            if (row.version if row else 0) != expected:
                conflict()
            if not row:
                row = TeamGrant(team_id=team.id, member_id=member.id, recipient_id=team.coach_id,
                                session_ids=[], include_future=False, future_from=None, expires_on=None)
                db.add(row)
            row.active, row.version = False, expected+1
            self._audit(db, actor, "sharing-revoked", member.id, row.version)
            return {"grant": self._grant_json(row)}

    @staticmethod
    def _receipt(row):
        return {"revision": row.source_revision, "sourceHash": row.source_hash, "source": row.source}

    def upload(self, actor, params, body):
        exact(body, ("grantVersion", "source"))
        version = _version(body["grantVersion"])
        if not identifier(params["session_id"]):
            invalid()
        with self.transaction(actor) as db:
            team = self._team(db, params["team_id"])
            self._coach(db, team.coach_id)
            member = self._member(db, team.id, actor, True)
            grant = db.get(TeamGrant, (team.id, member.id))
            if not self._grant_active(grant, team):
                denied()
            if grant.version != version:
                conflict()
            projection, hashed = project_source(member.id, body["source"], self.stamp())
            if projection["id"] != params["session_id"] or not self._scope(grant, team, projection):
                denied()
            row = db.get(TeamSession, (team.id, member.id, projection["id"]))
            if row and (row.source_revision > projection["revision"] or (row.source_revision == projection["revision"] and row.source_hash != hashed)):
                conflict()
            if row and row.source_revision == projection["revision"]:
                return {**self._receipt(row), "replayed": True}
            if not row:
                row = TeamSession(team_id=team.id, member_id=member.id, session_id=projection["id"])
                db.add(row)
            row.source_revision, row.source_hash, row.source, row.projection = projection["revision"], hashed, deepcopy(body["source"]), projection
            self._audit(db, actor, "session-shared", row.session_id, row.source_revision)
            from app.operations_telemetry import record_business_result
            record_business_result(db, "sharing", str(actor), team.id+":"+member.id+":"+row.session_id+":"+str(row.source_revision), "success", "shared", self.stamp())
            return {**self._receipt(row), "replayed": False}

    def read_receipt(self, actor, params, body):
        with self.transaction(actor) as db:
            team = self._team(db, params["team_id"])
            member = self._member(db, team.id, actor)
            row = db.get(TeamSession, (team.id, member.id, params["session_id"]))
            if not row:
                absent()
            return self._receipt(row)

    def _visible(self, db, team):
        members = db.scalars(select(TeamMember).where(TeamMember.team_id == team.id)).all()
        allowed = {m.id: m for m in members if m.status == "active" and m.user_id}
        grants = {g.member_id: g for g in db.scalars(select(TeamGrant).where(TeamGrant.team_id == team.id)).all()}
        sessions = [r.projection for r in db.scalars(select(TeamSession).where(TeamSession.team_id == team.id)).all()
                    if r.member_id in allowed and self._scope(grants.get(r.member_id), team, r.projection)]
        sessions.sort(key=lambda s: (s["date"], s["memberId"], s["id"]), reverse=True)
        return members, grants, sessions

    def _review(self, db, team):
        members, grants, sessions = self._visible(db, team)
        counts = {m.id: sum(s["memberId"] == m.id for s in sessions) for m in members}
        available = {(s["memberId"], s["id"]) for s in sessions}
        roster = [{"id": m.id, "userId": m.user_id, "label": m.label, "category": m.category, "memberStatus": m.status, "version": m.version,
                   "status": m.status,
                   "sharingStatus": "shared" if m.status == "active" and self._grant_active(grants.get(m.id), team) else "expired" if grants.get(m.id) and grants[m.id].active and grants[m.id].expires_on and grants[m.id].expires_on < self.today() else "revoked" if grants.get(m.id) else "not-shared",
                   "sharedCount": counts[m.id]} for m in members]
        notes = [n.value for n in db.scalars(select(TeamNote).where(TeamNote.team_id == team.id, TeamNote.coach_id == team.coach_id)).all() if (n.member_id, n.session_id) in available]
        return {"team": {"id": team.id, "name": team.name}, "members": roster, "sessions": sessions,
                "groups": [g.value for g in db.scalars(select(TeamGroup).where(TeamGroup.team_id == team.id)).all()], "notes": notes, "generatedAt": self.stamp()}

    def review(self, actor, params, body):
        with self.transaction(actor) as db:
            return self._review(db, self._team(db, params["team_id"], actor))

    def _session(self, db, team, member_id, session_id):
        row = db.get(TeamSession, (team.id, member_id, session_id))
        member = db.get(TeamMember, member_id)
        if not row or not member or member.team_id != team.id or member.status != "active" or not self._scope(db.get(TeamGrant, (team.id, member_id)), team, row.projection):
            absent()
        return row.projection

    def session(self, actor, params, body):
        with self.transaction(actor) as db:
            team = self._team(db, params["team_id"], actor)
            return self._session(db, team, params["member_id"], params["session_id"])

    def note(self, actor, params, body):
        exact(body, ("memberId", "sessionId", "expectedVersion", "sourceRevision", "text"))
        expected, source_revision = _version(body["expectedVersion"]), _version(body["sourceRevision"])
        content = _string(body["text"], 2000)
        if not identifier(body["memberId"]) or not identifier(body["sessionId"]):
            invalid()
        with self.transaction(actor) as db:
            team = self._team(db, params["team_id"], actor)
            source = self._session(db, team, body["memberId"], body["sessionId"])
            key = (team.id, body["memberId"], body["sessionId"])
            row = db.get(TeamNote, key)
            if source["revision"] != source_revision or (row.value["version"] if row else 0) != expected:
                conflict()
            value = {"memberId": body["memberId"], "sessionId": body["sessionId"], "sourceRevision": source_revision, "version": expected+1, "text": content, "updatedAt": self.stamp()}
            if not row:
                row = TeamNote(team_id=team.id, member_id=body["memberId"], session_id=body["sessionId"], coach_id=actor)
                db.add(row)
            row.value = value
            return value

    def group(self, actor, params, body):
        exact(body, ("id", "expectedVersion", "name", "kind", "memberIds", "preset", "config"))
        name, expected = _string(body["name"], 60, True), _version(body["expectedVersion"])
        ids, kind, config = body["memberIds"], body["kind"], body["config"]
        if body["id"] is not None and not identifier(body["id"]):
            invalid()
        if kind not in ("mixed", "men", "women") or type(ids) is not list or len(ids) != (2 if kind == "mixed" else 3) or any(not identifier(i) for i in ids) or len(set(ids)) != len(ids):
            invalid()
        exact(config, ("bow", "distance", "size", "targetId", "ends", "arrowsPerAthlete", "scoring"))
        if config["bow"] not in BOWS or not number(config["distance"], 1, 1000) or not number(config["size"], 1, 1000) or config["targetId"] not in STANDARD_TARGETS or not integer(config["ends"], 1, 100) or not integer(config["arrowsPerAthlete"], 1, 30) or config["scoring"] not in ("set", "cumulative") or body["preset"] not in ("custom", "wa-recurve", "wa-compound"):
            invalid()
        with self.transaction(actor) as db:
            team = self._team(db, params["team_id"], actor)
            members = [db.get(TeamMember, mid) for mid in ids]
            if any(not m or m.team_id != team.id or m.status != "active" or m.category not in ("men", "women") for m in members):
                invalid()
            categories = [m.category for m in members]
            if (kind == "mixed" and sorted(categories) != ["men", "women"]) or (kind != "mixed" and any(c != kind for c in categories)):
                invalid()
            row = db.get(TeamGroup, body["id"]) if body["id"] else None
            if body["id"] and (not row or row.team_id != team.id):
                absent()
            if (row.value["version"] if row else 0) != expected:
                conflict()
            preset_config = {"wa-recurve": {"bow": "反曲弓", "distance": 70, "size": 122, "targetId": "mobile-full", "ends": 4, "arrowsPerAthlete": 2, "scoring": "set"},
                             "wa-compound": {"bow": "复合弓", "distance": 50, "size": 80, "targetId": "mobile-five", "ends": 4, "arrowsPerAthlete": 2, "scoring": "cumulative"}}
            id_ = body["id"] or str(uuid4())
            value = {"id": id_, "version": expected+1, "name": name, "kind": kind, "memberIds": ids,
                     "preset": body["preset"] if config == preset_config.get(body["preset"]) else "custom", "config": config, "updatedAt": self.stamp()}
            if not row:
                row = TeamGroup(id=id_, team_id=team.id)
                db.add(row)
            row.value = value
            return value

    def report(self, actor, params, body):
        exact(body, ("filters", "groupId"))
        filters = body["filters"]
        if type(filters) is not dict or filters.keys() - set(_DIMENSIONS + ("from", "to")) or any(not isinstance(v, str) or len(v) > 100 for v in filters.values()) or (body["groupId"] is not None and not identifier(body["groupId"])):
            invalid()
        for key in ("from", "to"):
            if filters.get(key):
                day(filters[key])
        if filters.get("from") and filters.get("to") and filters["from"] > filters["to"]:
            invalid()
        with self.transaction(actor) as db:
            team = self._team(db, params["team_id"], actor)
            review = self._review(db, team)
            group = db.get(TeamGroup, body["groupId"]) if body["groupId"] else None
            if body["groupId"] and (not group or group.team_id != team.id):
                absent()
            def string(v):
                return "unknown" if v is None else str(int(v)) if type(v) is float and v.is_integer() else str(v)
            sessions = [s for s in review["sessions"] if all(not filters.get(k) or string(s["conditions"][k]) == filters[k] for k in _DIMENSIONS)
                        and (not filters.get("from") or s["date"] >= filters["from"]) and (not filters.get("to") or s["date"] <= filters["to"])
                        and (not group or s["memberId"] in group.value["memberIds"])]
            rows = []
            for member in review["members"]:
                cohorts = {}
                for s in sessions:
                    if s["memberId"] == member["id"]:
                        cohorts.setdefault(s["groupKey"] or s["id"], []).append(s)
                for values in cohorts.values():
                    first = values[0]
                    total, arrows = sum(s["summary"]["total"] for s in values), sum(s["summary"]["arrows"] for s in values)
                    c = first["conditions"]
                    rows.append(["本人授权共享", filters.get("from", ""), filters.get("to", ""), member["label"], c["bow"], c["distance"], c["targetName"], c["size"], c["rulesVersion"], len(values), arrows, total, f"{total/arrows:.4f}" if first["groupKey"] else "",
                                 *[sum(s["summary"]["distribution"][code] for s in values) for code in ("X", "10", "M")], sum(s["summary"]["trustedPoints"] for s in values), review["generatedAt"]])
            buffer = io.StringIO(newline="")
            writer = csv.writer(buffer, quoting=csv.QUOTE_ALL, lineterminator="\r\n")
            writer.writerow(["数据性质", "开始日期", "结束日期（含）", "队员", "弓种", "距离m", "靶型", "尺寸cm", "计分规则", "场数", "箭数", "总分", "箭均", "X", "普通10", "M", "可信落点", "生成时间"])
            for row in rows:
                safe = ["" if v is None else str(v) for v in row]
                writer.writerow(["'"+v if re.match(r"^\s*[=+@-]", v) else v for v in safe])
            return {"csv": "\ufeff"+buffer.getvalue().removesuffix("\r\n"), "rows": len(rows), "arrows": sum(s["summary"]["arrows"] for s in sessions), "generatedAt": review["generatedAt"]}


async def _body(request):
    data = bytearray()
    async for chunk in request.stream():
        data.extend(chunk)
        if len(data) > _MAX_BODY:
            raise HTTPException(413, "请求超过团队上传容量")
    if request.method == "GET":
        if data or request.query_params:
            invalid()
        return {}
    if request.headers.get("content-type", "").split(";")[0].strip().lower() != "application/json":
        invalid()
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                invalid()
            result[key] = value
        return result
    def reject_constant(_):
        invalid()
    try:
        value = json.loads(data, object_pairs_hook=unique, parse_constant=reject_constant)
    except (ValueError, UnicodeError, RecursionError):
        invalid()
    if type(value) is not dict:
        invalid()
    return value


class _TeamRoute(APIRoute):
    def get_route_handler(self):
        original = super().get_route_handler()
        async def guarded(request):
            try:
                return await original(request)
            except HTTPException as error:
                error.headers = {**(error.headers or {}), "Cache-Control": "no-store"}
                raise
            except RequestValidationError:
                raise HTTPException(422, "请求格式或共享范围无效", headers={"Cache-Control": "no-store"}) from None
        return guarded


def create_team_router(session_factory=None, clock=None, session_verifier=None, failure_observer=None):
    service = TeamWorkspace(session_factory, clock, session_verifier)
    result = APIRouter(prefix="/api/team", tags=["team-workspace"], route_class=_TeamRoute)
    def endpoint(operation):
        async def handle(request: Request, actor: str = Depends(team_actor)):
            body = await _body(request)
            try:
                value = await run_in_threadpool(getattr(service, operation), actor, request.path_params, body)
            except HTTPException as error:
                if failure_observer is not None and operation in ('upload', 'admin_update'):
                    await run_in_threadpool(failure_observer, actor, operation, body, error.status_code, request.path_params)
                raise
            except (TypeError, ValueError, KeyError, OverflowError, RecursionError):
                invalid()
            return JSONResponse(value, headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})
        handle.__name__ = "team_"+operation
        return handle
    for path, method, operation in [
        ("/me", "GET", "me"), ("/coach-application", "POST", "apply"),
        ("/admin/coaches", "GET", "admin_list"), ("/admin/coaches/{user_id}", "PUT", "admin_update"),
        ("/coach/teams", "GET", "coach_teams"), ("/coach/teams/{team_id}/invites", "POST", "invite"),
        ("/invitations/accept", "POST", "accept"), ("/coach/teams/{team_id}/members/{member_id}", "PUT", "member_update"),
        ("/member/teams/{team_id}/sharing", "GET", "sharing"), ("/member/teams/{team_id}/sharing", "PUT", "save_sharing"), ("/member/teams/{team_id}/sharing", "DELETE", "revoke"),
        ("/member/teams/{team_id}/sessions/{session_id}", "PUT", "upload"), ("/member/teams/{team_id}/sessions/{session_id}", "GET", "read_receipt"),
        ("/coach/teams/{team_id}/review", "GET", "review"), ("/coach/teams/{team_id}/sessions/{member_id}/{session_id}", "GET", "session"),
        ("/coach/teams/{team_id}/notes", "PUT", "note"), ("/coach/teams/{team_id}/groups", "PUT", "group"), ("/coach/teams/{team_id}/report", "POST", "report"),
    ]:
        result.add_api_route(path, endpoint(operation), methods=[method])
    return result
