"""One click, bounded server-owned OTP attempts; never store a phone or OTP.

An Auth error receipt is an opaque correlation value, NOT standalone authority.
Only the relay holding the original operation may advance a durable pre-write
failure. A competing direct Auth request can consume a slot, but cannot authorize
that relay to continue: its own response must carry the matching receipt.
"""
from __future__ import annotations
import asyncio
import hashlib
import hmac
import math
import re
import secrets
import time
import threading
from datetime import datetime, timedelta, timezone
from uuid import UUID
from sqlalchemy import text
from fastapi import HTTPException
from app.sms_hook import GateRejected, GateUnavailable

MAX_ATTEMPTS = 5
OPERATION_SECONDS = 40.0
RETRY_DELAY_SECONDS = 2.0
NEXT_ATTEMPT_MINIMUM_SECONDS = 7.0
_RECEIPT = re.compile(r'(?<![A-Za-z0-9_])GXJ_SMS_RETRY_RECEIPT=([0-9a-f]{64})\.([0-9a-f]{64})\.([1-5])(?![A-Za-z0-9_.])')

def public_unknown():
    return HTTPException(502, {'code':'gxj_sms_unknown', 'message':'短信发送结果未确认，请查看已收到的短信；不要自动重发'})

class AuthFrequencyLimited(HTTPException):
    """Only the trusted /otp HTTP 429 parser may construct this signal."""
    def __init__(self, seconds):
        if type(seconds) is not int or not 0 <= seconds <= 60:
            raise ValueError('auth_frequency_seconds')
        self.seconds = seconds
        super().__init__(429, {'code':'gxj_sms_cooldown',
            'message':'请间隔至少60秒再申请验证码', 'retryAfterSeconds':seconds})


class RetryReceipt(HTTPException):
    def __init__(self, operation, nonce, attempt, retry_after=None):
        detail={'code':'gxj_sms_rejected','message':'本次短信明确未发送成功，未计入每日5次；请稍后重新申请'}
        if type(retry_after) is int and 0 <= retry_after <= 60:
            detail['retryAfterSeconds']=retry_after
        super().__init__(422, detail)
        self.receipt=(operation,nonce,attempt)

def parse_receipt(message, retry_after=None):
    if not isinstance(message,str) or len(message)>8192 or 'GXJ_SMS_NOT_DISPATCHED:' not in message:
        return None
    found=list(_RECEIPT.finditer(message))
    if len(found)!=1:
        return None
    op,nonce,attempt=found[0].groups()
    return RetryReceipt(op,nonce,int(attempt),retry_after)

