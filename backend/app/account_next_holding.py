"""Private single-case support executor. Not a public route, default closed.

No Auth update, mail, quota refund, intent reset or Admin API. Native users -> one_time_tokens relation
ACCESS EXCLUSIVE NOWAIT locks FIRST, then nonwaiting PHONE -> EMAIL.
This drains existing reads on these relations, not every HTTP request.
Auth reads are briefly blocked until this bounded transaction exits; any busy
lock aborts the release without retry. The audit schema is unchanged.
"""
import hashlib,json,re,time
from uuid import UUID
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from app.account_next_compat import schema_revision,REVISION
from app.account_next_release_evidence import (ReleaseDenied, PinnedEvidenceVerifier, PinnedReadBarrierEvidenceVerifier, READ_BARRIER_MODE)

PHONE_LOCK=621662560617157762
EMAIL_LOCK=621662560617157763
HOLDING=frozenset(('cancelled_holding','expired_holding','invalidated'))

# Fixed reviewed v3 source, not a receipt-supplied body or boolean.
READ_BARRIER_NATIVE_SHA256 = '853e66bd94e444b90fd4922bc5418ae92421a5b6fc122fa7ec462049c9b6aa34'
READ_BARRIER_FINGERPRINT_SOURCE = "\n SELECT CASE WHEN value='' THEN NULL ELSE pg_catalog.encode(\n pg_catalog.sha256(pg_catalog.convert_to(intent::text || ':' || target || ':' || value,'UTF8')),'hex') END\n"


