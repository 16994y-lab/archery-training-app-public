"""Session-bound rewards. No startup DDL, external requests, or parameter logging."""
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
import base64
import hashlib
import hmac
import json
import os
import re
import secrets
from urllib.parse import urlparse
from uuid import uuid4

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from sqlalchemy import func, or_, select, text

from app.team_workspace import TeamWorkspace, team_actor, _TeamRoute, _uid
from app.team_workspace_projection import exact, invalid
from app.rewards_models import (RewardIdentity, RewardSource, RewardClaim, RewardRequest,
    RewardAttempt, RewardContact, RewardAudit)

POLICY = 'D122-v1'
REWARDS = {'sponsor', 'community', 'invite'}
INVITE_LOCK = 621662560617157764
_CODE = re.compile(r'[A-Za-z0-9_-]{32}')
_USER_SQL = """SELECT id::text AS user_id, phone, phone_confirmed_at,
 deleted_at, is_anonymous, banned_until FROM auth.users WHERE id=CAST(:uid AS uuid)"""


def fail(status=409):
    raise HTTPException(status, '请求状态已变化，请按原请求编号读取核对' if status == 409 else '奖励服务暂不可用')


def stamp(value):
    return value.astimezone(timezone.utc).isoformat(timespec='microseconds')


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode()


def page_args(body):
    page, limit = body['page'], body['limit']
    if type(page) is not int or type(limit) is not int or not 1 <= page <= 200 or not 1 <= limit <= 50:
        invalid()
    return page, limit


def page_result(items, page, limit):
    return {'items': items[:limit], 'page': page, 'limit': limit, 'hasMore': len(items) > limit}


def masked(phone):
    if not phone:
        return None
    phone = phone.removeprefix('+')
    if re.fullmatch(r'861\d{10}', phone):
        phone = phone[2:]
    return phone[:2] + '*' * max(3, len(phone)-6) + phone[-4:] if len(phone) > 6 else '***'