RETRY_SCHEMA_SQL = """SELECT c.relkind::text AS kind, c.relrowsecurity AS rls,
 c.relforcerowsecurity AS forced_rls,
 pg_catalog.pg_get_userbyid(c.relowner)=current_user AS runtime_owns_table,
 (SELECT pg_catalog.jsonb_object_agg(a.attname,pg_catalog.jsonb_build_array(
  pg_catalog.format_type(a.atttypid,a.atttypmod),a.attnotnull))
  FROM pg_catalog.pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0
   AND NOT a.attisdropped) AS columns,
 (SELECT pg_catalog.count(*)=1 AND pg_catalog.bool_and(k.contype='p'
  AND k.convalidated AND NOT k.condeferrable AND NOT k.condeferred
  AND k.conislocal AND k.coninhcount=0 AND k.conkey=ARRAY[1]::smallint[])
  FROM pg_catalog.pg_constraint k WHERE k.conrelid=c.oid) AS exact_constraints,
 (SELECT pg_catalog.count(*)=2 AND pg_catalog.bool_and(
  i.indisvalid AND i.indisready AND i.indislive AND i.indimmediate
  AND NOT i.indisexclusion AND i.indexprs IS NULL AND i.indpred IS NULL
  AND i.indnkeyatts=i.indnatts AND am.amname='btree'
  AND ((i.indisprimary AND i.indisunique AND i.indkey::text='1')
   OR (NOT i.indisprimary AND NOT i.indisunique AND i.indkey::text='2 6'))
  AND NOT EXISTS(SELECT 1 FROM pg_catalog.unnest(i.indclass) opid
   JOIN pg_catalog.pg_opclass op ON op.oid=opid
   JOIN pg_catalog.pg_namespace ns ON ns.oid=op.opcnamespace
   WHERE ns.nspname<>'pg_catalog'))
  AND pg_catalog.count(DISTINCT i.indkey::text)=2
  FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class ic ON ic.oid=i.indexrelid
  JOIN pg_catalog.pg_am am ON am.oid=ic.relam WHERE i.indrelid=c.oid) AS exact_indexes,
 NOT c.relispartition AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_inherits h
  WHERE h.inhrelid=c.oid OR h.inhparent=c.oid) AS no_inheritance,
 NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid=c.oid
  AND a.attnum>0 AND NOT a.attisdropped
  AND (a.atthasdef OR a.attidentity<>'' OR a.attgenerated<>'')) AS no_column_expressions,
 NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid=c.oid
  AND a.attnum>0 AND NOT a.attisdropped AND (a.attnum,a.attname::text) NOT IN
   ((1,'operation_id'),(2,'phone_digest'),(3,'attempt_nonce'),(4,'attempt_no'),(5,'state'),(6,'created_at'),(7,'expires_at'),(8,'next_at'),(9,'webhook_id'),(10,'owner_digest'),(11,'signup_owner_digest'),(12,'webhook_ids'),(13,'confirmation_digest'))) AS exact_column_order,
 NOT EXISTS(SELECT 1 FROM pg_catalog.pg_rewrite r WHERE r.ev_class=c.oid) AS no_rules,
 NOT EXISTS(SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid=c.oid) AS no_policies,
 NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t
  WHERE t.tgrelid=c.oid AND NOT t.tgisinternal) AS no_user_triggers,
 NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(c.relacl,
  pg_catalog.acldefault('r',c.relowner))) a WHERE a.grantee=0)
 AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a,
  LATERAL pg_catalog.aclexplode(a.attacl) acl WHERE a.attrelid=c.oid
  AND a.attnum>0 AND NOT a.attisdropped AND acl.grantee=0) AS no_public_acl,
 (SELECT pg_catalog.count(*)=2 FROM pg_catalog.pg_roles r
  WHERE r.rolname IN ('anon','authenticated')) AS public_roles_exist,
 NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles r
  WHERE r.rolname IN ('anon','authenticated') AND
   (pg_catalog.has_table_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    OR pg_catalog.has_any_column_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,REFERENCES'))) AS no_public_access
FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relname='sms_retry_operations'"""

RETRY_COLUMNS = {'operation_id': ['character varying(64)', True], 'phone_digest': ['character varying(64)', True], 'attempt_nonce': ['character varying(64)', True], 'attempt_no': ['integer', True], 'state': ['character varying(24)', True], 'created_at': ['timestamp with time zone', True], 'expires_at': ['timestamp with time zone', True], 'next_at': ['timestamp with time zone', True], 'webhook_id': ['character varying(128)', False], 'owner_digest': ['character varying(64)', False], 'signup_owner_digest': ['character varying(64)', False], 'webhook_ids': ['text[]', True], 'confirmation_digest':['character varying(64)',False]}


def require_retry_schema(session):
    rows = session.execute(text(RETRY_SCHEMA_SQL)).mappings().all()
    if len(rows) != 1:
        raise GateUnavailable
    row = rows[0]
    if (row['kind'] != 'r' or row['rls'] is not True or row['forced_rls'] is not False
            or row['columns'] != RETRY_COLUMNS
            or any(row[key] is not True for key in (
                'runtime_owns_table','exact_constraints','exact_indexes','no_inheritance',
                'no_column_expressions','exact_column_order','no_rules','no_policies','no_user_triggers',
                'no_public_acl','public_roles_exist','no_public_access'))):
        raise GateUnavailable


