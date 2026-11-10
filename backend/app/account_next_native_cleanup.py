"""REVIEW ONLY: private support maintenance, never imported by the service.

Default closed. No env/credential discovery, engine creation, CLI, route, Admin
API, send, retry, schema/grant changes, or holding release. An independently
reviewed support catalog must be frozen below before this candidate can run.
No production approval/catalog has been supplied in this review.
"""
from dataclasses import dataclass
import hashlib
import hmac
import json
import re
import time
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from app.account_next_compat import REVISION, schema_revision
from app.account_next_holding import PHONE_LOCK, EMAIL_LOCK, _read_installed_barrier
from app.account_next_release_evidence import (
    PinnedReadBarrierEvidenceVerifier, valid_sha,
)

PENDING_FIELDS = ('email_change', 'email_change_token_current',
                  'email_change_token_new', 'email_change_sent_at',
                  'email_change_confirm_status')
EMAIL_TYPES = ('email_change_token_current', 'email_change_token_new')


@dataclass(frozen=True)
class SupportCatalogPin:
    # Only a separately reviewed, actual protected catalog readback can fill
    # this record. The actual role/catalog are read again inside the barrier.
    reference: str
    readback_sha256: str
    database: str
    support_role: str
    support_role_oid: int
    application_role: str
    application_role_oid: int
    support_bypassrls: bool
    server_version_num: str
    auth_catalog_sha256: str


# Deliberately empty: callers cannot provide an "expected catalog" as authority.
# Adding a pin is a separate reviewed source change after real readback, not an
# environment flag or incoming receipt that declares the environment safe.
REVIEWED_SUPPORT_CATALOGS: tuple[SupportCatalogPin, ...] = ()


