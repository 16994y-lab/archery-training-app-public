"""Atomic PostgreSQL reservation gate for the optional Supabase SMS hook.

Total/month cost budgets count attempts, including unknown provider outcomes.
Per-phone daily limits count only explicit provider acceptance. Historical NULL outcomes
stay unknown. No code/phone plaintext, pruning, retroactive inference, or replay.
"""

from __future__ import annotations

import hashlib
import hmac
import math
import os
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from sqlalchemy import text

from app.sms_hook import (
    GateRejected, GateUnavailable, PHONE_INTERVAL_SECONDS, canonical_mainland_phone,
)


# One transaction-level lock serializes quota checks and insertion across all
# Vercel instances sharing this PostgreSQL database. It is released on commit.
_LOCK_KEY = 621662560617157761


# Catalog only: no user/phone/event data. DML explicitly addresses this table.
# Reject functions hidden in constraints, indexes, defaults, policies or rules.
SCHEMA_SQL = """SELECT c.relkind::text AS kind, c.relrowsecurity AS rls,
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
 (SELECT pg_catalog.count(*)=3 AND pg_catalog.bool_and(
  i.indisvalid AND i.indisready AND i.indislive AND i.indimmediate
  AND NOT i.indisexclusion AND i.indexprs IS NULL AND i.indpred IS NULL
  AND i.indnkeyatts=i.indnatts AND am.amname='btree'
  AND ((i.indisprimary AND i.indisunique AND i.indkey::text='1')
   OR (NOT i.indisprimary AND NOT i.indisunique AND i.indkey::text IN ('3','2 4')))
  AND NOT EXISTS(SELECT 1 FROM pg_catalog.unnest(i.indclass) opid
   JOIN pg_catalog.pg_opclass op ON op.oid=opid
   JOIN pg_catalog.pg_namespace ns ON ns.oid=op.opcnamespace
   WHERE ns.nspname<>'pg_catalog'))
  AND pg_catalog.count(DISTINCT i.indkey::text)=3
  FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class ic ON ic.oid=i.indexrelid
  JOIN pg_catalog.pg_am am ON am.oid=ic.relam WHERE i.indrelid=c.oid) AS exact_indexes,
 NOT c.relispartition AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_inherits h
  WHERE h.inhrelid=c.oid OR h.inhparent=c.oid) AS no_inheritance,
 NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid=c.oid
  AND a.attnum>0 AND NOT a.attisdropped
  AND (a.atthasdef OR a.attidentity<>'' OR a.attgenerated<>'')) AS no_column_expressions,
 NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid=c.oid
  AND a.attnum>0 AND NOT a.attisdropped AND (a.attnum,a.attname::text) NOT IN
   ((1,'webhook_id'),(2,'phone_digest'),(3,'utc_day'),(4,'reserved_at'),(5,'outcome'),(6,'completed_at'))) AS exact_column_order,
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
WHERE n.nspname='public' AND c.relname='sms_send_reservations'"""

EXPECTED_COLUMNS = {
    'webhook_id': ['character varying(128)', True],
    'phone_digest': ['character varying(64)', True],
    'utc_day': ['date', True], 'reserved_at': ['timestamp with time zone', True],
    'outcome': ['character varying(24)', False],
    'completed_at': ['timestamp with time zone', False],
}


def require_sms_schema(session):
    rows = session.execute(text(SCHEMA_SQL)).mappings().all()
    if len(rows) != 1:
        raise GateUnavailable
    row = rows[0]
    if (row['kind'] != 'r' or row['rls'] is not True or row['forced_rls'] is not False
            or row['columns'] != EXPECTED_COLUMNS
            or any(row[key] is not True for key in (
                'runtime_owns_table','exact_constraints','exact_indexes','no_inheritance',
                'no_column_expressions','exact_column_order','no_rules','no_policies','no_user_triggers',
                'no_public_acl','public_roles_exist','no_public_access'))):
        raise GateUnavailable


def _integer(raw: str) -> int:
    try:
        return int(raw)
    except (TypeError, ValueError):
        return 0


