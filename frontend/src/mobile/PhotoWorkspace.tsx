import {photoContributions} from './photo-contribution-runtime';
import {PhotoContributionCapture,contributionCaptureMessage,type CaptureStatus} from './photo-contribution-capture';
import {cloudSync} from './cloud-sync';
import type {CorrectionCause} from './photo-contribution-contract';
import React,{useEffect,useRef,useState,useSyncExternalStore} from 'react';
import {buildPhotoBatch,inUnit,type Candidate} from '../photo-geometry';
import {locateStandardTarget,type AutoFace} from '../auto-target';
import {importPhoto,type LocalPhoto} from '../photo-image';
import {inferContacts} from '../photo-assist/client';
import {photoWorkMaxLongEdge,recordPhotoStage,snapshotPhotoStages} from '../photo-assist/diagnostics';
import {photoTargetProfile} from '../photo-assist/target';
import {addArrow,confirmedPhotoTargetPoint,currentBlock,resizeEnd,scoreAt,uid,type Session} from './domain';
import {photoNextEndIssue,preparePhotoNextEnd} from './photo-group-flow';
import {exportText} from './store';
import {Button,Panel,sessionIn,useApp,useInnerBack} from './ui';
import {PhotoComparison} from './PhotoComparison';
import {ChoiceSelect} from './ChoiceSelect';
import {PhotoTargetNotice} from './PhotoTargetNotice';
import {PhotoReviewNudge} from './PhotoReviewControls';
import {manualPhotoSaveable,MANUAL_PHOTO_PREVIEW_EDGE} from './photo-manual-review';
import {buildPhotoDiagnosticReceipt,photoSha256,type CaptureDiagnostic,type DiagnosticCandidate,type PhotoDiagnosticActions,type PhotoDiagnosticDraft,type PhotoDiagnosticReceipt} from './photo-diagnostic';
import {adjacentCandidateId,adjustAutoFace,moveArrayItem,nudgePhotoPoint,photoPointToTarget,photoSaveModeNotice,scoreOrderValue,targetPointDisposition} from './photo-review';
import './media.css';
import {ManualCapture} from './ManualCapture';
import {PhotoHelp} from './PhotoHelp';
import {hasSeenPhotoHelp,finishPhotoHelp} from './photo-help';
import {savePhotoBatch,comparePhotoSave,type PhotoSaveReceipt} from './photo-save-receipt';
import './photo-next.css';
import './photo-review-controls.css';

declare const __ANDROID_VERSION__:string;
const APP_VERSION=typeof __ANDROID_VERSION__==='undefined'?'本地预览':__ANDROID_VERSION__;

async function enterReviewDisplay(element:HTMLElement|null){
 try{window.Gongxingji?.setReviewMode?.(true);}catch{}
 try{if(element?.requestFullscreen&&!document.fullscreenElement)await element.requestFullscreen();}catch{}
 return Boolean(document.fullscreenElement);
}
async function leaveReviewDisplay(){
 try{if(document.fullscreenElement)await document.exitFullscreen();}catch{}
 try{window.Gongxingji?.setReviewMode?.(false);}catch{}
}

export function photoCandidatesSaveable(candidates:readonly Candidate[],valid:(candidate:Candidate)=>boolean,manualPoint:(candidate:Candidate)=>{x:number;y:number}|null){
 return candidates.length>0&&candidates.every(candidate=>valid(candidate)||Boolean(manualPoint(candidate)));
}

export function photoCandidateSourceNotice(initial:readonly {id:string}[],current:readonly {id:string}[]){
 const initialIds=new Set(initial.map(candidate=>candidate.id)),modelCount=current.filter(candidate=>initialIds.has(candidate.id)).length,manualCount=current.length-modelCount;
 if(!current.length)return `${initial.length?'模型候选已全部移除':'模型未找到箭点'}；可在照片上补点并逐箭选环值，不代表本组零箭。`;
 const source=modelCount&&manualCount?`当前保留 ${modelCount} 个模型候选、${manualCount} 个手动补点`:modelCount?`当前保留 ${modelCount} 个模型候选`:`当前 ${manualCount} 个箭点均为手动补点`;
 return `${source}；靶面未定位，每箭环值请人工选择。`;
}