def _read_installed_barrier(session):
    """All facts come from this same locked transaction; nothing from JSON."""
    from app.account_next_contract import NATIVE_SOURCE
    if hashlib.sha256(NATIVE_SOURCE.encode()).hexdigest()!=READ_BARRIER_NATIVE_SHA256:
        raise ReleaseDenied('reviewed_fence_source_drift')
    try:
        held=session.execute(text("""SELECT count(*)=2 FROM pg_catalog.pg_locks
          WHERE pid=pg_backend_pid() AND locktype='relation' AND granted
           AND relation IN('auth.users'::regclass,'auth.one_time_tokens'::regclass)
           AND mode='AccessExclusiveLock'""")).scalar_one()
        if held is not True:raise ReleaseDenied('read_barrier_not_held')
        visible=session.execute(text("""SELECT
          NOT pg_catalog.row_security_active('auth.users'::regclass)
          AND NOT pg_catalog.row_security_active('auth.one_time_tokens'::regclass)
          AND current_setting('session_replication_role')='origin'
          AND (SELECT setting FROM pg_settings WHERE name='transaction_timeout')='2000'
          AND (SELECT setting FROM pg_settings WHERE name='idle_in_transaction_session_timeout')='1000'
          AND has_table_privilege(current_user,'auth.users','SELECT')
          AND has_table_privilege(current_user,'auth.one_time_tokens','SELECT')""")).scalar_one()
        if visible is not True:raise ReleaseDenied('Native_token_readback_unavailable')
        typed=session.execute(text("""SELECT
          (SELECT count(*) FROM (VALUES
 ('id','uuid',true),
 ('email','character varying(255)',false),
 ('email_confirmed_at','timestamp with time zone',false),
 ('email_change_token_new','character varying(255)',false),
 ('email_change','character varying(255)',false),
 ('email_change_sent_at','timestamp with time zone',false),
 ('phone','text',false),
 ('phone_confirmed_at','timestamp with time zone',false),
 ('phone_change','text',false),
 ('phone_change_token','character varying(255)',false),
 ('phone_change_sent_at','timestamp with time zone',false),
 ('email_change_token_current','character varying(255)',false),
 ('email_change_confirm_status','smallint',false),
 ('is_anonymous','boolean',true)

          ) expected(name,type_name,not_null) JOIN pg_attribute a
           ON a.attrelid='auth.users'::regclass AND a.attname=expected.name AND NOT a.attisdropped
           AND format_type(a.atttypid,a.atttypmod)=expected.type_name
           AND a.attnotnull=expected.not_null)=14
          AND (SELECT count(*) FROM (VALUES ('user_id','uuid'),('token_type','auth.one_time_token_type'))
           expected(name,type_name) JOIN pg_attribute a
           ON a.attrelid='auth.one_time_tokens'::regclass AND a.attname=expected.name AND NOT a.attisdropped
           AND format_type(a.atttypid,a.atttypmod)=expected.type_name AND a.attnotnull)=2
          AND enum_range(NULL::auth.one_time_token_type)::text[]=ARRAY[
           'confirmation_token','reauthentication_token','recovery_token',
           'email_change_token_new','email_change_token_current','phone_change_token']::text[]
          AND (SELECT count(*) FROM pg_class WHERE oid IN('auth.users'::regclass,'auth.one_time_tokens'::regclass)
           AND relkind='r')=2""")).scalar_one()
        if typed is not True:raise ReleaseDenied('read_barrier_catalog_drift')
        functions=session.execute(text("""SELECT count(*)=2 FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang
          WHERE p.prokind='f' AND p.proowner='postgres'::regrole
           AND p.proconfig=ARRAY['search_path=""']::text[]
           AND NOT has_function_privilege('anon',p.oid,'EXECUTE')
           AND NOT has_function_privilege('authenticated',p.oid,'EXECUTE')
           AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
             WHERE a.grantee=0)
           AND ((p.oid='account_next.native_fence()'::regprocedure
             AND l.lanname='plpgsql' AND p.prosecdef AND p.provolatile='v' AND NOT p.proisstrict
             AND p.prorettype='trigger'::regtype AND p.pronargs=0 AND p.prosrc=:native)
            OR (p.oid='account_next.fingerprint(text,uuid,text)'::regprocedure
             AND l.lanname='sql' AND NOT p.prosecdef AND p.provolatile='i' AND p.proisstrict
             AND p.prorettype='text'::regtype AND p.pronargs=3 AND p.prosrc=:fingerprint))"""),
            {'native':NATIVE_SOURCE,'fingerprint':READ_BARRIER_FINGERPRINT_SOURCE}).scalar_one()
        if functions is not True:raise ReleaseDenied('read_barrier_function_drift')
    except SQLAlchemyError:
        raise ReleaseDenied('read_barrier_catalog_unavailable') from None
    # schema_revision() in the caller already checked exact native/proof
    # trigger identity/body/attributes and private table/function ACL/RLS.
    return {'mode':READ_BARRIER_MODE,'native_sha256':READ_BARRIER_NATIVE_SHA256,
            'fingerprint_sha256':hashlib.sha256(READ_BARRIER_FINGERPRINT_SOURCE.encode()).hexdigest(),
            'relations':['auth.users','auth.one_time_tokens'],'lock_mode':'AccessExclusiveLock',
            'transaction_timeout_ms':2000,'idle_in_transaction_timeout_ms':1000}

