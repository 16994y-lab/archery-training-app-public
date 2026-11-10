"""Signed pre-create receipts + real-session completion. No Auth calls or DDL.

The signed Hook records an attempted future UID; only a later live Auth session
can seal it. The Auth service and this business transaction are NOT atomic.
"""
from datetime import datetime, timezone
from contextlib import contextmanager
from functools import wraps
import hashlib
import hmac
import re
from uuid import UUID, uuid4
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool
from sqlalchemy import func, select, text

from app.sms_hook import canonical_mainland_phone
from app.team_workspace import _transaction, team_actor, _TeamRoute
from app.rewards_models import RewardSource
from app.registration_models import RegistrationIntent, RegistrationReceipt, RegistrationPair

CAP = re.compile(r'^[A-Za-z0-9_-]{43}$')
CODE = re.compile(r'^[A-Za-z0-9_-]{32}$')
EVENT = re.compile(r'^[A-Za-z0-9_-]{1,100}$')


def fail(status=409):
    raise HTTPException(status, '注册奖励状态暂无法确认，请读取原进度；不要重复提交')


def uid(value):
    try:
        if not isinstance(value, str) or str(UUID(value)) != value:
            fail(422)
    except (TypeError, ValueError, AttributeError):
        fail(422)
    return value


def safe(fn):
    @wraps(fn)
    def wrapped(*args, **kwargs):
        try:
            return fn(*args, **kwargs)
        except HTTPException:
            raise
        except Exception:
            fail(503)
    return wrapped


