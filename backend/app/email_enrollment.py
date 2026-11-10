"""D-095 candidate: private, single-UID email enrollment; disabled by default.

No metadata permission: a one-use server nonce is matched to committed private
state. Native Auth alone verifies the OTP/issues sessions. This store writes app
proof only after that result and the current identity agree. No tokens at rest.
"""
from __future__ import annotations

import hmac
import json
import math
import os
import re
import secrets
import time
from datetime import datetime, timedelta, timezone
from functools import wraps
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen
from uuid import UUID, uuid4

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import BigInteger, Boolean, Column, MetaData, String, Table, insert, select, text, update

from app.auth import _supabase_url
from app.email_delivery import canonical_email

meta = MetaData()
enrollments = Table(
    'account_email_enrollments', meta,
    Column('enrollment_id', String(36), primary_key=True),
    Column('address_digest', String(64), nullable=False, unique=True),
    Column('resume_digest', String(64), nullable=False, unique=True),
    Column('creation_digest', String(64), nullable=False, unique=True),
    Column('creation_expires', BigInteger, nullable=False),
    Column('owner', String(36), unique=True),
    Column('state', String(16), nullable=False),
    Column('attempt_id', String(36), nullable=False),
    Column('send_digest', String(64), nullable=False),
    Column('send_expires', BigInteger, nullable=False),
    Column('mail_event', String(100), nullable=False),
    Column('mail_fingerprint', String(64), nullable=False),
    Column('delivery', String(16), nullable=False),
    Column('native_outcome', String(16), nullable=False),
    Column('created_at', BigInteger, nullable=False),
    Column('updated_at', BigInteger, nullable=False),
    Column('expires_at', BigInteger, nullable=False),
    Column('completed_at', BigInteger),
)
CAP = r'^[A-Za-z0-9_-]{43,128}$'
EVENT = r'^[A-Za-z0-9_-]{1,100}$'
CODE = r'^[0-9]{6,10}$'


def configured_enrollment_email_digests(security):
    """Derive one operator-approved test recipient with the existing private key.

    Only digests leave this parser. A malformed entry invalidates the complete
    enrollment allowlist; it must never silently widen or partially apply it.
    """
    configured = os.getenv('EMAIL_ENROLLMENT_ALLOWED_EMAIL_DIGESTS', '')
    recipient = os.getenv('EMAIL_ENROLLMENT_ALLOWED_EMAILS', '')
    allowed = configured.split(',') if configured else []
    if (len(allowed) > 8 or len(set(allowed)) != len(allowed)
            or any(not re.fullmatch('[0-9a-f]{64}', value) for value in allowed)):
        return ()
    if recipient:
        if any(ord(char) < 32 or ord(char) == 127 for char in recipient):
            return ()
        email = canonical_email(recipient)
        if not email or not security.key:
            return ()
        digest = security._digest('enrollment-address', email)
        if digest not in allowed:
            allowed.append(digest)
    return tuple(allowed) if 1 <= len(allowed) <= 8 else ()


def _fail(status=409, message='注册验证暂未完成，请读取当前状态'):
    raise HTTPException(status, message)


def storage_safe(fn):
    @wraps(fn)
    def guarded(*args, **kwargs):
        try:
            return fn(*args, **kwargs)
        except HTTPException:
            raise
        except Exception:
            raise HTTPException(503, '注册状态暂时无法核对；请保留进度，不要自动重发') from None
    return guarded


def _utc(value):
    if isinstance(value, str):
        value = datetime.fromisoformat(value)
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value