class RewardsWorkspace(TeamWorkspace):
    def __init__(self, session_factory=None, clock=None, session_verifier=None, *, enabled=False,
                 service=None, secret=None, test_directory=None, invitation_revoker=None,
                 runtime_role='postgres', verified_runtime_roles=(), writes_enabled=False):
        super().__init__(session_factory, clock, session_verifier)
        self.enabled = enabled is True
        # The outer gate defaults closed. This independent stop retains readback
        # of existing entitlements/receipts while suspending new business writes.
        self.writes_enabled = self.enabled and writes_enabled is True
        self.service = (service if service is not None else os.getenv('SUPABASE_URL', '')).rstrip('/')
        raw = secret if secret is not None else os.getenv('SMS_HOOK_PHONE_HASH_KEY', '')
        self.secret = raw.encode() if isinstance(raw, str) and len(raw.encode()) >= 32 else b''
        self.test_directory = test_directory
        self.invitation_revoker = invitation_revoker
        self.runtime_role = runtime_role
        self.verified_runtime_roles = verified_runtime_roles

    @contextmanager
    def transaction(self, actor, *, write=True):
        url = urlparse(self.service)
        if not self.enabled or not self.secret or url.scheme != 'https' or not url.netloc or url.path or url.query or url.fragment or url.username:
            fail(503)
        if write and not self.writes_enabled:
            fail(503)
        with super().transaction(actor) as db:
            if db.get_bind().dialect.name == 'postgresql':
                if self.test_directory is not None:
                    fail(503)
                from app.rewards_installation import assert_rewards_ready
                assert_rewards_ready(db, self.runtime_role, verified_runtime_roles=self.verified_runtime_roles)
            elif self.test_directory is None:
                # SQLite is only an explicit isolated test path, never production fallback.
                fail(503)
            yield db

    def _hash(self, domain, value):
        return hmac.new(self.secret, domain.encode()+b'\0'+self.service.encode()+b'\0'+value.encode(), hashlib.sha256).hexdigest()

    def _invitation_digest(self, code):
        key = hmac.digest(self.secret, b'gongxingji/invitation/v1', 'sha256')
        return hmac.new(key, code.encode(), hashlib.sha256).hexdigest()

    @staticmethod
    def _invite_lock(db):
        if db.get_bind().dialect.name == 'postgresql':
            db.execute(text('SELECT pg_advisory_xact_lock(:key)'), {'key': INVITE_LOCK})

    def _seal(self, value, context):
        key = hmac.digest(self.secret, b'gongxingji/rewards/private-fields/v1', 'sha256')
        nonce = secrets.token_bytes(12)
        return base64.urlsafe_b64encode(nonce + AESGCM(key).encrypt(nonce, value.encode(), (self.service+'|'+context).encode())).decode()

    def _unseal(self, value, context):
        try:
            key = hmac.digest(self.secret, b'gongxingji/rewards/private-fields/v1', 'sha256')
            data = base64.urlsafe_b64decode(value)
            return AESGCM(key).decrypt(data[:12], data[12:], (self.service+'|'+context).encode()).decode()
        except Exception:
            fail(503)

    def _user(self, db, uid):
        _uid(uid)
        if db.get_bind().dialect.name == 'postgresql':
            row = db.execute(text(_USER_SQL), {'uid': uid}).mappings().one_or_none()
            if not row or row['deleted_at'] or row['is_anonymous'] or not row['phone'] or not row['phone_confirmed_at'] or (row['banned_until'] and row['banned_until'] > self.now()):
                raise HTTPException(404, '账号当前不可用于此操作')
            return {'user_id': row['user_id'], 'phone': row['phone'], 'verified': bool(row['phone_confirmed_at'])}
        row = self.test_directory.get(uid)
        if not row or not row.get('verified') or row.get('disabled'):
            raise HTTPException(404, '账号当前不可用于此操作')
        return {'user_id': uid, 'phone': row.get('phone'), 'verified': True}

    def ensure_identity(self, db, user_id):
        self._user(db, user_id)
        self._invite_lock(db)
        row = db.get(RewardIdentity, (self.service, user_id))
        if row:
            return row
        if not self.writes_enabled:
            fail(503)
        code = None
        if db.get_bind().dialect.name == 'postgresql':
            code = db.execute(text('SELECT code FROM public.account_invitation_codes WHERE owner=CAST(:owner AS uuid)'), {'owner': user_id}).scalar_one_or_none()
        if code is not None and not _CODE.fullmatch(code):
            fail(503)
        for _ in range(5):
            candidate = code or secrets.token_urlsafe(24)
            if not _CODE.fullmatch(candidate):
                fail(503)
            exists = db.scalar(select(RewardIdentity.user_id).where(RewardIdentity.service == self.service, RewardIdentity.invite_code == candidate))
            if exists:
                if code:
                    fail(503)
                continue
            if db.get_bind().dialect.name == 'postgresql' and code is None:
                digest = self._invitation_digest(candidate)
                if db.execute(text('SELECT EXISTS(SELECT 1 FROM public.account_invitation_codes WHERE code_digest=:digest)'), {'digest': digest}).scalar_one():
                    continue
                db.execute(text('INSERT INTO public.account_invitation_codes(owner,code,code_digest,created_at) VALUES(CAST(:owner AS uuid),:code,:digest,:at)'), {'owner': user_id, 'code': candidate, 'digest': digest, 'at': self.now()})
            row = RewardIdentity(service=self.service, user_id=user_id, invite_code=candidate, revision=0)
            db.add(row); db.flush()
            return row
        fail(503)

    def _audit_reward(self, db, actor, action, subject, version):
        db.add(RewardAudit(id=str(uuid4()), service=self.service, actor_id=str(actor), action=action, subject_id=subject, version=version, at=self.stamp(), reason=db.info.get("reward_reason", "")))

    def _grant_source(self, db, user_id, reward, kind, source_key, actor, details=None):
        if not self.enabled or not self.writes_enabled: fail(503)
        if reward not in REWARDS or {'donation': 'sponsor', 'community': 'community', 'invitation': 'invite'}.get(kind) != reward or not isinstance(source_key, str) or not 1 <= len(source_key) <= 160:
            invalid()
        identity = self.ensure_identity(db, user_id)
        old = db.scalar(select(RewardSource).where(RewardSource.service == self.service, RewardSource.kind == kind, RewardSource.source_key == source_key))
        if old:
            if old.user_id != user_id or old.reward != reward:
                fail()
            # Tombstone never reactivated by late grant.
            return old
        row = RewardSource(id=str(uuid4()), service=self.service, user_id=user_id, reward=reward, kind=kind, source_key=source_key, active=True, version=1, created_at=self.stamp(), revoked_at=None, details=details or {})
        db.add(row); identity.revision += 1
        self._audit_reward(db, actor, 'source_granted', row.id, 1)
        db.flush()
        return row

    grant_source = _grant_source

    def _revoke_source(self, db, source, actor):
        if not self.enabled or not self.writes_enabled: fail(503)
        if source.service != self.service:
            fail()
        if source.active:
            source.active = False; source.version += 1; source.revoked_at = self.stamp()
            identity = db.get(RewardIdentity, (self.service, source.user_id))
            if identity is None: fail(503)
            identity.revision += 1
            self._audit_reward(db, actor, 'source_revoked', source.id, source.version)
        return source

    revoke_source = _revoke_source

    @staticmethod
    def _admin_body(body, fields):
        if type(body) is not dict: invalid()
        exact(body, fields | ({'reason'} if 'reason' in body else set()))
        reason = body.get('reason', '')
        if not isinstance(reason, str) or len(reason) > 500 or any(ord(c) < 32 for c in reason): invalid()

    def _request(self, db, actor, body, operation):
        db.info['reward_reason'] = body.get('reason', '')
        request_id = _uid(body['requestId'])
        existing = db.get(RewardRequest, (self.service, str(actor), request_id))
        if existing:
            # Never recreate a lost one-time response; no write replay.
            fail()
        return request_id

    def _receipt(self, db, actor, body, operation, result):
        db.add(RewardRequest(service=self.service, actor_id=str(actor), request_id=body['requestId'], operation=operation, body_digest=self._hash('request', canonical(body).decode()), result=result, created_at=self.stamp()))

    def _source(self, db, source_id):
        source = db.get(RewardSource, _uid(source_id))
        if not source or source.service != self.service:
            raise HTTPException(404, '记录不可用')
        return source

    @staticmethod
    def _version(body, row):
        if type(body['version']) is not int or body['version'] != row.version:
            fail()

    def _claim_json(self, row):
        state = 'revoked' if row.revoked_at else 'redeemed' if row.redeemed_at else 'expired' if datetime.fromisoformat(row.expires_at) <= self.now() else 'pending'
        return {'id': row.id, 'requestId': row.request_id, 'userId': row.user_id, 'state': state, 'createdAt': row.created_at, 'expiresAt': row.expires_at, 'redeemedAt': row.redeemed_at, 'version': row.version}

    def me(self, actor, params, body):
        exact(body, set())
        with self.transaction(actor, write=False) as db:
            self._user(db, str(actor))
            identity = db.get(RewardIdentity, (self.service, str(actor)))
            if identity is None and self.writes_enabled:
                identity = self.ensure_identity(db, str(actor))
            rewards = sorted(set(db.scalars(select(RewardSource.reward).where(RewardSource.service == self.service, RewardSource.user_id == str(actor), RewardSource.active.is_(True))).all()))
            return {'owner': str(actor), 'service': self.service, 'inviteCode': identity.invite_code if identity else None, 'rewards': rewards, 'revision': identity.revision if identity else 0, 'policyVersion': POLICY, 'writeReady': self.writes_enabled}

    def request_read(self, actor, params, body):
        exact(body, {'requestId', 'operation'})
        request_id = _uid(body['requestId'])
        admin = params.get('_admin', False)
        allowed = {'issue', 'revoke_claim', 'donation', 'refund', 'revoke_source', 'contact'} if admin else {'claim'}
        if body['operation'] not in allowed:
            invalid()
        with self.transaction(actor, write=False) as db:
            if admin:
                self._admin(db, actor)
            row = db.get(RewardRequest, (self.service, str(actor), request_id))
            found = row is not None and row.operation == body['operation']
            return {'found': found, 'requestId': request_id, 'operation': body['operation'], 'result': row.result if found else None}

    def issue(self, actor, params, body):
        self._admin_body(body, {'requestId', 'userId'}); uid = _uid(body['userId'])
        with self.transaction(actor) as db:
            self._admin(db, actor); self._request(db, actor, body, 'issue'); self.ensure_identity(db, uid)
            code = secrets.token_urlsafe(24); now = self.now()
            row = RewardClaim(id=str(uuid4()), service=self.service, user_id=uid, issuer_id=str(actor), request_id=body['requestId'], token_digest=self._hash('community-code', code), created_at=stamp(now), expires_at=stamp(now+timedelta(hours=12)), redeemed_at=None, revoked_at=None, source_id=None, version=1)
            db.add(row); db.flush()
            result = {'requestId': body['requestId'], 'status': 'issued', 'claim': self._claim_json(row)}
            self._receipt(db, actor, body, 'issue', result); self._audit_reward(db, actor, 'claim_issued', row.id, row.version)
            return {**result, 'code': code}

    def claim(self, actor, params, body):
        exact(body, {'requestId', 'code'}); _uid(body['requestId'])
        if not isinstance(body['code'], str) or len(body['code']) > 256:
            invalid()
        error = None
        with self.transaction(actor) as db:
            self._request(db, actor, body, 'claim'); self._user(db, str(actor))
            now = self.now()
            attempt = db.get(RewardAttempt, (self.service, str(actor)))
            if not attempt:
                attempt = RewardAttempt(service=self.service, user_id=str(actor), window_started=stamp(now), failures=0); db.add(attempt)
            elif datetime.fromisoformat(attempt.window_started)+timedelta(minutes=15) <= now:
                attempt.window_started = stamp(now); attempt.failures = 0
            if attempt.failures >= 5:
                result = {'requestId': body['requestId'], 'status': 'rate_limited'}; error = 429
            else:
                row = db.scalar(select(RewardClaim).where(RewardClaim.service == self.service, RewardClaim.token_digest == self._hash('community-code', body['code']))) if _CODE.fullmatch(body['code']) else None
                if not row or row.user_id != str(actor) or row.revoked_at or (not row.redeemed_at and datetime.fromisoformat(row.expires_at) <= now):
                    attempt.failures += 1
                    result = {'requestId': body['requestId'], 'status': 'unavailable'}; error = 400
                else:
                    if not row.redeemed_at:
                        source = self._grant_source(db, str(actor), 'community', 'community', row.id, actor)
                        row.redeemed_at = stamp(now); row.source_id = source.id; row.version += 1
                        self._audit_reward(db, actor, 'claim_redeemed', row.id, row.version)
                    result = {'requestId': body['requestId'], 'status': 'redeemed', 'claimId': row.id, 'reward': 'community', 'revision': self.ensure_identity(db, str(actor)).revision}
            self._receipt(db, actor, body, 'claim', result)
            from app.operations_telemetry import record_business_result
            record_business_result(db, 'claim', str(actor), 'claim:'+row.id if result['status']=='redeemed' else 'attempt:'+body['requestId'],
                'success' if result['status']=='redeemed' else 'failure', result['status'], self.stamp())
        # Error raised only AFTER commit: failed attempts and receipt survive restart.
        if error:
            raise HTTPException(error, '领取暂不可用，请核对后稍后再试')
        return result

    def users_search(self, actor, params, body):
        exact(body, {'query', 'page', 'limit'}); page, limit = page_args(body); query = body['query']
        if not isinstance(query, str) or not 2 <= len(query.strip()) <= 120 or any(ord(c) < 32 for c in query):
            invalid()
        query = query.strip()
        with self.transaction(actor, write=False) as db:
            self._admin(db, actor)
            if db.get_bind().dialect.name == 'postgresql':
                # No editable metadata participates in authorization. Escape LIKE wildcards.
                like = '%'+query.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_')+'%'
                rows = db.execute(text("""SELECT id::text AS user_id, phone FROM auth.users
                  WHERE deleted_at IS NULL AND is_anonymous IS FALSE AND phone_confirmed_at IS NOT NULL
                  AND (banned_until IS NULL OR banned_until<=:now)
                  AND (id::text=:query OR phone ILIKE :like ESCAPE '\\')
                  ORDER BY id LIMIT :limit OFFSET :offset"""), {'query': query, 'like': like, 'now': self.now(), 'limit': limit+1, 'offset': (page-1)*limit}).mappings().all()
            else:
                rows = [{'user_id': uid, 'phone': value.get('phone')} for uid, value in sorted(self.test_directory.items()) if value.get('verified') and not value.get('disabled') and (query == uid or query in (value.get('phone') or ''))][(page-1)*limit:page*limit+1]
            items = [{'userId': row['user_id'], 'service': self.service, 'label': '账号 '+row['user_id'][:8], 'phoneMasked': masked(row['phone'])} for row in rows]
            return page_result(items, page, limit)

    def sources_search(self, actor, params, body):
        exact(body, {'userId', 'page', 'limit'}); page, limit = page_args(body); uid = _uid(body['userId'])
        with self.transaction(actor, write=False) as db:
            self._admin(db, actor)
            rows = db.scalars(select(RewardSource).where(RewardSource.service == self.service, RewardSource.user_id == uid).order_by(RewardSource.created_at.desc(), RewardSource.id).offset((page-1)*limit).limit(limit+1)).all()
            return page_result([{'id': r.id, 'userId': r.user_id, 'reward': r.reward, 'kind': r.kind, 'active': r.active, 'version': r.version, 'createdAt': r.created_at, 'revokedAt': r.revoked_at} for r in rows], page, limit)

    def claims_search(self, actor, params, body):
        exact(body, {'query', 'userId', 'state', 'page', 'limit'}); page, limit = page_args(body)
        query = body['query']; uid = body['userId']; state = body['state']
        if query != '': _uid(query)
        if uid is not None: _uid(uid)
        if state not in {None, 'pending', 'redeemed', 'expired', 'revoked'}: invalid()
        with self.transaction(actor, write=False) as db:
            self._admin(db, actor); statement = select(RewardClaim).where(RewardClaim.service == self.service)
            if uid: statement = statement.where(RewardClaim.user_id == uid)
            if query: statement = statement.where(or_(RewardClaim.id == query, RewardClaim.request_id == query))
            if state == 'revoked': statement = statement.where(RewardClaim.revoked_at.is_not(None))
            elif state == 'redeemed': statement = statement.where(RewardClaim.revoked_at.is_(None), RewardClaim.redeemed_at.is_not(None))
            elif state in {'pending', 'expired'}:
                statement = statement.where(RewardClaim.revoked_at.is_(None), RewardClaim.redeemed_at.is_(None))
                statement = statement.where(RewardClaim.expires_at > self.stamp() if state == 'pending' else RewardClaim.expires_at <= self.stamp())
            rows = db.scalars(statement.order_by(RewardClaim.created_at.desc(), RewardClaim.id).offset((page-1)*limit).limit(limit+1)).all()
            return page_result([self._claim_json(r) for r in rows], page, limit)

    def revoke_claim(self, actor, params, body):
        self._admin_body(body, {'requestId', 'claimId', 'version'})
        with self.transaction(actor) as db:
            self._admin(db, actor); self._request(db, actor, body, 'revoke_claim')
            row = db.get(RewardClaim, _uid(body['claimId']))
            if not row or row.service != self.service: raise HTTPException(404, '记录不可用')
            self._version(body, row)
            if row.redeemed_at or row.revoked_at: fail()
            row.revoked_at = self.stamp(); row.version += 1
            result = {'requestId': body['requestId'], 'status': 'revoked', 'claim': self._claim_json(row)}
            self._receipt(db, actor, body, 'revoke_claim', result); self._audit_reward(db, actor, 'claim_revoked', row.id, row.version)
            return result

    def donation(self, actor, params, body):
        self._admin_body(body, {'requestId', 'userId', 'amount', 'evidenceRef'}); uid = _uid(body['userId'])
        amount, reference = body['amount'], body['evidenceRef']
        if not isinstance(amount, str) or len(amount) > 80 or not re.fullmatch(r'(?:0|[1-9]\d*)(?:\.\d+)?', amount) or not isinstance(reference, str) or not 1 <= len(reference.strip()) <= 120 or any(ord(c)<32 for c in reference): invalid()
        try:
            if Decimal(amount) <= 0: invalid()
        except InvalidOperation: invalid()
        with self.transaction(actor) as db:
            self._admin(db, actor); self._request(db, actor, body, 'donation')
            key = self._hash('donation-evidence', reference.strip())
            source = self._grant_source(db, uid, 'sponsor', 'donation', key, actor, {'amount': amount, 'evidence': self._seal(reference.strip(), 'donation:'+key), 'refunded': False})
            if not source.active or source.details.get('amount') != amount: fail()
            result = {'requestId': body['requestId'], 'status': 'confirmed', 'sourceId': source.id, 'reward': 'sponsor', 'revision': self.ensure_identity(db, uid).revision}
            self._receipt(db, actor, body, 'donation', result)
            return result

    def refund(self, actor, params, body):
        self._admin_body(body, {'requestId', 'sourceId', 'version'})
        with self.transaction(actor) as db:
            self._admin(db, actor); self._request(db, actor, body, 'refund'); source = self._source(db, body['sourceId']); self._version(body, source)
            if source.kind != 'donation' or not source.active: fail()
            source.details = {**source.details, 'refunded': True}; source.version += 1
            result = {'requestId': body['requestId'], 'status': 'refund_recorded', 'sourceId': source.id, 'version': source.version, 'rewardRetained': True}
            self._receipt(db, actor, body, 'refund', result); self._audit_reward(db, actor, 'refund_retained', source.id, source.version)
            return result

    def revoke_source_admin(self, actor, params, body):
        self._admin_body(body, {'requestId', 'sourceId', 'version'})
        with self.transaction(actor) as db:
            self._admin(db, actor); self._request(db, actor, body, 'revoke_source'); source = self._source(db, body['sourceId']); self._version(body, source)
            if source.kind == 'invitation' and source.details.get('counterpartyErased') is not True:
                if not self.invitation_revoker: fail(503)
                self.invitation_revoker(db, source, actor)
            else: self._revoke_source(db, source, actor)
            identity = db.get(RewardIdentity, (self.service, source.user_id))
            if identity is None: fail(503)
            result = {'requestId': body['requestId'], 'status': 'revoked', 'sourceId': source.id, 'revision': identity.revision}
            self._receipt(db, actor, body, 'revoke_source', result)
            return result

    def _contact_eligible(self, db, uid):
        return db.scalar(select(RewardClaim.id).where(RewardClaim.service == self.service, RewardClaim.user_id == uid, RewardClaim.redeemed_at.is_not(None)).limit(1)) is not None

    def admin_profile_summary(self, db, actor, uid):
        """Trusted integration helper; caller already owns active Team transaction.

        Checks admin again, binds the configured Auth service, never returns a full
        contact or commits. User/coach DTOs must never call this helper.
        """
        self._admin(db, actor); uid = _uid(uid)
        user = self._user(db, uid)
        eligible = self._contact_eligible(db, uid)
        contact = db.get(RewardContact, (self.service, uid)) if eligible else None
        qq = self._unseal(contact.qq_cipher, 'qq:'+uid) if contact else None
        qq_mask = (qq[:2]+'*'*max(3,len(qq)-4)+qq[-2:]) if qq else None
        scope = (RewardSource.service == self.service, RewardSource.user_id == uid)
        rewards = sorted(set(db.scalars(select(RewardSource.reward).where(*scope,RewardSource.active.is_(True))).all()))
        total = db.scalar(select(func.count()).select_from(RewardSource).where(*scope))
        active = db.scalar(select(func.count()).select_from(RewardSource).where(*scope,RewardSource.active.is_(True)))
        self._audit_reward(db,actor,'profile_summary_read',uid,contact.version if contact else 0)
        return {'owner':uid,'service':self.service,'phoneMasked':masked(user['phone']),
                'qqMasked':qq_mask,'rewards':rewards,'sourceCount':total,
                'activeSourceCount':active,'contactEligible':eligible}

    def contact_read(self, actor, params, body):
        exact(body, {'userId'}); uid = _uid(body['userId'])
        with self.transaction(actor, write=False) as db:
            self._admin(db, actor)
            eligible = self._contact_eligible(db, uid)
            if not eligible:
                return {'userId': uid, 'version': 0, 'qq': None, 'qqVerified': False, 'phone': None, 'phoneMasked': None, 'phoneVerified': False, 'eligible': False}
            user = self._user(db, uid); row = db.get(RewardContact, (self.service, uid))
            self._audit_reward(db, actor, 'contact_read', uid, row.version if row else 0)
            return {'userId': uid, 'version': row.version if row else 0, 'qq': self._unseal(row.qq_cipher, 'qq:'+uid) if row else None, 'qqVerified': False, 'phone': user['phone'], 'phoneMasked': masked(user['phone']), 'phoneVerified': user['verified'], 'eligible': True}

    def contact_save(self, actor, params, body):
        self._admin_body(body, {'requestId', 'userId', 'version', 'qq'}); uid = _uid(body['userId'])
        if not isinstance(body['qq'], str) or not re.fullmatch(r'[1-9]\d{4,11}', body['qq']) or type(body['version']) is not int: invalid()
        with self.transaction(actor) as db:
            self._admin(db, actor); self._request(db, actor, body, 'contact'); self._user(db, uid)
            if not self._contact_eligible(db, uid): raise HTTPException(403, '兑换完成后才可登记联系方式')
            row = db.get(RewardContact, (self.service, uid)); version = row.version if row else 0
            if body['version'] != version: fail()
            encrypted = self._seal(body['qq'], 'qq:'+uid)
            if not row:
                row = RewardContact(service=self.service, user_id=uid, qq_cipher=encrypted, version=1, updated_at=self.stamp()); db.add(row)
            else: row.qq_cipher = encrypted; row.version += 1; row.updated_at = self.stamp()
            result = {'requestId': body['requestId'], 'status': 'saved', 'userId': uid, 'version': row.version}
            self._receipt(db, actor, body, 'contact', result); self._audit_reward(db, actor, 'contact_saved', uid, row.version)
            return result


