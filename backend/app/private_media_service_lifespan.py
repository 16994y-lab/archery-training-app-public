"""Default-off continuous private media service with fresh bounded fact leases.

Approval of a service is distinct from every <=300s observed lease. Each due
request performs the real metadata GET and original same-SessionLocal catalog
collector. Missing object/global-capacity evidence stays unknown and closed.
Optional archive facts share this coordinator; no automatic writes or training consent.
"""
from __future__ import annotations

from contextlib import asynccontextmanager
from dataclasses import dataclass
import hashlib
import math
import os
import re
from threading import Lock, RLock
import time

from .private_media_bootstrap import (RuntimeMediaFacts, StorageKeyAttestation,
    RuntimeArchiveAttestation, RuntimeObjectArchiveAttestation, _bind_runtime_archive)
from .supabase_archive_object_store import object_archive_facts_valid
from .private_media_storage_facts import StorageBucketMetadataReader, StorageMetadataApproval, SERVER_KEY_ENV
from .supabase_private_media_store import APPROVED_ORIGIN, MAX_OBJECT_BYTES, MEDIA_MIME_TYPES, StorageProtectionEvidence


@dataclass(frozen=True, repr=False)
class MediaServicePolicy:
    """Reviewed internal service authorization, NOT bucket/permission evidence."""
    approved: bool = False
    operation_id: str = ""
    source_sha256: str = ""
    receipt_id: str = ""
    bucket: str = ""
    key_sha256: str = ""
    approved_backend_role: str = ""
    approved_at: float | None = None
    expires_at: float | None = None
    lease_seconds: int = 120
    cooldown_seconds: int = 30
    max_admission_seconds: float = 10


@dataclass(frozen=True, repr=False)
class MediaServiceCapabilities:
    """Independent trusted actual permissions/global-limit receipt.

    Metadata GET cannot produce these facts. No JSON/public input is accepted.
    Binding/hash/flags are reject-only checks, not a new independent observation.
    Root must review provenance before supplying this object or replacing it.
    """
    operation_id: str
    source_sha256: str
    receipt_id: str
    origin: str
    bucket: str
    key_sha256: str
    verified_at: float
    expires_at: float
    object_read_allowed: bool | None = None
    object_insert_allowed: bool | None = None
    global_file_size_limit: int | None = None


def _number(value):
    try:
        return type(value) in (int, float) and math.isfinite(value)
    except OverflowError:
        return False


def _match(pattern, value):
    return type(value) is str and re.fullmatch(pattern, value) is not None


def _policy_valid(p):
    return (type(p) is MediaServicePolicy and p.approved is True
        and _match(r"[A-Za-z0-9_-]{1,96}", p.operation_id)
        and _match(r"[A-Za-z0-9_-]{1,128}", p.receipt_id)
        and _match(r"[0-9a-f]{64}", p.source_sha256)
        and _match(r"[0-9a-f]{64}", p.key_sha256)
        and _match(r"[a-z0-9][a-z0-9_-]{2,62}", p.bucket)
        and _match(r"[a-zA-Z_][a-zA-Z0-9_]{0,62}", p.approved_backend_role)
        and p.approved_backend_role not in {"anon", "authenticated", "PUBLIC"}
        and _number(p.approved_at) and _number(p.expires_at) and p.approved_at < p.expires_at
        and type(p.lease_seconds) is int and 60 <= p.lease_seconds <= 300
        and type(p.cooldown_seconds) is int and 30 <= p.cooldown_seconds <= 300
        and _number(p.max_admission_seconds) and 1 <= p.max_admission_seconds <= 10)


def _capabilities_valid(c, p, now):
    return (type(c) is MediaServiceCapabilities
        and c.operation_id == p.operation_id and c.source_sha256 == p.source_sha256
        and _match(r"[A-Za-z0-9_-]{1,128}", c.receipt_id)
        and c.origin == APPROVED_ORIGIN and c.bucket == p.bucket and c.key_sha256 == p.key_sha256
        and _number(c.verified_at) and _number(c.expires_at)
        and c.verified_at <= now < c.expires_at <= c.verified_at + 86400
        and c.object_read_allowed is True and c.object_insert_allowed is True
        and type(c.global_file_size_limit) is int
        and MAX_OBJECT_BYTES <= c.global_file_size_limit <= 2**63 - 1)


class _Stopped(Exception):
    pass