def enrollment_native(path, body, redirect=None, bearer=None):
    """Only fixed Auth endpoints, publishable key, bounded response. No redirects/logging."""
    if path not in ('/otp', '/verify', '/user'):
        _fail(503)
    headers = {'Content-Type': 'application/json', 'apikey': os.getenv('SUPABASE_PUBLISHABLE_KEY', '')}
    if not headers['apikey']:
        _fail(503)
    if redirect is not None:
        headers['redirect_to'] = redirect
    if bearer is not None:
        headers['Authorization'] = 'Bearer ' + bearer
    # urllib's default redirect handler must not forward a capability to another host.
    from urllib.request import HTTPRedirectHandler, build_opener
    class NoRedirect(HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            return None
    request = Request(_supabase_url() + '/auth/v1' + path,
                      data=json.dumps(body).encode() if body is not None else None,
                      headers=headers, method='GET' if path == '/user' else 'POST')
    try:
        with build_opener(NoRedirect).open(request, timeout=6) as response:
            raw = response.read(512 * 1024 + 1)
        if len(raw) > 512 * 1024:
            _fail(502)
        result = json.loads(raw)
        if not isinstance(result, dict):
            _fail(502)
        return result
    except HTTPException:
        raise
    except (HTTPError, URLError, OSError, ValueError):
        # Provider payloads may contain email, OTP or session: never reflect them.
        _fail(502, '账号服务结果暂未确认，请读取状态；不要自动重发')


class EnrollmentStart(BaseModel):
    model_config = ConfigDict(extra='forbid')
    email: str = Field(min_length=3, max_length=254)
    resume: str = Field(pattern=CAP)


class EnrollmentRequest(EnrollmentStart):
    enrollment: UUID


class EnrollmentVerify(EnrollmentRequest):
    attempt: UUID
    token: str = Field(pattern=CODE)


class PostgresEmailEnrollment:
    def __init__(self, security, *, enabled=False, allowed_email_digests=(),
                 redirect_base='', native=enrollment_native):
        self.security, self.factory = security, security.factory
        self.enabled, self.redirect_base, self.native = enabled, redirect_base, native
        self.allowed = tuple(allowed_email_digests)
        parsed = urlsplit(redirect_base)
        self.valid_redirect = bool(parsed.scheme == 'https' and parsed.hostname
            and not parsed.username and not parsed.password and not parsed.query and not parsed.fragment
            and parsed.path == '/auth/enrollment')
        # This callback can only grant a persisted, current, whitelisted UID. No
        # caller-supplied owner is added to the operator list; the same ledger remains.
        self.security.enrollment_authorizer = self.allowed_owner

    def _now(self):
        return int(self.security.clock())

    def _at(self):
        return datetime.fromtimestamp(self.security.clock(), timezone.utc)

    def ready(self):
        return bool(self.enabled and self.security.ready() and self.valid_redirect
            and 1 <= len(self.allowed) <= 8 and len(set(self.allowed)) == len(self.allowed)
            and all(isinstance(v, str) and re.fullmatch('[0-9a-f]{64}', v) for v in self.allowed))

    def _ready(self):
        if not self.ready():
            _fail(503, '邮箱验证码注册尚未开放')

    def _address(self, email):
        email = canonical_email(email)
        if not email:
            _fail(422, '请输入有效邮箱')
        digest = self.security._digest('enrollment-address', email)
        if not any(hmac.compare_digest(digest, value) for value in self.allowed):
            _fail(403, '该邮箱尚未加入本轮测试范围')
        return email, digest

    def _row(self, session, enrollment):
        return session.execute(select(enrollments).where(
            enrollments.c.enrollment_id == enrollment)).mappings().one_or_none()

    def _identity(self, session, owner):
        return session.execute(text('SELECT CAST(id AS text) AS id,email,phone,phone_confirmed_at,is_anonymous '
            'FROM auth.users WHERE CAST(id AS text)=:owner'), {'owner': owner}).mappings().one_or_none()

    def _owned(self, session, row, email):
        user = self._identity(session, row['owner']) if row['owner'] else None
        if not user or user['is_anonymous'] or canonical_email(user['email']) != email:
            _fail(409, '注册身份尚未核对或已变化')
        return user

    def _access(self, session, enrollment, email, resume, *, live=True):
        email, digest = self._address(email)
        row = self._row(session, enrollment)
        if (not isinstance(resume, str) or not re.fullmatch(CAP, resume) or not row
                or row['address_digest'] != digest
                or not hmac.compare_digest(row['resume_digest'], self.security._digest('enrollment-resume', resume))):
            _fail(403, '注册请求无效')
        if live and (row['expires_at'] <= self._now() or row['state'] == 'invalidated'):
            _fail(409, '注册请求已结束，请保留当前账号并联系测试负责人')
        return row, email

    def _save(self, session, row, **fields):
        fields['updated_at'] = self._now()
        session.execute(update(enrollments).where(
            enrollments.c.enrollment_id == row['enrollment_id']).values(**fields))

    def _view(self, session, row):
        challenge = session.execute(text('SELECT challenge_id,code_digest,attempts,expires_at '
            'FROM account_email_challenges WHERE owner=:owner'), {'owner': row['owner']}).mappings().one_or_none()
        active = bool(challenge and challenge['challenge_id'] == row['attempt_id']
            and challenge['code_digest'] and challenge['attempts'] < 5
            and _utc(challenge['expires_at']) > self._at())
        current = self._identity(session, row['owner']) if row['owner'] else None
        current_email = canonical_email(current['email']) if current and not current['is_anonymous'] else None
        verified = bool(row['state'] in ('verified', 'complete') and current_email
            and row['address_digest'] == self.security._digest('enrollment-address', current_email)
            and self.security._proof(session, row['owner'], self.security._digest('address', row['owner'], current_email)))
        # A capability alone never receives a session, even after proof was written.
        return {'enrollment': row['enrollment_id'], 'attempt': row['attempt_id'],
            'owner': row['owner'], 'state': row['state'], 'registrationComplete': row['completed_at'] is not None, 'delivery': row['delivery'],
            'nativeOutcome': row['native_outcome'], 'emailVerified': verified,
            'canVerify': bool(active and row['state'] in ('pending', 'uncertain') and row['expires_at'] > self._now()),
            'canResend': bool(current and not current['phone_confirmed_at'] and row['state'] in ('pending', 'uncertain', 'verified')
                and row['expires_at'] > self._now() and row['delivery'] != 'inflight' and row['updated_at'] + 60 <= self._now()),
            'expiresIn': max(0, math.ceil((_utc(challenge['expires_at']) - self._at()).total_seconds())) if active else 0,
            'retryAfter': min(60, max(0, row['updated_at'] + 60 - self._now()))}

    @storage_safe
    def status(self, enrollment, email, resume):
        self._ready()
        with self.factory.begin() as session:
            self.security._lock(session)
            row, _ = self._access(session, enrollment, email, resume, live=False)
            return self._view(session, row)

    @storage_safe
    def start(self, email, resume):
        self._ready()
        email = canonical_email(email)
        if not email:
            _fail(422, {'code': 'invalid_email', 'notStarted': True, 'message': '请输入有效邮箱，注册尚未开始'})
        digest = self.security._digest('enrollment-address', email)
        if not isinstance(resume, str) or not re.fullmatch(CAP, resume):
            _fail(422)
        now, enrollment, attempt = self._now(), str(uuid4()), str(uuid4())
        creation, sending = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
        resume_digest = self.security._digest('enrollment-resume', resume)
        with self.factory.begin() as session:
            self.security._lock(session)
            existing = session.execute(select(enrollments).where(
                enrollments.c.address_digest == digest)).mappings().one_or_none()
            if existing:
                row, _ = self._access(session, existing['enrollment_id'], email, resume, live=False)
                return self._view(session, row)  # lost response recovery; never implicitly resend
            if digest not in self.allowed:
                # A prior committed intent would have been found above. Do not
                # issue this code merely because the operator removed a list entry.
                _fail(403, {'code': 'email_not_approved', 'notStarted': True,
                    'message': '该邮箱尚未加入本轮测试范围，注册尚未开始'})
            from app.account_next_compat import assert_channel_email_available
            assert_channel_email_available(session, self.security, email)
            if session.execute(text('SELECT COUNT(*) FROM auth.users WHERE lower(email)=:email '
                    'OR lower(email_change)=:email'), {'email': email}).scalar_one():
                _fail(409, '此邮箱无法开始新注册，请使用原账号入口')
            if session.execute(text('SELECT COUNT(*) FROM account_email_send_reservations')).scalar_one() >= self.security.total:
                _fail(429, '本轮邮件测试额度已用完')
            session.execute(insert(enrollments).values(enrollment_id=enrollment, address_digest=digest,
                resume_digest=resume_digest, creation_digest=self.security._digest('enrollment-create', creation),
                creation_expires=now + 300, owner=None, state='creating', attempt_id=attempt,
                send_digest=self.security._digest('enrollment-send', sending), send_expires=now + 60,
                mail_event='', mail_fingerprint='', delivery='idle', native_outcome='pending',
                created_at=now, updated_at=now, expires_at=now + 86400, completed_at=None))
        self._send(enrollment, attempt, email, creation, sending, create=True)
        return self.status(enrollment, email, resume)

    def _send(self, enrollment, attempt, email, creation, sending, *, create):
        outcome = 'unknown'
        try:
            self.native('/otp', {'email': email, 'create_user': create,
                'data': {'gxj_enrollment': creation} if create else {}},
                redirect=self.redirect_base + '#permit=' + sending)
            outcome = 'accepted'
        except Exception:
            pass
        with self.factory.begin() as session:
            self.security._lock(session)
            row = self._row(session, enrollment)
            if row and row['attempt_id'] == attempt:
                fields = {'native_outcome': outcome}
                if outcome == 'unknown' and row['state'] in ('creating', 'pending'):
                    fields['state'] = 'uncertain'
                self._save(session, row, **fields)

    @storage_safe
    def before_create(self, event, user):
        self._ready()
        if (not isinstance(event, str) or not re.fullmatch(EVENT, event) or not isinstance(user, dict)
                or user.get('is_anonymous') is not False or user.get('phone') not in (None, '')
                or user.get('app_metadata', {}).get('provider') != 'email'):
            _fail(403)
        email, address = self._address(user.get('email'))
        try:
            owner = str(UUID(user.get('id')))
            nonce = user.get('user_metadata', {}).get('gxj_enrollment')
        except (ValueError, TypeError, AttributeError):
            _fail(403)
        if not isinstance(nonce, str) or not re.fullmatch(CAP, nonce):
            _fail(403, '此邮箱创建请求未获允许')
        with self.factory.begin() as session:
            self.security._lock(session)
            from app.account_next_compat import assert_channel_email_available
            assert_channel_email_available(session, self.security, email)
            row = session.execute(select(enrollments).where(enrollments.c.creation_digest ==
                self.security._digest('enrollment-create', nonce))).mappings().one_or_none()
            if (not row or row['address_digest'] != address or row['creation_expires'] <= self._now()
                    or row['state'] not in ('creating', 'pending') or row['owner'] not in (None, owner)):
                _fail(403, '此邮箱创建请求未获允许')
            if row['owner'] is None:
                if session.execute(text('SELECT COUNT(*) FROM auth.users WHERE lower(email)=:email '
                        'OR lower(email_change)=:email'), {'email': email}).scalar_one():
                    _fail(409)
                self._save(session, row, owner=owner, state='pending')
            # Same signed future UID is idempotent; another UID cannot consume it.
        return {}

    @storage_safe
    def hook(self, event, user, data):
        self._ready()
        if (not isinstance(event, str) or not re.fullmatch(EVENT, event) or not isinstance(user, dict)
                or not isinstance(data, dict) or data.get('email_action_type') != 'magiclink'
                or user.get('is_anonymous') is not False or not isinstance(data.get('token'), str)
                or not re.fullmatch(CODE, data['token'])):
            _fail(403, '注册邮件请求未获允许')
        email, address = self._address(user.get('email'))
        redirect = data.get('redirect_to')
        prefix = self.redirect_base + '#permit='
        if not isinstance(redirect, str) or not redirect.startswith(prefix) or not re.fullmatch(CAP, redirect[len(prefix):]):
            _fail(403, '注册发送许可无效')
        sending = redirect[len(prefix):]
        token, owner = data['token'], user.get('id')
        fingerprint = self.security._digest('enrollment-mail', owner or '', address, token, redirect)
        with self.factory.begin() as session:
            self.security._lock(session)
            from app.account_next_compat import assert_channel_email_available
            assert_channel_email_available(session, self.security, email)
            row = session.execute(select(enrollments).where(enrollments.c.owner == owner)).mappings().one_or_none()
            if (not row or row['address_digest'] != address or row['state'] not in ('pending', 'uncertain')
                    or row['expires_at'] <= self._now() or row['send_expires'] <= self._now()
                    or not hmac.compare_digest(row['send_digest'], self.security._digest('enrollment-send', sending))):
                _fail(403, '注册发送许可无效')
            current = self._owned(session, row, email)
            if current['phone_confirmed_at']:
                _fail(403, '注册已结束，请使用原账号入口')
            if row['mail_event']:
                if row['mail_event'] == event and row['mail_fingerprint'] == fingerprint and row['delivery'] == 'accepted':
                    return {}
                _fail(409, '该邮件请求已处理或结果待核对')
            proof_digest = self.security._digest('address', owner, email)
            self.security._reserve(session, 'enroll-' + row['attempt_id'], owner, proof_digest, 'verification', self._at())
            code = self.security._digest('enrollment-code', owner, proof_digest, row['attempt_id'], token)
            session.execute(text('INSERT INTO account_email_challenges(owner,challenge_id,email_digest,code_digest,attempts,expires_at) '
                'VALUES(:owner,:challenge,:digest,:code,0,:expiry) ON CONFLICT(owner) DO UPDATE SET '
                'challenge_id=EXCLUDED.challenge_id,email_digest=EXCLUDED.email_digest,code_digest=EXCLUDED.code_digest,attempts=0,expires_at=EXCLUDED.expires_at'),
                {'owner': owner, 'challenge': row['attempt_id'], 'digest': proof_digest, 'code': code, 'expiry': self._at() + timedelta(seconds=300)})
            self._save(session, row, mail_event=event, mail_fingerprint=fingerprint, delivery='inflight')
            enrollment, attempt = row['enrollment_id'], row['attempt_id']
        accepted = False
        try:
            self.security.delivery.send(email, token, 'verification')
            accepted = True
        except Exception:
            pass
        with self.factory.begin() as session:
            self.security._lock(session)
            current = self._row(session, enrollment)
            if current and current['attempt_id'] == attempt and current['mail_event'] == event:
                self._save(session, current, delivery='accepted' if accepted else 'unknown')
        if not accepted:
            _fail(503, '注册邮件投递结果未确认，请先检查收件箱')
        return {}

    @storage_safe
    def resend(self, enrollment, email, resume):
        self._ready()
        sending, attempt = secrets.token_urlsafe(32), str(uuid4())
        with self.factory.begin() as session:
            self.security._lock(session)
            row, email = self._access(session, enrollment, email, resume)
            current = self._owned(session, row, email)
            if current['phone_confirmed_at'] or row['state'] not in ('pending', 'uncertain', 'verified'):
                _fail(409, '当前注册状态不允许重发')
            if row['delivery'] == 'inflight' or row['updated_at'] + 60 > self._now():
                _fail(429, '请等待当前请求结束后再操作')
            if session.execute(text('SELECT COUNT(*) FROM account_email_send_reservations')).scalar_one() >= self.security.total:
                _fail(429, '本轮邮件测试额度已用完')
            # Explicit resend only after a fresh permit is committed; the native
            # call may ignore data for an existing UID, so it carries redirect.
            self._save(session, row, attempt_id=attempt, send_digest=self.security._digest('enrollment-send', sending),
                send_expires=self._now() + 60, mail_event='', mail_fingerprint='', delivery='idle',
                native_outcome='pending', state='pending')
            session.execute(text("UPDATE account_email_challenges SET code_digest='' WHERE owner=:owner"), {'owner': row['owner']})
        self._send(enrollment, attempt, email, '', sending, create=False)
        return self.status(enrollment, email, resume)

    @storage_safe
    def verify(self, enrollment, email, resume, attempt, token):
        self._ready()
        if not isinstance(token, str) or not re.fullmatch(CODE, token):
            _fail(422)
        rejected = False
        with self.factory.begin() as session:
            self.security._lock(session)
            row, email = self._access(session, enrollment, email, resume)
            self._owned(session, row, email)
            challenge = session.execute(text('SELECT challenge_id,email_digest,code_digest,attempts,expires_at '
                'FROM account_email_challenges WHERE owner=:owner'), {'owner': row['owner']}).mappings().one_or_none()
            digest = self.security._digest('address', row['owner'], email)
            if (row['attempt_id'] != attempt or row['state'] not in ('pending', 'uncertain')
                    or not challenge or challenge['challenge_id'] != attempt or challenge['email_digest'] != digest
                    or not challenge['code_digest'] or challenge['attempts'] >= 5 or _utc(challenge['expires_at']) <= self._at()):
                _fail(403, '验证码无效或已过期')
            matched = hmac.compare_digest(challenge['code_digest'], self.security._digest(
                'enrollment-code', row['owner'], digest, attempt, token))
            session.execute(text('UPDATE account_email_challenges SET attempts=attempts+1 WHERE owner=:owner'), {'owner': row['owner']})
            if matched:
                self._save(session, row, state='verifying')
            else:
                rejected = True
            owner = row['owner']
        if rejected:
            _fail(403, '验证码不正确，请核对本次邮件')
        try:
            result = self.native('/verify', {'email': email, 'token': token, 'type': 'email'})
            access = result.get('access_token')
            if not isinstance(access, str) or not access or not isinstance(result.get('refresh_token'), str) or not result.get('refresh_token'):
                _fail(502)
            checked = self.native('/user', None, bearer=access)
            if (checked.get('id') != owner or canonical_email(checked.get('email')) != email
                    or checked.get('is_anonymous') is not False or not checked.get('email_confirmed_at')):
                _fail(409, '验证身份不一致，未采用登录结果')
            with self.factory.begin() as session:
                self.security._lock(session)
                row, _ = self._access(session, enrollment, email, resume)
                self._owned(session, row, email)
                challenge = session.execute(text('SELECT challenge_id,expires_at FROM account_email_challenges WHERE owner=:owner'),
                    {'owner': owner}).mappings().one_or_none()
                if (row['owner'] != owner or row['attempt_id'] != attempt or row['state'] != 'verifying'
                        or not challenge or challenge['challenge_id'] != attempt or _utc(challenge['expires_at']) <= self._at()):
                    _fail(409, '验证期间状态已变化，未采用登录结果')
                session.execute(text('INSERT INTO account_email_proofs(owner,email_digest,verified_at) VALUES(:owner,:digest,:at) '
                    'ON CONFLICT(owner) DO UPDATE SET email_digest=EXCLUDED.email_digest,verified_at=EXCLUDED.verified_at'),
                    {'owner': owner, 'digest': digest, 'at': self._at()})
                session.execute(text("UPDATE account_email_challenges SET code_digest='' WHERE owner=:owner"), {'owner': owner})
                self._save(session, row, state='verified')
            # Explicit whitelist: never echo native metadata/redirect/extra provider fields.
            return {'owner': owner, 'email': email, 'emailVerified': True, 'phoneRequired': True,
                    'access_token': access, 'refresh_token': result['refresh_token'],
                    'expires_in': result.get('expires_in'), 'token_type': 'bearer'}
        except Exception:
            with self.factory.begin() as session:
                self.security._lock(session)
                row = self._row(session, enrollment)
                if row and row['attempt_id'] == attempt and row['state'] == 'verifying':
                    self._save(session, row, state='uncertain')
            _fail(409, '验证结果暂未确认，请读取状态；不要重复提交验证码')

    @storage_safe
    def allowed_owner(self, session, owner):
        if enrollment_schema_revision(session, guard_enabled=True, entry_enabled=self.enabled) not in ('20261006_0012', '20261006_0013'):
            return False
        row = session.execute(select(enrollments).where(enrollments.c.owner == owner)).mappings().one_or_none()
        if not row or row['state'] == 'invalidated':
            return False
        current = self._identity(session, owner)
        email = canonical_email(current['email']) if current and not current['is_anonymous'] else None
        return bool(email and row['address_digest'] == self.security._digest('enrollment-address', email)
            and row['address_digest'] in self.allowed
            and (row['completed_at'] is not None or row['expires_at'] > self._now()))


def guard_registered_email(session, owner, security, *, complete=False):
    """Uses the fixed PHONE -> EMAIL lock order; never calls a provider.

    Completed phone-first registration stays admitted after later email changes;
    unfinished enrollment always needs its current real proof, including when
    the public start switch is disabled during rollback.
    """
    # Serialize proof/current-email reads and completion with the email-change
    # trigger; otherwise a late completion could overwrite its invalidation.
    # Enrollment paths take EMAIL only, never EMAIL -> PHONE.
    security._lock(session)
    row = session.execute(select(enrollments).where(enrollments.c.owner == owner)).mappings().one_or_none()
    if not row or row['completed_at'] is not None:
        return
    current = session.execute(text('SELECT email FROM auth.users WHERE CAST(id AS text)=:owner'),
                              {'owner': owner}).mappings().one_or_none()
    email = canonical_email(current['email']) if current else None
    if (row['state'] != 'verified' or not email
            or row['address_digest'] != security._digest('enrollment-address', email)
            or not security._proof(session, owner, security._digest('address', owner, email))):
        _fail(403, '请先完成此账号的邮箱验证码验证')
    if complete:
        session.execute(update(enrollments).where(enrollments.c.enrollment_id == row['enrollment_id']).values(
            state='complete', completed_at=int(security.clock()), updated_at=int(security.clock())))


@storage_safe
def enrollment_schema_revision(session, *, guard_enabled=None, entry_enabled=None):
    """One transaction snapshot; no cross-request cache and no provider calls.

    The bridge accepts exactly 0011 without the new table while creation is
    closed, then automatically enforces 0012. Missing/contradictory catalog
    facts never become permission to skip a required guard.
    """
    from app.account_next_compat import schema_revision
    return schema_revision(session, guard_enabled=guard_enabled, entry_enabled=entry_enabled)


def _configured_enrollment_active(session):
    # Preserve the existing non-PostgreSQL development path only when the
    # feature is disabled. Every hosted PG caller still checks schema/guard,
    # including a fresh store constructed outside the HTTP route gate.
    if (os.getenv('EMAIL_ENROLLMENT_GUARD_ENABLED') != '1'
            and session.get_bind().dialect.name != 'postgresql'):
        return False
    return enrollment_schema_revision(session) in ('20261006_0012', '20261006_0013')


def configured_enrollment_guard(session, owner, *, complete=False):
    if not _configured_enrollment_active(session):
        return
    from app.email_security import PostgresEmailSecurity
    security = PostgresEmailSecurity(None, os.getenv('SMS_HOOK_PHONE_HASH_KEY', ''), None, clock=time.time)
    guard_registered_email(session, owner, security, complete=complete)


@storage_safe
def configured_enrollment_phone_allowed(session, owner, phone=None):
    # Unlike the mail hook authorizer, SMS needs REAL proof, not a pending
    # creation intent. It does not increase any number in SmsSendBudget.
    if not _configured_enrollment_active(session):
        return False
    from app.email_security import PostgresEmailSecurity
    security = PostgresEmailSecurity(None, os.getenv('SMS_HOOK_PHONE_HASH_KEY', ''), None, clock=time.time)
    security._lock(session)  # Caller already holds PHONE; fixed PHONE -> EMAIL.
    row = session.execute(select(enrollments).where(enrollments.c.owner == owner)).mappings().one_or_none()
    allowed = configured_enrollment_email_digests(security)
    if not row or row['address_digest'] not in allowed:
        return False
    current = session.execute(text('SELECT email,phone,phone_confirmed_at,is_anonymous FROM auth.users WHERE CAST(id AS text)=:owner'),
                              {'owner': owner}).mappings().one_or_none()
    if not current or current['is_anonymous']:
        return False
    if row['completed_at'] is not None:
        # Completion is durable even after a later email change invalidates its
        # old proof. Grant only the already confirmed phone, never a new number.
        from app.sms_hook import canonical_mainland_phone
        actual = canonical_mainland_phone(current['phone'])
        return bool(actual and current['phone_confirmed_at'] and canonical_mainland_phone(phone) == actual)
    if row['state'] != 'verified' or row['expires_at'] <= int(security.clock()):
        return False
    email = canonical_email(current['email'])
    return bool(email and row['address_digest'] == security._digest('enrollment-address', email)
                and security._proof(session, owner, security._digest('address', owner, email)))


def create_email_enrollment_router(store):
    router = APIRouter(prefix='/api/auth/email-enrollment')
    @router.post('/start')
    @storage_safe
    def start(body: EnrollmentStart):
        return store.start(body.email, body.resume)
    @router.post('/status')
    @storage_safe
    def status(body: EnrollmentRequest):
        return store.status(str(body.enrollment), body.email, body.resume)
    @router.post('/resend')
    @storage_safe
    def resend(body: EnrollmentRequest):
        return store.resend(str(body.enrollment), body.email, body.resume)
    @router.post('/verify')
    @storage_safe
    def verify(body: EnrollmentVerify):
        return store.verify(str(body.enrollment), body.email, body.resume, str(body.attempt), body.token)
    return router

