"""Review candidate: exact migration/capability admission; no IO or locks here.

0013 is a PROPOSED revision, not an allocation or an installed migration.
Callers supply their existing transaction and acquire PHONE then EMAIL first
for account actions. Enrollment start already owns EMAIL; reservation queries
never acquire PHONE, instantiate a store, or open a transaction.
"""
from dataclasses import dataclass
import os
import re
from uuid import UUID
from fastapi import HTTPException
from sqlalchemy import Boolean, String, text
from app.email_delivery import canonical_email
from app.sms_hook import canonical_mainland_phone

REVISION = '20261006_0013'
CAPABILITY = 'd095-channel-invite-v1'
ENROLLMENT_REVISIONS = ('20261006_0012', REVISION)
REVISIONS = ('20261001_0006', '20261002_0007', '20261002_0008',
             '20261004_0009', '20261004_0010', '20261005_0011', *ENROLLMENT_REVISIONS)


def trigger_contract_snapshot(session):
    """Actual catalog rows; no synthetic success substituted in production.

    The unqualified AFTER UPDATE row fence covers phone and changes made by
    BEFORE triggers. The inherited 0012 proof trigger is separately frozen as
    AFTER UPDATE OF email FOR EACH ROW. Both reject WHEN/args/constraint drift.
    Definitions are returned for the standalone real-PG evidence recorder.
    """
    return session.execute(text("""SELECT t.tgname AS name,
        CAST(t.tgfoid AS text) AS function_oid,
        CAST(CAST(to_regprocedure(CASE WHEN t.tgname='account_next_native_fence'
             THEN 'account_next.native_fence()' ELSE 'public.invalidate_account_email_proof()' END) AS oid) AS text) AS expected_oid,
        t.tgtype AS trigger_type,t.tgenabled AS enabled,t.tgisinternal AS internal,
        t.tgnargs AS argument_count,octet_length(t.tgargs) AS argument_bytes,
        t.tgqual IS NOT NULL AS has_when,t.tgdeferrable AS is_deferrable,
        t.tginitdeferred AS initially_deferred,t.tgconstraint<>0 AS is_constraint,
        array_to_string(ARRAY(SELECT a.attname FROM unnest(t.tgattr) WITH ORDINALITY u(number,position)
          JOIN pg_attribute a ON a.attrelid=t.tgrelid AND a.attnum=u.number ORDER BY u.position),',') AS columns,
        p.prosrc AS function_source,p.pronargs=0 AS no_function_arguments,
        p.prorettype='trigger'::regtype AS returns_trigger,p.prosecdef AS security_definer,
        pg_get_triggerdef(t.oid,true) AS trigger_definition,pg_get_functiondef(p.oid) AS function_definition
        FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
        WHERE t.tgrelid='auth.users'::regclass AND t.tgname IN
          ('account_next_native_fence','invalidate_account_email_proof')
        ORDER BY t.tgname""").columns(internal=Boolean,has_when=Boolean,is_deferrable=Boolean,
            initially_deferred=Boolean,is_constraint=Boolean,no_function_arguments=Boolean,
            returns_trigger=Boolean,security_definer=Boolean)).mappings().all()


def assert_trigger_contracts(session):
    from app.account_next_contract import NATIVE_SOURCE, PROOF_SOURCE
    expected={'account_next_native_fence':('',NATIVE_SOURCE),
              'invalidate_account_email_proof':('email',PROOF_SOURCE)}
    rows=trigger_contract_snapshot(session)
    if len(rows)!=2 or {row['name'] for row in rows}!=set(expected):
        raise HTTPException(503,'trigger_contract_mismatch')
    for row in rows:
        columns,source=expected[row['name']]
        if (not row['expected_oid'] or row['function_oid']!=row['expected_oid']
                or row['trigger_type']!=17 or row['enabled']!='O' or row['internal']
                or row['argument_count']!=0 or row['argument_bytes']!=0 or row['has_when']
                or row['is_deferrable'] or row['initially_deferred'] or row['is_constraint']
                or (row['columns'] or '')!=columns or row['function_source']!=source
                or row['no_function_arguments'] is not True or row['returns_trigger'] is not True
                or row['security_definer'] is not True):
            raise HTTPException(503,'trigger_contract_mismatch')
    return rows


