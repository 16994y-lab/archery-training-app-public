"""Owner-bound account deletion with durable, secret-capability readback.

No startup DDL, credential logging, arbitrary owner input, or unknown-write replay.
Storage operations use fixed server-side targets and a durable pre-dispatch marker.
"""
from contextlib import contextmanager
import base64
import hashlib
import hmac
import json
import os
import re
import time
from uuid import UUID

from fastapi import APIRouter, Header, HTTPException, Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool
from sqlalchemy import delete, select, text

from app.account_deletion_models import AccountDeletionRequest as Receipt, AccountDeletionObject as Object
from app.account_deletion_installation import require_deletion_schema

POLICY = 'account-deletion-v1'
RECENT_SECONDS = 300
COUNTS = ('trainingSessions','trainingPlans','cloudBackups','teamMemberships','teamsOwned',
          'rewardSources','rewardClaims','invitationLinks','feedbackRecords','privateMedia',
          'contributionPhotos','archiveRecords','communityRecords')


def _fail(status=503, message='注销结果尚未确认，请保留当前进度并读取原请求结果'):
    raise HTTPException(status, message, headers={'Cache-Control':'no-store','Pragma':'no-cache'})


class _NotStarted(HTTPException):
    """Internal refusal; never exposed until the transaction rolled back cleanly."""


def _uuid(value):
    try:
        if not isinstance(value, str) or str(UUID(value)) != value:
            raise ValueError()
        return value
    except (ValueError, TypeError, AttributeError):
        _fail(422, '注销请求格式未通过核对')


def _hex(value):
    return isinstance(value, str) and re.fullmatch('[0-9a-f]{64}', value) is not None


def barrier_digest(service, owner):
    return hashlib.sha256((service+'|'+owner).encode()).hexdigest()


def _cap(value):
    if not isinstance(value, str) or not re.fullmatch('[A-Za-z0-9_-]{43}', value):
        _fail(422, '注销请求格式未通过核对')
    decoded = base64.urlsafe_b64decode(value + '=')
    if len(decoded) != 32 or base64.urlsafe_b64encode(decoded).rstrip(b'=').decode() != value:
        _fail(422, '注销请求格式未通过核对')
    return value


def recent_authentication(claims, now):
    amr = claims.get('amr')
    if not isinstance(amr, list):
        return False
    return any(isinstance(a, dict) and a.get('method') in ('password', 'otp')
               and type(a.get('timestamp')) is int and 0 <= now-a['timestamp'] <= RECENT_SECONDS
               for a in amr)


def _actor(claims):
    if not isinstance(claims, dict) or claims.get('is_anonymous') is not False:
        _fail(401, '请使用原账号重新登录')
    try:
        return _uuid(claims.get('sub')), _uuid(claims.get('session_id'))
    except HTTPException:
        _fail(401, '原账号会话格式无效，请重新登录')


def _default_live(db, owner, session_id, *, lock=False):
    # Lock user first: deletion's exclusive lock coordinates with DML barriers.
    user = db.execute(text("""SELECT id FROM auth.users WHERE id=CAST(:owner AS uuid)
      AND deleted_at IS NULL AND is_anonymous IS FALSE
      AND (banned_until IS NULL OR banned_until<=now())""" + (' FOR UPDATE' if lock else '')), {'owner': owner}).first()
    active = user and db.execute(text("""SELECT EXISTS(SELECT 1 FROM auth.sessions
      WHERE id=CAST(:session AS uuid) AND user_id=CAST(:owner AS uuid)
      AND (not_after IS NULL OR not_after>now()))"""), {'owner': owner, 'session': session_id}).scalar_one()
    if not active:
        _fail(401, '原账号会话已失效，请重新登录')


def _default_auth_delete(db, owner):
    result = db.execute(text('DELETE FROM auth.users WHERE id=CAST(:owner AS uuid)'), {'owner': owner})
    if result.rowcount != 1:
        _fail()


def require_live_account_session(claims):
    """Live admission for every ordinary JWT route once deletion is enabled.

    This is admission only. The database DML barriers provide commit-race safety.
    """
    owner, session_id = _actor(claims)
    from app.db import SessionLocal
    from app.team_workspace import _require_private_transaction
    from app.auth import _supabase_url
    try:
        with SessionLocal() as db, db.begin():
            _require_private_transaction(db, factory=SessionLocal)
            require_deletion_schema(db)
            _default_live(db, owner, session_id)
            if db.scalar(select(Receipt.request_id).where(Receipt.barrier_digest == barrier_digest(_supabase_url(), owner))):
                _fail(401, '账号已进入注销，请读取原注销结果')
    except HTTPException:
        raise
    except Exception:
        _fail(503, '账号存续状态暂时无法核对')


