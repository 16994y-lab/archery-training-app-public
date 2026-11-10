import {copy,initialData,type Data} from './domain';
import {CLOUD_COLLECTIONS,cloudDocument,cloudEqual,validateCloudDocument,type CloudDocument,type RemoteDocument} from './cloud-sync';
import {planBackupMerge,mergeBackup,type BackupMergePlan} from './backup';
import {assertPortableBackupTree} from './manual-backup-portable';
import {assertHostedBackupFits,requireTransportJsonBytes} from './manual-backup-transport';

export type BackupIdentity={owner:string;service:string;sessionKey:string;generation:number};
export type BackupTransport={identity:()=>Promise<BackupIdentity>;current:()=>BackupIdentity|null;request:(method:'GET'|'PUT',identity:BackupIdentity,document?:CloudDocument,revision?:number)=>Promise<unknown>};
export type BackupLocal={read:()=>Data;pending:()=>boolean;update:(change:(data:Data)=>void)=>Promise<boolean>};
export type BackupSummary={sessions:number;arrows:number;completed:number;drafts:number;plans:number;targets:number;equipment:number;schedules:number;programs:number;goals:number;accessories:number;bytes:number};
export type BackupPreview={token:number;kind:'upload'|'restore';destination:string;revision:number;updatedAt:string|null;local:BackupSummary;remote:BackupSummary|null;result:BackupSummary;plan:BackupMergePlan;strategy:'keep-existing'|'copy-imported'};
const stamp=(value:unknown)=>JSON.stringify(value);
const sameIdentity=(a:BackupIdentity|null,b:BackupIdentity)=>!!a&&a.owner===b.owner&&a.service===b.service&&a.sessionKey===b.sessionKey&&a.generation===b.generation;
export function validatePortableDocument(value:unknown):CloudDocument{
  assertPortableBackupTree(value);const document=validateCloudDocument(value);
  for(const key of CLOUD_COLLECTIONS)if(document[key].length>5000||document[key].some(row=>row.id.length>160))throw new Error('备份项目数量或标识超过服务容量，未发送');
  return document;
}
export function backupSummary(document:CloudDocument):BackupSummary {
  return {sessions:document.sessions.length,arrows:document.sessions.reduce((n,s)=>n+s.ends.reduce((a,e)=>a+e.arrows.length,0),0),completed:document.sessions.filter(s=>s.status==='completed').length,drafts:document.sessions.filter(s=>s.status==='draft').length,plans:document.plans.length,targets:document.targets.length,equipment:document.equipment.length,schedules:document.schedules.length,programs:document.programs.length,goals:document.goals.length,accessories:document.accessories.length,bytes:new TextEncoder().encode(JSON.stringify(document)).length};
}
export function parseManualBackupResponse(raw:unknown):RemoteDocument {
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('云端备份响应无效，本机未改变');
  requireTransportJsonBytes(JSON.stringify(raw));
  const r=raw as RemoteDocument;
  if(Object.keys(r).sort().join()!==['revision','document','updatedAt'].sort().join()||!Number.isSafeInteger(r.revision)||r.revision<0||(r.revision===0)!==(r.document===null)||(r.revision===0?r.updatedAt!==null:typeof r.updatedAt!=='string'||!Number.isFinite(Date.parse(r.updatedAt))))throw new Error('云端版本或日期无效，本机未改变');
  try{return {revision:r.revision,document:r.document===null?null:validatePortableDocument(r.document),updatedAt:r.updatedAt};}
  catch{throw new Error('云端备份内容无效或超过容量，本机未改变；请保留原备份');}
}
function asData(document:CloudDocument):Data{return {...initialData(),...copy(document)};}
type Prepared={view:BackupPreview;identity:BackupIdentity;local:string;remote:RemoteDocument;document:CloudDocument;resultData:Data;report:ReturnType<typeof mergeBackup>['report']};

