"""Phone ownership for email/password accounts; never merges training or users.

The native Auth phone-change lookup is not unique. A private ownership claim and
checks against both confirmed and pending Auth numbers protect the same UID.
"""
from __future__ import annotations

import json
import os
import time
from datetime import datetime, timezone
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import text

from app.auth import authenticated_user_id, _supabase_url
from app.sms_hook import canonical_mainland_phone
from app.sms_send_gate import SmsSendBudget

_LOCK=621662560617157762
_SIGNUP_COMMIT_SOURCE_SHA256='33d03fa89b0950d25e92fb9abc3b4fd151c6f5d2adba9aa97a54841a3f457152'
_SIGNUP_COMMIT_CATALOG="""SELECT count(*)=1 AND coalesce(bool_and(
  t.tgtype=5 AND t.tgenabled='O' AND NOT t.tgisinternal
  AND t.tgdeferrable AND t.tginitdeferred AND t.tgconstraint<>0
  AND t.tgnargs=0 AND octet_length(t.tgargs)=0
  AND t.tgqual IS NULL AND t.tgattr::text=''
  AND t.tgfoid='public.gxj_phone_signup_commit_guard()'::regprocedure
  AND p.proname='gxj_phone_signup_commit_guard' AND n.nspname='public'
  AND p.pronargs=0 AND p.prorettype='pg_catalog.trigger'::regtype
  AND p.prosecdef AND NOT p.proisstrict AND NOT p.proleakproof
  AND p.provolatile='v' AND p.proparallel='u' AND l.lanname='plpgsql'
  AND p.proconfig=ARRAY['search_path=pg_catalog']::text[]
  AND p.proowner=claims.relowner
  AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=:source_sha
  AND NOT EXISTS (
    SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) AS a
    WHERE a.grantee=0 OR a.grantee IN
      (SELECT oid FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role')))
),false) AS compatible
FROM pg_trigger AS t
JOIN pg_proc AS p ON p.oid=t.tgfoid
JOIN pg_namespace AS n ON n.oid=p.pronamespace
JOIN pg_language AS l ON l.oid=p.prolang
JOIN pg_class AS claims ON claims.oid='public.phone_binding_claims'::regclass
WHERE t.tgrelid='auth.users'::regclass AND t.tgname='gxj_phone_signup_commit_guard'
"""

class PhoneStart(BaseModel):
    model_config=ConfigDict(extra='forbid')
    phone: str=Field(min_length=1,max_length=24)

class PhoneVerify(PhoneStart):
    token: str=Field(pattern=r'^[0-9]{6}$')

