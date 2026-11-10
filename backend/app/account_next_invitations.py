"""Actual PostgreSQL invitation-store candidate; not registered or deployed.

Reuses the existing PostgresAccountStore native-user and phone canonicalization
rules. New table + HTTP entry authorization and actual PostgreSQL acceptance are
required. No signup, mail, SMS, Admin API or metadata-based authorization.
"""
from __future__ import annotations
import hashlib
import hmac
import re
import secrets
import time
from datetime import datetime, timezone
from uuid import UUID
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import text
from app.auth import authenticated_user_id
from app.sms_hook import canonical_mainland_phone
from app.account_next_compat import FeatureScope, admit, schema_revision, REVISION

INVITE_LOCK = 621662560617157764


class Empty(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)


class InviteAttribution(Empty):
    code: str = Field(pattern=r'^[A-Za-z0-9_-]{32}$')


class PostgresInvitations:
    def __init__(self, account_store, key, allowed_owners=(), clock=time.time,
                 generate=lambda: secrets.token_urlsafe(24), *, enabled=False,
                 email_security=None, enrollment_test_digests=()):
        self.accounts, self.factory = account_store, account_store.factory
        self.clock, self.generate = clock, generate
        self.enabled, self.email = enabled is True, email_security
        self.scope = FeatureScope(tuple(allowed_owners), tuple(enrollment_test_digests))
        self.key = hmac.digest(key.encode(), b'gongxingji/invitation/v1', 'sha256') if isinstance(key, str) and len(key.encode()) >= 32 else b''
        # FeatureScope is the sole validator, including the COMBINED count,
        # duplicate UID and digest format. Never reconstruct legacy authority
        # from the raw input after scope validation has failed.
        self.allowed = self.scope.owners

    def _ready(self, owner, *, action=True):
        if not self.key or not self.email or not (self.allowed or self.scope.enrollment_digests) or (action and not self.enabled):
            raise HTTPException(503, '邀请功能尚未开放')

    def _locks(self, session):
        self.accounts._lock(session)
        self.email._lock(session)
        self._lock(session)
        if schema_revision(session) != REVISION:
            raise HTTPException(503, '邀请存储尚未就绪')

    def _lock(self, session):
        if session.get_bind().dialect.name != 'postgresql':
            raise HTTPException(503, '邀请存储尚未就绪')
        session.execute(text("SET LOCAL statement_timeout='1000ms'"))
        session.execute(text("SET LOCAL lock_timeout='400ms'"))
        session.execute(text('SELECT pg_advisory_xact_lock(:key)'), {'key': INVITE_LOCK})

    def _eligible(self, session, owner):
        user = self.accounts._user(session, owner)
        # Pure same-session enrollment admission under PHONE -> EMAIL -> INVITE.
        admit(session, owner, user, self.scope, legacy_owners=self.allowed)
        if not user['phone_confirmed_at'] or not canonical_mainland_phone(user['phone']):
            raise HTTPException(403, '完成此账号的手机验证后，可选择填写或分享邀请码')

    def _hash(self, code):
        return hmac.new(self.key, code.encode(), hashlib.sha256).hexdigest()

    def status(self, owner):
        self._ready(owner, action=False)
        try:
            with self.factory.begin() as session:
                self._locks(session)
                self._eligible(session, owner)
                row = session.execute(text('SELECT code FROM public.account_invitation_codes WHERE owner=CAST(:owner AS uuid)'), {'owner': owner}).mappings().one_or_none()
                attributed = session.execute(text('SELECT EXISTS(SELECT 1 FROM public.account_invitation_attributions WHERE invitee=CAST(:owner AS uuid))'), {'owner': owner}).scalar_one()
            return {'owner': owner, 'code': row['code'] if row else None, 'attributed': bool(attributed)}
        except HTTPException:
            raise
        except Exception:
            raise HTTPException(503, '邀请状态暂时无法核对') from None

    def create(self, owner):
        self._ready(owner)
        try:
            with self.factory.begin() as session:
                self._locks(session)
                self._eligible(session, owner)
                row = session.execute(text('SELECT code FROM public.account_invitation_codes WHERE owner=CAST(:owner AS uuid)'), {'owner': owner}).mappings().one_or_none()
                if row:
                    return {'owner': owner, 'code': row['code']}
                for _ in range(5):
                    code = self.generate()
                    if not isinstance(code, str) or not re.fullmatch(r'[A-Za-z0-9_-]{32}', code):
                        raise HTTPException(503, '邀请码生成暂不可用')
                    digest = self._hash(code)
                    exists = session.execute(text('SELECT EXISTS(SELECT 1 FROM public.account_invitation_codes WHERE code_digest=:digest)'), {'digest': digest}).scalar_one()
                    if exists:
                        continue
                    session.execute(text('INSERT INTO public.account_invitation_codes(owner,code,code_digest,created_at) VALUES(CAST(:owner AS uuid),:code,:digest,:at)'),
                        {'owner': owner, 'code': code, 'digest': digest, 'at': datetime.fromtimestamp(self.clock(), timezone.utc)})
                    return {'owner': owner, 'code': code}
                raise HTTPException(503, '邀请码生成暂不可用')
        except HTTPException:
            raise
        except Exception:
            raise HTTPException(503, '邀请请求结果暂无法核对，请先读取状态') from None

    def attribute(self, owner, code):
        self._ready(owner)
        if not isinstance(code, str) or not re.fullmatch(r'[A-Za-z0-9_-]{32}', code):
            raise HTTPException(422, '请输入有效的邀请码')
        try:
            with self.factory.begin() as session:
                self._locks(session)
                self._eligible(session, owner)
                inviter = session.execute(text('SELECT owner::text AS owner FROM public.account_invitation_codes WHERE code_digest=:digest'), {'digest': self._hash(code)}).scalar_one_or_none()
                if not inviter or inviter == owner:
                    raise HTTPException(409, '此邀请码不可用于当前账号')
                self._eligible(session, inviter)
                prior = session.execute(text('SELECT inviter::text FROM public.account_invitation_attributions WHERE invitee=CAST(:owner AS uuid)'), {'owner': owner}).scalar_one_or_none()
                if prior:
                    if prior == inviter:
                        return {'owner': owner, 'attributed': True, 'replayed': True}
                    raise HTTPException(409, '此账号已记录邀请来源，不能重复归因')
                # The same advisory lock serializes all graph writes, including
                # reverse A->B/B->A transactions. Bound corrupted/huge chains.
                graph = session.execute(text('''WITH RECURSIVE invitation_chain(node,path,cycle,depth) AS (
                    SELECT CAST(:inviter AS uuid), ARRAY[CAST(:inviter AS uuid)], false, 0
                    UNION ALL
                    SELECT e.inviter, c.path || e.inviter, e.inviter=ANY(c.path), c.depth+1
                    FROM public.account_invitation_attributions e
                    JOIN invitation_chain c ON e.invitee=c.node
                    WHERE NOT c.cycle AND c.depth<1000
                ) SELECT bool_or(node=CAST(:owner AS uuid)) AS reaches_owner,
                    bool_or(cycle) AS has_cycle, max(depth)>=1000 AS too_deep
                  FROM invitation_chain'''), {'owner': owner, 'inviter': inviter}).mappings().one_or_none()
                if not graph or graph['reaches_owner'] or graph['has_cycle'] or graph['too_deep']:
                    raise HTTPException(409, '此邀请码会形成循环，未记录邀请来源')
                session.execute(text('INSERT INTO public.account_invitation_attributions(invitee,inviter,created_at) VALUES(CAST(:owner AS uuid),CAST(:inviter AS uuid),:at)'),
                    {'owner': owner, 'inviter': inviter, 'at': datetime.fromtimestamp(self.clock(), timezone.utc)})
            return {'owner': owner, 'attributed': True, 'replayed': False}
        except HTTPException:
            raise
        except Exception:
            raise HTTPException(503, '邀请归因结果暂无法核对，请先读取状态') from None


def create_invitations_router(store):
    router = APIRouter(prefix='/api/auth/invitations')

    @router.get('/me')
    def status(owner=Depends(authenticated_user_id)):
        return store.status(owner)

    @router.post('/me')
    def create(body: Empty, owner=Depends(authenticated_user_id)):
        return store.create(owner)

    @router.post('/attribute')
    def attribute(body: InviteAttribution, owner=Depends(authenticated_user_id)):
        return store.attribute(owner, body.code)

    return router
