"""Unregistered review candidate. PostgreSQL is authoritative; no Admin API.

Inject the EXISTING PostgresEmailSecurity, PostgresAccountStore and auth_upstream.
Do not instantiate against production until the reviewed contract gates pass.
All IO is injected. Native response tokens are never returned or adopted.
"""
from __future__ import annotations

import hashlib
import hmac
import re
import secrets
from datetime import datetime, timedelta, timezone
from uuid import UUID, uuid4
from urllib.parse import urlsplit

from fastapi import HTTPException
from sqlalchemy import text
from app.email_delivery import canonical_email
from app.account_next_code_contract import channel_code_length, valid_channel_code
from app.sms_hook import canonical_mainland_phone
from app.account_next_compat import FeatureScope, admit, schema_revision, REVISION, assert_enrollment_email_available

TERMINAL = {'completed', 'cancelled_holding', 'expired_holding', 'invalidated'}
FIELDS = ('id::text AS id,email,email_confirmed_at,email_change,'
          'email_change_token_current,email_change_token_new,email_change_confirm_status,'
          'phone,phone_confirmed_at,phone_change,phone_change_token,is_anonymous')


def reject(code, status=409):
    raise HTTPException(status, code)


def fingerprint(intent, target, native_hash):
    if not native_hash:
        reject('native_challenge_missing')
    return hashlib.sha256(f'{intent}:{target}:{native_hash}'.encode()).hexdigest()


def signed_native_hash(address, token, supplied=None, *, derive=False):
    # Supabase Auth v2.197.0 crypto.GenerateTokenHash: SHA-224(address + OTP).
    # Only called after the existing verified Hook; never log/store raw hashes.
    if not isinstance(address, str) or not isinstance(token, str):
        reject('signed_native_hash_invalid', 403)
    expected = hashlib.sha224((address + token).encode()).hexdigest()
    if supplied is None and derive:
        return expected  # SMS Hook supplies OTP; Native hashes it after Hook.
    if (not isinstance(supplied, str) or not re.fullmatch(r'(?:pkce_)?[0-9a-f]{56}', supplied)
            or not hmac.compare_digest(supplied.removeprefix('pkce_'), expected)):
        reject('signed_native_hash_invalid', 403)
    return supplied


