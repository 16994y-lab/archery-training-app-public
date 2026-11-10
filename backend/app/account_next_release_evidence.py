"""Private operator evidence contract. Missing/live-unknown facts deny release.

Never construct authority from a public request. Root pins reviewed receipt SHAs
and provides a live, non-secret ProviderFacts reader. No default live reader.
"""
from dataclasses import dataclass,asdict
import hashlib,hmac,json,re
from uuid import UUID

def valid_sha(value):return isinstance(value,str) and re.fullmatch('[0-9a-f]{64}',value) is not None
def receipt_sha(receipt):
    return hashlib.sha256(json.dumps(asdict(receipt),sort_keys=True,separators=(',',':')).encode()).hexdigest()

@dataclass(frozen=True)
class ReleaseEvidence:
    owner:str
    intent:str
    target_digest:str
    base_epoch:int
    source_mode:str
    provider_version:str
    public_config_sha256:str
    native_semantics_sha256:str
    bounded_event_receipt_sha256:str
    observed_at:int
    issued_before:int
    all_challenges_expired_by:int
    secure_email_change:bool
    no_inflight_requests:bool
    late_verification_cannot_commit:bool
    no_hidden_challenge_issuance:bool

@dataclass(frozen=True)
class ProviderFacts:
    provider_version:str
    public_config_sha256:str
    native_semantics_sha256:str
    secure_email_change:bool
    observed_at:int

class ReleaseDenied(Exception):
    def __init__(self,code):self.code=code;super().__init__(code)

class PinnedEvidenceVerifier:
    def __init__(self,reviewed_receipts=(),live_provider=None):
        # Each tuple SHA comes from Root's private, separately reviewed facts.
        # Neither JSON request booleans nor a checkbox is an authority source.
        self.receipts={}
        for pinned,receipt in reviewed_receipts:
            if not valid_sha(pinned) or not isinstance(receipt,ReleaseEvidence) or not hmac.compare_digest(pinned,receipt_sha(receipt)):
                raise ValueError('release_evidence_pin_invalid')
            if pinned in self.receipts:raise ValueError('duplicate_release_evidence')
            self.receipts[pinned]=receipt
        self.live_provider=live_provider

    def observe_provider(self):
        # Caller MUST perform any provider IO before opening a PG transaction.
        if not callable(self.live_provider):raise ReleaseDenied('live_provider_facts_unavailable')
        return self.live_provider()

    def verify(self,pinned,*,owner,intent,target_digest,base_epoch,now,current_facts,synthetic_local=False):
        e=self.receipts.get(pinned) if valid_sha(pinned) else None
        if e is None:raise ReleaseDenied('reviewed_native_evidence_unavailable')
        if not valid_sha(e.target_digest) or any(not valid_sha(x) for x in (e.public_config_sha256,e.native_semantics_sha256,e.bounded_event_receipt_sha256)):
            raise ReleaseDenied('native_evidence_digest_invalid')
        try:identical=str(UUID(e.owner))==str(UUID(owner)) and str(UUID(e.intent))==str(UUID(intent))
        except (ValueError,TypeError,AttributeError):identical=False
        if not identical or not hmac.compare_digest(e.target_digest,target_digest) or type(e.base_epoch) is not int or e.base_epoch!=base_epoch:
            raise ReleaseDenied('native_evidence_scope_mismatch')
        if e.source_mode!='hosted_observed' and not (synthetic_local and e.source_mode=='synthetic_local'):
            raise ReleaseDenied('native_evidence_source_unaccepted')
        if any(x is not True for x in (e.secure_email_change,e.no_inflight_requests,e.late_verification_cannot_commit,e.no_hidden_challenge_issuance)):
            raise ReleaseDenied('native_challenge_quiescence_unknown')
        times=(e.observed_at,e.issued_before,e.all_challenges_expired_by,now)
        if any(type(x) is not int for x in times) or not (0<e.issued_before<=e.all_challenges_expired_by<=e.observed_at<=now and now-e.observed_at<=60):
            raise ReleaseDenied('native_evidence_not_fresh_or_not_terminal')
        current=current_facts
        if not isinstance(current,ProviderFacts) or current.secure_email_change is not True or type(current.observed_at) is not int or not 0<=now-current.observed_at<=60:
            raise ReleaseDenied('live_provider_facts_unknown_or_stale')
        if not e.provider_version or (current.provider_version,current.public_config_sha256,current.native_semantics_sha256)!=(e.provider_version,e.public_config_sha256,e.native_semantics_sha256):
            raise ReleaseDenied('native_provider_contract_drift')
        return e

# Independent from ReleaseEvidence: no declaration of zero HTTP/in-flight work.
READ_BARRIER_MODE = 'installed_email_fence_read_barrier_v1'

