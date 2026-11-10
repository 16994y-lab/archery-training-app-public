"""First email on an existing phone account; no account merge or session switch.

Auth owns the email change. A committed, private intent gates its signed hook.
Only this intent's OTP plus a successful native verification may create proof.
Every network operation runs outside database transactions.
"""
from __future__ import annotations

import hmac
import math
import re
from datetime import datetime, timedelta, timezone
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import text

from app.account_auth import auth_upstream
from app.auth import authenticated_user_id
from app.email_delivery import canonical_email
from app.sms_hook import canonical_mainland_phone


class BindingStart(BaseModel):
    model_config = ConfigDict(extra='forbid')
    email: str = Field(min_length=3, max_length=254)


class BindingVerify(BindingStart):
    intent: UUID
    token: str = Field(pattern=r'^[0-9]{6,10}$')


class PostgresEmailBinding:
    def __init__(self, security, upstream=auth_upstream):
        self.security, self.upstream = security, upstream
        self.factory = security.factory

    def _now(self):
        return datetime.fromtimestamp(self.security.clock(), timezone.utc)

    def _ready(self, owner):
        if not self.security.ready():
            raise HTTPException(503, '绑定邮箱尚未开放')
        if owner not in self.security.allowed:
            raise HTTPException(403, '此账号尚未加入本轮邮件测试范围')

    def _user(self, session, owner):
        try:
            owner = str(UUID(owner))
        except (ValueError, TypeError, AttributeError):
            raise HTTPException(401, '请重新登录原手机账号') from None
        row = session.execute(text('SELECT id::text AS id,email,email_change,phone,phone_confirmed_at,is_anonymous FROM auth.users WHERE id=CAST(:owner AS uuid)'), {'owner': owner}).mappings().one_or_none()
        if not row or row['is_anonymous']:
            raise HTTPException(401, '请重新登录原手机账号')
        if not row['phone_confirmed_at'] or not canonical_mainland_phone(row['phone']):
            raise HTTPException(403, '请先验证此账号的中国大陆手机')
        return row

    def _row(self, session, owner):
        return session.execute(text('SELECT intent_id,email_digest,code_digest,state,attempts,created_at,expires_at FROM account_email_binding_intents WHERE owner=:owner'), {'owner': owner}).mappings().one_or_none()

    def _address(self, owner, email):
        email = canonical_email(email)
        if not email:
            raise HTTPException(422, '请输入有效的本人邮箱')
        return email, self.security._digest('address', owner, email)

    def status(self, owner):
        self._ready(owner)
        try:
            with self.factory() as session:
                user = self._user(session, owner)
                row = self._row(session, owner)
                email = canonical_email(user['email'])
                verified = bool(email and self.security._proof(session, owner, self._address(owner, email)[1]))
            remaining = max(0, math.ceil((row['expires_at'] - self._now()).total_seconds())) if row else 0
            state = ('verified' if verified else 'needs_proof') if email else (row['state'] if row and remaining else 'idle')
            return {'owner': owner, 'state': state, 'intent': row['intent_id'] if row and remaining else None,
                    'email': email, 'emailVerified': verified, 'retryAfter': remaining if not email else 0,
                    'canVerify': bool(not email and row and remaining and row['state'] in ('pending','uncertain') and row['code_digest'] and row['attempts'] < 5)}
        except HTTPException:
            raise
        except Exception:
            raise HTTPException(503, '绑定状态暂时无法核对，请重新读取') from None

    def start(self, owner, email, bearer):
        self._ready(owner)
        email, digest = self._address(owner, email)
        intent, now = str(uuid4()), self._now()
        try:
            with self.factory.begin() as session:
                self.security._lock(session)
                user = self._user(session, owner)
                if user['email'] not in (None, ''):
                    raise HTTPException(409, '此账号已有邮箱，请使用现有邮箱验证入口')
                prior = self._row(session, owner)
                if prior and prior['expires_at'] > now:
                    raise HTTPException(409, '已有绑定请求，请完成当前验证或等待五分钟后重新开始')
                occupied = session.execute(text("SELECT COUNT(*) FROM auth.users WHERE id<>CAST(:owner AS uuid) AND (lower(email)=:email OR lower(email_change)=:email)"), {'owner': owner, 'email': email}).scalar_one()
                if occupied:
                    raise HTTPException(409, '此邮箱已被使用或正在验证，请使用其他邮箱')
                session.execute(text("INSERT INTO account_email_binding_intents(owner,intent_id,email_digest,code_digest,state,attempts,created_at,expires_at) VALUES(:owner,:intent,:digest,'','requesting',0,:now,:expiry) ON CONFLICT(owner) DO UPDATE SET intent_id=EXCLUDED.intent_id,email_digest=EXCLUDED.email_digest,code_digest='',state='requesting',attempts=0,created_at=EXCLUDED.created_at,expires_at=EXCLUDED.expires_at"), {'owner': owner, 'intent': intent, 'digest': digest, 'now': now, 'expiry': now + timedelta(seconds=300)})
        except HTTPException:
            raise
        except Exception:
            raise HTTPException(503, '绑定尚未开始，请稍后重试') from None
        # The hook reads the already committed intent, not Auth's uncommitted pending field.
        try:
            result = self.upstream('/user', 'PUT', {'email': email}, bearer)
            if not isinstance(result, dict) or result.get('id') != owner:
                raise HTTPException(409, '绑定返回身份不一致，请重新读取状态')
        except Exception:
            # A timeout or hook failure may already have consumed quota. Keep the intent.
            self._uncertain(owner, intent, 'requesting')
            return {**self.status(owner), 'delivery': 'unknown'}
        state = self.status(owner)
        return {**state, 'delivery': 'accepted' if state['state'] == 'pending' else 'unknown'}

    def _uncertain(self, owner, intent, prior, attempt=None):
        try:
            with self.factory.begin() as session:
                self.security._lock(session)
                session.execute(text("UPDATE account_email_binding_intents SET state='uncertain' WHERE owner=:owner AND intent_id=:intent AND state=:prior" + (' AND attempts=:attempt' if attempt is not None else '')), {'owner': owner, 'intent': intent, 'prior': prior, 'attempt': attempt})
        except Exception:
            pass  # Never erase intent, quota or verification evidence after an uncertain result.

    def hook(self, event, user, data):
        if (not isinstance(user, dict) or not isinstance(data, dict)
                or user.get('email') not in (None, '') or data.get('email_action_type') != 'email_change'
                or not isinstance(event, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', event)):
            raise HTTPException(403, '仅支持原手机账号首次添加邮箱')
        owner = user.get('id')
        self._ready(owner)
        email, digest = self._address(owner, user.get('new_email'))
        # Official hook mapping: token_new goes to new_email. Single-token payloads
        # may instead use token. Reject two-code/old-address or ambiguous payloads.
        tokens = [v for v in (data.get('token'), data.get('token_new')) if v not in (None, '')]
        if len(tokens) != 1 or not isinstance(tokens[0], str) or not re.fullmatch(r'[0-9]{6,10}', tokens[0]) or data.get('token_hash_new') not in (None, ''):
            raise HTTPException(403, '原生绑定验证码格式尚未核实')
        token, now = tokens[0], self._now()
        try:
            with self.factory.begin() as session:
                self.security._lock(session)
                current = self._user(session, owner)
                row = self._row(session, owner)
                if (current['email'] not in (None, '') or not row or row['state'] != 'requesting'
                        or row['email_digest'] != digest or row['expires_at'] <= now):
                    raise HTTPException(403, '绑定请求不匹配或已过期')
                self.security._reserve(session, event, owner, digest, 'verification', now)
                code = self.security._digest('binding-code', owner, row['intent_id'], digest, token)
                session.execute(text("UPDATE account_email_binding_intents SET code_digest=:code,state='pending' WHERE owner=:owner AND intent_id=:intent"), {'owner': owner, 'intent': row['intent_id'], 'code': code})
            self.security.delivery.send(email, token, 'binding')
        except HTTPException:
            raise
        except Exception:
            raise HTTPException(503, '绑定邮件投递未能确认，请先检查收件箱') from None

    def verify(self, owner, intent, email, token, bearer):
        self._ready(owner)
        email, digest = self._address(owner, email)
        if not re.fullmatch(r'[0-9]{6,10}', token):
            raise HTTPException(422, '请输入邮件中的验证码')
        rejected, claimed = False, False
        try:
            with self.factory.begin() as session:
                self.security._lock(session)
                user = self._user(session, owner)
                row = self._row(session, owner)
                if (user['email'] not in (None, '') or not row or row['intent_id'] != intent
                        or row['email_digest'] != digest or row['state'] not in ('pending', 'uncertain')
                        or row['expires_at'] <= self._now() or row['attempts'] >= 5 or not row['code_digest']):
                    raise HTTPException(409, '绑定请求无效或结果待核对，请重新读取状态')
                attempt = row['attempts'] + 1
                matched = hmac.compare_digest(row['code_digest'], self.security._digest('binding-code', owner, intent, digest, token))
                session.execute(text('UPDATE account_email_binding_intents SET attempts=:attempt,state=:state WHERE owner=:owner AND intent_id=:intent'), {'owner': owner, 'intent': intent, 'attempt': attempt, 'state': 'verifying' if matched else row['state']})
                rejected = not matched
            if rejected:
                raise HTTPException(403, '验证码不正确，请核对本次邮件')
            claimed = True
            result = self.upstream('/verify', 'POST', {'email': email, 'token': token, 'type': 'email_change'}, bearer)
            user = result.get('user') if isinstance(result, dict) else None
            if (not isinstance(user, dict) or user.get('id') != owner or canonical_email(user.get('email')) != email
                    or not user.get('email_confirmed_at') or user.get('is_anonymous') is True):
                raise HTTPException(409, '原生验证结果未能核对，请重新读取状态')
            # The 0011 draft trigger preserves only the first empty->email change
            # in verifying state; subsequent changes invalidate the intent (incl. ABA).
            with self.factory.begin() as session:
                self.security._lock(session)
                current = self._user(session, owner)
                row = self._row(session, owner)
                if (canonical_email(current['email']) != email or not row or row['intent_id'] != intent
                        or row['email_digest'] != digest or row['state'] != 'verifying' or row['attempts'] != attempt
                        or row['expires_at'] <= self._now()):
                    raise HTTPException(409, '绑定状态已变化，未写入邮箱验证证明')
                session.execute(text('INSERT INTO account_email_proofs(owner,email_digest,verified_at) VALUES(:owner,:digest,:at) ON CONFLICT(owner) DO UPDATE SET email_digest=EXCLUDED.email_digest,verified_at=EXCLUDED.verified_at'), {'owner': owner, 'digest': digest, 'at': self._now()})
                session.execute(text("UPDATE account_email_binding_intents SET state='verified',code_digest='' WHERE owner=:owner AND intent_id=:intent"), {'owner': owner, 'intent': intent})
            # Do not expose or install the new native session. The client retains
            # its current phone identity and rereads it before showing completion.
            return {'owner': owner, 'email': email, 'emailVerified': True}
        except HTTPException:
            if claimed:
                self._uncertain(owner, intent, 'verifying', attempt)
            raise
        except Exception:
            if claimed:
                self._uncertain(owner, intent, 'verifying', attempt)
            raise HTTPException(503, '绑定结果暂时无法核对，请重新读取状态；不要重复请求邮件') from None


def create_email_binding_router(store):
    router = APIRouter(prefix='/api/auth/email-binding')

    @router.get('/status')
    def status(owner=Depends(authenticated_user_id)):
        return store.status(owner)

    @router.post('/start')
    def start(body: BindingStart, authorization: str | None = Header(default=None), owner=Depends(authenticated_user_id)):
        return store.start(owner, body.email, authorization)

    @router.post('/verify')
    def verify(body: BindingVerify, authorization: str | None = Header(default=None), owner=Depends(authenticated_user_id)):
        return store.verify(owner, str(body.intent), body.email, body.token, authorization)

    return router
