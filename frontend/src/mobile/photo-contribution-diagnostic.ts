import {canonical,sha256,parseChoice,parseRequest,parseReceipt,parseReadback,parseReadbackExpectation,ContributionHttpError,isContributionConflictReason,type ContributionConflictReason,type ContributionTransport} from './photo-contribution-api';
import {scopeKey,type ContributionIdentity,type ContributionScope,type ContributionStore,type QueuedSample} from './photo-contribution-store';

export type ContributionDiagnostic={ordinal:number;stage:'prepare'|'content'|'finalize';request:'found'|'not-found'|'unknown';sample:'bound'|'not-found'|'unknown';consentMatches:boolean|'unknown';contentVerified:boolean|'unknown';receiptVerified:boolean;conflict:ContributionConflictReason|null};
const unknown=(q:QueuedSample,ordinal:number):ContributionDiagnostic=>({ordinal,stage:q.step==='prepare-unknown'?'prepare':q.step==='content-unknown'?'content':'finalize',request:'unknown',sample:'unknown',consentMatches:'unknown',contentVerified:'unknown',receiptVerified:false,conflict:isContributionConflictReason(q.conflict)?q.conflict:null});
// Includes all queue bindings and choice/tombstone state. No image or private field is returned.
const fingerprint=(s:ContributionScope)=>canonical({...s,samples:s.samples.map(q=>({...q,image:q.image?{bytes:q.image.size,type:q.image.type}:null}))});
const missing=(e:unknown)=>e instanceof ContributionHttpError&&e.status===404;

/** Strictly read-only: neither store.change, policy refresh, reconcile nor a queue pump is called.
 * A missing receipt/sample cannot identify the reason for an earlier rejected request.
 */
export async function diagnoseContributionRequests(transport:ContributionTransport,store:ContributionStore,identity:ContributionIdentity,signal:AbortSignal,current:()=>boolean):Promise<ContributionDiagnostic[]>{
 const i={...identity},key=scopeKey(i),assert=()=>{if(!current()||signal.aborted||!transport.available()||canonical(i)!==canonical(transport.identity()))throw Error('贡献核对对象已变化');};
 assert();const local=await store.read(key);assert();if(local.key!==key)throw Error('贡献核对对象已变化');
 const fixed=fingerprint(local),pinned=async()=>{assert();const s=await store.read(key);assert();if(fingerprint(s)!==fixed)throw Error('贡献核对对象已变化');};
 const read=async(method:'GET'|'POST',path:string,body?:unknown)=>{await pinned();try{const raw=await transport.request(i,method,path,signal,body);await pinned();return raw;}catch(e){await pinned();throw e;}};
 const pending=local.samples.map((q,n)=>({q,ordinal:n+1})).filter(({q})=>q.step.endsWith('-unknown'));
 if(!pending.length)return [];
 let choice:ReturnType<typeof parseChoice>|null=null;
 try{choice=parseChoice(await read('GET','/choice'),i);}catch{await pinned();}
 const results:ContributionDiagnostic[]=[];
 for(const {q,ordinal} of pending){
  await pinned();const result=unknown(q,ordinal);results.push(result);
  if(choice)result.consentMatches=choice.choice==='participate'&&choice.activeEpoch===q.epoch&&choice.revision===q.revision&&choice.policyVersion==='photo-contribution/v1';
  // Legacy/inconsistent local manifests are preserved, never silently repaired or submitted.
  if(q.manifest.sampleId!==q.sampleId||await sha256(canonical(q.manifest))!==q.manifestSha256){await pinned();continue;}await pinned();
  const requestId=result.stage==='prepare'?q.prepareId:result.stage==='content'?q.contentId:q.finalizeId;
  try{const receipt=parseRequest(await read('POST','/requests/read',{requestId}),requestId);
   if(!receipt.found)result.request='not-found';
   else if(receipt.operation===result.stage&&receipt.sampleId===q.sampleId&&(result.stage==='content'||receipt.state==='done'))result.request='found';
  }catch{await pinned();}
  try{const sample=parseReceipt(await read('GET','/samples/'+q.sampleId),q.sampleId);
   if(sample.manifestSha256===q.manifestSha256&&sample.imageSha256===q.manifest.image.sha256&&sample.imageBytes===q.manifest.image.bytes&&sample.consentEpoch===q.epoch&&sample.consentRevision===q.revision)result.sample='bound';
  }catch(error){await pinned();if(missing(error))result.sample='not-found';}
  if(result.request!=='found'||result.sample!=='bound')continue;
  if(result.stage==='finalize'){
   try{const readback=parseReadbackExpectation({sampleId:q.sampleId,manifestSha256:q.manifestSha256,imageSha256:q.manifest.image.sha256,imageBytes:q.manifest.image.bytes,consentEpoch:q.epoch,consentRevision:q.revision});
    const receipt=parseReadback(await read('POST','/requests/read',{requestId,readback})),events=q.manifest.correctionEvents;
    result.receiptVerified=receipt.status==='verified'&&Array.isArray(events)&&receipt.initialCount===q.manifest.initial.predictions.length&&receipt.eventCount===events.length&&receipt.finalCount===q.manifest.corrected.labels.length&&receipt.undoCount===events.filter(e=>e.undoOf!==null).length&&Object.entries(receipt.causeCounts!).every(([cause,n])=>events.filter(e=>e.cause===cause).length===n);
   }catch{await pinned();}
  }
  if(result.stage!=='prepare')try{const raw=await read('GET','/samples/'+q.sampleId+'/content-status') as Record<string,unknown>;
   if(raw&&typeof raw==='object'&&!Array.isArray(raw)&&Object.keys(raw).length===3&&raw.sampleId===q.sampleId&&raw.contentVerified===true&&raw.unknown===false)result.contentVerified=true;
  }catch{await pinned();}
 }
 await pinned();return results;
}