class PostgresAccountStore:
    def __init__(self, session_factory, budget: SmsSendBudget, clock=time.time, allowed_owners=None, retry_store=None):
        self.factory,self.budget,self.clock=session_factory,budget,clock
        self.retry_store=retry_store
        owners=allowed_owners if allowed_owners is not None else tuple(filter(None,os.getenv('ACCOUNT_PHONE_BINDING_ALLOWED_OWNER_IDS','').split(',')))
        try:
            self.allowed_owners=tuple(str(UUID(owner)) for owner in owners) if len(owners)<=8 else ()
        except (ValueError,TypeError,AttributeError):
            self.allowed_owners=()

    def _user(self, session, owner):
        UUID(owner)
        row=session.execute(text('SELECT id::text AS id, phone, phone_change, phone_confirmed_at, is_anonymous FROM auth.users WHERE id=CAST(:owner AS uuid)'),{'owner':owner}).mappings().one_or_none()
        if not row or row['is_anonymous']:
            raise HTTPException(401,'登录状态无效，请重新登录')
        return row

    def status(self, owner):
        try:
            with self.factory() as session:
                user=self._user(session,owner)
                self._enrollment_guard(session,owner)
            return {'owner':owner,'phoneVerified':bool(canonical_mainland_phone(user['phone']) and user['phone_confirmed_at'])}
        except HTTPException:
            raise
        except Exception:
            raise HTTPException(503,'账号状态暂时无法核对，请稍后重试') from None

    def _enrollment_guard(self,session,owner,*,complete=False):
        from app.email_enrollment import configured_enrollment_guard
        configured_enrollment_guard(session,owner,complete=complete)

    def _lock(self, session):
        if session.get_bind().dialect.name!='postgresql':
            raise HTTPException(503,'手机绑定存储尚未就绪')
        session.execute(text("SET LOCAL statement_timeout='1000ms'"))
        session.execute(text("SET LOCAL lock_timeout='400ms'"))
        session.execute(text('SELECT pg_advisory_xact_lock(:key)'),{'key':_LOCK})

    def _number(self, phone, owner=None, *, signup=False):
        normalized=canonical_mainland_phone(phone)
        if normalized is None:
            raise HTTPException(422,'暂不支持该手机号，请使用中国大陆手机号')
        digest=(self.budget.registration_phone_digest(normalized) if signup else self.budget.approved_phone_digest(normalized))
        if digest is None and owner in self.allowed_owners:
            digest=self.budget.phone_digest(normalized)
        if digest is None and owner is not None and os.getenv('EMAIL_ENROLLMENT_GUARD_ENABLED')=='1':
            from app.email_enrollment import configured_enrollment_phone_allowed
            with self.factory.begin() as session:
                self._lock(session)
                if configured_enrollment_phone_allowed(session,owner,normalized):
                    digest=self.budget.phone_digest(normalized)
        if digest is None:
            raise HTTPException(403,'该手机号尚未加入本轮测试范围')
        return normalized,digest

    def _other(self, session, owner, phone):
        count=session.execute(text("SELECT COUNT(*) FROM auth.users WHERE id<>CAST(:owner AS uuid) AND (phone IN (:phone,:e164) OR phone_change IN (:phone,:e164))"),{'owner':owner,'phone':phone[1:],'e164':phone}).scalar_one()
        if count:
            raise HTTPException(409,'该手机号已被其他账号使用或正在验证，请使用另一手机号')

    def reserve(self, owner, phone):
        normalized,digest=self._number(phone,owner)
        try:
            with self.factory.begin() as session:
                self._lock(session)
                user=self._user(session,owner)
                self._enrollment_guard(session,owner)
                if user['phone_confirmed_at'] and canonical_mainland_phone(user['phone']):
                    raise HTTPException(409,'此账号已验证手机，无需重复绑定')
                self._other(session,owner,normalized)
                if session.execute(text("SELECT COUNT(*) FROM phone_binding_claims WHERE owner=:owner AND state='pending' AND phone_digest<>:digest"),{'owner':owner,'digest':digest}).scalar_one():
                    raise HTTPException(409,'此账号已有未完成的手机验证，请先完成原号码验证')
                prior=session.execute(text('SELECT owner FROM phone_binding_claims WHERE phone_digest=:digest'),{'digest':digest}).scalar_one_or_none()
                if prior and prior!=owner:
                    raise HTTPException(409,'该手机号有尚未结束的账号绑定，请使用另一手机号')
                session.execute(text("INSERT INTO phone_binding_claims(phone_digest,owner,state,updated_at) VALUES(:digest,:owner,'pending',:at) ON CONFLICT(phone_digest) DO UPDATE SET updated_at=EXCLUDED.updated_at"),{'digest':digest,'owner':owner,'at':datetime.fromtimestamp(self.clock(),timezone.utc)})
            return normalized
        except HTTPException:
            raise
        except Exception:
            raise HTTPException(503,'手机绑定暂时不可用；没有切换账号') from None

    def require_pending(self, owner, phone):
        normalized,digest=self._number(phone,owner)
        try:
            with self.factory.begin() as session:
                self._lock(session)
                self._user(session,owner)
                self._enrollment_guard(session,owner)
                self._other(session,owner,normalized)
                row=session.execute(text('SELECT owner,state FROM phone_binding_claims WHERE phone_digest=:digest'),{'digest':digest}).mappings().one_or_none()
                if not row or row['owner']!=owner or row['state']!='pending':
                    raise HTTPException(409,'当前手机验证不属于此账号，请重新开始')
            return normalized
        except HTTPException:
            raise
        except Exception:
            raise HTTPException(503,'手机绑定状态暂时无法核对') from None

    def complete(self, owner, phone):
        normalized,digest=self._number(phone,owner)
        try:
            with self.factory.begin() as session:
                self._lock(session)
                user=self._user(session,owner)
                self._enrollment_guard(session,owner)
                self._other(session,owner,normalized)
                if canonical_mainland_phone(user['phone'])!=normalized or not user['phone_confirmed_at']:
                    raise HTTPException(409,'手机确认尚未完成，请重新核对')
                row=session.execute(text('SELECT owner FROM phone_binding_claims WHERE phone_digest=:digest'),{'digest':digest}).scalar_one_or_none()
                if row!=owner:
                    raise HTTPException(409,'手机确认账号不一致，未采用登录结果')
                self._enrollment_guard(session,owner,complete=True)
                session.execute(text("UPDATE phone_binding_claims SET state='verified',updated_at=:at WHERE phone_digest=:digest AND owner=:owner"),{'digest':digest,'owner':owner,'at':datetime.fromtimestamp(self.clock(),timezone.utc)})
        except HTTPException:
            raise
        except Exception:
            raise HTTPException(503,'手机确认结果暂时无法核对，请重新连接') from None

    def hook_guard(self, user, phone):
        """Signed hook: only a reserved pending owner may send a change OTP."""
        # The same-number/login SMS branch must also enforce unfinished email
        # enrollment. It otherwise skips require_pending below.
        if os.getenv('EMAIL_ENROLLMENT_GUARD_ENABLED')=='1':
            with self.factory.begin() as session:
                self._lock(session)
                self._enrollment_guard(session,user.get('id',''))
        new_phone=user.get('new_phone')
        is_change=bool(new_phone) or canonical_mainland_phone(user.get('phone'))!=phone
        if is_change:
            self.require_pending(user.get('id',''),phone)

    def signup_guard(self, phone, future_owner):
        """Reserve the signed future UID before Auth inserts the user.

        A failed Auth transaction can leave its external hook reservation.
        A later explicit request may replace only an orphan pending claim,
        after cooldown and with the exact deferred Auth commit guard installed.
        That guard rejects an old, late transaction whose claim was replaced.
        """
        try:
            owner=str(UUID(future_owner))
        except (ValueError,TypeError,AttributeError):
            raise HTTPException(400,'注册账号标识无效') from None
        normalized,digest=self._number(phone,signup=True)
        try:
            with self.factory.begin() as session:
                self._lock(session)
                if session.execute(text('SELECT EXISTS(SELECT 1 FROM auth.users WHERE id::text=:owner)'),{'owner':owner}).scalar_one():
                    raise HTTPException(409,'手机号注册账号已存在，不能重新接管')
                self._other(session,owner,normalized)
                if session.execute(text("SELECT COUNT(*) FROM phone_binding_claims WHERE owner=:owner AND state='pending' AND phone_digest<>:digest"),{'owner':owner,'digest':digest}).scalar_one():
                    raise HTTPException(409,'此账号已有未完成的手机验证')
                claim=session.execute(text('SELECT owner,state,updated_at FROM phone_binding_claims WHERE phone_digest=:digest FOR UPDATE'),{'digest':digest}).mappings().one_or_none()
                if self.retry_store is not None:
                    self._require_signup_commit_guard(session)
                if claim and claim['owner']!=owner:
                    self._recover_signup_claim(session,claim,digest,owner)
                signup_checked_at=None
                if self.retry_store is not None:
                    signup_checked_at=self.retry_store.bind_signup_operation(session,digest,owner,None if claim is None else claim['owner'])
                # Keep the claim timestamp inside the exact validated relay lease,
                # even if the final SQL write completes after that lease expires.
                at=signup_checked_at if signup_checked_at is not None else datetime.fromtimestamp(self.clock(),timezone.utc)
                session.execute(text("INSERT INTO phone_binding_claims(phone_digest,owner,state,updated_at) VALUES(:digest,:owner,'pending',:at) ON CONFLICT(phone_digest) DO UPDATE SET updated_at=EXCLUDED.updated_at"),{'digest':digest,'owner':owner,'at':at})
        except HTTPException:
            raise
        except Exception:
            raise HTTPException(503,'手机号注册状态暂时无法核对') from None

    def _recover_signup_claim(self,session,claim,digest,owner):
        # No account is deleted, merged, verified or given a password here.
        # The Auth commit guard, not elapsed time, makes reassignment safe.
        existing=session.execute(text('SELECT EXISTS(SELECT 1 FROM auth.users WHERE id::text=:owner)'),{'owner':claim['owner']}).scalar_one()
        if claim['state']!='pending' or existing:
            raise HTTPException(409,'本次手机号验证暂时无法继续，请稍后重新获取验证码')
        at=datetime.fromtimestamp(self.clock(),timezone.utc)
        self._require_signup_commit_guard(session)
        if (at-claim['updated_at']).total_seconds()<60:
            authorized=(self.retry_store is not None and self.retry_store.authorize_signup_recovery(session,digest,claim['owner'],owner,claim_updated_at=claim['updated_at']))
            if not authorized:
                raise HTTPException(429,'请间隔至少60秒再申请验证码')
        recovered=session.execute(text("UPDATE phone_binding_claims SET owner=:owner,updated_at=:at WHERE phone_digest=:digest AND owner=:previous AND state='pending' AND NOT EXISTS(SELECT 1 FROM auth.users WHERE id::text=:previous) RETURNING owner"),{'owner':owner,'at':at,'digest':digest,'previous':claim['owner']}).scalar_one_or_none()
        if recovered!=owner:
            raise HTTPException(503,'手机号验证恢复结果未能核对，请稍后重试')

    def _require_signup_commit_guard(self,session):
        # Fresh snapshots after the PHONE lock and an exact deferred fence are
        # both required. Missing/altered database protection never frees a claim.
        if session.execute(text("SELECT current_setting('transaction_isolation')")).scalar_one()!='read committed':
            raise HTTPException(503,'手机号验证恢复暂未就绪，请稍后重试')
        if session.execute(text(_SIGNUP_COMMIT_CATALOG),{'source_sha':_SIGNUP_COMMIT_SOURCE_SHA256}).scalar_one() is not True:
            raise HTTPException(503,'手机号验证恢复暂未就绪，请稍后重试')

    def approved_recipient(self, phone):
        """A narrow operator-approved UID may add its own privately entered number."""
        digest=self.budget.phone_digest(phone)
        if digest is None:
            return None
        try:
            with self.factory() as session:
                row=session.execute(text('SELECT owner,state FROM phone_binding_claims WHERE phone_digest=:digest'),{'digest':digest}).mappings().one_or_none()
                if not row:
                    return None
                if row['owner'] not in self.allowed_owners:
                    if os.getenv('EMAIL_ENROLLMENT_GUARD_ENABLED')!='1':
                        return None
                    from app.email_enrollment import configured_enrollment_phone_allowed
                    self._lock(session)
                    row=session.execute(text('SELECT owner,state FROM phone_binding_claims WHERE phone_digest=:digest'),{'digest':digest}).mappings().one_or_none()
                    if not row or not configured_enrollment_phone_allowed(session,row['owner'],phone):
                        return None
                user=self._user(session,row['owner'])
                # Native verification may have committed before our final read
                # timed out. A matching confirmed phone is authoritative even
                # when the private bookkeeping row still says pending.
                if user['phone_confirmed_at'] and canonical_mainland_phone(user['phone'])==canonical_mainland_phone(phone):
                    return digest
                if row['state']=='pending' and not user['phone_confirmed_at']:
                    return digest
                return None
        except HTTPException:
            raise
        except Exception:
            raise HTTPException(503,'测试手机授权暂时无法核对') from None

    def release_rejected_start(self, owner, phone):
        """Only after a completed Auth rejection and no persisted challenge.

        Timeouts and 5xx are uncertain, so callers must retain those claims.
        Confirmed phones and existing native challenges are never released.
        """
        normalized,digest=self._number(phone,owner)
        with self.factory.begin() as session:
            self._lock(session)
            user=self._user(session,owner)
            if canonical_mainland_phone(user['phone'])==normalized or canonical_mainland_phone(user['phone_change'])==normalized:
                return
            session.execute(text("DELETE FROM phone_binding_claims WHERE phone_digest=:digest AND owner=:owner AND state='pending'"),{'digest':digest,'owner':owner})