class HoldingSupportStore:
    def __init__(self,changes,evidence_verifier,*,enabled=False,synthetic_local=False,clock=time.time):
        self.changes,self.factory,self.verifier=changes,changes.factory,evidence_verifier
        self.enabled=enabled is True;self.synthetic_local=synthetic_local is True;self.clock=clock

    def release(self,owner,intent,target,evidence_sha256):
        try:
            return self._release(owner,intent,target,evidence_sha256)
        except SQLAlchemyError as error:
            # Includes query, commit and rollback errors. Never expose SQL or
            # owner/target parameters through the private operator boundary.
            code = 'support_release_busy' if getattr(getattr(error, 'orig', None), 'sqlstate', None) == '55P03' else 'support_release_database_unavailable'
            raise ReleaseDenied(code) from None

    def _release(self,owner,intent,target,evidence_sha256):
        if not self.enabled:raise ReleaseDenied('support_release_closed')
        verifier=self.verifier
        if type(verifier) not in (PinnedEvidenceVerifier,PinnedReadBarrierEvidenceVerifier):
            raise ReleaseDenied('support_release_verifier_type_unknown')
        owner,intent=str(UUID(owner)),str(UUID(intent))
        address,digest=self.changes._address('email',target,owner)
        current_facts=verifier.observe_provider()  # no provider IO under PG locks
        with self.factory.begin() as s:
            if s.get_bind().dialect.name!='postgresql':raise ReleaseDenied('postgres_required')
            # Also conflict with AccessShare: no old verify transaction may
            # retain a previously read User/OTT snapshot across this barrier.
            try:
                # PostgreSQL17: terminate the session if the whole transaction
                # or client-idle interval exceeds these limits. No PREPARE.
                s.execute(text("SET LOCAL transaction_timeout='2s'"))
                s.execute(text("SET LOCAL idle_in_transaction_session_timeout='1s'"))
                s.execute(text("SET LOCAL lock_timeout='200ms'"))
                s.execute(text("SET LOCAL statement_timeout='1000ms'"))
                s.execute(text('LOCK TABLE auth.users IN ACCESS EXCLUSIVE MODE NOWAIT'))
                s.execute(text('LOCK TABLE auth.one_time_tokens IN ACCESS EXCLUSIVE MODE NOWAIT'))
                if s.execute(text("SELECT pg_catalog.row_security_active('auth.one_time_tokens'::regclass)")).scalar_one() is not False:
                    raise ReleaseDenied('Native_token_readback_unavailable')
            except SQLAlchemyError as error:
                code='support_release_busy' if getattr(getattr(error,'orig',None),'sqlstate',None)=='55P03' else 'Native_token_readback_unavailable'
                raise ReleaseDenied(code) from None
            for key in (PHONE_LOCK,EMAIL_LOCK):
                if s.execute(text('SELECT pg_try_advisory_xact_lock(:key)'),{'key':key}).scalar_one() is not True:
                    raise ReleaseDenied('support_release_busy')
            if schema_revision(s)!=REVISION:raise ReleaseDenied('release_schema_mismatch')
            barrier=_read_installed_barrier(s) if type(verifier) is PinnedReadBarrierEvidenceVerifier else None
            if s.execute(text('SELECT enabled FROM account_next.policy WHERE singleton')).scalar_one() is not False:
                raise ReleaseDenied('close_new_change_actions_first')
            if s.execute(text("SELECT to_regclass('account_next.support_release_audits') IS NOT NULL")).scalar_one() is not True:
                raise ReleaseDenied('private_release_audit_unavailable')
            if s.execute(text("SELECT relrowsecurity AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(relacl,acldefault('r',relowner))) a WHERE a.grantee=0 OR a.grantee IN(SELECT oid FROM pg_roles WHERE rolname IN('anon','authenticated'))) FROM pg_class WHERE oid='account_next.support_release_audits'::regclass")).scalar_one() is not True:
                raise ReleaseDenied('private_release_audit_acl_mismatch')
            if self.synthetic_local:
                row=s.execute(text("SELECT current_database(),host(inet_server_addr()),inet_server_port(),current_setting('server_version_num')")).one()
                if not re.fullmatch('d095_fixture_[0-9a-f]{32}',row[0]) or tuple(row[1:])!=('127.0.0.1',15439,'170011'):
                    raise ReleaseDenied('synthetic_release_cannot_target_Hosted')
            op=s.execute(text('SELECT * FROM account_next.intents WHERE intent=CAST(:intent AS uuid) AND owner=CAST(:owner AS uuid) FOR UPDATE'),{'intent':intent,'owner':owner}).mappings().one_or_none()
            if not op or op['kind']!='email' or op['state'] not in HOLDING or op['target_digest']!=digest:
                raise ReleaseDenied('single_holding_case_mismatch')
            now=int(self.clock())
            verifier.verify(evidence_sha256,owner=owner,intent=intent,target_digest=digest,base_epoch=op['base_epoch'],now=now,current_facts=current_facts,synthetic_local=self.synthetic_local)
            epoch=s.execute(text('SELECT epoch FROM account_next.epochs WHERE owner=CAST(:owner AS uuid) FOR UPDATE'),{'owner':owner}).scalar_one()
            user=s.execute(text('SELECT email,email_change,email_change_token_current,email_change_token_new,email_change_confirm_status,phone_change,phone_change_token,is_anonymous FROM auth.users WHERE id=CAST(:owner AS uuid)'),{'owner':owner}).mappings().one_or_none()
            if not user or user['is_anonymous'] or epoch!=op['base_epoch'] or op['native_confirmed_at'] is not None:
                raise ReleaseDenied('holding_epoch_or_identity_drift')
            if any(user[x] not in (None,'') for x in ('email_change','email_change_token_current','email_change_token_new','phone_change','phone_change_token')) or user['email_change_confirm_status']!=0:
                raise ReleaseDenied('Native_challenge_not_clear')
            try:
                change_tokens_empty=s.execute(text("SELECT NOT EXISTS(SELECT 1 FROM auth.one_time_tokens WHERE user_id=CAST(:owner AS uuid) AND token_type IN ('email_change_token_new','email_change_token_current'))"),{'owner':owner}).scalar_one()
            except SQLAlchemyError:
                raise ReleaseDenied('Native_token_readback_unavailable') from None
            if change_tokens_empty is not True:
                raise ReleaseDenied('Native_change_tokens_not_clear')
            if self.changes._address('email',user['email'],owner)[1]!=op['old_digest']:
                raise ReleaseDenied('holding_original_channel_changed')
            active=s.execute(text("SELECT count(*) FROM account_next.intents WHERE owner=CAST(:owner AS uuid) AND state NOT IN('completed','cancelled_holding','expired_holding','invalidated')"),{'owner':owner}).scalar_one()
            if active:raise ReleaseDenied('another_owned_change_active')
            if s.execute(text("SELECT count(*) FROM auth.users WHERE lower(btrim(email))=:target OR lower(btrim(email_change))=:target"),{'target':address}).scalar_one():
                raise ReleaseDenied('target_now_native_occupied')
            # Existing D095 and first-binding reservations remain authoritative.
            from app.account_next_compat import assert_enrollment_email_available
            assert_enrollment_email_available(s,self.changes.email,address)
            first=s.execute(text("SELECT owner,email_digest FROM public.account_email_binding_intents WHERE state IN('requesting','pending','verifying','uncertain')")).mappings().all()
            if any(row['email_digest']==self.changes.email._digest('address',row['owner'],address) for row in first):
                raise ReleaseDenied('target_held_by_first_binding')
            audit=s.execute(text('SELECT evidence_sha256 FROM account_next.support_release_audits WHERE intent=CAST(:intent AS uuid)'),{'intent':intent}).scalar_one_or_none()
            claim=s.execute(text("SELECT owner::text,intent::text FROM account_next.reservations WHERE kind='email' AND target_digest=:digest FOR UPDATE"),{'digest':digest}).mappings().one_or_none()
            if audit:
                if audit!=evidence_sha256 or claim:raise ReleaseDenied('release_receipt_or_claim_drift')
                return {'state':'released','replayed':True,'nativeChanged':False,'ledgerChanged':False}
            if not claim or claim['owner']!=owner or claim['intent']!=intent:raise ReleaseDenied('held_claim_mismatch')
            snapshot={'base_epoch':epoch,'state':op['state'],'kind':'email','native_empty':True,'native_email_change_ott_empty':True,'other_active':False}
            if barrier is not None:snapshot['read_barrier']=barrier
            snapshot_sha=hashlib.sha256(json.dumps(snapshot,sort_keys=True,separators=(',',':')).encode()).hexdigest()
            s.execute(text("INSERT INTO account_next.support_release_audits(intent,evidence_sha256,snapshot_sha256,released_at) VALUES(CAST(:intent AS uuid),:evidence,:snapshot,to_timestamp(:now))"),{'intent':intent,'evidence':evidence_sha256,'snapshot':snapshot_sha,'now':now})
            s.execute(text("UPDATE account_next.codes SET code_digest='',native_fingerprint=NULL WHERE intent=CAST(:intent AS uuid)"),{'intent':intent})
            deleted=s.execute(text("DELETE FROM account_next.reservations WHERE kind='email' AND target_digest=:digest AND owner=CAST(:owner AS uuid) AND intent=CAST(:intent AS uuid)"),{'digest':digest,'owner':owner,'intent':intent}).rowcount
            if deleted!=1:raise ReleaseDenied('single_claim_delete_mismatch')
        return {'state':'released','replayed':False,'nativeChanged':False,'ledgerChanged':False}
