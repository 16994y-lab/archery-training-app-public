import {uid} from './domain';
import type {AutoFace} from '../auto-target';
import type {Candidate} from '../photo-geometry';
import type {ContactResult} from '../photo-assist/client';
import type {Manifest,Geometry,Label,Score,PointPpm,CorrectionCause,CorrectionEvent} from './photo-contribution-contract';
import type {PhotoSaveReceipt} from './photo-save-receipt';
import {canonical,digestPattern,sha256} from './photo-contribution-api';
import {PhotoContributionController,type CapturePermit} from './photo-contribution-controller';
export type CaptureStatus='verification-paused'|'verification-failed'|'verification-unconfirmed'|'save-paused'|'preparing'|'ready'|'saving'|'queued'|'not-enabled'|'target-unverified'|'rules-unverified'|'model-unverified'|'permission-changed'|'invalid-data'|'image-unavailable'|'receipt-mismatch'|'queue-unconfirmed'|'disposed'|'manual-only';
const captureMessages:Record<CaptureStatus,string>={
 'verification-paused':'正在重新核对当前账号和参与选择；本图编辑记录保留，核对完成前不会提交贡献。',
 'verification-failed':'账号或参与状态未能核实；本图和修正已保留，可重新核对。个人保存不受影响。',
 'verification-unconfirmed':'账号或参与状态尚未核实；本图和修正已保留，可重新核对。个人保存不受影响。',
 'save-paused':'个人训练已保存；保存时账号或参与选择仍在核对，本次未确认贡献入队。不会自动补发，请勿为贡献重复保存。',
 preparing:'模型改进：正在检查本次照片的采集条件，尚未加入贡献队列。',
 ready:'模型改进：本次副本仍待个人保存成功后核对入队；尚无接收回执。',
 saving:'个人训练已保存；正在核对本次贡献副本是否进入本机队列，尚未确认接收。',
 queued:'个人训练已保存；本次副本已进入本机贡献队列，不等于服务器已接收。可在设置核对最近一次贡献。',
 'not-enabled':'本次未启动模型改进采集：加载照片时账号、参与选择或接收条件尚未全部核实。个人保存不受影响。',
 'target-unverified':'本次未生成贡献副本：靶面未可靠定位。仍可人工核对并保存个人成绩。',
 'rules-unverified':'本次未生成贡献副本：当前靶型规则未核实。个人保存不受影响。',
 'model-unverified':'本次未生成贡献副本：模型来源校验未完成。识别候选仍可人工核对，个人保存不受影响。',
 'permission-changed':'本次贡献采集条件已失效：账号或参与状态发生变化。个人保存不受影响；不会补采或自动重试。',
 'invalid-data':'本次未生成贡献副本：采集或修正过程未能完整核对。个人保存不受影响。',
 'image-unavailable':'本次未生成贡献副本：工作图副本未准备成功。个人保存不受影响。',
 'receipt-mismatch':'本次未生成贡献副本：贡献内容与个人保存结果未能一致核对。请保留个人记录，不要为贡献重复保存。',
 'queue-unconfirmed':'个人训练已保存；本次贡献入队结果未核实，尚无已核实接收回执。请在设置查看原队列，不要重复保存或补发。',
 disposed:'本次贡献采集已结束，未据此确认入队或接收。个人训练保存结果保持。',
 'manual-only':'本次仅人工核对并保存个人成绩，不生成模型改进贡献副本。'
};
export const contributionCaptureMessage=(status:CaptureStatus)=>captureMessages[status];
const scores=new Set(['X','10','9','8','7','6','5','4','3','2','1','M']);
const ppm=(value:number)=>{if(!Number.isFinite(value)||value<0||value>1)throw Error('贡献坐标未核实');return Math.round(value*1000000);};
const point=(p:{x:number;y:number}):PointPpm=>({x:ppm(p.x),y:ppm(p.y)});
const score=(s:unknown):Score|null=>typeof s==='string'&&scores.has(s)?s as Score:null;
const clone=<T,>(value:T):T=>JSON.parse(canonical(value));
export function contributionGeometry(face:AutoFace,_width:number,_height:number,radius:number):Geometry{return {kind:'auto-ellipse',controls:face.controls.map(p=>point(p)),radiusRatioPpm:ppm(radius)};}
/** Holds only this load's inference-work copy. No filename, original file or training identity. */
export class PhotoContributionCapture{
 private image:Promise<Blob|null>=Promise.resolve(null);private canvas:HTMLCanvasElement|null;private initial:Manifest['initial']|null=null;private model:Manifest['model']|null=null;private final:{geometry:Geometry;labels:Label[];localIds:string[]}|null=null;private aliases=new Map<string,string>();private disposed=false;private committed=false;private sampleId=uid();
 private status:CaptureStatus='preparing';
 private report(status:CaptureStatus){this.status=status;try{this.onStatus?.(status);}catch{/* Presentation cannot block saving or contribution checks. */}}
 getStatus():CaptureStatus{if(this.disposed||this.committed)return this.status;const state=this.controller.permitState(this.permit);return state==='invalid'?'permission-changed':state==='paused'?(this.controller.getSnapshot().verification==='checking'?'verification-paused':this.controller.getSnapshot().verification==='failed'?'verification-failed':'verification-unconfirmed'):this.status;}
 retryVerification(verifyAccount:()=>Promise<void>){if(this.disposed||this.committed)return Promise.resolve();return this.controller.retryVerification(this.permit,verifyAccount);}
 private events:CorrectionEvent[]=[];private current=new Map<string,Label>();
 constructor(private controller:PhotoContributionController,readonly permit:CapturePermit,canvas:HTMLCanvasElement,private target:Manifest['target'],private onStatus?:(status:CaptureStatus)=>void){
  // Retain the existing work canvas only; do not encode while ORT is loading/running.
  this.canvas=canvas;this.width=canvas.width;this.height=canvas.height;
 }
 private width:number;private height:number;
 private alias(id:string){if(!this.aliases.has(id)){if(this.aliases.size>=512)throw Error('贡献修正超过上限');this.aliases.set(id,'p'+(this.aliases.size+1));}return this.aliases.get(id)!;}
 freeze(result:ContactResult,candidates:Candidate[],geometry:AutoFace,radius:number,initialScore:(candidate:Candidate)=>string|null){
  try{if(this.disposed)return;if(this.controller.permitState(this.permit)==='invalid'){this.dispose('permission-changed');return;}if(!result.verifiedModelSha256||!digestPattern.test(result.verifiedModelSha256)){this.dispose('model-unverified');return;}if(this.initial||candidates.length>256||new Set(candidates.map(c=>c.id)).size!==candidates.length){this.dispose('invalid-data');return;}
   this.model={status:'completed',sha256:result.verifiedModelSha256,decoder:'phase11-regional-maxima-nms/v1',preprocessing:'rgb-planar-unit/v1'};
   this.initial=clone({geometry:contributionGeometry(geometry,this.width,this.height,radius),predictions:candidates.map((c,index)=>({id:this.alias(c.id),point:point(c.point),score:score(initialScore(c)),responsePpm:ppm(result.peaks[index].response)}))});
   this.current=new Map(this.initial.predictions.map(p=>[p.id,{id:p.id,point:clone(p.point),score:p.score,targetPoint:null,coordinateEvidence:null}]));
   // freeze follows successful inference and worker termination; the work image is unchanged.
   const canvas=this.canvas;this.canvas=null;
   if(!canvas||canvas.width!==this.width||canvas.height!==this.height)throw Error('贡献工作图已变化');
   this.report('ready');
   this.image=new Promise(resolve=>{const done=(blob:Blob|null)=>{const valid=blob&&blob.type==='image/png'&&blob.size<=8*1024*1024?blob:null;if(!valid&&!this.disposed)this.report('image-unavailable');resolve(valid);};try{canvas.toBlob(done,'image/png');}catch{done(null);}});
  }catch{this.dispose('invalid-data');}
 }
 private labels(candidates:Candidate[],code:(candidate:Candidate)=>string|null,manual:(candidate:Candidate)=>{x:number;y:number}|null,allowAdd=false){
  if(candidates.length>512||new Set(candidates.map(c=>c.id)).size!==candidates.length)throw Error('贡献候选未核实');
  return candidates.map(c=>{if(!allowAdd&&!this.aliases.has(c.id))throw Error('贡献缺少新增过程');const p=manual(c);return {id:this.alias(c.id),point:point(c.point),score:score(code(c)),targetPoint:p?point({x:(p.x+1.2)/2.4,y:(1.2-p.y)/2.4}):null,coordinateEvidence:p?'manual-target-confirmed' as const:null};});
 }
 /** Synchronous semantic edit hook, never a render effect or a React state updater. */
 record(cause:CorrectionCause,candidates:Candidate[],geometry:AutoFace,radius:number,code:(candidate:Candidate)=>string|null,manual:(candidate:Candidate)=>{x:number;y:number}|null){
  try{if(this.disposed||!this.initial)return;if(this.controller.permitState(this.permit)==='invalid'){this.dispose('permission-changed');return;}
   if(canonical(contributionGeometry(geometry,this.width,this.height,radius))!==canonical(this.initial.geometry))throw Error('贡献缺少靶框修正过程');
   const oldAliases=this.aliases.size,labels=this.labels(candidates,code,manual,cause==='add-point'),next=new Map(labels.map(p=>[p.id,p]));
   const changed=[...new Set([...this.current.keys(),...next.keys()])].filter(id=>canonical(this.current.get(id)??null)!==canonical(next.get(id)??null));
   if(!changed.length)return;if(changed.length!==1||this.events.length>=256)throw Error('贡献过程超限或不完整');
   const id=changed[0],before=this.current.get(id)??null,after=next.get(id)??null,kind=!before?'add':!after?'remove':'change';
   if(kind==='add'){if(cause!=='add-point'||id!=='p'+(oldAliases+1)||this.aliases.size!==oldAliases+1||after!.targetPoint!==null)throw Error('贡献新增顺序无效');}
   else if(kind==='remove'){if(cause!=='remove-point')throw Error('贡献删除未核实');}
   else if(cause==='set-target-point'){if(canonical(before!.point)!==canonical(after!.point)||before!.score!==after!.score||!after!.targetPoint)throw Error('贡献定位未核实');}
   else if(cause==='set-score'||cause==='restore-score'){if(canonical(before!.point)!==canonical(after!.point)||after!.targetPoint!==null||cause==='set-score'&&after!.score===null)throw Error('贡献改分未核实');}
   else if(cause==='move-point'){if(after!.targetPoint!==null)throw Error('贡献移动后旧定位未清除');}
   else throw Error('贡献事件类型无效');
   const reverse=[...this.events].reverse().find(e=>e.candidateId===id&&canonical(e.before)===canonical(after)&&canonical(e.after)===canonical(before));
   this.events.push(clone({seq:this.events.length+1,candidateId:id,kind,cause,before,after,undoOf:reverse?.seq??null}));this.current=new Map(labels.map(p=>[p.id,clone(p)]));this.final=null;
  }catch{this.dispose('invalid-data');}
 }
 /** Save snapshot verifies history; it never manufactures missing edit events. */
 corrected(candidates:Candidate[],geometry:AutoFace,radius:number,code:(candidate:Candidate)=>string|null,manual:(candidate:Candidate)=>{x:number;y:number}|null){
  try{if(this.disposed||!this.initial)return;
   const finalGeometry=contributionGeometry(geometry,this.width,this.height,radius),labels=this.labels(candidates,code,manual);
   if(canonical(finalGeometry)!==canonical(this.initial.geometry)||labels.length!==this.current.size||labels.some(p=>canonical(p)!==canonical(this.current.get(p.id)??null)))throw Error('贡献最终结果与过程不一致');
   this.final=clone({geometry:finalGeometry,localIds:candidates.map(c=>c.id),labels});}catch{this.dispose('invalid-data');}
 }
 /** Only called after savePhotoBatch or comparePhotoSave proves the exact local rows. */
 async confirmed(receipt:PhotoSaveReceipt){
  const corrected=this.final,initial=this.initial,model=this.model;if(this.disposed||this.committed)return false;if(!this.controller.permitValid(this.permit)){this.dispose(this.controller.permitState(this.permit)==='paused'?'save-paused':'permission-changed');return false;}if(!initial||!model||!corrected){this.dispose('invalid-data');return false;}
  if(receipt.rows.length!==corrected.localIds.length||corrected.localIds.some((id,index)=>{const rows=receipt.rows.filter(r=>r.id===id);return rows.length!==1||rows[0].code!==corrected.labels[index].score||rows[0].source!=='photo'||corrected.labels[index].coordinateEvidence==='manual-target-confirmed'&&(rows[0].coordinateEvidence!=='manual-target-confirmed'||rows[0].x===null||rows[0].y===null||canonical(point({x:(rows[0].x+1.2)/2.4,y:(1.2-rows[0].y)/2.4}))!==canonical(corrected.labels[index].targetPoint));})){this.dispose('receipt-mismatch');return false;}
  this.committed=true;this.report('saving');const image=await this.image;if(this.disposed)return false;if(!this.controller.permitValid(this.permit)){this.dispose(this.controller.permitState(this.permit)==='paused'?'save-paused':'permission-changed');return false;}if(!image){this.dispose('image-unavailable');return false;}
  try{const manifest:Manifest={schema:'photo-contribution/v1',sampleId:this.sampleId,image:{kind:'inference-work-png',sha256:await sha256(image),bytes:image.size,width:this.width,height:this.height,mime:'image/png'},target:{...this.target},model:clone(model),initial:clone(initial),correctionEvents:clone(this.events),corrected:{geometry:corrected.geometry,labels:corrected.labels,removedPredictionIds:initial.predictions.filter(p=>!corrected.labels.some(c=>c.id===p.id)).map(p=>p.id)},confirmation:{kind:'user-confirmed-local-save',labelSource:'user-not-ground-truth',labels:clone(corrected.labels)}};
   if(new TextEncoder().encode(canonical(manifest)).length>512*1024-1024){this.dispose('invalid-data');return false;}
   const queued=await this.controller.enqueue(this.permit,manifest,image);this.report(this.controller.permitState(this.permit)==='invalid'?'permission-changed':!this.controller.permitValid(this.permit)?'queue-unconfirmed':queued?'queued':'queue-unconfirmed');return queued;
  }catch{this.report('queue-unconfirmed');return false;}finally{this.image=Promise.resolve(null);}
 }
 dispose(reason:CaptureStatus='disposed'){if(this.disposed)return;this.disposed=true;this.report(reason);this.canvas=null;this.image=Promise.resolve(null);this.initial=null;this.final=null;this.model=null;this.aliases.clear();this.events=[];this.current.clear();}
}
