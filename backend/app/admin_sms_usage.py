"""Administrator-only aggregates of SMS reservations; never delivery or billing claims."""
from datetime import datetime, timedelta, timezone
import json
import os
import re
from fastapi import HTTPException
from sqlalchemy import select, func, case
from sqlalchemy.exc import SQLAlchemyError
from app.sms_send_gate_models import SmsSendReservation
from app.sms_send_gate import SmsSendBudget

BEIJING = timezone(timedelta(hours=8))

# Private configuration is projected only after the existing administrator check.
_CONSOLE_RECONCILIATION_ENV = "GXJ_ADMIN_SMS_CONSOLE_RECONCILIATION_JSON"
_CONSOLE_KEYS = frozenset(("version", "source", "observedAt", "timezone", "usageMonth", "sentMessages", "package"))
_PACKAGE_KEYS = frozenset(("totalMessages", "remainingMessages", "cashPaid", "currency", "purchasedAt", "expiresAt"))
_SAFE_INTEGER = 9007199254740991


def _console_reconciliation(raw, now):
    """Closed, non-realtime administrator snapshot. Invalid or absent means omitted."""
    if type(raw) is not str or not raw or len(raw) > 4096 or not raw.isascii():
        return None
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError()
            result[key] = value
        return result
    def reject_constant(_):
        raise ValueError()
    def integer(value, minimum=0):
        return type(value) is int and minimum <= value <= _SAFE_INTEGER
    def stamp(value):
        if type(value) is not str or re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\+08:00", value) is None:
            raise ValueError()
        parsed = datetime.fromisoformat(value)
        if parsed.isoformat(timespec="seconds") != value:
            raise ValueError()
        return parsed
    try:
        data = json.loads(raw, object_pairs_hook=unique, parse_constant=reject_constant)
        if type(data) is not dict or set(data) != _CONSOLE_KEYS:
            return None
        package = data["package"]
        if (type(data["version"]) is not int or data["version"] != 1 or
            data["source"] != "aliyun-pnvs-console" or data["timezone"] != "Asia/Shanghai" or
            type(package) is not dict or set(package) != _PACKAGE_KEYS):
            return None
        if (not integer(data["sentMessages"]) or not integer(package["totalMessages"], 1) or
            not integer(package["remainingMessages"]) or package["remainingMessages"] > package["totalMessages"] or
            package["currency"] != "CNY" or type(package["cashPaid"]) is not str or
            re.fullmatch(r"(?:0|[1-9][0-9]{0,8})\.[0-9]{2}", package["cashPaid"]) is None):
            return None
        observed = stamp(data["observedAt"])
        purchased = stamp(package["purchasedAt"])
        expires = stamp(package["expiresAt"])
        month = data["usageMonth"]
        if type(month) is not str or re.fullmatch(r"[0-9]{4}-(?:0[1-9]|1[0-2])", month) is None:
            return None
        datetime.strptime(month, "%Y-%m")
        if (now.tzinfo is None or now.utcoffset() is None or observed > now or
            month > data["observedAt"][:7] or purchased > observed or expires <= purchased):
            return None
        return dict(version=1, status="recorded", realtime=False, source="aliyun-pnvs-console",
            observedAt=data["observedAt"], timezone="Asia/Shanghai", usageMonth=month,
            sentMessages=data["sentMessages"], package=dict(totalMessages=package["totalMessages"],
                remainingMessages=package["remainingMessages"], cashPaid=package["cashPaid"],
                currency="CNY", purchasedAt=package["purchasedAt"], expiresAt=package["expiresAt"]))
    except (ValueError, TypeError, OverflowError, RecursionError):
        return None