def auth_upstream(path, method, body, bearer, *, redirect_to=None):
    if not bearer or not bearer.startswith('Bearer '):
        raise HTTPException(401,'请先登录')
    headers={'Authorization':bearer,'Content-Type':'application/json'}
    open_request=urlopen
    if redirect_to is not None:
        # Private email-change dispatch only. Do not put the correlation marker
        # in a URL or allow the transport to forward it on HTTP redirects.
        from urllib.parse import urlsplit
        from urllib.request import HTTPRedirectHandler, build_opener
        if ((path,method)!=('/user','PUT') or not isinstance(redirect_to,str)
                or not 1 <= len(redirect_to) <= 2048 or not redirect_to.isascii()
                or any(ord(c)<=32 or ord(c)==127 for c in redirect_to)):
            raise HTTPException(503,'账号服务关联配置无效')
        try:
            parsed=urlsplit(redirect_to)
            if (parsed.scheme!='https' or not parsed.hostname or parsed.username or parsed.password
                    or parsed.query or not parsed.fragment.startswith('gxj-channel=')):
                raise ValueError('invalid_private_redirect')
        except ValueError:
            raise HTTPException(503,'账号服务关联配置无效') from None
        class NoRedirect(HTTPRedirectHandler):
            def redirect_request(self,*args,**kwargs):return None
        open_request=build_opener(NoRedirect()).open
        headers['redirect_to']=redirect_to
    headers['apikey']=os.getenv('SUPABASE_PUBLISHABLE_KEY','')
    request=Request(_supabase_url()+'/auth/v1'+path,data=json.dumps(body).encode() if body is not None else None,method=method,headers=headers)
    try:
        with open_request(request,timeout=6) as response:
            return json.loads(response.read(512*1024))
    except HTTPError as error:
        # Never reflect provider fields, OTPs, tokens, phone or email addresses.
        messages={400:'验证码无效或已过期，请重新核对',401:'登录状态已失效，请重新登录',403:'验证码无效或已过期，请重新核对',422:'账号验证请求未能完成',429:'请求过于频繁，请稍后重试'}
        raise HTTPException(error.code if error.code in messages else 502,messages.get(error.code,'账号服务暂不可用，请稍后重试')) from None
    except (URLError,OSError,ValueError):
        raise HTTPException(502,'连接超时或账号服务暂不可用，请稍后核对；没有切换账号') from None

