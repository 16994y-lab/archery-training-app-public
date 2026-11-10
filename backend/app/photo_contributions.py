"""D-123 candidate. Default closed. No DDL, research reader or training job.

SQL transactions reuse the original verified-session guard and bounded lock.
Storage I/O cannot be atomic with SQL: persist the single upload attempt first,
then put once, read fixed bytes, and recheck consent/session before acceptance.
"""
from dataclasses import dataclass, field
from contextlib import contextmanager
from datetime import timedelta
import asyncio
import hashlib
import json
import re
import zlib
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.concurrency import run_in_threadpool
from fastapi.exceptions import RequestValidationError
from fastapi.routing import APIRoute
from fastapi.responses import JSONResponse
from sqlalchemy import select, func

from app.team_workspace import TeamWorkspace, team_actor
from app.private_media import validate_mime
from app.photo_contribution_manifest import ChoiceWrite, Manifest, ReadbackExpectation, RequestRead, SamplePrepare, SampleFinalize
from app.photo_contribution_models import ContributionChoice, ContributionReceipt, ContributionSample, ContributionDeletion

from app.photo_contribution_storage import PREFIX

VERSION = 'photo-contribution/v1'
MAX_BODY = 512 * 1024
MAX_IMAGE = 8 * 1024 * 1024
READBACK_CAUSES = ('add-point', 'remove-point', 'move-point', 'set-score', 'restore-score', 'set-target-point')


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False).encode('utf-8')


def digest(value):
    return hashlib.sha256(value).hexdigest()


CONFLICT_REASONS = frozenset({'request-binding', 'choice-revision', 'consent-changed', 'sample-exists',
    'image-already-contributed', 'deletion-pending', 'content-attempted', 'sample-expired',
    'sample-state', 'image-binding', 'manifest-binding'})


def fail(code=409, *, reason=None):
    messages = {401:'登录会话已失效',404:'该贡献记录当前不可访问',409:'贡献状态已变化，请只读核对原记录',413:'贡献内容超过限额',422:'贡献内容格式不符合要求',503:'照片贡献暂不可用；登录与个人训练不受影响'}
    # Only fixed, allowlisted facts about the authenticated owner's attempted operation.
    # No IDs, submitted fields, provider details or historical-cause inference.
    detail = {'schema':'photo-contribution-conflict/v1','reason':reason} if code == 409 and reason in CONFLICT_REASONS else messages[code]
    raise HTTPException(code, detail)


def fixed_id(value):
    if not isinstance(value, str) or not re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', value):
        fail(422)
    return value


def work_png(content):
    """Validate a bounded, metadata-free browser work PNG, without new libraries."""
    if not isinstance(content, bytes) or not 1 <= len(content) <= MAX_IMAGE:
        fail(413)
    try:
        validate_mime(content, 'image/png')
        width, height = int.from_bytes(content[16:20], 'big'), int.from_bytes(content[20:24], 'big')
        depth, color, compression, filtering, interlace = content[24:29]
        if not (32 <= width <= 1024 and 32 <= height <= 1024 and depth == 8 and color in (2,6)
                and compression == filtering == interlace == 0):
            fail(422)
        offset, compressed, idat_finished, saw_idat = 8, bytearray(), False, False
        while offset < len(content):
            size = int.from_bytes(content[offset:offset+4], 'big')
            kind = content[offset+4:offset+8]
            body = content[offset+8:offset+8+size]
            if kind not in (b'IHDR',b'IDAT',b'IEND',b'sRGB'):
                fail(422)  # EXIF, text, ICC and application data cannot pass.
            if kind == b'sRGB' and (size != 1 or body[0] > 3 or saw_idat):
                fail(422)
            if kind == b'IDAT':
                if idat_finished:
                    fail(422)
                saw_idat = True
                compressed.extend(body)
            elif saw_idat:
                idat_finished = True
            offset += size+12
        stride = width*(4 if color == 6 else 3)+1
        exact = stride*height
        decoder = zlib.decompressobj()
        pixels = decoder.decompress(compressed, exact+1)
        if len(pixels) != exact or not decoder.eof or decoder.unused_data or decoder.unconsumed_tail:
            fail(422)
        if any(pixels[y*stride] > 4 for y in range(height)):
            fail(422)
        return width, height
    except (ValueError, IndexError, zlib.error, HTTPException):
        fail(422)


