"""Private operator assembly for existing media/ZIP runtime; default zero I/O.

A non-secret operation scope is a request, never Storage/durability proof.
Reviewed external attestations and a protected lazy key callback are separate
inputs. This module reads no environment, secret file, database or HTTP itself,
creates no route/logger/engine, and does not grant user upload/training consent.
Each returned lifespan factory attempts at most once; workers are independent.
"""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from dataclasses import dataclass, replace
import json
import math
import re
from threading import Lock, RLock
import time

from .private_media_bootstrap import (
    RuntimeArchiveAttestation, RuntimeObjectArchiveAttestation, RuntimeMediaActivation, RuntimeMediaFacts,
    StorageKeyAttestation, StorageProtectionEvidence,
)


@dataclass(frozen=True, repr=False)
class MediaActivationScope:
    operation_id: str
    source_sha256: str
    approved_at: float
    expires_at: float
    enabled: bool
    archive_enabled: bool
    ttl_seconds: int
    max_admission_seconds: float
    refresh_on_request: bool


@dataclass(frozen=True, repr=False)
class MediaActivationEvidence:
    """Trusted server receipt data, not a configuration flag or new measurement.

    The source/operation binding must match the separately approved scope. An
    operator must establish the target, bucket/key validity and directory facts
    outside this adapter. Archive facts may be absent for media-only activation.
    """
    operation_id: str
    source_sha256: str
    approved_backend_role: str
    storage: StorageProtectionEvidence
    storage_receipt_id: str
    key_sha256: str
    archive: RuntimeArchiveAttestation | RuntimeObjectArchiveAttestation | None = None


@dataclass(frozen=True, repr=False)
class MediaActivationEvent:
    status: str
    operation_id: str | None = None
    source_sha256: str | None = None
    media_enabled: bool = False
    archive_enabled: bool = False
    attestation_basis: str = "reviewed-caller-input;not-new-provider-proof"
    deployment_source_verified: bool = False
    per_instance_only: bool = True
    schema: str = "private-media-activation/v1"


def _number(value):
    if type(value) not in (int, float):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        return False


def _digest(value):
    return type(value) is str and re.fullmatch(r"[0-9a-f]{64}", value) is not None


def parse_media_activation_scope(raw):
    """Parse only one bounded non-secret JSON scope; never read configuration."""
    if type(raw) is not str or not raw or len(raw) > 4096:
        return None

    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError("duplicate-field")
            result[key] = value
        return result

    def invalid_constant(_):
        raise ValueError("invalid-number")

    try:
        data = json.loads(raw, object_pairs_hook=pairs, parse_constant=invalid_constant)
        if type(data) is not dict or set(data) != set(MediaActivationScope.__dataclass_fields__):
            return None
        s = MediaActivationScope(**data)
        if (type(s.operation_id) is not str or re.fullmatch(r"[A-Za-z0-9_-]{1,128}",s.operation_id) is None
                or not _digest(s.source_sha256)
                or not _number(s.approved_at) or not _number(s.expires_at)
                or not 0 < s.expires_at - s.approved_at <= 300
                or type(s.enabled) is not bool or type(s.archive_enabled) is not bool
                or type(s.refresh_on_request) is not bool
                or type(s.ttl_seconds) is not int or not 60 <= s.ttl_seconds <= 300
                or not _number(s.max_admission_seconds) or not 1 <= s.max_admission_seconds <= 10):
            return None
        return s
    except (ValueError, TypeError, OverflowError, RecursionError):
        return None


class _Stopped(Exception):
    pass


