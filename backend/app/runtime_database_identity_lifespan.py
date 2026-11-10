"""Private, opt-in startup adapter for the reviewed identity collector.

No environment access, logger configuration, route, feature gate or database SQL
is added here. Root supplies one dedicated non-secret scope and a protected sink.
One attempt is local to this returned lifespan factory; workers/restarts each
have their own instance, so this is NOT a globally-once mechanism. An attested
source hash is not deployment/target verification or production authorization.
"""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from dataclasses import dataclass
import math
import re
from threading import Lock
import time
from typing import Callable

from .runtime_database_identity import (
    DatabaseIdentityReceipt, IdentityCollectionScope, RuntimeDatabaseIdentity,
)


@dataclass(frozen=True, repr=False)
class DatabaseIdentityLifespanEvent:
    status: str
    operation_id: str | None = None
    source_sha256: str | None = None
    receipt: DatabaseIdentityReceipt | None = None
    schema: str = "runtime-database-identity-lifespan/v1"
    per_instance_only: bool = True


def _number(value):
    if type(value) not in (int, float):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        return False


def _valid_scope(scope):
    return (type(scope) is IdentityCollectionScope
            and type(scope.operation_id) is str
            and re.fullmatch(r"[A-Za-z0-9_-]{1,128}", scope.operation_id) is not None
            and type(scope.source_sha256) is str
            and re.fullmatch(r"[0-9a-f]{64}", scope.source_sha256) is not None
            and _number(scope.approved_at) and _number(scope.expires_at)
            and 0 < scope.expires_at - scope.approved_at <= 300
            and _number(scope.max_seconds) and 1 <= scope.max_seconds <= 10)


def make_database_identity_lifespan(
    factory_provider: Callable,
    scope_provider: Callable[[], IdentityCollectionScope | None] | None = None,
    protected_receipt_sink: Callable[[DatabaseIdentityLifespanEvent], None] | None = None,
):
    """Return an async context-manager factory suitable for lifespan composition.

    All providers/sinks must be synchronous, trusted, fast internal callbacks.
    With no scope provider, entry/exit calls no provider, clock, collector or sink.
    A provider returning None is also silent and consumes this instance's attempt.
    A missing sink fails closed before opening a session. No exception text or
    arbitrary provider value is forwarded. Sink failure is not retried.

    Collection runs off the event loop. A bounded await rejects late evidence,
    but cancellation cannot forcibly stop a synchronous DB checkout/driver call.
    The collector owns eventual session cleanup and checks permanent revocation
    when a blocked operation returns. Shutdown also revokes the collector.

    Preserve an existing FastAPI lifespan by nesting this context inside it and
    yielding the original context's state unchanged. This adapter yields None
    and never adds evidence to app.state, public responses or health checks.
    """
    attempted = False
    attempt_lock = Lock()

    def emit(status, scope=None, receipt=None):
        if protected_receipt_sink is None:
            return
        event = DatabaseIdentityLifespanEvent(
            status, scope.operation_id if scope else None,
            scope.source_sha256 if scope else None, receipt)
        try:
            protected_receipt_sink(event)
        except Exception:
            # No retry or fallback logger: even a sink error may contain secrets.
            pass

    @asynccontextmanager
    async def lifespan(_app):
        nonlocal attempted
        if scope_provider is None:
            yield
            return
        with attempt_lock:
            owns_attempt = not attempted
            attempted = True
        if not owns_attempt:
            yield
            return
        collector = None
        scope = None
        try:
            try:
                candidate = scope_provider()
            except Exception:
                emit("scope-provider-failed")
                candidate = None
            if candidate is not None and protected_receipt_sink is not None:
                if not _valid_scope(candidate):
                    emit("invalid-scope")
                else:
                    scope = candidate
                    now = time.time()
                    if not _number(now) or not scope.approved_at <= now < scope.expires_at:
                        emit("scope-inactive", scope)
                    else:
                        try:
                            factory = factory_provider()
                        except Exception:
                            emit("factory-provider-failed", scope)
                        else:
                            try:
                                collector = RuntimeDatabaseIdentity(
                                    factory, reviewed_source_sha256=scope.source_sha256)
                                now = time.time()
                                if not _number(now) or not scope.approved_at <= now < scope.expires_at:
                                    collector.revoke()
                                    emit("scope-inactive", scope)
                                else:
                                    receipt = await asyncio.wait_for(
                                        asyncio.to_thread(collector.collect, scope, approved=True),
                                        timeout=min(scope.max_seconds, scope.expires_at - now))
                                    # The event loop may have resumed after the scope expired.
                                    now = time.time()
                                    if not _number(now) or not scope.approved_at <= now < scope.expires_at:
                                        collector.revoke()
                                        emit("scope-inactive", scope)
                                    elif (type(receipt) is DatabaseIdentityReceipt
                                          and receipt.operation_id == scope.operation_id
                                          and receipt.source_sha256 == scope.source_sha256
                                          and receipt.target_verified is False
                                          and receipt.deployment_source_verified is False):
                                        emit("observed", scope, receipt)
                                    else:
                                        status = collector.status
                                        emit(status if status in {"failed", "cleanup-failed", "revoked"}
                                             else "collection-failed", scope)
                            except TimeoutError:
                                if collector is not None:
                                    collector.revoke()
                                emit("timed-out", scope)
                            except asyncio.CancelledError:
                                if collector is not None:
                                    collector.revoke()
                                # Cancellation is control flow, not a service startup failure.
                                raise
                            except Exception:
                                if collector is not None:
                                    collector.revoke()
                                emit("collection-failed", scope)
            yield
        finally:
            if collector is not None:
                collector.revoke()

    return lifespan
