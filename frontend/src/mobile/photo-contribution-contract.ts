/** Candidate wire contract. Numeric geometry is integer millionths (ppm), not floats.
 * Canonical hash: recursive ASCII key sort, JSON.stringify, UTF-8; arrays retain order.
 * Never include original filenames, account/contact fields, notes or arbitrary errors.
 */
export type Score = 'X'|'10'|'9'|'8'|'7'|'6'|'5'|'4'|'3'|'2'|'1'|'M';
export type PointPpm = {x:number;y:number};
export type Geometry = {kind:'unlocated'|'auto-ellipse'|'manual-quad';controls:PointPpm[];radiusRatioPpm:number};
export type Label = {id:string;point:PointPpm;score:Score|null;targetPoint:PointPpm|null;coordinateEvidence:'manual-target-confirmed'|null};
export type Prediction = {id:string;point:PointPpm;score:Score|null;responsePpm:number};
export type CorrectionCause = 'add-point'|'remove-point'|'move-point'|'set-score'|'restore-score'|'set-target-point';
export type CorrectionEvent = {seq:number;candidateId:string;kind:'add'|'remove'|'change';cause:CorrectionCause;before:Label|null;after:Label|null;undoOf:number|null};
export type Manifest = {
 schema:'photo-contribution/v1';
 sampleId:string;
 image:{kind:'inference-work-png';sha256:string;bytes:number;width:number;height:number;mime:'image/png'};
 model:{status:'completed';sha256:string;decoder:'phase11-regional-maxima-nms/v1';preprocessing:'rgb-planar-unit/v1'};
 target:{id:string;face:number;rulesVersion:string};
 initial:{geometry:Geometry;predictions:Prediction[]};
 correctionEvents:CorrectionEvent[];
 corrected:{geometry:Geometry;labels:Label[];removedPredictionIds:string[]};
 confirmation:{kind:'user-confirmed-local-save';labelSource:'user-not-ground-truth';labels:Label[]};
};
export type Policy = {
 version:'photo-contribution/v1';ready:boolean;purpose:string|null;controller:string|null;
 accessors:string[];retentionPolicyId:string|null;retentionDays:number|null;deletionContact:string|null;
 imageKind:'inference-work-png';trainingExecuted:false;
};
export type ChoiceState = {
 service:string;owner:string;choice:'undecided'|'participate'|'decline';revision:number;
 activeEpoch:string|null;policyVersion:string|null;effectiveAt:string|null;receiverReady:boolean;
};
export type ChoiceWrite = {requestId:string;expectedRevision:number;choice:'participate'|'decline';policyVersion:'photo-contribution/v1'};
export type SamplePrepare = {requestId:string;sampleId:string;consentEpoch:string;consentRevision:number;manifestSha256:string;imageSha256:string;imageBytes:number;mime:'image/png'};
export type SampleFinalize = {requestId:string;manifest:Manifest;manifestSha256:string};
export type SampleReceipt = {sampleId:string;status:'reserved'|'uploading'|'uploaded'|'received'|'withdrawn'|'deletion_pending'|'expired';consentEpoch:string;consentRevision:number;manifestSha256:string;imageSha256:string;imageBytes:number;receivedAt:string|null;deleteAfter:string;contentVerified:boolean;eligible:boolean};
export type RequestReceipt = {found:false}|{found:true;requestId:string;operation:'choice'|'prepare'|'content'|'finalize';state:'done'|'unknown';sampleId:string|null};

/** Private expectations stay in the original request body; the response has no identifiers. */
export type ReadbackExpectation = {sampleId:string;manifestSha256:string;imageSha256:string;imageBytes:number;consentEpoch:string;consentRevision:number};
export type SampleReadback = {
 schema:'photo-contribution-readback/v1';status:'verified'|'not-found'|'not-received'|'mismatch'|'unavailable';matchedCount:0|1;
 received:boolean;manifestValidated:boolean;storedDigestMatches:boolean;expectedDigestMatches:boolean;imageBindingMatches:boolean;finalizeReceiptBound:boolean;
 eventSequenceValid:boolean;replayMatchesFinal:boolean;confirmationMatches:boolean;consentBindingMatches:boolean;
 initialCount:number|null;eventCount:number|null;finalCount:number|null;undoCount:number|null;causeCounts:Record<CorrectionCause,number>|null;
 currentEligible:boolean|'unknown';objectReadVerifiedNow:'unknown';
};