def make_private_media_activation_lifespan(
    runtime_provider, *, scope_provider=None, operator_approved=False,
    evidence_provider=None, key_provider=None, reviewed_source_sha256=None,
    protected_event_sink=None,
):
    """Return a private lifespan context; preserve Root's old outer context/state.

    Providers and sink are trusted synchronous server callbacks. Scope retrieval
    and runtime lookup must be fast; evidence/key retrieval runs in the collector
    thread. The sink is an existing protected service log, not a public response.
    Missing approval/scope provider calls no provider, clock, collector or sink.
    No approved scope is inferred from environment booleans or credential shape.

    The runtime must be the existing Root object with its original SessionLocal.
    A timeout rejects admission and revokes only this operation's opaque token;
    it cannot force-stop synchronous checkout, driver or filesystem work. The
    existing guards reject late results; already completed assets are retained.
    Do not create replacement lifespan factories as an automatic retry.
    """
    attempted = False
    attempt_lock = Lock()

    def emit(status, scope=None, enabled=False):
        if protected_event_sink is None:
            return
        event = MediaActivationEvent(status,
            scope.operation_id if scope else None,
            scope.source_sha256 if scope else None,
            enabled, bool(enabled and scope and scope.archive_enabled))
        try:
            protected_event_sink(event)
        except Exception:
            # No exception repr, fallback logger or retry: sink errors can leak.
            pass

    @asynccontextmanager
    async def lifespan(application):
        nonlocal attempted
        if operator_approved is not True or scope_provider is None:
            yield
            return
        with attempt_lock:
            owns_attempt = not attempted
            attempted = True
        if not owns_attempt:
            yield
            return
        gate = RLock()
        active = True
        runtime = None
        token = object()
        operator_generation = None
        scope = None
        started_wall = started_mono = None

        def stop():
            nonlocal active
            with gate:
                active = False
                if runtime is not None:
                    runtime.revoke_operator(token)

        def alive(*, admission=True, owner=False):
            with gate:
                wall, mono = time.time(), time.monotonic()
                if (not active or not _number(wall) or not _number(mono)
                        or wall < started_wall or mono < started_mono
                        or not scope.approved_at <= wall < scope.expires_at
                        or (admission and mono - started_mono >= scope.max_admission_seconds)
                        or (owner and not runtime.operator_owned(token))):
                    raise _Stopped()

        def lazy_key():
            # Later service/request refresh remains valid for the approved scope,
            # not merely for the startup admission stopwatch.
            alive(admission=False, owner=True)
            value = key_provider()
            alive(admission=False, owner=True)
            return value

        def settings():
            alive(owner=True)
            evidence = evidence_provider(scope)
            alive(owner=True)
            if (type(evidence) is not MediaActivationEvidence
                    or evidence.operation_id != scope.operation_id
                    or evidence.source_sha256 != scope.source_sha256
                    or type(evidence.storage) is not StorageProtectionEvidence
                    or not _digest(evidence.key_sha256)):
                raise _Stopped()
            protection = replace(evidence.storage,
                expires_at=min(evidence.storage.expires_at,scope.expires_at))
            archive = None
            if scope.archive_enabled:
                if type(evidence.archive) not in (RuntimeArchiveAttestation,RuntimeObjectArchiveAttestation):
                    raise _Stopped()
                if type(evidence.archive) is RuntimeObjectArchiveAttestation and (evidence.archive.operation_id!=scope.operation_id or evidence.archive.source_sha256!=scope.source_sha256 or evidence.archive.key_sha256!=evidence.key_sha256):
                    raise _Stopped()
                archive = replace(evidence.archive,
                    expires_at=min(evidence.archive.expires_at,scope.expires_at))
            attestation = StorageKeyAttestation(protection,evidence.storage_receipt_id,
                                              evidence.key_sha256,lazy_key)
            alive(owner=True)
            return RuntimeMediaActivation(True,evidence.approved_backend_role,
                scope.operation_id,attestation,scope.ttl_seconds,
                scope.max_admission_seconds,scope.refresh_on_request,archive)

        def activate():
            alive(owner=True)
            admitted = runtime.apply_operator_settings(settings,approved=True,
                operator_token=token,_operator_generation=operator_generation)
            if not admitted:
                return False
            with gate:
                alive(owner=True)
                return runtime.ensure_installed(application,operator_token=token)

        try:
            if not all(callable(v) for v in (scope_provider,runtime_provider,
                                            evidence_provider,key_provider,protected_event_sink)):
                emit("configuration-incomplete")
            else:
                try:
                    raw = scope_provider()
                    scope = parse_media_activation_scope(raw)
                    if scope is None:
                        if raw:
                            emit("invalid-scope")
                    elif (not _digest(reviewed_source_sha256)
                          or scope.source_sha256 != reviewed_source_sha256):
                        emit("source-attestation-mismatch",scope)
                    elif not scope.enabled:
                        emit("disabled",scope)
                    else:
                        started_wall,started_mono = time.time(),time.monotonic()
                        alive()
                        candidate = runtime_provider()
                        if not isinstance(candidate,RuntimeMediaFacts):
                            raise _Stopped()
                        runtime = candidate
                        with gate:
                            alive()
                            operator_generation = runtime.claim_operator(token)
                            if operator_generation is None:
                                raise _Stopped()
                        admitted = await asyncio.wait_for(asyncio.to_thread(activate),
                            timeout=min(scope.max_admission_seconds,scope.expires_at-started_wall))
                        alive(owner=True)
                        if admitted:
                            emit("admitted",scope,True)
                        else:
                            stop()
                            emit("admission-refused",scope)
                except TimeoutError:
                    stop()
                    emit("timed-out",scope)
                except asyncio.CancelledError:
                    stop()
                    raise
                except Exception:
                    stop()
                    emit("activation-failed",scope)
            yield
        finally:
            stop()

    return lifespan