class AccountDeletion:
    def __init__(self, factory, *, enabled=False, service=None, secret=None, clock=time.time,
                 storage=None, inspector=None, eraser=None, live=None, auth_delete=None,
                 test_mode=False):
        self.factory, self.enabled, self.clock, self.storage = factory, enabled is True, clock, storage
        self.service = (service if service is not None else os.getenv('SUPABASE_URL', '')).rstrip('/')
        raw = secret if secret is not None else os.getenv('SMS_HOOK_PHONE_HASH_KEY', '')
        self.secret = raw.encode() if isinstance(raw, str) and len(raw.encode()) >= 32 else b''
        self.inspector, self.eraser, self.live = inspector, eraser, live or _default_live
        self.auth_delete, self.test_mode = auth_delete or _default_auth_delete, test_mode is True

    def ready(self):
        if not self.secret or not re.fullmatch(r'https://[a-zA-Z0-9.-]+', self.service):
            _fail(503, '账号注销服务尚未安全接通')

    def digest(self, domain, value):
        return hmac.new(self.secret, (POLICY+'\0'+domain+'\0'+self.service+'\0'+value).encode(), hashlib.sha256).hexdigest()

    @contextmanager
    def transaction(self):
        self.ready()
        from app.team_workspace import _transaction
        try:
            with _transaction(self.factory) as db:
                if db.get_bind().dialect.name == 'postgresql':
                    require_deletion_schema(db)
                elif not self.test_mode:
                    _fail()
                db.info['account_deletion_storage_buckets'] = dict(getattr(self.storage, 'buckets', {}))
                yield db
        except HTTPException:
            raise
        except Exception:
            # Includes transport/driver failures without echoing private details.
            _fail()

    def inspect(self, db, owner):
        if self.inspector is None:
            from app.account_deletion_data import inspect
            value = inspect(db, owner, self.service)
        else:
            value = self.inspector(db, owner, self.service)
        if (not isinstance(value, dict) or not _hex(value.get('fingerprint'))
            or not isinstance(value.get('counts'), dict) or set(value['counts']) != set(COUNTS)
            or any(type(n) is not int or n < 0 for n in value['counts'].values())
            or not isinstance(value.get('blockers'), list) or not isinstance(value.get('storageObjects'), list)):
            _fail()
        for blocker in value['blockers']:
            if not isinstance(blocker, dict) or set(blocker) != {'code','message'} or not all(isinstance(v,str) for v in blocker.values()):
                _fail()
        keys = [o.get('key') for o in value['storageObjects']]
        if len(keys) > 10000 or any(not _hex(k) for k in keys) or len(set(keys)) != len(keys):
            _fail()
        # Check the trusted adapter's bounded contract BEFORE accepting a
        # deletion. This is deliberately no-I/O: unsupported size/kind/path or
        # bucket configuration must not strand an already-pending account.
        supports = getattr(self.storage, 'supports', None)
        unsupported = False
        for target in value['storageObjects']:
            try:
                accepted = supports(target) is True if callable(supports) else self.test_mode
            except Exception:
                accepted = False
            if not accepted:
                unsupported = True
                break
        if unsupported:
            code = 'storage_target_unsupported'
            if not any(blocker['code'] == code for blocker in value['blockers']):
                value = {**value, 'blockers': [*value['blockers'], {
                    'code': code, 'message': '部分媒体的大小或保存位置尚不支持安全清理，请先完成核对；本次注销尚未开始',
                }]}
        return value

    def scope(self, owner, plan):
        return self.digest('scope', owner+'\0'+plan['fingerprint'])

    def prepare(self, claims):
        if not self.enabled:
            _fail(503, '账号注销尚未开放')
        owner, session_id = _actor(claims)
        with self.transaction() as db:
            self.live(db, owner, session_id)
            existing = db.scalar(select(Receipt).where(Receipt.barrier_digest == barrier_digest(self.service, owner)))
            if existing:
                _fail(409, '此账号已有注销请求，请读取原请求结果')
            plan = self.inspect(db, owner)
            fresh = recent_authentication(claims, int(self.clock()))
            return dict(version=1, policyVersion=POLICY, owner=owner, service=self.service,
                        scopeDigest=self.scope(owner, plan), counts=plan['counts'], blockers=plan['blockers'],
                        requiresRecentAuthentication=True, recentAuthentication=fresh,
                        canDelete=not plan['blockers'] and fresh, storagePending=bool(plan['storageObjects']))

    def _credentials(self, body, *, confirm=False):
        keys = {'requestId','readbackCapability'} | ({'scopeDigest','confirmation'} if confirm else set())
        if not isinstance(body, dict) or set(body) != keys:
            _fail(422, '注销请求格式未通过核对')
        request_id, capability = _uuid(body['requestId']), _cap(body['readbackCapability'])
        if confirm and (not _hex(body['scopeDigest']) or body['confirmation'] != 'DELETE_MY_ACCOUNT'):
            _fail(422, '请核对注销范围并确认本人账号')
        return request_id, self.digest('capability', request_id+'\0'+capability)

    def _read(self, db, request_id, capability_digest):
        row = db.get(Receipt, request_id)
        if not row or row.service != self.service or not hmac.compare_digest(row.capability_digest, capability_digest):
            _fail(404, '未找到匹配的注销回执，请保留原进度')
        return row

    @staticmethod
    def result(row):
        return dict(version=1, requestId=row.request_id, state=row.state, stage=row.stage,
                    canClearLocal=row.state == 'completed' and row.stage == 'done')

    def _finish(self, db, row, plan, absent):
        if plan['blockers'] or plan['fingerprint'] != row.fingerprint or self.scope(row.owner, plan) != row.scope_digest:
            _fail(409, '注销范围发生变化，请保留原进度并联系核对')
        plan = {**plan, 'storageVerifiedAbsent': sorted(absent)}
        owner = row.owner
        if self.eraser is None:
            from app.account_deletion_data import erase
            erase(db, owner, self.service, plan)
        else:
            self.eraser(db, owner, self.service, plan)
        self.auth_delete(db, owner)
        db.execute(delete(Object).where(Object.request_id == row.request_id))
        row.owner, row.state, row.stage, row.updated_at = None, 'completed', 'done', int(self.clock())

    def confirm(self, claims, body):
        try:
            return self._confirm(claims, body)
        except _NotStarted as error:
            # _confirm has exited its transaction. A rollback/commit transport
            # failure is converted to an ordinary unknown 503, never this code.
            raise HTTPException(error.status_code, {
                'code': 'account_deletion_not_started',
                'message': '本次注销尚未开始，请重新验证并核对范围',
            }, headers={'Cache-Control':'no-store','Pragma':'no-cache'}) from None

    def _confirm(self, claims, body):
        if not self.enabled:
            _fail(503, '账号注销尚未开放')
        owner, session_id = _actor(claims)
        request_id, cap_digest = self._credentials(body, confirm=True)
        with self.transaction() as db:
            self.live(db, owner, session_id, lock=True)
            old = db.scalar(select(Receipt).where(Receipt.barrier_digest == barrier_digest(self.service, owner)))
            if old:
                if old.request_id == request_id and hmac.compare_digest(old.capability_digest, cap_digest) and old.scope_digest == body['scopeDigest']:
                    return self.result(old)  # Receipt only; never replay a deletion.
                _fail(409, '此账号已有注销请求，请读取原请求结果')
            if db.get(Receipt, request_id):
                _fail(409, '注销请求标识已存在，请保留原进度核对')
            # Absence is checked under the owner's write lock before a refusal
            # can permit discarding the local operation. Existing receipts are
            # never invalidated by a later expired AMR or changed client body.
            if not recent_authentication(claims, int(self.clock())):
                raise _NotStarted(403, 'account_deletion_preflight_refused')
            plan = self.inspect(db, owner)
            if plan['blockers'] or not hmac.compare_digest(body['scopeDigest'], self.scope(owner, plan)):
                raise _NotStarted(409, 'account_deletion_preflight_refused')
            now = int(self.clock())
            row = Receipt(request_id=request_id, service=self.service, owner=owner,
                          owner_digest=self.digest('owner', owner), capability_digest=cap_digest,
                          barrier_digest=barrier_digest(self.service, owner),
                          scope_digest=body['scopeDigest'], fingerprint=plan['fingerprint'],
                          state='pending', stage='storage' if plan['storageObjects'] else 'finalizing',
                          created_at=now, updated_at=now)
            db.add(row); db.flush()
            for target in plan['storageObjects']:
                db.add(Object(request_id=request_id, key=target['key'], target=target,
                              state='waiting', updated_at=now))
            if not plan['storageObjects']:
                self._finish(db, row, plan, [])
            db.flush()
            result = self.result(row)
        return result

    def status(self, body):
        request_id, cap_digest = self._credentials(body)
        with self.transaction() as db:
            return self.result(self._read(db, request_id, cap_digest))

    def _presence(self, target):
        if self.storage is None:
            _fail(503, '注销的文件清理服务尚未就绪，请保留原进度')
        try:
            found = self.storage.inspect(target)
        except Exception:
            _fail()
        if found is None:
            return None
        if (not isinstance(found, dict) or not isinstance(found.get('version'), str)
            or not 1 <= len(found['version']) <= 1024 or type(found.get('bytes')) is not int
            or found['bytes'] != target.get('expectedBytes')
            or target.get('sha256') and found.get('sha256') not in (None, target['sha256'])):
            _fail(409, '注销文件身份未能核对，请保留原进度')
        return found

    def continue_request(self, body):
        request_id, cap_digest = self._credentials(body)
        # Snapshot is fixed by the already accepted request, never caller targets.
        with self.transaction() as db:
            row = self._read(db, request_id, cap_digest)
            if row.state == 'completed':
                return self.result(row)
            target_row = db.scalar(select(Object).where(Object.request_id == request_id, Object.state != 'absent').order_by(Object.key).limit(1))
            target = json.loads(json.dumps(target_row.target)) if target_row else None
        if target is not None:
            found = self._presence(target)
            dispatch = False
            with self.transaction() as db:
                row = self._read(db, request_id, cap_digest)
                obj = db.get(Object, (request_id, target['key']))
                if row.state == 'completed':
                    return self.result(row)
                if found is None:
                    obj.state = 'absent'
                elif obj.state == 'waiting':
                    obj.state, obj.observed_version, dispatch = 'attempted', found['version'], True
                else:
                    row.stage = 'storage_unknown'  # No second remove after unknown dispatch.
                obj.updated_at = row.updated_at = int(self.clock())
                version = obj.observed_version
            if dispatch:
                try:
                    acknowledgement = self.storage.remove(target, version)
                except Exception:
                    acknowledgement = {'status': 'unknown'}
                if acknowledgement == {'status': 'not_dispatched'}:
                    with self.transaction() as db:
                        row = self._read(db, request_id, cap_digest)
                        obj = db.get(Object, (request_id, target['key']))
                        if obj and obj.state == 'attempted' and obj.observed_version == version:
                            obj.state, obj.observed_version = 'waiting', None
                            row.stage = 'storage'
                else:
                    found = self._presence(target)
                    with self.transaction() as db:
                        row = self._read(db, request_id, cap_digest)
                        obj = db.get(Object, (request_id, target['key']))
                        if obj:
                            obj.state = 'absent' if found is None else 'attempted'
                            row.stage = 'storage' if found is None else 'storage_unknown'
            return self.status(body)
        # Reinspect actual absence again, then erase all business/auth rows atomically.
        with self.transaction() as db:
            row = self._read(db, request_id, cap_digest)
            fixed = [json.loads(json.dumps(o.target)) for o in db.scalars(select(Object).where(Object.request_id == request_id)).all()]
        if any(self._presence(o) is not None for o in fixed):
            _fail(409, '注销文件仍待确认，尚未完成账号注销')
        with self.transaction() as db:
            row = self._read(db, request_id, cap_digest)
            if row.state != 'completed':
                # Exclusive Auth owner lock prevents newly admitted concurrent writes.
                if db.get_bind().dialect.name == 'postgresql':
                    db.execute(text('SELECT id FROM auth.users WHERE id=CAST(:owner AS uuid) FOR UPDATE'), {'owner': row.owner}).one()
                self._finish(db, row, self.inspect(db, row.owner), [o['key'] for o in fixed])
            db.flush()
            return self.result(row)