class RegistrationRewards:
    def __init__(self, rewards, registration_key, *, enabled=False, local_directory=None):
        self.rewards, self.enabled = rewards, enabled is True
        self.key = hmac.digest(registration_key.encode(), b'gxj/registration-rewards/v1', 'sha256') if isinstance(registration_key, str) and len(registration_key.encode()) >= 32 else b''
        self.local_directory = local_directory

    @property
    def service(self):
        return self.rewards.service

    def _ready(self, write=True):
        url = urlparse(self.service)
        if not self.key or not self.rewards.enabled or not self.rewards.secret or url.scheme != 'https' or not url.netloc or url.path or url.query or url.fragment or url.username:
            fail(503)
        if write and (not self.enabled or not self.rewards.writes_enabled):
            fail(503)

    @contextmanager
    def _hook_transaction(self, *, write=True):
        """Unauthenticated prepare / signed Hook, same guarded business connection."""
        self._ready(write=write)
        with _transaction(self.rewards.factory) as db:
            if db.get_bind().dialect.name == 'postgresql':
                if self.local_directory is not None or self.rewards.test_directory is not None:
                    fail(503)
                from app.rewards_installation import assert_rewards_ready
                assert_rewards_ready(db, self.rewards.runtime_role, verified_runtime_roles=self.rewards.verified_runtime_roles)
            elif db.get_bind().dialect.name != 'sqlite' or self.local_directory is None or self.rewards.test_directory is None:
                fail(503)
            yield db

    def _digest(self, purpose, value):
        return hmac.new(self.key, purpose.encode()+b'\0'+value.encode(), hashlib.sha256).hexdigest()

    def _now(self):
        return int(self.rewards.now().timestamp())

    def _user(self, db, owner):
        if db.get_bind().dialect.name == 'postgresql':
            # Never permit the synthetic directory to override production facts.
            if self.local_directory is not None:
                fail(503)
            return db.execute(text('SELECT id::text AS id,phone,phone_confirmed_at,is_anonymous,banned_until,deleted_at FROM auth.users WHERE id=CAST(:owner AS uuid)'), {'owner': uid(owner)}).mappings().one_or_none()
        if db.get_bind().dialect.name == 'sqlite' and self.local_directory is not None:
            return self.local_directory.user(db, owner)
        fail(503)

    def _verified_phone(self, db, owner):
        user = self._user(db, owner)
        phone = canonical_mainland_phone(user.get('phone')) if user else None
        if not user or user.get('is_anonymous') is not False or user.get('deleted_at') or not phone or not user.get('phone_confirmed_at'):
            return None
        banned = user.get('banned_until')
        if banned and (datetime.fromisoformat(banned) if isinstance(banned, str) else banned) > self.rewards.now():
            return None
        return self._digest('phone', phone)

    def _receipt(self, db, owner):
        return db.scalar(select(RegistrationReceipt).where(RegistrationReceipt.service == self.service, RegistrationReceipt.user_id == owner))

    def _status(self, owner, receipt):
        return {'owner': owner, 'service': self.service, 'state': receipt.state if receipt else 'existing_or_unproven', 'registrationId': receipt.registration_id if receipt else None, 'revision': receipt.revision if receipt else 0}

    def _resume_bound_intent(self, db, intent, owner, phone, phone_hash):
        """Continue an orphan signup only behind the existing Auth commit fence.

        Auth and the Hook are separate transactions. A valid choice already
        bound by an earlier Hook remains that choice after Auth failed to commit.
        """
        if not intent or intent.state != 'bound' or not intent.registration_id:
            return False
        if db.get_bind().dialect.name == 'postgresql':
            from app.account_auth import _LOCK, _SIGNUP_COMMIT_CATALOG, _SIGNUP_COMMIT_SOURCE_SHA256
            # Keep the surrounding private transaction's stricter timeouts.
            db.execute(text('SELECT pg_advisory_xact_lock(:key)'), {'key': _LOCK})
            if db.execute(text("SELECT current_setting('transaction_isolation')")).scalar_one() != 'read committed':
                fail(503)
            if db.execute(text(_SIGNUP_COMMIT_CATALOG), {'source_sha': _SIGNUP_COMMIT_SOURCE_SHA256}).scalar_one() is not True:
                fail(503)
            # Bootstrap supplies this same SMS phone-hash key to RewardsWorkspace.
            # This is the claim digest, not the domain-separated invitation digest.
            claim_digest = hmac.new(self.rewards.secret, phone.encode('ascii'), hashlib.sha256).hexdigest()
            claim = db.execute(text('SELECT owner::text AS owner,state FROM public.phone_binding_claims WHERE phone_digest=:digest FOR UPDATE'), {'digest': claim_digest}).mappings().one_or_none()
            if not claim or claim['owner'] != owner or claim['state'] != 'pending':
                return False
        elif db.get_bind().dialect.name == 'sqlite' and self.local_directory is not None:
            can_resume = getattr(self.local_directory, 'can_resume_signup', None)
            if can_resume is None or not can_resume(db, phone, owner):
                return False
        else:
            fail(503)
        old = db.get(RegistrationReceipt, intent.registration_id)
        if (not old or old.service != self.service or old.user_id == owner
            or old.state != 'pending' or old.intent_id != intent.request_id
            or old.phone_digest != phone_hash or intent.phone_digest != phone_hash
            or old.invitation_digest != intent.invitation_digest
            or db.get(RegistrationPair, old.registration_id) is not None
            or self._user(db, old.user_id) is not None or self._user(db, owner) is not None):
            return False
        # Preserve the old attempt. The PHONE fence prevents its late Auth insert;
        # a repeated old Hook must not revive it either.
        old.state, old.completed_at, old.revision = 'revoked', self._now(), old.revision+1
        return True

    @safe
    def prepare(self, request_id, capability, phone, invitation_code):
        self._ready(); uid(request_id)
        normalized = canonical_mainland_phone(phone)
        if not normalized or not isinstance(capability, str) or not CAP.fullmatch(capability) or not isinstance(invitation_code, str) or not CODE.fullmatch(invitation_code):
            fail(422)
        cap_hash, phone_hash = self._digest('capability', capability), self._digest('phone', normalized)
        code_hash = self.rewards._invitation_digest(invitation_code)
        with self._hook_transaction() as db:
            old = db.get(RegistrationIntent, request_id)
            if old:
                # Never interpret replay as a fresh write allowance. Read with the original capability.
                fail(409)
            now = self._now()
            recent = select(RegistrationIntent).where(RegistrationIntent.service == self.service, RegistrationIntent.created_at > now-900)
            count = db.scalar(select(func.count()).select_from(recent.where(RegistrationIntent.phone_digest == phone_hash).subquery()))
            global_count = db.scalar(select(func.count()).select_from(recent.subquery()))
            if count >= 5 or global_count >= 200:
                fail(429)
            # No inviter lookup/oracle here. Eligibility is read under the completing transaction.
            db.add(RegistrationIntent(request_id=request_id, service=self.service, capability_digest=cap_hash, phone_digest=phone_hash, invitation_digest=code_hash, state='prepared', created_at=now, expires_at=now+1800))
        return {'requestId': request_id, 'state': 'prepared'}

    @safe
    def read_prepare(self, request_id, capability):
        self._ready(write=False); uid(request_id)
        if not isinstance(capability, str) or not CAP.fullmatch(capability):
            fail(422)
        with self._hook_transaction(write=False) as db:
            row = db.get(RegistrationIntent, request_id)
            if not row or row.service != self.service or not hmac.compare_digest(row.capability_digest, self._digest('capability', capability)):
                return {'requestId': request_id, 'state': 'not_found'}
            return {'requestId': request_id, 'state': 'expired' if row.state == 'prepared' and row.expires_at <= self._now() else row.state}

    @safe
    def before_create(self, event_id, user):
        """Internal call ONLY after signature + original signup policy succeeds."""
        self._ready()
        if not isinstance(user, dict) or not isinstance(event_id, str) or not EVENT.fullmatch(event_id):
            fail(422)
        owner = uid(user.get('id')); phone = canonical_mainland_phone(user.get('phone'))
        if not phone or user.get('is_anonymous', False) is not False or user.get('app_metadata', {}).get('provider') != 'phone':
            fail(422)
        phone_hash, event_hash = self._digest('phone', phone), self._digest('hook-event', event_id)
        metadata = user.get('user_metadata')
        nonce = metadata.get('gxj_reward_registration') if isinstance(metadata, dict) else None
        with self._hook_transaction() as db:
            old = self._receipt(db, owner)
            if old:
                if old.state == 'revoked' or old.hook_event_digest != event_hash or old.phone_digest != phone_hash:
                    fail(409)
                return
            # The prerequisite separating a new UID from old-account OTP/login.
            if self._user(db, owner) is not None:
                fail(409)
            now, registration_id = self._now(), str(uuid4())
            intent = db.scalar(select(RegistrationIntent).where(RegistrationIntent.service == self.service, RegistrationIntent.capability_digest == self._digest('capability', nonce))) if isinstance(nonce, str) and CAP.fullmatch(nonce) else None
            bound = bool(intent and intent.state == 'prepared' and intent.expires_at > now and hmac.compare_digest(intent.phone_digest, phone_hash))
            if not bound and intent and intent.state == 'bound':
                bound = self._resume_bound_intent(db, intent, owner, phone, phone_hash)
            # Choosing an invitation must not silently become an uninvited signup.
            # No metadata key is the only ordinary registration-without-invite path.
            if isinstance(metadata, dict) and 'gxj_reward_registration' in metadata and not bound:
                fail(409)
            receipt = RegistrationReceipt(registration_id=registration_id, service=self.service, user_id=owner, phone_digest=phone_hash, hook_event_digest=event_hash, invitation_digest=intent.invitation_digest if bound else '', intent_id=intent.request_id if bound else None, state='pending', revision=1, created_at=now)
            db.add(receipt)
            if bound:
                intent.state, intent.registration_id = 'bound', registration_id

    @safe
    def status(self, actor):
        self._ready(write=False)
        with self.rewards.transaction(actor, write=False) as db:
            return self._status(str(actor), self._receipt(db, str(actor)))

    def _legacy_inviter(self, db, digest):
        if db.get_bind().dialect.name == 'postgresql':
            return db.execute(text('SELECT owner::text FROM public.account_invitation_codes WHERE code_digest=:digest'), {'digest': digest}).scalar_one_or_none()
        if self.local_directory is not None:
            return self.local_directory.inviter(db, digest)
        fail(503)

    def _attribute(self, db, invitee, inviter):
        if db.get_bind().dialect.name != 'postgresql':
            if self.local_directory is None:
                fail(503)
            return self.local_directory.attribute(db, invitee, inviter)
        if db.execute(text('SELECT EXISTS(SELECT 1 FROM public.account_invitation_attributions WHERE invitee=CAST(:owner AS uuid))'), {'owner': invitee}).scalar_one():
            return False  # Old relation is NOT a new reward source.
        graph = db.execute(text('''WITH RECURSIVE chain(node,path,cycle,depth) AS (
          SELECT CAST(:inviter AS uuid),ARRAY[CAST(:inviter AS uuid)],false,0
          UNION ALL SELECT e.inviter,c.path||e.inviter,e.inviter=ANY(c.path),c.depth+1
          FROM public.account_invitation_attributions e JOIN chain c ON e.invitee=c.node
          WHERE NOT c.cycle AND c.depth<1000)
          SELECT bool_or(node=CAST(:invitee AS uuid)) AS reaches_owner,bool_or(cycle) AS cycle,max(depth)>=1000 AS deep FROM chain'''), {'inviter': inviter, 'invitee': invitee}).mappings().one()
        if graph['reaches_owner'] or graph['cycle'] or graph['deep']:
            return False
        db.execute(text('INSERT INTO public.account_invitation_attributions(invitee,inviter,created_at) VALUES(CAST(:invitee AS uuid),CAST(:inviter AS uuid),:at)'), {'invitee': invitee, 'inviter': inviter, 'at': self.rewards.now()})
        return True

    @safe
    def complete(self, actor, registration_id):
        self._ready(); uid(registration_id)
        with self.rewards.transaction(actor) as db:
            self.rewards._invite_lock(db)
            owner = str(actor); receipt = self._receipt(db, owner)
            if not receipt or receipt.registration_id != registration_id:
                fail(409)
            if receipt.state != 'pending':
                fail(409)  # Caller must read the durable result, not replay writes.
            actual_phone = self._verified_phone(db, owner)
            if not actual_phone or not hmac.compare_digest(actual_phone, receipt.phone_digest):
                fail(403)
            self.rewards.ensure_identity(db, owner)
            state = 'registered_without_invite'
            if receipt.invitation_digest:
                inviter = self._legacy_inviter(db, receipt.invitation_digest)
                inviter_phone = self._verified_phone(db, inviter) if inviter and inviter != owner else None
                if not inviter_phone or hmac.compare_digest(inviter_phone, actual_phone) or not self._attribute(db, owner, inviter):
                    state = 'unavailable'
                else:
                    self.rewards.ensure_identity(db, inviter)
                    source_a = self.rewards._grant_source(db, inviter, 'invite', 'invitation', registration_id+'/inviter', owner)
                    source_b = self.rewards._grant_source(db, owner, 'invite', 'invitation', registration_id+'/invitee', owner)
                    if not source_a.active or not source_b.active:
                        fail(409)
                    db.add(RegistrationPair(registration_id=registration_id, service=self.service, inviter_id=inviter, invitee_id=owner, inviter_source_id=source_a.id, invitee_source_id=source_b.id, state='active', version=1))
                    state = 'awarded'
            receipt.state, receipt.completed_at, receipt.revision = state, self._now(), receipt.revision+1
            from app.operations_telemetry import record_business_result
            record_business_result(db, 'registration', owner, registration_id,
                'failure' if state == 'unavailable' else 'success', state, self.rewards.stamp())
            return self._status(owner, receipt)

    def revoke_pair(self, db, source, actor):
        """Same transaction callback for admin source revocation; no single-side withdrawal."""
        pair = db.scalar(select(RegistrationPair).where(RegistrationPair.service == self.service, (RegistrationPair.inviter_source_id == source.id) | (RegistrationPair.invitee_source_id == source.id)))
        if not pair:
            fail(409)
        receipt = db.get(RegistrationReceipt, pair.registration_id)
        if not receipt or pair.state != 'active':
            fail(409)
        for source_id in (pair.inviter_source_id, pair.invitee_source_id):
            linked = db.get(RewardSource, source_id)
            if not linked or not linked.active:
                fail(409)
            self.rewards._revoke_source(db, linked, actor)
        pair.state, pair.version = 'revoked', pair.version+1
        receipt.state, receipt.revision = 'revoked', receipt.revision+1

    @safe
    def cancel_pending(self, actor, registration_id):
        """Protected admin correction before attribution; tombstone prevents late completion."""
        self._ready(); uid(registration_id)
        with self.rewards.transaction(actor) as db:
            self.rewards._admin(db, actor)
            row = db.get(RegistrationReceipt, registration_id)
            if not row or row.service != self.service or row.state != 'pending':
                fail(409)
            row.state, row.revision = 'revoked', row.revision+1
            return self._status(row.user_id, row)


