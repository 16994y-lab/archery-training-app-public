// Only fixed phases; no photo, names, paths, accounts or runtime errors.
export const PHOTO_STAGES = ["PHOTO_BEGIN", "IMAGE_READY", "TARGET_READY", "INPUT_READY", "WASM_CHECK", "WASM_READY", "RUNTIME_LOAD", "RUNTIME_READY", "MODEL_FETCH", "MODEL_FETCH_DONE", "MODEL_VERIFY", "MODEL_VERIFY_DONE", "MODEL_VERIFY_FAILED", "SESSION_CREATE", "SESSION_READY", "TENSOR_READY", "INFERENCE_RUN", "INFERENCE_DONE", "DECODE_DONE", "RELEASE_START", "RELEASE_DONE", "RESULT_READY", "PHOTO_FAILED", "CANCELLED", "TIMEOUT"] as const;
export type PhotoStage = typeof PHOTO_STAGES[number];
export function isPhotoStage(value:unknown):value is PhotoStage{return typeof value==='string'&&(PHOTO_STAGES as readonly string[]).includes(value);}
export type PhotoStageEntry={stage:PhotoStage;elapsedMs:number};
const terminalStages:readonly PhotoStage[]=['RESULT_READY','PHOTO_FAILED','CANCELLED','TIMEOUT'];
let entries:PhotoStageEntry[]=[],startedAt=0,lastElapsed=0,finished=false;
function monotonicNow():number{try{const value=performance.now();return Number.isFinite(value)?value:startedAt+lastElapsed;}catch{return startedAt+lastElapsed;}}
// Memory only. Callers may add this fixed, bounded snapshot to the existing local diagnostic export.
export function snapshotPhotoStages():PhotoStageEntry[]{return entries.map(({stage,elapsedMs})=>({stage,elapsedMs}));}
type PhotoBridge={photoWorkMaxLongEdge?:()=>unknown;photoInferenceStage?:(stage:string)=>unknown};
function nativeBridge():PhotoBridge|undefined{return (globalThis as typeof globalThis&{Gongxingji?:PhotoBridge}).Gongxingji;}
// App bitness does not prove renderer bitness. Native Android is conservatively capped.
// A native build can explicitly return 1024 for a reviewed rollback; ordinary Web stays 1024.
export function photoWorkMaxLongEdge(bridge:PhotoBridge|undefined=nativeBridge()):256|512|1024{
 if(!bridge)return 1024;
 try{const limit=bridge.photoWorkMaxLongEdge?.();return limit===256?256:limit===1024?1024:512;}catch{return 512;}
}
export function recordPhotoStage(stage:unknown):void{
 if(!isPhotoStage(stage))return;
 if(stage==='PHOTO_BEGIN'){entries=[];startedAt=monotonicNow();lastElapsed=0;finished=false;}
 if(finished)return;
 if(entries.length===0&&stage!=='PHOTO_BEGIN')startedAt=monotonicNow();
 const elapsedMs=Math.max(lastElapsed,Math.floor(Math.max(0,monotonicNow()-startedAt)));
 lastElapsed=elapsedMs;
 if(entries[entries.length-1]?.stage!==stage){entries.push({stage,elapsedMs});if(entries.length>64)entries.shift();}
 if(terminalStages.includes(stage))finished=true;
 try{nativeBridge()?.photoInferenceStage?.(stage);}catch{/* Diagnostics must not fail or replay inference. */}
}