def create_account_deletion_router(factory, *, storage=None, service=None, secret=None, enabled=None):
    worker = AccountDeletion(factory, storage=storage, service=service, secret=secret,
                             enabled=os.getenv('ACCOUNT_DELETION_ENABLED') == '1' if enabled is None else enabled)
    router = APIRouter(prefix='/api/account-deletion')

    def claims(authorization):
        from app.auth import verified_access_claims
        if os.getenv('AUTH_MODE') != 'supabase':
            _fail(503, '账号注销身份服务尚未就绪')
        return verified_access_claims(authorization)

    def reply(value):
        return JSONResponse(value, headers={'Cache-Control':'no-store','Pragma':'no-cache'})

    async def body(request, confirm=False):
        from app.native_session_relay import _body
        value = await _body(request, {'requestId','readbackCapability','scopeDigest','confirmation'} if confirm else {'requestId','readbackCapability'})
        worker._credentials(value, confirm=confirm)
        return value

    @router.get('/prepare')
    def prepare(authorization: str | None = Header(default=None)):
        return reply(worker.prepare(claims(authorization)))

    @router.post('/confirm')
    async def confirm(request: Request, authorization: str | None = Header(default=None)):
        value = await body(request, True)
        actor = await run_in_threadpool(claims, authorization)
        return reply(await run_in_threadpool(worker.confirm, actor, value))

    @router.post('/status')
    async def status(request: Request):
        return reply(await run_in_threadpool(worker.status, await body(request)))

    @router.post('/continue')
    async def continuation(request: Request):
        return reply(await run_in_threadpool(worker.continue_request, await body(request)))

    return router
