import type {AutoFace,AutoPoint} from '../auto-target';
import {isPhotoStage,type PhotoStage} from '../photo-assist/diagnostics';

export type CaptureDiagnostic={
 source:'gallery'|'camera-photo'|'camera-frame';
 focus:'not-requested'|'point'|'center'|'unsupported';
 focusPoint?:AutoPoint;
 voice:'not-requested'|'requested'|'started'|'completed'|'unavailable'|'failed'|'stopped';
 capturedAt?:string;
};

export type DiagnosticCandidate={
 id:string;
 point:AutoPoint;
 automaticCode:string|null;
 finalCode:string|null;
 disposition:string;
 overridden:boolean;
};

export type PhotoDiagnosticActions={pointVisits:number;pointNudges:number;adds:number;deletes:number;scoreOverrides:number;mappingAdjustments:number;fullscreenEntries:number;saveAttempts:number};

export type PhotoDiagnosticDraft={
 schema:'gongxingji-photo-diagnostic-v1';
 batchId:string;
 appVersion:string;
 startedAt:string;
 target:{id:string;name:string;face:number};
 capture:CaptureDiagnostic;
 input:{mime:string;bytes:number;sha256:string|null;fileNameIncluded:false};
 viewport:{width:number;height:number;devicePixelRatio:number;orientation:string|null};
 image?:{width:number;height:number};
 geometry?:{method:'color-ellipse-affine-v1';face:AutoFace};
 processingStages?:{stage:PhotoStage;elapsedMs:number}[];
 inference?:{milliseconds:number;initialCandidates:{id:string;point:AutoPoint}[]};
 failure?:string;
 failureStage?:'image'|'target-location'|'inference'|'cancelled';
 reviewMode?:'manual-photo'|'photo-candidates-only';
 targetLocationIssue?:'invalid-image'|'no-reliable-target'|'ambiguous-target';
 previewUnavailable?:true;
 manualFallbackFrom?:'target-location-failed'|'inference-failed'|'cancelled';
 manualPreview?:{width:number;height:number};
};

export type PhotoDiagnosticReceipt=PhotoDiagnosticDraft&{
 exportedAt:string;
 outcome:'review'|'saved'|'failed';
 adjustment:{mapping:{dxPixels:number;dyPixels:number;uniformScale:number};saveCoordinates:boolean;order:'score-desc'|'custom'};
 candidates:{
  id:string;origin:'automatic'|'manual';initialPoint:AutoPoint|null;finalPoint:AutoPoint;
  deltaPixels:{x:number;y:number}|null;automaticCode:string|null;finalCode:string|null;
  disposition:string;overridden:boolean;
 }[];
 removedAutomaticIds:string[];
 summary:{initial:number;final:number;added:number;removed:number;moved:number;scoreOverrides:number};
 actionCounts:PhotoDiagnosticActions;
 privacy:{photoIncluded:false;fileNameIncluded:false;sessionIdentityIncluded:false;uploaded:false};
};

const rounded=(value:number,digits=6)=>Number(value.toFixed(digits));
const point=(value:AutoPoint):AutoPoint=>({x:rounded(value.x),y:rounded(value.y)});

export async function photoSha256(file:Blob):Promise<string|null>{
 try{
  if(!globalThis.crypto?.subtle)return null;
  const bytes=await file.arrayBuffer(),digest=await globalThis.crypto.subtle.digest('SHA-256',bytes);
  return [...new Uint8Array(digest)].map(value=>value.toString(16).padStart(2,'0')).join('');
 }catch{return null;}
}

export function buildPhotoDiagnosticReceipt(draft:PhotoDiagnosticDraft,current:DiagnosticCandidate[],mapping:{dx:number;dy:number;scale:number},saveCoordinates:boolean,order:'score-desc'|'custom',outcome:'review'|'saved'|'failed',actions:Partial<PhotoDiagnosticActions>={},exportedAt=new Date().toISOString()):PhotoDiagnosticReceipt{
 const initial=draft.inference?.initialCandidates??[],byId=new Map(initial.map(candidate=>[candidate.id,candidate.point])),present=new Set(current.map(candidate=>candidate.id));
 const aliases=new Map<string,string>();
 [...initial,...current].forEach(candidate=>{if(!aliases.has(candidate.id))aliases.set(candidate.id,`p${aliases.size+1}`);});
 const alias=(id:string)=>aliases.get(id)??'p0';
 const candidates=current.map(candidate=>{
  const original=byId.get(candidate.id)??null,dx=original?(candidate.point.x-original.x)*(draft.image?.width??1):0,dy=original?(candidate.point.y-original.y)*(draft.image?.height??1):0;
  return {
   id:alias(candidate.id),origin:original?'automatic' as const:'manual' as const,initialPoint:original?point(original):null,finalPoint:point(candidate.point),
   deltaPixels:original?{x:rounded(dx,2),y:rounded(dy,2)}:null,automaticCode:candidate.automaticCode,finalCode:candidate.finalCode,
   disposition:candidate.disposition,overridden:candidate.overridden
  };
 });
 const removedAutomaticIds=initial.filter(candidate=>!present.has(candidate.id)).map(candidate=>alias(candidate.id));
 const processingStages=draft.processingStages?.filter(entry=>isPhotoStage(entry.stage)&&Number.isFinite(entry.elapsedMs)&&entry.elapsedMs>=0).slice(0,64).map(entry=>({stage:entry.stage,elapsedMs:Math.round(entry.elapsedMs)}));
 const sanitizedDraft:PhotoDiagnosticDraft={...draft,processingStages,inference:draft.inference?{...draft.inference,initialCandidates:draft.inference.initialCandidates.map(candidate=>({id:alias(candidate.id),point:point(candidate.point)}))}:undefined};
 const actionCounts:PhotoDiagnosticActions={pointVisits:actions.pointVisits??0,pointNudges:actions.pointNudges??0,adds:actions.adds??0,deletes:actions.deletes??0,scoreOverrides:actions.scoreOverrides??0,mappingAdjustments:actions.mappingAdjustments??0,fullscreenEntries:actions.fullscreenEntries??0,saveAttempts:actions.saveAttempts??0};
 return {...sanitizedDraft,exportedAt,outcome,adjustment:{mapping:{dxPixels:rounded(mapping.dx,2),dyPixels:rounded(mapping.dy,2),uniformScale:rounded(mapping.scale)},saveCoordinates,order},candidates,removedAutomaticIds,
  summary:{initial:initial.length,final:candidates.length,added:candidates.filter(candidate=>candidate.origin==='manual').length,removed:removedAutomaticIds.length,moved:candidates.filter(candidate=>candidate.deltaPixels&&Math.hypot(candidate.deltaPixels.x,candidate.deltaPixels.y)>=.01).length,scoreOverrides:candidates.filter(candidate=>candidate.overridden).length},
  actionCounts,
  privacy:{photoIncluded:false,fileNameIncluded:false,sessionIdentityIncluded:false,uploaded:false}};
}