@dataclass(frozen=True)
class SmsSendBudget:
    total: int = 0
    per_utc_day: int = 0
    per_phone_utc_day: int = 0
    phone_hash_key: str = ""
    allowed_phone_digests: tuple[str, ...] = ()
    unlimited_daily: bool = False
    public_phone_registration: bool = False
    phone_daily_only: bool = False
    daily_reset_at: str = ''
    per_beijing_month: int = 0
    capacity_valid_until: str = ''

    @classmethod
    def from_env(cls) -> SmsSendBudget:
        return cls(
            total=_integer(os.getenv("SMS_HOOK_MAX_TOTAL_SENDS", "")),
            per_utc_day=_integer(os.getenv("SMS_HOOK_MAX_DAILY_SENDS", "")),
            per_phone_utc_day=_integer(os.getenv("SMS_HOOK_MAX_PHONE_DAILY_SENDS", "")),
            phone_hash_key=os.getenv("SMS_HOOK_PHONE_HASH_KEY", ""),
            allowed_phone_digests=tuple(part.strip() for part in
                os.getenv("SMS_HOOK_ALLOWED_PHONE_DIGESTS", "").split(",")
                if part.strip()),
            unlimited_daily=os.getenv('SMS_HOOK_UNLIMITED_TEST_DAILY')=='1',
            public_phone_registration=os.getenv('PUBLIC_PHONE_REGISTRATION_ENABLED')=='1',
            phone_daily_only=os.getenv('SMS_HOOK_PHONE_DAILY_ONLY')=='1',
            daily_reset_at=os.getenv('SMS_HOOK_DAILY_RESET_AT',''),
            per_beijing_month=_integer(os.getenv('SMS_HOOK_MAX_MONTHLY_SENDS','')),
            capacity_valid_until=os.getenv('SMS_HOOK_CAPACITY_VALID_UNTIL',''),
        )

    def daily_reset(self) -> datetime | None:
        return self._instant(self.daily_reset_at)

    def capacity_expiry(self) -> datetime | None:
        return self._instant(self.capacity_valid_until)

    @staticmethod
    def _instant(raw) -> datetime | None:
        try:
            value=datetime.fromisoformat(raw.replace('Z','+00:00'))
            return value.astimezone(timezone.utc) if value.tzinfo is not None and 1970<=value.year<=2100 else None
        except (ValueError,TypeError,AttributeError):
            return None

    def ready(self) -> bool:
        if self.phone_daily_only:
            # Explicit public policy, never infer unlimited use from zero or
            # missing configuration. Keep the HMAC recipient identity intact.
            return (1<=self.total<=1500 and self.per_utc_day==0 and self.unlimited_daily
                    and self.per_phone_utc_day==5 and self.public_phone_registration
                    and len(self.phone_hash_key.encode('utf-8'))>=32
                    and self.daily_reset() is not None
                    and 1<=self.per_beijing_month<=self.total
                    and self.capacity_expiry() is not None
                    and self.daily_reset()<self.capacity_expiry())
        # Explicit daily-policy support. The cumulative reservation budget is
        # still a cost boundary; daily policy does not purchase more sends.
        # An optional positive per-phone cap remains effective in this mode.
        daily_ready = (
            self.unlimited_daily and self.per_utc_day == 0
            and 0 <= self.per_phone_utc_day <= min(9, self.total)
        ) or (
            not self.unlimited_daily
            and 1 <= self.per_utc_day <= min(100, self.total)
            and 1 <= self.per_phone_utc_day <= min(9, self.per_utc_day)
        )
        return (1 <= self.total <= 1500
                and daily_ready
                and len(self.phone_hash_key.encode("utf-8")) >= 32
                and (self.public_phone_registration or 1 <= len(self.allowed_phone_digests))
                and len(self.allowed_phone_digests) <= 32
                and len(set(self.allowed_phone_digests)) == len(self.allowed_phone_digests)
                and all(len(value) == 64 and all(char in "0123456789abcdef"
                    for char in value) for value in self.allowed_phone_digests))


    def phone_digest(self, phone: str) -> str | None:
        phone=canonical_mainland_phone(phone)
        if not self.ready() or phone is None:
            return None
        return hmac.new(self.phone_hash_key.encode('utf-8'),phone.encode('ascii'),hashlib.sha256).hexdigest()

    def approved_phone_digest(self, phone: str) -> str | None:
        """Pure recipient policy, shared by signup and send; consumes no quota."""
        digest=self.phone_digest(phone)
        if digest is None:
            return None
        matches = [hmac.compare_digest(digest, allowed)
                   for allowed in self.allowed_phone_digests]
        return digest if any(matches) else None

    def registration_phone_digest(self, phone: str) -> str | None:
        """Explicit public +86 admission; maintenance keeps its own policy."""
        return self.phone_digest(phone) if self.public_phone_registration else self.approved_phone_digest(phone)


