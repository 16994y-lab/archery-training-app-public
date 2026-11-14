import {deletionStore} from './account-deletion-local';
import type {DeletionScope,DeletionJournal} from './account-deletion-core';
import {CONTRIBUTION_PREFIX,validateContributionRequest,contributionHttpError} from './photo-contribution-api';
import type {ContributionIdentity} from './photo-contribution-store';
import {copy,initialData,LIMITS,uid,type Data} from './domain';
import {validateData} from './store';
import {CloudApiClient,CloudHttpError,OtpSendError,mainlandPhone,type OtpSendReceipt,PasswordOutcomeUnknownError,RecoverySessionExpiredError,serviceKey,transport,mobileServiceBase,type OriginalChannelSession,type AuthSession,type CloudConfig,type EmailSecurityStatus,type EmailSecurityChallenge} from './api';
import {createChannelTransport} from './channel-change-transport';
import {createNativePrivateMediaChannel,validateNativePrivateMediaRequest,validateNativeMediaArchiveRequest} from './private-media-native-channel';
import {createNativeMediaArchiveExporter} from './media-archive-native-export';
import {readBoundedResponse} from './bounded-response';
import type {Actor,ChannelTransport} from './channel-change-client';
import {cloudStorage,type CloudStorage} from './cloud-meta';
import type {ProductionCommunityIdentity} from './community-api';
import {communityTestOnly,trainingCloudUnavailable,automaticRecordsSaveReady,privateMediaSaveReady,protectedArchiveReady} from './release-mode';
import {DurableCloudSave} from './cloud-save-queue';
import {assertHostedBackupFits} from './manual-backup-transport';
import {assertPortableBackupTree} from './manual-backup-portable';
import type {ScoreBackupDocument,ScoreBackupResponse} from './score-backup';
import type {EnrollmentRequest,EnrollmentStatus} from './email-enrollment-contract';
import {createEnrollmentStorage} from './email-enrollment-storage';
import {emailEnrollmentReady} from './release-mode';
import {isFreshPhoneRegistration,type PhoneRegistrationWindow} from './registration-completion';
import {markRegistrationIntroPending,registrationIntroPersistence} from './intro-preference';
import {parseLocalIdentity,type LocalIdentity} from './local-identity';
import {TeamApi,validateTeamRequest,type TeamIdentity} from './team-api';
import {TeamSharingQueue,type LocalTeamScope} from './team-sharing-queue';
import {teamSharingReady} from './release-mode';

export const CLOUD_COLLECTIONS=['sessions','plans','targets','equipment','schedules','programs','goals','accessories'] as const;
type Collection=typeof CLOUD_COLLECTIONS[number];
export type CloudDocument=Pick<Data,'schema'|'sessions'|'plans'|'targets'|'equipment'|'schedules'|'programs'|'goals'|'profile'>&{accessories:NonNullable<Data['accessories']>};
type Entity={id:string;name?:string;date?:string;[key:string]:unknown};
export type CloudConflict={key:string;collection:Collection|'profile';id:string;label:string;local:unknown;remote:unknown;kind:'edit-edit'|'edit-delete'|'add-add'};
export type Resolutions=Record<string,'local'|'remote'>;
export type RemoteDocument={revision:number;document:CloudDocument|null;updatedAt:string|null};
type Space={owner:string;email:string;service:string;base:CloudDocument|null;revision:number;lastSync:string|null;local:CloudDocument|null;activeId:string|null};
type Switch={from:string|null;to:string;oldDoc:CloudDocument;nextDoc:CloudDocument;nextActiveId:string|null};
type RecoveryArchive={id:string;savedAt:string;spaces:Record<string,Space>;pendingSwitch:Switch|null};
type Meta={version:1;binding:string|null;spaces:Record<string,Space>;pendingSwitch:Switch|null;recoveryArchives?:RecoveryArchive[];cloudSaveQueue?:string;teamSharingQueue?:string};
export type CloudPhase='unconfigured'|'signed-out'|'binding'|'ready'|'syncing'|'conflict'|'error';
export type CloudStatus={phase:CloudPhase;message:string;email:string;owner:string|null;boundEmail:string;needsBinding:boolean;lastSync:string|null;dirty:boolean;conflicts:CloudConflict[];busy:boolean;recoveryEmail:string|null;authVerified:boolean;reauthenticationRequired?:boolean;phoneVerified?:boolean;phoneDisplay?:string;profileDefaultName?:string|null;localAllowed?:boolean};
export type CloudAdapter={read:()=>Data;pending?:()=>boolean;update:(change:(data:Data)=>void)=>Promise<boolean>;localAccount?:()=>string|null;selectLocalAccount?:(key:string,legacyOwner:string|null)=>Promise<void>};
type Pending={base:CloudDocument;local:CloudDocument;remote:CloudDocument;revision:number;owner:string};
const emptyMeta=():Meta=>({version:1,binding:null,spaces:{},pendingSwitch:null});
const labels:Record<Collection|string,string>={sessions:'场次',plans:'训练计划',targets:'自建靶面',equipment:'器材套组',schedules:'未来训练',programs:'长期计划',goals:'目标',accessories:'配件',profile:'个人资料',name:'姓名',bow:'弓种',hand:'惯用手',experience:'训练经历',competition:'比赛安排'};

function stable(value:unknown):string {if(value===undefined)return 'undefined';if(value===null||typeof value!=='object')return JSON.stringify(value);if(Array.isArray(value))return '['+value.map(stable).join(',')+']';return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+stable((value as Record<string,unknown>)[key])).join(',')+'}';}
export const cloudEqual=(left:unknown,right:unknown)=>stable(left)===stable(right);
export function cloudDocument(data:Data):CloudDocument {
  const profile=copy(data.profile);
  // Local avatar assets have a separate explicit media contract; the old cloud schema accepts four presets.
  if(!['initial','bow','target','star'].includes(String(profile.avatar??'initial')))profile.avatar='initial';
  const document={schema:1,profile:Object.fromEntries(Object.entries(profile).filter(([key])=>['name','bow','hand','experience','competition','avatar'].includes(key)))} as CloudDocument;
  for(const collection of CLOUD_COLLECTIONS)(document as unknown as Record<string,unknown>)[collection]=copy(data[collection]??[]).sort((a:{id:string},b:{id:string})=>a.id.localeCompare(b.id));
  document.sessions.forEach(session=>{if(session.status==='active')session.status='draft';});
  return document;
}
export const emptyCloudDocument=()=>cloudDocument(initialData());
export function validateCloudDocument(value:unknown):CloudDocument {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('云资料格式无效，本机未改变');
  const d=value as CloudDocument;if(Object.keys(d).sort().join()!==['schema','profile',...CLOUD_COLLECTIONS].sort().join()||d.schema!==1)throw new Error('云资料版本或字段不兼容，本机未改变');
  if(d.sessions?.some(s=>s.status==='active'))throw new Error('云端不能指定此设备的当前训练');
  if(new TextEncoder().encode(JSON.stringify(d)).length>LIMITS.bytes)throw new Error('云资料超过 24 MiB，本机未改变');
  const candidate={...initialData(),...copy(d),activeId:null};validateData(candidate);
  if(!Array.isArray(d.accessories)||d.accessories.length>5000||new Set(d.accessories.map(a=>a.id)).size!==d.accessories.length||d.accessories.some(a=>!a.id||typeof a.favorite!=='boolean'||['category','name','note'].some(k=>typeof a[k as keyof typeof a]!=='string')))throw new Error('云配件资料无效');
  return cloudDocument(candidate);
}
export function mergeCloudDocuments(base:CloudDocument,local:CloudDocument,remote:CloudDocument,resolutions:Resolutions={}){
  const document=emptyCloudDocument(),conflicts:CloudConflict[]=[];
  function choose(collection:Collection|'profile',id:string,b:unknown,l:unknown,r:unknown){
    const key=collection+':'+id,chosen=resolutions[key];
    if(chosen)return chosen==='local'?l:r;
    if(cloudEqual(l,r))return l;if(cloudEqual(l,b))return r;if(cloudEqual(r,b))return l;
    const entity=(l??r) as Entity|undefined;
    conflicts.push({key,collection,id,label:collection==='profile'?`个人资料 · ${labels[id]??id}`:`${labels[collection]} · ${entity?.name||entity?.date||id}`,local:l??null,remote:r??null,kind:l===undefined||r===undefined?'edit-delete':b===undefined?'add-add':'edit-edit'});
    return l;
  }
  for(const collection of CLOUD_COLLECTIONS){
    const index=(d:CloudDocument)=>new Map((d[collection] as unknown as Entity[]).map(entity=>[entity.id,entity]));
    const b=index(base),l=index(local),r=index(remote),ids=[...new Set([...b.keys(),...l.keys(),...r.keys()])].sort();
    (document as unknown as Record<string,unknown>)[collection]=ids.map(id=>choose(collection,id,b.get(id),l.get(id),r.get(id))).filter(value=>value!==undefined);
  }
  for(const field of Object.keys(document.profile) as (keyof Data['profile'])[])document.profile[field]=choose('profile',field,base.profile[field],local.profile[field],remote.profile[field]) as string;
  return {document,conflicts};
}
/** A local active reference is never uploaded or reassigned by another device. */
export function applyCloudDocument(data:Data,document:CloudDocument,activeId=data.activeId){
  for(const collection of CLOUD_COLLECTIONS)(data as unknown as Record<string,unknown>)[collection]=copy(document[collection]);
  const localAvatar=data.profile.avatar;data.profile=copy(document.profile);
  if(localAvatar&&!['initial','bow','target','star'].includes(String(localAvatar)))data.profile.avatar=localAvatar;
  data.activeId=null;
  const current=data.sessions.find(session=>session.id===activeId);if(current&&current.status==='draft'){current.status='active';data.activeId=current.id;}
  validateData(data);
}
export function cloudConfig(data:Data):CloudConfig{
  const env=(import.meta as ImportMeta&{env?:Record<string,string>}).env??{};
  if(communityTestOnly)return {api:env.VITE_API_URL??'',auth:env.VITE_SUPABASE_URL??'',publicKey:env.VITE_SUPABASE_PUBLISHABLE_KEY??''};
  return {api:data.connection.api||env.VITE_API_URL||env.VITE_API_BASE_URL||'',auth:data.connection.auth||env.VITE_SUPABASE_URL||'',publicKey:data.connection.publicKey||env.VITE_SUPABASE_PUBLISHABLE_KEY||env.VITE_SUPABASE_ANON_KEY||''};
}
function remoteValue(value:RemoteDocument){if(!Number.isSafeInteger(value.revision)||value.revision<0||(value.revision===0)!==(value.document===null))throw new Error('云端版本响应无效');return value.document?validateCloudDocument(value.document):emptyCloudDocument();}
function parseMeta(raw:string|null):Meta{
  if(raw===null)return emptyMeta();const meta=JSON.parse(raw) as Meta;
  const invalid=()=>new Error('本机同步元信息无法恢复，已暂停云同步；请先导出备份并核对，训练档案保留');
  const nullableText=(value:unknown)=>value===null||typeof value==='string';
  function spaces(value:Record<string,Space>){
    if(!value||typeof value!=='object'||Array.isArray(value))throw invalid();
    for(const [key,space] of Object.entries(value)){
      if(!space||typeof space.service!=='string'||typeof space.owner!=='string'||!space.owner||typeof space.email!=='string'||key!==space.service+'|'+space.owner||!Number.isSafeInteger(space.revision)||space.revision<0||!nullableText(space.activeId)||!nullableText(space.lastSync)||(space.lastSync!==null&&!Number.isFinite(Date.parse(space.lastSync))))throw invalid();
      if(space.base!==null)space.base=validateCloudDocument(space.base);if(space.local!==null)space.local=validateCloudDocument(space.local);
    }
  }
  function pending(value:Switch|null,all:Record<string,Space>){if(value===null)return;if(!value||typeof value.to!=='string'||!Object.prototype.hasOwnProperty.call(all,value.to)||!nullableText(value.from)||(value.from!==null&&!Object.prototype.hasOwnProperty.call(all,value.from))||!nullableText(value.nextActiveId))throw invalid();value.oldDoc=validateCloudDocument(value.oldDoc);value.nextDoc=validateCloudDocument(value.nextDoc);}
  if(!meta||meta.version!==1||!nullableText(meta.binding)||Object.keys(meta).some(key=>!['version','binding','spaces','pendingSwitch','recoveryArchives','cloudSaveQueue','teamSharingQueue'].includes(key)))throw invalid();
  if(meta.cloudSaveQueue!==undefined&&typeof meta.cloudSaveQueue!=='string')throw invalid();
  if(meta.teamSharingQueue!==undefined&&(typeof meta.teamSharingQueue!=='string'||new TextEncoder().encode(meta.teamSharingQueue).length>64*1024*1024))throw invalid();
  spaces(meta.spaces);if(meta.binding!==null&&!Object.prototype.hasOwnProperty.call(meta.spaces,meta.binding))throw invalid();pending(meta.pendingSwitch,meta.spaces);
  if(meta.recoveryArchives!==undefined){if(!Array.isArray(meta.recoveryArchives)||new Set(meta.recoveryArchives.map(a=>a?.id)).size!==meta.recoveryArchives.length)throw invalid();for(const archive of meta.recoveryArchives){if(!archive||typeof archive.id!=='string'||!archive.id||typeof archive.savedAt!=='string'||!Number.isFinite(Date.parse(archive.savedAt)))throw invalid();spaces(archive.spaces);pending(archive.pendingSwitch,archive.spaces);}}
  return meta;
}