@dataclass(frozen=True)
class ReadBarrierEvidence:
    owner: str
    intent: str
    target_digest: str
    base_epoch: int
    source_mode: str
    provider_version: str
    public_config_sha256: str
    native_semantics_sha256: str
    service_manifest_sha256: str
    hook_config_sha256: str
    redirect_base_sha256: str
    observed_at: int
    expires_at: int
    mode: str = READ_BARRIER_MODE

@dataclass(frozen=True)
class ReadBarrierServiceFacts:
    # Produced ONLY by the private, fresh deployed-service/Hook/base reader.
    # Constructing this object or hashing local source is not a Hosted readback.
    service_manifest_sha256: str
    hook_config_sha256: str
    redirect_base_sha256: str
    observed_at: int

@dataclass(frozen=True)
class ReadBarrierObservation:
    provider: ProviderFacts
    service: ReadBarrierServiceFacts

class PinnedReadBarrierEvidenceVerifier:
    """Reviewed case plus fresh real readers; database barrier is store-owned.

    Neither incoming JSON nor these dataclasses prove installed protection.
    The only accepting caller must acquire/read the barrier in its transaction.
    Missing readers close the new mode; no legacy quiescence bool is filled in.
    """
    def __init__(self,reviewed_receipts=(),live_provider=None,live_service=None):
        self.receipts={}
        for pinned,receipt in reviewed_receipts:
            if (not valid_sha(pinned) or type(receipt) is not ReadBarrierEvidence
                    or receipt.mode!=READ_BARRIER_MODE
                    or not hmac.compare_digest(pinned,receipt_sha(receipt))):
                raise ValueError('read_barrier_evidence_pin_invalid')
            if pinned in self.receipts:raise ValueError('duplicate_release_evidence')
            self.receipts[pinned]=receipt
        self.live_provider,self.live_service=live_provider,live_service

    def observe_provider(self):
        # No provider/network IO is performed while the release holds PG locks.
        if not callable(self.live_provider) or not callable(self.live_service):
            raise ReleaseDenied('live_protection_facts_unavailable')
        try:
            result=ReadBarrierObservation(self.live_provider(),self.live_service())
        except Exception:
            raise ReleaseDenied('live_protection_facts_unavailable') from None
        return result

    def verify(self,pinned,*,owner,intent,target_digest,base_epoch,now,current_facts,synthetic_local=False):
        e=self.receipts.get(pinned) if valid_sha(pinned) else None
        if e is None:raise ReleaseDenied('reviewed_native_evidence_unavailable')
        digests=(e.target_digest,e.public_config_sha256,e.native_semantics_sha256,
                 e.service_manifest_sha256,e.hook_config_sha256,e.redirect_base_sha256)
        if any(not valid_sha(x) for x in digests):raise ReleaseDenied('native_evidence_digest_invalid')
        try:identical=str(UUID(e.owner))==str(UUID(owner)) and str(UUID(e.intent))==str(UUID(intent))
        except (ValueError,TypeError,AttributeError):identical=False
        if (not identical or not hmac.compare_digest(e.target_digest,target_digest)
                or type(e.base_epoch) is not int or e.base_epoch!=base_epoch):
            raise ReleaseDenied('native_evidence_scope_mismatch')
        if e.source_mode!='hosted_observed' and not (synthetic_local and e.source_mode=='synthetic_local'):
            raise ReleaseDenied('native_evidence_source_unaccepted')
        if (any(type(x) is not int for x in (e.observed_at,e.expires_at,now))
                or not 0<e.observed_at<=now<e.expires_at
                or not 0<e.expires_at-e.observed_at<=300):
            raise ReleaseDenied('read_barrier_evidence_not_fresh')
        if type(current_facts) is not ReadBarrierObservation:
            raise ReleaseDenied('live_protection_facts_unavailable')
        provider,service=current_facts.provider,current_facts.service
        if (type(provider) is not ProviderFacts or type(service) is not ReadBarrierServiceFacts
                or provider.secure_email_change is not True
                or any(type(x) is not int or not 0<=now-x<=60 for x in (provider.observed_at,service.observed_at))):
            raise ReleaseDenied('live_protection_facts_unknown_or_stale')
        if (not e.provider_version or
                (provider.provider_version,provider.public_config_sha256,provider.native_semantics_sha256)
                !=(e.provider_version,e.public_config_sha256,e.native_semantics_sha256)):
            raise ReleaseDenied('native_provider_contract_drift')
        if ((service.service_manifest_sha256,service.hook_config_sha256,service.redirect_base_sha256)
                !=(e.service_manifest_sha256,e.hook_config_sha256,e.redirect_base_sha256)):
            raise ReleaseDenied('installed_service_contract_drift')
        return e
