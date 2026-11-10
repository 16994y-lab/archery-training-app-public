"""Bounded, explicit contribution cleanup. No scheduler, startup DDL or personal I/O."""
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime,timezone,timedelta
from uuid import uuid4
import hashlib,re
from sqlalchemy import select,func,and_,or_
from fastapi import HTTPException
from app.team_workspace import _transaction
from app.photo_contribution_models import ContributionSample,ContributionReceipt,ContributionDeletion
from app.photo_contribution_storage import safe_error,PREFIX,MAX_IMAGE,ContributionDeleteNotDispatched

@dataclass(frozen=True)
class ContributionCleanupTarget:
    """Private, independently read-back object binding; never an HTTP payload."""
    service:str
    user_id:str
    sample_id:str
    object_id:str
    image_sha256:str
    image_bytes:int
    delete_after:str

class ContributionRetention:
    def __init__(self,factory,*,service,store,enabled=False,schema_guard=None,clock=None):
        self.factory,self.service,self.store=factory,service.rstrip('/'),store
        self.enabled,self.schema_guard=enabled,schema_guard
        self.clock=clock or (lambda:datetime.now(timezone.utc))
    def stamp(self):
        value=self.clock()
        if not isinstance(value,datetime) or value.tzinfo is None:raise safe_error()
        return value.astimezone(timezone.utc).isoformat(timespec='microseconds')
    @contextmanager
    def transaction(self,*,storage_required=True):
        if self.enabled is not True or not re.fullmatch(r'https://[a-zA-Z0-9.-]+',self.service) or getattr(self.store,'purpose',None)!='photo-contribution' or getattr(self.store,'deletion_supported',False) is not True or (storage_required and self.store.protection_verified is not True):raise safe_error()
        with _transaction(self.factory) as db:
            if db.get_bind().dialect.name=='postgresql':
                if not callable(self.schema_guard):raise safe_error()
                self.schema_guard(db)
            yield db
    def cleanup_cutoff(self):
        # delete_after remains the original hard deadline (90d / opt-out 7d).
        # Start 26h early: one daily scheduling window plus documented Hobby
        # timing jitter. This is not a promise against scheduler/provider failure.
        # Withdrawal
        # statuses are immediately eligible, including compatible old rows.
        return (datetime.fromisoformat(self.stamp())+timedelta(hours=26)).isoformat(timespec='microseconds')
    def cleanup_eligible(self,row):
        return row.status in ('withdrawn','deletion_pending') or row.delete_after<=self.cleanup_cutoff()
    @staticmethod
    def key(row):return (row.service,row.user_id,row.sample_id)
    def bound_key(self,key):
        if not isinstance(key,tuple) or len(key)!=3 or key[0]!=self.service or any(not isinstance(v,str) or not re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}',v) for v in key[1:]):raise safe_error()
    def validate_targets(self,targets):
        # Shape errors, cross-service input and duplicate objects fail before I/O.
        if type(targets) is not tuple or not 1<=len(targets)<=25:raise safe_error()
        keys=set();objects=set()
        for target in targets:
            if type(target) is not ContributionCleanupTarget:raise safe_error()
            key=self.key(target);self.bound_key(key)
            if type(target.object_id) is not str or not re.fullmatch(r'[a-f0-9]{32}',target.object_id):raise safe_error()
            if key in keys or target.object_id in objects:raise safe_error()
            if type(target.image_sha256) is not str or not re.fullmatch(r'[a-f0-9]{64}',target.image_sha256):raise safe_error()
            if type(target.image_bytes) is not int or not 1<=target.image_bytes<=MAX_IMAGE:raise safe_error()
            if type(target.delete_after) is not str:raise safe_error()
            try: deadline=datetime.fromisoformat(target.delete_after)
            except ValueError:raise safe_error() from None
            if deadline.tzinfo is None or deadline.utcoffset()!=timedelta(0) or deadline.isoformat(timespec='microseconds')!=target.delete_after:raise safe_error()
            keys.add(key);objects.add(target.object_id)
    def bound_expected(self,row,expected):
        if expected is None:return
        if row is None or any(getattr(row,name)!=getattr(expected,name) for name in ContributionCleanupTarget.__dataclass_fields__):raise safe_error()
    def claim_selected(self,targets):
        self.validate_targets(targets)
        with self.transaction() as db:
            checked=[]
            # Read all exact primary keys before changing any ORM field. A bad
            # member rejects the whole batch, without object-store operations.
            for target in targets:
                key=self.key(target);row=db.get(ContributionSample,key)
                self.bound_expected(row,target)
                if row.storage_scope!=PREFIX or not self.cleanup_eligible(row):raise safe_error()
                job=db.get(ContributionDeletion,key)
                if job is not None:
                    if job.state=='deleted':raise safe_error()
                    self.bound_row(row,job)
                completed=db.scalar(select(ContributionReceipt.request_id).where(
                    ContributionReceipt.service==target.service,
                    ContributionReceipt.user_id==target.user_id,
                    ContributionReceipt.sample_id==target.sample_id,
                    ContributionReceipt.request_id==row.upload_request,
                    ContributionReceipt.operation=='content',ContributionReceipt.state=='done'))
                checked.append((row,job,completed))
            for row,job,completed in checked:
                if job is None:
                    job=ContributionDeletion(service=row.service,user_id=row.user_id,sample_id=row.sample_id,request_id=str(uuid4()),state='fenced',object_id=row.object_id,image_sha256=row.image_sha256,image_bytes=row.image_bytes,version=None,settled=(row.status in ('uploaded','received') or row.received_at is not None or completed is not None),upload_attempted=bool(row.upload_request),delete_attempted=False,checked_at=None)
                    db.add(job)
                job.checked_at=self.stamp()
                row.manifest=None
                row.status='deletion_pending' if row.upload_request else 'withdrawn'
        return targets
    def claim(self,limit):
        with self.transaction() as db:
            join=and_(ContributionDeletion.service==ContributionSample.service,ContributionDeletion.user_id==ContributionSample.user_id,ContributionDeletion.sample_id==ContributionSample.sample_id)
            # Withdrawal changes sample.status but does not erase the original
            # atomic content receipt. Read its exact ownership in this same
            # query, not one extra database round trip per sample.
            completed=and_(ContributionReceipt.service==ContributionSample.service,
                ContributionReceipt.user_id==ContributionSample.user_id,
                ContributionReceipt.sample_id==ContributionSample.sample_id,
                ContributionReceipt.request_id==ContributionSample.upload_request,
                ContributionReceipt.operation=='content',ContributionReceipt.state=='done')
            rows=list(db.execute(select(ContributionSample,ContributionReceipt.request_id).outerjoin(ContributionDeletion,join).outerjoin(ContributionReceipt,completed).where(ContributionSample.service==self.service,ContributionSample.storage_scope==PREFIX,or_(ContributionSample.status.in_(('withdrawn','deletion_pending')),ContributionSample.delete_after<=self.cleanup_cutoff())).order_by(func.coalesce(ContributionDeletion.checked_at,''),ContributionSample.delete_after,ContributionSample.sample_id).limit(limit)).all())
            keys=[]
            for row,completed_upload in rows:
                key=self.key(row);job=db.get(ContributionDeletion,key)
                if job is None:
                    job=ContributionDeletion(service=row.service,user_id=row.user_id,sample_id=row.sample_id,request_id=str(uuid4()),state='fenced',object_id=row.object_id,image_sha256=row.image_sha256,image_bytes=row.image_bytes,version=None,settled=(row.status in ('uploaded','received') or row.received_at is not None or completed_upload is not None),upload_attempted=bool(row.upload_request),delete_attempted=False,checked_at=None)
                    db.add(job)
                job.checked_at=self.stamp()
                row.manifest=None
                row.status='deletion_pending' if row.upload_request else 'withdrawn'
                keys.append(key)
            return keys
    def snapshot(self,key,*,expected=None):
        self.bound_key(key)
        if expected is not None:
            self.validate_targets((expected,))
            if self.key(expected)!=key:raise safe_error()
        with self.transaction() as db:
            job=db.get(ContributionDeletion,key)
            if expected is not None:
                self.bound_expected(db.get(ContributionSample,key),expected)
                if job is None or job.state=='deleted':raise safe_error()
            if job is None:return None
            if job.state!='deleted':self.bound_row(db.get(ContributionSample,key),job)
            return {name:getattr(job,name) for name in ('state','object_id','image_sha256','image_bytes','version','settled','upload_attempted','delete_attempted')}
    def bound_row(self,row,job):
        if row is None or row.storage_scope!=PREFIX or not self.cleanup_eligible(row) or any(getattr(row,k)!=getattr(job,k) for k in ('object_id','image_sha256','image_bytes')):raise safe_error()
    def _finish(self,key,*,expected=None):
        self.bound_key(key)
        with self.transaction() as db:
            job=db.get(ContributionDeletion,key)
            if expected is not None and (job is None or job.state=='deleted'):raise safe_error()
            if job is None or job.state=='deleted':return
            row=db.get(ContributionSample,key)
            self.bound_expected(row,expected)
            self.bound_row(row,job)
            # Retain only account-lifetime opaque operation/sample identifiers;
            # no image SHA, manifest, correction labels or request-body digest.
            for receipt in db.scalars(select(ContributionReceipt).where(ContributionReceipt.service==key[0],ContributionReceipt.user_id==key[1],ContributionReceipt.sample_id==key[2])):
                receipt.body_digest='';receipt.event={};receipt.at=''
            db.delete(row)
            job.state='deleted';job.object_id=None;job.image_sha256=None;job.image_bytes=None;job.version=None
            job.settled=None;job.upload_attempted=None;job.delete_attempted=None;job.checked_at=None
    def _release_not_dispatched(self,key,version,*,expected=None):
        self.bound_key(key)
        # Only reached from the storage adapter's explicit zero-DELETE signal.
        # Recording that fact must survive an expired Storage lease/budget;
        # the same database schema/role/transaction protection still applies.
        with self.transaction(storage_required=False) as db:
            job=db.get(ContributionDeletion,key)
            if job is None or job.state=='deleted':return
            row=db.get(ContributionSample,key)
            self.bound_expected(row,expected);self.bound_row(row,job)
            if job.state!='delete_unknown' or job.delete_attempted is not True or job.version!=version:raise safe_error()
            job.delete_attempted=False;job.state='fenced'
    def process(self,key,*,expected=None):
        job=self.snapshot(key,expected=expected)
        if not job or job['state']=='deleted':return 'deleted'
        # A missing object after an unknown PUT does not prove the request cannot
        # still arrive. Read matching immutable bytes once before deleting it.
        found=self.store.inspect(job['object_id'],job['image_bytes'],job['version'])
        if found is None:
            if job['settled'] or not job['upload_attempted']:
                # Exact-version absence does not prove the contribution path is
                # empty: replacement bytes must remain an unresolved exception.
                if job['version'] is not None and self.store.inspect(job['object_id'],job['image_bytes']) is not None:
                    return 'unknown'
                self._finish(key,expected=expected);return 'deleted'
            return 'unknown'
        if hashlib.sha256(found.content).hexdigest()!=job['image_sha256']:return 'unknown'
        with self.transaction() as db:
            current=db.get(ContributionDeletion,key)
            row=db.get(ContributionSample,key)
            self.bound_expected(row,expected)
            if expected is not None and (current is None or current.state=='deleted'):raise safe_error()
            if current is None or current.state=='deleted':return 'deleted'
            self.bound_row(row,current)
            # Another worker may have pinned a version after this worker's
            # snapshot. Never overwrite the original delete attempt's identity.
            if current.version is not None and current.version!=found.version:return 'unknown'
            current.settled=True;current.version=found.version
            first=current.delete_attempted is False
            if first:current.delete_attempted=True;current.state='delete_unknown'
        if first:
            try:self.store.remove(job['object_id'],job['image_bytes'],found.version)
            except ContributionDeleteNotDispatched:
                self._release_not_dispatched(key,found.version,expected=expected)
                return 'unknown' # Later bounded run, never retry in this run.
            except Exception:pass # Original attempt is persisted; no retry.
        after=self.store.inspect(job['object_id'],job['image_bytes'],found.version)
        if after is None:
            # This is a read only check of the current path, never a second
            # DELETE or permission to remove an unexpected replacement.
            if self.store.inspect(job['object_id'],job['image_bytes']) is not None:return 'unknown'
            self._finish(key,expected=expected);return 'deleted'
        return 'unknown'
    def run_selected(self,targets):
        selected=self.claim_selected(targets)
        result={'examined':len(selected),'deleted':0,'unknown':0}
        for target in selected:
            try:state=self.process(self.key(target),expected=target)
            except Exception:state='unknown'
            result[state]+=1
        return result
    def run_once(self,limit=10):
        if type(limit) is not int or not 1<=limit<=100:raise safe_error()
        keys=self.claim(limit);result={'examined':len(keys),'deleted':0,'unknown':0}
        for key in keys:
            try:state=self.process(key)
            except Exception:state='unknown'
            result[state]+=1
        return result