@dataclass(frozen=True)
class ContributionPolicy:
    # Operator facts, not self-asserted proof of a deployed receiver.
    purpose: str | None = None
    controller: str | None = None
    accessors: tuple[str,...] = ()
    retention_policy_id: str | None = None
    retention_days: int | None = None
    deletion_contact: str | None = None
    facts_verified: bool = False
    deletion_process_verified: bool = False
    allowed_models: frozenset[str] = field(default_factory=frozenset)
    allowed_targets: frozenset[tuple[str,str,int]] = field(default_factory=frozenset)
    max_owner_bytes: int = 100 * 1024 * 1024
    max_owner_samples: int = 200

    def complete(self):
        strings = (self.purpose,self.controller,self.retention_policy_id,self.deletion_contact)
        return (self.facts_verified is True and self.deletion_process_verified is True
                and all(isinstance(v,str) and 0 < len(v.strip()) <= 500 for v in strings)
                and bool(self.accessors) and all(isinstance(v,str) and 0 < len(v) <= 80 for v in self.accessors)
                and type(self.retention_days) is int and 1 <= self.retention_days <= 3650
                and bool(self.allowed_models) and all(re.fullmatch(r'[a-f0-9]{64}',v) for v in self.allowed_models)
                and bool(self.allowed_targets) and self.max_owner_bytes > 0 and self.max_owner_samples > 0)


