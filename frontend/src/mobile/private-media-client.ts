import {archiveSha256} from './protected-archive';
import type {SaveIdentity} from './cloud-save-queue';
export type MediaTrainingConsent={version:'media-training/v1';accepted:boolean;purpose:'archery-assist-research/v1'|null;accessors:('approved-researcher'|'approved-annotator')[]};
export const noMediaTraining=():MediaTrainingConsent=>({version:'media-training/v1',accepted:false,purpose:null,accessors:[]});
export type MediaObject={id:string;ownerId:string;clientObjectId:string;selectionId:string;kind:'photo'|'video'|'avatar';mime:string;sha256:string;bytes:number;status:'pending'|'stored'|'expired'|'repair-required';trainingConsent:MediaTrainingConsent;trainingWithdrawalLimit:string};
export type MediaSelection={id:string;owner:string;service:string;name:string;kind:MediaObject['kind'];mime:string;bytes:number;sha256:string;selectionId:string;idempotencyKey:string;body:Uint8Array;saveConsented:boolean;trainingConsent:MediaTrainingConsent;remoteId:string|null;attempts:number;state:'selected'|'pending'|'verified'|'error';verifiedAt:string|null};
export interface MediaSelectionStore {get(id:string):Promise<MediaSelection|null>;put(value:MediaSelection):Promise<void>;list(owner:string,service:string):Promise<MediaSelection[]>}
export type MediaRequest=(method:'GET'|'POST'|'PUT'|'PATCH',path:string,signal:AbortSignal,body?:unknown,headers?:Record<string,string>)=>Promise<unknown>;
const same=(a:SaveIdentity|null,b:SaveIdentity)=>!!a&&a.owner===b.owner&&a.service===b.service&&a.sessionKey===b.sessionKey&&a.generation===b.generation;
const randomId=()=>crypto.randomUUID().replace(/-/g,'');
const maxObjectBytes=50*1024*1024;
export const mediaTrainingExplanation='训练贡献默认关闭，与私有保存分别自愿选择。用途为未来射箭辅助模型研究，仅拟供获批准研究人员与标注人员选取。撤回停止未来选取，已产生的模型影响未建立可移除机制，不能承诺模型忘记；此模块不执行训练或授予研究人员读取权限。';
const sameTraining=(a:MediaTrainingConsent,b:MediaTrainingConsent)=>a.version===b.version&&a.accepted===b.accepted&&a.purpose===b.purpose&&JSON.stringify([...a.accessors].sort())===JSON.stringify([...b.accessors].sort());
function fields(v:unknown,required:string[],optional:string[]=[]):asserts v is Record<string,unknown>{if(!v||typeof v!=='object'||Array.isArray(v)||required.some(k=>!Object.prototype.hasOwnProperty.call(v,k))||Object.keys(v).some(k=>!required.includes(k)&&!optional.includes(k)))throw new Error('媒体字段缺失或包含未知内容；原任务保留');}
function hexId(v:unknown):v is string{return typeof v==='string'&&/^[a-f0-9]{32}$/.test(v);}
function backendId(v:unknown):v is string{return typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(v);}
function unix(v:unknown):v is number{return typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=253402300799;}
function media(kind:unknown,mime:unknown){if(typeof kind!=='string'||!['photo','video','avatar'].includes(kind)||typeof mime!=='string'||!['image/png','image/jpeg','image/webp','video/mp4'].includes(mime)||(kind==='video')!==(mime==='video/mp4'))throw new Error('媒体类型与MIME不一致');}
function training(value:unknown,dates:'forbid'|'optional'|'required'='forbid'):asserts value is MediaTrainingConsent{
  fields(value,['version','accepted','purpose','accessors',...(dates==='required'?['acceptedAt']:[])],dates==='forbid'?[]:dates==='optional'?['acceptedAt','changedAt']:['changedAt']);
  if(value.version!=='media-training/v1'||typeof value.accepted!=='boolean'||!Array.isArray(value.accessors)||value.accessors.length>2||(value.accepted?(value.purpose!=='archery-assist-research/v1'||!value.accessors.length||value.accessors.some(a=>!['approved-researcher','approved-annotator'].includes(a))||new Set(value.accessors).size!==value.accessors.length):(value.purpose!==null||value.accessors.length!==0)))throw new Error('训练贡献须另行明确选择用途与访问者');
  if(Object.prototype.hasOwnProperty.call(value,'acceptedAt')&&(value.accepted?!unix(value.acceptedAt):value.acceptedAt!==null))throw new Error('训练同意日期无效');
  if(Object.prototype.hasOwnProperty.call(value,'changedAt')&&(!Object.prototype.hasOwnProperty.call(value,'acceptedAt')||!unix(value.changedAt)||(typeof value.acceptedAt==='number'&&value.changedAt<value.acceptedAt)))throw new Error('训练同意更新日期无效');
}
/** File inputs are supplied by the user. No gallery scan or default upload exists. */
export class PrivateMediaSave {
  private busy=false;private controllers=new Set<AbortController>();private epoch=0;
  constructor(private store:MediaSelectionStore,private identity:()=>SaveIdentity|null,private request:MediaRequest,private now:()=>number=()=>Date.now()){}
  invalidate(){this.epoch++;for(const c of this.controllers)c.abort();this.controllers.clear();}
  private current(){const i=this.identity();if(!i)throw new Error('请先登录并核对媒体归属');return i;}
  private assert(i:SaveIdentity,epoch:number){if(epoch!==this.epoch||!same(this.identity(),i))throw new Error('账号或操作已变化，旧媒体结果未采用');}
  private async controlled<T>(parent:AbortSignal|undefined,work:(signal:AbortSignal)=>Promise<T>):Promise<T>{const c=new AbortController(),stop=()=>c.abort();if(parent?.aborted)c.abort();parent?.addEventListener('abort',stop,{once:true});this.controllers.add(c);
    try{if(c.signal.aborted)throw new Error('媒体操作已取消');const value=await work(c.signal);if(c.signal.aborted)throw new Error('媒体操作已取消，旧结果未采用');return value;}
    finally{parent?.removeEventListener('abort',stop);this.controllers.delete(c);}
  }
  private inspectSelection(value:unknown,i:SaveIdentity,id:string):MediaSelection{
    fields(value,['id','owner','service','name','kind','mime','bytes','sha256','selectionId','idempotencyKey','body','saveConsented','trainingConsent','remoteId','attempts','state','verifiedAt']);const j=value as unknown as MediaSelection;
    if(!hexId(id)||j.id!==id||!hexId(j.id)||!hexId(j.selectionId)||!hexId(j.idempotencyKey)||(j.remoteId!==null&&!hexId(j.remoteId))||j.owner!==i.owner||j.service!==i.service||!['https://service-1.example.invalid','https://service-3.example.invalid'].includes(j.service)||typeof j.name!=='string'||j.name.length>160||!Number.isSafeInteger(j.bytes)||j.bytes<1||j.bytes>maxObjectBytes||typeof j.sha256!=='string'||!/^[a-f0-9]{64}$/.test(j.sha256)||!(j.body instanceof Uint8Array)||j.body.byteLength!==j.bytes||!Number.isSafeInteger(j.attempts)||j.attempts<0||j.attempts>3||!['selected','pending','verified','error'].includes(j.state)||typeof j.saveConsented!=='boolean')throw new Error('本机媒体任务损坏或归属未知；未请求网络，原任务保留');
    media(j.kind,j.mime);training(j.trainingConsent,'optional');
    if(j.verifiedAt!==null&&(typeof j.verifiedAt!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(j.verifiedAt)||!Number.isFinite(Date.parse(j.verifiedAt))||new Date(j.verifiedAt).toISOString()!==j.verifiedAt))throw new Error('媒体回读日期损坏；原任务保留');
    if((j.state==='selected'&&(j.attempts!==0||j.remoteId!==null||j.saveConsented||j.verifiedAt!==null||j.trainingConsent.accepted))||(j.state!=='selected'&&!j.saveConsented)||(j.attempts>0&&j.remoteId===null)||(j.state==='verified'&&(j.remoteId===null||j.verifiedAt===null)))throw new Error('媒体任务状态不一致；未重置或请求网络');
    return j;
  }
  async selections(){const i=this.current(),epoch=this.epoch,rows=await this.store.list(i.owner,i.service);this.assert(i,epoch);return rows.map(v=>this.inspectSelection(v,i,v.id));}
  async select(file:Blob,name:string,kind:MediaObject['kind']):Promise<MediaSelection>{const i=this.current(),epoch=this.epoch;
    if(typeof name!=='string'||!file.size||file.size>maxObjectBytes)throw new Error('请选择50 MiB以内的有效媒体');media(kind,file.type);
    const body=new Uint8Array(await file.arrayBuffer());this.assert(i,epoch);const sha256=await archiveSha256(body);this.assert(i,epoch);
    const job:MediaSelection={id:randomId(),owner:i.owner,service:i.service,name:name.slice(0,160),kind,mime:file.type,bytes:body.byteLength,sha256,selectionId:randomId(),idempotencyKey:randomId(),body,saveConsented:false,trainingConsent:noMediaTraining(),remoteId:null,attempts:0,state:'selected',verifiedAt:null};this.inspectSelection(job,i,job.id);await this.store.put(job);this.assert(i,epoch);return job;
  }
  private parseObject(value:unknown,i:SaveIdentity,job?:MediaSelection):MediaObject{
    fields(value,['id','ownerId','clientObjectId','selectionId','kind','mime','sha256','bytes','status','createdAt','storedAt','expiresAt','saveConsent','trainingConsent','trainingWithdrawalLimit']);const o=value as unknown as MediaObject;
    if(!hexId(o.id)||o.ownerId!==i.owner||!backendId(o.clientObjectId)||!backendId(o.selectionId)||!Number.isSafeInteger(o.bytes)||o.bytes<1||o.bytes>maxObjectBytes||typeof o.sha256!=='string'||!/^[a-f0-9]{64}$/.test(o.sha256)||!['pending','stored','expired','repair-required'].includes(o.status)||typeof o.trainingWithdrawalLimit!=='string'||!o.trainingWithdrawalLimit||o.trainingWithdrawalLimit.length>10000)throw new Error('媒体归属、大小或摘要无效');
    media(o.kind,o.mime);training(o.trainingConsent,'required');
    if(!unix(value.createdAt)||!unix(value.expiresAt)||value.expiresAt<=value.createdAt||value.expiresAt-value.createdAt>3600||(value.storedAt!==null&&(!unix(value.storedAt)||value.storedAt<value.createdAt))||(o.status==='stored'&&value.storedAt===null))throw new Error('媒体服务日期或保存状态无效');
    fields(value.saveConsent,['version','accepted','acceptedAt','selectionId']);if(value.saveConsent.version!=='media-save/v1'||value.saveConsent.accepted!==true||value.saveConsent.acceptedAt!==value.createdAt||value.saveConsent.selectionId!==o.selectionId)throw new Error('媒体保存同意或选择归属未能核对');
    if(job&&((job.remoteId!==null&&o.id!==job.remoteId)||o.clientObjectId!==job.id||o.selectionId!==job.selectionId||o.bytes!==job.bytes||o.sha256!==job.sha256||o.kind!==job.kind||o.mime!==job.mime))throw new Error('云对象与所选媒体不一致');return o;
  }
  private boundObject(objects:MediaObject[],i:SaveIdentity,job:MediaSelection){
    const matches=objects.filter(o=>o.clientObjectId===job.id);if(matches.length>1)throw new Error('媒体清单存在多个匹配对象，尚未唯一确认；本机对象保留');
    const object=matches[0];if(job.remoteId!==null&&(!object||object.id!==job.remoteId))throw new Error('已绑定媒体对象缺失或标识不一致；不采用其他对象，也不另建上传');
    return object?this.parseObject(object,i,job):undefined;
  }
  async catalog(signal?:AbortSignal){const i=this.current(),epoch=this.epoch;return this.controlled(signal,async live=>{const value=await this.request('GET','/api/private-media',live);this.assert(i,epoch);
    fields(value,['objects','quota','storageMode']);fields(value.quota,['usedBytes','reservedBytes','maxBytes']);const r=value as unknown as {objects:unknown[];quota:{usedBytes:number;reservedBytes:number;maxBytes:number};storageMode:string};
    if(!Array.isArray(r.objects)||r.objects.length>1000||![r.quota.usedBytes,r.quota.reservedBytes,r.quota.maxBytes].every(n=>Number.isSafeInteger(n)&&n>=0)||r.quota.maxBytes<1||!Number.isSafeInteger(r.quota.usedBytes+r.quota.reservedBytes)||r.quota.usedBytes+r.quota.reservedBytes>r.quota.maxBytes||!['local-protected-candidate','supabase-private-candidate'].includes(r.storageMode))throw new Error('媒体容量或清单无效');const objects=r.objects.map(o=>this.parseObject(o,i));if(new Set(objects.map(o=>o.id)).size!==objects.length)throw new Error('媒体清单对象重复');return {...r,objects};
    });
  }
  private async verify(i:SaveIdentity,epoch:number,job:MediaSelection,o:MediaObject,signal:AbortSignal,readOnly=false){
    const r=await this.request('GET','/api/private-media/'+o.id+'/access',signal) as {accessToken:string;expiresAt:number;readPath:string};this.assert(i,epoch);
    if(!r||typeof r.accessToken!=='string'||r.accessToken.length<16||r.readPath!=='/api/private-media/'+o.id+'/content'||!Number.isFinite(r.expiresAt)||r.expiresAt*1000<=this.now()||r.expiresAt*1000>this.now()+300000)throw new Error('短期媒体访问许可无效');
    const body=await this.request('GET',r.readPath,signal,undefined,{'X-Media-Access':r.accessToken});this.assert(i,epoch);
    if(!(body instanceof Uint8Array)||body.byteLength!==job.bytes||await archiveSha256(body)!==job.sha256)throw new Error('云媒体回读损坏或大小不一致，本机对象保留');this.assert(i,epoch);
    if(readOnly)job.trainingConsent={...o.trainingConsent,accessors:[...o.trainingConsent.accessors]};else if(!sameTraining(o.trainingConsent,job.trainingConsent)){const consentReceipt=await this.request('PATCH','/api/private-media/'+o.id+'/training-consent',signal,job.trainingConsent) as {object:unknown};this.assert(i,epoch);const returned=this.parseObject(consentReceipt.object,i,job);if(returned.id!==o.id||returned.status!=='stored'||!sameTraining(returned.trainingConsent,job.trainingConsent))throw new Error('媒体字节已确认，但训练贡献回执未能核对此对象、保存状态和完整同意');o=returned;}
    job.state='verified';job.verifiedAt=new Date(this.now()).toISOString();job.remoteId=o.id;await this.store.put(job);this.assert(i,epoch);return o;
  }
  async save(id:string,consent:{ownershipConfirmed:true;saveConsent:true;trainingConsent?:MediaTrainingConsent}){if(this.busy)throw new Error('媒体操作正在进行');this.busy=true;try{return await this.saveSelected(id,consent);}finally{this.busy=false;}}
  private async saveSelected(id:string,consent:{ownershipConfirmed:true;saveConsent:true;trainingConsent?:MediaTrainingConsent}){const i=this.current(),epoch=this.epoch;if(!hexId(id))throw new Error('本机媒体标识无效；原任务保留');const raw=await this.store.get(id);this.assert(i,epoch);const job=this.inspectSelection(raw,i,id);
    if(consent.ownershipConfirmed!==true||consent.saveConsent!==true)throw new Error('请明确选择当前账号的对象并确认保存');
    const readOnly=job.attempts>=3;if(await archiveSha256(job.body)!==job.sha256)throw new Error('本机所选对象已损坏，未发送');this.assert(i,epoch);
    training(consent.trainingConsent??noMediaTraining());if(!readOnly){job.saveConsented=true;job.trainingConsent=consent.trainingConsent??noMediaTraining();job.state='pending';await this.store.put(job);this.assert(i,epoch);}
    const controller=new AbortController();this.controllers.add(controller);
    try{
      const catalog=await this.catalog(controller.signal);this.assert(i,epoch);let object=this.boundObject(catalog.objects,i,job);
      if(object){object=this.parseObject(object,i,job);if(object.status==='stored')return await this.verify(i,epoch,job,object,controller.signal,readOnly);if(object.status!=='pending')throw new Error('云对象已过期或需修复；本机对象保留，请另行确认');}
      else if(catalog.quota.usedBytes+catalog.quota.reservedBytes+job.bytes>catalog.quota.maxBytes)throw new Error('媒体保存配额不足；本机对象保留');
      if(readOnly)throw new Error('本对象已达到3次上传门槛；已只读核对，现有云对象尚未确认完整保存，本机对象保留，不新增上传');const receipt=await this.request('POST','/api/private-media/intents',controller.signal,{clientObjectId:job.id,selectionId:job.selectionId,kind:job.kind,mime:job.mime,sha256:job.sha256,bytes:job.bytes,idempotencyKey:job.idempotencyKey,saveConsent:{version:'media-save/v1',accepted:true},trainingConsent:noMediaTraining()}) as {object:unknown;uploadPath:string;expiresAt:number};this.assert(i,epoch);
      object=this.parseObject(receipt.object,i,job);job.remoteId=object.id;await this.store.put(job);this.assert(i,epoch);
      if(receipt.uploadPath!=='/api/private-media/'+object.id+'/content'||!Number.isFinite(receipt.expiresAt)||receipt.expiresAt*1000<=this.now())throw new Error('媒体上传预约已到期或路径无效');
      job.attempts++;await this.store.put(job);this.assert(i,epoch);let error:unknown;
      try{await this.request('PUT',receipt.uploadPath,controller.signal,job.body,{'Content-Type':job.mime});}catch(e){error=e;}this.assert(i,epoch);
      const read=await this.catalog(controller.signal);this.assert(i,epoch);const stored=this.boundObject(read.objects,i,job);if(!stored||stored.status!=='stored')throw error??new Error('媒体保存尚未确认；本机对象保留，没有自动重放');
      return await this.verify(i,epoch,job,stored,controller.signal);
    }catch(e){job.state='error';await this.store.put(job);throw e;}finally{this.controllers.delete(controller);}
  }
  async setTraining(objectId:string,value:MediaTrainingConsent){training(value);if(!hexId(objectId))throw new Error('媒体标识无效');const expected:MediaTrainingConsent={version:value.version,accepted:value.accepted,purpose:value.purpose,accessors:[...value.accessors]},i=this.current(),epoch=this.epoch;return this.controlled(undefined,async signal=>{
    const r=await this.request('PATCH','/api/private-media/'+objectId+'/training-consent',signal,{...expected,accessors:[...expected.accessors]});this.assert(i,epoch);const object=this.parseObject((r as {object:unknown}).object,i);if(object.id!==objectId||!sameTraining(object.trainingConsent,expected))throw new Error('训练贡献响应未确认本次对象或完整同意；未知及旧结果未记为成功');return object;
    });
  }
}
