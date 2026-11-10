"""Continuous authorization with freshly observed short Storage leases.

Authorization is not a Storage fact. Default closed; no startup I/O or DDL.
Metadata/decline never wait for or depend on bucket/key/Storage permissions.
"""
from contextlib import contextmanager
from dataclasses import dataclass,field
from datetime import datetime,timezone
import hashlib,math,os,re,time
from threading import Lock,RLock,local
from app.photo_contributions import PhotoContributions,ContributionPolicy,create_photo_contributions_router,fail
from app.photo_contribution_storage import SupabaseContributionStore,MAX_IMAGE,ContributionDeleteNotDispatched
from app.photo_contribution_retention import ContributionRetention
from app.photo_contribution_installation import require_contribution_schema
from app.photo_contribution_cleanup_routes import create_contribution_cleanup_router,MAX_BATCH
from app.supabase_private_media_store import APPROVED_ORIGIN
from app.private_media_storage_facts import StorageBucketMetadataReader,StorageMetadataApproval,SERVER_KEY_ENV
from app.team_workspace import _transaction


@dataclass(frozen=True,repr=False)
class ContributionDeployment:
    # Stable service authorization until explicit stop/redeployment. These are
    # first real acceptance bindings, NOT expiring facts copied indefinitely.
    approved:bool=False
    acceptance_id:str=''
    source_sha256:str=''
    runtime_role:str='postgres'
    verified_runtime_roles:tuple[str,...]=()
    bucket:str=''
    key_sha256:str=''
    storage_acl_sha256:str=''
    receiver_accepted:bool=False
    deletion_accepted:bool=False
    allowed_models:frozenset[str]=field(default_factory=frozenset)
    allowed_targets:frozenset[tuple[str,str,int]]=field(default_factory=frozenset)


def _approved(p):
    return (type(p) is ContributionDeployment and p.approved is True
        and re.fullmatch(r'[A-Za-z0-9_-]{1,96}',p.acceptance_id or '') is not None
        and re.fullmatch(r'[a-f0-9]{64}',p.source_sha256 or '') is not None)