class PhotoContributions(TeamWorkspace):
    def __init__(self, factory=None, *, service='', store=None, policy=None, enabled=False,
                 writes_enabled=False, schema_verified=False, schema_guard=None, clock=None, session_verifier=None):
        super().__init__(factory, clock, session_verifier)
        self.service = service.rstrip('/')
        self.store, self.policy = store, policy or ContributionPolicy()
        self.enabled, self.writes_enabled, self.schema_verified = enabled, writes_enabled, schema_verified
        self.schema_guard = schema_guard

    @contextmanager
    def transaction(self, actor):
        with super().transaction(actor) as db:
            # A boolean is never sufficient to bypass actual production ACL/RLS
            # and schema verification. SQLite is only the isolated test fixture.
            if db.get_bind().dialect.name == 'postgresql':
                if not callable(self.schema_guard):
                    fail(503)
                self.schema_guard(db)
            yield db

    def _ready(self, write=False):
        if not (self.enabled is True and self.schema_verified is True and re.fullmatch(r'https://[a-zA-Z0-9.-]+', self.service)):
            fail(503)
        if write and self.writes_enabled is not True:
            fail(503)

    def receiver_ready(self):
        return (self.enabled is True and self.schema_verified is True and self.writes_enabled is True
                and re.fullmatch(r'https://[a-zA-Z0-9.-]+', self.service) is not None
                and self.policy.complete() and self.store is not None
                and getattr(self.store,'protection_verified',False) is True
                and getattr(self.store,'purpose',None)=='photo-contribution'
                and getattr(self.store,'deletion_supported',False) is True)

    def public_policy(self):
        p = self.policy
        # Unverified or missing facts are never presented as real terms.
        known = p.facts_verified is True
        return dict(version=VERSION,ready=self.receiver_ready(),purpose=p.purpose if known else None,
            controller=p.controller if known else None,accessors=list(p.accessors) if known else [],
            retentionPolicyId=p.retention_policy_id if known else None,retentionDays=p.retention_days if known else None,
            deletionContact=p.deletion_contact if known else None,imageKind='inference-work-png',trainingExecuted=False)

    def _choice(self, db, actor):
        return db.get(ContributionChoice,(self.service,str(actor)))

    def _choice_view(self, actor, row):
        return dict(service=self.service,owner=str(actor),choice=row.choice if row else 'undecided',
            revision=row.revision if row else 0,activeEpoch=row.epoch if row else None,
            policyVersion=row.policy_version if row else None,effectiveAt=row.effective_at if row else None,
            receiverReady=self.receiver_ready())

    def choice(self, actor):
        self._ready()
        with self.transaction(actor) as db:
            return self._choice_view(actor,self._choice(db,actor))

    def _receipt(self, db, actor, request_id, operation, body):
        row = db.get(ContributionReceipt,(self.service,str(actor),request_id))
        if row and (row.operation != operation or row.body_digest != digest(canonical(body))):
            fail(reason='request-binding')
        return row

    def _new_receipt(self, db, actor, request_id, operation, body, sample_id=None, state='done',event=None):
        row = ContributionReceipt(service=self.service,user_id=str(actor),request_id=request_id,operation=operation,
            body_digest=digest(canonical(body)),state=state,sample_id=sample_id,at=self.stamp(),event=event or {})
        db.add(row)
        return row

    def write_choice(self, actor, value:ChoiceWrite):
        self._ready(write=True)
        with self.transaction(actor) as db:
            # Read existing before testing policy; never replay the old mutation.
            old = self._receipt(db,actor,value.requestId,'choice',value.model_dump())
            row = self._choice(db,actor)
            if old:
                return self._choice_view(actor,row)
            if (row.revision if row else 0) != value.expectedRevision:
                fail(reason='choice-revision')
            if value.choice == 'participate' and not self.receiver_ready():
                fail(503)
            if row is None:
                row = ContributionChoice(service=self.service,user_id=str(actor),revision=0,choice='decline',policy_version=VERSION,epoch=None,effective_at=self.stamp())
                db.add(row)
            # Repeated explicit participate still creates a new epoch, invalidating
            # old queues rather than inheriting an ambiguous collection boundary.
            if row.epoch or value.choice == 'decline':
                retired = select(ContributionSample).where(ContributionSample.service==self.service,
                    ContributionSample.user_id==str(actor))
                # D-123: opt-out covers every retained contribution epoch of this
                # owner, including epochs already retired by re-participation.
                withdrawal_deadline = None
                if value.choice == 'decline':
                    withdrawal_deadline = (self.now()+timedelta(days=7)).isoformat(timespec='microseconds')
                else:
                    retired = retired.where(ContributionSample.epoch==row.epoch)
                for sample in db.scalars(retired):
                    sample.status = 'deletion_pending' if sample.upload_request else 'withdrawn'
                    if withdrawal_deadline is not None:
                        sample.delete_after = min(sample.delete_after, withdrawal_deadline)
            row.revision += 1
            row.choice, row.epoch = value.choice, str(uuid4()) if value.choice=='participate' else None
            row.policy_version, row.effective_at = VERSION, self.stamp()
            self._new_receipt(db,actor,value.requestId,'choice',value.model_dump(),event={
                'choice':row.choice,'revision':row.revision,'epoch':row.epoch,'policyVersion':VERSION})
            return self._choice_view(actor,row)

    def request_read(self, actor, request_id, readback:ReadbackExpectation | None = None):
        if readback is not None:
            return self._request_readback(actor,request_id,readback)
        self._ready()
        fixed_id(request_id)
        with self.transaction(actor) as db:
            row = db.get(ContributionReceipt,(self.service,str(actor),request_id))
            return dict(found=False) if not row else dict(found=True,requestId=row.request_id,operation=row.operation,state=row.state,sampleId=row.sample_id)

    @staticmethod
    def _readback_result(status):
        # Fixed projection only: never identifiers, digests, manifests, object
        # keys, event bodies, exception details or submitted values.
        return dict(schema='photo-contribution-readback/v1',status=status,matchedCount=0,
            received=False,manifestValidated=False,storedDigestMatches=False,
            expectedDigestMatches=False,imageBindingMatches=False,finalizeReceiptBound=False,
            eventSequenceValid=False,replayMatchesFinal=False,confirmationMatches=False,
            consentBindingMatches=False,initialCount=None,eventCount=None,finalCount=None,
            undoCount=None,causeCounts=None,currentEligible='unknown',objectReadVerifiedNow='unknown')

    def _request_readback(self, actor, request_id, expected:ReadbackExpectation):
        try:
            self._ready()
            fixed_id(request_id)
            # Keep the original authenticated, locked, schema-guarded transaction.
            # No ORM mutation or storage operation is performed in this branch.
            with self.transaction(actor) as db:
                receipt = db.get(ContributionReceipt,(self.service,str(actor),request_id))
                if receipt is None:
                    return self._readback_result('not-found')
                if receipt.operation != 'finalize' or receipt.state != 'done':
                    return self._readback_result('not-received')
                if receipt.sample_id != expected.sampleId:
                    return self._readback_result('mismatch')
                row = db.get(ContributionSample,(self.service,str(actor),expected.sampleId))
                if row is None:
                    return self._readback_result('not-found')
                if row.status != 'received' or not row.received_at:
                    return self._readback_result('not-received')
                if (row.storage_scope != PREFIX or row.epoch != expected.consentEpoch
                        or row.revision != expected.consentRevision):
                    return self._readback_result('mismatch')
                try:
                    # Full DTO validation includes ordered replay, before/after,
                    # exact undo inverses, removed aliases and confirmation.
                    manifest = Manifest.model_validate(row.manifest)
                    actual_digest = digest(canonical(manifest.model_dump()))
                    original_body = SampleFinalize(requestId=request_id,manifest=manifest,
                        manifestSha256=expected.manifestSha256).model_dump()
                    bound = (manifest.sampleId == expected.sampleId
                        and actual_digest == row.manifest_sha256 == expected.manifestSha256
                        and manifest.image.sha256 == row.image_sha256 == expected.imageSha256
                        and manifest.image.bytes == row.image_bytes == expected.imageBytes
                        and receipt.body_digest == digest(canonical(original_body)))
                except (ValueError, TypeError, RecursionError):
                    return self._readback_result('mismatch')
                if not bound:
                    return self._readback_result('mismatch')
                choice = self._choice(db,actor)
                deletion = db.get(ContributionDeletion,(self.service,str(actor),expected.sampleId))
                eligible = (deletion is None and self.receiver_ready() and row.delete_after > self.stamp()
                    and choice is not None and choice.choice == 'participate'
                    and choice.policy_version == VERSION and choice.epoch == row.epoch
                    and choice.revision == row.revision)
                causes = {cause:0 for cause in READBACK_CAUSES}
                for event in manifest.correctionEvents:
                    causes[event.cause] += 1
                return dict(schema='photo-contribution-readback/v1',status='verified',matchedCount=1,
                    received=True,manifestValidated=True,storedDigestMatches=True,
                    expectedDigestMatches=True,imageBindingMatches=True,finalizeReceiptBound=True,
                    eventSequenceValid=True,replayMatchesFinal=True,confirmationMatches=True,
                    consentBindingMatches=True,initialCount=len(manifest.initial.predictions),
                    eventCount=len(manifest.correctionEvents),finalCount=len(manifest.corrected.labels),
                    undoCount=sum(event.undoOf is not None for event in manifest.correctionEvents),
                    causeCounts=causes,currentEligible=bool(eligible),objectReadVerifiedNow='unknown')
        except HTTPException as error:
            # Authentication and invalid request errors retain the existing API
            # status. Read-channel/guard failure cannot turn into a receipt.
            if error.status_code in (401,403,422):
                raise
            return self._readback_result('unavailable')
        except Exception:
            return self._readback_result('unavailable')

    def _sample(self, db, actor, sample_id):
        fixed_id(sample_id)
        row = db.get(ContributionSample,(self.service,str(actor),sample_id))
        if not row:
            fail(404)
        return row

    def _writable_sample(self, db, actor, sample_id):
        row = self._sample(db,actor,sample_id)
        if row.storage_scope != PREFIX:
            fail(503)
        if db.get(ContributionDeletion,(self.service,str(actor),sample_id)):
            fail(reason='deletion-pending')
        return row

    def _active(self, db, actor, epoch, revision):
        row = self._choice(db,actor)
        if not row or row.choice != 'participate' or row.epoch != epoch or row.revision != revision or row.policy_version != VERSION:
            fail(reason='consent-changed')
        if not self.receiver_ready():
            fail(503)

    def _sample_view(self, db, actor, row):
        choice = self._choice(db,actor)
        eligible = (row.storage_scope==PREFIX and row.status=='received' and self.receiver_ready() and row.delete_after > self.stamp()
            and choice is not None and choice.choice=='participate' and choice.epoch==row.epoch and choice.revision==row.revision)
        return dict(sampleId=row.sample_id,status=row.status,consentEpoch=row.epoch,consentRevision=row.revision,
            manifestSha256=row.manifest_sha256,imageSha256=row.image_sha256,imageBytes=row.image_bytes,
            receivedAt=row.received_at,deleteAfter=row.delete_after,contentVerified=row.status in ('uploaded','received'),eligible=eligible)

    def sample(self, actor, sample_id):
        self._ready()
        with self.transaction(actor) as db:
            return self._sample_view(db,actor,self._sample(db,actor,sample_id))

    def prepare(self, actor, value:SamplePrepare):
        self._ready(write=True)
        with self.transaction(actor) as db:
            old = self._receipt(db,actor,value.requestId,'prepare',value.model_dump())
            if old:
                return self._sample_view(db,actor,self._sample(db,actor,old.sample_id))
            self._active(db,actor,value.consentEpoch,value.consentRevision)
            if (db.get(ContributionSample,(self.service,str(actor),value.sampleId))
                    or db.get(ContributionDeletion,(self.service,str(actor),value.sampleId))):
                fail(reason='sample-exists')
            # A new epoch cannot resubmit an old queued image under a new ID.
            duplicate = db.scalar(select(ContributionSample).where(ContributionSample.service==self.service,
                ContributionSample.user_id==str(actor),
                ContributionSample.image_sha256==value.imageSha256))
            if duplicate:
                fail(reason='image-already-contributed')
            count, used = db.execute(select(func.count(),func.coalesce(func.sum(ContributionSample.image_bytes),0)).where(
                ContributionSample.service==self.service,ContributionSample.user_id==str(actor))).one()
            if count >= self.policy.max_owner_samples or used+value.imageBytes > self.policy.max_owner_bytes:
                fail(413)
            row = ContributionSample(service=self.service,user_id=str(actor),sample_id=value.sampleId,
                epoch=value.consentEpoch,revision=value.consentRevision,status='reserved',object_id=uuid4().hex,storage_scope=PREFIX,
                image_sha256=value.imageSha256,manifest_sha256=value.manifestSha256,image_bytes=value.imageBytes,
                created_at=self.stamp(),delete_after=(self.now()+timedelta(days=self.policy.retention_days)).isoformat(timespec='microseconds'),
                retention_policy=self.policy.retention_policy_id)
            db.add(row)
            self._new_receipt(db,actor,value.requestId,'prepare',value.model_dump(),value.sampleId)
            return self._sample_view(db,actor,row)

    def _snapshot(self, actor, sample_id):
        self._ready()
        with self.transaction(actor) as db:
            row = self._sample(db,actor,sample_id)
            return dict(object_id=row.object_id,storage_scope=row.storage_scope,image_bytes=row.image_bytes,image_sha256=row.image_sha256,
                manifest_sha256=row.manifest_sha256,epoch=row.epoch,revision=row.revision,upload_request=row.upload_request,
                status=row.status,delete_after=row.delete_after)

    def _read_content(self, snapshot):
        if snapshot.get('storage_scope') != PREFIX or self.store is None or getattr(self.store,'protection_verified',False) is not True:
            fail(503)
        try:
            data = self.store.read(snapshot['object_id'],snapshot['image_bytes'])
            if len(data) != snapshot['image_bytes'] or digest(data) != snapshot['image_sha256']:
                fail()
            dimensions = work_png(data)
            return dimensions
        except Exception:
            fail(503)  # No vendor response, object key, body or credential in errors.

    def content_status(self, actor, sample_id):
        snapshot = self._snapshot(actor,sample_id)
        verified = False
        if snapshot['upload_request']:
            try:
                self._read_content(snapshot)
                verified = True
            except HTTPException:
                pass
        # Recheck authenticated session after I/O; no metadata/status mutation.
        with self.transaction(actor) as db:
            self._sample(db,actor,sample_id)
        return dict(sampleId=sample_id,contentVerified=verified,unknown=not verified)

    def upload(self, actor, sample_id, request_id, content):
        self._ready(write=True)
        fixed_id(request_id)
        work_png(content)
        with self.transaction(actor) as db:
            row = self._writable_sample(db,actor,sample_id)
            self._active(db,actor,row.epoch,row.revision)
            if row.delete_after <= self.stamp():
                fail(reason='sample-expired')
            if row.upload_request:
                fail(reason='content-attempted')
            if row.status != 'reserved':
                fail(reason='sample-state')
            if len(content) != row.image_bytes or digest(content) != row.image_sha256:
                fail(reason='image-binding')
            body = dict(sampleId=sample_id,imageSha256=row.image_sha256)
            if self._receipt(db,actor,request_id,'content',body):
                fail(reason='content-attempted')
            row.status,row.upload_request = 'uploading',request_id
            self._new_receipt(db,actor,request_id,'content',body,sample_id,state='unknown')
            object_id = row.object_id
        try:
            self.store.put(object_id,content)  # ONLY invocation; exceptions never retry.
        except Exception:
            fail(503)
        snapshot = self._snapshot(actor,sample_id)
        self._read_content(snapshot)
        with self.transaction(actor) as db:
            row = self._writable_sample(db,actor,sample_id)
            self._active(db,actor,row.epoch,row.revision)
            if row.delete_after <= self.stamp():
                fail(reason='sample-expired')
            if row.status != 'uploading' or row.upload_request != request_id:
                fail(reason='sample-state')
            row.status = 'uploaded'
            db.get(ContributionReceipt,(self.service,str(actor),request_id)).state = 'done'
            return self._sample_view(db,actor,row)

    def finalize(self, actor, sample_id, value:SampleFinalize):
        self._ready(write=True)
        manifest = value.manifest.model_dump()
        if value.manifest.sampleId != sample_id or digest(canonical(manifest)) != value.manifestSha256:
            fail(reason='manifest-binding')
        if value.manifest.model.sha256 not in self.policy.allowed_models or (value.manifest.target.id,value.manifest.target.rulesVersion,value.manifest.target.face) not in self.policy.allowed_targets:
            fail(422)
        with self.transaction(actor) as db:
            old = self._receipt(db,actor,value.requestId,'finalize',value.model_dump())
            row = self._writable_sample(db,actor,sample_id)
            if old:
                return self._sample_view(db,actor,row)
            self._active(db,actor,row.epoch,row.revision)
            if row.delete_after <= self.stamp():
                fail(reason='sample-expired')
            if row.status not in ('uploading','uploaded'):
                fail(reason='sample-state')
            if row.manifest_sha256 != value.manifestSha256 or row.image_sha256 != value.manifest.image.sha256 or row.image_bytes != value.manifest.image.bytes:
                fail(reason='manifest-binding')
        snapshot = self._snapshot(actor,sample_id)
        dimensions = self._read_content(snapshot)
        if dimensions != (value.manifest.image.width,value.manifest.image.height):
            fail(reason='image-binding')
        with self.transaction(actor) as db:
            row = self._writable_sample(db,actor,sample_id)
            old = self._receipt(db,actor,value.requestId,'finalize',value.model_dump())
            if old:
                return self._sample_view(db,actor,row)
            self._active(db,actor,row.epoch,row.revision)
            if row.delete_after <= self.stamp():
                fail(reason='sample-expired')
            if row.status not in ('uploading','uploaded'):
                fail(reason='sample-state')
            row.status,row.manifest,row.received_at = 'received',manifest,self.stamp()
            self._new_receipt(db,actor,value.requestId,'finalize',value.model_dump(),sample_id)
            db.get(ContributionReceipt,(self.service,str(actor),row.upload_request)).state = 'done'
            return self._sample_view(db,actor,row)