class ContinuousMediaService:
    """Private synchronous request coordinator; one in-flight probe per process.

    Default transport is the real provider. environment/transport are test seams,
    never a receipt factory. Existing runtime performs its actual PG collector.
    Deadlines reject late work; they do not hard-kill a blocking network driver.
    """
    def __init__(self, runtime, application, *, policy=None, capabilities=None,
                 environment=None, transport=None, clock=time.time, monotonic=time.monotonic,
                 archive_attestation=None):
        self._runtime, self._application = runtime, application
        self._policy, self._capabilities = policy, capabilities
        self._archive_attestation=archive_attestation
        self._archive_requested=archive_attestation is not None
        self._environment, self._transport = environment, transport
        self._clock, self._monotonic = clock, monotonic
        self._gate, self._probe = RLock(), Lock()
        self._token = object()
        self._active = False
        self._started = False
        self._epoch = self._attempt = 0
        self._expires = None
        self._next_probe = None
        self._last_wall = self._last_mono = None
        self._reader = None
        self._status = "disabled"

    @property
    def status(self):
        with self._gate:
            return self._status

    def _time(self):
        wall, mono = self._clock(), self._monotonic()
        if (not _number(wall) or not _number(mono)
                or (self._last_wall is not None and wall < self._last_wall)
                or (self._last_mono is not None and mono < self._last_mono)):
            raise _Stopped()
        self._last_wall, self._last_mono = wall, mono
        return wall, mono

    def _alive(self, epoch=None, deadline=None):
        with self._gate:
            if (not self._active or not self._runtime.operator_owned(self._token)
                    or (epoch is not None and epoch != self._epoch)):
                raise _Stopped()
            wall, mono = self._time()
            if (not self._policy.approved_at <= wall < self._policy.expires_at
                    or (deadline is not None and mono >= deadline)):
                raise _Stopped()
            return wall, mono

    def _archive_valid(self,a,now):
        if a is None:return not self._archive_requested
        if type(a) is RuntimeObjectArchiveAttestation:
            return object_archive_facts_valid(a,now) and a.operation_id==self._policy.operation_id and a.source_sha256==self._policy.source_sha256 and a.key_sha256==self._policy.key_sha256
        if type(a) is RuntimeArchiveAttestation:
            try:
                _bind_runtime_archive(a,1,min(a.expires_at,self._policy.expires_at),self._clock)
                return True
            except Exception:return False
        return False

    def replace_archive_attestation(self,value):
        # Internal review replacement, never a public authorization/fact producer.
        with self._gate:
            if not self._active or not self._runtime.operator_owned(self._token):return False
            self._epoch+=1;self._expires=None;self._archive_attestation=value
            if self._reader is not None:self._reader.revoke()
            self._runtime.renew_operator(self._token)
            self._status="archive-facts-replaced-awaiting-readback"
            return True

    def start(self):
        # The default path does not call runtime, clock, environment or HTTP.
        if not _policy_valid(self._policy) or not isinstance(self._runtime, RuntimeMediaFacts):
            return False
        with self._gate:
            if self._started:
                return False
            self._started = True
            try:
                wall, _ = self._time()
                if not self._policy.approved_at <= wall < self._policy.expires_at or not self._archive_valid(self._archive_attestation,wall):
                    return False
                if self._runtime.claim_operator(self._token) is None:
                    return False
                self._active = True
                if not self._runtime.install_continuous_dependency(self._application,
                        self._token, self.ensure_lease, archive_requested=self._archive_requested):
                    self.stop()
                    return False
                self._status = "waiting-for-request"
                return True
            except Exception:
                self.stop()
                return False

    def stop(self):
        with self._gate:
            self._active = False
            self._epoch += 1
            self._expires = None
            if self._reader is not None:
                self._reader.revoke()
            if isinstance(self._runtime, RuntimeMediaFacts):
                self._runtime.revoke_operator(self._token)
            self._status = "revoked"

    def replace_capabilities(self, capabilities):
        """Trusted internal receipt replacement; no IO or public endpoint.

        Replacing with unknown/invalid facts closes immediately. Cooldown is not
        reset, and this method cannot reactivate a revoked/replaced operator.
        """
        with self._gate:
            if not self._active or not self._runtime.operator_owned(self._token):
                return False
            self._epoch += 1
            self._expires = None
            self._capabilities = capabilities
            if self._reader is not None:
                self._reader.revoke()
            self._runtime.renew_operator(self._token)
            self._status = "facts-replaced-awaiting-readback"
            return True

    def _key(self, epoch, expires):
        with self._gate:
            now, _ = self._alive(epoch)
            if now >= expires:
                raise _Stopped()
        environment = os.environ if self._environment is None else self._environment
        value = environment.get(SERVER_KEY_ENV)
        with self._gate:
            now, _ = self._alive(epoch)
            if (now >= expires or type(value) is not str or not value or len(value) > 8192
                    or hashlib.sha256(value.encode("utf-8")).hexdigest() != self._policy.key_sha256):
                raise _Stopped()
        return value

    def ensure_lease(self):
        with self._gate:
            if not self._active or not self._runtime.operator_owned(self._token):
                return False
            try:
                now, mono = self._alive()
                if self._expires is not None and now < self._expires:
                    return True
                if self._next_probe is not None and mono < self._next_probe:
                    return False
                if not self._probe.acquire(blocking=False):
                    return False
                self._epoch += 1
                epoch = self._epoch
                generation = self._runtime.renew_operator(self._token)
                if generation is None:
                    self._probe.release()
                    return False
                self._expires = None
                self._attempt += 1
                self._next_probe = mono + self._policy.cooldown_seconds
                self._status = "collecting"
                capabilities = self._capabilities
                archive_attestation=self._archive_attestation
                deadline = mono + self._policy.max_admission_seconds
            except Exception:
                self.stop()
                return False
        reader = None
        try:
            policy = self._policy
            if not _capabilities_valid(capabilities, policy, now) or not self._archive_valid(archive_attestation,now):
                raise _Stopped()
            approval = StorageMetadataApproval(True,
                f"{policy.operation_id}_{self._attempt}", policy.receipt_id,
                policy.source_sha256, policy.bucket, policy.key_sha256, now,
                min(now + policy.max_admission_seconds, policy.expires_at, capabilities.expires_at),
                policy.max_admission_seconds)
            reader = StorageBucketMetadataReader(environment=self._environment,
                transport=self._transport, clock=self._clock, monotonic=self._monotonic)
            with self._gate:
                self._alive(epoch, deadline)
                self._reader = reader
            observed = reader.collect(approval)
            with self._gate:
                now, mono = self._alive(epoch, deadline)
            if observed is None or not _capabilities_valid(capabilities, policy, now) or not self._archive_valid(archive_attestation,now):
                raise _Stopped()
            facts = observed.facts
            if (facts.bucket_private is not True or facts.credential_get_accepted is not True
                    or facts.mime_policy_state == "missing" or facts.file_size_policy_state == "missing"
                    or (facts.allowed_mime_types is not None
                        and not MEDIA_MIME_TYPES.issubset(facts.allowed_mime_types))):
                raise _Stopped()
            capacity = capabilities.global_file_size_limit
            if facts.bucket_file_size_limit is not None:
                capacity = min(capacity, facts.bucket_file_size_limit)
            if capacity < MAX_OBJECT_BYTES:
                raise _Stopped()
            expires = min(observed.observed_at + policy.lease_seconds,
                          policy.expires_at, capabilities.expires_at)
            if archive_attestation is not None:expires=min(expires,archive_attestation.expires_at)
            protection = StorageProtectionEvidence(APPROVED_ORIGIN, policy.bucket,
                True, True, MEDIA_MIME_TYPES, capacity, observed.observed_at, expires,
                capabilities.receipt_id)
            attestation = StorageKeyAttestation(protection, observed.approval_receipt_id,
                policy.key_sha256, lambda: self._key(epoch, expires))
            remaining = deadline - mono
            if remaining < 1:
                raise _Stopped()
            admitted = self._runtime.refresh(enabled=True,
                approved_backend_role=policy.approved_backend_role,
                receipt_id=observed.operation_id, storage_attestation=attestation,
                ttl_seconds=policy.lease_seconds, max_admission_seconds=remaining,
                refresh_on_request=False, archive_attestation=archive_attestation,
                _operator_generation=generation)
            with self._gate:
                self._alive(epoch, deadline)
                if not admitted:
                    raise _Stopped()
                self._expires = expires
                self._status = "fresh-lease"
                return True
        except Exception:
            with self._gate:
                # Never revoke a replacement operator or a newer local receipt.
                if epoch == self._epoch and self._runtime.operator_owned(self._token):
                    self._runtime.renew_operator(self._token)
                    self._expires = None
                    self._status = "closed-unconfirmed"
            return False
        finally:
            with self._gate:
                if self._reader is reader:
                    self._reader = None
            self._probe.release()


def make_private_media_service_lifespan(runtime_provider, *, policy=None,
        capabilities=None, environment=None, transport=None, clock=time.time,
        monotonic=time.monotonic, archive_attestation=None):
    """Compose inside existing FastAPI context; yield no replacement state.

    No default lookup/call/clock/log/environment/HTTP. One context entry per
    factory; request-driven probes continue for the approved service interval.
    Root supplies trusted policy/receipts; this does not authorize production.
    """
    entered = False
    entry_lock = Lock()

    @asynccontextmanager
    async def lifespan(application):
        nonlocal entered
        if not _policy_valid(policy):
            yield
            return
        with entry_lock:
            first = not entered
            entered = True
        if not first:
            yield
            return
        controller = None
        try:
            runtime = runtime_provider()
            controller = ContinuousMediaService(runtime, application, policy=policy,
                capabilities=capabilities, environment=environment, transport=transport,
                clock=clock, monotonic=monotonic,archive_attestation=archive_attestation)
            controller.start()
            yield
        finally:
            if controller is not None:
                controller.stop()

    return lifespan