def create_account_auth_router(store, upstream=auth_upstream):
    router=APIRouter(prefix='/api/auth')

    @router.get('/status')
    def status(owner=Depends(authenticated_user_id)):
        return store.status(owner)

    @router.post('/phone-binding/start')
    def start(body:PhoneStart, authorization:str|None=Header(default=None), owner=Depends(authenticated_user_id)):
        phone=store.reserve(owner,body.phone)
        try:
            user=upstream('/user','PUT',{'phone':phone,'channel':'sms'},authorization)
        except HTTPException as error:
            if error.status_code in (400,401,403,422,429):
                try:
                    store.release_rejected_start(owner,phone)
                except Exception:
                    pass  # Retention is safer than releasing an uncertain claim.
            raise
        if user.get('id')!=owner:
            raise HTTPException(409,'手机验证返回了不同账号，未采用结果')
        return {'owner':owner,'sent':True}

    @router.post('/phone-binding/verify')
    def verify(body:PhoneVerify, authorization:str|None=Header(default=None), owner=Depends(authenticated_user_id)):
        phone=store.require_pending(owner,body.phone)
        result=upstream('/verify','POST',{'phone':phone,'token':body.token,'type':'phone_change'},authorization)
        token=result.get('access_token')
        if not isinstance(token,str) or not token:
            raise HTTPException(502,'手机验证没有返回有效会话，请重新核对')
        user=upstream('/user','GET',None,'Bearer '+token)
        if user.get('id')!=owner or canonical_mainland_phone(user.get('phone'))!=phone or not user.get('phone_confirmed_at'):
            raise HTTPException(409,'手机验证账号不一致，未采用结果')
        store.complete(owner,phone)
        return result

    return router