class ContributionRoute(APIRoute):
    def get_route_handler(self):
        original = super().get_route_handler()
        async def handler(request):
            try:
                # Bound bodies before Pydantic; never return invalid submitted input.
                maximum = MAX_IMAGE if request.method=='PUT' else MAX_BODY
                if request.query_params:
                    fail(422)
                if request.method in ('POST','PUT'):
                    if request.headers.get('content-encoding','identity') != 'identity':
                        fail(422)
                    length = request.headers.get('content-length')
                    if length is not None and (not length.isdigit() or int(length)>maximum):
                        fail(413)
                    body = bytearray()
                    async with asyncio.timeout(20):
                        async for part in request.stream():
                            if len(body)+len(part)>maximum:
                                fail(413)
                            body.extend(part)
                    request._body = bytes(body)
                    if request.method == 'POST':
                        def unique(pairs):
                            value = {}
                            for key,item in pairs:
                                if key in value:
                                    fail(422)
                                value[key] = item
                            return value
                        def reject_constant(_):
                            fail(422)
                        try:
                            request._json = json.loads(body,object_pairs_hook=unique,parse_constant=reject_constant)
                        except (ValueError,UnicodeError,RecursionError):
                            fail(422)
                response = await original(request)
                response.headers['Cache-Control'] = 'no-store'
                return response
            except RequestValidationError:
                return JSONResponse({'detail':'贡献内容格式不符合要求'},status_code=422,headers={'Cache-Control':'no-store'})
            except HTTPException as error:
                return JSONResponse({'detail':error.detail},status_code=error.status_code,headers={'Cache-Control':'no-store'})
            except Exception:
                return JSONResponse({'detail':'照片贡献暂不可用；请只读核对原记录'},status_code=503,headers={'Cache-Control':'no-store'})
        return handler