ROUTES = [
    ('/rewards/me', 'GET', 'me'), ('/rewards/claim', 'POST', 'claim'),
    ('/rewards/requests/read', 'POST', 'request_read'),
    ('/admin/rewards/users/search', 'POST', 'users_search'),
    ('/admin/rewards/sources/search', 'POST', 'sources_search'),
    ('/admin/rewards/claims/search', 'POST', 'claims_search'),
    ('/admin/rewards/claims/issue', 'POST', 'issue'),
    ('/admin/rewards/claims/revoke', 'POST', 'revoke_claim'),
    ('/admin/rewards/donations/confirm', 'POST', 'donation'),
    ('/admin/rewards/donations/refund', 'POST', 'refund'),
    ('/admin/rewards/sources/revoke', 'POST', 'revoke_source_admin'),
    ('/admin/rewards/contacts/read', 'POST', 'contact_read'),
    ('/admin/rewards/contacts/save', 'POST', 'contact_save'),
    ('/admin/rewards/requests/read', 'POST', 'request_read'),
]


async def rewards_body(request):
    if request.query_params: invalid()
    raw = bytearray()
    async for chunk in request.stream():
        raw.extend(chunk)
        if len(raw) > 16*1024: raise HTTPException(413, '请求内容过大')
    if request.method == 'GET':
        if raw: invalid()
        return {}
    if request.headers.get('content-type', '').split(';')[0].lower().strip() != 'application/json': invalid()
    def pairs(values):
        obj = {}
        for key, value in values:
            if key in obj: invalid()
            obj[key] = value
        return obj
    def constant(_): invalid()
    try: body = json.loads(raw, object_pairs_hook=pairs, parse_constant=constant)
    except (ValueError, UnicodeError, RecursionError): invalid()
    if type(body) is not dict: invalid()
    return body


def create_rewards_router(session_factory=None, clock=None, session_verifier=None, **config):
    failure_observer = config.pop('failure_observer', None)
    service = config.pop('service_instance', None) or RewardsWorkspace(session_factory, clock, session_verifier, **config)
    router = APIRouter(prefix='/api/team', tags=['rewards'], route_class=_TeamRoute)
    def endpoint(operation, admin):
        async def handle(request: Request, actor: str = Depends(team_actor)):
            body = await rewards_body(request)
            try: value = await run_in_threadpool(getattr(service, operation), actor, {'_admin': admin}, body)
            except HTTPException as error:
                if failure_observer is not None and admin:
                    await run_in_threadpool(failure_observer, actor, operation, body, error.status_code)
                raise
            except (TypeError, ValueError, KeyError, OverflowError, RecursionError): invalid()
            return JSONResponse(value, headers={'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'})
        handle.__name__ = 'rewards_'+operation+('_admin' if admin else '')
        return handle
    for path, method, operation in ROUTES:
        router.add_api_route(path, endpoint(operation, path.startswith('/admin/')), methods=[method])
    return router
