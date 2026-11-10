import {diagnoseContributionRequests,type ContributionDiagnostic} from './photo-contribution-diagnostic';
import {uid} from './domain';
import type {ChoiceState,Policy,Manifest,SampleReceipt,SampleReadback} from './photo-contribution-contract';
import {contributionConflictReason,contributionConflictMessages,canonical,parseChoice,parsePolicy,parseReceipt,parseRequest,parseReadback,parseReadbackExpectation,validateContributionRequest,sha256,type ContributionTransport} from './photo-contribution-api';
import {scopeKey,type ContributionIdentity,type ContributionStore,type ContributionScope,type QueuedSample} from './photo-contribution-store';
export type CapturePermit={identity:ContributionIdentity;epoch:string;revision:number;serial:number;captureKey:string;policy:string};
type NetworkSignal='offline'|'available'|'unknown';
const networkSignal=():NetworkSignal=>typeof navigator==='undefined'||typeof navigator.onLine!=='boolean'?'unknown':navigator.onLine?'available':'offline';
type View={diagnostics:ContributionDiagnostic[];diagnosticChecking:boolean;diagnosticMessage:string;network:NetworkSignal;sendable:number;unconfirmed:number;verification:'idle'|'checking'|'failed'|'ready';policy:Policy|null;choice:ChoiceState|null;busy:boolean;stopped:boolean;pending:boolean;queued:number;message:string;loginRunning:boolean;receipt:SampleReadback|null;receiptMessage:string;receiptChecking:boolean;receiptImageStatus:'verified'|'unknown'|null;receiptImageMessage:string};
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const id=()=>uid();
/** No credential, image, account field or error detail is logged by this controller. */
export class PhotoContributionController{
 private view:View={diagnostics:[],diagnosticChecking:false,diagnosticMessage:'',network:networkSignal(),sendable:0,unconfirmed:0,verification:'idle',policy:null,choice:null,busy:false,stopped:true,pending:false,queued:0,message:'',loginRunning:false,receipt:null,receiptMessage:'',receiptChecking:false,receiptImageStatus:null,receiptImageMessage:''};
 private listeners=new Set<()=>void>();private identityKey='';private serial=0;private abort=new AbortController();private loadedKey='';private busy=false;private operations=0;private loginTicket=0;private drainRequested=false;private withdrawalQueued=false;private localStopped=new Set<string>();
 private automaticKey:string|undefined;private retrying=false;private holdAutomaticDrain=false;
 private captureSerial=0;private captureIdentityKey='';private captureChoiceKey='';private capturePolicyKey='';
 private diagnosticIdentity:ContributionIdentity|null=null;private diagnosticSerial=-1;private diagnosticGeneration=0;private holdDiagnosticDrain=false;
 private receiptIdentity:ContributionIdentity|null=null;private receiptSerial=-1;private receiptGeneration=0;
 constructor(readonly transport:ContributionTransport,readonly store:ContributionStore){}
 subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>this.listeners.delete(listener);};getSnapshot=()=>this.view;
 /** UI checks the current identity synchronously, before coordinator effects can run. */
 getReceiptView=()=>this.receiptSerial===this.serial&&same(this.receiptIdentity,this.transport.identity())?{receipt:this.view.receipt, message:this.view.receiptMessage,checking:this.view.receiptChecking,imageStatus:this.view.receiptImageStatus,imageMessage:this.view.receiptImageMessage}:{receipt:null,message:'',checking:false,imageStatus:null,imageMessage:''};
 getDiagnosticView=()=>this.diagnosticSerial===this.serial&&same(this.diagnosticIdentity,this.transport.identity())?{rows:this.view.diagnostics,checking:this.view.diagnosticChecking,message:this.view.diagnosticMessage}:{rows:[],checking:false,message:''};
 private clearDiagnostic(){this.diagnosticGeneration++;this.diagnosticIdentity=null;this.diagnosticSerial=-1;this.emit({diagnostics:[],diagnosticChecking:false,diagnosticMessage:''});}
 /** Historical unknown entries are inspected without refreshing consent, changing queue state or scheduling writes. */
 async diagnosePending(){
  if(this.busy||this.view.receiptChecking)return;
  // Persist the automatic-drain pause until an explicit send, new saved contribution or account change.
  // In particular, ending this read must not start a previously scheduled pump or auto refresh.
  this.holdDiagnosticDrain=true;this.clearDiagnostic();
  const live=this.transport.identity(),i=live?{...live}:null,serial=this.serial,generation=this.diagnosticGeneration,parentSignal=this.abort.signal;
  this.diagnosticIdentity=i;this.diagnosticSerial=serial;
  if(!i||!this.transport.available()){this.emit({diagnosticMessage:'请先联网并核对当前账号，再只读核对待确认记录。'});return;}
  const controller=new AbortController(),signal=controller.signal,stop=()=>controller.abort();parentSignal.addEventListener('abort',stop,{once:true});if(parentSignal.aborted)stop();
  const retained=()=>generation===this.diagnosticGeneration&&serial===this.serial&&same(i,this.transport.identity())&&!parentSignal.aborted,current=()=>retained()&&!signal.aborted;
  const cancelled=new Promise<never>((_,reject)=>{if(signal.aborted)reject(Error('贡献核对已取消'));else signal.addEventListener('abort',()=>reject(Error('贡献核对已取消')),{once:true});});
  let timer:ReturnType<typeof setTimeout>;const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{stop();reject(Error('贡献只读核对超时'));},30000);});
  this.startBusy();this.emit({diagnosticChecking:true});
  try{const rows=await Promise.race([diagnoseContributionRequests(this.transport,this.store,i,signal,current),deadline,cancelled]);if(current())this.emit({diagnostics:rows,diagnosticMessage:rows.length?'已只读核对原记录；待确认记录与本机草稿均保留，未上传或续传。':'本机没有待确认的贡献条目；不能据此判断云端历史记录。'});}
  catch{if(retained())this.emit({diagnostics:[],diagnosticMessage:'原记录仍未核实；未上传或续传，本机草稿已保留。'});}
  finally{clearTimeout(timer!);parentSignal.removeEventListener('abort',stop);stop();if(generation===this.diagnosticGeneration)this.emit({diagnosticChecking:false});this.endBusy();}
 }
 private clearReceipt(){this.receiptGeneration++;this.receiptIdentity=null;this.receiptSerial=-1;this.emit({receipt:null,receiptMessage:'',receiptChecking:false,receiptImageStatus:null,receiptImageMessage:''});}
 private startBusy(){this.operations++;this.busy=true;this.emit({busy:true});}
 private endBusy(){this.operations=Math.max(0,this.operations-1);this.busy=this.operations>0;this.emit({busy:this.busy});}
 private emit(patch:Partial<View>){this.view={...this.view,...patch};this.listeners.forEach(f=>f());}
 captureContextKey(){return JSON.stringify(this.transport.captureIdentity?this.transport.captureIdentity():this.transport.identity());}
 identityChanged(){const captureKey=JSON.stringify(this.transport.captureIdentity?this.transport.captureIdentity():this.transport.identity());if(captureKey!==this.captureIdentityKey){this.captureIdentityKey=captureKey;this.captureSerial++;this.captureChoiceKey='';this.capturePolicyKey='';this.holdAutomaticDrain=false;}const next=this.transport.identity(),key=JSON.stringify(next);if(key===this.identityKey)return;this.identityKey=key;this.drainRequested=false;this.withdrawalQueued=false;this.serial++;this.abort.abort();this.abort=new AbortController();this.loadedKey='';this.holdDiagnosticDrain=false;this.clearDiagnostic();this.clearReceipt();this.emit({verification:this.retrying?'checking':'idle',policy:null,choice:null,stopped:true,pending:false,queued:0,sendable:0,unconfirmed:0,message:''});}
 private assert(i:ContributionIdentity){if(!same(i,this.transport.identity())||this.abort.signal.aborted)throw Error('贡献账号已变化');}
 private adopt(s:ContributionScope){const choiceKey=canonical([s.choice?.choice??null,s.choice?.activeEpoch??null,s.choice?.revision??null,s.choice?.policyVersion??null,s.choice?.receiverReady??false,s.stopped,s.stopRequested,!!s.pendingChoice]);if(this.captureChoiceKey&&this.captureChoiceKey!==choiceKey)this.captureSerial++;this.captureChoiceKey=choiceKey;this.withdrawalQueued=s.pendingChoice?.choice==='decline'&&!s.pendingChoice.attempted;this.emit({choice:s.choice,stopped:s.stopped||this.localStopped.has(s.key),pending:!!s.pendingChoice,queued:s.samples.filter(q=>!['received','stopped'].includes(q.step)).length,sendable:s.samples.filter(q=>['new','prepared','uploaded'].includes(q.step)).length,unconfirmed:s.samples.filter(q=>q.step.endsWith('-unknown')).length});}
 /** Opening settings pauses automatic writes before the status read starts. */
 openDiagnostics(){this.identityChanged();this.holdDiagnosticDrain=true;return this.refresh();}
 async refreshAutomatically(){const key=JSON.stringify(this.transport.identity());if(this.busy||this.holdDiagnosticDrain||this.automaticKey===key)return;this.automaticKey=key;await this.refresh();}
 async refresh(){if(this.busy)return;this.clearDiagnostic();this.clearReceipt();this.identityChanged();this.loadedKey='';this.startBusy();this.emit({verification:'checking'});try{await this.readVerification(true);}finally{this.endBusy();}}
 /** Explicit recovery only: no photo save, enqueue, or contribution write is scheduled. */
 async retryVerification(permit:CapturePermit,verifyAccount:()=>Promise<void>){
  if(this.busy||this.permitState(permit)!=='paused')return;
  const context=this.captureContextKey(),captureSerial=this.captureSerial;
  const retained=()=>context===this.captureContextKey()&&captureSerial===this.captureSerial&&this.transport.available();
  this.retrying=true;this.holdAutomaticDrain=true;this.startBusy();this.emit({verification:'checking'});
  try{await verifyAccount();this.identityChanged();if(!retained())return;if(!this.transport.identity())throw Error('账号尚未核实');
   this.automaticKey=JSON.stringify(this.transport.identity());this.loadedKey='';await this.readVerification(false);
  }catch{if(retained()){this.loadedKey='';this.emit({verification:'failed',policy:null,message:'账号或参与状态未能核实，可稍后重新核对；本图编辑已保留。'});}}
  finally{this.retrying=false;if(retained())this.automaticKey=JSON.stringify(this.transport.identity());if(retained()&&this.view.verification==='checking')this.emit({verification:'failed'});this.endBusy();}
 }
 private async readVerification(scheduleDrain:boolean){const serial=this.serial,signal=this.abort.signal;const current=()=>serial===this.serial&&!signal.aborted;const checked=(i:ContributionIdentity)=>{if(!current())throw Error('贡献核验已过期');this.assert(i);};
  try{const localIdentity=this.transport.identity()??this.transport.localIdentity?.();if(localIdentity){const local=await this.store.read(scopeKey(localIdentity));if(!current())return;this.adopt(local);if(local.stopRequested)this.localStopped.add(local.key);}const policy=parsePolicy(await this.transport.policy(signal));if(!current())return;const policyKey=canonical(policy);if(this.capturePolicyKey&&this.capturePolicyKey!==policyKey)this.captureSerial++;this.capturePolicyKey=policyKey;this.emit({policy});const i=this.transport.identity();if(!i){this.emit({verification:'idle'});return;}checked(i);const key=scopeKey(i),local=await this.store.read(key);checked(i);this.adopt(local);
   const choice=parseChoice(await this.transport.request(i,'GET','/choice',signal),i);checked(i);
   const saved=await this.store.change(key,s=>{checked(i);const stale=s.samples.filter(q=>!q.step.endsWith('-unknown')&&(choice.choice!=='participate'||q.epoch!==choice.activeEpoch||q.revision!==choice.revision||!Array.isArray(q.manifest.correctionEvents)));s.tombstones.push(...stale.map(q=>({sampleId:q.sampleId,requestIds:[q.prepareId,q.contentId,q.finalizeId]})));s.samples=s.samples.filter(q=>!stale.includes(q));if(choice.choice==='decline')s.stopped=true;s.choice=choice;});checked(i);this.loadedKey=key;this.adopt(saved);if(scheduleDrain)this.drainRequested=!saved.samples.some(q=>q.step.endsWith('-unknown'))&&saved.samples.some(q=>['new','prepared','uploaded'].includes(q.step));this.emit({verification:'ready',message:''});
  }catch{if(serial===this.serial)this.emit({verification:'failed',policy:null,message:'模型改进状态暂未核实，登录和本机训练可继续。'});}
 }
 canCapture(){const i=this.transport.identity(),c=this.view.choice,p=this.view.policy;return !this.retrying&&!!i&&this.transport.available()&&this.loadedKey===scopeKey(i)&&!this.view.stopped&&!this.view.pending&&p?.ready===true&&c?.choice==='participate'&&c.receiverReady&&c.policyVersion===p.version&&!!c.activeEpoch;}
 /** Called synchronously at new load; a later choice cannot adopt an older photo. */
 beginLoad():CapturePermit|null{if(!this.canCapture())return null;const c=this.view.choice!;return {identity:{...this.transport.identity()!},epoch:c.activeEpoch!,revision:c.revision,serial:this.captureSerial,captureKey:this.captureContextKey(),policy:canonical(this.view.policy)};}
 permitState(p:CapturePermit):'valid'|'paused'|'invalid'{
  if(p.captureKey!==this.captureContextKey()||p.serial!==this.captureSerial||!this.transport.available())return 'invalid';
  if(!this.canCapture())return 'paused';
  const i=this.transport.identity()!;
  return i.owner===p.identity.owner&&i.authService===p.identity.authService&&i.apiService===p.identity.apiService&&p.epoch===this.view.choice?.activeEpoch&&p.revision===this.view.choice?.revision&&p.policy===canonical(this.view.policy)?'valid':'invalid';
 }
 permitValid(p:CapturePermit){return this.permitState(p)==='valid';}
 private async idle(){if(!this.busy)return;await new Promise<void>((resolve)=>{const done=()=>{clearTimeout(timer);off();resolve();};const off=this.subscribe(()=>{if(!this.busy)done();}),timer=setTimeout(done,15000);});}
 async login(choice:'participate'|'decline'|undefined,authenticate:()=>Promise<void>){const ticket=++this.loginTicket;this.emit({loginRunning:true});try{await authenticate();if(ticket!==this.loginTicket)return;const i=this.transport.identity();if(!i)return;await this.idle();await this.refresh();if(!same(i,this.transport.identity())||ticket!==this.loginTicket)return;
   // Existing effective choices win over anonymous-page intent. No second prompt.
   if(this.view.choice&&this.view.choice.choice!=='undecided'&&this.view.choice.policyVersion===this.view.policy?.version)return;
   if(choice)await this.choose(choice);
  }finally{if(ticket===this.loginTicket)this.emit({loginRunning:false});}}
 async choose(choice:'participate'|'decline'){
  const online=this.transport.identity();if(choice==='participate'&&!online){this.emit({message:'请先联网并核对当前账号，再选择参与模型改进；尚未建立参与选择。'});return;}
  const i=online??this.transport.localIdentity?.();if(!i)return;if(this.busy&&choice!=='decline')return;const key=scopeKey(i),participationSerial=this.serial;
  const assertParticipation=()=>{if(choice==='participate'){if(participationSerial!==this.serial)throw Error('参与选择已变化');this.assert(i);}};
  if(choice==='participate'&&(!this.transport.available()||!this.view.policy?.ready)){this.emit({message:'真实条款或接收条件尚未就绪，未开始采集。'});return;}
  // Stop in memory before any asynchronous work. Persist before contacting server.
  this.captureSerial++;this.clearDiagnostic();this.clearReceipt();
  if(choice==='decline'){this.holdDiagnosticDrain=false;this.localStopped.add(key);this.serial++;this.abort.abort();this.abort=new AbortController();this.emit({stopped:true});}
  if(choice==='participate')this.localStopped.delete(key);
  const wasBusy=this.busy;this.startBusy();try{
   const saved=await this.store.change(key,s=>{assertParticipation();if(choice==='decline'){s.stopped=true;s.stopRequested=true;s.tombstones.push(...s.samples.map(q=>({sampleId:q.sampleId,requestIds:[q.prepareId,q.contentId,q.finalizeId]})));s.samples=[];
     // Explicit exit cancels only a choice that was never attempted; unknown writes keep their original receipt identity.
     if(s.pendingChoice?.choice==='participate'&&!s.pendingChoice.attempted)s.pendingChoice=null;}
    if(s.pendingChoice){if(choice==='decline')return;throw Error('原选择待核对');}if(choice==='participate')s.stopRequested=false;s.pendingChoice={requestId:id(),expectedRevision:s.choice?.revision??0,choice,policyVersion:'photo-contribution/v1',attempted:false};});assertParticipation();this.adopt(saved);if(!online||wasBusy||saved.pendingChoice?.choice!==choice){this.emit({message:'本机已停止采集，联网后读取并提交退出；个人训练保持。'});return;}this.assert(i);await this.sendChoice(i,saved);
  }catch{if(choice==='decline'||participationSerial===this.serial)this.emit({message:choice==='decline'?'本机已停止采集；远端退出尚待核对，不会重复提交。':'本次选择结果待核对，尚未开始采集。'});}finally{this.endBusy();}
 }
 private async sendChoice(i:ContributionIdentity,s:ContributionScope){const p=s.pendingChoice;if(!p||p.attempted)return;this.assert(i);await this.store.change(s.key,c=>{if(c.pendingChoice?.requestId!==p.requestId||c.pendingChoice.attempted)throw Error('原选择已变化');c.pendingChoice.attempted=true;});this.assert(i);
  const {attempted:_,...body}=p;const c=parseChoice(await this.transport.request(i,'POST','/choice',this.abort.signal,body),i);this.assert(i);if(c.choice!==p.choice||c.revision<=p.expectedRevision)throw Error('选择未确认');
  await this.finishChoice(i,p.requestId,c);
 }
 private async finishChoice(i:ContributionIdentity,requestId:string,choice:ChoiceState){const key=scopeKey(i);this.assert(i);const saved=await this.store.change(key,s=>{if(s.pendingChoice?.requestId!==requestId)throw Error('选择已变化');s.choice=choice;s.pendingChoice=null;if((s.stopRequested||this.localStopped.has(key))&&choice.choice==='participate'){s.stopped=true;s.pendingChoice={requestId:id(),expectedRevision:choice.revision,choice:'decline',policyVersion:'photo-contribution/v1',attempted:false};}else s.stopped=choice.choice!=='participate';});this.assert(i);if(!saved.stopped)this.localStopped.delete(key);this.loadedKey=key;this.adopt(saved);this.emit({message:choice.choice==='decline'?'已停止模型改进贡献，个人训练与备份保持。':'已记录选择；仅之后新加载的照片可参与。'});}
 /** Explicit read never retries a previously attempted choice or sample write. */
 async reconcile(){if(this.busy)return;const i=this.transport.identity();if(!i)return;const serial=this.serial,current=()=>serial===this.serial&&same(i,this.transport.identity())&&!this.abort.signal.aborted;let originalMissing=false;const missingMessage='服务器暂未找到本次提交记录，已保留待核对，不会重复上传';this.startBusy();try{this.assert(i);const s=await this.store.read(scopeKey(i));this.assert(i);
   if(s.pendingChoice){const p=s.pendingChoice;if(!p.attempted){await this.sendChoice(i,s);}else{const r=parseRequest(await this.transport.request(i,'POST','/requests/read',this.abort.signal,{requestId:p.requestId}),p.requestId);this.assert(i);if(r.found&&r.operation==='choice'&&r.state==='done'){const c=parseChoice(await this.transport.request(i,'GET','/choice',this.abort.signal),i);this.assert(i);if(c.choice===p.choice&&c.revision>p.expectedRevision)await this.finishChoice(i,p.requestId,c);}}}
   for(const q of s.samples.filter(q=>q.step.endsWith('-unknown'))){this.assert(i);if(this.localStopped.has(s.key))break;if(await this.readSample(i,q)==='not-found')originalMissing=true;}const updated=await this.store.read(s.key);this.assert(i);this.drainRequested=updated.samples.some(q=>['new','prepared','uploaded'].includes(q.step));this.adopt(updated);this.emit({message:originalMissing?missingMessage:'已读取原请求；仍未知的写入保持停止。'});
  }catch{if(current())this.emit({message:originalMissing?missingMessage:'原请求仍未核实，未重复发送。'});}finally{this.endBusy();}
 }
 /** Read the original finalize receipt, then current content, without queue mutation or write replay. */
 async verifyLatestReceipt(){
  if(this.busy||this.view.receiptChecking||this.hasDrainRequest())return;
  this.clearReceipt();const live=this.transport.identity(),i=live?{...live}:null,serial=this.serial,generation=this.receiptGeneration,signal=this.abort.signal;
  this.receiptIdentity=i;this.receiptSerial=serial;
  if(!i||!this.transport.available()){this.emit({receiptMessage:'请先联网并核对当前账号，再核对贡献回执。'});return;}
  const current=()=>generation===this.receiptGeneration&&serial===this.serial&&same(i,this.transport.identity())&&!signal.aborted;
  const assertCurrent=()=>{if(!current()||this.busy||this.hasDrainRequest()||this.localStopped.has(scopeKey(i)))throw Error('回读对象已变化');};
  const latest=(s:ContributionScope)=>{assertCurrent();const q=s.samples[s.samples.length-1];if(s.key!==scopeKey(i)||s.stopped||s.stopRequested||s.pendingChoice||s.choice?.choice!=='participate'||!q||!['received','finalize-unknown'].includes(q.step)||s.choice.activeEpoch!==q.epoch||s.choice.revision!==q.revision||s.samples.some(x=>!['received','stopped','prepare-unknown','content-unknown','finalize-unknown'].includes(x.step)))throw Error('本机回执暂不可核对');return q;};
  const fingerprint=(q:QueuedSample)=>canonical({sampleId:q.sampleId,finalizeId:q.finalizeId,manifestSha256:q.manifestSha256,epoch:q.epoch,revision:q.revision,step:q.step,manifest:q.manifest});
  this.emit({receiptChecking:true});
  try{
   const local=await this.store.read(scopeKey(i));assertCurrent();
   if(!local.samples.length){this.emit({receiptMessage:'本机没有可核对的贡献样本记录，未发起服务器回执查询。个人保存不等于模型改进贡献；不能据此判断云端是否存在历史样本。'});return;}
   const q=latest(local),fixed=fingerprint(q),manifest=q.manifest;
   if(manifest.sampleId!==q.sampleId||await sha256(canonical(manifest))!==q.manifestSha256)throw Error('本机摘要未核实');assertCurrent();
   const readback=parseReadbackExpectation({sampleId:q.sampleId,manifestSha256:q.manifestSha256,imageSha256:manifest.image.sha256,imageBytes:manifest.image.bytes,consentEpoch:q.epoch,consentRevision:q.revision});
   const body={requestId:q.finalizeId,readback};validateContributionRequest('POST','/requests/read',body);
   if(fingerprint(latest(await this.store.read(scopeKey(i))))!==fixed)throw Error('回读对象已变化');
   const result=parseReadback(await this.transport.request(i,'POST','/requests/read',signal,body));assertCurrent();
   if(fingerprint(latest(await this.store.read(scopeKey(i))))!==fixed)throw Error('回读对象已变化');
   if(result.status==='verified'){
    const events=manifest.correctionEvents;if(result.initialCount!==manifest.initial.predictions.length||result.eventCount!==events.length||result.finalCount!==manifest.corrected.labels.length||result.undoCount!==events.filter(e=>e.undoOf!==null).length||Object.entries(result.causeCounts!).some(([cause,n])=>events.filter(e=>e.cause===cause).length!==n))throw Error('回读计数不一致');
    this.emit({receipt:result,receiptMessage:'',receiptImageStatus:'unknown',receiptImageMessage:'正在核对图片当前可读状态…'});
    // The strict receipt proves the stored manifest and original finalize binding.
    // Current object readability is a separate fact; do not rewrite its historic unknown field.
    const assertPinned=async()=>{try{const s=await this.store.read(scopeKey(i));assertCurrent();if(fingerprint(latest(s))!==fixed)throw Error('回读对象已变化');}catch(error){if(current())this.clearReceipt();throw error;}};
    const imageUnknown=()=>this.emit({receiptImageStatus:'unknown',receiptImageMessage:'回执已核对；图片当前可读状态尚未核实。可稍后再次核对，未重复提交贡献。'});
    try{
     await assertPinned();
     const content=await this.transport.request(i,'GET','/samples/'+q.sampleId+'/content-status',signal);assertCurrent();
     await assertPinned();
     const c=content as Record<string,unknown>|null;
     if(c&&typeof c==='object'&&!Array.isArray(c)&&Object.keys(c).length===3&&c.sampleId===q.sampleId&&c.contentVerified===true&&c.unknown===false)this.emit({receiptImageStatus:'verified',receiptImageMessage:'图片当前可读取，内容核对通过。'});
     else imageUnknown();
    }catch{
     if(current()){try{await assertPinned();imageUnknown();}catch{/* A changed account or queue invalidates both displayed facts. */}}
    }
   }else this.emit({receipt:null,receiptMessage:'本次贡献尚未核实，可稍后只读核对；个人训练不受影响。'});
  }catch{if(current())this.emit({receipt:null,receiptMessage:'本次贡献尚未核实，可稍后只读核对；个人训练不受影响。'});}
  finally{if(generation===this.receiptGeneration)this.emit({receiptChecking:false});}
 }
 private receiptMatches(q:QueuedSample,r:SampleReceipt){return r.manifestSha256===q.manifestSha256&&r.imageSha256===q.manifest.image.sha256&&r.imageBytes===q.manifest.image.bytes&&r.consentEpoch===q.epoch&&r.consentRevision===q.revision;}
 private async stage(i:ContributionIdentity,q:QueuedSample,step:QueuedSample['step']){this.assert(i);const s=await this.store.change(scopeKey(i),s=>{this.assert(i);if(s.stopped||this.localStopped.has(s.key))throw Error('采集已停止');const item=s.samples.find(x=>x.sampleId===q.sampleId);if(!item||item.step!==q.step)throw Error('样本状态已变化');item.step=step;if(step==='received'||step==='stopped')item.image=null;});this.assert(i);q.step=step;this.adopt(s);}
 private async readSample(i:ContributionIdentity,q:QueuedSample){const operation=q.step==='prepare-unknown'?'prepare':q.step==='content-unknown'?'content':q.step==='finalize-unknown'?'finalize':null;if(!operation)throw Error('原贡献阶段未核实');const requestId=operation==='prepare'?q.prepareId:operation==='content'?q.contentId:q.finalizeId;const original=parseRequest(await this.transport.request(i,'POST','/requests/read',this.abort.signal,{requestId}),requestId);this.assert(i);if(!original.found)return 'not-found' as const;if(original.operation!==operation||original.sampleId!==q.sampleId||operation!=='content'&&original.state!=='done')throw Error('原贡献请求绑定未核实');
  const r=parseReceipt(await this.transport.request(i,'GET','/samples/'+q.sampleId,this.abort.signal),q.sampleId);this.assert(i);if(!this.receiptMatches(q,r))throw Error('样本摘要不同');
  if(['withdrawn','deletion_pending','expired'].includes(r.status))return this.stage(i,q,'stopped');if(r.status==='received'&&r.contentVerified)return this.stage(i,q,'received');
  if(q.step==='prepare-unknown'&&r.status==='reserved')return this.stage(i,q,'prepared');
  if(q.step==='content-unknown'){const status=await this.transport.request(i,'GET','/samples/'+q.sampleId+'/content-status',this.abort.signal) as {sampleId:string;contentVerified:boolean;unknown:boolean};this.assert(i);if(status.sampleId===q.sampleId&&status.contentVerified===true&&status.unknown===false)await this.stage(i,q,'uploaded');}
 }
 async enqueue(permit:CapturePermit,manifest:Manifest,image:Blob){if(!this.permitValid(permit)||!Array.isArray(manifest.correctionEvents)||manifest.correctionEvents.length>256)return false;this.clearDiagnostic();this.clearReceipt();try{const digest=await sha256(canonical(manifest));if(!this.permitValid(permit))return false;
   const s=await this.store.change(scopeKey(permit.identity),s=>{if(!this.permitValid(permit)||s.stopped||s.pendingChoice||s.choice?.activeEpoch!==permit.epoch||s.choice.revision!==permit.revision)throw Error('参与选择已变化');if(s.samples.some(q=>q.sampleId===manifest.sampleId))return;
    const active=s.samples.filter(q=>q.image);if(s.tombstones.length>=1000||active.length>=20||active.reduce((sum,q)=>sum+(q.image?.size??0),0)+image.size>100*1024*1024||image.size>8*1024*1024)throw Error('贡献副本容量已满');
    s.samples=s.samples.filter(q=>q.step!=='received'&&q.step!=='stopped');s.samples.push({sampleId:manifest.sampleId,epoch:permit.epoch,revision:permit.revision,manifest,manifestSha256:digest,image,step:'new',prepareId:id(),contentId:id(),finalizeId:id()});});if(this.permitValid(permit)){this.holdDiagnosticDrain=false;this.holdAutomaticDrain=false;this.drainRequested=true;this.adopt(s);}return true;
  }catch{this.emit({message:'本次贡献未进入队列，个人训练保存结果保持。'});return false;}}
 hasDrainRequest=()=>!this.holdDiagnosticDrain&&(!this.holdAutomaticDrain&&this.drainRequested||this.withdrawalQueued);
 async drainScheduled(){if(this.holdDiagnosticDrain||this.busy||this.retrying||this.holdAutomaticDrain&&!this.withdrawalQueued)return;const withdrawal=this.withdrawalQueued;this.withdrawalQueued=false;this.drainRequested=false;if(withdrawal)await this.reconcile();else await this.sendQueued();}
 networkChanged=()=>{const network=networkSignal();if(network!==this.view.network)this.emit({network});};
 private pauseForOffline(){this.networkChanged();if(this.view.network!=='offline')return false;this.emit({message:'当前设备已离线，待贡献样本保留在本机；联网后继续发送。'});return true;}
 async sendQueued(){if(this.busy||!this.canCapture())return;if(this.pauseForOffline())return;const i={...this.transport.identity()!},serial=this.serial;let attempted:QueuedSample|null=null;this.holdDiagnosticDrain=false;this.clearDiagnostic();this.drainRequested=false;this.startBusy();try{const s=await this.store.read(scopeKey(i));this.assert(i);for(const q of s.samples){if(!this.canCapture())break;if(!['new','prepared','uploaded'].includes(q.step))continue;if(!Array.isArray(q.manifest.correctionEvents)||q.manifest.correctionEvents.length>256){await this.stage(i,q,'stopped');continue;}
   if(q.step==='new'){if(this.pauseForOffline())break;await this.stage(i,q,'prepare-unknown');attempted=q;const r=parseReceipt(await this.transport.request(i,'POST','/samples/prepare',this.abort.signal,{requestId:q.prepareId,sampleId:q.sampleId,consentEpoch:q.epoch,consentRevision:q.revision,manifestSha256:q.manifestSha256,imageSha256:q.manifest.image.sha256,imageBytes:q.manifest.image.bytes,mime:'image/png'}),q.sampleId);if(!this.receiptMatches(q,r)||r.status!=='reserved')throw Error('样本准备未核实');await this.stage(i,q,'prepared');}
   if(q.step==='prepared'&&q.image){if(this.pauseForOffline())break;await this.stage(i,q,'content-unknown');attempted=q;const r=parseReceipt(await this.transport.request(i,'PUT','/samples/'+q.sampleId+'/content',this.abort.signal,q.image,q.contentId),q.sampleId);if(!this.receiptMatches(q,r)||!r.contentVerified)throw Error('图片未核实');await this.stage(i,q,'uploaded');}
   if(q.step==='uploaded'){if(this.pauseForOffline())break;await this.stage(i,q,'finalize-unknown');attempted=q;const r=parseReceipt(await this.transport.request(i,'POST','/samples/'+q.sampleId+'/finalize',this.abort.signal,{requestId:q.finalizeId,manifest:q.manifest,manifestSha256:q.manifestSha256}),q.sampleId);if(!this.receiptMatches(q,r)||r.status!=='received'||!r.contentVerified)throw Error('接收未核实');await this.stage(i,q,'received');}
  }}catch(error){if(serial===this.serial&&same(i,this.transport.identity())){const conflict=contributionConflictReason(error),q=attempted;
   if(conflict&&q){try{await this.store.change(scopeKey(i),s=>{this.assert(i);const item=s.samples.find(x=>x.sampleId===q.sampleId);if(item&&item.step===q.step&&item.prepareId===q.prepareId&&item.contentId===q.contentId&&item.finalizeId===q.finalizeId&&item.manifestSha256===q.manifestSha256)item.conflict=conflict;});}catch{/* Failure to retain a diagnostic never retries the original write. */}}
   if(serial===this.serial&&same(i,this.transport.identity()))this.emit({message:conflict?'本次提交未完成：'+contributionConflictMessages[conflict]+'原请求和本机草稿已保留，请只读核对待确认记录。':'贡献结果待核对，原请求保留；个人训练不受影响。'});
  }}finally{this.endBusy();}
 }
}