class PostgresSmsRetry:
    def __init__(self, factory, budget, clock=time.time):
        self.factory,self.budget,self.clock=factory,budget,clock

    def _gate(self):
        from app.sms_send_gate import PostgresSendGate
        return PostgresSendGate(self.factory,self.budget,retry_store=self)

    def lock(self, session):
        session.execute(text('LOCK TABLE ONLY public.sms_retry_operations IN SHARE ROW EXCLUSIVE MODE'))
        require_retry_schema(session)

    def _at(self):
        now=self.clock()
        if not math.isfinite(now): raise GateUnavailable
        return datetime.fromtimestamp(now,timezone.utc)

    def _owner(self, owner):
        try: owner=str(UUID(owner))
        except (ValueError,TypeError,AttributeError): raise GateUnavailable from None
        return hmac.new(self.budget.phone_hash_key.encode(),b'gongxingji/sms-retry-owner/v1\0'+owner.encode(),hashlib.sha256).hexdigest()

    def _challenge(self,operation,native_hash):
        if not isinstance(native_hash,str) or not re.fullmatch('[0-9a-f]{56}',native_hash): raise GateUnavailable
        return hmac.new(self.budget.phone_hash_key.encode(),b'gongxingji/sms-retry-auth-commit/v1\0'+operation.encode()+b'\0'+native_hash.encode(),hashlib.sha256).hexdigest()

    @staticmethod
    def _valid(row):
        if (row is None or not 1<=row['attempt_no']<=5 or row['state'] not in
            {'armed','inflight','not_dispatched','accepted','rejected','unknown','closed'}
            or not isinstance(row['webhook_ids'],list) or len(row['webhook_ids'])>5
            or len(set(row['webhook_ids']))!=len(row['webhook_ids'])
            or row['expires_at']!=row['created_at']+timedelta(seconds=40)):
            raise GateUnavailable
        return row

    def begin(self,phone,proposed=None,cancelled=None):
        digest=self.budget.phone_digest(phone)
        if digest is None: raise GateRejected('recipient')
        op,nonce,attempt=proposed if proposed is not None else (secrets.token_hex(32),secrets.token_hex(32),1)
        if attempt!=1 or not all(isinstance(x,str) and re.fullmatch('[0-9a-f]{64}',x) for x in (op,nonce)): raise GateUnavailable
        with self._gate()._transaction() as db:
            if cancelled is not None and cancelled.is_set(): raise GateUnavailable
            latest=db.execute(text('SELECT max(created_at) FROM public.sms_retry_operations WHERE phone_digest=:phone'),{'phone':digest}).scalar_one()
            recent=db.execute(text(self.cooldown_sql()),{'phone':digest}).scalar_one()
            last=max([x for x in (latest,recent) if x is not None],default=None)
            if cancelled is not None and cancelled.is_set(): raise GateUnavailable
            at=self._at()
            if last is not None and at<last+timedelta(seconds=60):
                raise GateRejected('cooldown',max(1,min(60,math.ceil((last+timedelta(seconds=60)-at).total_seconds()))))
            db.execute(text("INSERT INTO public.sms_retry_operations(operation_id,phone_digest,attempt_nonce,attempt_no,state,created_at,expires_at,next_at,webhook_ids) VALUES(:op,:phone,:nonce,1,'armed',:at,:expiry,:at,ARRAY[]::text[])"),{'op':op,'phone':digest,'nonce':nonce,'at':at,'expiry':at+timedelta(seconds=40)})
            if cancelled is not None and cancelled.is_set(): raise GateUnavailable
        return (op,nonce,1)

    @staticmethod
    def cooldown_expression(alias='s'):
        # Fixed internal aliases only. No caller input is interpolated.
        if alias not in ('s','public.sms_send_reservations'): raise GateUnavailable
        return "COALESCE((SELECT o.created_at FROM public.sms_retry_operations o WHERE o.phone_digest="+alias+".phone_digest AND "+alias+".webhook_id=ANY(o.webhook_ids)),"+alias+".reserved_at)"

    def cooldown_sql(self):
        return 'SELECT max('+self.cooldown_expression()+') FROM public.sms_send_reservations s WHERE s.phone_digest=:phone'

    def claim(self,db,webhook,phone_digest,owner,now,challenge_hash=None):
        row=db.execute(text('SELECT * FROM public.sms_retry_operations WHERE phone_digest=:phone ORDER BY created_at DESC LIMIT 1 FOR UPDATE'),{'phone':phone_digest}).mappings().one_or_none()
        if row is None or now>=row['created_at']+timedelta(seconds=60): return None
        row=self._valid(row)
        if row['state']!='armed' or now>=row['expires_at'] or now<row['next_at']:
            raise GateRejected('cooldown',max(1,min(60,math.ceil((row['created_at']+timedelta(seconds=60)-now).total_seconds()))))
        if challenge_hash is None: raise GateRejected('policy')
        confirmation_digest=self._challenge(row['operation_id'],challenge_hash)
        owner_digest=self._owner(owner)
        if row['signup_owner_digest'] is not None and not hmac.compare_digest(row['signup_owner_digest'],owner_digest):
            raise GateRejected('policy')
        if row['attempt_no']>1:
            prior=db.execute(text('SELECT outcome FROM public.sms_send_reservations WHERE webhook_id=:id AND phone_digest=:phone'),{'id':row['webhook_id'],'phone':phone_digest}).scalar_one_or_none()
            if prior!='not_dispatched': raise GateUnavailable
        events=row['webhook_ids']+[webhook]
        if len(events)!=row['attempt_no'] or len(events)>5: raise GateUnavailable
        db.execute(text("UPDATE public.sms_retry_operations SET state='inflight',webhook_id=:webhook,owner_digest=:owner,webhook_ids=:events,confirmation_digest=:confirmation WHERE operation_id=:op"),{'webhook':webhook,'owner':owner_digest,'events':events,'confirmation':confirmation_digest,'op':row['operation_id']})
        return (row['operation_id'],row['attempt_nonce'],row['attempt_no'],row['created_at'].timestamp())

    def finish(self,db,webhook,outcome,now):
        row=db.execute(text('SELECT * FROM public.sms_retry_operations WHERE webhook_id=:webhook FOR UPDATE'),{'webhook':webhook}).mappings().one_or_none()
        if row is None: return
        row=self._valid(row)
        target={'provider_accepted':'accepted','not_dispatched':'not_dispatched','rejected':'rejected','unknown':'unknown'}[outcome]
        # A relay cancellation/unknown closes authority permanently even if the
        # already-running Hook later records the factual ledger outcome.
        if row['state'] in ('unknown','closed'): return
        if row['state']==target: return
        if row['state']!='inflight': raise GateUnavailable
        db.execute(text('UPDATE public.sms_retry_operations SET state=:state,next_at=:next WHERE operation_id=:op'),{'state':target,'next':now+timedelta(seconds=2),'op':row['operation_id']})

    def advance(self,held,returned,cancelled=None):
        if held!=returned: raise GateUnavailable
        at=self._at()
        with self._gate()._transaction() as db:
            if cancelled is not None and cancelled.is_set(): raise GateUnavailable
            row=self._valid(db.execute(text('SELECT * FROM public.sms_retry_operations WHERE operation_id=:op FOR UPDATE'),{'op':held[0]}).mappings().one_or_none())
            if (not hmac.compare_digest(row['attempt_nonce'],held[1]) or row['attempt_no']!=held[2]
                or row['state']!='not_dispatched' or at<row['next_at'] or row['attempt_no']>=5
                or (row['expires_at']-at).total_seconds()<NEXT_ATTEMPT_MINIMUM_SECONDS): raise GateUnavailable
            outcome=db.execute(text('SELECT outcome FROM public.sms_send_reservations WHERE webhook_id=:id AND phone_digest=:phone'),{'id':row['webhook_id'],'phone':row['phone_digest']}).scalar_one_or_none()
            if outcome!='not_dispatched': raise GateUnavailable
            nonce=secrets.token_hex(32)
            db.execute(text("UPDATE public.sms_retry_operations SET attempt_nonce=:nonce,attempt_no=attempt_no+1,state='armed',signup_owner_digest=NULL WHERE operation_id=:op"),{'nonce':nonce,'op':held[0]})
            if cancelled is not None and cancelled.is_set(): raise GateUnavailable
        return (held[0],nonce,held[2]+1)

    def require_armed_for_auth_retry(self,held,phone,cancelled=None):
        # An Auth pre-send response is not authority to reopen a consumed slot.
        # This read/check shares the normal gate's transaction and schema locks.
        digest=self.budget.phone_digest(phone)
        if digest is None: raise GateUnavailable
        with self._gate()._transaction() as db:
            if cancelled is not None and cancelled.is_set(): raise GateUnavailable
            row=self._valid(db.execute(text('SELECT * FROM public.sms_retry_operations WHERE operation_id=:op FOR UPDATE'),{'op':held[0]}).mappings().one_or_none())
            at=self._at()  # Refresh after acquiring locks, not before waiting.
            if (row['phone_digest']!=digest or row['attempt_no']!=held[2]
                or not hmac.compare_digest(row['attempt_nonce'],held[1])
                or row['state']!='armed' or not row['created_at']<=at<row['expires_at']
                or at<row['next_at'] or (row['expires_at']-at).total_seconds()<NEXT_ATTEMPT_MINIMUM_SECONDS
                or len(row['webhook_ids'])!=row['attempt_no']-1): raise GateUnavailable
            if row['attempt_no']==1:
                if (row['webhook_id'] is not None or row['owner_digest'] is not None
                    or row['confirmation_digest'] is not None): raise GateUnavailable
            else:
                if (row['webhook_id']!=row['webhook_ids'][-1] or row['owner_digest'] is None
                    or row['confirmation_digest'] is None): raise GateUnavailable
                outcome=db.execute(text('SELECT outcome FROM public.sms_send_reservations WHERE webhook_id=:id AND phone_digest=:phone'),{'id':row['webhook_id'],'phone':digest}).scalar_one_or_none()
                if outcome!='not_dispatched': raise GateUnavailable
            if cancelled is not None and cancelled.is_set(): raise GateUnavailable
        # Do not change attempt, nonce, signup owner, timing or any Hook evidence.

    def accepted(self,held,phone):
        with self._gate()._transaction() as db:
            row=self._valid(db.execute(text('SELECT * FROM public.sms_retry_operations WHERE operation_id=:op'),{'op':held[0]}).mappings().one_or_none())
            if row['attempt_no']!=held[2] or not hmac.compare_digest(row['attempt_nonce'],held[1]) or row['state']!='accepted': raise GateUnavailable
            if db.execute(text("SELECT outcome='provider_accepted' FROM public.sms_send_reservations WHERE webhook_id=:id"),{'id':row['webhook_id']}).scalar_one_or_none() is not True: raise GateUnavailable
            if self.budget.phone_digest(phone)!=row['phone_digest']: raise GateUnavailable
            user=db.execute(text('SELECT id::text AS id,confirmation_token FROM auth.users WHERE phone IN (:phone,:e164) AND is_anonymous IS FALSE'),{'phone':phone.removeprefix('+'),'e164':phone}).mappings().one_or_none()
            if (user is None or self._owner(user['id'])!=row['owner_digest']
                or not isinstance(row['confirmation_digest'],str)
                or not hmac.compare_digest(self._challenge(held[0],user['confirmation_token']),row['confirmation_digest'])): raise GateUnavailable
            return max(0,min(60,math.ceil((row['created_at']+timedelta(seconds=60)-self._at()).total_seconds())))

    def close(self,held):
        with self._gate()._transaction() as db:
            db.execute(text("UPDATE public.sms_retry_operations SET state=CASE WHEN state='not_dispatched' THEN 'closed' ELSE 'unknown' END WHERE operation_id=:op AND state NOT IN ('accepted','rejected','unknown','closed')"),{'op':held[0],'nonce':held[1],'attempt':held[2]})

    def _signup_operation(self,session,digest):
        # Called only inside the signed signup Hook's existing PHONE transaction.
        from app.team_workspace import _require_private_transaction
        from app.sms_send_gate import require_sms_schema, _LOCK_KEY
        _require_private_transaction(session,factory=self.factory)
        session.execute(text('LOCK TABLE ONLY public.sms_send_reservations IN SHARE ROW EXCLUSIVE MODE'))
        require_sms_schema(session)
        session.execute(text('SELECT pg_advisory_xact_lock(:key)'),{'key':_LOCK_KEY})
        self.lock(session)
        row=session.execute(text('SELECT * FROM public.sms_retry_operations WHERE phone_digest=:phone ORDER BY created_at DESC LIMIT 1 FOR UPDATE'),{'phone':digest}).mappings().one_or_none()
        if row is None: return None
        row=self._valid(row);at=self._at()
        if row['phone_digest']!=digest: raise GateUnavailable
        # No current relay lease after its full cooldown. Preserve the existing
        # standalone Auth/legacy-claim path without reviving the old operation.
        if at>=row['created_at']+timedelta(seconds=60): return None
        if (row['phone_digest']!=digest or row['state']!='armed'
            or not row['created_at']<=at<row['expires_at'] or at<row['next_at']): raise GateUnavailable
        if row['attempt_no']==1:
            if (row['webhook_ids'] or row['webhook_id'] is not None
                or row['owner_digest'] is not None or row['confirmation_digest'] is not None): raise GateUnavailable
        elif (len(row['webhook_ids'])!=row['attempt_no']-1 or not row['webhook_ids']
              or row['webhook_id']!=row['webhook_ids'][-1] or row['owner_digest'] is None): raise GateUnavailable
        return row,at

    def bind_signup_operation(self,session,digest,owner,prior_owner=None):
        # The future UID comes from the verified Auth Hook, never client metadata.
        # A completely unobserved old Hook has no request token in this protocol;
        # binding the first arrival cannot prove which Auth call originated it.
        checked=self._signup_operation(session,digest)
        if checked is None: return None
        row,checked_at=checked
        owner_digest=self._owner(owner)
        if row['signup_owner_digest'] is not None and not hmac.compare_digest(row['signup_owner_digest'],owner_digest): raise GateUnavailable
        seen=session.execute(text('SELECT EXISTS(SELECT 1 FROM public.sms_retry_operations WHERE phone_digest=:phone AND created_at<:current AND COALESCE(signup_owner_digest,owner_digest)=:owner)'),{'phone':digest,'current':row['created_at'],'owner':owner_digest}).scalar_one()
        if seen: raise GateUnavailable
        if row['attempt_no']>1:
            if prior_owner is None: raise GateUnavailable
            prior_digest=self._owner(prior_owner)
            if (prior_digest!=row['owner_digest'] and not
                (row['signup_owner_digest']==owner_digest and prior_digest==owner_digest)): raise GateUnavailable
            outcome=session.execute(text('SELECT outcome FROM public.sms_send_reservations WHERE webhook_id=:id AND phone_digest=:phone'),{'id':row['webhook_id'],'phone':digest}).scalar_one_or_none()
            if outcome!='not_dispatched': raise GateUnavailable
        session.execute(text('UPDATE public.sms_retry_operations SET signup_owner_digest=:owner WHERE operation_id=:op'),{'owner':owner_digest,'op':row['operation_id']})
        return checked_at

    def authorize_signup_recovery(self,session,digest,old_owner,new_owner,*,claim_updated_at=None):
        checked=self._signup_operation(session,digest)
        if checked is None: return False
        row,_=checked
        old_digest,new_digest=self._owner(old_owner),self._owner(new_owner)
        if row['signup_owner_digest'] is not None and not hmac.compare_digest(row['signup_owner_digest'],new_digest): return False
        if row['attempt_no']>1:
            # Same-operation automatic retry still requires durable non-dispatch.
            if row['owner_digest']!=old_digest: return False
            outcome=session.execute(text('SELECT outcome FROM public.sms_send_reservations WHERE webhook_id=:id AND phone_digest=:phone'),{'id':row['webhook_id'],'phone':digest}).scalar_one_or_none()
            if outcome!='not_dispatched': return False
        else:
            # A new explicit operation may replace only its proven predecessor's
            # orphan claim after the original operation's full 60-second window.
            prior=session.execute(text('SELECT * FROM public.sms_retry_operations WHERE phone_digest=:phone AND created_at<:current ORDER BY created_at DESC LIMIT 1 FOR UPDATE'),{'phone':digest,'current':row['created_at']}).mappings().one_or_none()
            if prior is None: return False
            prior=self._valid(prior)
            effective_owner=prior['signup_owner_digest'] if prior['signup_owner_digest'] is not None else prior['owner_digest']
            if (prior['phone_digest']!=digest or effective_owner!=old_digest
                or claim_updated_at is None or not prior['created_at']<=claim_updated_at<prior['expires_at']
                or prior['created_at']+timedelta(seconds=60)>row['created_at']): return False
        session.execute(text('UPDATE public.sms_retry_operations SET signup_owner_digest=:owner WHERE operation_id=:op'),{'owner':new_digest,'op':row['operation_id']})
        return True