/** No timers, account binding, automatic upload, automatic merge or persistence on read. */
export class ManualBackup {
  private prepared:Prepared|null=null;private busy=false;private serial=0;
  constructor(private local:BackupLocal,private transport:BackupTransport){}
  invalidate(){this.prepared=null;}
  private assertIdentity(identity:BackupIdentity){if(!sameIdentity(this.transport.current(),identity))throw new Error('账号或连接已变化，请重新读取核对；本机资料保留');}
  private assertLocal(value:string){if(this.local.pending()||stamp(this.local.read())!==value)throw new Error('本机资料或未保存内容已变化，请重新读取核对');}
  private async run<T>(work:()=>Promise<T>):Promise<T>{if(this.busy)throw new Error('备份操作正在进行，请稍候');this.busy=true;try{return await work();}finally{this.busy=false;}}
  async preview(kind:'upload'|'restore',strategy:'keep-existing'|'copy-imported'='copy-imported'):Promise<BackupPreview>{return this.run(async()=>{
    this.prepared=null;if(this.local.pending())throw new Error('本机有未保存内容，请先处理后再备份或恢复');
    const identity=await this.transport.identity();this.assertIdentity(identity);
    const data=copy(this.local.read()),local=stamp(data),localDoc=validatePortableDocument(cloudDocument(data));
    if(kind==='upload')assertHostedBackupFits(localDoc);
    const remote=parseManualBackupResponse(await this.transport.request('GET',identity));this.assertIdentity(identity);this.assertLocal(local);
    if(kind==='restore'&&!remote.document)throw new Error('当前账号还没有完整云备份；本机资料未改变');
    const incoming=kind==='upload'?asData(localDoc):asData(remote.document!);
    const current=kind==='upload'?asData(remote.document??cloudDocument(initialData())):{...copy(data),...copy(localDoc),activeId:null};
    const plan=planBackupMerge(current,incoming),merged=mergeBackup(current,incoming,strategy);
    // The uploader explicitly contributes its profile. Restore fills default profile fields and retains manually filled values.
    if(kind==='upload')merged.data.profile=copy(data.profile);
    else {
      // A fresh device restores agreed profile fields; manually filled local values stay local.
      const defaults=initialData().profile;
      for(const field of Object.keys(defaults) as (keyof Data['profile'])[])if(cloudEqual(data.profile[field],defaults[field]))(merged.data.profile as Record<string,string|undefined>)[field]=incoming.profile[field]??defaults[field];
    }
    if(kind==='restore'&&data.activeId){
      const active=data.sessions.find(s=>s.id===data.activeId&&s.status==='active');
      if(active){merged.data.sessions=merged.data.sessions.map(s=>s.id===active.id?copy(active):s);merged.data.activeId=active.id;}
    }
    const document=validatePortableDocument(cloudDocument(merged.data));
    if(kind==='upload')assertHostedBackupFits(document);
    const view:BackupPreview={token:++this.serial,kind,destination:new URL(identity.service).hostname,revision:remote.revision,updatedAt:remote.updatedAt,local:backupSummary(localDoc),remote:remote.document?backupSummary(remote.document):null,result:backupSummary(document),plan,strategy};
    this.prepared={view:copy(view),identity,local,remote,document,resultData:copy(merged.data),report:copy(merged.report)};return copy(view);
  });}
  private consume(token:number,ownershipConfirmed:true,kind:'upload'|'restore'){
    const p=this.prepared;this.prepared=null;
    if(ownershipConfirmed!==true||!p||p.view.token!==token||p.view.kind!==kind)throw new Error('请先读取摘要并确认账号归属与内容');
    this.assertIdentity(p.identity);this.assertLocal(p.local);return p;
  }
  async upload(token:number,ownershipConfirmed:true):Promise<{revision:number;verified:boolean;unchanged:boolean}>{return this.run(async()=>{
    const p=this.consume(token,ownershipConfirmed,'upload');
    if(p.remote.document&&cloudEqual(p.document,p.remote.document)){
      const read=parseManualBackupResponse(await this.transport.request('GET',p.identity));this.assertIdentity(p.identity);
      if(read.revision!==p.remote.revision||!cloudEqual(read.document,p.document))throw new Error('云备份已变化，请重新读取核对');
      return {revision:read.revision,verified:true,unchanged:true};
    }
    let lost=false;
    try{const put=parseManualBackupResponse(await this.transport.request('PUT',p.identity,p.document,p.remote.revision));this.assertIdentity(p.identity);if(put.revision!==p.remote.revision+1||!cloudEqual(put.document,p.document))lost=true;}
    catch(error){this.assertIdentity(p.identity);if(error&&typeof error==='object'&&'status' in error){if(error.status===409)throw new Error('其他设备已更新云备份，请重新读取确认；没有自动重试上传');if(typeof error.status==='number'&&error.status<500&&error.status!==408)throw error;}lost=true;}
    // After an uncertain response, read only. Never issue a second PUT.
    let read:RemoteDocument;try{read=parseManualBackupResponse(await this.transport.request('GET',p.identity));this.assertIdentity(p.identity);}catch{throw new Error('上传结果尚未确认，请重新读取云端核对；本机与当前训练保持原值');}
    if(read.revision!==p.remote.revision+1||!cloudEqual(read.document,p.document))throw new Error(lost?'上传响应丢失且回读未能确认，请重新读取核对；没有再次上传':'云端回读与本次备份不一致，请重新读取核对；本机未改变');
    return {revision:read.revision,verified:true,unchanged:false};
  });}
  async restore(token:number,ownershipConfirmed:true){return this.run(async()=>{
    const p=this.consume(token,ownershipConfirmed,'restore');
    const latest=parseManualBackupResponse(await this.transport.request('GET',p.identity));this.assertIdentity(p.identity);this.assertLocal(p.local);
    if(latest.revision!==p.remote.revision||!cloudEqual(latest.document,p.remote.document))throw new Error('云端备份已变化，请重新预览后确认；本机未改变');
    const saved=await this.local.update(data=>{
      this.assertIdentity(p.identity);this.assertLocal(p.local);
      if(stamp(data)!==p.local)throw new Error('本机已变化，请重新预览');
      // Existing merger retains profile, connection, current training and all local-only values.
      Object.assign(data,copy(p.resultData));
    });
    if(!saved)throw new Error('本机恢复未保存完成，原资料与当前训练保留；请先处理未保存内容');
    return copy(p.report);
  });}
}