class AdminSmsUsageMixin:
    def sms_summary(self, actor, body):
        self.ready()
        if type(body) is not dict or set(body) != {"days"} or type(body["days"]) is not int or body["days"] not in (7, 30):
            raise HTTPException(422, "短信查询条件无效")
        now = self.now()
        local = now.astimezone(BEIJING)
        today = local.replace(hour=0, minute=0, second=0, microsecond=0)
        start = today-timedelta(days=body["days"]-1)
        month = today.replace(day=1)
        at = SmsSendReservation.reserved_at
        def count_since(edge):
            return func.coalesce(func.sum(case((at >= edge.astimezone(timezone.utc), 1), else_=0)), 0)
        columns = [func.count(), func.min(at), func.max(at), count_since(today), count_since(month)]
        outcome = SmsSendReservation.outcome
        for state in ('provider_accepted', 'rejected', 'unknown', 'pending'):
            columns.append(func.coalesce(func.sum(case(((outcome.in_(('rejected','not_dispatched')) if state=='rejected' else outcome == state), 1), else_=0)), 0))
        columns.append(func.coalesce(func.sum(case((outcome.is_(None), 1), else_=0)), 0))
        for index in range(body["days"]):
            edge = start+timedelta(days=index)
            columns.append(func.coalesce(func.sum(case(((at >= edge.astimezone(timezone.utc)) &
                (at < (edge+timedelta(days=1)).astimezone(timezone.utc)), 1), else_=0)), 0))
        with self.transaction(actor) as db:
            self._admin(db, actor)
            try:
                row = db.execute(select(*columns).where(at <= now)).one()
            except SQLAlchemyError:
                raise HTTPException(503, "短信预约记录暂不可用") from None
        budget = SmsSendBudget.from_env()
        ready = budget.ready()
        total, first, latest, day_count, month_count, accepted, rejected, uncertain, pending, historical, *counts = row
        def stamp(value):
            if value is None:
                return None
            # SQLite synthetic fixtures lose timezone; Postgres column is timestamptz.
            return value.replace(tzinfo=timezone.utc).isoformat() if value.tzinfo is None else value.astimezone(timezone.utc).isoformat()
        unknown = dict(status="not_collected", count=None)
        result = dict(generatedAt=now.isoformat(), timezone="Asia/Shanghai", days=body["days"],
            reservations=dict(status="available", total=total, today=day_count, thisMonth=month_count,
                firstRecordAt=stamp(first), latestRecordAt=stamp(latest),
                definition="通过限额检查后的发送预约；含供应商失败、超时或结果未知，不包含预约前被拒绝的点击，不等于成功发送或计费条数。",
                buckets=[dict(date=(start+timedelta(days=i)).date().isoformat(), count=count) for i, count in enumerate(counts)]),
            limits=dict(status="configured" if ready else "unavailable", total=budget.total if ready else None,
                remainingReservations=max(0, budget.total-total) if ready else None,
                month=budget.per_beijing_month if ready and budget.phone_daily_only else None,
                monthRemaining=max(0, budget.per_beijing_month-month_count) if ready and budget.phone_daily_only else None,
                perPhoneDay=budget.per_phone_utc_day if ready else None,
                phoneDayTimezone="Asia/Shanghai" if ready and budget.phone_daily_only else "UTC" if ready else None,
                cooldownSeconds=60, validUntil=stamp(budget.capacity_expiry()) if ready and budget.phone_daily_only else None,
                definition="总量与月额度按预约保护成本；每日5次仅统计新账本明确供应商受理成功，失败与未知不计入每日5次。不是套餐余额。"),
            providerAccepted=dict(status="available", count=accepted,
                definition="新账本明确供应商请求受理成功；不等于手机送达或Auth验证码已生效，历史空结果未计入。"),
            providerFailed=dict(status="available", count=rejected,
                definition="新账本明确未调用供应商或供应商明确拒绝；不含写出后超时或未知，未计入每日5次。"),
            providerUnknown=dict(status="available", count=uncertain, pendingCount=pending,
                historicalUnknownCount=historical,
                definition="结果未知、未完成回写和历史空结果分别保留；不能推断成功、失败、送达或扣费。"),
            delivered={**unknown, "definition":"未接入运营商送达回执。"},
            billing=dict(status="not_connected", chargedMessages=None, amount=None, currency="CNY",
                definition="未接入真实账单或套餐消费记录，实际扣费条数、余额和金额未知。"))

        snapshot = _console_reconciliation(os.getenv(_CONSOLE_RECONCILIATION_ENV), now)
        if snapshot is not None:
            result["consoleReconciliation"] = snapshot
        return result