class NativeCleanupDenied(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def deny(code):
    raise NativeCleanupDenied(code)


def _fingerprint(intent, target, native_hash):
    return hashlib.sha256((intent + ':' + target + ':' + native_hash).encode()).hexdigest()


def _catalog_digest(session):
    # No user/token values. Pin complete columns, constraints, all DML triggers
    # (including internal ones), called function definitions/ACLs, and rules.
    # The reviewer must examine these bodies for indirect writes as well.
    catalog = session.execute(text("""SELECT jsonb_build_object(
      'relations', (SELECT jsonb_agg(jsonb_build_array(n.nspname,c.relname,
        c.relkind,c.relowner::regrole::text,c.relrowsecurity,c.relforcerowsecurity,
        coalesce(c.relacl::text,'')) ORDER BY n.nspname,c.relname)
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE c.oid IN('auth.users'::regclass,'auth.one_time_tokens'::regclass)),
      'columns', (SELECT jsonb_agg(jsonb_build_array(a.attrelid::regclass::text,
        a.attnum,a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,
        a.attidentity,a.attgenerated,coalesce(pg_get_expr(d.adbin,d.adrelid),''),
        coalesce(a.attacl::text,'')) ORDER BY a.attrelid::regclass::text,a.attnum)
        FROM pg_attribute a LEFT JOIN pg_attrdef d
          ON d.adrelid=a.attrelid AND d.adnum=a.attnum
        WHERE a.attrelid IN('auth.users'::regclass,'auth.one_time_tokens'::regclass)
          AND a.attnum>0 AND NOT a.attisdropped),
      'constraints', (SELECT coalesce(jsonb_agg(jsonb_build_array(
        c.conrelid::regclass::text,c.conname,pg_get_constraintdef(c.oid,true),
        c.convalidated,c.condeferrable,c.condeferred)
        ORDER BY c.conrelid::regclass::text,c.conname),'[]'::jsonb)
        FROM pg_constraint c WHERE c.conrelid IN
          ('auth.users'::regclass,'auth.one_time_tokens'::regclass)),
      'triggers', (SELECT coalesce(jsonb_agg(jsonb_build_array(
        t.tgrelid::regclass::text,t.tgname,t.tgenabled,t.tgisinternal,
        pg_get_triggerdef(t.oid,true),pg_get_functiondef(p.oid),
        p.proowner::regrole::text,coalesce(p.proacl::text,''))
        ORDER BY t.tgrelid::regclass::text,t.tgname),'[]'::jsonb)
        FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
        WHERE t.tgrelid IN('auth.users'::regclass,'auth.one_time_tokens'::regclass)),
      'rules', (SELECT coalesce(jsonb_agg(jsonb_build_array(
        r.ev_class::regclass::text,r.rulename,pg_get_ruledef(r.oid,true))
        ORDER BY r.ev_class::regclass::text,r.rulename),'[]'::jsonb)
        FROM pg_rewrite r WHERE r.ev_class IN
          ('auth.users'::regclass,'auth.one_time_tokens'::regclass)))""")).scalar_one()
    return hashlib.sha256(json.dumps(catalog, sort_keys=True,
                          separators=(',', ':'), ensure_ascii=True).encode()).hexdigest()


def _support_role(session, pin):
    row = session.execute(text("""SELECT current_database() AS db,
      current_setting('server_version_num') AS version,
      current_user::text AS current_name,session_user::text AS session_name,
      r.oid::bigint AS oid,r.rolsuper,r.rolbypassrls,r.rolcreaterole,
      r.rolcreatedb,r.rolreplication,r.rolcanlogin,
      (SELECT oid::bigint FROM pg_roles WHERE rolname=:app) AS app_oid,
      EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid) AS inherits_role,
      pg_has_role(CAST(:appoid AS oid),r.oid,'MEMBER') AS app_can_assume,
      NOT EXISTS(SELECT 1 FROM pg_class WHERE relnamespace='auth'::regnamespace
        AND relowner=r.oid) AS does_not_own_auth,
      NOT has_schema_privilege(current_user,'auth','CREATE') AS no_auth_ddl,
      current_setting('transaction_isolation') AS isolation
      FROM pg_roles r WHERE r.rolname=current_user"""),
      {'app': pin.application_role, 'appoid': pin.application_role_oid}).mappings().one()
    if (row['db'] != pin.database or row['version'] != pin.server_version_num
            or row['current_name'] != pin.support_role or row['session_name'] != pin.support_role
            or row['oid'] != pin.support_role_oid or row['app_oid'] != pin.application_role_oid
            or row['oid'] == row['app_oid'] or row['rolsuper'] or row['rolcreaterole']
            or row['rolcreatedb'] or row['rolreplication'] or not row['rolcanlogin']
            or row['rolbypassrls'] is not pin.support_bypassrls
            or row['inherits_role'] or row['app_can_assume']
            or not row['does_not_own_auth'] or not row['no_auth_ddl']
            or row['isolation'] != 'read committed'):
        deny('independent_support_role_unproven')
    # PG17 MAINTAIN permits AX without granting table-wide users UPDATE.
    # Do not silently replace missing MAINTAIN with an administrator connection.
    mutation = session.execute(text("""SELECT
      has_table_privilege(current_user,'auth.users','MAINTAIN')
      AND has_table_privilege(current_user,'auth.users','SELECT')
      AND has_table_privilege(current_user,'auth.one_time_tokens','SELECT')
      AND has_table_privilege(current_user,'auth.one_time_tokens','DELETE')
      AND NOT EXISTS(SELECT 1 FROM pg_attribute a
        WHERE a.attrelid='auth.users'::regclass AND a.attnum>0 AND NOT a.attisdropped
          AND has_column_privilege(current_user,a.attrelid,a.attnum,'UPDATE')
              IS DISTINCT FROM (a.attname IN('email_change','email_change_token_current',
                'email_change_token_new','email_change_sent_at','email_change_confirm_status')))
      AND NOT EXISTS(SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='auth' AND c.relkind IN('r','p') AND (
          has_table_privilege(current_user,c.oid,'INSERT')
          OR has_table_privilege(current_user,c.oid,'TRUNCATE')
          OR (c.oid<>'auth.one_time_tokens'::regclass
              AND has_table_privilege(current_user,c.oid,'DELETE'))
          OR (c.oid<>'auth.users'::regclass
              AND has_any_column_privilege(current_user,c.oid,'UPDATE'))))""")).scalar_one()
    if mutation is not True:
        deny('support_mutation_privileges_unproven')


def _user(session, owner):
    return session.execute(text("""SELECT u.id::text AS id,u.email,u.phone,
      u.email_confirmed_at,u.phone_confirmed_at,u.is_anonymous,
      u.email_change,u.email_change_token_current,u.email_change_token_new,
      u.email_change_sent_at,u.email_change_confirm_status,
      u.phone_change,u.phone_change_token,
      encode(sha256(convert_to((to_jsonb(u)-ARRAY['email_change',
        'email_change_token_current','email_change_token_new','email_change_sent_at',
        'email_change_confirm_status'])::text,'UTF8')),'hex') AS protected_sha
      FROM auth.users u WHERE u.id=CAST(:owner AS uuid)"""),
      {'owner': owner}).mappings().one_or_none()


def _other_tokens(session, owner):
    # Compare all unrelated token columns in DB; no raw token leaves this query.
    return session.execute(text("""SELECT count(*) AS count,
      encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(t)
        ORDER BY t.id::text),'[]'::jsonb)::text,'UTF8')),'hex') AS digest
      FROM auth.one_time_tokens t WHERE t.user_id=CAST(:owner AS uuid)
        AND t.token_type NOT IN ('email_change_token_current','email_change_token_new')"""),
      {'owner': owner}).mappings().one()


def _related_tokens(session, owner):
    return session.execute(text("""SELECT id::text AS id,user_id::text AS owner,
      token_type::text AS kind,token_hash,relates_to FROM auth.one_time_tokens
      WHERE user_id=CAST(:owner AS uuid)
        AND token_type IN('email_change_token_current','email_change_token_new')
      ORDER BY token_type,id"""), {'owner': owner}).mappings().all()


def _matched_tokens(op, user, codes, tokens, owner, intent, address):
    if (not op['request_claimed'] or len(codes) != 2
            or {c['leg'] for c in codes} != {'old', 'new'}
            or any(c['code_digest'] != '' or not valid_sha(c['native_fingerprint']) for c in codes)):
        deny('retained_native_fingerprints_unavailable')
    if (not isinstance(user['email_change'], str)
            or user['email_change'].strip().lower() != address
            or user['email_change_sent_at'] is None):
        deny('pending_email_case_mismatch')
    present = {leg: bool(user[field]) for leg, field in
               (('old', EMAIL_TYPES[0]), ('new', EMAIL_TYPES[1]))}
    status = user['email_change_confirm_status']
    if status == 0:
        if not all(present.values()) or op['authority_verified'] or op['new_verified']:
            deny('pending_email_shape_unknown')
    elif status == 1:
        if (sum(present.values()) != 1
                or bool(op['authority_verified']) != (not present['old'])
                or bool(op['new_verified']) != (not present['new'])):
            deny('half_confirmed_email_shape_unknown')
    else:
        deny('pending_email_shape_unknown')
    indexed = {t['kind']: t for t in tokens}
    if len(indexed) != len(tokens) or len(tokens) != sum(present.values()):
        deny('related_token_set_unknown')
    by_leg = {c['leg']: c for c in codes}
    for leg, kind, related in (('old', EMAIL_TYPES[0], user['email']),
                               ('new', EMAIL_TYPES[1], user['email_change'])):
        token = indexed.get(kind)
        if not present[leg]:
            if token is not None:
                deny('related_token_set_unknown')
            continue
        raw = user[kind]
        if (not isinstance(raw, str) or not re.fullmatch(r'(?:pkce_)?[0-9a-f]{56}', raw)
                or token is None or token['owner'] != owner
                or token['token_hash'] != raw or token['relates_to'] != related.lower()
                or not hmac.compare_digest(_fingerprint(intent, address, raw),
                                           by_leg[leg]['native_fingerprint'])):
            deny('native_token_association_mismatch')
        UUID(token['id'])
    return tokens


class PrivateNativeEmailCleanup:
    def __init__(self, changes, *, support_session_factory=None,
                 evidence_verifier=None, catalog_reference=None, enabled=False, clock=time.time):
        # changes supplies existing pure address/HMAC only. Its application
        # session factory is never used; support factory has no fallback.
        self.changes = changes
        self.factory = support_session_factory
        self.verifier = evidence_verifier
        self.catalog_reference = catalog_reference
        self.enabled = enabled is True
        self.clock = clock

    def clean(self, owner, intent, target, evidence_sha256):
        try:
            return self._clean(owner, intent, target, evidence_sha256)
        except NativeCleanupDenied:
            raise
        except SQLAlchemyError as error:
            code = 'native_cleanup_busy' if getattr(getattr(error, 'orig', None), 'sqlstate', None) == '55P03' else 'native_cleanup_database_unavailable'
            raise NativeCleanupDenied(code) from None
        except Exception:
            # Includes provider, input, catalog, commit/rollback and driver
            # wrappers. No SQL, token, channel or third-party message escapes.
            raise NativeCleanupDenied('native_cleanup_unavailable') from None

    def _clean(self, owner, intent, target, evidence_sha256):
        if not self.enabled:
            deny('native_cleanup_closed')
        pins = [p for p in REVIEWED_SUPPORT_CATALOGS if p.reference == self.catalog_reference]
        if (len(pins) != 1 or type(pins[0]) is not SupportCatalogPin
                or not valid_sha(pins[0].readback_sha256)
                or not valid_sha(pins[0].auth_catalog_sha256)):
            deny('reviewed_support_catalog_unavailable')
        pin = pins[0]
        if (not callable(self.factory) or type(self.verifier) is not PinnedReadBarrierEvidenceVerifier
                or self.factory is getattr(self.changes, 'factory', None)):
            deny('independent_support_dependencies_unavailable')
        owner, intent = str(UUID(owner)), str(UUID(intent))
        address, digest = self.changes._address('email', target, owner)
        facts = self.verifier.observe_provider()  # real readers required; outside locks
        with self.factory.begin() as s:
            bind = s.get_bind()
            if (bind.dialect.name != 'postgresql' or bind.hide_parameters is not True
                    or bind.echo not in (False, None)):
                deny('private_support_transport_unproven')
            s.execute(text("SET LOCAL transaction_timeout='2s'"))
            s.execute(text("SET LOCAL idle_in_transaction_session_timeout='1s'"))
            s.execute(text("SET LOCAL lock_timeout='200ms'"))
            s.execute(text("SET LOCAL statement_timeout='1000ms'"))
            _support_role(s, pin)
            s.execute(text('LOCK TABLE auth.users IN ACCESS EXCLUSIVE MODE NOWAIT'))
            s.execute(text('LOCK TABLE auth.one_time_tokens IN ACCESS EXCLUSIVE MODE NOWAIT'))
            for key in (PHONE_LOCK, EMAIL_LOCK):
                if s.execute(text('SELECT pg_try_advisory_xact_lock(:key)'), {'key': key}).scalar_one() is not True:
                    deny('native_cleanup_busy')
            if schema_revision(s) != REVISION:
                deny('native_cleanup_schema_mismatch')
            _read_installed_barrier(s)
            if not hmac.compare_digest(_catalog_digest(s), pin.auth_catalog_sha256):
                deny('reviewed_auth_catalog_drift')
            # Catalog pin must contain the real id/token_hash/relates_to types,
            # DML triggers/functions, constraints and actual permission ACLs.
            # No migration or permission repair is attempted here.
            if s.execute(text('SELECT enabled FROM account_next.policy WHERE singleton')).scalar_one() is not False:
                deny('close_new_change_actions_first')
            op = s.execute(text('SELECT *,expires_at<=clock_timestamp() AS expired_now FROM account_next.intents WHERE intent=CAST(:intent AS uuid) AND owner=CAST(:owner AS uuid)'),
                           {'intent': intent, 'owner': owner}).mappings().one_or_none()
            if (not op or op['kind'] != 'email' or op['state'] not in ('cancelled_holding', 'expired_holding')
                    or op['target_digest'] != digest or op['native_confirmed_at'] is not None
                    or op['verify_leg'] is not None
                    or (op['state'] == 'expired_holding' and op['expired_now'] is not True)):
                deny('exact_email_holding_case_required')
            epoch = s.execute(text('SELECT epoch FROM account_next.epochs WHERE owner=CAST(:owner AS uuid)'),
                              {'owner': owner}).scalar_one()
            self.verifier.verify(evidence_sha256, owner=owner, intent=intent,
                                 target_digest=digest, base_epoch=op['base_epoch'],
                                 now=int(self.clock()), current_facts=facts, synthetic_local=False)
            user = _user(s, owner)
            if (not user or user['id'] != owner or user['is_anonymous']
                    or not user['email_confirmed_at'] or not user['phone'] or not user['phone_confirmed_at']
                    or epoch != op['base_epoch']
                    or self.changes._address('email', user['email'], owner)[1] != op['old_digest']
                    or any(user[k] not in (None, '') for k in ('phone_change', 'phone_change_token'))):
                deny('original_identity_or_pending_phone_drift')
            if s.execute(text("SELECT count(*) FROM account_next.intents WHERE owner=CAST(:owner AS uuid) AND state NOT IN('completed','cancelled_holding','expired_holding','invalidated')"),
                         {'owner': owner}).scalar_one():
                deny('another_owned_change_active')
            claim = s.execute(text("SELECT owner::text,intent::text FROM account_next.reservations WHERE kind='email' AND target_digest=:digest"),
                              {'digest': digest}).one_or_none()
            if claim is None or tuple(claim) != (owner, intent):
                deny('exact_holding_claim_required')
            codes = s.execute(text('SELECT leg,code_digest,native_fingerprint FROM account_next.codes WHERE intent=CAST(:intent AS uuid)'),
                              {'intent': intent}).mappings().all()
            tokens = _matched_tokens(op, user, codes, _related_tokens(s, owner), owner, intent, address)
            unrelated = dict(_other_tokens(s, owner))
            # Fixed SQL, exact row predicates. Never delete by owner/type alone.
            for token in tokens:
                count = s.execute(text("""DELETE FROM auth.one_time_tokens
                  WHERE id=CAST(:id AS uuid) AND user_id=CAST(:owner AS uuid)
                    AND token_type::text=:kind AND token_hash=:hash AND relates_to=:related"""),
                  {'id': token['id'], 'owner': owner, 'kind': token['kind'],
                   'hash': token['token_hash'], 'related': token['relates_to']}).rowcount
                if count != 1:
                    deny('native_cleanup_token_rowcount_mismatch')
            changed = s.execute(text("""UPDATE auth.users SET email_change='',
              email_change_token_current='',email_change_token_new='',
              email_change_sent_at=NULL,email_change_confirm_status=0
              WHERE id=CAST(:owner AS uuid) AND email IS NOT DISTINCT FROM :email
                AND phone IS NOT DISTINCT FROM :phone
                AND email_confirmed_at IS NOT DISTINCT FROM :confirmed
                AND phone_confirmed_at IS NOT DISTINCT FROM :phone_confirmed
                AND email_change IS NOT DISTINCT FROM :target
                AND email_change_token_current IS NOT DISTINCT FROM :old_token
                AND email_change_token_new IS NOT DISTINCT FROM :new_token
                AND email_change_sent_at IS NOT DISTINCT FROM :sent_at
                AND email_change_confirm_status IS NOT DISTINCT FROM :status"""),
              {'owner': owner, 'email': user['email'], 'phone': user['phone'],
               'confirmed': user['email_confirmed_at'], 'phone_confirmed': user['phone_confirmed_at'],
               'target': user['email_change'], 'old_token': user['email_change_token_current'],
               'new_token': user['email_change_token_new'], 'sent_at': user['email_change_sent_at'],
               'status': user['email_change_confirm_status']}).rowcount
            if changed != 1:
                deny('native_cleanup_user_rowcount_mismatch')
            after = _user(s, owner)
            if (not after or after['protected_sha'] != user['protected_sha']
                    or any(after[k] != '' for k in ('email_change', *EMAIL_TYPES))
                    or after['email_change_sent_at'] is not None or after['email_change_confirm_status'] != 0
                    or _related_tokens(s, owner) or dict(_other_tokens(s, owner)) != unrelated):
                deny('native_cleanup_postcondition_mismatch')
            if not hmac.compare_digest(_catalog_digest(s), pin.auth_catalog_sha256):
                deny('reviewed_auth_catalog_drift')
            self.verifier.verify(evidence_sha256, owner=owner, intent=intent,
                                 target_digest=digest, base_epoch=op['base_epoch'],
                                 now=int(self.clock()), current_facts=facts, synthetic_local=False)
        # Commit has completed. Does not release a claim, clear retained
        # fingerprints, refund sends or invoke another operator automatically.
        return {'state': 'native_pending_cleared', 'deletedEmailChangeTokens': len(tokens),
                'reservationReleased': False, 'ledgerChanged': False}