async def send_phone_otp(upstream,store,body,*,monotonic=time.monotonic,sleep=asyncio.sleep):
    """One awaited operation. No detached retry task and no retry on cancellation."""
    deadline=monotonic()+OPERATION_SECONDS
    held=None
    auth_retry=False
    cancelled=threading.Event()
    async def bounded(function,*args):
        remaining=deadline-0.5-monotonic()
        if cancelled.is_set() or remaining<=0: raise TimeoutError()
        return await asyncio.wait_for(asyncio.to_thread(function,*args),remaining)
    def call_upstream():
        # The executor may have queued this job after the outer check. Admit
        # an Auth request only at the actual worker entry, with its full window.
        if cancelled.is_set() or deadline-monotonic()<NEXT_ATTEMPT_MINIMUM_SECONDS+0.5:
            raise TimeoutError()
        if auth_retry:
            store.require_armed_for_auth_retry(held,body['phone'],cancelled)
            # Lock acquisition can consume the budget or outlive cancellation.
            if cancelled.is_set() or deadline-monotonic()<NEXT_ATTEMPT_MINIMUM_SECONDS+0.5:
                raise TimeoutError()
        return upstream('/otp','POST',body)
    try:
        held=(secrets.token_hex(32),secrets.token_hex(32),1)
        await bounded(store.begin,body['phone'],held,cancelled)
        for attempt in range(1,MAX_ATTEMPTS+1):
            if deadline-monotonic()<NEXT_ATTEMPT_MINIMUM_SECONDS+0.5: raise TimeoutError()
            try:
                await bounded(call_upstream)
            except AuthFrequencyLimited as error:
                # Auth reports truncated whole seconds. Cross that boundary and
                # retain the existing minimum inter-request spacing.
                delay=max(RETRY_DELAY_SECONDS,error.seconds+1.0)
                if attempt==MAX_ATTEMPTS or deadline-monotonic()<delay+NEXT_ATTEMPT_MINIMUM_SECONDS+0.5:
                    raise
                await bounded(store.require_armed_for_auth_retry,held,body['phone'],cancelled)
                if deadline-monotonic()<delay+NEXT_ATTEMPT_MINIMUM_SECONDS+0.5:
                    raise
                await asyncio.wait_for(sleep(delay),deadline-0.5-monotonic())
                auth_retry=True
                continue
            except RetryReceipt as error:
                # Wrong/missing response receipt must never authorize another call.
                if held!=error.receipt: raise public_unknown() from None
                if attempt==MAX_ATTEMPTS or deadline-monotonic()<RETRY_DELAY_SECONDS+NEXT_ATTEMPT_MINIMUM_SECONDS+0.5:
                    raise HTTPException(error.status_code,error.detail) from None
                await sleep(RETRY_DELAY_SECONDS)
                held=await bounded(store.advance,held,error.receipt,cancelled)
                auth_retry=False
                continue
            return await bounded(store.accepted,held,body['phone'])
        raise public_unknown()
    except GateRejected as error:
        if error.reason=='cooldown':
            raise HTTPException(429,{'code':'gxj_sms_cooldown','message':'请间隔至少60秒再申请验证码','retryAfterSeconds':error.retry_after_seconds}) from None
        raise HTTPException(503,{'code':'gxj_sms_gate_unavailable','message':'短信发送状态暂时无法核对，请稍后核对，不要自动重发'}) from None
    except HTTPException:
        raise
    except asyncio.CancelledError:
        raise
    except Exception:
        raise public_unknown() from None
    finally:
        cancelled.set()
        if held is not None:
            # Cleanup does not create retry authority; a cancellation/timeout
            # never resubmits a provider or Auth request. SQL is bounded by the
            # private transaction profile. Unknown cleanup COMMIT stays unknown.
            try:
                remaining=max(0.0,min(0.5,deadline-monotonic()))
                if remaining>0:
                    await asyncio.wait_for(asyncio.to_thread(store.close,held),remaining)
            except BaseException:
                pass