class PostgresSendGate:
    """Reserve before calling Aliyun; fail closed on any storage uncertainty."""

    def __init__(self, session_factory, budget: SmsSendBudget, recipient_policy=None, retry_store=None):
        self._session_factory = session_factory
        self._budget = budget
        self._recipient_policy=recipient_policy
        self._retry_store=retry_store

    @contextmanager
    def _transaction(self):
        try:
            with self._session_factory.begin() as session:
                if session.get_bind().dialect.name != 'postgresql':
                    raise GateUnavailable
                from app.team_workspace import _require_private_transaction
                _require_private_transaction(session, factory=self._session_factory)
                # Catalog reads alone do not lock the checked relation. Take a
                # bounded, compatible DML lock before inspecting its catalog so
                # external ALTER/trigger/rule replacement cannot race private SQL.
                session.execute(text('LOCK TABLE ONLY public.sms_send_reservations IN SHARE ROW EXCLUSIVE MODE'))
                require_sms_schema(session)
                session.execute(text('SELECT pg_advisory_xact_lock(:lock_key)'),
                                {'lock_key': _LOCK_KEY})
                if self._retry_store is not None:
                    self._retry_store.lock(session)
                yield session
        except GateRejected:
            raise
        except Exception:
            # Includes COMMIT uncertainty. Do not retry the transaction/send.
            raise GateUnavailable from None

    def finish(self, webhook_id: str, outcome: str, now: float) -> None:
        """One monotone outcome per new event; never rewrite historical NULLs.

        Provider acceptance is not delivery or Auth's later transaction commit.
        Repeating the identical outcome is harmless; an inconsistent transition
        is rejected. This method never calls the provider or retries SQL.
        """
        if outcome not in {'provider_accepted', 'rejected', 'not_dispatched', 'unknown'} or not math.isfinite(now):
            raise GateUnavailable
        instant = datetime.fromtimestamp(now, timezone.utc)
        with self._transaction() as session:
            row = session.execute(text(
                'SELECT outcome, reserved_at FROM public.sms_send_reservations '
                'WHERE webhook_id=:id FOR UPDATE'), {'id': webhook_id}).mappings().one_or_none()
            if row is None or instant < row['reserved_at']:
                raise GateUnavailable
            if row['outcome'] == outcome:
                return
            if row['outcome'] != 'pending':
                raise GateUnavailable
            session.execute(text(
                'UPDATE public.sms_send_reservations SET outcome=:outcome, completed_at=:at '
                "WHERE webhook_id=:id AND outcome='pending'"),
                {'id': webhook_id, 'outcome': outcome, 'at': instant})
            if self._retry_store is not None:
                self._retry_store.finish(session,webhook_id,outcome,instant)

    def retry_after(self, phone: str, now: float) -> int:
        """Read only the remaining phone cooldown, never identity or outcome rows."""
        digest = self._budget.phone_digest(phone)
        if digest is None or not math.isfinite(now):
            raise GateUnavailable
        with self._transaction() as session:
            query=(self._retry_store.cooldown_sql() if self._retry_store is not None else
                   'SELECT max(reserved_at) FROM public.sms_send_reservations WHERE phone_digest=:phone')
            latest = session.execute(text(query), {'phone': digest}).scalar_one()
            return 0 if latest is None else max(0,min(60,math.ceil(latest.timestamp()+60-now)))

    def reserve_for_user(self, webhook_id, phone, now, user, sms):
        challenge=None
        # Current SMS Hook may omit sms_type. Explicit non-login types/new-phone
        # challenges cannot claim the login retry slot. Commit readback below
        # still requires confirmation_token, so absent type alone grants nothing.
        if (isinstance(user,dict) and isinstance(sms,dict) and not user.get('new_phone')
            and canonical_mainland_phone(user.get('phone'))==phone
            and sms.get('sms_type') in (None,'','confirmation')
            and (not sms.get('phone') or canonical_mainland_phone(sms['phone'])==phone)):
            otp=sms.get('otp')
            if isinstance(otp,str) and otp.isascii() and otp.isdigit() and 4<=len(otp)<=10:
                challenge=hashlib.sha224((phone.removeprefix('+')+otp).encode()).hexdigest()
        return self.reserve(webhook_id,phone,now,owner=user.get('id'),challenge_hash=challenge)

    def reserve(self, webhook_id: str, phone: str, now: float, *, owner=None, challenge_hash=None):
        if not self._budget.ready() or not math.isfinite(now):
            raise GateUnavailable
        # The same recipient policy guards new accounts and actual delivery.
        # Rejected numbers never open a DB transaction or reach the provider.
        phone_digest = self._budget.registration_phone_digest(phone)
        if phone_digest is None and self._recipient_policy is not None:
            try:
                approved=self._recipient_policy(phone)
                expected=self._budget.phone_digest(phone)
                if expected and isinstance(approved,str) and hmac.compare_digest(expected,approved):
                    phone_digest=expected
            except Exception:
                raise GateUnavailable from None
        if phone_digest is None:
            raise GateRejected('recipient')
        instant = datetime.fromtimestamp(now, timezone.utc)
        if self._budget.phone_daily_only and instant < self._budget.daily_reset():
            raise GateUnavailable
        if self._budget.phone_daily_only and instant >= self._budget.capacity_expiry():
            raise GateRejected('capacity_expired')
        interval_start = instant - timedelta(seconds=PHONE_INTERVAL_SECONDS)
        try:
            with self._transaction() as session:
                # Aggregate only after acquiring the same transaction lock: a
                # lock embedded in this SELECT could use a pre-wait snapshot.
                values = {"id": webhook_id, "phone": phone_digest,
                          "day": instant.date(), "cutoff": interval_start}
                receipt=None
                if self._retry_store is not None:
                    if owner is None: raise GateUnavailable
                    receipt=self._retry_store.claim(session,webhook_id,phone_digest,owner,instant,challenge_hash)
                if self._budget.phone_daily_only:
                    # Keep Beijing day/month boundaries and the fixed reset;
                    # reset never removes history, deduplication or cooldown.
                    local=instant.astimezone(timezone(timedelta(hours=8)))
                    day_start=local.replace(hour=0,minute=0,second=0,microsecond=0).astimezone(timezone.utc)
                    month_start=local.replace(day=1,hour=0,minute=0,second=0,microsecond=0).astimezone(timezone.utc)
                    month_end=(local.replace(year=local.year+1,month=1,day=1,hour=0,minute=0,second=0,microsecond=0) if local.month==12 else local.replace(month=local.month+1,day=1,hour=0,minute=0,second=0,microsecond=0)).astimezone(timezone.utc)
                    values.update(month_start=month_start, month_end=month_end,
                                  day_start=day_start, day_end=day_start+timedelta(days=1),
                                  reset_at=self._budget.daily_reset())
                    counts = session.execute(text(
                        "SELECT COUNT(*) FILTER (WHERE webhook_id = :id) AS duplicate, "
                        "COUNT(*) AS total, "
                        "COUNT(*) FILTER (WHERE reserved_at >= :month_start "
                        "AND reserved_at < :month_end) AS month_total, "
                        "COUNT(*) FILTER (WHERE phone_digest = :phone "
                        "AND outcome='provider_accepted' "
                        "AND completed_at >= :day_start AND completed_at < :day_end "
                        "AND completed_at >= :reset_at) AS phone_daily, "
                        "MAX(reserved_at) FILTER (WHERE phone_digest = :phone "
                        "AND reserved_at > :cutoff) AS recent "
                        "FROM public.sms_send_reservations"
                    ), values).mappings().one()
                else:
                    counts = session.execute(text(
                        "SELECT COUNT(*) FILTER (WHERE webhook_id = :id) AS duplicate, "
                        "COUNT(*) AS total, "
                        "COUNT(*) FILTER (WHERE utc_day = :day) AS daily, "
                        "COUNT(*) FILTER (WHERE phone_digest = :phone "
                        "AND outcome='provider_accepted' "
                        "AND (completed_at AT TIME ZONE 'UTC')::date = :day) AS phone_daily, "
                        "MAX(reserved_at) FILTER (WHERE phone_digest = :phone "
                        "AND reserved_at > :cutoff) AS recent "
                        "FROM public.sms_send_reservations"
                    ), values).mappings().one()
                # Preserve the existing externally visible rejection priority.
                if counts['duplicate']:
                    raise GateRejected('duplicate')
                if counts['total'] >= self._budget.total:
                    raise GateRejected('total')
                if self._budget.phone_daily_only:
                    if counts['month_total'] >= self._budget.per_beijing_month:
                        raise GateRejected('month')
                elif not self._budget.unlimited_daily and counts['daily'] >= self._budget.per_utc_day:
                    raise GateRejected('day')
                if self._budget.per_phone_utc_day > 0 and counts['phone_daily'] >= self._budget.per_phone_utc_day:
                    raise GateRejected('phone_day')
                if self._retry_store is not None:
                    counts=dict(counts)
                    counts['recent']=session.execute(text(self._retry_store.cooldown_sql()),{'phone':phone_digest}).scalar_one()
                    if counts['recent'] is not None and counts['recent']<=interval_start:
                        counts['recent']=None
                if counts['recent'] and not (receipt and receipt[2]>1):
                    remaining = math.ceil((counts['recent'] + timedelta(seconds=PHONE_INTERVAL_SECONDS) - instant).total_seconds())
                    raise GateRejected('cooldown', retry_after_seconds=max(1, min(60, remaining)))
                session.execute(text(
                    "INSERT INTO public.sms_send_reservations "
                    "(webhook_id, phone_digest, utc_day, reserved_at, outcome) "
                    "VALUES (:id, :phone, :day, :at, 'pending')"
                ), {"id": webhook_id, "phone": phone_digest,
                    "day": instant.date(), "at": instant})
            return receipt
        except GateRejected:
            raise
        except Exception:
            # Do not expose phone, OTP, SQL details or provider credentials.
            raise GateUnavailable from None
