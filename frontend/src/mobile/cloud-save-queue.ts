export type SaveIdentity={owner:string;service:string;sessionKey:string;generation:number};
export type CloudSavePhase='off'|'local'|'pending'|'saving'|'verified'|'conflict'|'auth-required'|'capacity'|'retry-exhausted'|'unknown'|'error';
export type CloudSaveStatus={phase:CloudSavePhase;message:string;enabled:boolean;owner:string|null;lastConfirmed:string|null;attempts:number;nextAt:number|null;conflicts:{key:string;label:string;local:unknown;remote:unknown}[];discovery:'idle'|'checking'|'available'|'empty'|'error';discoveryMessage:string;remoteAvailable:boolean|null};
export type SaveRemote<D>={revision:number;document:D|null;updatedAt:string|null};
export type SaveMerge<D>={document:D;conflicts:{key:string;label:string;local:unknown;remote:unknown}[]};
export interface SaveQueueStore {read():Promise<string|null>;write(value:string):Promise<void>}
export interface SaveQueueAdapter<D> {
  identity():SaveIdentity|null; readLocal():D; hasPendingLocal():boolean;
  empty():D; validate(value:unknown):D; equal(a:unknown,b:unknown):boolean;
  merge(base:D,local:D,remote:D,resolutions?:Record<string,'local'|'remote'>):SaveMerge<D>;
  apply(document:D,expected:D,identity:SaveIdentity):Promise<boolean>;
  request(method:'GET'|'PUT',identity:SaveIdentity,signal:AbortSignal,document?:D,revision?:number):Promise<unknown>;
  fits(document:D):void;
}
type Consent={version:'records-save/v1';scope:'complete-records';acceptedAt:string;ownershipConfirmed:true;enabled:boolean};
type Job<D>={serial:number;document:D;attempts:number;nextAt:number;blocked:CloudSavePhase|null;verification?:{sent:D;localAtSend:D;expectedRevision:number;priorRevision:number};resolutions?:Record<string,'local'|'remote'>};
type Conflict<D>={base:D;local:D;remote:D;revision:number;items:SaveMerge<D>['conflicts']};
type Space<D>={owner:string;service:string;consent:Consent|null;base:D|null;revision:number;confirmedAt:string|null;pending:Job<D>|null;conflict:Conflict<D>|null};
type State<D>={version:1;serial:number;binding:string|null;spaces:Record<string,Space<D>>;writeId?:string};
const clone=<T,>(value:T):T=>JSON.parse(JSON.stringify(value));
const keyOf=(i:Pick<SaveIdentity,'service'|'owner'>)=>i.service+'|'+i.owner;
const same=(a:SaveIdentity|null,b:SaveIdentity)=>!!a&&keyOf(a)===keyOf(b)&&a.sessionKey===b.sessionKey&&a.generation===b.generation;
const initial=<D,>():State<D>=>({version:1,serial:0,binding:null,spaces:{}});
class UnknownSave extends Error {constructor(){super('上次上传结果尚未确认；仅重新读取核对，不会重复上传。本机记录与待核对内容保留。');}}
/** Local saves are durable before enqueue. Discovery reads never grant saving consent. */
export class DurableCloudSave<D> {
  private state=initial<D>();private loaded=false;private closed=false;private paused=false;private epoch=0;private storageFailed=false;
  private timer:ReturnType<typeof setTimeout>|null=null;private active:AbortController|null=null;
  private flight:Promise<void>|null=null;private discoveryFlight:Promise<void>|null=null;private discoveryKey:string|null=null;private serial:Promise<unknown>=Promise.resolve();
  private listeners=new Set<()=>void>();
  private discovery:CloudSaveStatus['discovery']='idle';private discoveryMessage='';private remoteAvailable:boolean|null=null;
  private online=()=>{void this.resume().catch(e=>this.emit('error',this.message(e)));};
  private pageHide=()=>{this.invalidate();this.closed=true;this.emit('local','页面已关闭或进入后台；本机与耐久任务保留');};
  private pageShow=()=>{this.closed=false;this.identityChanged();};
  private visibility=()=>{if(document.visibilityState==='visible')this.online();};
  private status:CloudSaveStatus={phase:'off',message:'本机已保存；自动云保存默认关闭',enabled:false,owner:null,lastConfirmed:null,attempts:0,nextAt:null,conflicts:[],discovery:'idle',discoveryMessage:'',remoteAvailable:null};
  constructor(private store:SaveQueueStore,private adapter:SaveQueueAdapter<D>,private options:{now?:()=>number;debounceMs?:number;maxAttempts?:number;autoSchedule?:boolean;discoverOnIdentity?:boolean;pollMs?:number}={}){}
  getStatus=()=>this.status;
  subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
  private now(){return this.options.now?.()??Date.now();}
  private message(e:unknown){return e instanceof Error?e.message:'云保存未完成；本机与耐久任务保留';}
  private locked<T>(work:()=>Promise<T>){const next=this.serial.then(work);this.serial=next.catch(()=>{});return next;}
  private current(){const i=this.adapter.identity();return i?this.state.spaces[keyOf(i)]??null:null;}
  private enabled(){const i=this.adapter.identity();return !this.paused&&!this.storageFailed&&!!i&&this.state.binding===keyOf(i)&&!!this.current()?.consent?.enabled;}
  private isConfirmed(s:Space<D>|null,document?:D){return !!s&&typeof s.confirmedAt==='string'&&Number.isFinite(Date.parse(s.confirmedAt))&&s.base!==null&&this.adapter.equal(s.base,document??this.adapter.readLocal());}
  private emit(phase:CloudSavePhase,message:string){const s=this.current(),i=this.adapter.identity();this.status={phase,message,enabled:this.enabled(),owner:i?.owner??null,lastConfirmed:s?.confirmedAt??null,attempts:s?.pending?.attempts??0,nextAt:s?.pending?.nextAt??null,conflicts:s?.conflict?.items??[],discovery:this.discovery,discoveryMessage:this.discoveryMessage,remoteAvailable:this.remoteAvailable};this.listeners.forEach(l=>l());}
  private async change(work:(state:State<D>)=>void,guard?:()=>void){return this.locked(async()=>{
    guard?.();const next=clone(this.state);work(next);
    // Different tabs must never create byte-identical metadata acknowledgements.
    next.writeId=typeof crypto.randomUUID==='function'?crypto.randomUUID():Array.from(crypto.getRandomValues(new Uint8Array(16)),n=>n.toString(16).padStart(2,'0')).join('');
    try{await this.store.write(JSON.stringify(next));}catch(error){this.storageFailed=true;this.paused=true;this.invalidate();this.emit('error',this.message(error));throw error;}
    this.state=next;guard?.();
  });}
  private validateState(raw:string):State<D>{
    const v=JSON.parse(raw) as State<D>;
    if(!v||v.version!==1||!Number.isSafeInteger(v.serial)||v.serial<0||!v.spaces||typeof v.spaces!=='object'||Array.isArray(v.spaces)||(v.writeId!==undefined&&(typeof v.writeId!=='string'||v.writeId.length>100)))throw new Error('云队列格式无效；原资料保留，自动上传已停止');
    for(const [key,s] of Object.entries(v.spaces)){
      if(!s||key!==keyOf(s)||!/^[A-Za-z0-9_-]{1,128}$/.test(s.owner)||new URL(s.service).protocol!=='https:'||!Number.isSafeInteger(s.revision)||s.revision<0)throw new Error('云队列归属或版本无效');
      if(s.consent&&(s.consent.version!=='records-save/v1'||s.consent.scope!=='complete-records'||s.consent.ownershipConfirmed!==true||typeof s.consent.enabled!=='boolean'||!Number.isFinite(Date.parse(s.consent.acceptedAt))))throw new Error('云保存同意记录无效');
      if(s.base!==null)s.base=this.adapter.validate(s.base);
      if(s.pending){const j=s.pending;if(!Number.isSafeInteger(j.serial)||j.serial<1||!Number.isInteger(j.attempts)||j.attempts<0||!Number.isFinite(j.nextAt)||!['off','local','pending','saving','verified','conflict','auth-required','capacity','retry-exhausted','unknown','error',null].includes(j.blocked))throw new Error('待保存任务无效');j.document=this.adapter.validate(j.document);if(j.verification){j.verification.sent=this.adapter.validate(j.verification.sent);j.verification.localAtSend=this.adapter.validate(j.verification.localAtSend);if(!Number.isSafeInteger(j.verification.priorRevision)||j.verification.priorRevision<0||j.verification.expectedRevision!==j.verification.priorRevision+1)throw new Error('云回读任务版本无效');}}
      if(s.conflict){s.conflict.base=this.adapter.validate(s.conflict.base);s.conflict.local=this.adapter.validate(s.conflict.local);s.conflict.remote=this.adapter.validate(s.conflict.remote);if(!Number.isSafeInteger(s.conflict.revision)||s.conflict.revision<0||!Array.isArray(s.conflict.items))throw new Error('云冲突记录无效');}
    }
    if(v.binding!==null&&(typeof v.binding!=='string'||!v.spaces[v.binding]))throw new Error('本机资料归属记录无效');return v;
  }
  async initialize(){if(this.loaded)return;const raw=await this.store.read();this.state=raw===null?initial<D>():this.validateState(raw);this.loaded=true;this.closed=false;if(typeof window!=='undefined'){window.addEventListener('online',this.online);window.addEventListener('pagehide',this.pageHide);window.addEventListener('pageshow',this.pageShow);window.addEventListener('gongxingji-background',this.pageHide);window.addEventListener('gongxingji-foreground',this.pageShow);if(typeof document!=='undefined')document.addEventListener('visibilitychange',this.visibility);}this.identityChanged();}
  private assertIdentity(i:SaveIdentity,epoch:number){if(this.closed||epoch!==this.epoch||!same(this.adapter.identity(),i))throw new Error('账号或操作已变化；旧结果未采用');}
  private assert(i:SaveIdentity,epoch:number){this.assertIdentity(i,epoch);if(!this.enabled())throw new Error('账号或保存同意已变化；旧结果未采用');}
  async enable(input:{ownershipConfirmed:true;saveConsent:true;scope:'complete-records'}){
    if(!this.loaded||this.closed||this.storageFailed)throw new Error('云队列尚未安全打开，请重新打开应用');const i=this.adapter.identity(),epoch=this.epoch;
    if(!i||new URL(i.service).protocol!=='https:'||input.ownershipConfirmed!==true||input.saveConsent!==true||input.scope!=='complete-records')throw new Error('请先登录并明确确认资料归属与保存用途');
    const guard=()=>this.assertIdentity(i,epoch);
    await this.change(state=>{const k=keyOf(i),s=state.spaces[k]??{owner:i.owner,service:i.service,base:null,revision:0,confirmedAt:null,pending:null,conflict:null,consent:null};s.consent={version:'records-save/v1',scope:'complete-records',acceptedAt:new Date(this.now()).toISOString(),ownershipConfirmed:true,enabled:true};state.spaces[k]=s;state.binding=k;},guard);
    guard();this.paused=false;await this.enqueue();if(!this.current()?.pending)await this.enqueue(true);
  }
  async disable(){this.paused=true;this.invalidate();const i=this.adapter.identity();try{if(i)await this.change(state=>{const s=state.spaces[keyOf(i)];if(s?.consent)s.consent.enabled=false;});}catch{this.emit('off','本页面已停止上传，但关闭设置未保存；重开可能恢复旧同意，请先处理存储故障');throw new Error('本页面已停止上传，但关闭设置未保存；重开可能恢复旧同意，请先处理存储故障');}this.emit('off','自动云保存已关闭；本机、待保存任务和云端资料保留');}
  invalidate(){this.epoch++;this.active?.abort();this.active=null;if(this.timer)clearTimeout(this.timer);this.timer=null;}
  identityChanged(){
    this.invalidate();this.discovery='idle';this.discoveryMessage='';this.remoteAvailable=null;const s=this.current(),i=this.adapter.identity();
    if(i&&this.state.binding!==null&&this.state.binding!==keyOf(i)){void this.suspendOwnership().catch(e=>this.emit('error',this.message(e)));this.emit('off','账号归属已变化；自动保存暂停，须重新确认本机资料归属与保存同意');return;}
    if(this.storageFailed){this.emit('error','同步存储已变化，请关闭旧页面后重新打开；本机资料保留');return;}
    const phase=s?.pending?.blocked??(s?.conflict?'conflict':s?.pending?'pending':this.isConfirmed(s)?'verified':'local');
    this.emit(this.enabled()?phase:'off',this.enabled()?phase==='verified'?'上次云端回读已确认':'本机资料保留，等待核对云端更新':'本机已保存；此账号自动云保存未开启');
    // A task boundary lets the authentication mutex release before any read.
    if(this.options.autoSchedule!==false&&i){this.timer=setTimeout(()=>{this.timer=null;this.online();},0);(this.timer as unknown as {unref?:()=>void}).unref?.();}
    else if(this.enabled()&&!s?.pending&&!this.isConfirmed(s))void this.localSaved().catch(e=>this.emit('error',this.message(e)));
  }
  /** A bounded GET, including for a newly signed-in account. No document is exposed in status/logs. */
  async discover():Promise<void>{
    if(this.discoveryFlight){if(this.discoveryKey===JSON.stringify(this.adapter.identity()))return this.discoveryFlight;await this.discoveryFlight;return this.discover();}if(this.flight)return;
    const i=this.adapter.identity(),epoch=this.epoch;if(!this.loaded||this.closed||this.storageFailed||!i||typeof navigator!=='undefined'&&navigator.onLine===false)return;
    this.discoveryKey=JSON.stringify(i);const controller=new AbortController();this.active=controller;this.discovery='checking';this.discoveryMessage='正在查找此账号的云备份';this.emit(this.status.phase,this.status.message);
    this.discoveryFlight=(async()=>{try{const remote=this.remote(await this.adapter.request('GET',i,controller.signal));this.assertIdentity(i,epoch);this.remoteAvailable=remote.document!==null;this.discovery=remote.document?'available':'empty';this.discoveryMessage=remote.document?'发现此账号已有云备份；确认后可恢复并开启自动保存':'此账号尚无完整云备份；本机资料保持';}catch(e){if(epoch!==this.epoch||!same(this.adapter.identity(),i)||this.closed)return;this.discovery='error';this.remoteAvailable=null;this.discoveryMessage='云备份暂未查明；本机资料保持，可稍后重新查找';}finally{if(this.active===controller)this.active=null;if(epoch===this.epoch)this.emit(this.status.phase,this.status.message);}})().finally(()=>{this.discoveryFlight=null;this.schedule();});return this.discoveryFlight;
  }
  private async enqueue(force=false){
    if(!this.loaded||this.closed||!this.enabled()||this.adapter.hasPendingLocal())return;const i=this.adapter.identity()!,epoch=this.epoch,document=this.adapter.validate(this.adapter.readLocal()),guard=()=>this.assert(i,epoch);
    const old=this.current();if(old?.pending&&this.adapter.equal(old.pending.document,document)){if(force&&!old.pending.blocked&&!old.conflict)await this.change(state=>{state.spaces[keyOf(i)].pending!.nextAt=this.now();},guard);this.schedule();return;}
    if(!force&&!old?.pending&&this.isConfirmed(old,document))return;
    await this.change(state=>{const s=state.spaces[keyOf(i)],verify=s.pending?.verification,blocked=verify?'unknown':s.pending?.blocked==='auth-required'?'auth-required':null;s.pending={serial:++state.serial,document:clone(document),attempts:0,nextAt:this.now()+(force?0:this.options.debounceMs??2000),blocked,...(verify?{verification:verify}:{})};if(!verify)s.conflict=null;},guard);
    this.emit(this.current()?.pending?.blocked??'pending','本机已保存，等待云端核对');this.schedule();
  }
  async localSaved(){return this.enqueue();}
  private schedule(){
    if(this.paused||this.storageFailed||this.options.autoSchedule===false||this.closed||this.flight||this.discoveryFlight||typeof navigator!=='undefined'&&navigator.onLine===false)return;
    if(this.timer)clearTimeout(this.timer);this.timer=null;if(!this.enabled())return;const s=this.current()!;if(s.pending?.blocked||s.conflict)return;
    const delay=s.pending?Math.max(0,s.pending.nextAt-this.now()):Math.max(30000,this.options.pollMs??60000);
    this.timer=setTimeout(()=>{this.timer=null;if(typeof document!=='undefined'&&document.visibilityState==='hidden'){this.schedule();return;}void (s.pending?this.flush():this.resume()).catch(e=>this.emit('error',this.message(e)));},delay);(this.timer as unknown as {unref?:()=>void}).unref?.();
  }
  async resume(){if(this.closed||this.storageFailed||!this.adapter.identity()||typeof navigator!=='undefined'&&navigator.onLine===false)return;if(this.enabled()){if(this.current()?.pending?.blocked||this.current()?.conflict)return;await this.enqueue(true);return this.flush();}if(this.options.discoverOnIdentity)return this.discover();}
  async retry(){if(this.paused||this.closed||this.storageFailed)throw new Error('自动云保存已暂停，请先重新确认开启');if(!this.enabled())throw new Error('请先核对登录与保存同意');await this.enqueue(true);const i=this.adapter.identity()!,epoch=this.epoch;await this.change(state=>{const p=state.spaces[keyOf(i)].pending;if(p){p.attempts=0;p.blocked=null;p.nextAt=this.now();}},()=>this.assert(i,epoch));this.emit('pending','已保留本机资料，重新读取云端核对');return this.flush();}
  async resolve(resolutions:Record<string,'local'|'remote'>){if(this.paused||this.closed||this.storageFailed)throw new Error('自动云保存已暂停，请先重新确认开启');const i=this.adapter.identity(),s=this.current(),epoch=this.epoch;if(!i||!s?.conflict||!s.pending)throw new Error('请先重新读取冲突');if(s.conflict.items.some(c=>!['local','remote'].includes(resolutions[c.key])))throw new Error('请为每项冲突明确选择');if(!this.adapter.equal(this.adapter.readLocal(),s.conflict.local)){await this.localSaved();throw new Error('核对期间本机又有修改，请重新查看冲突');}await this.change(state=>{const v=state.spaces[keyOf(i)];v.pending!.resolutions=clone(resolutions);v.pending!.blocked=null;v.pending!.nextAt=this.now();},()=>this.assert(i,epoch));return this.flush();}
  private remote(raw:unknown):SaveRemote<D>{if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('云端响应格式无效');const r=raw as SaveRemote<D>;if(Object.keys(r).sort().join()!==['revision','document','updatedAt'].sort().join()||!Number.isSafeInteger(r.revision)||r.revision<0||(r.revision===0)!==(r.document===null)||(r.revision===0?r.updatedAt!==null:typeof r.updatedAt!=='string'||!Number.isFinite(Date.parse(r.updatedAt))))throw new Error('云端版本或日期无效');return {...r,document:r.document===null?null:this.adapter.validate(r.document)};}
  private async conflict(i:SaveIdentity,epoch:number,base:D,local:D,remote:D,revision:number,items:SaveMerge<D>['conflicts']){await this.change(state=>{const s=state.spaces[keyOf(i)];s.conflict={base:clone(base),local:clone(local),remote:clone(remote),revision,items:clone(items)};if(s.pending)s.pending.blocked='conflict';},()=>this.assert(i,epoch));this.emit('conflict','两端同时更改，请逐项核对；本机记录未覆盖');}
  async flush(){if(this.flight)return this.flight;const discovery=this.discoveryFlight;this.flight=(async()=>{if(discovery)await discovery;await this.perform();})().finally(()=>{this.flight=null;this.schedule();});return this.flight;}
  private async perform(){
    const i=this.adapter.identity(),s=this.current();if(!this.loaded||this.closed||!this.enabled()||!i||!s?.pending||s.pending.blocked||this.adapter.hasPendingLocal()||typeof navigator!=='undefined'&&navigator.onLine===false)return;
    if(s.pending.nextAt>this.now())return;const epoch=this.epoch,controller=new AbortController(),guard=()=>this.assert(i,epoch);this.active=controller;this.emit('saving','本机已保存，正在读取云端版本');
    try{
      // Claim through the actual metadata CAS before any network or local apply.
      await this.change(()=>{},guard);let remote=this.remote(await this.adapter.request('GET',i,controller.signal));guard();
      if(remote.revision<this.state.spaces[keyOf(i)].revision)throw new Error('云端版本低于此前确认记录，已停止恢复与上传；本机资料保持');
      const job=this.state.spaces[keyOf(i)].pending!;
      if(job.verification){if(remote.revision===job.verification.expectedRevision&&this.adapter.equal(remote.document,job.verification.sent)){await this.confirm(i,epoch,remote,job.verification.localAtSend,job.resolutions);return;}throw new UnknownSave();}
      const local=this.adapter.validate(this.adapter.readLocal()),remoteDoc=remote.document??this.adapter.empty(),base=this.state.spaces[keyOf(i)].base??this.adapter.empty();
      const c=this.state.spaces[keyOf(i)].conflict,choices=c&&c.revision===remote.revision&&this.adapter.equal(c.remote,remoteDoc)&&this.adapter.equal(c.local,local)?job.resolutions:undefined;
      // Missing local contents are not evidence of deliberate deletion after a reset.
      const emptyKey='recovery:empty-local',emptyLocal=this.adapter.equal(local,this.adapter.empty()),lostLocal=this.state.spaces[keyOf(i)].base!==null&&emptyLocal&&!this.adapter.equal(base,this.adapter.empty())&&!this.adapter.equal(remoteDoc,this.adapter.empty());
      if(lostLocal&&!choices?.[emptyKey]){await this.conflict(i,epoch,base,local,remoteDoc,remote.revision,[{key:emptyKey,label:'本机为空，云端已有记录：请选择恢复云端或明确保留空本机',local:null,remote:'已有完整云备份'}]);return;}
      const merged=lostLocal&&choices?.[emptyKey]?{document:choices[emptyKey]==='remote'?remoteDoc:local,conflicts:[]}:this.adapter.merge(base,local,remoteDoc,choices);
      if(merged.conflicts.length){await this.conflict(i,epoch,base,local,remoteDoc,remote.revision,merged.conflicts);return;}
      this.adapter.validate(merged.document);this.adapter.fits(merged.document);
      if(this.adapter.equal(merged.document,remoteDoc)){await this.confirm(i,epoch,remote,local,choices);return;}
      await this.change(state=>{const v=state.spaces[keyOf(i)];v.pending!.verification={sent:clone(merged.document),localAtSend:clone(local),priorRevision:remote.revision,expectedRevision:remote.revision+1};},guard);
      let putError:unknown=null;
      try{const received=this.remote(await this.adapter.request('PUT',i,controller.signal,merged.document,remote.revision));if(received.revision!==remote.revision+1||!this.adapter.equal(received.document,merged.document))putError=new UnknownSave();}catch(e){putError=e;}
      guard();const status=putError&&typeof putError==='object'&&'status' in putError?Number(putError.status):0;
      if([400,401,403,404,409,413,422,429].includes(status)){await this.change(state=>{delete state.spaces[keyOf(i)].pending!.verification;},guard);throw putError;}
      remote=this.remote(await this.adapter.request('GET',i,controller.signal));guard();const expected=this.state.spaces[keyOf(i)].pending?.verification;
      if(!expected||remote.revision!==expected.expectedRevision||!this.adapter.equal(remote.document,expected.sent))throw new UnknownSave();
      await this.confirm(i,epoch,remote,expected.localAtSend,choices);
    }catch(e){
      if(this.storageFailed||epoch!==this.epoch||this.closed||!same(this.adapter.identity(),i))return;
      const status=e&&typeof e==='object'&&'status' in e?Number(e.status):0;
      await this.change(state=>{const p=state.spaces[keyOf(i)].pending;if(!p)return;p.attempts++;p.blocked=e instanceof UnknownSave||p.verification?'unknown':[401,403].includes(status)?'auth-required':status===413?'capacity':p.attempts>=(this.options.maxAttempts??5)?'retry-exhausted':null;p.nextAt=this.now()+Math.min(60000,1000*2**Math.min(p.attempts-1,6));},guard);
      const phase=this.current()?.pending?.blocked??'pending';this.emit(phase,phase==='unknown'?new UnknownSave().message:status===401||status===403?'登录需重新核对；本机与待保存任务保留':status===413?'超出在线容量；请保留本机资料并导出文件':this.message(e));
    }finally{if(this.active===controller)this.active=null;}
  }
  private async confirm(i:SaveIdentity,epoch:number,remote:SaveRemote<D>,localAtSend:D,resolutions?:Record<string,'local'|'remote'>){
    const guard=()=>this.assert(i,epoch);guard();const received=remote.document??this.adapter.empty(),latest=this.adapter.validate(this.adapter.readLocal());
    // Apply an explicit conflict choice only while its exact local snapshot remains current.
    const final=this.adapter.equal(latest,localAtSend)?{document:received,conflicts:[]}:this.adapter.merge(localAtSend,latest,received);
    if(final.conflicts.length){await this.conflict(i,epoch,localAtSend,latest,received,remote.revision,final.conflicts);return;}
    if(!this.adapter.equal(latest,final.document)){guard();if(!await this.adapter.apply(final.document,latest,i))throw new Error('云端已确认，但本机合并未保存；现有本机资料保留');guard();}
    const newest=this.adapter.validate(this.adapter.readLocal());
    await this.change(state=>{const s=state.spaces[keyOf(i)];s.base=clone(received);s.revision=remote.revision;s.confirmedAt=new Date(this.now()).toISOString();s.conflict=null;s.pending=this.adapter.equal(newest,received)?null:{serial:++state.serial,document:clone(newest),attempts:0,nextAt:this.now()+(this.options.debounceMs??2000),blocked:null};},guard);
    this.remoteAvailable=remote.document!==null;this.discovery=remote.document?'available':'empty';this.emit(this.current()?.pending?'pending':'verified',this.current()?.pending?'已回读确认前次保存；新输入仍在本机并等待云保存':'云端已回读确认，本机保存保持');
  }
  async suspendOwnership(){this.paused=true;this.invalidate();try{await this.change(state=>{state.binding=null;});}catch{this.emit('off','本页面已暂停归属，但设置未保存；重开可能恢复旧同意，请先处理存储故障');throw new Error('本页面已暂停归属，但设置未保存；重开可能恢复旧同意，请先处理存储故障');}this.emit('off','本机归属已暂停；恢复后须重新确认归属与云保存同意');}
  async close(){if(typeof window!=='undefined'){window.removeEventListener('online',this.online);window.removeEventListener('pagehide',this.pageHide);window.removeEventListener('pageshow',this.pageShow);window.removeEventListener('gongxingji-background',this.pageHide);window.removeEventListener('gongxingji-foreground',this.pageShow);if(typeof document!=='undefined')document.removeEventListener('visibilitychange',this.visibility);}this.invalidate();this.closed=true;if(this.flight)await this.flight;if(this.discoveryFlight)await this.discoveryFlight;this.emit('local','云保存已暂停；本机与耐久任务保留，重开后核对');}
}
