"""Strict contribution DTO. No arbitrary strings, account metadata or float JSON."""
from typing import Annotated, Literal
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

UUIDText = Annotated[str, StringConstraints(pattern=r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')]
Hash = Annotated[str, StringConstraints(pattern=r'^[0-9a-f]{64}$')]
Alias = Annotated[str, StringConstraints(pattern=r'^p[1-9][0-9]{0,2}$')]
Identifier = Annotated[str, StringConstraints(pattern=r'^[a-zA-Z0-9_.:/-]{1,80}$')]
Ppm = Annotated[int, Field(strict=True, ge=0, le=1_000_000)]
Score = Literal['X','10','9','8','7','6','5','4','3','2','1','M']


class Exact(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)


class Point(Exact):
    x: Ppm
    y: Ppm


class Geometry(Exact):
    kind: Literal['unlocated','auto-ellipse','manual-quad']
    controls: list[Point] = Field(max_length=4)
    radiusRatioPpm: Annotated[int, Field(strict=True, ge=1, le=1_000_000)]

    @model_validator(mode='after')
    def shape(self):
        if len(self.controls) != (0 if self.kind == 'unlocated' else 4):
            raise ValueError('invalid geometry')
        return self


class Label(Exact):
    id: Alias
    point: Point
    score: Score | None
    targetPoint: Point | None
    coordinateEvidence: Literal['manual-target-confirmed'] | None

    @model_validator(mode='after')
    def evidence(self):
        if (self.targetPoint is None) != (self.coordinateEvidence is None):
            raise ValueError('invalid coordinate evidence')
        return self


class Prediction(Exact):
    id: Alias
    point: Point
    score: Score | None
    responsePpm: Ppm


class Image(Exact):
    kind: Literal['inference-work-png']
    sha256: Hash
    bytes: Annotated[int, Field(strict=True, ge=1, le=8*1024*1024)]
    width: Annotated[int, Field(strict=True, ge=32, le=1024)]
    height: Annotated[int, Field(strict=True, ge=32, le=1024)]
    mime: Literal['image/png']


class Model(Exact):
    status: Literal['completed']
    sha256: Hash
    decoder: Literal['phase11-regional-maxima-nms/v1']
    preprocessing: Literal['rgb-planar-unit/v1']


class Target(Exact):
    id: Identifier
    face: Annotated[int, Field(strict=True, ge=1, le=3)]
    rulesVersion: Identifier


class Initial(Exact):
    geometry: Geometry
    predictions: list[Prediction] = Field(max_length=256)


class Corrected(Exact):
    geometry: Geometry
    labels: list[Label] = Field(min_length=1, max_length=512)
    removedPredictionIds: list[Alias] = Field(max_length=256)


class Confirmation(Exact):
    kind: Literal['user-confirmed-local-save']
    labelSource: Literal['user-not-ground-truth']
    labels: list[Label] = Field(min_length=1, max_length=512)


class CorrectionEvent(Exact):
    seq: Annotated[int, Field(strict=True, ge=1, le=256)]
    candidateId: Alias
    kind: Literal['add','remove','change']
    cause: Literal['add-point','remove-point','move-point','set-score','restore-score','set-target-point']
    before: Label | None
    after: Label | None
    undoOf: Annotated[int, Field(strict=True, ge=1, le=255)] | None


class Manifest(Exact):
    schema: Literal['photo-contribution/v1']
    sampleId: UUIDText
    image: Image
    model: Model
    target: Target
    initial: Initial
    correctionEvents: list[CorrectionEvent] = Field(max_length=256)
    corrected: Corrected
    confirmation: Confirmation

    @model_validator(mode='after')
    def coherence(self):
        initial = [p.id for p in self.initial.predictions]
        final = [p.id for p in self.corrected.labels]
        removed = self.corrected.removedPredictionIds
        if any(len(ids) != len(set(ids)) for ids in (initial, final, removed)):
            raise ValueError('duplicate aliases')
        if set(removed) != set(initial)-set(final) or set(removed)&set(final):
            raise ValueError('inconsistent removals')
        if initial != [f'p{i+1}' for i in range(len(initial))]:
            raise ValueError('initial aliases must be sequential')
        known=set(initial)
        current={p.id:Label(id=p.id,point=p.point,score=p.score,targetPoint=None,coordinateEvidence=None) for p in self.initial.predictions}
        for seq,event in enumerate(self.correctionEvents,1):
            before,after=event.before,event.after
            if event.seq!=seq or (before is not None and before.id!=event.candidateId) or (after is not None and after.id!=event.candidateId):
                raise ValueError('invalid event sequence or alias')
            if current.get(event.candidateId)!=before or before==after:
                raise ValueError('event does not match current state')
            if event.kind=='add':
                if event.cause!='add-point' or before is not None or after is None or after.targetPoint is not None or event.candidateId in known or event.candidateId!=f'p{len(known)+1}' or len(known)>=512:
                    raise ValueError('invalid addition')
                known.add(event.candidateId)
            elif event.kind=='remove':
                if event.cause!='remove-point' or before is None or after is not None:
                    raise ValueError('invalid removal')
            else:
                if before is None or after is None:
                    raise ValueError('invalid change')
                if event.cause=='set-target-point':
                    if before.point!=after.point or before.score!=after.score or after.targetPoint is None:
                        raise ValueError('invalid target change')
                elif event.cause in ('set-score','restore-score'):
                    if before.point!=after.point or after.targetPoint is not None or (event.cause=='set-score' and after.score is None):
                        raise ValueError('invalid score change')
                elif event.cause=='move-point':
                    if after.targetPoint is not None:
                        raise ValueError('stale target confirmation after move')
                else:
                    raise ValueError('invalid change cause')
            if event.undoOf is not None:
                if event.undoOf>=seq:
                    raise ValueError('invalid undo reference')
                inverse=self.correctionEvents[event.undoOf-1]
                if inverse.candidateId!=event.candidateId or inverse.before!=after or inverse.after!=before:
                    raise ValueError('undo must match exact inverse')
            if after is None:current.pop(event.candidateId)
            else:current[event.candidateId]=after
        if current!={p.id:p for p in self.corrected.labels} or self.initial.geometry!=self.corrected.geometry:
            raise ValueError('correction replay does not match final state')
        if self.confirmation.labels != self.corrected.labels or any(p.score is None for p in self.confirmation.labels):
            raise ValueError('confirmation must match corrected labels')
        return self


class ChoiceWrite(Exact):
    requestId: UUIDText
    expectedRevision: Annotated[int, Field(strict=True, ge=0)]
    choice: Literal['participate','decline']
    policyVersion: Literal['photo-contribution/v1']


class ReadbackExpectation(Exact):
    sampleId: UUIDText
    manifestSha256: Hash
    imageSha256: Hash
    imageBytes: Annotated[int, Field(strict=True, ge=1, le=8*1024*1024)]
    consentEpoch: UUIDText
    consentRevision: Annotated[int, Field(strict=True, ge=1, le=9007199254740991)]


class RequestRead(Exact):
    requestId: UUIDText
    readback: ReadbackExpectation | None = None

    @model_validator(mode='before')
    @classmethod
    def absent_or_object(cls, value):
        # Absence preserves the original request receipt contract. Explicit null
        # is invalid, matching the native bridge's strict optional-object rule.
        if isinstance(value, dict) and 'readback' in value and value['readback'] is None:
            raise ValueError('invalid readback')
        return value


class SamplePrepare(Exact):
    requestId: UUIDText
    sampleId: UUIDText
    consentEpoch: UUIDText
    consentRevision: Annotated[int, Field(strict=True, ge=1)]
    manifestSha256: Hash
    imageSha256: Hash
    imageBytes: Annotated[int, Field(strict=True, ge=1, le=8*1024*1024)]
    mime: Literal['image/png']


class SampleFinalize(Exact):
    requestId: UUIDText
    manifest: Manifest
    manifestSha256: Hash