def create_photo_contributions_router(service:PhotoContributions):
    router = APIRouter(prefix='/api/photo-contributions',route_class=ContributionRoute)

    @router.get('/policy')
    def policy():
        return service.public_policy()

    @router.get('/choice')
    def choice(actor=Depends(team_actor)):
        return service.choice(actor)

    @router.post('/choice')
    def write_choice(value:ChoiceWrite,actor=Depends(team_actor)):
        return service.write_choice(actor,value)

    @router.post('/requests/read')
    def request_read(value:RequestRead,actor=Depends(team_actor)):
        return service.request_read(actor,value.requestId,value.readback)

    @router.post('/samples/prepare')
    def prepare(value:SamplePrepare,actor=Depends(team_actor)):
        return service.prepare(actor,value)

    @router.get('/samples/{sample_id}')
    def sample(sample_id:str,actor=Depends(team_actor)):
        return service.sample(actor,sample_id)

    @router.get('/samples/{sample_id}/content-status')
    def content_status(sample_id:str,actor=Depends(team_actor)):
        return service.content_status(actor,sample_id)

    @router.put('/samples/{sample_id}/content')
    async def upload(sample_id:str,request:Request,actor=Depends(team_actor)):
        if request.headers.get('content-type') != 'image/png':
            fail(422)
        return await run_in_threadpool(service.upload,actor,sample_id,request.headers.get('x-contribution-request-id'),await request.body())

    @router.post('/samples/{sample_id}/finalize')
    def finalize(sample_id:str,value:SampleFinalize,actor=Depends(team_actor)):
        return service.finalize(actor,sample_id,value)
    return router