export class CloudSync {
  private adapter:CloudAdapter|null=null;
  private meta:Meta=emptyMeta();
  private api:CloudApiClient|null=null;
  private communityEpoch=0;
  private channelEpoch=0;
  private channelPin:{api:CloudApiClient;communityEpoch:number;original:OriginalChannelSession}|null=null;
  private channelAbort:AbortController|null=null;
  private channelImpl:ChannelTransport|null=null;
  private initialized=false;
  private recoveryPaused=false;
  private initializing:Promise<void>|null=null;
  private pending:Pending|null=null;
  private operation:Promise<void>|null=null;
  private timer:ReturnType<typeof setTimeout>|null=null;
  private durableSave:DurableCloudSave<CloudDocument>|null=null;
  private persistence:Promise<unknown>=Promise.resolve();
  private sessionPersistence:Promise<void>=Promise.resolve();
  private configuring:Promise<void>=Promise.resolve();
  private saveIdentityKey='null';
  private teamQueue:TeamSharingQueue|null=null;
  private teamApi:TeamApi|null=null;
  private teamScopeKey='null';
  private saveQueueError='';
  private mediaChannel:ReturnType<typeof createNativePrivateMediaChannel>|null=null;
  private archiveMediaChannel:ReturnType<typeof createNativePrivateMediaChannel>|null=null;
  private archiveMediaExporter:ReturnType<typeof createNativeMediaArchiveExporter>|null=null;
  private passwordRecovery:{client:CloudApiClient;previous:CloudStatus;original:{api:CloudApiClient;owner:string;service:string;generation:number}|null}|null=null;
  private recoveryOperation:Promise<void>|null=null;
  private automaticSyncPaused=false;
  private logoutPending=false;
  private deletionFreeze:Promise<void>|null=null;
  private deletionLocked=false;
  private signingOut:Promise<void>|null=null;
  // Presentation hints only. The server owns cross-device cooldown and quota.
  private otpRetryAt=new Map<string,number>();
  private otpSending=new Set<string>();
  private emailRecoveryRetryAt=0;
  private registrationEpoch=0;
  private phoneRegistrationAttempt:(PhoneRegistrationWindow&{phone:string;api:CloudApiClient;epoch:number})|null=null;
  private listeners=new Set<()=>void>();
  private localIdentity:LocalIdentity|null=null;
  private localPin:{owner:string;service:string}|null=null;
  private identityDamaged=false;
  private identityWrites:Promise<unknown>=Promise.resolve();
  private identityEpoch=0;
  // Photo retention only: this fence never authorizes a network request.
  private captureEpoch=0;
  private reverifyNotice=0;
  private switchingLocal=false;
  private status:CloudStatus={phase:'signed-out',message:'训练先保存在本机',email:'',owner:null,boundEmail:'',needsBinding:false,lastSync:null,dirty:false,conflicts:[],busy:false,recoveryEmail:null,authVerified:false};
  constructor(private storage:CloudStorage=cloudStorage,private createClient:(config:CloudConfig,persist:(session:AuthSession|null)=>Promise<void>)=>CloudApiClient=(config,persist)=>new CloudApiClient(config,persist),private testOnly=communityTestOnly,private now:()=>number=()=>Date.now()){
    if(typeof window!=='undefined'){window.addEventListener('online',()=>void this.resumeTeamSharing());document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')void this.resumeTeamSharing();});}
    if(typeof window!=='undefined'){window.addEventListener('gongxingji-local-identity-changed',()=>this.invalidateLocalIdentity());window.addEventListener('gongxingji-local-identity-reverified',()=>void this.reverifyLocalIdentity());}
  }
  private invalidateLocalIdentity(){this.reverifyNotice++;this.captureEpoch++;this.identityEpoch++;this.localIdentity=null;this.cancelRecovery();this.api?.discardTemporarySession();this.emit({authVerified:false,message:'另一页面已改变登录状态，请重新打开；原资料保留'});}
  /** A same-account notice pauses transport; durable reread plus /user is still required. */
  private async reverifyLocalIdentity(){
    const api=this.api,prior=this.localIdentity,session=api?.session;
    if(!api||!session||!prior||prior.state!=='active'||!this.localAccess()||this.passwordRecovery){this.invalidateLocalIdentity();return;}
    const ticket=++this.reverifyNotice,epoch=++this.identityEpoch,previous=this.operation;
    api.invalidatePendingAuth();const generation=api.communityGeneration;
    this.emit({authVerified:false});
    const current=()=>ticket===this.reverifyNotice&&epoch===this.identityEpoch&&api===this.api&&api.communityGeneration===generation&&!this.logoutPending&&!this.recoveryPaused;
    try{
      await previous?.catch(()=>{});await api.settleSessionWrites();await this.sessionPersistence.catch(()=>{});if(!current())return;
      if(!this.storage.readLocalIdentity)throw Error('本机身份未核实');
      const receipt=parseLocalIdentity(await this.storage.readLocalIdentity());if(!current())return;
      const raw=await this.storage.readSession();if(!current())return;
      const saved=raw?JSON.parse(raw) as AuthSession:null;
      if(!receipt||receipt.state!=='active'||receipt.owner!==prior.owner||receipt.service!==prior.service||!saved||saved.owner!==prior.owner||saved.service!==prior.service||typeof saved.accessToken!=='string'||typeof saved.refreshToken!=='string'||!Number.isFinite(saved.expiresAt))throw Error('账号已变化');
      api.restore(saved);this.localIdentity=receipt;
      if(api.reauthenticationRequired||!this.localAccess())throw Error('账号需重新登录');
      // Do not echo this notification back and create a two-tab verification loop.
      await this.run(()=>this.verifyCurrentSession(false));
    }catch{if(current())this.invalidateLocalIdentity();}
  }
  private async resumeTeamSharing(){if(!teamSharingReady||!this.initialized||!this.teamQueue||!this.teamLocalScope()||typeof navigator!=='undefined'&&navigator.onLine===false)return;try{await this.teamQueue.enqueue();await this.teamQueue.flush();}catch(error){this.emit({message:error instanceof Error?error.message:'团队共享等待联网核对，原训练保持'});}}
  private localAccess(){const s=this.api?.session,p=this.localIdentity,key=p?p.service+'|'+p.owner:null,partition=this.adapter?.localAccount?.();return !this.switchingLocal&&!this.api?.sessionRejected&&!!p&&p.state==='active'&&!!s&&s.owner===p.owner&&s.service===p.service&&s.phoneVerified===true&&!this.logoutPending&&!this.recoveryPaused&&!this.meta.pendingSwitch&&(partition?partition===key:!this.meta.binding||this.meta.binding===key);}
  private grantLocalAccess(announceReceipt=true){
    const api=this.client(),session=api.session,epoch=this.identityEpoch,generation=api.communityGeneration;
    if(!session?.phoneVerified)return Promise.resolve();
    const valid=()=>this.api===api&&epoch===this.identityEpoch&&generation===api.communityGeneration&&api.session?.owner===session.owner&&api.session?.service===session.service&&!this.logoutPending&&!this.recoveryPaused;
    const work=this.identityWrites.then(async()=>{
      if(!valid())throw new Error('账号已变化，本机身份未采用');
      if(!this.localPin&&!this.adapter?.localAccount?.()&&!cloudEqual(cloudDocument(this.current()),emptyCloudDocument()))throw new Error('旧资料所属账号尚未核对，已停止绑定；请恢复原账号凭据，原资料保留');
      if(this.adapter?.selectLocalAccount&&this.adapter.localAccount?.()!==session.service+'|'+session.owner){
        const key=session.service+'|'+session.owner,legacy=this.localPin?this.localPin.service+'|'+this.localPin.owner:key;
        this.switchingLocal=true;this.emit({authVerified:false});
        try{await this.adapter.selectLocalAccount(key,legacy);if(!valid())throw new Error('账号已变化，已保存资料保留，请重新登录');}
        finally{this.switchingLocal=false;this.emit();}
      }else if(!this.adapter?.selectLocalAccount){
        if(this.localPin&&(this.localPin.owner!==session.owner||this.localPin.service!==session.service))throw new Error('此版本尚不支持多账号，请更新安装包；原资料保留');
        if(this.meta.binding&&this.meta.binding!==session.service+'|'+session.owner)throw new Error('本机资料身份不匹配，原资料保留');
      }
      if(!this.storage.writeLocalIdentity)return;
      const receipt:LocalIdentity={version:1,owner:session.owner,service:session.service,verifiedAt:this.now(),state:'active'};
      await this.storage.writeLocalIdentity(JSON.stringify(receipt),announceReceipt);
      if(!valid())throw new Error('账号已变化，本机身份未采用');
      this.localIdentity=receipt;this.localPin={owner:receipt.owner,service:receipt.service};this.identityDamaged=false;
    });this.identityWrites=work.catch(()=>{});return work;
  }
  private disableLocalAccess(state:'signed-out'|'revoked'){
    this.captureEpoch++;this.reverifyNotice++;this.identityEpoch++;const prior=this.localIdentity,session=this.api?.session;
    // Capture the accepted identity before a first receipt's delayed write.
    // The grant may later fail its epoch check and never populate localPin.
    const pin=this.localPin??(session?{owner:session.owner,service:session.service}:null);
    this.localIdentity=prior?{...prior,state}:null;this.emit({authVerified:false});
    const work=this.identityWrites.then(async()=>{const p=this.localIdentity??prior??(pin?{version:1 as const,...pin,verifiedAt:this.now(),state}:null);if(p&&this.storage.writeLocalIdentity){await this.storage.writeLocalIdentity(JSON.stringify({...p,state}));this.localIdentity={...p,state};this.localPin={owner:p.owner,service:p.service};}});this.identityWrites=work.catch(()=>{});return work;
  }
  getStatus=()=>this.status;
  /** A local deadline check; ordinary foreground minutes make no HTTP request. */
  sessionRefreshDue=()=>!!this.api?.session?.phoneVerified&&!this.status.reauthenticationRequired
    &&!this.api.session.relayRefreshCandidate&&this.api.session.expiresAt<=this.now()+60000;
  getAutomaticSave=()=>this.durableSave;
  getAutomaticSaveError=()=>this.saveQueueError;
  private async initializeDurableSave(){
    if(!automaticRecordsSaveReady&&this.meta.cloudSaveQueue===undefined)return;
    const same=(identity:ProductionCommunityIdentity)=>cloudEqual(this.manualBackupIdentity(),identity);
    this.durableSave=new DurableCloudSave<CloudDocument>({
      read:async()=>this.meta.cloudSaveQueue??null,
      write:async value=>{await this.save(undefined,value);},
    },{
      identity:()=>automaticRecordsSaveReady&&this.status.authVerified&&this.status.phoneVerified?this.manualBackupIdentity():null,readLocal:()=>cloudDocument(this.current()),hasPendingLocal:()=>!!this.adapter?.pending?.(),
      empty:emptyCloudDocument,validate:value=>{assertPortableBackupTree(value);return validateCloudDocument(value);},equal:cloudEqual,
      merge:(base,local,remote,resolutions)=>this.mergeForDevice(base,local,remote,resolutions),
      fits:assertHostedBackupFits,
      apply:async(document,expected,identity)=>this.manualBackupSave(()=>this.adapter!.update(data=>{if(!same(identity)||!cloudEqual(cloudDocument(data),expected))throw new Error('账号或本机资料已变化，未覆盖本机记录');applyCloudDocument(data,document);})),
      request:async(method,identity,signal,document,revision)=>{if(!automaticRecordsSaveReady||signal.aborted||!same(identity))throw new Error('本次云保存未开放或已取消');const response=await this.manualBackupRequest(method,identity,document,revision,signal);if(signal.aborted||!same(identity))throw new Error('账号或保存同意已变化，旧结果未采用');return response;},
    },{autoSchedule:automaticRecordsSaveReady,discoverOnIdentity:automaticRecordsSaveReady});
    this.durableSave.subscribe(()=>this.listeners.forEach(listener=>listener()));
    try{await this.durableSave.initialize();}catch(error){this.saveQueueError=error instanceof Error?error.message:'自动云保存元信息未恢复，本机训练及登录仍可使用';this.durableSave=null;this.emit({message:this.saveQueueError});}
  }
  private otpKey(kind:'phone'|'email',destination:string){return JSON.stringify([this.enrollmentService(),kind,kind==='phone'?mainlandPhone(destination):destination.trim().toLowerCase()]);}
  otpRetrySeconds=(kind:'phone'|'email',destination:string)=>{try{return Math.max(0,Math.ceil(((this.otpRetryAt.get(this.otpKey(kind,destination))??0)-this.now())/1000));}catch{return 0;}};
  // Automatic foreground verification yields to an outstanding send; password login does not.
  otpSendInProgress=()=>this.otpSending.size>0;
  otpSendPending=(kind:'phone'|'email',destination:string)=>{try{return this.otpSending.has(this.otpKey(kind,destination));}catch{return false;}};
  private otpClient(){if(this.logoutPending||this.recoveryPaused||this.passwordRecovery||this.operation||!this.initialized)throw new Error('请先完成当前账号操作，再申请验证码');return this.client();}
  private async requestOtp(kind:'phone'|'email',destination:string,send:()=>Promise<OtpSendReceipt>){
    const key=this.otpKey(kind,destination),seconds=this.otpRetrySeconds(kind,destination);
    if(this.otpSending.has(key))throw new Error('此号码或邮箱的申请仍在处理中，请先核对结果');
    if(seconds>0)throw new Error(`请 ${seconds} 秒后再申请验证码；服务器会再次核对发送间隔`);
    for(const [old,until] of this.otpRetryAt)if(until<=this.now()&&!this.otpSending.has(old))this.otpRetryAt.delete(old);
    this.otpSending.add(key);this.otpRetryAt.set(key,this.now()+60000);this.emit({});
    // A phone click starts one local manual-application interval, not server admission.
    // Late accepted/unknown replies do not start it again; begin remains authoritative.
    try{const result=await send();if(kind!=='phone'&&result.retryAfterSeconds!==undefined)this.otpRetryAt.set(key,this.now()+result.retryAfterSeconds*1000);return result;}
    catch(error){if(error instanceof OtpSendError&&error.retryAfterSeconds!==undefined&&(kind!=='phone'||error.status===429||error.outcome==='rejected'))this.otpRetryAt.set(key,this.now()+error.retryAfterSeconds*1000);throw error;}
    finally{this.otpSending.delete(key);this.emit({});}
  }
  emailRecoveryRetrySeconds=()=>Math.max(0,Math.ceil((this.emailRecoveryRetryAt-this.now())/1000));
  private originalChannelContext(){
    const api=this.api,original=api?.originalChannelSession();
    if(!this.initialized||!this.status.authVerified||this.recoveryPaused||this.passwordRecovery||this.logoutPending
      ||this.meta.pendingSwitch||!api||!original){this.channelPin=null;return null;}
    const old=this.channelPin,p=old?.original,s=original.session;
    if(!old||old.api!==api||old.communityEpoch!==this.communityEpoch||p?.generation!==original.generation
      ||p.session.owner!==s.owner||p.session.service!==s.service||p.session.accessToken!==s.accessToken
      ||p.session.refreshToken!==s.refreshToken||p.session.expiresAt!==s.expiresAt
      ||p.serviceOrigin!==original.serviceOrigin||p.supabaseOrigin!==original.supabaseOrigin||p.publishableKey!==original.publishableKey){
      if(this.channelEpoch>=Number.MAX_SAFE_INTEGER)throw new Error('账号作用域已耗尽，请重开应用');
      this.channelEpoch++;this.channelPin={api,communityEpoch:this.communityEpoch,original};
    }
    return {api,original,actor:{owner:s.owner,sessionEpoch:this.channelEpoch}};
  }
  /** The UI receives an opaque owner/epoch only, never bearer credentials. */
  channelActor=():Actor|null=>this.originalChannelContext()?.actor??null;
  /** Local queue ownership is separate from fresh online authorization. */
  teamLocalScope=():LocalTeamScope|null=>{const s=this.api?.session;if(!this.localAccess()||!s||!this.api)return null;return {owner:s.owner,service:mobileServiceBase(this.api.config.api)};};
  teamIdentity=():TeamIdentity|null=>{const c=this.originalChannelContext();return c&&this.status.phoneVerified===true?{owner:c.actor.owner,epoch:c.actor.sessionEpoch,service:c.original.serviceOrigin}:null;};
  getTeamApi(){if(!teamSharingReady)throw new Error('当前安装包尚未开放团队共享');return this.teamApi??=new TeamApi({identity:this.teamIdentity,request:(url,init,expected)=>this.teamRequest(url,init,expected)});}
  getTeamQueue(){return this.teamQueue??=new TeamSharingQueue({read:async()=>this.meta.teamSharingQueue??null,write:async raw=>{if(new TextEncoder().encode(raw).length>64*1024*1024)throw new Error('团队提交达到容量保护，原训练保持');await this.save(undefined,undefined,raw);},scope:this.teamLocalScope,sessions:()=>this.current().sessions,api:this.getTeamApi(),online:()=>typeof navigator==='undefined'||navigator.onLine!==false,prepare:()=>this.ensureTeamIdentity()});}
  async ensureTeamIdentity(){if(!teamSharingReady)throw new Error('当前安装包尚未开放团队共享');await this.ensureScoreBackupIdentity();const identity=this.teamIdentity();if(!identity)throw new Error('请联网核对原账号后使用团队共享');return identity;}
  private async teamRequest(url:string,init:RequestInit,expected:TeamIdentity):Promise<Response>{
    const c=this.originalChannelContext();if(!c||JSON.stringify(this.teamIdentity())!==JSON.stringify(expected))throw new Error('团队账号已变化，未发送请求');
    validateTeamRequest(url,init,c.original.serviceOrigin);
    const deadline=new AbortController(),timer=setTimeout(()=>deadline.abort(),20000);
    try{return await this.runChannelOperation(c.actor,deadline.signal,async signal=>{const context=this.assertChannelActor(c.actor);if(JSON.stringify(this.teamIdentity())!==JSON.stringify(expected))throw new Error('团队会话已变化');return transport(url,{...init,signal,headers:{...init.headers,Authorization:'Bearer '+context.original.session.accessToken}});});}finally{clearTimeout(timer);}
  }
  private assertChannelActor(actor:Actor){
    const c=this.originalChannelContext();
    if(!c||c.actor.owner!==actor.owner||c.actor.sessionEpoch!==actor.sessionEpoch)throw new Error('原账号作用域已变化，请重新读取');
    return c;
  }

  /** Dedicated D-123 channel. This never inherits personal backup or team consent. */
  private contributionChannel:ReturnType<typeof createNativePrivateMediaChannel>|null=null;
  photoContributionIdentity=():ContributionIdentity|null=>{const c=this.originalChannelContext();return c&&this.status.phoneVerified?{owner:c.actor.owner,epoch:c.actor.sessionEpoch,authService:c.original.supabaseOrigin.replace(/\/$/,''),apiService:c.original.serviceOrigin}:null;};
  photoContributionLocalIdentity=():ContributionIdentity|null=>{const s=this.api?.session;if(!s||!this.api||!this.localAccess())return null;return {owner:s.owner,epoch:0,authService:this.api.config.auth.replace(/\/$/,''),apiService:mobileServiceBase(this.api.config.api)};};
  /** Retain only the already selected local account; online authority is separate. */
  photoContributionCaptureIdentity=():ContributionIdentity|null=>{const i=this.photoContributionLocalIdentity();return i&&!this.passwordRecovery?{...i,epoch:this.captureEpoch}:null;};
  photoContributionAvailable=()=>typeof window==='undefined'||!window.Gongxingji||['photoContributionFingerprint','privateMediaBegin','privateMediaChunk','privateMediaFinish','privateMediaCancel'].every(key=>typeof (window.Gongxingji as unknown as Record<string,unknown>)[key]==='function');
  async photoContributionPolicy(signal:AbortSignal):Promise<unknown>{
    const base=mobileServiceBase(this.client().config.api),controller=new AbortController(),stop=()=>controller.abort(),timer=setTimeout(stop,12000);signal.addEventListener('abort',stop,{once:true});
    try{if(signal.aborted)throw Error('已取消');const r=await transport(base+CONTRIBUTION_PREFIX+'/policy',{signal:controller.signal,method:'GET',cache:'no-store',credentials:'omit',redirect:'error',referrerPolicy:'no-referrer'});if(!r.ok)throw Error('贡献条件暂不可用');const raw=JSON.parse(new TextDecoder().decode(await readBoundedResponse(r,32768,controller.signal)));if(base!==mobileServiceBase(this.client().config.api)||signal.aborted)throw Error('服务已变化');return raw;}finally{clearTimeout(timer);signal.removeEventListener('abort',stop);}
  }
  async photoContributionRequest(expected:ContributionIdentity,method:'GET'|'POST'|'PUT',path:string,signal:AbortSignal,body?:unknown,requestId?:string):Promise<unknown>{
    validateContributionRequest(method,path,body,requestId);const c=this.originalChannelContext();if(!c||JSON.stringify(this.photoContributionIdentity())!==JSON.stringify(expected)||!this.photoContributionAvailable())throw Error('贡献账号或通道尚未核实');
    return this.runChannelOperation(c.actor,signal,async live=>{
      const assert=()=>{this.assertChannelActor(c.actor);if(live.aborted||JSON.stringify(this.photoContributionIdentity())!==JSON.stringify(expected))throw Error('贡献账号已变化');};assert();
      if(typeof window!=='undefined'&&window.Gongxingji){
        if(!this.contributionChannel||this.contributionChannel.isDisposed())this.contributionChannel=createNativePrivateMediaChannel({enabled:()=>!!this.photoContributionIdentity()&&this.photoContributionAvailable(),identity:()=>{const i=this.photoContributionIdentity();return i?{owner:i.owner,service:i.apiService,generation:i.epoch,sessionKey:i.authService}:null;}},'photo-contribution');
        const bytes=body instanceof Blob?new Uint8Array(await body.arrayBuffer()):body;assert();const r=await this.contributionChannel.request(method,CONTRIBUTION_PREFIX+path,live,bytes,method==='PUT'?{'content-type':'image/png','x-contribution-request-id':requestId!}:{});assert();return r;
      }
      const controller=new AbortController(),stop=()=>controller.abort(),timer=setTimeout(stop,120000);live.addEventListener('abort',stop,{once:true});
      try{const context=this.assertChannelActor(c.actor),headers:Record<string,string>={Accept:'application/json',Authorization:'Bearer '+context.original.session.accessToken};if(method==='POST')headers['Content-Type']='application/json';if(method==='PUT'){headers['Content-Type']='image/png';headers['X-Contribution-Request-Id']=requestId!;}
        const r=await transport(expected.apiService+CONTRIBUTION_PREFIX+path,{method,signal:controller.signal,cache:'no-store',credentials:'omit',redirect:'error',referrerPolicy:'no-referrer',headers,body:body instanceof Blob?body:body===undefined?undefined:JSON.stringify(body)});assert();if(!r.ok){let detail:unknown=null;if(r.status===409){try{detail=JSON.parse(new TextDecoder().decode(await readBoundedResponse(r,4096,controller.signal)));}catch{/* Legacy or untrusted error bodies stay unclassified. */}}assert();throw contributionHttpError(r.status,detail);}const raw=JSON.parse(new TextDecoder().decode(await readBoundedResponse(r,1024*1024,controller.signal)));assert();return raw;
      }finally{clearTimeout(timer);live.removeEventListener('abort',stop);}
    });
  }

  /** Share the existing mutex, but never run training synchronization on exit. */
  private async runChannelOperation<T>(actor:Actor,signal:AbortSignal,work:(signal:AbortSignal)=>Promise<T>):Promise<T>{
    if(signal.aborted||this.operation||this.status.busy)throw new Error('当前账号操作未结束或已取消');
    this.assertChannelActor(actor);
    if(this.timer){clearTimeout(this.timer);this.timer=null;}
    const controller=new AbortController(),stop=()=>controller.abort();signal.addEventListener('abort',stop,{once:true});
    this.channelAbort=controller;
    const result=Promise.resolve().then(()=>{if(controller.signal.aborted)throw new Error('账号操作已取消');this.assertChannelActor(actor);return work(controller.signal);});
    const slot=result.then(()=>{},()=>{});this.operation=slot;this.emit({busy:true});
    try{const value=await result;if(controller.signal.aborted)throw new Error('账号操作已取消');this.assertChannelActor(actor);return value;}
    finally{signal.removeEventListener('abort',stop);if(this.channelAbort===controller)this.channelAbort=null;if(this.operation===slot){this.operation=null;this.emit({busy:false});}}
  }
  private channelTransport(){
    if(!this.channelImpl)this.channelImpl=createChannelTransport({
      fetcher:(input,options)=>{
        if(typeof input!=='string'&&!(input instanceof URL))return Promise.reject(new Error('账号请求地址格式无效'));
        return transport(String(input),options??{});
      },
      readSession:()=>{const c=this.originalChannelContext();return c?{...c.actor,accessToken:c.original.session.accessToken,
        serviceOrigin:c.original.serviceOrigin,supabaseOrigin:c.original.supabaseOrigin,publishableKey:c.original.publishableKey}:null;},
      commitChannelFacts:async(facts,actor)=>{
        const c=this.assertChannelActor(actor),signal=this.channelAbort?.signal;
        const current=()=>{const n=this.originalChannelContext();return !signal?.aborted&&!!n&&n.api===c.api&&n.actor.owner===actor.owner&&n.actor.sessionEpoch===actor.sessionEpoch;};
        try{await c.api.commitChannelFacts(facts,c.original,current);}
        catch(error){this.emit({authVerified:false,message:'渠道保存未能确认，请重新核验当前登录；训练记录保留'});throw error;}
        this.emit({message:facts.kind==='email'?'已核对原账号的新邮箱；请另行验证邮箱所有权':'已核对原账号的新手机号'});
      }
    });
    return this.channelImpl;
  }
  accountChannelTransport:ChannelTransport={
    request:(action,body,actor,signal)=>this.runChannelOperation(actor,signal,s=>this.channelTransport().request(action,body,actor,s)),
    confirmOriginalAccount:(kind,target,actor,signal)=>this.runChannelOperation(actor,signal,s=>this.channelTransport().confirmOriginalAccount(kind,target,actor,s))
  };
  invitationTransport=(action:'status'|'create'|'attribute',body:Record<string,unknown>,actor:Actor,signal:AbortSignal)=>this.runChannelOperation(actor,signal,async live=>{
    if(!['status','create','attribute'].includes(action))throw new Error('邀请动作无效');
    const c=this.assertChannelActor(actor);
    if(action==='attribute'?Object.keys(body).join()!=='code'||typeof body.code!=='string'||! /^[A-Za-z0-9_-]{32}$/.test(body.code):Object.keys(body).length!==0)throw new Error('邀请请求格式无效');
    const abort=new AbortController(),stop=()=>abort.abort(),timer=setTimeout(stop,15000);live.addEventListener('abort',stop,{once:true});
    try{
      const response=await transport(c.original.serviceOrigin+'/api/auth/invitations/'+(action==='attribute'?'attribute':'me'),{
        method:action==='status'?'GET':'POST',credentials:'omit',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer',
        headers:{Accept:'application/json','Content-Type':'application/json',Authorization:'Bearer '+c.original.session.accessToken},
        body:action==='status'?undefined:JSON.stringify(body),signal:abort.signal});
      if(live.aborted)throw new Error('邀请操作已取消');this.assertChannelActor(actor);
      if(!response.ok)throw new Error('邀请服务暂不可用，请稍后手动读取');
      const r=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await readBoundedResponse(response,1024*1024,abort.signal))) as Record<string,unknown>;this.assertChannelActor(actor);
      const fields=action==='status'?['owner','code','attributed']:action==='create'?['owner','code']:['owner','attributed','replayed'];
      if(live.aborted||!r||Array.isArray(r)||r.owner!==actor.owner||Object.keys(r).some(k=>!fields.includes(k))||fields.some(k=>!(k in r))
        ||r.code!=null&&(typeof r.code!=='string'||! /^[A-Za-z0-9_-]{32}$/.test(r.code))
        ||action==='create'&&typeof r.code!=='string'||action==='status'&&typeof r.attributed!=='boolean'
        ||action==='attribute'&&(r.attributed!==true||typeof r.replayed!=='boolean'))throw new Error('邀请结果未能核对');
      return r as {owner:string;code?:string|null;attributed?:boolean;replayed?:boolean};
    }finally{clearTimeout(timer);live.removeEventListener('abort',stop);}
  });
  /** A snapshot only; no token or private training document reaches the community page. */
  communityIdentity=():ProductionCommunityIdentity|null=>{
    const api=this.api,session=api?.session;
    if(!this.initialized||this.recoveryPaused||this.passwordRecovery||this.meta.pendingSwitch||this.logoutPending
      ||!api||!session||session.expiresAt<=Date.now()+60000
      ||session.service!==serviceKey(api.config)
      ||!Number.isSafeInteger(api.communityGeneration)||api.communityGeneration<0
      ||!/^[A-Za-z0-9_-]{1,128}$/.test(session.owner))return null;
    try{
      const service=new URL(api.config.api),auth=new URL(api.config.auth);
      const base=new URL(api.config.api.replace(/\/api\/?$/,''));
      if(service.protocol!=='https:'||auth.protocol!=='https:'||base.pathname!=='/'
        ||service.username||service.password||service.search||service.hash
        ||auth.username||auth.password||auth.search||auth.hash)return null;
      return {owner:session.owner,service:base.origin,generation:api.communityGeneration,sessionKey:`${session.service}|${this.communityEpoch}`};
    }catch{return null;}
  };
  /** Refresh first; a restored, expired token alone never opens community writes. */
  private async refreshIdentity(api:CloudApiClient){
    try{if(api.session&&api.session.expiresAt<=Date.now()+60000)await api.refresh();}
    catch(error){if(this.api===api){this.emit({authVerified:false});if(api.sessionRejected)await this.disableLocalAccess('revoked');}throw error;}
    finally{if(this.api===api)this.emit();}
  }
  async ensureCommunityIdentity():Promise<ProductionCommunityIdentity>{
    if(!this.initialized||this.recoveryPaused||this.passwordRecovery||this.meta.pendingSwitch||this.logoutPending)throw new Error('社区账号退出尚未完成，请重试退出');
    const api=this.client();if(!api.session)throw new Error('请先登录社区账号');
    await this.refreshIdentity(api);
    const identity=this.communityIdentity();if(!identity)throw new Error('社区账号或 HTTPS 服务尚未就绪');
    return identity;
  }
  /** Account check for optional score backup; no community feature is opened. */
  async ensureScoreBackupIdentity():Promise<ProductionCommunityIdentity>{
    if(!this.initialized||this.recoveryPaused||this.passwordRecovery||this.meta.pendingSwitch||this.logoutPending)
      throw new Error('账号正在切换或退出，请稍后再核对成绩备份');
    const api=this.client();if(!api.session)throw new Error('请先登录后使用可选成绩备份');
    await this.refreshIdentity(api);
    const identity=this.communityIdentity();if(!identity)throw new Error('成绩备份账号或 HTTPS 服务尚未就绪');
    return identity;
  }
  subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
  private emit(patch:Partial<CloudStatus>={}){const wasVerified=this.status.authVerified;const session=this.api?.session,space=this.meta.binding?this.meta.spaces[this.meta.binding]:null;this.status={...this.status,email:session?.email??'',owner:session?.owner??null,phoneVerified:session?.phoneVerified===true,phoneDisplay:this.api?.phoneDisplay??'',profileDefaultName:session?.profileDefaultName??null,boundEmail:space?.email??'',needsBinding:!!this.key()&&this.key()!==this.meta.binding,lastSync:space?.lastSync??null,...patch,reauthenticationRequired:this.api?.reauthenticationRequired===true,localAllowed:this.localAccess()};if(!session||this.logoutPending||this.api?.sessionRejected)this.status.authVerified=false;const saveIdentity=this.status.authVerified?this.manualBackupIdentity():null,saveKey=JSON.stringify(saveIdentity);if(this.durableSave&&saveKey!==this.saveIdentityKey){this.saveIdentityKey=saveKey;this.durableSave.identityChanged();}const teamKey=JSON.stringify(this.teamLocalScope());if(teamKey!==this.teamScopeKey){this.teamScopeKey=teamKey;this.teamQueue?.identityChanged();}this.listeners.forEach(listener=>listener());if(!wasVerified&&this.status.authVerified&&this.teamQueue)setTimeout(()=>void this.resumeTeamSharing(),0);}
  private async save(meta:Meta|undefined,queue?:string,teamQueue?:string){
    const work=this.persistence.then(async()=>{const next=copy(meta??this.meta);if(queue!==undefined)next.cloudSaveQueue=queue;else if(this.meta.cloudSaveQueue!==undefined)next.cloudSaveQueue=this.meta.cloudSaveQueue;if(teamQueue!==undefined)next.teamSharingQueue=teamQueue;else if(this.meta.teamSharingQueue!==undefined)next.teamSharingQueue=this.meta.teamSharingQueue;await this.storage.writeMeta(JSON.stringify(next));this.meta=next;});this.persistence=work.catch(()=>{});await work;
  }
  private key(){const session=this.api?.session;return session?session.service+'|'+session.owner:null;}
  private current(){if(!this.adapter)throw new Error('同步尚未初始化');return this.adapter.read();}
  private assertIdentity(key:string){if(this.recoveryPaused||this.key()!==key||this.meta.binding!==key||this.meta.pendingSwitch)throw new Error('账号隔离状态已变化，未继续同步');}
  private ready(){const key=this.key();this.emit({phase:!this.api?'unconfigured':!key?'signed-out':this.testOnly?'ready':this.meta.binding===key?'ready':'binding',message:this.identityDamaged?'本机身份凭据无法核对，请联网登录原账号或核验原登录；原资料保留':this.testOnly?trainingCloudUnavailable:!this.api?'云服务尚未配置；本机训练可正常使用':!key?'请登录后选择是否绑定本机训练资料':this.meta.binding===key?'已登录，资料先存本机，再同步到当前账号':'登录成功；请确认本机资料与账号的归属',conflicts:[]});}
  async initialize(adapter:CloudAdapter){
    if(this.recoveryPaused)throw new Error('资料恢复已暂停云同步，请完成恢复后重新打开应用');
    if(this.initialized)return;if(this.initializing)return this.initializing;this.adapter=adapter;
    this.initializing=(async()=>{try{this.meta=parseMeta(await this.storage.readMeta());await this.configureClient();const deletion=typeof window!=='undefined'&&!window.Gongxingji?await deletionStore.read():null;if(deletion&&!deletion.localDone&&this.accountDeletionScope()?.owner===deletion.scope.owner&&this.accountDeletionScope()?.localService===deletion.scope.localService){await this.freezeAccountDeletion(deletion.scope);this.initialized=true;return;}if(!this.testOnly)await this.recoverSwitch();this.initialized=true;this.ready();await this.initializeDurableSave();if(teamSharingReady&&this.meta.teamSharingQueue!==undefined){try{await this.getTeamQueue().initialize();}catch(error){this.emit({message:error instanceof Error?error.message:'团队提交存储无法核对，原训练保持'});}}this.localSaved(false);if(this.teamQueue)void this.resumeTeamSharing();}catch(error){this.emit({phase:'error',message:error instanceof Error?error.message:'同步初始化失败'});throw error;}finally{this.initializing=null;}})();return this.initializing;
  }
  private configureClient(){
    const next=this.configuring.then(()=>this.configureClientNow());
    this.configuring=next.catch(()=>{});return next;
  }
  private async configureClientNow(){
    this.captureEpoch++;this.reverifyNotice++;
    this.cancelRegistrationPresentation();
    this.durableSave?.invalidate();
    this.communityEpoch++;
    this.emit({authVerified:false});
    this.api?.invalidatePendingAuth();this.api=null;
    await this.sessionPersistence.catch(()=>{});
    const config=cloudConfig(this.current());if(!config.api||!config.auth||!config.publicKey){this.api=null;return;}
    const api=this.createClient(config,session=>{
      const save=this.sessionPersistence.then(async()=>{
      if(this.api!==api)throw new Error('账号连接已变化，旧登录保存已取消');
      // Refuse adoption before any credential reaches disk: a rejected login
      // must not become a legacy owner pin on the next cold start.
      if(session&&this.storage.readLocalIdentity){
        if(!this.adapter?.selectLocalAccount&&this.localPin&&(session.owner!==this.localPin.owner||session.service!==this.localPin.service))throw new Error('此版本尚不支持多账号，请更新安装包；原资料保留');
        if(!this.localPin&&!this.adapter?.localAccount?.()&&!cloudEqual(cloudDocument(this.current()),emptyCloudDocument()))throw new Error('旧资料所属账号尚未核对，已停止绑定；请恢复原账号凭据，原资料保留');
      }
      await this.storage.writeSession(session?JSON.stringify(session):null);
      });
      this.sessionPersistence=save.catch(()=>{});return save;
    });
    const raw=await this.storage.readSession();if(raw){const session=JSON.parse(raw) as AuthSession;if(typeof session.owner!=='string'||typeof session.accessToken!=='string'||typeof session.refreshToken!=='string'||!Number.isFinite(session.expiresAt))throw new Error('登录存储无法恢复，请重新登录');api.restore(session);}
    this.api=api;
    if(this.storage.readLocalIdentity){
      const identityRaw=await this.storage.readLocalIdentity();this.identityDamaged=false;
      try{this.localIdentity=parseLocalIdentity(identityRaw);}catch{this.localIdentity=null;this.identityDamaged=true;}
      const prior=this.localIdentity??api.session;this.localPin=prior?{owner:prior.owner,service:prior.service}:null;
      // Upgrade pins the existing secure session's archive owner before another
      // login can replace it. It grants no offline rights until fresh verification.
      if(!this.identityDamaged&&!this.localIdentity&&this.localPin&&this.storage.writeLocalIdentity){
        this.localIdentity={version:1,...this.localPin,verifiedAt:0,state:'signed-out'};
        await this.storage.writeLocalIdentity(JSON.stringify(this.localIdentity));
      }
    }
  }
  async configurationChanged(){if(this.recoveryPaused)throw new Error('资料恢复已暂停云同步，请重新打开应用');if(this.operation||this.passwordRecovery)throw new Error('等待当前账号操作完成后再修改配置');await this.suspendAutomaticOwnership();await this.configureClient();this.pending=null;this.ready();}
  /** A deliberate new login/configuration requires a durable ownership pause first. */
  private async suspendAutomaticOwnership(){
    this.captureEpoch++;this.reverifyNotice++;
    if(!this.durableSave){if(automaticRecordsSaveReady||this.meta.cloudSaveQueue!==undefined)throw new Error('自动保存归属设置尚未安全打开；请处理本机存储故障后再切换或退出账号');return;}
    await this.durableSave.suspendOwnership();
  }
  private run(work:()=>Promise<void>,allowLogout=false){
    if(this.logoutPending&&!allowLogout)return Promise.reject(new Error('账号退出尚未完成，请重试退出'));
    if(this.recoveryPaused)return Promise.reject(new Error('资料恢复已暂停云同步，请完成恢复后重新打开应用'));
    if(this.passwordRecovery)return Promise.reject(new Error('请先完成或取消找回密码；训练同步已暂停'));
    if(this.operation)return Promise.reject(new Error('正在处理云账号操作，请稍候'));
    if(!this.initialized)return Promise.reject(new Error('同步尚未安全初始化，请重新打开页面'));
    if(this.timer){clearTimeout(this.timer);this.timer=null;}
    this.emit({busy:true});
    this.operation=(async()=>{try{await work();}catch(error){this.emit({phase:'error',message:error instanceof Error?error.message:'云操作失败，本机记录已保留'});throw error;}finally{this.operation=null;this.emit({busy:false});if(!this.automaticSyncPaused&&!this.passwordRecovery&&this.status.phase==='ready'&&this.status.dirty)this.localSaved();}})();return this.operation;
  }
  private client(){if(!this.api)throw new Error('云服务尚未配置');return this.api;}
  /** One explicit score-backup transfer, independent of archive binding/sync. */
  async scoreBackupRequest(method:'GET'|'PUT',document?:ScoreBackupDocument,revision?:number):Promise<ScoreBackupResponse>{
    let result:ScoreBackupResponse|undefined;
    await this.run(async()=>{
      const api=this.client(),generation=api.communityGeneration,owner=api.session?.owner;
      if(!owner)throw new Error('请先登录后使用可选成绩备份');
      result=await api.scoreBackupRequest(method,document,revision);
      if(this.api!==api||api.communityGeneration!==generation||api.session?.owner!==owner||this.logoutPending)
        throw new Error('账号已切换，成绩备份结果未采用；请重新读取核对');
      this.emit({phase:'ready',message:method==='GET'?'已读取云端成绩清单；本机资料未改变':'云端已接收所选成绩；本机资料未改变'});
    });
    if(!result)throw new Error('成绩备份未返回结果；本机成绩保持不变');
    return result;
  }
  manualBackupIdentity=():ProductionCommunityIdentity|null=>{
    if(!this.testOnly||!this.initialized||this.recoveryPaused||this.passwordRecovery||this.meta.pendingSwitch||this.logoutPending)return null;
    return this.communityIdentity();
  };
  async ensureManualBackupIdentity(){
    if(!this.testOnly)throw new Error('手动备份要求自动同步保持关闭');
    await this.ensureScoreBackupIdentity();
    const identity=this.manualBackupIdentity();if(!identity)throw new Error('备份账号或 HTTPS 服务尚未就绪');return identity;
  }
  async manualBackupRequest(method:'GET'|'PUT',identity:ProductionCommunityIdentity,document?:CloudDocument,revision?:number,signal?:AbortSignal):Promise<unknown>{
    const actor=this.channelActor();if(!actor)throw new Error('备份账号尚未核对，请重新登录');
    return this.runChannelOperation(actor,signal??new AbortController().signal,async live=>{
      const assert=()=>{const current=this.manualBackupIdentity();if(live.aborted||!this.status.authVerified||!this.status.phoneVerified||!current||!cloudEqual(current,identity))throw new Error('备份账号已变化，请重新读取核对');};
      assert();if(document!==undefined)validateCloudDocument(document);
      const result=await this.client().manualBackupRequest(method,document,revision,live);assert();return result;
    });
  }
  /** Dedicated bounded media transfer; neither bearer nor refreshed session reaches UI. */
  async privateMediaRequest(method:'GET'|'POST'|'PUT'|'PATCH',path:string,signal:AbortSignal,body?:unknown,extra:Record<string,string>={}):Promise<unknown>{
    const identity=this.status.authVerified&&this.status.phoneVerified?this.manualBackupIdentity():null;
    const actor=this.channelActor();
    if(!privateMediaSaveReady||!identity||!actor||signal.aborted||!['https://service-1.example.invalid','https://service-3.example.invalid'].includes(identity.service))throw new Error('私有媒体账号或安装包尚未验收；本机对象保留');
    const packet=validateNativePrivateMediaRequest(method,path,body,extra);
    const assert=()=>{if(!this.status.authVerified||!this.status.phoneVerified||!cloudEqual(identity,this.manualBackupIdentity()))throw new Error('媒体账号已变化，旧响应未采用');};
    return this.runChannelOperation(actor,signal,async live=>{
      assert();
      if(typeof window!=='undefined'&&window.Gongxingji){
        if(!this.mediaChannel||this.mediaChannel.isDisposed())this.mediaChannel=createNativePrivateMediaChannel({
          enabled:()=>privateMediaSaveReady&&this.status.authVerified&&this.status.phoneVerified===true,
          identity:()=>this.status.authVerified&&this.status.phoneVerified?this.manualBackupIdentity():null,
        });
        if(!this.mediaChannel.available())throw new Error('此安装包缺少已验收的媒体传输入口；本机对象保留');
        const result=await this.mediaChannel.request(method,path,live,body,extra);assert();return result;
      }
      const original=this.assertChannelActor(actor).original;
      const controller=new AbortController(),stop=()=>controller.abort(),timer=setTimeout(stop,120000);
      live.addEventListener('abort',stop,{once:true});
      try{
        if(live.aborted)throw new Error('媒体操作已取消');
        const response=await transport(mobileServiceBase(this.client().config.api)+path,{
          method:packet.method,signal:controller.signal,cache:'no-store',credentials:'omit',redirect:'error',referrerPolicy:'no-referrer',
          headers:{...packet.headers,Authorization:'Bearer '+original.session.accessToken},
          body:packet.bytes?new Blob([Uint8Array.from(body as Uint8Array).buffer]):packet.json||undefined,
        });
        assert();if(live.aborted)throw new Error('媒体操作已取消');
        if(!response.ok){await response.body?.cancel();throw new CloudHttpError(`媒体请求未完成（${response.status}）；所选对象保留本机`,response.status);}
        const binary=packet.method==='GET'&&path.endsWith('/content');
        const bytes=await readBoundedResponse(response,binary?50*1024*1024:1024*1024,controller.signal);
        assert();if(live.aborted)throw new Error('媒体操作已取消');
        if(binary){if(!bytes.length)throw new Error('媒体回读为空');return bytes;}
        return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
      }finally{clearTimeout(timer);live.removeEventListener('abort',stop);}
    });
  }
  /** Archive routes have an independent acceptance gate and share the account mutex. */
  async mediaArchiveRequest(method:'GET'|'POST',path:string,signal:AbortSignal,body?:unknown):Promise<unknown>{
    const identity=this.status.authVerified&&this.status.phoneVerified?this.manualBackupIdentity():null,actor=this.channelActor();
    if(!protectedArchiveReady||!identity||!actor||signal.aborted||!['https://service-1.example.invalid','https://service-3.example.invalid'].includes(identity.service))throw new Error('媒体归档账号或安装包尚未验收；原对象保留');
    const packet=validateNativeMediaArchiveRequest(method,path,body);
    const assert=()=>{if(!this.status.authVerified||!this.status.phoneVerified||!cloudEqual(identity,this.manualBackupIdentity()))throw new Error('归档账号已变化，旧响应未采用');};
    return this.runChannelOperation(actor,signal,async live=>{
      assert();
      if(typeof window!=='undefined'&&window.Gongxingji){
        if(!this.archiveMediaChannel||this.archiveMediaChannel.isDisposed())this.archiveMediaChannel=createNativePrivateMediaChannel({enabled:()=>protectedArchiveReady&&this.status.authVerified&&this.status.phoneVerified===true,identity:()=>this.status.authVerified&&this.status.phoneVerified?this.manualBackupIdentity():null},'media-archive');
        if(!this.archiveMediaChannel.available())throw new Error('此安装包缺少归档二进制传输入口；原对象保留');
        const result=await this.archiveMediaChannel.request(method,path,live,body);assert();return result;
      }
      const original=this.assertChannelActor(actor).original,controller=new AbortController(),stop=()=>controller.abort(),timer=setTimeout(stop,120000);
      live.addEventListener('abort',stop,{once:true});
      try{
        if(live.aborted)throw new Error('归档操作已取消');
        const response=await transport(original.serviceOrigin+path,{method:packet.method,signal:controller.signal,credentials:'omit',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer',headers:{...packet.headers,Authorization:'Bearer '+original.session.accessToken},body:packet.json||undefined});
        assert();if(live.aborted)throw new Error('归档操作已取消');
        if(!response.ok){await response.body?.cancel();throw new CloudHttpError(`归档请求未完成（${response.status}）；原对象保留`,response.status);}
        if((response.headers.get('content-type')??'').split(';',1)[0].trim().toLowerCase()!==(packet.binary?'application/zip':'application/json')){await response.body?.cancel();throw new Error('归档响应类型与路径不符');}
        const bytes=await readBoundedResponse(response,packet.binary?50*1024*1024:1024*1024,controller.signal);
        assert();if(live.aborted)throw new Error('归档操作已取消');
        if(packet.binary){if(!bytes.length)throw new Error('归档文件回读为空');return bytes;}
        return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
      }finally{clearTimeout(timer);live.removeEventListener('abort',stop);}
    });
  }
  private getArchiveMediaExporter(){
    if(!this.archiveMediaExporter||this.archiveMediaExporter.isDisposed())this.archiveMediaExporter=createNativeMediaArchiveExporter({enabled:()=>protectedArchiveReady&&this.status.authVerified&&this.status.phoneVerified===true,identity:()=>this.status.authVerified&&this.status.phoneVerified?this.manualBackupIdentity():null});
    return this.archiveMediaExporter;
  }
  mediaArchiveExportAvailable=()=>protectedArchiveReady&&this.status.authVerified&&this.status.phoneVerified===true&&!!this.manualBackupIdentity()&&this.getArchiveMediaExporter().available();
  async exportMediaArchive(name:string,bytes:Uint8Array,identity:ProductionCommunityIdentity,signal:AbortSignal=new AbortController().signal):Promise<void>{
    const actor=this.channelActor();
    if(!this.mediaArchiveExportAvailable()||!actor||!cloudEqual(identity,this.manualBackupIdentity()))throw new Error('此账号或安装包尚无已核对的归档文件保存入口；原对象保留');
    await this.runChannelOperation(actor,signal,async live=>{await this.getArchiveMediaExporter().export(name,bytes,identity,live);if(!cloudEqual(identity,this.manualBackupIdentity()))throw new Error('保存期间账号已变化，目标文件结果仍需核对');});
  }
  /** Keep account controls busy during the one confirmed durable local save. */
  async manualBackupSave(work:()=>Promise<boolean>):Promise<boolean>{
    let saved=false;
    await this.run(async()=>{
      const identity=this.manualBackupIdentity();if(!identity)throw new Error('备份账号状态已变化，请重新预览');
      saved=await work();
      if(!cloudEqual(this.manualBackupIdentity(),identity))throw new Error('保存期间账号已变化，请先核对本机恢复状态');
    });return saved;
  }
  verifySession(){return this.run(()=>this.verifyCurrentSession());}
  private async verifyCurrentSession(announceReceipt=true){
    if(this.logoutPending)throw new Error('上次退出尚未完成，请重试退出登录');
    const api=this.client(),epoch=this.identityEpoch,generation=api.communityGeneration;
    const current=()=>api===this.api&&epoch===this.identityEpoch&&generation===api.communityGeneration&&!this.logoutPending&&!this.recoveryPaused;
    this.emit({authVerified:false});
    let session:AuthSession|null;
    try{session=await api.validateSession();}
    catch(error){if(current()&&(api.sessionRejected||error instanceof CloudHttpError&&[400,401,403].includes(error.status)))await this.disableLocalAccess('revoked');throw error;}
    if(!current())throw Error('账号核验已过期，旧结果未采用');
    if(session)await this.grantLocalAccess(announceReceipt);
    if(!current())throw Error('账号核验已过期，旧结果未采用');
    this.emit({authVerified:!!session});this.ready();await this.clearCompletedEnrollment();
  }
  /** A deliberate password login rebases storage once, before authenticating.
   * It never adopts stored credentials or retries a conflicting write. */
  private async preparePasswordLogin(){
    const api=this.client(),epoch=this.identityEpoch,notice=this.reverifyNotice;
    api.invalidatePendingAuth();const generation=api.communityGeneration;
    const current=()=>this.api===api&&this.identityEpoch===epoch&&this.reverifyNotice===notice&&api.communityGeneration===generation&&!this.logoutPending&&!this.recoveryPaused;
    const check=()=>{if(!current())throw new Error('登录状态刚发生变化，请重新确认账号后登录；原资料保留');};
    await api.settleSessionWrites();check();await this.sessionPersistence.catch(()=>{});check();await this.identityWrites.catch(()=>{});check();
    const raw=await this.storage.readSession();check();
    if(raw){const saved=JSON.parse(raw) as AuthSession;if(typeof saved.owner!=='string'||typeof saved.accessToken!=='string'||typeof saved.refreshToken!=='string'||!Number.isFinite(saved.expiresAt)||saved.service!==serviceKey(api.config))throw new Error('保存的账号状态未能核对，请重新打开页面；原资料保留');}
    if(this.storage.readLocalIdentity){const rawIdentity=await this.storage.readLocalIdentity();check();parseLocalIdentity(rawIdentity);}
    // Keep the archive owner pin. Only the original password + /user checks may
    // grant identity, select that account's partition and persist through CAS.
    this.localIdentity=null;this.emit({authVerified:false});
  }
  login(email:string,password:string){this.cancelRegistrationPresentation();return this.run(async()=>{await this.suspendAutomaticOwnership();await this.preparePasswordLogin();await this.client().login(email,password);await this.grantLocalAccess();this.pending=null;this.emit({authVerified:true});this.ready();await this.clearCompletedEnrollment();});}
  loginPhone(phone:string,password:string){this.cancelRegistrationPresentation();return this.run(async()=>{await this.suspendAutomaticOwnership();await this.preparePasswordLogin();await this.client().loginPhone(phone,password);await this.grantLocalAccess();this.pending=null;this.emit({authVerified:true});this.ready();await this.clearCompletedEnrollment();});}
  registrationRewardsOwner(){const api=this.api,s=api?.session;return api&&s&&this.status.authVerified&&this.status.phoneVerified&&!this.logoutPending?{owner:s.owner,service:api.config.auth.replace(/\/$/,'')}:null;}
  async registrationRewardsCall(action:'prepare'|'read'|'status'|'complete',body:Record<string,unknown>={}){if(action==='prepare'||action==='read'){const api=this.otpClient(),generation=api.communityGeneration,owner=api.session?.owner;const result=await api.registrationRewardsCall(action,body);if(this.api!==api||api.communityGeneration!==generation||api.session?.owner!==owner||this.logoutPending)throw new Error('账号或服务已变化，邀请结果未采用');return result;}let value:unknown;await this.run(async()=>{const api=this.client();value=await api.registrationRewardsCall(action,body);if(this.api!==api||this.logoutPending)throw new Error('账号或服务已变化，邀请结果未采用');});return value;}
  enrollmentService(){return serviceKey(this.client().config);}
  cancelEmailEnrollment(){this.api?.invalidatePendingAuth();}
  /** Cancelling presentation never discards a valid session or training data. */
  cancelRegistrationPresentation(){this.registrationEpoch++;this.phoneRegistrationAttempt=null;}
  /** Cancel only a pending login; successful navigation must keep its session. */
  cancelPendingOtpLogin(){if(!this.status.authVerified)this.api?.invalidatePendingAuth();}
  private async initializeRegistrationName(api:CloudApiClient,owner:string){
    const session=api.session, adapter=this.adapter, name=session?.profileDefaultName;
    if(!session||!adapter||typeof name!=='string'||!/^打弓人\d{4}$/.test(name))return;
    const current=()=>this.api===api&&api.session?.owner===owner&&api.session?.service===session.service&&this.localAccess();
    if(!current()||adapter.read().profile.name.trim())return;
    // A deferred profile write can retry from the verified name cached in this
    // owner's session. It must never make a successful registration appear to fail.
    try{await adapter.update(data=>{if(current()&&!data.profile.name.trim())data.profile.name=name;});}catch{/* Profile screen retries a blank name. */}
  }
  private markCompletedRegistration(owner:string){try{return markRegistrationIntroPending(owner)!==false&&registrationIntroPersistence(owner)!==false;}catch{return false;}}
  private async clearCompletedEnrollment(forRegistration=false,explicitResume=false):Promise<boolean>{
    if(!emailEnrollmentReady)return false;
    const api=this.client(),owner=api.session?.owner,generation=api.communityGeneration,registrationEpoch=this.registrationEpoch;
    if(!owner||!api.session?.phoneVerified)return false;
    try{
      const storage=createEnrollmentStorage(),draft=await storage.read();
      if(!draft?.enrollment||draft.service!==serviceKey(api.config))return false;
      const result=await api.emailEnrollmentStatus('status',{email:draft.email,resume:draft.resume,enrollment:draft.enrollment});
      if(result.owner!==owner||result.enrollment!==draft.enrollment||result.state!=='complete'||!result.registrationComplete||!result.emailVerified
        ||this.api!==api||this.logoutPending||api.communityGeneration!==generation||api.session?.owner!==owner||api.session.phoneVerified!==true
        ||forRegistration&&registrationEpoch!==this.registrationEpoch)return false;
      if(forRegistration){
        const facts=api.acceptedAccountFacts;
        if(!explicitResume&&(!facts||facts.source!=='phone-binding'||facts.owner!==owner||facts.generation!==generation||!facts.phoneVerified))return false;
        if(!this.markCompletedRegistration(owner))return false;
      }
      await storage.write(null);
      if(forRegistration)await this.initializeRegistrationName(api,owner);
      return true;
    }catch{/* Retain pending progress on uncertainty; never revoke a verified login. */return false;}
  }
  /** A deliberate continuation reads the saved enrollment; it never sends or creates an account. */
  resumeCompletedRegistration(){return this.run(async()=>{
    this.cancelRegistrationPresentation();
    if(!this.status.authVerified||!this.status.phoneVerified)throw new Error('请先核对当前本人账号');
    if(!await this.clearCompletedEnrollment(true,true))throw new Error('没有可确认的首次注册完成进度；登录和训练保持，仍可在使用说明中重看介绍');
    this.ready();
  });}
  async emailEnrollmentStatus(action:'start'|'status'|'resend',body:EnrollmentRequest){let result:EnrollmentStatus|undefined;await this.run(async()=>{result=await this.client().emailEnrollmentStatus(action,body);});return result!;}
  verifyEmailEnrollment(body:EnrollmentRequest,owner:string){return this.run(async()=>{await this.suspendAutomaticOwnership();await this.client().verifyEmailEnrollment(body,owner);this.pending=null;this.emit({authVerified:true});this.ready();});}
  async emailChangeAction(action:Parameters<CloudApiClient['emailChangeAction']>[0],body:Record<string,unknown>,visible:()=>boolean){
    let result:Awaited<ReturnType<CloudApiClient['emailChangeAction']>>|undefined;
    await this.run(async()=>{const api=this.client(),owner=api.session?.owner,generation=api.communityGeneration;const current=()=>visible()&&this.api===api&&api.session?.owner===owner&&api.communityGeneration===generation&&!this.logoutPending&&this.status.authVerified;result=await api.emailChangeAction(action,body,current);if(!current())throw new Error('账号或页面已变化，旧更换结果已丢弃');});return result!;
  }
  confirmChangedEmail(email:string,visible:()=>boolean){return this.run(async()=>{const api=this.client(),owner=api.session?.owner,generation=api.communityGeneration;const current=()=>visible()&&this.api===api&&api.session?.owner===owner&&api.communityGeneration===generation&&!this.logoutPending&&this.status.authVerified;await api.confirmChangedEmail(email,current);if(!current())throw new Error('原账号身份结果未采用');this.ready();});}
  async revalidateEmailChange(visible:()=>boolean){let result:Awaited<ReturnType<CloudApiClient['emailChangeAction']>>|undefined;await this.run(async()=>{const api=this.client(),owner=api.session?.owner,generation=api.communityGeneration;const current=()=>visible()&&this.api===api&&api.session?.owner===owner&&api.communityGeneration===generation&&!this.logoutPending;await api.revalidateEmailChange(current);result=await api.emailChangeAction('status',{},current);if(!current())throw new Error('登录核验续接结果已丢弃');this.emit({authVerified:true});this.ready();});return result!;}
  async emailSecurityStatus(){let result:EmailSecurityStatus|undefined;await this.run(async()=>{result=await this.client().emailSecurityStatus();});return result!;}
  async emailBindingStatus(){let result:Awaited<ReturnType<CloudApiClient['emailBindingStatus']>>|undefined;await this.run(async()=>{const api=this.client(),owner=api.session?.owner,generation=api.communityGeneration;result=await api.emailBindingStatus();if(result.email){await api.refreshBoundEmail(result.email,owner,generation);this.ready();}});return result!;}
  async startEmailBinding(email:string){let result:Awaited<ReturnType<CloudApiClient['startEmailBinding']>>|undefined;await this.run(async()=>{result=await this.client().startEmailBinding(email);});return result!;}
  verifyEmailBinding(intent:string,email:string,token:string){return this.run(async()=>{await this.client().verifyEmailBinding(intent,email,token);this.ready();this.emit({message:'邮箱已绑定并验证；请设置邮箱登录密码'});});}
  async startEmailVerification(){let result:EmailSecurityChallenge|undefined;await this.run(async()=>{result=await this.client().startEmailVerification();this.emit({message:result.sent?'邮箱验证码已请求发送，请查看收件箱':'邮件投递未能确认；若已收到邮件仍可输入验证码，一分钟后可重试'});});return result!;}
  verifyEmailOwnership(challenge:string,token:string){return this.run(async()=>{await this.client().verifyEmailOwnership(challenge,token);this.emit({message:'邮箱已验证，之后可以使用邮件验证码找回密码'});});}
  sendOtp(kind:'phone'|'email',destination:string,createUser=false,registrationCapability?:string){
    const api=this.otpClient(),target=kind==='phone'?mainlandPhone(destination):destination.trim().toLowerCase();
    return this.requestOtp(kind,target,async()=>{
      this.cancelRegistrationPresentation();
      if(kind==='phone'&&createUser)this.phoneRegistrationAttempt={service:serviceKey(api.config),phone:target,startedAt:this.now(),api,epoch:this.registrationEpoch};
      // No global auth busy/message mutation: password login remains independent.
      return api.sendOtp(kind,target,createUser,registrationCapability);
    });
  }
  verifyOtp(kind:'phone'|'email',destination:string,code:string,expectedOwner?:string){return this.run(async()=>{
    const api=this.client(),attempt=this.phoneRegistrationAttempt;
    if(expectedOwner&&api.session?.owner!==expectedOwner)throw new Error('原账号已变化，未继续验证');
    await this.suspendAutomaticOwnership();
    await api.verifyOtp(kind,destination,code,expectedOwner);
    const session=api.session;
    const fresh=kind==='phone'&&!!attempt&&attempt.api===api&&attempt.epoch===this.registrationEpoch&&attempt.phone===destination.trim()
      &&!!session&&isFreshPhoneRegistration(api.acceptedAccountFacts,{service:serviceKey(api.config),owner:session.owner,generation:api.communityGeneration},attempt,this.now());
    this.cancelRegistrationPresentation();
    if(fresh&&session)this.markCompletedRegistration(session.owner);
    await this.grantLocalAccess();
    this.pending=null;this.emit({authVerified:true});this.ready();
    if(fresh&&session)await this.initializeRegistrationName(api,session.owner);
    await this.clearCompletedEnrollment();
  });}
  startPhoneBinding(phone:string){const api=this.otpClient(),target=mainlandPhone(phone);return this.requestOtp('phone',target,async()=>{await api.startPhoneBinding(target);return {outcome:'accepted',message:'手机绑定验证码请求已受理，请以实际收到为准。'};});}
  verifyPhoneBinding(phone:string,code:string){return this.run(async()=>{this.cancelRegistrationPresentation();await this.client().verifyPhoneBinding(phone,code);await this.grantLocalAccess();await this.clearCompletedEnrollment(true);this.emit({authVerified:true});this.ready();});}
  register(email:string,password:string){return this.run(async()=>{await this.suspendAutomaticOwnership();const session=await this.client().register(email,password);if(this.testOnly&&!session)throw new Error('邮箱注册尚未完成接入；本应用不要求邮箱验证码，请稍后重试');this.emit({authVerified:!!session});this.ready();if(!session)this.emit({message:'注册请求已发送，请检查邮箱完成确认后登录。服务不会透露邮箱是否已有账号。'});});}
  recover(email:string){
    const seconds=this.emailRecoveryRetrySeconds();
    if(seconds>0)return Promise.reject(new Error(`请 ${seconds} 秒后再发送找回邮件`));
    return this.run(async()=>{
      // A failed response may still mean the mail was sent. Keep one shared
      // cooldown across panel remounts; the server remains the durable limit.
      this.emailRecoveryRetryAt=this.now()+60000;
      await this.client().recover(email);
      this.emit({message:'找回请求已发送。如账号存在，请检查邮箱；可输入验证码或粘贴邮件中的验证链接。'});
    });
  }
  verify(email:string,code:string,type:'signup'|'recovery'){
    if(type==='signup')return this.run(async()=>{await this.suspendAutomaticOwnership();await this.client().verify(email,code,type);this.ready();});
    return this.beginPasswordRecovery(email.trim(),async client=>{
      const session=await client.verify(email,code,'recovery');
      if(session.email.trim().toLowerCase()!==email.trim().toLowerCase()||session.phoneVerified!==true)throw new Error('找回账号未能核对，请使用已验证手机');
    });
  }
  verifyPhoneRecovery(phone:string,code:string){
    return this.beginPasswordRecovery(null,async client=>{await client.verifyPhoneRecovery(phone,code);});
  }
  private beginPasswordRecovery(email:string|null,verify:(client:CloudApiClient)=>Promise<void>){
    this.cancelRegistrationPresentation();
    if(this.recoveryPaused||!this.initialized)return Promise.reject(new Error('账号功能尚未安全初始化，请重新打开页面'));
    if(this.logoutPending||this.operation||this.passwordRecovery)return Promise.reject(new Error('请先完成或取消当前账号操作'));
    const originalApi=this.client(),session=originalApi.session;
    const original=session?{api:originalApi,owner:session.owner,service:session.service,generation:originalApi.communityGeneration}:null;
    let client:CloudApiClient;try{client=this.createClient(originalApi.config,async()=>{});}catch(error){return Promise.reject(error);}
    this.durableSave?.invalidate();
    const recovery={client,previous:copy(this.status),original};this.passwordRecovery=recovery;this.automaticSyncPaused=true;
    if(this.timer){clearTimeout(this.timer);this.timer=null;}
    this.emit({busy:true,recoveryEmail:email,message:'正在验证找回码；原账号和训练资料保持不变'});
    return this.recoveryOperation=(async()=>{try{
      await verify(client);
      if(this.passwordRecovery!==recovery)throw new Error('找回流程已取消，旧验证结果已丢弃');
      if(!this.passwordRecoveryMatches(recovery))throw new Error('找回身份与当前原账号不一致，已取消；原账号和本机训练保留');
      this.emit({recoveryEmail:email,message:'验证码已核对，请设置新密码。原账号未切换，训练同步暂停。'});
    }catch(error){if(this.passwordRecovery===recovery)this.finishPasswordRecovery(error instanceof Error?error.message:'找回验证失败，请核对本次验证码');throw error;}
    finally{if(this.passwordRecovery===recovery){this.recoveryOperation=null;this.emit({busy:false});}}})();
  }
  private passwordRecoveryMatches(recovery:NonNullable<CloudSync['passwordRecovery']>){
    const pin=recovery.original,temporary=recovery.client.session;
    return !pin||!!temporary&&temporary.owner===pin.owner&&temporary.service===pin.service&&this.api===pin.api&&pin.api.session?.owner===pin.owner&&pin.api.session.service===pin.service&&pin.api.communityGeneration===pin.generation&&!this.logoutPending&&!this.recoveryPaused;
  }
  private finishPasswordRecovery(message:string){
    const recovery=this.passwordRecovery;if(!recovery)return;
    recovery.client.discardTemporarySession();this.passwordRecovery=null;this.recoveryOperation=null;this.automaticSyncPaused=true;
    this.emit({...recovery.previous,busy:false,recoveryEmail:null,message});this.localSaved(false);
  }
  cancelRecovery(){this.finishPasswordRecovery('已关闭找回流程，原账号和训练资料保留。需要同步时请点“立即同步”。');}
  updatePassword(password:string){
    const recovery=this.passwordRecovery;
    if(!recovery)return this.run(async()=>{await this.client().updatePassword(password);this.emit({message:'密码已更新，请妥善保存新密码'});});
    if(this.recoveryOperation)return Promise.reject(new Error('正在验证或更改密码，请稍候'));
    if(!recovery.client.session)return Promise.reject(new Error('请先验证找回码'));
    if(!this.passwordRecoveryMatches(recovery)){this.finishPasswordRecovery('原账号状态已变化，找回已取消；原资料保留');return Promise.reject(new Error('原账号状态已变化，未提交密码'));}
    this.emit({busy:true});
    return this.recoveryOperation=(async()=>{try{
      await recovery.client.updatePassword(password);
      if(this.passwordRecovery!==recovery)throw new Error('找回流程已关闭，请重新登录核对密码结果');
      this.finishPasswordRecovery('密码已更新。原账号和训练资料保留，请使用新密码登录需要的账号；训练尚未自动同步。');
    }catch(error){if(this.passwordRecovery===recovery){if(error instanceof PasswordOutcomeUnknownError)this.finishPasswordRecovery(error.message);else if(recovery.client.sessionRejected||error instanceof CloudHttpError&&[401,403].includes(error.status)){const expired=new RecoverySessionExpiredError();this.finishPasswordRecovery(expired.message);throw expired;}else this.emit({message:error instanceof Error?error.message:'密码更新失败，请重试'});}throw error;}
    finally{if(this.passwordRecovery===recovery){this.recoveryOperation=null;this.emit({busy:false});}}})();
  }
  accountDeletionScope=():DeletionScope|null=>{const api=this.api,s=api?.session;if(!api||!s)return null;return {owner:s.owner,service:api.config.auth.replace(/\/$/,''),apiOrigin:mobileServiceBase(api.config.api),localService:s.service};};
  isAccountDeletionFrozen=()=>this.deletionLocked;
  async prepareAccountDeletion(scope:DeletionScope){const api=this.client();if(!this.status.authVerified||this.accountDeletionScope()?.owner!==scope.owner||this.accountDeletionScope()?.localService!==scope.localService)throw new Error('账号已变化，请重新核对');return api.accountDeletionRequest('prepare',undefined,scope.owner);}
  async reauthenticateAccountDeletion(scope:DeletionScope,channel:'phone'|'email',destination:string,secret:string,kind:'password'|'otp'){
    await this.run(async()=>{const api=this.client();if(this.accountDeletionScope()?.owner!==scope.owner||this.accountDeletionScope()?.localService!==scope.localService)throw new Error('账号已变化，未重新验证');await this.preparePasswordLogin();if(kind==='password')await api.reauthenticateDeletion(channel,destination,secret,scope.owner);else await api.verifyOtp(channel,channel==='phone'?mainlandPhone(destination):destination.trim().toLowerCase(),secret,scope.owner);await this.grantLocalAccess();this.emit({authVerified:true});this.ready();});
  }
  freezeAccountDeletion(scope:DeletionScope):Promise<void>{
    const current=this.accountDeletionScope();if(current&&(current.owner!==scope.owner||current.localService!==scope.localService))return Promise.resolve();if(this.deletionFreeze)return this.deletionFreeze;
    this.deletionLocked=true;this.captureEpoch++;this.reverifyNotice++;this.logoutPending=true;this.automaticSyncPaused=true;this.channelAbort?.abort();this.durableSave?.invalidate();this.teamQueue?.identityChanged();this.api?.invalidatePendingAuth();
    this.emit({authVerified:false,message:'正在核对账号注销；原请求未明确完成前不会删除本机资料。'});
    return this.deletionFreeze=(async()=>{
      await this.durableSave?.close();await this.teamQueue?.settle();if(this.operation)await this.operation.catch(()=>{});await this.api?.settleSessionWrites();await this.persistence;await this.sessionPersistence;await this.identityWrites;
      if(current){
        if(this.storage.readLocalIdentity){const saved=parseLocalIdentity(await this.storage.readLocalIdentity());if(saved&&(saved.owner!==scope.owner||saved.service!==scope.localService))throw new Error('另一页面已切换账号，未改动其资料；请重新打开后核对原注销请求。');}
        await this.disableLocalAccess('revoked');
      }
    })().catch(error=>{this.deletionFreeze=null;throw error;});
  }
  async confirmAccountDeletion(j:DeletionJournal){const current=this.accountDeletionScope();if(!current||current.owner!==j.scope.owner||current.localService!==j.scope.localService)throw new Error('账号已变化，只能读取原注销结果');return this.client().accountDeletionRequest('confirm',{requestId:j.requestId,readbackCapability:j.readbackCapability,scopeDigest:j.scopeDigest,confirmation:'DELETE_MY_ACCOUNT'},j.scope.owner);}
  logout(){
    if(this.signingOut)return this.signingOut;
    if(this.passwordRecovery)return Promise.reject(new Error('请先完成或取消找回密码；原账号保持不变'));
    const logoutApi=this.api,logoutOwner=logoutApi?.session?.owner,logoutService=logoutApi?.session?.service;
    this.captureEpoch++;this.reverifyNotice++;this.cancelRegistrationPresentation();this.channelAbort?.abort();this.durableSave?.invalidate();this.logoutPending=true;this.communityEpoch++;
    this.api?.invalidatePendingAuth?.();
    this.emit({authVerified:false,message:'正在退出账号，请稍候；本机训练记录保留'});
    const prior=this.operation;
    this.signingOut=(async()=>{
      let markerFailed=false;
      try{await this.disableLocalAccess('signed-out');}catch{markerFailed=true;}
      try{await this.suspendAutomaticOwnership();}catch{markerFailed=true;}
      if(prior)await prior.catch(()=>{});
      await this.run(async()=>{
        let revoked:boolean;
        try{
          // This explicit logout may follow another page's same-account refresh.
          // Settle obsolete writes, then rebase once; never clear a different owner.
          await logoutApi?.settleSessionWrites?.();await this.sessionPersistence.catch(()=>{});
          if(this.api!==logoutApi)throw new Error('账号连接已变化');
          const raw=await this.storage.readSession(),stored=raw?JSON.parse(raw) as AuthSession:null;
          if(this.api!==logoutApi||stored&&(stored.owner!==logoutOwner||stored.service!==logoutService))throw new Error('另一页面已切换账号，请重新打开后核对');
          revoked=await this.client().logout();
        }catch(error){throw new Error(error instanceof Error&&error.message.includes('另一页面')?'退出尚未持久保存：另一页面已改变账号，请重新打开后核对；未清除另一账号，原训练保留。':'退出尚未持久保存，本页已停止账号操作；请处理本机存储故障并重试退出，不要关闭后假定已退出。原训练保留。');}
        this.logoutPending=false;this.pending=null;this.ready();
        if(markerFailed)this.emit({message:'已清除本机登录凭据；退出标记或自动保存暂停未能写入，请核对本机存储后再登录。原训练保留。'});
        else if(!revoked)this.emit({message:'已清除本机登录凭据；网络异常，服务端会话撤销尚未确认。本机训练记录保留。'});
      },true);
    })().finally(()=>{this.signingOut=null;});
    return this.signingOut;
  }
  /** Stop all current-page uploads before a recovery operation touches the archive. */
  async suspendForRecovery(){
    this.channelAbort?.abort();
    this.cancelRecovery();
    await this.durableSave?.suspendOwnership();this.recoveryPaused=true;if(this.timer){clearTimeout(this.timer);this.timer=null;}
    if(this.operation)await this.operation.catch(()=>{});
    if(this.api)this.api.session=null;this.pending=null;
    this.emit({phase:'signed-out',message:'资料恢复已暂停云同步，恢复后须重新登录并确认资料归属',conflicts:[],dirty:false});
  }
  getRecoveryArchiveBackups(){
    const key=this.key();if(!key)return [];
    return (this.meta.recoveryArchives??[]).flatMap(archive=>{const space=archive.spaces[key],document=space?.local??space?.base;if(!document)return [];const data=initialData();applyCloudDocument(data,document,space.local?space.activeId:null);data.updated=archive.savedAt;return [{id:archive.id+'|'+key,email:space.email,savedAt:archive.savedAt,data}];});
  }
  private async recoverSwitch(){
    const pending=this.meta.pendingSwitch;if(!pending)return;
    const current=cloudDocument(this.current());
    if(!cloudEqual(current,pending.nextDoc)){
      if(!cloudEqual(current,pending.oldDoc))throw new Error('上次账号切换中断后本机又有修改。已暂停切换和同步，资料未覆盖；请先导出本机备份。');
      if(!await this.adapter!.update(data=>{if(!cloudEqual(cloudDocument(data),pending.oldDoc))throw new Error('本机资料已变化，未切换账号');applyCloudDocument(data,pending.nextDoc,pending.nextActiveId);}))throw new Error('账号切换保存失败，本机原资料已保留');
    }
    const meta=copy(this.meta);meta.binding=pending.to;meta.pendingSwitch=null;await this.save(meta);
  }
  /** Called only after explicit first-binding/account-switch confirmation in the UI. */
  bind(){if(this.testOnly)return Promise.reject(new Error(trainingCloudUnavailable));return this.run(async()=>{
    const api=this.client(),session=api.session,key=this.key();if(!session||!key)throw new Error('请先登录');if(this.meta.binding===key){this.ready();return;}
    const meta=copy(this.meta);
    if(!meta.binding){
      const previous=meta.spaces[key];
      if(previous&&(previous.local||previous.base)&&!(meta.recoveryArchives??[]).some(archive=>cloudEqual(archive.spaces[key],previous))){meta.recoveryArchives??=[];meta.recoveryArchives.push({id:uid(),savedAt:new Date().toISOString(),spaces:{[key]:copy(previous)},pendingSwitch:null});}
      // An unbound restored archive is a fresh merge source, not a deletion set
      // relative to the earlier owner's base. Preserve that base in recovery archives.
      meta.spaces[key]={owner:session.owner,email:session.email,service:session.service,base:null,revision:0,lastSync:null,local:null,activeId:null};meta.binding=key;await this.save(meta);this.ready();return;
    }
    const oldDoc=cloudDocument(this.current()),activeId=this.current().activeId;meta.spaces[meta.binding].local=oldDoc;meta.spaces[meta.binding].activeId=activeId;
    let next=meta.spaces[key];
    if(!next){const remote=await api.request<RemoteDocument>('/api/mobile-document');if(this.key()!==key)throw new Error('登录账号已变化');const document=remoteValue(remote);next={owner:session.owner,email:session.email,service:session.service,base:document,revision:remote.revision,lastSync:null,local:document,activeId:null};meta.spaces[key]=next;}
    meta.pendingSwitch={from:meta.binding,to:key,oldDoc,nextDoc:next.local??next.base??emptyCloudDocument(),nextActiveId:next.activeId};
    await this.save(meta);await this.recoverSwitch();this.pending=null;this.ready();this.localSaved(false);
  });}
  private conflict(base:CloudDocument,local:CloudDocument,remote:CloudDocument,revision:number,owner:string,conflicts:CloudConflict[]){this.pending={base,local,remote,revision,owner};this.emit({phase:'conflict',message:`${conflicts.length} 项资料在两端同时变更，请逐项选择；尚未覆盖本机记录`,conflicts,dirty:true});}
  private mergeForDevice(base:CloudDocument,local:CloudDocument,remote:CloudDocument,resolutions:Resolutions={}){
    const merged=mergeCloudDocuments(base,local,remote,resolutions),activeId=this.current().activeId;
    const l=local.sessions.find(s=>s.id===activeId),r=remote.sessions.find(s=>s.id===activeId),b=base.sessions.find(s=>s.id===activeId),key='sessions:'+activeId;
    // An open training screen must not silently disappear or be replaced by another device.
    if(l&&!cloudEqual(l,r)&&!cloudEqual(b,r)&&!resolutions[key]&&!merged.conflicts.some(c=>c.key===key)){
      merged.conflicts.push({key,collection:'sessions',id:l.id,label:`当前训练 · ${l.name}`,local:l,remote:r??null,kind:r?'edit-edit':'edit-delete'});
      merged.document.sessions=merged.document.sessions.filter(s=>s.id!==l.id);merged.document.sessions.push(copy(l));
    }
    return merged;
  }
  sync(automatic=false){
    if(automatic)return Promise.resolve(); // Retired online/visibility callbacks cannot bypass explicit queue consent.
    if(this.testOnly)return Promise.reject(new Error(trainingCloudUnavailable));
    if(!this.passwordRecovery)this.automaticSyncPaused=false;
    return this.run(()=>this.performSync());
  }
  resolve(resolutions:Resolutions){if(this.testOnly)return Promise.reject(new Error(trainingCloudUnavailable));return this.run(async()=>{if(!this.pending)throw new Error('冲突已变化，请重新同步');const pending=this.pending;if(this.status.conflicts.some(c=>!resolutions[c.key]))throw new Error('请为每项冲突选择保留哪一端');if(!cloudEqual(cloudDocument(this.current()),pending.local)||this.key()!==pending.owner){this.pending=null;await this.performSync();return;}await this.performSync({pending,resolutions});});}
  private async performSync(choice?:{pending:Pending;resolutions:Resolutions}){
    if(this.testOnly)throw new Error(trainingCloudUnavailable);
    const api=this.client(),key=this.key();if(!key||this.meta.binding!==key)throw new Error('请先确认本机资料与当前账号的归属');this.assertIdentity(key);
    this.emit({phase:'syncing',message:'正在核对两端更新；训练仍先保存在本机',conflicts:[]});
    for(let attempt=0;attempt<3;attempt++){
      this.assertIdentity(key);const space=this.meta.spaces[key],local=cloudDocument(this.current());
      const received=await api.request<RemoteDocument>('/api/mobile-document');this.assertIdentity(key);const remote=remoteValue(received);
      let base=space.base??emptyCloudDocument(),resolutions:Resolutions={};
      if(choice&&choice.pending.revision===received.revision&&cloudEqual(choice.pending.remote,remote)&&cloudEqual(choice.pending.local,local)){base=choice.pending.base;resolutions=choice.resolutions;}else choice=undefined;
      const merged=this.mergeForDevice(base,local,remote,resolutions);
      if(merged.conflicts.length){this.conflict(base,local,remote,received.revision,key,merged.conflicts);return;}
      validateCloudDocument(merged.document);
      let committed=received;
      if(!cloudEqual(merged.document,remote)){
        try{committed=await api.request<RemoteDocument>('/api/mobile-document','PUT',{document:merged.document},received.revision);}catch(error){if(error instanceof CloudHttpError&&error.status===409){choice=undefined;continue;}throw error;}
      }
      this.assertIdentity(key);const savedRemote=remoteValue(committed),latest=cloudDocument(this.current());
      // Include edits made while the network request was in flight.
      const final=this.mergeForDevice(local,latest,savedRemote,cloudEqual(latest,local)?resolutions:{});
      if(final.conflicts.length){this.conflict(local,latest,savedRemote,committed.revision,key,final.conflicts);return;}
      validateCloudDocument(final.document);
      if(!cloudEqual(latest,final.document)){
        const saved=await this.adapter!.update(data=>{this.assertIdentity(key);if(!cloudEqual(cloudDocument(data),latest))throw new Error('同步期间本机又有修改，请再次同步；新输入已保留');applyCloudDocument(data,final.document);});
        if(!saved)throw new Error('云端已接收更新，但本机合并保存未完成；请重试，未宣称同步完成');
      }
      const meta=copy(this.meta);meta.spaces[key].base=savedRemote;meta.spaces[key].revision=committed.revision;meta.spaces[key].lastSync=new Date().toISOString();meta.spaces[key].local=null;await this.save(meta);
      this.pending=null;const dirty=!cloudEqual(cloudDocument(this.current()),savedRemote);
      this.emit({phase:'ready',message:dirty?'本机有刚录入的更新，等待下一次同步':'两端资料已同步',dirty,conflicts:[]});return;
    }
    throw new Error('其他设备持续更新，暂缓自动合并；本机记录已保留，请稍后同步');
  }
  /** Hook after the repository confirms a durable local save, never before it. */
  localSaved(auto=true){
    if(teamSharingReady&&this.teamQueue)void this.teamQueue.enqueue().then(()=>auto?this.teamQueue?.flush():undefined).catch(error=>this.emit({message:error instanceof Error?error.message:'团队提交队列未保存；原训练保持'}));
    if(this.durableSave)void this.durableSave.localSaved().catch(error=>this.emit({message:error instanceof Error?error.message:'耐久云队列未保存；本机记录保持'}));
    if(this.testOnly)return;
    if(this.recoveryPaused||!this.initialized||!this.adapter)return;const key=this.key(),space=key&&this.meta.binding===key?this.meta.spaces[key]:null;
    const dirty=!!space&&!cloudEqual(cloudDocument(this.current()),space.base??emptyCloudDocument());this.emit({dirty});
    if(auto&&!this.passwordRecovery)this.automaticSyncPaused=false;
    if(!auto||this.automaticSyncPaused||this.passwordRecovery||!dirty||this.operation||this.status.phase!=='ready')return;
    // Retired legacy timer: only the consented durable queue may schedule uploads.
  }
}
export const cloudSync=new CloudSync();

/** Independent of Repository.load: call and await this before native/browser
 * archive recovery. A failed validation, credential clear or CAS blocks recovery. */
export async function pauseCloudForRecovery(storage:CloudStorage=cloudStorage,coordinator:CloudSync=cloudSync){
  await coordinator.suspendForRecovery();
  const meta=parseMeta(await storage.readMeta());
  if(Object.keys(meta.spaces).length||meta.pendingSwitch){meta.recoveryArchives??=[];meta.recoveryArchives.push({id:uid(),savedAt:new Date().toISOString(),spaces:copy(meta.spaces),pendingSwitch:copy(meta.pendingSwitch)});}
  meta.binding=null;meta.pendingSwitch=null;
  // Clear credentials first. If the CAS then fails, no stale persistent session
  // can silently reconnect after reopening the recovery screen.
  await storage.readSession();await storage.writeSession(null);await storage.writeMeta(JSON.stringify(meta));
  return {archivedAccounts:Object.keys(meta.spaces).length};
}