class _LiveStorage:
    LEASE_SECONDS=120
    def __init__(self,factory,approval,environment,transport,clock,monotonic):
        self.factory,self.approval,self.environment,self.transport=factory,approval,environment,transport
        self.clock,self.monotonic=clock,monotonic
        self._gate,self._probe,self._local=RLock(),Lock(),local()
        self.active=True;self.generation=0;self.expires=0;self.mono_expires=0;self.next_probe=0
        self.store=None;self._last_wall=None;self._last_mono=None;self._clock_fault=False
    def _times(self):
        wall,mono=self.clock(),self.monotonic()
        if self._clock_fault or any(type(v) not in (int,float) or not math.isfinite(v) for v in (wall,mono)):fail(503)
        if self._last_wall is not None and (wall<self._last_wall or mono<self._last_mono):
            self._clock_fault=True;self.generation+=1;self.expires=self.mono_expires=0;fail(503)
        self._last_wall,self._last_mono=wall,mono
        return wall,mono
    def stop(self):
        with self._gate:self.active=False;self.generation+=1;self.expires=self.mono_expires=0
    def guard(self,generation):
        # Pure local admission + current original-process key binding. Does not
        # renew a lease inside SQL or during an in-flight Storage operation.
        with self._gate:
            try:
                wall,mono=self._times();key=self.environment.get(SERVER_KEY_ENV,'')
                deadline=getattr(self._local,'deadline',None)
                return (self.active and generation==self.generation and wall<self.expires and mono<self.mono_expires
                    and (deadline is None or mono<deadline) and type(key) is str and 1<=len(key)<=8192
                    and hashlib.sha256(key.encode()).hexdigest()==self.approval.key_sha256)
            except Exception:return False
    def schema(self,db):
        if not self.active:fail(503)
        facts=require_contribution_schema(db,self.approval.runtime_role,verified_runtime_roles=self.approval.verified_runtime_roles)
        if facts['storageRights'] is not True or facts['storageAclSha256']!=self.approval.storage_acl_sha256:
            with self._gate:self.generation+=1;self.expires=self.mono_expires=0
        return facts
    def ensure(self):
        with self._gate:
            if not self.active:return False
            if self.store is not None and self.store.protection_verified:return True
            try:wall,mono=self._times()
            except Exception:return False
            if mono<self.next_probe or not self._probe.acquire(blocking=False):return False
            self.generation+=1;generation=self.generation;self.expires=self.mono_expires=0
            self.next_probe=mono+30
        try:
            p=self.approval
            if (p.receiver_accepted is not True or p.deletion_accepted is not True
                or re.fullmatch(r'[a-z0-9][a-z0-9_-]{2,62}',p.bucket or '') is None
                or any(re.fullmatch(r'[a-f0-9]{64}',v or '') is None for v in (p.key_sha256,p.storage_acl_sha256))):return False
            # One actual fixed-provider GET, existing original TLS/key parser.
            reader=StorageBucketMetadataReader(environment=self.environment,transport=self.transport,clock=self.clock,monotonic=self.monotonic)
            observed=reader.collect(StorageMetadataApproval(True,p.acceptance_id,p.acceptance_id,p.source_sha256,p.bucket,p.key_sha256,wall,wall+5,5))
            if observed is None:return False
            facts=observed.facts
            if (facts.bucket_private is not True or facts.credential_get_accepted is not True
                or facts.mime_policy_state=='missing' or facts.file_size_policy_state=='missing'
                or (facts.allowed_mime_types is not None and 'image/png' not in facts.allowed_mime_types)
                or (facts.bucket_file_size_limit is not None and facts.bucket_file_size_limit<MAX_IMAGE)):return False
            # Same existing session factory/private transaction. No user fields.
            with _transaction(self.factory) as db:catalog=self.schema(db)
            if catalog['storageRights'] is not True or catalog['storageAclSha256']!=p.storage_acl_sha256:return False
            with self._gate:
                now,current=self._times()
                if not self.active or generation!=self.generation or current-mono>=10:return False
                key=self.environment.get(SERVER_KEY_ENV,'')
                if type(key) is not str or not 1<=len(key)<=8192 or hashlib.sha256(key.encode()).hexdigest()!=p.key_sha256:return False
                store=SupabaseContributionStore(APPROVED_ORIGIN,p.bucket,key,transport=self.transport,clock=self.clock,timeout_seconds=3,live_guard=lambda:self.guard(generation))
                self.expires=now+self.LEASE_SECONDS;self.mono_expires=current+self.LEASE_SECONDS
                self.store=store
                return True
        except Exception:return False
        finally:self._probe.release()
    @property
    def protection_verified(self):return self.store is not None and self.store.protection_verified
    purpose='photo-contribution'
    deletion_supported=True
    def put(self,*args):
        if not self.protection_verified:fail(503)
        return self.store.put(*args)
    def read(self,*args):
        if not self.protection_verified:fail(503)
        return self.store.read(*args)
    def inspect(self,*args):
        if not self.protection_verified:fail(503)
        return self.store.inspect(*args)
    def remove(self,*args):
        if not self.protection_verified:raise ContributionDeleteNotDispatched()
        return self.store.remove(*args)
    @contextmanager
    def cleanup_budget(self):
        self._local.deadline=self.monotonic()+40
        try:yield
        finally:self._local.deadline=None


