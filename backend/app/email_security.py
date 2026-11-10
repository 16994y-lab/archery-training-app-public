"""Phone-first account email proof without issuing an email login session.

Native Auth still owns passwords, login sessions and verified-email recovery.
The small application challenge is needed because native verifyOtp issues a
complete session before this unverified login label has been proved safe.
"""
from __future__ import annotations

import hashlib
import hmac
import math
import os
import re
import secrets
import time
from datetime import datetime, timedelta, timezone
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import text

from app.auth import authenticated_user_id
from app.email_delivery import canonical_email
from app.sms_hook import canonical_mainland_phone

_LOCK=621662560617157763


class EmptyEmailStart(BaseModel):
    model_config=ConfigDict(extra='forbid')


class EmailProof(BaseModel):
    model_config=ConfigDict(extra='forbid')
    challenge: UUID
    token: str=Field(pattern=r'^[0-9]{6}$')


class PostgresEmailSecurity:
    def __init__(self,factory,key,delivery,clock=time.time,total=0,allowed_owners=()):
        self.factory,self.delivery,self.clock,self.total=factory,delivery,clock,total
        self.enrollment_authorizer=None
        self.probe_send_guard=None
        self.post_change_authorizer=None
        self.recovery_authorizer=None
        self.key=hmac.digest(key.encode(),'gongxingji/email-proof/v1'.encode(),'sha256') if isinstance(key,str) and len(key.encode())>=32 else b''
        try:
            self.allowed=tuple(str(UUID(owner)) for owner in allowed_owners) if len(allowed_owners)<=8 else ()
        except (TypeError,ValueError,AttributeError):
            self.allowed=()

    def ready(self):
        return bool(self.key and self.allowed and isinstance(self.total,int) and 1<=self.total<=1000 and self.delivery.ready())

    def _digest(self,purpose,*values):
        if not self.key:
            raise HTTPException(503,'邮箱安全验证尚未接入完成')
        return hmac.new(self.key,('\0'.join((purpose,*values))).encode(),hashlib.sha256).hexdigest()

    def _lock(self,session):
        if session.get_bind().dialect.name!='postgresql':
            raise HTTPException(503,'邮箱安全存储尚未就绪')
        session.execute(text("SET LOCAL statement_timeout='1000ms'"))
        session.execute(text("SET LOCAL lock_timeout='400ms'"))
        session.execute(text('SELECT pg_advisory_xact_lock(:key)'),{'key':_LOCK})

    def _user(self,session,owner):
        try:
            owner=str(UUID(owner))
        except (ValueError,TypeError,AttributeError):
            raise HTTPException(401,'登录状态无效，请重新登录') from None
        row=session.execute(text('SELECT id::text AS id,email,phone,phone_confirmed_at,is_anonymous FROM auth.users WHERE id=CAST(:owner AS uuid)'),{'owner':owner}).mappings().one_or_none()
        if not row or row['is_anonymous']:
            raise HTTPException(401,'登录状态无效，请重新登录')
        if not row['phone_confirmed_at'] or not canonical_mainland_phone(row['phone']):
            raise HTTPException(403,'请先完成此账号的手机验证')
        email=canonical_email(row['email'])
        if not email:
            raise HTTPException(409,'此账号尚无可验证的登录邮箱')
        return email,self._digest('address',owner,email)

    def _proof(self,session,owner,digest):
        saved=session.execute(text('SELECT email_digest FROM account_email_proofs WHERE owner=:owner'),{'owner':owner}).scalar_one_or_none()
        return isinstance(saved,str) and hmac.compare_digest(saved,digest)

    def status(self,owner):
        try:
            with self.factory() as session:
                email,digest=self._user(session,owner)
                verified=self._proof(session,owner,digest)
                allowed=self._allowed(session,owner)
                pending=session.execute(text('SELECT challenge_id,email_digest,code_digest,attempts,expires_at FROM account_email_challenges WHERE owner=:owner'),{'owner':owner}).mappings().one_or_none()
                reserved=session.execute(text('SELECT max(reserved_at) FROM account_email_send_reservations WHERE owner=:owner'),{'owner':owner}).scalar_one_or_none()
                at=datetime.fromtimestamp(self.clock(),timezone.utc)
                active=bool(pending and pending['email_digest']==digest and pending['code_digest'] and pending['attempts']<5 and pending['expires_at']>at)
            return {'owner':owner,'emailVerified':verified,'emailVerificationReady':self.ready() and allowed,
                    'challenge':pending['challenge_id'] if active else None,
                    'expiresIn':int((pending['expires_at']-at).total_seconds()) if active else 0,
                    'retryAfter':min(60,max(0,math.ceil(60-(at-reserved).total_seconds()))) if reserved else 0}
        except HTTPException:
            raise
        except Exception:
            raise HTTPException(503,'邮箱验证状态暂时无法核对') from None

    def _allowed(self,session,owner,*,purpose='verification'):
        if purpose=='recovery' and self.recovery_authorizer is not None:
            admitted=self.recovery_authorizer(session,owner)
            if admitted is not None:
                # Explicit False for an enrollment identity is final; pending
                # mail/static legacy lists cannot bypass completion or proof.
                return admitted is True
        return (owner in self.allowed
                or bool(self.enrollment_authorizer and self.enrollment_authorizer(session,owner))
                or bool(self.post_change_authorizer and self.post_change_authorizer(session,owner)))

    def _reserve(self,session,event,owner,digest,purpose,now):
        if self.probe_send_guard and not self.probe_send_guard(session,event,owner,digest,purpose):
            raise HTTPException(403,'contract_probe_mail_scope_or_budget_closed')
        if not self._allowed(session,owner,purpose=purpose):
            raise HTTPException(403,'此账号尚未加入本轮邮件测试范围')
        if session.execute(text('SELECT COUNT(*) FROM account_email_send_reservations WHERE event_id=:event'),{'event':event}).scalar_one():
            raise HTTPException(409,'本次邮件已请求发送，请检查收件箱')
        if session.execute(text('SELECT COUNT(*) FROM account_email_send_reservations')).scalar_one()>=self.total:
            raise HTTPException(429,'本轮邮件测试额度已用完')
        if session.execute(text('SELECT COUNT(*) FROM account_email_send_reservations WHERE owner=:owner AND reserved_at>:cutoff'),{'owner':owner,'cutoff':now-timedelta(seconds=60)}).scalar_one():
            raise HTTPException(429,'请在一分钟后再请求邮件')
        session.execute(text('INSERT INTO account_email_send_reservations(event_id,owner,email_digest,purpose,reserved_at) VALUES(:event,:owner,:digest,:purpose,:at)'),{'event':event,'owner':owner,'digest':digest,'purpose':purpose,'at':now})

    def start(self,owner):
        if not self.ready():
            raise HTTPException(503,'邮箱验证邮件尚未接入完成，请稍后重试')
        challenge=str(uuid4());token=f'{secrets.randbelow(1000000):06d}'
        now=datetime.fromtimestamp(self.clock(),timezone.utc)
        try:
            with self.factory.begin() as session:
                self._lock(session)
                email,digest=self._user(session,owner)
                if self._proof(session,owner,digest):
                    raise HTTPException(409,'此邮箱已验证，无需重复验证')
                self._reserve(session,'verification-'+challenge,owner,digest,'verification',now)
                code=self._digest('code',owner,digest,challenge,token)
                session.execute(text('INSERT INTO account_email_challenges(owner,challenge_id,email_digest,code_digest,attempts,expires_at) VALUES(:owner,:challenge,:digest,:code,0,:expiry) ON CONFLICT(owner) DO UPDATE SET challenge_id=EXCLUDED.challenge_id,email_digest=EXCLUDED.email_digest,code_digest=EXCLUDED.code_digest,attempts=0,expires_at=EXCLUDED.expires_at'),{'owner':owner,'challenge':challenge,'digest':digest,'code':code,'expiry':now+timedelta(seconds=300)})
        except HTTPException:
            raise
        except Exception:
            raise HTTPException(503,'邮箱验证尚未开始，请稍后重试') from None
        # Commit before SMTP. Retain both quota and a usable challenge if the
        # response is uncertain; status also recovers its ID after App restart.
        try:
            self.delivery.send(email,token,'verification')
            sent=True
        except Exception:
            sent=False
        return {'owner':owner,'challenge':challenge,'sent':sent,'delivery':'accepted' if sent else 'unknown',
                'expiresIn':300,'retryAfter':60}

    def verify(self,owner,challenge,token):
        if not self.ready():
            raise HTTPException(503,'邮箱安全验证尚未接入完成')
        now=datetime.fromtimestamp(self.clock(),timezone.utc)
        rejected=None
        try:
            with self.factory.begin() as session:
                self._lock(session)
                _,digest=self._user(session,owner)
                if not self._allowed(session,owner):
                    raise HTTPException(403,'此账号尚未加入本轮邮件测试范围')
                row=session.execute(text('SELECT challenge_id,email_digest,code_digest,attempts,expires_at FROM account_email_challenges WHERE owner=:owner'),{'owner':owner}).mappings().one_or_none()
                if (not row or row['challenge_id']!=str(challenge) or row['email_digest']!=digest
                        or not row['code_digest'] or row['expires_at']<=now or row['attempts']>=5):
                    raise HTTPException(403,'验证码无效或已过期，请重新请求邮件')
                matched=hmac.compare_digest(row['code_digest'],self._digest('code',owner,digest,str(challenge),token))
                session.execute(text('UPDATE account_email_challenges SET attempts=attempts+1 WHERE owner=:owner'),{'owner':owner})
                if not matched:
                    rejected=HTTPException(403,'验证码无效或已过期，请重新核对')
                else:
                    session.execute(text('INSERT INTO account_email_proofs(owner,email_digest,verified_at) VALUES(:owner,:digest,:at) ON CONFLICT(owner) DO UPDATE SET email_digest=EXCLUDED.email_digest,verified_at=EXCLUDED.verified_at'),{'owner':owner,'digest':digest,'at':now})
                    session.execute(text("UPDATE account_email_challenges SET code_digest='' WHERE owner=:owner"),{'owner':owner})
            # Wrong attempts must commit. Raising inside begin() rolls them back.
            if rejected:
                raise rejected
            return {'owner':owner,'emailVerified':True}
        except HTTPException:
            raise
        except Exception:
            raise HTTPException(503,'邮箱验证结果暂时无法核对，请重新连接') from None

    def recovery(self,event,user,token):
        return self._native_mail(event,user,token,'recovery')

    def login(self,event,user,token):
        if (not isinstance(user,dict) or user.get('is_anonymous') is not False
                or not canonical_mainland_phone(user.get('phone'))
                or not isinstance(token,str) or not re.fullmatch(r'[0-9]{8}',token)):
            raise HTTPException(403,'请使用原已验证邮箱登录，或使用已验证手机')
        return self._native_mail(event,user,token,'login')

    def _native_mail(self,event,user,token,purpose):
        if (not self.ready() or not isinstance(event,str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,100}',event)
                or not isinstance(user,dict) or not isinstance(token,str) or not re.fullmatch(r'[0-9]{6,10}',token)):
            raise HTTPException(403,'邮箱登录或找回尚未开放，请使用已验证手机')
        owner=user.get('id')
        try:
            now=datetime.fromtimestamp(self.clock(),timezone.utc)
            with self.factory.begin() as session:
                self._lock(session)
                email,digest=self._user(session,owner)
                if canonical_email(user.get('email'))!=email or not self._proof(session,owner,digest):
                    raise HTTPException(403,'请先在账号安全验证此邮箱，或使用已验证手机找回')
                # Login shares the existing proved-email recovery admission,
                # ceiling and cooldown. It neither creates an enrollment nor
                # consumes a new, independently reset quota.
                self._reserve(session,event,owner,digest,'recovery',now)
            self.delivery.send(email,token,purpose)
        except HTTPException:
            raise
        except Exception:
            raise HTTPException(503,'登录邮件发送未能确认，请检查收件箱，勿立即重发' if purpose=='login' else '找回邮件发送未能确认，请检查收件箱后重试') from None


def create_email_security_router(store):
    router=APIRouter(prefix='/api/auth/email-security')

    @router.get('/status')
    def status(owner=Depends(authenticated_user_id)):
        return store.status(owner)

    @router.post('/start')
    def start(body:EmptyEmailStart,owner=Depends(authenticated_user_id)):
        return store.start(owner)

    @router.post('/verify')
    def verify(body:EmailProof,owner=Depends(authenticated_user_id)):
        return store.verify(owner,str(body.challenge),body.token)

    return router
