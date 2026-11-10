"""Safe business outcomes, not request counters. Caller owns its transaction.

The deployment explicitly enables each stream after readiness checks. Reads and
replays never manufacture successes; no credentials or payloads are collected.
"""
import hashlib
import os
import re
from app.admin_operations_models import BusinessMetricEvent, BusinessMetricStream


def record_business_result(db, stream, actor, operation_id, outcome, code, stamp):
    if os.getenv("OPERATIONS_METRICS_ENABLED") != "1":
        return
    if stream not in ("registration", "claim", "sharing") or outcome not in ("success", "failure", "unknown"):
        raise ValueError("Invalid business outcome")
    if not isinstance(code, str) or not re.fullmatch(r"[a-z][a-z_]{0,39}", code):
        raise ValueError("Invalid outcome classification")
    coverage = db.get(BusinessMetricStream, stream)
    if not coverage or coverage.state != "active":
        return
    key = hashlib.sha256((stream+"|"+actor+"|"+operation_id).encode()).hexdigest()
    old = db.get(BusinessMetricEvent, key)
    if old:
        return
    db.add(BusinessMetricEvent(id=key, stream=stream, outcome=outcome, code=code, at=stamp))
    coverage.refreshed_at = stamp