async def _body(request, fields):
    if request.url.query or request.headers.get('content-type', '').split(';')[0].strip().lower() != 'application/json':
        fail(422)
    raw = bytearray()
    async for piece in request.stream():
        raw.extend(piece)
        if len(raw) > 2048:
            fail(413)
    try:
        import json
        def unique(pairs):
            result = {}
            for key, value in pairs:
                if key in result: fail(422)
                result[key] = value
            return result
        def reject_constant(_): fail(422)
        value = json.loads(raw, object_pairs_hook=unique, parse_constant=reject_constant)
        if not isinstance(value, dict) or set(value) != set(fields):
            fail(422)
        return value
    except (ValueError, UnicodeError, RecursionError):
        fail(422)


def create_registration_rewards_router(store):
    router = APIRouter(route_class=_TeamRoute)
    reply = lambda value: JSONResponse(value, headers={'Cache-Control': 'no-store', 'Pragma': 'no-cache'})

    @router.post('/api/auth/registration-rewards/prepare')
    async def prepare(request: Request):
        body = await _body(request, ('requestId', 'capability', 'phone', 'invitationCode'))
        return reply(await run_in_threadpool(store.prepare, body['requestId'], body['capability'], body['phone'], body['invitationCode']))

    @router.post('/api/auth/registration-rewards/read')
    async def read(request: Request):
        body = await _body(request, ('requestId', 'capability'))
        return reply(await run_in_threadpool(store.read_prepare, body['requestId'], body['capability']))

    @router.get('/api/team/registration/me')
    async def status(request: Request, actor=Depends(team_actor)):
        if request.url.query or request.headers.get('content-length', '0') != '0' or request.headers.get('transfer-encoding'):
            fail(422)
        return reply(await run_in_threadpool(store.status, actor))

    @router.post('/api/team/registration/complete')
    async def complete(request: Request, actor=Depends(team_actor)):
        body = await _body(request, ('registrationId',))
        return reply(await run_in_threadpool(store.complete, actor, body['registrationId']))

    return router