export function PhotoWorkspace({session,face,onBack,onDirtyChange}:{session:Session;face:number;onBack:()=>void;onDirtyChange?:(dirty:boolean)=>void}){
 const {update,tell,ask,retryPendingSave,hasPendingSave,readSaveState}=useApp(),target=session.conditions.target;
 const original=useRef({endId:session.ends[session.currentEnd]?.id,target:JSON.stringify(target),sessionId:session.id,face});
 const activeFace=original.current.face,end=session.ends.find(e=>e.id===original.current.endId),remaining=Math.max(0,(end?.capacity??0)-(end?.arrows.length??0));
 const profile=photoTargetProfile(target,activeFace),supported=profile!==null,radiusRatio=profile?.radiusRatio??1;
 const [photo,setPhoto]=useState<LocalPhoto|null>(null),[geometry,setGeometry]=useState<AutoFace|null>(null),[candidates,setCandidates]=useState<Candidate[]>([]);
 const nextEndIssue=end?photoNextEndIssue(session,end.id,candidates.length):'当前分组已变化，请返回成绩页核对。';
 const [phase,setPhase]=useState<'guide'|'processing'|'review'|'error'>('guide'),[busy,setBusy]=useState(false),[uncertain,setUncertain]=useState(false),[scanStep,setScanStep]=useState(0);
 const [manualReview,setManualReview]=useState(false);
 const sourceFile=useRef<File|null>(null),preparingManual=useRef(false);
 const [error,setError]=useState(''),[notice,setNotice]=useState(''),[selected,setSelected]=useState<string|null>(null),[editingPoint,setEditingPoint]=useState(false),[adding,setAdding]=useState(false),[orderMode,setOrderMode]=useState<'score-desc'|'custom'>('score-desc'),[nudgeStep,setNudgeStep]=useState<1|4>(1);
 const [mapping,setMapping]=useState({dx:0,dy:0,scale:1}),[saveCoordinates,setSaveCoordinates]=useState(false),[inlineLayout,setInlineLayout]=useState<'photo'|'target'>('target'),[compareFullscreen,setCompareFullscreen]=useState(false),[compareDisplayNote,setCompareDisplayNote]=useState(''),[fullscreenToolsOpen,setFullscreenToolsOpen]=useState(true);
 const [actualPhotoOpened,setActualPhotoOpened]=useState(false);
 const [scoreOverrides,setScoreOverrides]=useState<Record<string,string>>({});
 const [manualPoints,setManualPoints]=useState<Record<string,{x:number;y:number}>>({}),[markingTarget,setMarkingTarget]=useState<string|null>(null);
 const [capturing,setCapturing]=useState(false),[captureNote,setCaptureNote]=useState('');
 const [diagnostic,setDiagnostic]=useState<PhotoDiagnosticDraft|null>(null),[lastReceipt,setLastReceipt]=useState<PhotoDiagnosticReceipt|null>(null);
 const diagnosticActions=useRef<PhotoDiagnosticActions>({pointVisits:0,pointNudges:0,adds:0,deletes:0,scoreOverrides:0,mappingAdjustments:0,fullscreenEntries:0,saveAttempts:0});
 const saveReceipt=useRef<PhotoSaveReceipt|null>(null),contribution=useRef<PhotoContributionCapture|null>(null);
 const fileInput=useRef<HTMLInputElement>(null),compareStage=useRef<HTMLDivElement>(null),returnFocus=useRef<HTMLElement|null>(null),alive=useRef(true),generation=useRef(0),livePhoto=useRef<LocalPhoto|null>(null),abort=useRef<AbortController|null>(null),submitting=useRef(false);
 // Presentation-only status, bound to this photo generation and the current identity.
 useSyncExternalStore(photoContributions.subscribe,photoContributions.getSnapshot);
 useSyncExternalStore(cloudSync.subscribe,cloudSync.getStatus);
 const [contributionProgress,setContributionProgress]=useState<{status:CaptureStatus;ticket:number;identity:string}|null>(null);
 const reportContribution=(status:CaptureStatus,ticket:number,identity:string)=>{if(alive.current&&ticket===generation.current&&identity===photoContributions.captureContextKey())setContributionProgress({status,ticket,identity});};
 const currentContributionStatus=contributionProgress&&contributionProgress.ticket===generation.current&&contributionProgress.identity===photoContributions.captureContextKey()?(contribution.current?.getStatus()??contributionProgress.status):null;
 const contributionMessage=currentContributionStatus?contributionCaptureMessage(currentContributionStatus):'';
 const [teaching,setTeaching]=useState(()=>!hasSeenPhotoHelp());
 const finishTeaching=()=>{if(!finishPhotoHelp())setNotice('教学偏好暂未存入本机，重开可能再次提示；可以继续照片录入。');setTeaching(false);};
 const frozen=busy||uncertain,photoCandidatesOnly=manualReview&&diagnostic?.reviewMode==='photo-candidates-only';
 useInnerBack(true,()=>{if(compareFullscreen)void exitSplitCompare();else void close();},20);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;contribution.current?.dispose();contribution.current=null;generation.current++;abort.current?.abort();livePhoto.current?.dispose();livePhoto.current=null;sourceFile.current=null;void leaveReviewDisplay();};},[]);
 useEffect(()=>{if(!compareFullscreen)return;document.documentElement.classList.add('photo-review-fullscreen-open');const key=(event:KeyboardEvent)=>{if(event.key==='Escape'){void exitSplitCompare();return;}if(event.key!=='Tab')return;const focusable=[...(compareStage.current?.querySelectorAll<HTMLElement>('button:not(:disabled),select:not(:disabled),summary,[tabindex]:not([tabindex="-1"])')??[])].filter(element=>!element.hasAttribute('hidden')&&element.getClientRects().length>0);if(!focusable.length)return;const first=focusable[0],last=focusable[focusable.length-1];if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}};window.addEventListener('keydown',key);return()=>{document.documentElement.classList.remove('photo-review-fullscreen-open');window.removeEventListener('keydown',key);};},[compareFullscreen]);
 useEffect(()=>{if(!compareFullscreen)return;const frame=requestAnimationFrame(()=>compareStage.current?.querySelector<HTMLElement>('.photo-fullscreen-toolbar .button.primary')?.focus());return()=>cancelAnimationFrame(frame);},[compareFullscreen]);
 useEffect(()=>{const changed=()=>{if(compareFullscreen&&!document.fullscreenElement&&!window.Gongxingji?.setReviewMode)void exitSplitCompare();};document.addEventListener('fullscreenchange',changed);return()=>document.removeEventListener('fullscreenchange',changed);},[compareFullscreen]);
 useEffect(()=>{onDirtyChange?.(Boolean(photo)||busy||capturing);},[photo,busy,capturing,onDirtyChange]);
 useEffect(()=>()=>onDirtyChange?.(false),[onDirtyChange]);
 useEffect(()=>{const stop=()=>abort.current?.abort(),hidden=()=>{if(document.hidden)stop();};window.addEventListener('gongxingji-background',stop);document.addEventListener('visibilitychange',hidden);return()=>{window.removeEventListener('gongxingji-background',stop);document.removeEventListener('visibilitychange',hidden);};},[]);
 useEffect(()=>{if(!photo)return;const warn=(e:BeforeUnloadEvent)=>{e.preventDefault();e.returnValue='';};const navigation=(e:Event)=>e.preventDefault();window.addEventListener('beforeunload',warn);window.addEventListener('gongxingji:before-navigate',navigation);return()=>{window.removeEventListener('beforeunload',warn);window.removeEventListener('gongxingji:before-navigate',navigation);};},[photo]);
 useEffect(()=>{if(!uncertain||!candidates.length||!readSaveState||!saveReceipt.current)return;const expected=saveReceipt.current,state=readSaveState();if(state.pending&&comparePhotoSave(state.pending,expected).status==='complete')return;const match=comparePhotoSave(state.data,expected);if(match.status!=='complete'){if(match.status==='conflict')setError(match.reason??'保存对账冲突；候选保留，请返回本组核对');return;}const savedEnd=session.ends.find(item=>item.id===expected.end.id);if(!savedEnd)return;void contribution.current?.confirmed(expected);contribution.current=null;saveReceipt.current=null;setLastReceipt(receipt('saved'));setDiagnostic(null);livePhoto.current?.dispose();livePhoto.current=null;sourceFile.current=null;setManualReview(false);setUncertain(false);setError('');setNotice('');setCandidates([]);setPhoto(null);setGeometry(null);setSelected(null);setAdding(false);setManualPoints({});setMarkingTarget(null);setPhase('guide');tell('该批候选已核实保存，成绩已更新。');if(savedEnd.id!==original.current.endId)onBack();},[session.ends,uncertain,candidates,tell,onBack,readSaveState]);
 const reviewGeometry=geometry&&photo?adjustAutoFace(geometry,mapping.dx,mapping.dy,mapping.scale,photo.canvas.width,photo.canvas.height):geometry;
 const mobileOf=(c:Candidate)=>{if(!reviewGeometry||!photo)return null;const p=photoPointToTarget(reviewGeometry,{x:c.point.x*photo.canvas.width,y:c.point.y*photo.canvas.height},radiusRatio);return {x:p.x,y:-p.y};};
 const disposition=(c:Candidate)=>targetPointDisposition(mobileOf(c));
 const validCandidate=(c:Candidate)=>disposition(c)!=='invalid'&&inUnit(c.point);
 const outside=(c:Candidate)=>['miss-located','miss-unlocated'].includes(disposition(c));
 const recordable=(c:Candidate)=>validCandidate(c)&&disposition(c)!=='miss-unlocated';
 const automaticCodeOf=(c:Candidate)=>{if(manualReview)return null;const p=mobileOf(c),kind=disposition(c);return !p||kind==='invalid'?null:kind==='inside'?scoreAt(target,p.x,p.y):'M';};
 const codeOf=(c:Candidate)=>scoreOverrides[c.id]??(manualReview?null:automaticCodeOf(c));
 const manualPointOf=(c:Candidate)=>{if(manualReview)return null;const point=manualPoints[c.id],code=codeOf(c);return point&&code&&inUnit(c.point)&&Number.isFinite(point.x)&&Number.isFinite(point.y)&&Math.abs(point.x)<=1.2&&Math.abs(point.y)<=1.2&&scoreAt(target,point.x,point.y)===code?point:null;};
 const recordCorrection=(cause:CorrectionCause,items:Candidate[],overrides=scoreOverrides,points=manualPoints)=>{if(manualReview||!reviewGeometry)return;const code=(c:Candidate)=>overrides[c.id]??automaticCodeOf(c);contribution.current?.record(cause,items,reviewGeometry,radiusRatio,code,c=>{const p=points[c.id],s=code(c);return p&&s&&inUnit(c.point)&&Number.isFinite(p.x)&&Number.isFinite(p.y)&&Math.abs(p.x)<=1.2&&Math.abs(p.y)<=1.2&&scoreAt(target,p.x,p.y)===s?p:null;});};
 const confirmedManualPoints:Record<string,{x:number;y:number}>={};for(const candidate of candidates){const point=manualPointOf(candidate);if(point)confirmedManualPoints[candidate.id]=point;}
 const manualCount=Object.keys(confirmedManualPoints).length;
 const candidatesSaveable=manualReview?manualPhotoSaveable(candidates,scoreOverrides,target.allowed_score_codes):photoCandidatesSaveable(candidates,validCandidate,manualPointOf);
 const label=(c:Candidate)=>{if(manualReview){const code=codeOf(c);return code?`${code}${code==='M'||code==='X'?'':'环'} · 人工核对`:'待选环值';}if(!validCandidate(c)&&!manualPointOf(c))return '位置无效';const code=codeOf(c),base=scoreOverrides[c.id]?`${code}${code==='M'?'':'环'} · 已更正`:outside(c)?recordable(c)?'M · 圈外待确认':'M · 位置不保存':`${code}${code==='M'?'':'环'}`;return manualPointOf(c)?`${base} · 靶面已定位`:base;};
 const orderedCandidates=orderMode==='custom'?candidates:[...candidates].map((candidate,index)=>({candidate,index})).sort((a,b)=>scoreOrderValue(codeOf(b.candidate)??'')-scoreOrderValue(codeOf(a.candidate)??'')||a.index-b.index).map(item=>item.candidate);
 const selectedCandidate=candidates.find(candidate=>candidate.id===selected)??null,selectedOrderIndex=orderedCandidates.findIndex(candidate=>candidate.id===selected);
 useEffect(()=>{if(!candidates.length){if(selected)setSelected(null);return;}if(!selected||!candidates.some(candidate=>candidate.id===selected))setSelected(candidates[0].id);},[candidates,selected]);
 const diagnosticCandidates=(items=candidates):DiagnosticCandidate[]=>items.map(candidate=>({id:candidate.id,point:{...candidate.point},automaticCode:automaticCodeOf(candidate),finalCode:codeOf(candidate),disposition:manualReview?'manual-score-only':disposition(candidate),overridden:Boolean(scoreOverrides[candidate.id])}));
 function receipt(outcome:'review'|'saved'|'failed',items=candidates,draft=diagnostic){return draft?buildPhotoDiagnosticReceipt(draft,diagnosticCandidates(items),mapping,saveCoordinates,orderMode,outcome,diagnosticActions.current):null;}
 function exportReceipt(value:PhotoDiagnosticReceipt|null){if(!value)return;try{exportText(`gongxingji-photo-diagnostic-${value.batchId.slice(0,8)}.json`,JSON.stringify(value,null,2),'application/json');tell('本次照片诊断记录已导出；不含照片、文件名或训练身份。');}catch(reason){setError(reason instanceof Error?reason.message:'诊断记录导出失败。');}}
 async function load(file:File|undefined,capture:CaptureDiagnostic={source:'gallery',focus:'not-requested',voice:'not-requested'}){
  if(!file||frozen||!supported||!alive.current)return;
  const confirmationTicket=generation.current;
  if(photo&&await ask('更换照片？','当前未保存候选会清除，正式成绩保留。',['保留当前照片','更换'])!==1)return;
  if(!alive.current||confirmationTicket!==generation.current)return;
  const permit=photoContributions.beginLoad();contribution.current?.dispose();contribution.current=null;const ticket=++generation.current;const contributionIdentity=photoContributions.captureContextKey();reportContribution(permit?'preparing':'not-enabled',ticket,contributionIdentity);abort.current?.abort();const controller=new AbortController();abort.current=controller;
  let inferenceStarted=false;
  let draft:PhotoDiagnosticDraft={schema:'gongxingji-photo-diagnostic-v1',batchId:uid(),appVersion:APP_VERSION,startedAt:new Date().toISOString(),target:{id:target.id,name:target.name,face:activeFace},capture,input:{mime:file.type,bytes:file.size,sha256:null,fileNameIncluded:false},viewport:{width:window.innerWidth,height:window.innerHeight,devicePixelRatio:window.devicePixelRatio||1,orientation:screen.orientation?.type??null}};
   diagnosticActions.current={pointVisits:0,pointNudges:0,adds:0,deletes:0,scoreOverrides:0,mappingAdjustments:0,fullscreenEntries:0,saveAttempts:0};setBusy(true);setManualReview(false);setError('');setNotice('正在读取照片…');setScanStep(0);setPhase('processing');setPhoto(null);setGeometry(null);setCandidates([]);setSelected(null);setEditingPoint(false);setAdding(false);setActualPhotoOpened(false);setInlineLayout('target');setMapping({dx:0,dy:0,scale:1});setSaveCoordinates(false);saveReceipt.current=null;setScoreOverrides({});setManualPoints({});setMarkingTarget(null);setDiagnostic(draft);setLastReceipt(null);
  // Replacement was explicitly confirmed above; release its image before decoding another.
  livePhoto.current?.dispose();livePhoto.current=null;sourceFile.current=null;
  try{
   recordPhotoStage('PHOTO_BEGIN');
   const next=await importPhoto(file,photoWorkMaxLongEdge());if(!alive.current||ticket!==generation.current){next.dispose();return;}if(controller.signal.aborted){next.dispose();throw new DOMException('已取消','AbortError');}
   const sha256=await photoSha256(file);if(!alive.current||ticket!==generation.current){next.dispose();return;}if(controller.signal.aborted){next.dispose();throw new DOMException('已取消','AbortError');}recordPhotoStage('IMAGE_READY');
   livePhoto.current=next;sourceFile.current=file;setPhoto(next);setScanStep(1);setNotice('正在定位主靶…');const {canvas}=next;
   draft={...draft,input:{...draft.input,sha256},image:{width:canvas.width,height:canvas.height}};setDiagnostic(draft);
   const located=(()=>{const pixels=canvas.getContext('2d')!.getImageData(0,0,canvas.width,canvas.height);return locateStandardTarget(pixels.data,canvas.width,canvas.height);})();
   if(located.ok){
    recordPhotoStage('TARGET_READY');draft={...draft,geometry:{method:located.method,face:located.face}};setGeometry(located.face);
    if(permit&&photoContributions.permitState(permit)!=='invalid'&&typeof target.rules_version==='string')contribution.current=new PhotoContributionCapture(photoContributions,permit,canvas,{id:target.id,face:activeFace,rulesVersion:target.rules_version},status=>reportContribution(status,ticket,contributionIdentity));
    else if(permit)reportContribution(photoContributions.permitState(permit)==='invalid'?'permission-changed':'rules-unverified',ticket,contributionIdentity);
   }else{
    const message=located.reason==='ambiguous-target'?'画面中主靶不唯一，箭点可能来自不同靶位；请只保留本组实际箭。':'未能可靠定位主靶；仍可识别照片箭点，环值需逐箭选择。';
    draft={...draft,targetLocationIssue:located.reason,failure:message,failureStage:'target-location'};
    reportContribution('target-unverified',ticket,contributionIdentity);
    // No trusted target fit: do not create a contribution or fabricate a score/target point.
    if(located.reason==='invalid-image')throw Error('照片尺寸无法用于定位，请重新选择清晰照片。');
   }
   setDiagnostic(draft);setScanStep(2);inferenceStarted=true;
   const result=await inferContacts(canvas,controller.signal,message=>{if(alive.current&&ticket===generation.current){setNotice(message);setScanStep(message.includes('寻找')?3:2);}},!!contribution.current);
   if(!alive.current||ticket!==generation.current)return;
   if(controller.signal.aborted)throw new DOMException('已取消','AbortError');
   const found=result.peaks.map(p=>({id:uid(),point:{x:(p.x+.5)/result.width,y:(p.y+.5)/result.height},reviewed:false}));
   if(located.ok)contribution.current?.freeze(result,found,located.face,radiusRatio,c=>{const p=photoPointToTarget(located.face,{x:c.point.x*canvas.width,y:c.point.y*canvas.height},radiusRatio),m={x:p.x,y:-p.y};const kind=targetPointDisposition(m);return kind==='invalid'?null:kind==='inside'?scoreAt(target,m.x,m.y):'M';});
   draft={...draft,processingStages:snapshotPhotoStages(),inference:{milliseconds:result.inference_ms,initialCandidates:found.map(candidate=>({id:candidate.id,point:{...candidate.point}}))}};
   if(!located.ok){
    // The original worker has terminated before decoding a clearer display-only preview.
    let preview=next;
    try{if(Math.max(canvas.width,canvas.height)<MANUAL_PHOTO_PREVIEW_EDGE)preview=await importPhoto(file,MANUAL_PHOTO_PREVIEW_EDGE);}catch{draft={...draft,previewUnavailable:true};}
    if(!alive.current||ticket!==generation.current){if(preview!==next)preview.dispose();return;}
    if(controller.signal.aborted){if(preview!==next)preview.dispose();throw new DOMException('已取消','AbortError');}
    if(preview!==next){next.dispose();livePhoto.current=preview;setPhoto(preview);}
    draft={...draft,reviewMode:'photo-candidates-only',manualFallbackFrom:'target-location-failed',manualPreview:{width:preview.canvas.width,height:preview.canvas.height}};
    setManualReview(true);
   }
   setCandidates(found);setSelected(found[0]?.id??null);setDiagnostic(draft);
    setPhase('review');setOrderMode(located.ok?'score-desc':'custom');setNotice('');
  }catch(e){if(alive.current&&ticket===generation.current){recordPhotoStage(controller.signal.aborted?'CANCELLED':'PHOTO_FAILED');contribution.current?.dispose('invalid-data');contribution.current=null;reportContribution('invalid-data',ticket,contributionIdentity);const message=controller.signal.aborted?'已取消识别。请重新选图，或退出后使用手动记分。':(e as Error).message;draft={...draft,processingStages:snapshotPhotoStages(),failure:message,failureStage:controller.signal.aborted?'cancelled':inferenceStarted?'inference':draft.image?'target-location':'image'};setDiagnostic(draft);setPhase('error');setError(message);setNotice('没有把失败当作零箭结果，也没有保存成绩。');}}
  finally{if(alive.current&&ticket===generation.current)setBusy(false);}
 }
 async function beginManualReview(){
  const file=sourceFile.current;if(preparingManual.current||frozen||phase!=='error'||!photo||!file||!alive.current)return;
  preparingManual.current=true;setBusy(true);setError('');setNotice('正在准备人工核对照片…');
  const ticket=generation.current,controller=new AbortController();abort.current=controller;
  try{
   // inferContacts settles only after terminating its worker. This preview never enters inference.
   const next=Math.max(photo.canvas.width,photo.canvas.height)>=MANUAL_PHOTO_PREVIEW_EDGE?photo:await importPhoto(file,MANUAL_PHOTO_PREVIEW_EDGE);
   if(!alive.current||ticket!==generation.current||controller.signal.aborted){if(next!==photo)next.dispose();if(controller.signal.aborted)throw new DOMException('已取消','AbortError');return;}
   if(next!==photo){livePhoto.current?.dispose();livePhoto.current=next;setPhoto(next);}
   contribution.current?.dispose('manual-only');contribution.current=null;reportContribution('manual-only',ticket,photoContributions.captureContextKey());
   setGeometry(null);setMapping({dx:0,dy:0,scale:1});setSaveCoordinates(false);setManualPoints({});setMarkingTarget(null);
   setCandidates([]);setSelected(null);setScoreOverrides({});setOrderMode('custom');setAdding(false);setEditingPoint(false);
   setDiagnostic(draft=>draft?{...draft,reviewMode:'manual-photo',manualFallbackFrom:draft.failureStage==='cancelled'?'cancelled':draft.failureStage==='inference'?'inference-failed':'target-location-failed',manualPreview:{width:next.canvas.width,height:next.canvas.height}}:draft);
   setManualReview(true);setPhase('review');setNotice('');setInlineLayout('target');setActualPhotoOpened(false);
  }catch(reason){if(alive.current&&ticket===generation.current){setError(controller.signal.aborted?'已取消准备；当前照片仍保留。':'清晰预览暂未就绪，当前照片仍保留。可重新准备，或换一张照片。');setNotice('没有保存成绩。');}}
  finally{preparingManual.current=false;if(alive.current&&ticket===generation.current)setBusy(false);}
 }
 async function cancelManualReview(){
  if(frozen||!manualReview)return;const ticket=generation.current;
  if(candidates.length&&await ask('返回照片处理？','本次未保存的照片标记会清除，照片和已有正式成绩保留。',['继续核对','返回照片处理'])!==1)return;
  if(!alive.current||ticket!==generation.current)return;
  setCandidates([]);setSelected(null);setScoreOverrides({});setManualReview(false);setPhase('error');setError(diagnostic?.failure??'本次自动识别未完成。');setNotice('照片仍保留，未保存人工记录。');
 }
 async function close(){if(submitting.current||!alive.current)return;const ticket=generation.current;if(photo&&await ask('退出照片录入？',uncertain?'保存状态尚未核实，请先返回本组成绩检查，避免重复导入。':'未确认候选不会进入成绩；已有正式成绩保留，照片会从本机内存释放。',['继续核对','退出照片录入'])!==1)return;if(!alive.current||ticket!==generation.current)return;abort.current?.abort();onBack();}
  function selectCandidate(id:string){diagnosticActions.current.pointVisits++;setSelected(id);setEditingPoint(true);setAdding(false);setMarkingTarget(null);}
  function toggleAdding(){if(frozen)return;setAdding(!adding);setEditingPoint(false);setMarkingTarget(null);}
  function selectInlineView(view:'photo'|'target'){
   if(view==='photo')setActualPhotoOpened(true);
   if(inlineLayout===view)return;
   setInlineLayout(view);
   setAdding(false);
   setMarkingTarget(null);
  }
  function toggleInlineAdding(){
   if(frozen)return;
   selectInlineView('photo');
   toggleAdding();
  }
  function addPoint(point:{x:number;y:number}){if(frozen||phase!=='review'||!adding||!inUnit(point))return;if(candidates.length>=256){setError('候选过多，请重新拍摄或退出后使用手动记分。');return;}diagnosticActions.current.adds++;const id=uid();recordCorrection('add-point',[...candidates,{id,point,reviewed:false}]);setCandidates(v=>[...v,{id,point,reviewed:false}]);setSelected(id);setEditingPoint(true);setMarkingTarget(null);setError('');}
  function nudgeSelected(dx:number,dy:number){if(!photo||!selected||!editingPoint||frozen)return;diagnosticActions.current.pointNudges++;const points={...manualPoints};delete points[selected];recordCorrection('move-point',candidates.map(candidate=>candidate.id===selected?{...candidate,point:nudgePhotoPoint(candidate.point,dx*nudgeStep,dy*nudgeStep,photo.canvas.width,photo.canvas.height)}:candidate),scoreOverrides,points);setCandidates(items=>items.map(candidate=>candidate.id===selected?{...candidate,point:nudgePhotoPoint(candidate.point,dx*nudgeStep,dy*nudgeStep,photo.canvas.width,photo.canvas.height)}:candidate));setManualPoints(current=>{const next={...current};delete next[selected];return next;});setMarkingTarget(null);setError('');}
 function chooseOrder(next:'score-desc'|'custom'){if(next===orderMode)return;if(next==='custom')setCandidates(orderedCandidates);setOrderMode(next);}
 function moveSelected(offset:number){if(!selected||orderMode!=='custom')return;setCandidates(items=>{const from=items.findIndex(candidate=>candidate.id===selected);return moveArrayItem(items,from,from+offset);});}
  function selectAdjacent(offset:-1|1){const next=adjacentCandidateId(orderedCandidates.map(candidate=>candidate.id),selected,offset);if(next){diagnosticActions.current.pointVisits++;setSelected(next);setEditingPoint(true);setAdding(false);setMarkingTarget(null);}}
   async function enterSplitCompare(){
    diagnosticActions.current.fullscreenEntries++;
    returnFocus.current=document.activeElement instanceof HTMLElement?document.activeElement:null;
    setAdding(false);setEditingPoint(false);setMarkingTarget(null);setFullscreenToolsOpen(true);setCompareFullscreen(true);
    const browserFullscreen=await enterReviewDisplay(compareStage.current);
    if(!alive.current)return;
    const description=manualReview?'左侧照片可标记，右侧为靶面参考。':'左侧照片、右侧靶面映射；两图可同步缩放。';
    const needsRotation=!window.Gongxingji?.setReviewMode&&!(browserFullscreen&&window.innerWidth>window.innerHeight);
    setCompareDisplayNote(needsRotation?description+' 可横置设备查看。':description);
   }
  async function exitSplitCompare(){setCompareFullscreen(false);setCompareDisplayNote('');setAdding(false);setEditingPoint(false);setMarkingTarget(null);await leaveReviewDisplay();requestAnimationFrame(()=>{
   const original=returnFocus.current;
   const trigger=original?.isConnected?original:compareStage.current?.querySelector<HTMLButtonElement>('.photo-compare-open');
   trigger?.focus({preventScroll:true});
  });}
  function removeSelected(){if(!selected||frozen||phase!=='review')return;diagnosticActions.current.deletes++;const index=candidates.findIndex(candidate=>candidate.id===selected),next=candidates.filter(candidate=>candidate.id!==selected);recordCorrection('remove-point',next);setCandidates(next);setSelected(next[Math.min(Math.max(0,index),Math.max(0,next.length-1))]?.id??null);setEditingPoint(false);setScoreOverrides(current=>{const copy={...current};delete copy[selected];return copy;});setManualPoints(current=>{const copy={...current};delete copy[selected];return copy;});setMarkingTarget(null);setError('');}
  function overrideSelected(code:string){if(!selected||frozen||phase!=='review'||!target.allowed_score_codes.includes(code))return;diagnosticActions.current.scoreOverrides++;const points={...manualPoints};delete points[selected];recordCorrection('set-score',candidates,{...scoreOverrides,[selected]:code},points);setScoreOverrides(current=>({...current,[selected]:code}));setManualPoints(current=>{const copy={...current};delete copy[selected];return copy;});setMarkingTarget(null);setError('');}
  function restoreSelectedScore(){if(!selected||frozen||phase!=='review')return;const overrides={...scoreOverrides},points={...manualPoints};delete overrides[selected];delete points[selected];recordCorrection('restore-score',candidates,overrides,points);setScoreOverrides(current=>{const copy={...current};delete copy[selected];return copy;});setManualPoints(current=>{const copy={...current};delete copy[selected];return copy;});setMarkingTarget(null);setError('');}
  function beginManualPosition(){
   if(manualReview||!reviewGeometry||!selected||frozen)return;
   setMarkingTarget(selected);setAdding(false);setError('');
   if(compareFullscreen)return;
   setInlineLayout('target');
   requestAnimationFrame(()=>{
    const surface=compareStage.current?.querySelector<SVGSVGElement>('figure.media-compare-target svg');
    surface?.scrollIntoView({block:'center',inline:'nearest'});
    surface?.focus({preventScroll:true});
   });
  }
  function confirmManualPosition(point:{x:number;y:number}){const candidate=candidates.find(item=>item.id===markingTarget);if(manualReview||!reviewGeometry||!candidate||frozen)return;const code=codeOf(candidate);if(!code){setError('先核对并选择此点的环值，再确认靶面位置。');return;}try{const verified=confirmedPhotoTargetPoint(target,code,point);recordCorrection('set-target-point',candidates,scoreOverrides,{...manualPoints,[candidate.id]:verified});setManualPoints(current=>({...current,[candidate.id]:verified}));setMarkingTarget(null);setError('');setNotice('本点靶面位置已由你手动确认；其余候选仍按各自保存方式处理。');}catch(reason){setError(reason instanceof Error?reason.message:'靶面位置无法确认');}}
 async function expandCapacity(){
  if(!end||frozen||candidates.length<=remaining)return;const required=end.arrows.length+candidates.length,ticket=generation.current;
  const choice=await ask('扩大本组箭数？',`上一组已录的 ${end.arrows.length} 箭和这 ${candidates.length} 个候选将留在同一组；不会自动保存候选。`,['返回核对','扩大本组']);if(!alive.current||ticket!==generation.current||choice!==1)return;
  if(await update(data=>{if(!alive.current||ticket!==generation.current)throw Error('照片确认已失效，未调整容量。');const s=sessionIn(data,original.current.sessionId),e=s.ends[s.currentEnd];if(!e||e.id!==original.current.endId||e.confirmed||s.status!=='active'||s.rest.some(rest=>!rest.ended)||currentBlock(s)?.kind==='rest'||JSON.stringify(s.conditions.target)!==original.current.target)throw Error('当前场次或分组已变化，未调整容量。');if(e.arrows.length!==end.arrows.length||e.capacity!==end.capacity)throw Error('本组成绩或容量已变化，请重新核对。');resizeEnd(s,required);})&&alive.current&&ticket===generation.current){setNotice(`本组容量已调整为 ${required} 箭；没有截断候选或覆盖已有成绩。`);setError('');}
 }
 async function save(destination:'current'|'next'='current'){
  if(submitting.current||frozen||phase!=='review'||(!manualReview&&!reviewGeometry)||!candidatesSaveable
    ||(destination==='current'&&candidates.length>remaining)
    ||(destination==='next'&&nextEndIssue))return;
  if(!readSaveState){setError('本机保存对账入口尚未初始化；候选保留');return;}
  const ticket=generation.current;diagnosticActions.current.saveAttempts++;
  const snapshot=orderedCandidates.map(c=>({...c,point:{...c.point},reviewed:true})),outer=snapshot.filter(outside).length,unlocated=snapshot.filter(c=>!recordable(c)&&!manualPointOf(c)).length,manual=snapshot.filter(c=>scoreOverrides[c.id]).length,scoreById=new Map(snapshot.map(candidate=>[candidate.id,codeOf(candidate)]));
  const manuallyLocated=new Map(snapshot.flatMap(candidate=>{const point=manualPointOf(candidate);return point?[[candidate.id,{...point}] as const]:[];}));submitting.current=true;setBusy(true);
  try{
    const missing=destination==='next'&&end?end.capacity-end.arrows.length:0;
    const prompt=destination==='next'?`上一组计划 ${end?.capacity??0} 箭，已录 ${end?.arrows.length??0} 箭；这 ${snapshot.length} 个候选将加入下一组。`:`将按当前顺序把 ${snapshot.length} 个候选加入本组。`;
    const located=!manualReview&&saveCoordinates&&reviewGeometry?snapshot.filter(candidate=>!manuallyLocated.has(candidate.id)&&recordable(candidate)&&!scoreOverrides[candidate.id]):[];
    const byId=new Map<string,ReturnType<typeof buildPhotoBatch>['arrows'][number]>();
    for(const candidate of located){
      try{
        const mapped=buildPhotoBatch([candidate],reviewGeometry!.controls,activeFace,1,radiusRatio).arrows[0];
        const code=scoreById.get(candidate.id),point={x:(mapped.plot_x_norm-.5)*2.4,y:(.5-mapped.plot_y_norm)*2.4};
        if(code&&scoreAt(target,point.x,point.y)===code)byId.set(candidate.id,mapped);
      }catch{/* This candidate can still be saved as a reviewed score, without claiming a position. */}
    }
    const details=manualReview?`${photoCandidatesOnly?'箭点模型已运行，但靶面未定位，未自动判环。':'本次自动识别未完成。'}这 ${snapshot.length} 箭均由你按照片人工核对，只保存明确选择的环值，不保存靶面坐标。${prompt}未知箭不要猜测为 M。照片只在当前核对页暂存，训练记录不保存原图。`:`请确认原图是本次实际主靶，剩余每个点都属于本组且环值已核对；未知、固定钉或其他组落点请返回更正，不自动算作 M。${prompt}${manual?`其中 ${manual} 个环值已由你更正。`:''}${manuallyLocated.size?`其中 ${manuallyLocated.size} 个点由你在靶面逐个定位。`:''}${saveCoordinates?`另有 ${byId.size} 个可保存的实验参考位置；其余未人工定位的候选只存环值。${outer?`其中 ${outer} 个自动映射为圈外。`:''}${unlocated?`${unlocated} 个离靶较远。`:''}`:`其余 ${snapshot.length-manuallyLocated.size} 个点只保存环值。`}压线仍请按照片核对；个人训练不保存照片原图。${contributionMessage}`;
    let missingMode:'M'|'skip'='skip';
    if(missing>0){
      const choice=await ask('上一组少录的箭如何处理？',`${details}若上一组照片漏检命中箭，请先返回补点或手动录入；只有确认脱靶才记 M。`,['返回核对',`少的 ${missing} 箭确实脱靶，记 M`,`仅保存已录 ${end?.arrows.length??0} 箭，不记 M`]);
      if(!alive.current||ticket!==generation.current||choice===0)return;
      missingMode=choice===1?'M':'skip';
    }else{const choice=await ask(destination==='next'?'保存上一组并加入下一组？':manualReview?'确认人工核对的环值？':'确认本组落点和参考环值？',details,['返回核对','确认保存']);if(!alive.current||ticket!==generation.current||choice!==1)return;}
   if(!alive.current||ticket!==generation.current)return;
   if(!manualReview&&reviewGeometry)contribution.current?.corrected(snapshot,reviewGeometry,radiusRatio,codeOf,manualPointOf);
   const result=await savePhotoBatch(update,readSaveState,data=>{
     if(!alive.current||ticket!==generation.current)throw Error('照片确认已失效，未加入成绩。');
     const s=sessionIn(data,original.current.sessionId),previous=s.ends[s.currentEnd];
     if(!previous||previous.id!==original.current.endId||previous.confirmed||s.status!=='active'
       ||s.rest.some(rest=>!rest.ended)||currentBlock(s)?.kind==='rest'
       ||JSON.stringify(s.conditions.target)!==original.current.target)throw Error('当前场次或分组已变化，未加入成绩。');
     const existing=new Set(s.ends.flatMap(item=>item.arrows.map(arrow=>arrow.id)));
     if(snapshot.some(candidate=>existing.has(candidate.id)))throw Error('此批候选已有保存标识，未重复加入。');
      if(destination==='next')preparePhotoNextEnd(s,previous.id,snapshot.length,end?.arrows.length??0,end?.capacity??0,missingMode,activeFace);
     const targetEnd=s.ends[s.currentEnd];
     if(targetEnd.arrows.length+snapshot.length>targetEnd.capacity)throw Error('目标分组位置不足，未截断候选。');
     for(const candidate of snapshot){
       const locatedArrow=byId.get(candidate.id),code=scoreById.get(candidate.id);
       if(!code)throw Error('候选环值无效，未保存。');
       const manualPoint=manuallyLocated.get(candidate.id);
       if(manualPoint){addArrow(s,code,activeFace,null,manualPoint,'photo');targetEnd.arrows[targetEnd.arrows.length-1].coordinateEvidence='manual-target-confirmed';}
       else if(saveCoordinates&&locatedArrow){const point={x:(locatedArrow.plot_x_norm-.5)*2.4,y:(.5-locatedArrow.plot_y_norm)*2.4};addArrow(s,code,activeFace,null,point,'photo');}
       else addArrow(s,code,activeFace,null,undefined,'photo');
       targetEnd.arrows[targetEnd.arrows.length-1].id=candidate.id;
       if(manualReview)targetEnd.arrows[targetEnd.arrows.length-1].note=photoCandidatesOnly?'按照片人工核对（靶面未定位，环值人工确认）':'按照片人工核对（自动识别未完成）';
     }
     return {sessionId:s.id,endId:targetEnd.id,candidateIds:snapshot.map(candidate=>candidate.id),...(destination==='next'?{previousEndId:previous.id}:{})};
   });
   if(!alive.current||ticket!==generation.current)return;
   saveReceipt.current=result.receipt;
   if(result.status==='saved'){if(result.receipt)void contribution.current?.confirmed(result.receipt);contribution.current=null;saveReceipt.current=null;setLastReceipt(receipt('saved',snapshot));setDiagnostic(null);setManualReview(false);livePhoto.current?.dispose();livePhoto.current=null;sourceFile.current=null;setPhoto(null);setGeometry(null);setCandidates([]);setSelected(null);setEditingPoint(false);setAdding(false);setScoreOverrides({});setManualPoints({});setMarkingTarget(null);setMapping({dx:0,dy:0,scale:1});setPhase('guide');setCaptureNote('');if(destination==='next'){tell('上一组已保存，本批候选已加入下一组。');onBack();}else setNotice(manualReview?`已保存 ${snapshot.length} 箭人工核对环值；${photoCandidatesOnly?'模型已运行，未自动判环。':'本次自动识别未完成。'}`:`已把 ${snapshot.length} 个核对点加入本组；可继续拍摄或切换录入方式。`);}else if(result.status==='pending'){setUncertain(true);setError('完整批次与本机待保存内容一致，但尚未持久保存。可重试同一批，不会再次加入。');}else if(result.status==='conflict'){setUncertain(true);setError('保存的完整行、归属或上一组处理未能对账；候选保留，请返回本组检查，勿重复加入。');}else setError('本次保存没有开始，可能正有另一项保存。候选仍可编辑，请稍候再点确认。');
  }catch(e){if(alive.current&&ticket===generation.current)setError((e as Error).message);}finally{submitting.current=false;if(alive.current&&ticket===generation.current)setBusy(false);}
 }
 async function retryBatch(){if(!uncertain||!readSaveState||!saveReceipt.current)return;const state=readSaveState();if(!state.pending||comparePhotoSave(state.pending,saveReceipt.current).status!=='complete'){setError('没有与本批完整内容一致的待保存资料；候选保留，请返回本组核对。');return;}await retryPendingSave();}
  return <section className="mobile-photo photo-inline-workspace photo-clean-workspace" aria-label="本组照片录入">
   {contributionMessage&&<p className="caption" role="status" aria-label="本次照片的模型改进状态">{contributionMessage}</p>}{(currentContributionStatus==='verification-failed'||currentContributionStatus==='verification-unconfirmed')&&<Button type="button" disabled={photoContributions.getSnapshot().busy||cloudSync.getStatus().busy} onClick={()=>void contribution.current?.retryVerification(()=>cloudSync.verifySession())}>重新核对账号和参与状态</Button>}<div className="photo-inline-heading"><div><h3>本组照片录入 <small>测试版</small></h3><p>{target.name}{target.face_count>1?` · ${activeFace}号靶位`:''} · 剩余 {remaining} 箭</p></div></div>
  {teaching&&<PhotoHelp onDone={finishTeaching} onSkip={finishTeaching}/>}
  {!compareFullscreen&&<div data-guide-target={!supported?"photo-unsupported":undefined}><PhotoTargetNotice target={target} face={activeFace} issue={diagnostic?.targetLocationIssue} disabled={frozen||capturing} onManual={()=>void close()}/></div>}
  {(!photo||phase!=='review')&&<Panel><p className="photo-entry-note">照片只提供候选，逐箭核对后保存。</p><p className="photo-upload-formats">本机处理 · JPEG、PNG 或 WebP · 每张最多 20 MB</p>
   {!supported?null:<>

    <div className="media-actions" data-guide-target={phase==='guide'&&!teaching&&!capturing?'photo-import':undefined}><Button disabled={frozen} kind="primary" onClick={()=>setCapturing(true)}>拍摄照片</Button><Button disabled={frozen} onClick={()=>fileInput.current?.click()}>{photo?'更换照片':'从相册选择'}</Button>{busy&&!submitting.current&&<Button onClick={()=>abort.current?.abort()}>取消处理</Button>}</div>
    <details className="photo-file-details"><summary>图片要求与拍摄教学</summary><p>尽量正对主靶，确保箭孔清晰。识别失败时可返回手动记分。</p><Button className="photo-entry-help" disabled={frozen} onClick={()=>setTeaching(true)}>重看拍摄教学</Button></details></>}
  </Panel>}
  <input ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={e=>{void load(e.target.files?.[0]);e.target.value='';}}/>
  {capturing&&<ManualCapture onClose={()=>setCapturing(false)} onGallery={()=>{setCapturing(false);fileInput.current?.click();}} onPhoto={result=>{setCapturing(false);setCaptureNote(result.method==='video-frame'?'已使用完整相机视频帧拍摄，引导标记不会进入照片；若细节不清，请重新拍摄或从相册选择清晰原图。':'已使用相机静态照片，引导标记不会进入照片。');void load(result.file,{source:result.method==='photo'?'camera-photo':'camera-frame',focus:result.evidence?.focus??'not-requested',focusPoint:result.evidence?.focusPoint,voice:result.evidence?.voice??'not-requested',capturedAt:result.evidence?.capturedAt});}}/>}
   {photo&&phase==='processing'&&<div className="photo-scan-preview" role="status" aria-live="polite" aria-label={`照片分析进度，第 ${scanStep+1} 步，共 4 步`}><div className="photo-scan-image"><img src={photo.url} alt="正在分析的导入照片"/><span className="photo-scan-shade" aria-hidden="true"/><span className="photo-scan-line" aria-hidden="true"/></div><div className="photo-scan-status"><b>{notice||'正在分析照片…'}</b><span>第 {scanStep+1}/4 步</span></div><div className="photo-scan-progress" role="progressbar" aria-valuemin={1} aria-valuemax={4} aria-valuenow={scanStep+1}><i style={{width:`${(scanStep+1)*25}%`}}/></div><ol className="photo-scan-steps">{['读取照片','检查靶面','加载模型','寻找落点'].map((label,index)=><li key={label} className={index<scanStep?'done':index===scanStep?'active':''}>{label}</li>)}</ol></div>}
   {captureNote&&phase!=='review'&&<p className="caption">{captureNote}</p>}{notice&&phase!=='review'&&phase!=='processing'&&<p role="status" className="notice">{notice}</p>}{error&&<p role="alert" className="notice">{error}</p>}
  {(diagnostic||lastReceipt)&&!(photo&&(manualReview||reviewGeometry)&&phase==='review')&&<details className="photo-diagnostic"><summary>真机测试记录（可选）</summary><p>仅导出版本、照片 SHA-256 摘要、处理尺寸、对焦/语音结果、自动几何、候选修改、映射调整和保存状态；不含照片、文件名、训练身份，也不会上传。</p><Button disabled={busy&&!diagnostic?.failure} onClick={()=>exportReceipt(lastReceipt??receipt(phase==='error'?'failed':'review'))}>{lastReceipt?'导出刚才已保存记录':'导出当前诊断记录'}</Button>{(lastReceipt??(diagnostic&&receipt(phase==='error'?'failed':'review')))?.input.sha256===null&&<small>当前环境无法计算照片摘要，其余记录仍可导出。</small>}</details>}
  {photo&&phase==='error'&&<Panel title="照片仍在，未保存成绩"><img className="manual-photo-failed-preview" src={photo.url} alt="本次未完成识别的照片"/><Button kind="primary" disabled={frozen} data-guide-target="photo-manual" onClick={()=>void beginManualReview()}>看照片手动录分</Button><p className="caption">由你逐箭核对，不重新运行识别。照片仅在当前页面暂存。</p></Panel>}
  {photo&&(manualReview||reviewGeometry)&&phase==='review'&&<Panel title={photoCandidatesOnly?'照片箭点核对':manualReview?'按照片人工核对':'识别结果核对'}>
    <div className="photo-review-summary" role="status" data-candidate-count={candidates.length}>
     <div><b>{photoCandidatesOnly?`待核对 ${candidates.length} 个照片箭点`:manualReview?`已标记 ${candidates.length} 箭`:`发现 ${candidates.length} 个候选`}</b>
      <span>{manualReview?'逐箭核对环值':`靶面手动定位 ${manualCount}/${candidates.length} 点`}</span>
     </div>
     <p>{photoCandidatesOnly?photoCandidateSourceNotice(diagnostic?.inference?.initialCandidates??[],candidates):manualReview?'自动识别未完成，不生成靶面落点；确认环值后保存。':manualCount?`其中 ${manualCount} 点已逐个在靶面定位；未定位点仍按所选方式保存。`:photoSaveModeNotice(saveCoordinates)}</p>
    </div>
    {photoCandidatesOnly&&diagnostic?.targetLocationIssue==='ambiguous-target'&&<p role="alert">主靶不唯一，照片候选可能来自不同靶位；请删除其他靶位、旧箭或其他组的点。</p>}
    {photoCandidatesOnly&&diagnostic?.previewUnavailable&&<p role="status">清晰预览暂未生成，已保留当前照片和候选；看不清的箭请更换照片，勿猜测环值。</p>}
    <div ref={compareStage} className={`photo-compare-stage${compareFullscreen?' photo-compare-fullscreen':''}${compareFullscreen&&!fullscreenToolsOpen?' photo-tools-collapsed':''}`} role={compareFullscreen?'dialog':undefined} aria-modal={compareFullscreen||undefined} aria-label={compareFullscreen?(manualReview?'全屏实际照片与靶面参考左右对照':'全屏实际照片与映射参考左右对照'):undefined}>
     {!compareFullscreen?<div className="photo-result-view" data-guide-photo-view={inlineLayout}>
      <div className="photo-result-controls" role="group" aria-label="照片核对视图">
       <Button kind={inlineLayout==='target'?'selected':''} aria-pressed={inlineLayout==='target'} onClick={()=>selectInlineView('target')}>靶面</Button>
       <Button kind={inlineLayout==='photo'?'selected':''} aria-pressed={inlineLayout==='photo'} data-guide-target={!actualPhotoOpened?'photo-review':undefined} onClick={()=>selectInlineView('photo')}>实际照片</Button>
       <Button className="photo-compare-open" onClick={()=>void enterSplitCompare()}>横屏放大</Button>
      </div>
      {actualPhotoOpened&&<div className="photo-inline-actions">
       <Button disabled={frozen} kind={adding?'selected':''} aria-pressed={adding} data-guide-target={!adding&&!candidates.length?'photo-missing-point':undefined} onClick={toggleInlineAdding}>
        {adding?(manualReview?'完成标记':'完成补点'):(manualReview?'标记一箭':'补漏点')}
       </Button>
       {adding&&<span role="status">{manualReview?'点照片标记箭位，再选环值。':'点实际照片补上漏点，再核对环值。'}</span>}
      </div>}
      {inlineLayout==='target'&&<p className="photo-mapping-note" role="status">
       {markingTarget?'点靶面确认选中点的位置，须与已核对环值一致。':manualReview?'当前靶面供参考。切换到实际照片核对箭位和环值。':'落点为映射参考，压线请切到实际照片核对。'}
      </p>}
      <PhotoComparison photo={photo} geometry={reviewGeometry} radiusRatio={radiusRatio} target={target} candidates={candidates} selected={selected} adding={inlineLayout==='photo'&&adding} frozen={frozen} layout={inlineLayout} showAlignment={false} showZoomControls={inlineLayout==='photo'} onSelect={selectCandidate} onAdd={addPoint} manualPoints={confirmedManualPoints} markingCandidateId={markingTarget} onTargetPoint={confirmManualPosition}/>
     </div>:<><header className="photo-fullscreen-toolbar"><div className="photo-fullscreen-title"><b>{manualReview?'实际照片与靶面参考':'实际照片与映射对照'}</b><span>{markingTarget?'请点右侧靶面确认选中点位置；环值须一致。':compareDisplayNote||'正在打开左右对照…'}</span></div><Button className="photo-fullscreen-toggle" aria-expanded={fullscreenToolsOpen} onClick={()=>setFullscreenToolsOpen(value=>{const next=!value;if(!next){setAdding(false);setEditingPoint(false);setMarkingTarget(null);}return next;})}>{fullscreenToolsOpen?'收起工具':'展开工具'}</Button><Button kind="primary" onClick={()=>void exitSplitCompare()}>退出全屏</Button></header><PhotoComparison photo={photo} geometry={reviewGeometry} radiusRatio={radiusRatio} target={target} candidates={candidates} selected={editingPoint?selected:null} adding={adding} frozen={frozen} layout="split" showAlignment={false} onSelect={selectCandidate} onAdd={addPoint} manualPoints={confirmedManualPoints} markingCandidateId={markingTarget} onTargetPoint={confirmManualPosition}/></>}
     {compareFullscreen&&<>
      {fullscreenToolsOpen&&editingPoint&&selectedCandidate&&!adding&&!markingTarget&&<PhotoReviewNudge disabled={frozen} step={nudgeStep} onStep={setNudgeStep} onNudge={nudgeSelected}/>}
      <footer className="photo-fullscreen-editbar" aria-label="全屏落点编辑">
       <div className="photo-review-point-row"><Button disabled={frozen||selectedOrderIndex<=0} aria-label="上一候选点" onClick={()=>selectAdjacent(-1)}>上一点</Button><b>{selectedCandidate?`第 ${selectedOrderIndex+1}/${orderedCandidates.length} 点 · ${label(selectedCandidate)}`:'暂无候选'}</b><Button disabled={frozen||selectedOrderIndex<0||selectedOrderIndex>=orderedCandidates.length-1} aria-label="下一候选点" onClick={()=>selectAdjacent(1)}>下一点</Button></div>
       <div className="photo-review-action-row">
        <Button disabled={frozen} kind={adding?'selected':''} aria-pressed={adding} onClick={toggleAdding}>{adding?'完成补点':manualReview?'标记一箭':'补漏点'}</Button>
        {!editingPoint&&selectedCandidate&&!adding&&<Button disabled={frozen} onClick={()=>setEditingPoint(true)}>编辑本点</Button>}
        {editingPoint&&<Button disabled={frozen} kind="primary" onClick={()=>{setEditingPoint(false);setMarkingTarget(null);}}>完成本点</Button>}
        {editingPoint&&selectedCandidate&&<label>环值<ChoiceSelect key={selectedCandidate.id} className="photo-ring-trigger" aria-label="全屏选中点保存环值" overlayContainer={compareStage.current??undefined} value={codeOf(selectedCandidate)??''} disabled={frozen} onChange={event=>overrideSelected(event.target.value)}><option value="" disabled>选择环值</option>{target.allowed_score_codes.map(code=><option key={code} value={code}>{code}</option>)}</ChoiceSelect></label>}
        {editingPoint&&selectedCandidate&&<details className="photo-review-more"><summary>更多</summary><div onClick={event=>{if((event.target as HTMLElement).closest('button')){const menu=event.currentTarget.parentElement;menu?.removeAttribute('open');menu?.querySelector('summary')?.focus();}}}>
         {!manualReview&&<Button disabled={frozen} aria-pressed={markingTarget===selected} onClick={()=>{if(markingTarget===selected)setMarkingTarget(null);else beginManualPosition();}}>{markingTarget===selected?'取消靶面定位':manualPointOf(selectedCandidate)?'重标靶面位置':'确认靶面位置'}</Button>}
         {!manualReview&&scoreOverrides[selectedCandidate.id]&&<Button disabled={frozen} onClick={restoreSelectedScore}>恢复自动环值</Button>}
         <Button disabled={frozen} onClick={removeSelected}>删除选中点</Button>
        </div></details>}
       </div>
       <p className="photo-review-mode-note" role="status">{adding?(manualReview?'在左侧照片标记；右侧无映射，不会新增落点。':'可在照片或右侧映射靶补点；新点仍须核对环值，不自动成为可信位置。'):markingTarget?'点右侧靶面确认本点位置；环值须一致。':editingPoint?'右侧方向键按原照片像素微调；更改后请核对环值。':'点选候选后编辑；确认加入仍在退出全屏后完成。'}</p>
      </footer>
     </>}
   </div>
   <div className="photo-score-review"><b>{manualReview?'人工环值 · 逐箭选择':'候选环值 · 点选核对'}</b><div className="auto-photo-scores" aria-label="候选参考环值和保存顺序">{orderedCandidates.map((c,index)=><Button key={c.id} disabled={frozen} aria-pressed={editingPoint&&selected===c.id} kind={editingPoint&&selected===c.id?'selected':''} onClick={()=>selectCandidate(c.id)}>{index+1} · {label(c)}</Button>)}</div>{!compareFullscreen&&selectedCandidate&&<div className="photo-inline-score-editor" role="group" aria-label="选中候选核对"><label>第 {selectedOrderIndex+1} 点 · 环值<ChoiceSelect key={selectedCandidate.id} className="photo-ring-trigger" aria-label="选中候选环值" value={codeOf(selectedCandidate)??''} disabled={frozen} onChange={event=>overrideSelected(event.target.value)}><option value="" disabled>选择环值</option>{target.allowed_score_codes.map(code=><option key={code} value={code}>{code==='M'?'M · 脱靶':code==='X'?'X · 内十环':code+' 环'}</option>)}</ChoiceSelect></label><div className="photo-inline-score-actions">{!manualReview&&scoreOverrides[selectedCandidate.id]&&<Button disabled={frozen} onClick={restoreSelectedScore}>恢复识别环值</Button>}<Button disabled={frozen} onClick={removeSelected}>删除错点</Button></div><p role="status">{scoreOverrides[selectedCandidate.id]?'已更正候选，确认加入后才保存到本组。':'请对照照片核对；修改不会立即写入本组。'}</p></div>}<p className="caption">{manualReview?'未选环值不能保存，未知箭不要记成 M。序号是保存顺序。':'自动环值供参考；压线请按照片核对。序号是保存顺序，修改后会在这里更新。'}</p>{!manualReview&&<><Button disabled={!selectedCandidate||frozen} onClick={beginManualPosition}>{selectedCandidate&&manualPointOf(selectedCandidate)?'重标选中点靶面位置':'在靶面确认选中点位置'}</Button><p className="caption">在靶面逐点确认位置。其余候选可只存环值。</p></>}</div>
    {candidates.some(c=>outside(c)&&!recordable(c))&&<p role="status">有点按自动映射离靶较远：未逐点在靶面定位时仅保存无坐标 M；误点请删除。</p>}
    {uncertain&&<div className="photo-save-retry" role="alert"><Button kind="primary" onClick={()=>void retryBatch()}>重试保存这批</Button><span>重试使用同一批标识，不会重复加入。</span></div>}
   {candidates.length>remaining&&<div className="photo-capacity-alert" role="alert"><p>候选比本组剩余位置多 {candidates.length-remaining} 个。请选择保存方式；尚未改动正式成绩。</p>{!manualReview&&Boolean(end?.arrows.length)&&<Button disabled={frozen||!!nextEndIssue||!candidatesSaveable} onClick={()=>void save('next')}>保存上一组，候选加入下一组</Button>}<Button disabled={frozen} onClick={()=>void expandCapacity()}>扩大本组至 {(end?.arrows.length??0)+candidates.length} 箭</Button><span>{nextEndIssue&&end?.arrows.length?nextEndIssue:'若其中有误点，可选中删除后再保存。'}</span></div>}
    <div className="photo-review-actions"><Button kind="primary" disabled={frozen||!candidatesSaveable||candidates.length>remaining} data-guide-target={frozen||!candidatesSaveable||candidates.length>remaining?undefined:'photo-confirm'} onClick={()=>void save()}>{manualReview?`确认人工环值 · ${candidates.length} 箭`:`确认加入 · ${candidates.length} 点`}</Button>{manualReview&&<Button disabled={frozen} onClick={()=>void cancelManualReview()}>返回照片处理</Button>}<Button disabled={frozen} onClick={()=>fileInput.current?.click()}>更换照片</Button><p className="caption">{manualReview?'只保存明确选择的环值，无靶面坐标；原照片仅在当前页暂存。':'默认只保存核对后的环值；逐点手动定位可以保存可信位置。实验参考坐标须另行选择，不参加可信散布计算。'}</p><details className="photo-advanced"><summary>更多设置</summary><p>{manualReview?'按需调整保存顺序或导出测试记录。':'按需调整保存顺序、实验坐标或导出测试记录。'}</p><div className="photo-order"><span>加入本组的顺序</span><Button kind={orderMode==='score-desc'?'selected':''} aria-pressed={orderMode==='score-desc'} onClick={()=>chooseOrder('score-desc')}>按环值从大到小</Button><Button kind={orderMode==='custom'?'selected':''} aria-pressed={orderMode==='custom'} onClick={()=>chooseOrder('custom')}>自定义顺序</Button>{orderMode==='custom'&&<><Button disabled={!selected||candidates[0]?.id===selected} onClick={()=>moveSelected(-1)}>前移</Button><Button disabled={!selected||candidates[candidates.length-1]?.id===selected} onClick={()=>moveSelected(1)}>后移</Button></>}</div>{!manualReview&&<><div className="photo-coordinate-mode" role="group" aria-label="照片点位保存方式"><span>点位保存</span><Button kind={!saveCoordinates?'selected':''} aria-pressed={!saveCoordinates} onClick={()=>setSaveCoordinates(false)}>只保存环值</Button><Button kind={saveCoordinates?'selected':''} aria-pressed={saveCoordinates} onClick={()=>setSaveCoordinates(true)}>另存实验性自动坐标</Button></div>{!saveCoordinates?<p role="status" className="photo-add-mode">未逐点在靶面定位的候选只存环值；不会写入可能偏移的自动坐标。</p>:<p role="alert" className="photo-add-mode">自动坐标可能因侧拍和靶面定位偏差影响压线判断，仅用于实验分析。</p>}</>}{diagnostic&&<div className="photo-diagnostic photo-diagnostic-inline"><b>真机测试记录（可选）</b><p>仅导出版本、照片摘要、处理尺寸、阶段耗时、候选修改、映射调整和保存状态；不含照片、文件名或训练身份，也不会上传。</p><Button disabled={busy&&!diagnostic.failure} onClick={()=>exportReceipt(receipt('review'))}>导出当前诊断记录</Button>{diagnostic.input.sha256===null&&<small>当前环境无法计算照片摘要，其余记录仍可导出。</small>}</div>}</details></div>
   </Panel>}
 </section>;
}