class PostgresChannelChanges:
    def __init__(self, email_security, account_store, upstream, *, enabled=False,
                 hosted_contract_verified=False, reservation_guard_installed=False,
                 change_delivery=None, test_owner_ids=(), enrollment_test_digests=(), enabled_channels=(), contract_probe=None, native_redirect_base=''):
        self.email, self.account, self.upstream = email_security, account_store, upstream
        self.factory, self.clock = email_security.factory, email_security.clock
        self.change_delivery = change_delivery
        self.reservation_guard_installed = reservation_guard_installed is True
        self.enabled = enabled is True and hosted_contract_verified is True and self.reservation_guard_installed
        # Explicit channel capabilities. Invalid configuration grants nothing.
        self.enabled_channels = frozenset(enabled_channels) if (
            isinstance(enabled_channels, tuple) and len(enabled_channels) <= 2
            and all(isinstance(kind, str) and kind in ('email', 'phone') for kind in enabled_channels)
            and len(set(enabled_channels)) == len(enabled_channels)) else frozenset()
        self.contract_probe = contract_probe
        self.native_redirect_base = native_redirect_base
        self.allowed = set(email_security.allowed) & set(account_store.allowed_owners)
        self.scope = FeatureScope(tuple(test_owner_ids), tuple(enrollment_test_digests))

    def _now(self):
        return datetime.fromtimestamp(self.clock(), timezone.utc)

    def _locks(self, session):
        self.account._lock(session)
        self.email._lock(session)

    def _native_hook_locks(self, session):
        # Native can already own these locks for a mixed update in its outer
        # transaction. Never wait for the request that is awaiting this Hook.
        session.execute(text("SET LOCAL lock_timeout='200ms'"))
        for key in (621662560617157762, 621662560617157763):
            if session.execute(text('SELECT pg_try_advisory_xact_lock(:key)'), {'key': key}).scalar_one() is not True:
                reject('native_hook_busy', 503)

    def _inspect(self, session, owner, *, create_epoch=False):
        """Existing receipt access: identity/owner only, never enables actions.

        Independent of feature flag, policy, delivery readiness, send budget,
        allowlist changes and current phone verification. Missing identity or
        foreign intent still fails closed. Does not grant any fresh authority.
        """
        owner = str(UUID(owner))
        self._locks(session)
        user = session.execute(text(f'SELECT {FIELDS} FROM auth.users WHERE id=CAST(:owner AS uuid)'), {'owner': owner}).mappings().one_or_none()
        if not user or user['is_anonymous']:
            reject('account_identity_invalid', 401)
        if create_epoch:
            session.execute(text('INSERT INTO account_next.epochs(owner,epoch) VALUES(CAST(:owner AS uuid),0) ON CONFLICT(owner) DO NOTHING'), {'owner': owner})
        epoch = session.execute(text('SELECT epoch FROM account_next.epochs WHERE owner=CAST(:owner AS uuid) FOR UPDATE'), {'owner': owner}).scalar_one_or_none()
        return user, epoch

    def _native_redirect_ready(self):
        base = self.native_redirect_base
        if not isinstance(base, str) or not 1 <= len(base) <= 1024 or not base.isascii() or any(ord(c) <= 32 or ord(c) == 127 for c in base):
            return False
        try:
            parsed = urlsplit(base)
            return bool(parsed.scheme == 'https' and parsed.hostname and parsed.netloc
                        and not parsed.username and not parsed.password and not parsed.query and not parsed.fragment
                        and '#' not in base and '?' not in base)
        except ValueError:
            return False

    def _native_request_redirect(self, op):
        # Reuse the reviewed enrollment base and existing private HMAC key.
        # No address, OTP or raw Native hash is put in this short-lived marker.
        if not self._native_redirect_ready():
            reject('native_request_correlation_unavailable', 503)
        proof = self.email._digest('channel-native-request-v1', str(op['owner']),
            str(op['intent']), str(op['base_epoch']), op['target_digest'])
        if not isinstance(proof, str) or not re.fullmatch('[0-9a-f]{64}', proof):
            reject('native_request_correlation_unavailable', 503)
        return self.native_redirect_base + '#gxj-channel=' + str(op['intent']) + '.' + proof

    def _require_channel(self, kind):
        if (not self.enabled and self.contract_probe is None) or kind not in self.enabled_channels:
            reject('channel_change_closed', 503)
        if kind == 'email' and not self._native_redirect_ready():
            reject('native_request_correlation_unavailable', 503)

    def _gate(self, session, owner, *, kind=None):
        if kind is not None:
            self._require_channel(kind)
        if (not self.enabled and (not self.contract_probe or not self.contract_probe.owner_live(owner,self.clock()))) or not self.enabled_channels or not self.email.ready() or not self.change_delivery or not self.change_delivery.ready():
            reject('channel_change_closed', 503)
        user, epoch = self._inspect(session, owner, create_epoch=True)
        if schema_revision(session) != REVISION:
            reject('channel_migration_required', 503)
        scope = self.scope if self.enabled else FeatureScope((self.contract_probe.owner,),())
        admit(session, owner, user, scope, legacy_owners=self.allowed)
        if not self.enabled:
            count = session.execute(text('SELECT count(*) FROM public.account_email_send_reservations')).scalar_one()
            if not self.contract_probe.action_ledger_matches(count):reject('contract_probe_budget_drift',429)
        if session.execute(text('SELECT enabled FROM account_next.policy WHERE singleton')).scalar_one_or_none() is not True:
            reject('channel_change_closed', 503)
        # Existence alone is not evidence of the correct hosted contract. The
        # separate default-false attestation must be set only after live review.
        if not session.execute(text("SELECT count(*) FROM pg_catalog.pg_trigger WHERE tgrelid='auth.users'::regclass AND tgname='account_next_native_fence' AND tgenabled='O' AND NOT tgisinternal")).scalar_one():
            reject('native_fence_missing', 503)
        if not user['phone_confirmed_at'] or not canonical_mainland_phone(user['phone']):
            reject('verified_phone_admission_required', 403)
        return user, epoch

    def _receipt_address(self, kind, value, owner):
        """Existing facts need keys and normalization, not send authorization."""
        if kind == 'email':
            return self._address(kind, value, owner)
        address = canonical_mainland_phone(value)
        key = self.account.budget.phone_hash_key
        if not address or not isinstance(key, str) or len(key.encode()) < 32:
            reject('receipt_phone_key_or_address_unavailable', 503)
        return address, hmac.new(key.encode(), address.encode('ascii'), hashlib.sha256).hexdigest()

    def _change_number(self, session, value, owner):
        """Change-only validator in caller's locked transaction.

        Never calls first-binding _number or its factory. Feature admission
        uses a durable completed enrollment and the independent change scope;
        current and target phones use the unchanged budget HMAC identity.
        """
        user = self.account._user(session, owner)
        admit(session, owner, user, self.scope, legacy_owners=self.allowed)
        address = canonical_mainland_phone(value)
        digest = self.account.budget.phone_digest(address) if address else None
        if not digest:
            reject('phone_key_or_address_unavailable', 422)
        return address, digest

    def _address(self, kind, value, owner, *, session=None):
        if kind == 'email':
            address = canonical_email(value)
            if not address:
                reject('invalid_email', 422)
            # Global target key, DISTINCT from UID-bound independent proof.
            return address, self.email._digest('channel-email-address-v2', address)
        if kind == 'phone':
            if session is not None:
                return self._change_number(session, value, owner)
            # Pure normalization and HMAC only. Authority is checked by _gate
            # in the SAME transaction before each action. Never call _number:
            # D-095 _number opens another PHONE transaction for first binding.
            address = canonical_mainland_phone(value)
            digest = self.account.budget.phone_digest(address) if address else None
            if not digest:
                reject('phone_key_or_address_unavailable', 422)
            return address, digest
        reject('invalid_kind', 422)

    def _has_email_proof(self, session, owner, address):
        return self.email._proof(session, owner, self.email._digest('address', owner, address))

    def _code(self, op, leg, token):
        return self.email._digest('channel-code-v2', str(op['owner']), str(op['intent']),
                                  str(op['base_epoch']), leg, token)

    def _load(self, session, owner, intent):
        row = session.execute(text('SELECT * FROM account_next.intents WHERE intent=CAST(:intent AS uuid) AND owner=CAST(:owner AS uuid) FOR UPDATE'), {'intent': str(UUID(intent)), 'owner': owner}).mappings().one_or_none()
        if not row:
            reject('intent_not_found', 404)
        return row

    def _retire_stale(self, session, op, epoch):
        """Atomic expiry/epoch retirement; preserve native-confirmed receipts.

        Caller holds common advisory locks. Never releases target claims or
        ledger and never changes completed/cancelled receipts into new grants.
        """
        state = op['state']
        if state not in TERMINAL and state != 'native_confirmed':
            if epoch is None or epoch != op['base_epoch']:
                state = 'invalidated'
            elif op['expires_at'] <= self._now():
                state = 'expired_holding'
            if state != op['state']:
                session.execute(text('UPDATE account_next.intents SET state=:state,verify_leg=NULL WHERE intent=:intent'), {'state': state, 'intent': op['intent']})
                session.execute(text("UPDATE account_next.codes SET code_digest='',native_fingerprint=CASE WHEN :kind='email' AND :state='expired_holding' THEN native_fingerprint ELSE NULL END WHERE intent=:intent"), {'intent': op['intent'], 'kind': op['kind'], 'state': state})
        return state

    def _active(self, session, owner, intent):
        user, epoch = self._gate(session, owner)
        op = self._load(session, owner, intent)
        self._require_channel(op['kind'])
        if not self.enabled and not self.contract_probe.intent_matches(op):reject('contract_probe_scope_mismatch',403)
        if op['state'] in TERMINAL or op['state'] == 'native_confirmed' or op['expires_at'] <= self._now():
            reject('intent_not_active')
        _, old = self._address(op['kind'], user[op['kind']], owner, session=session)
        _, authority = self._address(op['authority_kind'], user[op['authority_kind']], owner, session=session)
        if epoch != op['base_epoch'] or old != op['old_digest'] or authority != op['authority_digest']:
            reject('credential_epoch_or_authority_changed', 403)
        return user, op

    def _available(self, session, owner, kind, target, digest):
        if kind == 'phone':
            self.account._other(session, owner, target)
            prior = session.execute(text('SELECT owner FROM public.phone_binding_claims WHERE phone_digest=:digest'), {'digest': digest}).scalar_one_or_none()
            if prior and prior != owner:
                reject('target_unavailable')
            if session.execute(text("SELECT count(*) FROM public.phone_binding_claims WHERE owner=:owner AND state='pending' AND phone_digest<>:digest"), {'owner': owner, 'digest': digest}).scalar_one():
                reject('pending_phone_claim_exists')
        else:
            assert_enrollment_email_available(session, self.email, target)
            if session.execute(text('SELECT count(*) FROM auth.users WHERE id<>CAST(:owner AS uuid) AND (lower(btrim(email))=:target OR lower(btrim(email_change))=:target)'), {'owner': owner, 'target': target}).scalar_one():
                reject('target_unavailable')
            # A first-binding intent is committed BEFORE its native Hook/PUT.
            # Compare its existing UID-bound digest against the retyped target;
            # do not misinterpret absence of auth.users.email_change as free.
            first = session.execute(text("SELECT owner,email_digest FROM public.account_email_binding_intents WHERE state IN('requesting','pending','verifying','uncertain')")).mappings().all()
            for row in first:
                if hmac.compare_digest(row['email_digest'], self.email._digest('address', row['owner'], target)):
                    reject('target_held_by_first_binding')
        # Retained uncertain/expired reservations also block SAME-owner reuse.
        if session.execute(text('SELECT count(*) FROM account_next.reservations WHERE kind=:kind AND target_digest=:digest'), {'kind': kind, 'digest': digest}).scalar_one():
            reject('target_held_for_review')

    def _reserve_target(self, session, op, target):
        _, digest = self._address(op['kind'], target, str(op['owner']), session=session)
        if digest != op['target_digest']:
            reject('target_mismatch', 403)
        self._available(session, str(op['owner']), op['kind'], target, digest)
        session.execute(text('INSERT INTO account_next.reservations(kind,target_digest,owner,intent) VALUES(:kind,:digest,:owner,:intent)'), {'kind': op['kind'], 'digest': digest, 'owner': op['owner'], 'intent': op['intent']})
        if op['kind'] == 'phone':
            session.execute(text("INSERT INTO public.phone_binding_claims(phone_digest,owner,state,updated_at) VALUES(:digest,:owner,'pending',:at) ON CONFLICT(phone_digest) DO UPDATE SET state='pending',updated_at=EXCLUDED.updated_at"), {'digest': digest, 'owner': str(op['owner']), 'at': self._now()})

    def begin(self, owner, kind, target, lost_channel=False):
        self._require_channel(kind)
        owner = str(UUID(owner)); intent = str(uuid4())
        target, digest = self._address(kind, target, owner)
        if not self.enabled:
            if (not self.contract_probe or not self.contract_probe.owner_live(owner,self.clock())
                    or not self.contract_probe.target_matches(digest) or lost_channel):
                reject('contract_probe_scope_mismatch',403)
            intent = self.contract_probe.intent
        # Commit stale receipt retirement separately from a possible rejected
        # new target/policy check; otherwise its HTTP error would roll it back.
        # This is owner-only recovery, not a fresh action or automatic resend.
        self.status(owner)
        resumed = False
        with self.factory.begin() as session:
            user, epoch = self._gate(session, owner, kind=kind)
            target, digest = self._address(kind, target, owner, session=session)
            # Email change ALWAYS needs independently proved current email and
            # native dual confirmation; losing it never creates an Admin path.
            authority_kind = 'email' if kind == 'email' or lost_channel else 'phone'
            if kind == 'email' and lost_channel:
                reject('lost_email_recovery_closed', 403)
            active = session.execute(text("SELECT * FROM account_next.intents WHERE owner=CAST(:owner AS uuid) AND state NOT IN('completed','cancelled_holding','expired_holding','invalidated') FOR UPDATE"), {'owner': owner}).mappings().one_or_none()
            if not self.enabled and active and not self.contract_probe.intent_matches(active):reject('contract_probe_scope_mismatch',403)
            if active and self._retire_stale(session, active, epoch) not in TERMINAL:
                if active['kind'] != kind or active['target_digest'] != digest or active['authority_kind'] != authority_kind:
                    reject('intent_in_progress')
                intent, resumed = str(active['intent']), True
            else:
                if not self.enabled:
                    used=session.execute(text('SELECT count(*) FROM account_next.intents WHERE intent=CAST(:intent AS uuid)'),{'intent':intent}).scalar_one()
                    count=session.execute(text('SELECT count(*) FROM public.account_email_send_reservations')).scalar_one()
                    if used or not self.contract_probe.pair_ledger_matches(count):reject('contract_probe_already_used_or_budget_drift',409)
                old, old_digest = self._address(kind, user[kind], owner, session=session)
                if target == old:
                    reject('unchanged')
                authority, authority_digest = self._address(authority_kind, user[authority_kind], owner, session=session)
                if authority_kind == 'email' and not self._has_email_proof(session, owner, authority):
                    reject('current_email_independent_proof_required', 403)
                self._available(session, owner, kind, target, digest)
                now = self._now()
                session.execute(text('INSERT INTO account_next.intents(intent,owner,kind,base_epoch,old_digest,target_digest,authority_kind,authority_digest,state,created_at,expires_at) VALUES(:intent,:owner,:kind,:epoch,:old,:target,:authority_kind,:authority,:state,:at,:expiry)'), {'intent': intent, 'owner': owner, 'kind': kind, 'epoch': epoch, 'old': old_digest, 'target': digest, 'authority_kind': authority_kind, 'authority': authority_digest, 'state': 'requesting' if kind == 'email' else 'awaiting_old', 'at': now, 'expiry': min(now + timedelta(minutes=5),datetime.fromtimestamp(self.contract_probe.expires_unix,timezone.utc)) if not self.enabled else now + timedelta(minutes=5)})
                if kind == 'email':
                    self._reserve_target(session, self._load(session, owner, intent), target)
        return {**self.status(owner, intent), 'resumed': resumed}

    def _save_code(self, session, op, leg, token, *, native_fp=None):
        if not valid_channel_code(op.get('kind'), leg, token):
            reject('unsupported_native_code_contract', 403)
        session.execute(text('INSERT INTO account_next.codes(intent,leg,code_digest,native_fingerprint) VALUES(:intent,:leg,:digest,:fp)'), {'intent': op['intent'], 'leg': leg, 'digest': self._code(op, leg, token), 'fp': native_fp})

    def old_start(self, owner, intent, bearer):
        token = None
        with self.factory.begin() as session:
            user, op = self._active(session, owner, intent)
            if op['kind'] != 'phone' or op['state'] != 'awaiting_old':
                reject('old_authorization_already_requested')
            address, digest = self._address(op['authority_kind'], user[op['authority_kind']], owner, session=session)
            if op['authority_kind'] == 'email':
                if not self._has_email_proof(session, owner, address):
                    reject('current_email_independent_proof_required', 403)
                token = f'{secrets.randbelow(1000000):06d}'
                self.email._reserve(session, 'old-'+str(op['intent']), owner, self.email._digest('address', owner, address), 'verification', self._now())
                self._save_code(session, op, 'authority', token)
            session.execute(text('UPDATE account_next.intents SET state=:state WHERE intent=:intent'), {'state': 'old_pending' if token else 'old_requesting', 'intent': op['intent']})
        try:
            if token:
                self.change_delivery.send(address, token, 'phone-authority')
            else:
                self.upstream('/otp', 'POST', {'phone': address, 'create_user': False}, bearer)
        except Exception:
            # Never retry/refund automatically, and never erase signed-hook code.
            pass
        return self.status(owner, intent)

    def capture_sms(self, event, user, phone, token):
        """INTERNAL ONLY, after existing Standard Webhook signature validation.

        Call before the unchanged existing SMS budget.reserve/transport. True
        selects the exact rebind branch; False keeps the first-binding guard.
        Signed retries fail closed; no public HTTP route exposes this method.
        """
        if not self.reservation_guard_installed:
            return False
        try:
            owner = str(UUID(user.get('id', '')))
        except (ValueError, TypeError, AttributeError):
            return False
        address = canonical_mainland_phone(phone)
        if not address:
            return False
        new_request = canonical_mainland_phone(user.get('new_phone')) == address
        if not new_request and (user.get('new_phone') or canonical_mainland_phone(user.get('phone')) != address):
            return False
        with self.factory.begin() as session:
            # Classify ONLY from owned persistent intents BEFORE phone, SMTP,
            # policy or feature gating. Nonmatching ordinary flows are untouched.
            if schema_revision(session) != REVISION:
                return False  # staged 0011/0012 service: original SMS path
            # Unlocked preclassification may only keep an obvious nonmatch on
            # its original route. It can never admit a channel-change request.
            query = "SELECT * FROM account_next.intents WHERE owner=CAST(:owner AS uuid) AND kind='phone' ORDER BY created_at DESC,intent DESC"
            rows = session.execute(text(query), {'owner': owner}).mappings().all()
            if not rows:
                return False
            _, digest = self._receipt_address('phone', address, owner)
            def matches(row):
                return ((new_request and row['target_digest'] == digest) or
                    (not new_request and row['state'] == 'old_requesting' and row['authority_kind'] == 'phone' and row['authority_digest'] == digest))
            if not any(matches(row) for row in rows):
                return False
            self._native_hook_locks(session)
            # Repeat after acquiring both locks; the unlocked snapshot grants
            # nothing and must not retire or consume a concurrently changed row.
            rows = session.execute(text(query + ' FOR UPDATE'), {'owner': owner}).mappings().all()
            chosen = next((row for row in rows if matches(row)), None)
            if chosen and not new_request:
                # A stale old-authority request must not trap ordinary current-
                # phone login/recovery before the owner can authenticate status.
                # Retire ONLY this old_requesting leg under the common locks;
                # keep claims/ledger, and NEVER relax new-target classification.
                epoch = session.execute(text('SELECT epoch FROM account_next.epochs WHERE owner=CAST(:owner AS uuid) FOR UPDATE'), {'owner': owner}).scalar_one_or_none()
                if self._retire_stale(session, chosen, epoch) != 'old_requesting':
                    chosen = None
            if not chosen:
                return False
            _, op = self._active(session, owner, str(chosen['intent']))
            leg = 'new' if new_request else 'authority'
            if leg == 'authority':
                if canonical_mainland_phone(user.get('phone')) != address or user.get('new_phone'):
                    reject('old_sms_not_current_channel', 403)
            elif op['state'] != 'requesting' or not op['authority_verified'] or not op['request_claimed'] or canonical_mainland_phone(user.get('new_phone')) != address:
                reject('new_sms_not_authorized', 403)
            if not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', event):
                reject('invalid_signed_event', 403)
            native_fp = None
            if leg == 'new':
                if not valid_channel_code('phone', 'new', token):
                    reject('unsupported_native_code_contract', 403)
                native_fp = fingerprint(str(op['intent']), address, signed_native_hash(address.removeprefix('+'), token, derive=True))
            self._save_code(session, op, leg, token, native_fp=native_fp)
            session.execute(text('UPDATE account_next.intents SET state=:state WHERE intent=:intent'), {'state': 'old_pending' if leg == 'authority' else 'pending', 'intent': op['intent']})
        return True

    def _claim_code(self, owner, intent, leg, token, target=None):
        rejected = False
        with self.factory.begin() as session:
            user, op = self._active(session, owner, intent)
            expected = 'old_pending' if leg == 'authority' else 'pending'
            if op['state'] != expected or (leg != 'authority' and leg not in ('old', 'new')):
                reject('code_not_available')
            if channel_code_length(op.get('kind'), leg) is None:
                reject('unsupported_native_code_contract', 403)
            c = session.execute(text('SELECT * FROM account_next.codes WHERE intent=:intent AND leg=:leg FOR UPDATE'), {'intent': op['intent'], 'leg': leg}).mappings().one_or_none()
            if not self.enabled and c and c['attempts'] != 0:reject('contract_probe_verify_attempt_consumed',403)
            if not c or c['consumed'] or c['attempts'] >= 5 or not c['code_digest']:
                reject('code_used_or_locked', 403)
            matched = valid_channel_code(op.get('kind'), leg, token) and hmac.compare_digest(c['code_digest'], self._code(op, leg, token))
            session.execute(text('UPDATE account_next.codes SET attempts=attempts+1 WHERE intent=:intent AND leg=:leg'), {'intent': op['intent'], 'leg': leg})
            if not matched:
                rejected = True
            else:
                native_fp = None
                if leg != 'authority':
                    pending, digest = self._address(op['kind'], user[op['kind']+'_change'], owner, session=session)
                    supplied, supplied_digest = self._address(op['kind'], target, owner, session=session)
                    if digest != op['target_digest'] or supplied_digest != digest or supplied != pending:
                        reject('native_pending_target_mismatch', 403)
                    native_hash = user['phone_change_token'] if op['kind'] == 'phone' else user['email_change_token_current' if leg == 'old' else 'email_change_token_new']
                    native_fp = fingerprint(str(op['intent']), pending, native_hash)
                    if not isinstance(c.get('native_fingerprint'), str) or not hmac.compare_digest(c['native_fingerprint'], native_fp):
                        reject('native_challenge_drift_from_signed_hook', 403)
                session.execute(text('UPDATE account_next.codes SET consumed=true,native_fingerprint=:fp WHERE intent=:intent AND leg=:leg'), {'fp': native_fp, 'intent': op['intent'], 'leg': leg})
                session.execute(text('UPDATE account_next.intents SET state=:state,verify_leg=:leg WHERE intent=:intent'), {'state': 'old_verifying' if leg == 'authority' else 'verifying', 'leg': None if leg == 'authority' else leg, 'intent': op['intent']})
        if rejected:
            reject('incorrect_code', 403)  # outside begin(): wrong attempt persists
        return dict(user), dict(op)

    @staticmethod
    def _same_uid(result, owner, required=False):
        user = result.get('user') if isinstance(result, dict) else None
        # /user is the user object; /verify is a token response containing user.
        if user is None and isinstance(result, dict) and 'id' in result:
            user = result
        if (required and not user) or (user is not None and (not isinstance(user, dict) or str(user.get('id')) != owner or user.get('is_anonymous') is True)):
            reject('native_uid_mismatch', 403)
        return user

    def old_verify(self, owner, intent, token, target, bearer):
        user, op = self._claim_code(owner, intent, 'authority', token)
        try:
            if op['authority_kind'] == 'phone':
                address, _ = self._address('phone', user['phone'], owner)
                result = self.upstream('/verify', 'POST', {'phone': address, 'token': token, 'type': 'sms'}, bearer)
                native = self._same_uid(result, owner, True)
                if canonical_mainland_phone(native.get('phone')) != address or not native.get('phone_confirmed_at'):
                    reject('old_phone_native_not_confirmed', 403)
                self._same_uid(self.upstream('/user', 'GET', None, bearer), owner, True)
            with self.factory.begin() as session:
                authority_user, current = self._active(session, owner, intent)
                if current['state'] != 'old_verifying':
                    reject('old_authorization_changed')
                if current['authority_kind'] == 'email' and not self._has_email_proof(session, owner, canonical_email(authority_user['email'])):
                    reject('current_email_proof_changed', 403)
                address, _ = self._address('phone', target, owner, session=session)
                self._reserve_target(session, current, address)
                session.execute(text("UPDATE account_next.intents SET authority_verified=true,state='requesting' WHERE intent=:intent"), {'intent': current['intent']})
        except Exception:
            self._uncertain(owner, intent, 'old_verifying')
        return self.status(owner, intent)

    def request_native(self, owner, intent, target, bearer):
        with self.factory.begin() as session:
            _, op = self._active(session, owner, intent)
            if op['state'] != 'requesting' or op['request_claimed'] or (op['kind'] == 'phone' and not op['authority_verified']):
                reject('native_request_already_claimed')
            address, digest = self._address(op['kind'], target, owner, session=session)
            if digest != op['target_digest']:
                reject('target_mismatch', 403)
            redirect = self._native_request_redirect(op) if op['kind'] == 'email' else None
            session.execute(text('UPDATE account_next.intents SET request_claimed=true WHERE intent=:intent'), {'intent': op['intent']})
        try:
            payload = {op['kind']: address}
            if op['kind'] == 'phone':
                payload['channel'] = 'sms'
            if redirect is not None:
                result = self.upstream('/user', 'PUT', payload, bearer, redirect_to=redirect)
            else:
                result = self.upstream('/user', 'PUT', payload, bearer)
            self._same_uid(result, owner, True)
        except Exception:
            self._uncertain(owner, intent, 'requesting')
        return self.status(owner, intent)

    def capture_email_change(self, event, user, email_data):
        """INTERNAL signed Send Email Hook branch; atomically reserve TWO sends.

        Caller verifies the signature before invocation and does not run the
        first-empty-email handler for this explicit email_change branch.
        No native token_hash is stored, returned, or logged.
        """
        owner = str(UUID(user.get('id', '')))
        with self.factory.begin() as session:
            self._native_hook_locks(session)
            current, _ = self._gate(session, owner, kind='email')
            intent = session.execute(text("SELECT intent::text FROM account_next.intents WHERE owner=CAST(:owner AS uuid) AND kind='email' AND state='requesting' AND request_claimed"), {'owner': owner}).scalar_one_or_none()
            if not intent or email_data.get('email_action_type') != 'email_change':
                reject('signed_email_change_not_requested', 403)
            _, op = self._active(session, owner, intent)
            redirect = email_data.get('redirect_to')
            expected_redirect = self._native_request_redirect(op)
            if not isinstance(redirect, str) or not redirect.isascii() or len(redirect) > 2048 or not hmac.compare_digest(redirect, expected_redirect):
                reject('signed_native_request_mismatch', 403)
            old, old_digest = self._address('email', user.get('email'), owner)
            new, new_digest = self._address('email', user.get('new_email'), owner)
            if old_digest != op['old_digest'] or new_digest != op['target_digest'] or canonical_email(current['email']) != old:
                reject('signed_email_intent_mismatch', 403)
            # v2.197.0 mail.go: token_hash is NEW; token_hash_new is CURRENT.
            # Validate the exact signed raw address/OTP pair before reserving sends.
            if not valid_channel_code('email', 'old', email_data.get('token')) or not valid_channel_code('email', 'new', email_data.get('token_new')):
                reject('unsupported_native_code_contract', 403)
            old_hash = signed_native_hash(user.get('email'), email_data['token'], email_data.get('token_hash_new', ''))
            new_hash = signed_native_hash(user.get('new_email'), email_data['token_new'], email_data.get('token_hash', ''))
            if old_hash.startswith('pkce_') != new_hash.startswith('pkce_'):
                reject('signed_native_flow_mismatch', 403)
            if not self._has_email_proof(session, owner, old) or not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', event):
                reject('email_authority_or_event_invalid', 403)
            if not self.enabled and not self.contract_probe.pair_ledger_matches(session.execute(text('SELECT count(*) FROM public.account_email_send_reservations')).scalar_one()):reject('contract_probe_pair_consumed_or_budget_drift',429)
            if session.execute(text('SELECT count(*) FROM public.account_email_send_reservations')).scalar_one() + 2 > self.email.total:
                reject('email_pair_budget_exhausted', 429)
            self.email._reserve(session, event+'-old', owner, self.email._digest('address', owner, old), 'verification', self._now())
            # Same transaction: bypass ONLY per-owner cooldown for second leg.
            # Do not bypass total budget, unique event, or the first leg checks.
            session.execute(text("INSERT INTO public.account_email_send_reservations(event_id,owner,email_digest,purpose,reserved_at) VALUES(:event,:owner,:digest,'verification',:at)"), {'event': event+'-new', 'owner': owner, 'digest': self.email._digest('address', owner, new), 'at': self._now()})
            self._save_code(session, op, 'old', email_data['token'], native_fp=fingerprint(str(op['intent']), new, old_hash))
            self._save_code(session, op, 'new', email_data['token_new'], native_fp=fingerprint(str(op['intent']), new, new_hash))
            session.execute(text("UPDATE account_next.intents SET state='pending' WHERE intent=:intent"), {'intent': op['intent']})
        # The ledger stays reserved after either failure. No retry in this hook.
        self.change_delivery.send(old, email_data['token'], 'channel-old')
        self.change_delivery.send(new, email_data['token_new'], 'channel-new')

    def verify_native(self, owner, intent, leg, token, target, bearer):
        user, op = self._claim_code(owner, intent, leg, token, target)
        address, _ = self._address(op['kind'], target, owner)
        payload = {'token': token, 'type': op['kind']+'_change'}
        payload[op['kind']] = canonical_email(user['email']) if op['kind'] == 'email' and leg == 'old' else address
        try:
            result = self.upstream('/verify', 'POST', payload, bearer)
            self._same_uid(result, owner)  # native email half has no user/session
        except Exception:
            self._uncertain(owner, intent, 'verifying')
        # Native trigger receipt, not HTTP wording, decides pending/final.
        return self.status(owner, intent, bearer=bearer)

    def _uncertain(self, owner, intent, expected):
        with self.factory.begin() as session:
            self._inspect(session, owner)
            session.execute(text("UPDATE account_next.intents SET state='uncertain',verify_leg=NULL WHERE intent=CAST(:intent AS uuid) AND owner=CAST(:owner AS uuid) AND state=:expected"), {'owner': owner, 'intent': intent, 'expected': expected})

    def approved_sms_recipient(self, phone):
        """Narrow fallback for the existing gate's recipient policy, not quota.

        Original approved_recipient remains FIRST in a future composite policy.
        Accept only a captured old/new challenge of an allowlisted intent.
        """
        if not self.enabled or 'phone' not in self.enabled_channels:
            return None
        digest = self.account.budget.phone_digest(phone)
        if not digest:
            return None
        with self.factory.begin() as session:
            self.account._lock(session)
            self.email._lock(session)
            if schema_revision(session) != REVISION:
                return None
            rows = session.execute(text("SELECT owner::text,intent::text,state,authority_kind,authority_digest,target_digest FROM account_next.intents WHERE state IN('old_pending','pending') AND expires_at>:now AND ((authority_kind='phone' AND authority_digest=:digest) OR (kind='phone' AND target_digest=:digest))"), {'now': self._now(), 'digest': digest}).mappings().all()
            for row in rows:
                _, op = self._active(session, row['owner'], row['intent'])
                if (op['state'] == 'old_pending' and op['authority_kind'] == 'phone' and op['authority_digest'] == digest) or (op['state'] == 'pending' and op['kind'] == 'phone' and op['authority_verified'] and op['target_digest'] == digest):
                    return digest
        return None

    def assert_first_email_target_available(self, user):
        """Additive first-binding Hook guard, retained even when start is OFF.

        Does not replace the original guard, grant proof, or write Auth. Must be
        installed on the only signed email dispatch before enabling changes.
        """
        if not self.reservation_guard_installed:
            return
        address = canonical_email(user.get('new_email'))
        if not address:
            reject('invalid_first_email_target', 403)
        digest = self.email._digest('channel-email-address-v2', address)
        with self.factory.begin() as session:
            self.account._lock(session)
            self.email._lock(session)
            if schema_revision(session) != REVISION:
                return
            if session.execute(text("SELECT count(*) FROM account_next.reservations WHERE kind='email' AND target_digest=:digest"), {'digest': digest}).scalar_one():
                reject('first_email_target_held', 403)

    def probe_send_allowed(self,session,event,owner,digest,purpose):
        # Caller already holds EMAIL. Pure queries: no PHONE or new sessions.
        # Original quota/cooldown/unique-event/authority checks still follow.
        probe=self.contract_probe
        if not probe:return True
        if not probe.owner_live(owner,self.clock()) or purpose!='verification':return False
        count=session.execute(text('SELECT count(*) FROM public.account_email_send_reservations')).scalar_one()
        if count==4 and isinstance(event,str) and event.endswith('-old'):
            op=session.execute(text('SELECT * FROM account_next.intents WHERE intent=CAST(:intent AS uuid)'),{'intent':probe.intent}).mappings().one_or_none()
            return bool(op and probe.intent_matches(op) and op['state']=='requesting' and op['request_claimed'])
        if count==6 and isinstance(event,str) and event.startswith('verification-'):
            return self.post_change_mail_allowed(session,owner)
        return False

    def post_change_mail_allowed(self, session, owner):
        """Send eligibility only; no proof write and no new native capability.

        The email-security caller already holds EMAIL. Pure reads avoid taking
        PHONE in reverse order. Current phone + completed enrollment + scoped,
        matching native receipt and epoch are all required. Existing mail
        ledger, cooldown and challenge verification still apply unchanged.
        """
        probing = not self.enabled and self.contract_probe is not None
        if probing and (not self.contract_probe.owner_live(owner,self.clock()) or session.execute(text('SELECT count(*) FROM public.account_email_send_reservations')).scalar_one() not in (6,7)):
            return False
        if (not self.enabled and not probing) or 'email' not in self.enabled_channels or schema_revision(session) != REVISION:
            return False
        user = session.execute(text(f'SELECT {FIELDS} FROM auth.users WHERE id=CAST(:owner AS uuid)'), {'owner': owner}).mappings().one_or_none()
        from app.account_next_compat import enrollment_row
        row = enrollment_row(session, owner)
        scope = FeatureScope((self.contract_probe.owner,),()) if probing else self.scope
        if (not row or row['completed_at'] is None or not scope.contains(owner, row)
                or not user or user['is_anonymous'] or not user['phone_confirmed_at']
                or not canonical_mainland_phone(user['phone']) or not user['email_confirmed_at']):
            return False
        address = canonical_email(user['email'])
        if not address or session.execute(text('SELECT enabled FROM account_next.policy WHERE singleton')).scalar_one_or_none() is not True:
            return False
        digest = self.email._digest('channel-email-address-v2', address)
        if probing and not self.contract_probe.target_matches(digest):return False
        return bool(session.execute(text("""SELECT count(*) FROM account_next.intents i
            JOIN account_next.epochs e ON e.owner=i.owner
            JOIN account_next.reservations r ON r.intent=i.intent AND r.owner=i.owner
              AND r.kind='email' AND r.target_digest=i.target_digest
            WHERE i.owner=CAST(:owner AS uuid) AND i.kind='email'
              AND i.state IN('native_confirmed','completed') AND i.native_confirmed_at IS NOT NULL
              AND i.authority_verified AND i.new_verified AND i.request_claimed
            AND e.epoch=i.base_epoch+1 AND i.target_digest=:digest
            AND (:probing IS FALSE OR i.intent=CAST(:probe_intent AS uuid))"""), {'owner': owner, 'digest': digest, 'probing':probing, 'probe_intent':self.contract_probe.intent if probing else None}).scalar_one())

    def proven_email_recovery_allowed(self, session, owner):
        """Current proved-email recovery, distinct from new-proof transition.

        No change-entry flag, policy or past receipt epoch dependency. A later
        legitimate phone change cannot revoke the current independent email
        proof. Return None only for legacy identities with no enrollment row,
        letting their original mail scope remain authoritative.
        """
        from app.account_next_compat import ENROLLMENT_REVISIONS, enrollment_row
        from app.email_enrollment import configured_enrollment_email_digests
        if schema_revision(session) not in ENROLLMENT_REVISIONS:
            return None
        row = enrollment_row(session, owner)
        if row is None:
            return None
        user = session.execute(text(f'SELECT {FIELDS} FROM auth.users WHERE id=CAST(:owner AS uuid)'), {'owner': owner}).mappings().one_or_none()
        # Preserve the original recovery scope when new channel actions are
        # closed. Admission to change a channel never revokes existing proof.
        original_scope = (owner in self.email.allowed or row['address_digest']
                          in configured_enrollment_email_digests(self.email))
        if (row['completed_at'] is None or not (original_scope or self.scope.contains(owner, row))
                or not user or str(user['id']) != owner or user['is_anonymous']
                or not user['phone_confirmed_at'] or not canonical_mainland_phone(user['phone'])
                or not user['email_confirmed_at']):
            return False
        address = canonical_email(user['email'])
        return bool(address and self._has_email_proof(session, owner, address))

    def cancel(self, owner, intent):
        with self.factory.begin() as session:
            self._inspect(session, owner)
            op = self._load(session, owner, intent)
            if op['state'] not in TERMINAL and op['state'] != 'native_confirmed':
                session.execute(text("UPDATE account_next.intents SET state='cancelled_holding',verify_leg=NULL WHERE intent=:intent"), {'intent': op['intent']})
                session.execute(text("UPDATE account_next.codes SET code_digest='',native_fingerprint=CASE WHEN :kind='email' THEN native_fingerprint ELSE NULL END WHERE intent=:intent"), {'intent': op['intent'], 'kind': op['kind']})
        return self.status(owner, intent)

    def status(self, owner, intent=None, bearer=None):
        with self.factory.begin() as session:
            user, epoch = self._inspect(session, owner)
            if intent is None:
                # Stable owner-scoped restart recovery; no target, code, send,
                # native verify or new intent is created by this lookup.
                intent = session.execute(text("SELECT intent::text FROM account_next.intents WHERE owner=CAST(:owner AS uuid) ORDER BY CASE WHEN state NOT IN('completed','cancelled_holding','expired_holding','invalidated') THEN 0 ELSE 1 END,created_at DESC,intent DESC LIMIT 1 FOR UPDATE"), {'owner': owner}).scalar_one_or_none()
                if intent is None:
                    return {'intent': None, 'state': 'none', 'authorityKind': None,
                            'requestClaimed': False, 'sessionAdopted': False}
            op = self._load(session, owner, intent)
            state = self._retire_stale(session, op, epoch)
            from app.account_next_release_status import owned_release_status
            release = owned_release_status(session, owner, intent)
            if state == 'native_confirmed':
                _, actual = self._receipt_address(op['kind'], user[op['kind']], owner)
                confirmed = user[op['kind']+'_confirmed_at']
                if epoch != op['base_epoch']+1 or actual != op['target_digest'] or not confirmed:
                    reject('native_commit_receipt_mismatch', 403)
        # Final SAME UID read through the ORIGINAL caller bearer; discard any
        # native /verify session. Network IO stays outside application locks.
        if state == 'native_confirmed' and bearer:
            native = self._same_uid(self.upstream('/user', 'GET', None, bearer), owner, True)
            _, actual = self._receipt_address(op['kind'], native.get(op['kind']), owner)
            if actual != op['target_digest'] or not native.get(op['kind']+'_confirmed_at'):
                reject('native_final_read_mismatch', 403)
            with self.factory.begin() as session:
                user, epoch = self._inspect(session, owner)
                current = self._load(session, owner, intent)
                _, actual = self._receipt_address(current['kind'], user[current['kind']], owner)
                if current['state'] != 'native_confirmed' or epoch != current['base_epoch']+1 or actual != current['target_digest']:
                    reject('finalization_epoch_changed', 403)
                session.execute(text("UPDATE account_next.intents SET state='completed' WHERE intent=:intent"), {'intent': current['intent']})
                state = 'completed'
                release = owned_release_status(session, owner, intent)
        return {'intent': str(op['intent']), 'kind': op['kind'], 'state': state,
                # Owned persistent facts for restart continuation; no address,
                # code/hash, sending capability or automatic resend is exposed.
                'authorityKind': op['authority_kind'], 'requestClaimed': bool(op['request_claimed']),
                'authorityVerified': op['authority_verified'], 'newVerified': op['new_verified'],
                'expiresIn': max(0, int((op['expires_at']-self._now()).total_seconds())),
                'sessionAdopted': False, **release}