def schema_revision(session, *, guard_enabled=None, entry_enabled=None):
    guard = os.getenv('EMAIL_ENROLLMENT_GUARD_ENABLED') == '1' if guard_enabled is None else guard_enabled
    entry = os.getenv('EMAIL_ENROLLMENT_ENABLED') == '1' if entry_enabled is None else entry_enabled
    row = session.execute(text("""SELECT version_num,
        to_regclass('public.account_email_enrollments') IS NOT NULL AS enrollment_exists,
        to_regnamespace('account_next') IS NOT NULL AS next_exists
        FROM public.alembic_version""").columns(version_num=String, enrollment_exists=Boolean, next_exists=Boolean)).mappings().one()
    revision, enrolled, next_exists = row['version_num'], row['enrollment_exists'], row['next_exists']
    if (revision not in REVISIONS or type(enrolled) is not bool or type(next_exists) is not bool
            or enrolled != (revision in ENROLLMENT_REVISIONS) or next_exists != (revision == REVISION)
            or (enrolled and not guard) or (entry and not guard)
            or (guard and revision not in ('20261005_0011', *ENROLLMENT_REVISIONS))
            or (entry and revision == '20261005_0011')):
        raise HTTPException(503, 'migration_capability_mismatch')
    if revision == REVISION:
        if os.getenv('ACCOUNT_NEXT_GUARD_ENABLED') != '1':
            raise HTTPException(503, 'persistent_account_next_guard_required')
        # Marker alone is insufficient: exact private tables, proof trigger,
        # fence identity, RLS and no client/public table/function privileges.
        valid = session.execute(text("""SELECT
          (SELECT count(*)=8 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
           WHERE (n.nspname='account_next' AND c.relname IN('capabilities','policy','epochs','intents','codes','reservations')
             OR n.nspname='public' AND c.relname IN('account_invitation_codes','account_invitation_attributions'))
             AND c.relkind='r' AND c.relrowsecurity
             AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
               WHERE a.grantee=0 OR a.grantee IN(SELECT oid FROM pg_roles WHERE rolname IN('anon','authenticated'))))
          AND EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
            JOIN pg_namespace n ON n.oid=p.pronamespace
            WHERE t.tgrelid='auth.users'::regclass AND t.tgname='account_next_native_fence'
              AND t.tgenabled='O' AND NOT t.tgisinternal AND n.nspname='account_next' AND p.proname='native_fence')
          AND EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
            JOIN pg_namespace n ON n.oid=p.pronamespace
            WHERE t.tgrelid='auth.users'::regclass AND t.tgname='invalidate_account_email_proof'
              AND t.tgenabled='O' AND NOT t.tgisinternal AND n.nspname='public' AND p.proname='invalidate_account_email_proof')
          AND (SELECT count(*)=2 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
            WHERE n.nspname='account_next' AND p.proname IN('native_fence','fingerprint')
              AND p.oid IN(to_regprocedure('account_next.native_fence()'),to_regprocedure('account_next.fingerprint(text,uuid,text)'))
              AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
                WHERE a.grantee=0 OR a.grantee IN(SELECT oid FROM pg_roles WHERE rolname IN('anon','authenticated'))))
          AS compatible""").columns(compatible=Boolean)).scalar_one()
        marker = session.execute(text('SELECT capability FROM account_next.capabilities WHERE singleton')).scalar_one_or_none()
        if valid is not True or marker != CAPABILITY:
            raise HTTPException(503, 'migration_capability_mismatch')
        assert_trigger_contracts(session)
    return revision


@dataclass(frozen=True)
class FeatureScope:
    """An independent <=8-item scope, never the pending-mail authorizer."""
    owners: tuple = ()
    enrollment_digests: tuple = ()

    def __post_init__(self):
        try:
            owners = tuple(str(UUID(x)) for x in self.owners)
            digests = tuple(self.enrollment_digests)
            if (len(owners) + len(digests) > 8 or len(set(owners)) != len(owners)
                    or len(set(digests)) != len(digests)
                    or any(not isinstance(x, str) or not re.fullmatch('[0-9a-f]{64}', x) for x in digests)):
                raise ValueError('scope')
        except (ValueError, TypeError, AttributeError):
            owners, digests = (), ()
        object.__setattr__(self, 'owners', owners)
        object.__setattr__(self, 'enrollment_digests', digests)

    def contains(self, owner, enrollment):
        return owner in self.owners or bool(enrollment and enrollment['address_digest'] in self.enrollment_digests)


def enrollment_row(session, owner):
    return session.execute(text('SELECT owner,address_digest,state,completed_at FROM public.account_email_enrollments WHERE owner=:owner'), {'owner': owner}).mappings().one_or_none()


def admit(session, owner, user, scope, *, legacy_owners=(), guard_enabled=None, entry_enabled=None):
    """Caller holds common locks. Completed receipt + current native phone.

    Durable completed_at survives email invalidation. Pending/verified email
    alone is never admission, even if its UID appears on a feature test list.
    """
    revision = schema_revision(session, guard_enabled=guard_enabled, entry_enabled=entry_enabled)
    row = enrollment_row(session, owner) if revision in ENROLLMENT_REVISIONS else None
    if (not user or str(user['id']) != owner or user['is_anonymous']
            or not user['phone_confirmed_at'] or not canonical_mainland_phone(user['phone'])):
        raise HTTPException(403, 'verified_identity_required')
    if row is not None:
        allowed = row['completed_at'] is not None and scope.contains(owner, row)
    else:
        allowed = owner in legacy_owners
    if not allowed:
        raise HTTPException(403, 'independent_feature_scope_required')
    return row


def assert_enrollment_email_available(session, security, address):
    digest = security._digest('enrollment-address', canonical_email(address))
    if session.execute(text('SELECT count(*) FROM public.account_email_enrollments WHERE address_digest=:digest'), {'digest': digest}).scalar_one():
        raise HTTPException(409, 'target_held_by_enrollment')


def assert_channel_email_available(session, security, address):
    """Pure EMAIL-lock query; guard persists when new actions are closed."""
    revision = schema_revision(session)
    if revision == REVISION:
        digest = security._digest('channel-email-address-v2', canonical_email(address))
        if session.execute(text("SELECT count(*) FROM account_next.reservations WHERE kind='email' AND target_digest=:digest"), {'digest': digest}).scalar_one():
            raise HTTPException(409, 'target_held_by_channel_change')
