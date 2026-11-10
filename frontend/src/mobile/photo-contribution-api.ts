import type {ChoiceState,Policy,RequestReceipt,SampleReceipt,ReadbackExpectation,SampleReadback} from './photo-contribution-contract';
import type {ContributionIdentity} from './photo-contribution-store';
/** Only explicit current server conflicts are classified; legacy/native errors remain unknown. */
export const contributionConflictMessages={
 'request-binding':'原请求标识与提交内容不一致。',
 'choice-revision':'参与选择版本已变化。',
 'consent-changed':'这份记录对应的参与选择已变化。',
 'sample-exists':'这份样本标识已有记录。',
 'image-already-contributed':'同一账号已有这张工作图的贡献记录。',
 'deletion-pending':'这份贡献已进入删除流程。',
 'content-attempted':'这份图片已尝试上传，不能再次上传。',
 'sample-expired':'这份贡献的保留期限已到。',
 'sample-state':'这份贡献当前不能执行此步骤。',
 'image-binding':'图片与原提交记录不一致。',
 'manifest-binding':'修正内容与原提交记录不一致。',
} as const;
export type ContributionConflictReason=keyof typeof contributionConflictMessages;
export function isContributionConflictReason(value:unknown):value is ContributionConflictReason{return typeof value==='string'&&Object.prototype.hasOwnProperty.call(contributionConflictMessages,value);}
export class ContributionHttpError extends Error{
 constructor(readonly status:number,readonly conflict:ContributionConflictReason|null=null){super('贡献请求未确认');}
}
export function contributionHttpError(status:number,raw:unknown):ContributionHttpError{
 const value=raw as Record<string,unknown>|null,detail=value?.detail as Record<string,unknown>|null;
 const reason=status===409&&value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===1&&detail&&typeof detail==='object'&&!Array.isArray(detail)&&Object.keys(detail).length===2&&detail.schema==='photo-contribution-conflict/v1'&&isContributionConflictReason(detail.reason)?detail.reason:null;
 return new ContributionHttpError(status,reason);
}
export function contributionConflictReason(error:unknown):ContributionConflictReason|null{return error instanceof ContributionHttpError&&error.status===409&&isContributionConflictReason(error.conflict)?error.conflict:null;}
export const CONTRIBUTION_PREFIX='/api/photo-contributions';
export const digestPattern=/^[a-f0-9]{64}$/;
export const uuidPattern=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export interface ContributionTransport{
 identity():ContributionIdentity|null;
 localIdentity?():ContributionIdentity|null;
 /** Retention only; never accepted by request(). */
 captureIdentity?():ContributionIdentity|null;
 available():boolean;
 policy(signal:AbortSignal):Promise<unknown>;
 request(identity:ContributionIdentity,method:'GET'|'POST'|'PUT',path:string,signal:AbortSignal,body?:unknown,requestId?:string):Promise<unknown>;
}
export function validateNativeContributionRequest(method:string,path:string,body:unknown,extra:Record<string,string>){
 if(!path.startsWith(CONTRIBUTION_PREFIX+'/'))throw Error('贡献路径无效');const relative=path.slice(CONTRIBUTION_PREFIX.length);
 if(Object.keys(extra).some(k=>!['content-type','x-contribution-request-id'].includes(k)))throw Error('贡献请求头无效');
 const upload=method==='PUT';if(upload&&(!(body instanceof Uint8Array)||extra['content-type']!=='image/png'))throw Error('贡献图片格式无效');
 if(!upload&&Object.keys(extra).length)throw Error('贡献读取或JSON不能带图片头');
 validateContributionRequest(method,relative,upload?new Blob([Uint8Array.from(body as Uint8Array).buffer],{type:'image/png'}):body,extra['x-contribution-request-id']);
 const headers:Record<string,string>={accept:'application/json',...(method==='POST'?{'content-type':'application/json'}:{}),...extra};
 return {method:method as 'GET'|'POST'|'PUT',headers,json:method==='POST'?JSON.stringify(body):'',bytes:upload?(body as Uint8Array).byteLength:0,binary:false};
}
const object=(x:unknown):Record<string,any>=>{if(!x||typeof x!=='object'||Array.isArray(x))throw Error('贡献回读格式未核实');return x as Record<string,any>;};
export function parsePolicy(raw:unknown):Policy{
 const p=object(raw);if(p.version!=='photo-contribution/v1'||typeof p.ready!=='boolean'||p.imageKind!=='inference-work-png'||p.trainingExecuted!==false||!Array.isArray(p.accessors)||p.accessors.some((s:unknown)=>typeof s!=='string'))throw Error('贡献条款未核实');
 for(const k of ['purpose','controller','retentionPolicyId','deletionContact'])if(p[k]!==null&&(typeof p[k]!=='string'||p[k].length>2000))throw Error('贡献条款未核实');
 if(p.retentionDays!==null&&(!Number.isSafeInteger(p.retentionDays)||p.retentionDays<1))throw Error('贡献期限未核实');
 if(p.ready&&(!p.purpose||!p.controller||!p.retentionPolicyId||!p.deletionContact||!p.retentionDays||!p.accessors.length))throw Error('贡献事实缺失');return p as Policy;
}
export function parseChoice(raw:unknown,i:ContributionIdentity):ChoiceState{
 const c=object(raw);if(c.owner!==i.owner||c.service!==i.authService||!['undecided','participate','decline'].includes(c.choice)||!Number.isSafeInteger(c.revision)||c.revision<0||typeof c.receiverReady!=='boolean'||c.activeEpoch!==null&&!uuidPattern.test(c.activeEpoch)||c.policyVersion!==null&&typeof c.policyVersion!=='string'||c.effectiveAt!==null&&(typeof c.effectiveAt!=='string'||!Number.isFinite(Date.parse(c.effectiveAt))))throw Error('贡献账号回读未核实');
 if(c.choice==='participate'&&(!c.activeEpoch||c.revision<1||!c.effectiveAt))throw Error('贡献选择未生效');return c as ChoiceState;
}
export function parseReceipt(raw:unknown,sampleId:string):SampleReceipt{const r=object(raw);if(r.sampleId!==sampleId||!['reserved','uploading','uploaded','received','withdrawn','deletion_pending','expired'].includes(r.status)||!digestPattern.test(r.manifestSha256)||!digestPattern.test(r.imageSha256)||typeof r.contentVerified!=='boolean'||typeof r.eligible!=='boolean')throw Error('贡献样本回读未核实');return r as SampleReceipt;}
export function parseRequest(raw:unknown,requestId:string):RequestReceipt{const r=object(raw);if(typeof requestId!=='string'||!uuidPattern.test(requestId))throw Error('原贡献请求未核实');if(r.found===false){exactKeys(r,['found']);return {found:false};}exactKeys(r,['found','requestId','operation','state','sampleId']);if(r.found!==true||r.requestId!==requestId||!['choice','prepare','content','finalize'].includes(r.operation)||!['done','unknown'].includes(r.state)||(r.operation==='choice'?r.sampleId!==null:typeof r.sampleId!=='string'||!uuidPattern.test(r.sampleId)))throw Error('原贡献请求未核实');return r as RequestReceipt;}
const readbackCauses=['add-point','remove-point','move-point','set-score','restore-score','set-target-point'] as const;
const readbackFlags=['received','manifestValidated','storedDigestMatches','expectedDigestMatches','imageBindingMatches','finalizeReceiptBound','eventSequenceValid','replayMatchesFinal','confirmationMatches','consentBindingMatches'] as const;
const exactKeys=(value:Record<string,any>,keys:readonly string[])=>{if(Object.keys(value).length!==keys.length||keys.some(k=>!Object.prototype.hasOwnProperty.call(value,k)))throw Error('贡献回读格式未核实');};
const bounded=(value:unknown,min:number,max:number)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=min&&value<=max;
export function parseReadbackExpectation(raw:unknown):ReadbackExpectation{
 const r=object(raw);exactKeys(r,['sampleId','manifestSha256','imageSha256','imageBytes','consentEpoch','consentRevision']);
 for(const k of ['sampleId','consentEpoch'])if(typeof r[k]!=='string'||!uuidPattern.test(r[k]))throw Error('贡献回读期待未核实');
 for(const k of ['manifestSha256','imageSha256'])if(typeof r[k]!=='string'||!digestPattern.test(r[k]))throw Error('贡献回读期待未核实');
 if(!bounded(r.imageBytes,1,8*1024*1024)||!bounded(r.consentRevision,1,Number.MAX_SAFE_INTEGER))throw Error('贡献回读期待未核实');return r as ReadbackExpectation;
}
export function parseReadback(raw:unknown):SampleReadback{
 const r=object(raw);exactKeys(r,['schema','status','matchedCount',...readbackFlags,'initialCount','eventCount','finalCount','undoCount','causeCounts','currentEligible','objectReadVerifiedNow']);
 if(r.schema!=='photo-contribution-readback/v1'||!['verified','not-found','not-received','mismatch','unavailable'].includes(r.status)||!bounded(r.matchedCount,0,1)||readbackFlags.some(k=>typeof r[k]!=='boolean')||!(typeof r.currentEligible==='boolean'||r.currentEligible==='unknown')||r.objectReadVerifiedNow!=='unknown')throw Error('贡献回读未核实');
 if(r.status==='verified'){
  if(r.matchedCount!==1||readbackFlags.some(k=>r[k]!==true)||typeof r.currentEligible!=='boolean'||!bounded(r.initialCount,0,256)||!bounded(r.eventCount,0,256)||!bounded(r.finalCount,1,512)||!bounded(r.undoCount,0,r.eventCount))throw Error('贡献回读未核实');
  const counts=object(r.causeCounts);exactKeys(counts,readbackCauses);if(readbackCauses.some(k=>!bounded(counts[k],0,256))||readbackCauses.reduce((n,k)=>n+counts[k],0)!==r.eventCount)throw Error('贡献回读未核实');
 }else if(r.matchedCount!==0||['initialCount','eventCount','finalCount','undoCount','causeCounts'].some(k=>r[k]!==null)||readbackFlags.some(k=>r[k]!==false)||r.currentEligible!=='unknown')throw Error('贡献回读未核实');
 return r as SampleReadback;
}
export function canonical(value:unknown):string{if(value===null||typeof value==='string'||typeof value==='boolean')return JSON.stringify(value);if(typeof value==='number'&&Number.isSafeInteger(value))return String(value);if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical((value as Record<string,unknown>)[k])).join(',')+'}';throw Error('贡献摘要输入无效');}
export async function sha256(value:Blob|string){const bytes=typeof value==='string'?new TextEncoder().encode(value):await value.arrayBuffer();return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(v=>v.toString(16).padStart(2,'0')).join('');}
/** Strict transport surface, independent from personal cloud/TeamApi consent. */
export function validateContributionRequest(method:string,path:string,body:unknown,requestId?:string){
 const sample=path.split('/')[2];if(path.startsWith('/samples/')&&sample!=='prepare'&&!uuidPattern.test(sample??''))throw Error('贡献样本标识无效');const id='[a-f0-9-]{36}';if(!((method==='GET'&&/^\/(choice|samples\/[a-f0-9-]{36}(\/content-status)?)$/.test(path))||(method==='POST'&&['/choice','/requests/read','/samples/prepare'].includes(path))||(method==='POST'&&new RegExp('^/samples/'+id+'/finalize$').test(path))||(method==='PUT'&&new RegExp('^/samples/'+id+'/content$').test(path))))throw Error('贡献路径未开放');
 if(method==='POST'&&path==='/requests/read'){const r=object(body);exactKeys(r,Object.prototype.hasOwnProperty.call(r,'readback')?['requestId','readback']:['requestId']);if(typeof r.requestId!=='string'||!uuidPattern.test(r.requestId))throw Error('贡献原请求未核实');if(Object.prototype.hasOwnProperty.call(r,'readback'))parseReadbackExpectation(r.readback);}
 if(method==='GET'&&body!==undefined)throw Error('读取不能写入');if(method==='PUT'){if(!(body instanceof Blob)||body.type!=='image/png'||body.size<1||body.size>8*1024*1024||!requestId||!uuidPattern.test(requestId))throw Error('贡献图片格式未核实');}else if(method==='POST'&&(!body||typeof body!=='object'||new TextEncoder().encode(JSON.stringify(body)).length>512*1024))throw Error('贡献请求无效');
}