class _InstalledContributions(PhotoContributions):
    def __init__(self,*args,live,receive=False,**kwargs):
        self._live,self._receive=live,receive
        super().__init__(*args,**kwargs)
    def _ready(self,write=False):
        if not self._live.active:fail(503)
        return super()._ready(write)
    def receiver_ready(self):return self._receive and self._live.active and super().receiver_ready()
    def _receive_start(self):
        if not self._receive or not self._live.ensure():fail(503)
    def public_policy(self):
        if self._receive:self._live.ensure()
        return super().public_policy()
    def write_choice(self,actor,value):
        if value.choice=='participate':self._receive_start()
        return super().write_choice(actor,value)
    def prepare(self,*args):self._receive_start();return super().prepare(*args)
    def upload(self,*args):self._receive_start();return super().upload(*args)
    def finalize(self,*args):self._receive_start();return super().finalize(*args)
    def _request_readback(self,actor,request_id,expected):
        # Fresh protected-Storage facts are needed for current eligibility, even
        # on a cold instance. Keep this bounded probe outside the account SQL.
        if self._receive:self._live.ensure()
        with self._live._gate:
            generation=self._live.generation
            ready_before=self.receiver_ready()
        result=super()._request_readback(actor,request_id,expected)
        # A later concurrent refresh must not make an earlier expired check look
        # authoritative. Preserve the original verified boolean/unavailable DTO.
        with self._live._gate:
            stable_ready=(ready_before and self.receiver_ready()
                and generation==self._live.generation)
        if result['status']=='verified' and self._receive and not stable_ready:
            return self._readback_result('unavailable')
        return result
    def content_status(self,*args):
        # An unknown old upload remains readable when new collection is stopped.
        # Failed refresh yields the original unknown DTO, never a write retry.
        self._live.ensure()
        return super().content_status(*args)


class ContributionRuntime:
    def __init__(self,service,worker,live,cleanup):self.service,self.worker,self.live,self._cleanup=service,worker,live,cleanup
    def stop(self):self.live.stop()
    def cleanup(self,limit):
        if type(limit) is not int or not 1<=limit<=MAX_BATCH or not self._cleanup or not self.live.ensure():fail(503)
        with self.live.cleanup_budget():return self.worker.run_once(limit)
    def cleanup_selected(self,targets):
        # Private operator entry only. The public cron remains service-scoped
        # and accepts no target identifiers or caller-selected batch size.
        self.worker.validate_targets(targets)
        if not self._cleanup or not self.live.ensure():fail(503)
        with self.live.cleanup_budget():return self.worker.run_selected(targets)


def install_photo_contributions(app,factory,*,review=None,environment=None,transport=None,clock=time.time,monotonic=time.monotonic):
    enabled=writes=receive=cleanup=False;origin='';policy=ContributionPolicy()
    env={} # Unapproved install does not inspect process environment or key.
    if _approved(review):
        try:
            env=os.environ if environment is None else environment
            origin=env.get('SUPABASE_URL','').rstrip('/')
            if origin!=APPROVED_ORIGIN:raise ValueError()
            enabled=env.get('PHOTO_CONTRIBUTIONS_ENABLED')=='1'
            writes=enabled and env.get('PHOTO_CONTRIBUTIONS_WRITES_ENABLED')=='1'
            receive=writes and env.get('PHOTO_CONTRIBUTIONS_RECEIVER_ENABLED')=='1'
            cleanup=env.get('PHOTO_CONTRIBUTIONS_CLEANUP_ENABLED')=='1'
            accepted=review.receiver_accepted is True and review.deletion_accepted is True
            policy=ContributionPolicy(purpose='用于改进识箭模型',controller='弓行记运营方',accessors=('原开发者与管理者',),
                retention_policy_id='contribution-90d-optout-7d/v1',retention_days=90,
                deletion_contact='弓行记内「反馈与交流群」入口',facts_verified=accepted,deletion_process_verified=accepted,
                allowed_models=review.allowed_models,allowed_targets=review.allowed_targets)
        except Exception:enabled=writes=receive=cleanup=False;env={};policy=ContributionPolicy()
    live=_LiveStorage(factory,review,env,transport,clock,monotonic)
    now=lambda:datetime.fromtimestamp(clock(),timezone.utc)
    service=_InstalledContributions(factory,service=origin,store=live,policy=policy,enabled=enabled,writes_enabled=writes,
        schema_verified=enabled,schema_guard=live.schema,clock=now,live=live,receive=receive)
    worker=ContributionRetention(factory,service=origin,store=live,enabled=cleanup,schema_guard=live.schema,clock=now)
    runtime=ContributionRuntime(service,worker,live,cleanup)
    app.include_router(create_photo_contributions_router(service))
    app.include_router(create_contribution_cleanup_router(runtime.cleanup,environment=environment))
    return runtime
