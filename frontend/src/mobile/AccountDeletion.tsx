import React,{useEffect,useRef,useState,useSyncExternalStore} from 'react';
import {FirstBatchHeader} from './FirstBatchHeader';
import {Button,Field,Panel,Modal,useApp} from './ui';
import {cloudSync} from './cloud-sync';
import {mainlandPhone} from './api';
import {accountDeletionReady,phoneOtpReady,existingEmailOtpLoginReady} from './release-mode';
import {PasswordField} from './PasswordField';
import {readBoundedResponse} from './bounded-response';
import {AccountDeletionFlow,parseDeletionPreview,type DeletionPreview,type DeletionJournal,type DeletionScope} from './account-deletion-core';
import {clearDeletionLocal,deletionStore,DELETION_EVENT} from './account-deletion-local';

async function readback(j:DeletionJournal,action:'status'|'continue'){
 const c=new AbortController(),timer=setTimeout(()=>c.abort(),20000);
 try{const r=await fetch(j.scope.apiOrigin+'/api/account-deletion/'+action,{method:'POST',credentials:'omit',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer',headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify({requestId:j.requestId,readbackCapability:j.readbackCapability}),signal:c.signal});
  if(!r.ok){await r.body?.cancel();throw new Error(`原注销请求尚未核对（${r.status}）；本机资料保留，不会再次提交注销。`);}return JSON.parse(new TextDecoder().decode(await readBoundedResponse(r,128*1024,c.signal)));
 }finally{clearTimeout(timer);}
}
const flow=new AccountDeletionFlow(deletionStore,{prepare:s=>cloudSync.prepareAccountDeletion(s),freeze:s=>cloudSync.freezeAccountDeletion(s),confirm:j=>cloudSync.confirmAccountDeletion(j),status:j=>readback(j,'status'),resume:j=>readback(j,'continue'),clearLocal:clearDeletionLocal});
const labels:Record<string,string>={trainingSessions:'云端训练',trainingPlans:'云端计划',cloudBackups:'云备份',teamMemberships:'团队成员关系',teamsOwned:'本人负责团队',rewardSources:'本人权益来源',rewardClaims:'本人领取记录',invitationLinks:'邀请关联',feedbackRecords:'本人反馈',privateMedia:'私有媒体',contributionPhotos:'贡献照片',archiveRecords:'归档记录',communityRecords:'社区记录'};
export function AccountDeletionEntry(){
 const [opened,setOpened]=useState(false);
 if(!accountDeletionReady)return null;
 if(window.Gongxingji)return <Panel title="永久注销账号"><p>此安装包尚不支持按账号清理。请使用当前正式网页版办理注销；手机内的旧资料不会被网页远程清除。</p><a href="https://service-1.example.invalid/app/#/account" target="_blank" rel="noreferrer">打开正式网页版</a></Panel>;
 return <div className="account-deletion-detail">
  <FirstBatchHeader eyebrow="账号中心 / 账号管理" title="永久注销账号" description="先查看云端影响范围，核对本人身份，再决定是否继续。"/>
  {opened?<DeletionStart onClose={()=>setOpened(false)}/>:<Panel className="deletion-intro"><span className="deletion-flag">不可恢复</span><h2>注销后会发生什么</h2><p>账号和本人云端资料将永久删除。本人在团队中的权限、邀请关联和权益也会相应处理。</p><p>重新注册会创建全新账号，无法继承原训练或权益。重新满足邀请码或当次活动条件后，可再次领取相应奖励。</p><Button onClick={()=>setOpened(true)}>查看注销范围</Button></Panel>}
 </div>;
}
function DeletionStart({onClose}:{onClose:()=>void}){
 const {open,hasPendingSave}=useApp(),status=useSyncExternalStore(cloudSync.subscribe,cloudSync.getStatus,cloudSync.getStatus);
 const [scope]=useState<DeletionScope|null>(()=>cloudSync.accountDeletionScope()),[preview,setPreview]=useState<DeletionPreview|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[destination,setDestination]=useState(''),[channel,setChannel]=useState<'phone'|'email'>('phone'),[secret,setSecret]=useState(''),[kind,setKind]=useState<'password'|'otp'>('password'),[confirmed,setConfirmed]=useState(''),[understood,setUnderstood]=useState(false),[message,setMessage]=useState('');
 const [finalCheck,setFinalCheck]=useState(false);
 const cancelFinal=()=>{if(busy)return;setFinalCheck(false);setUnderstood(false);setConfirmed('');};
 const lock=useRef(false),alive=useRef(true),pin=scope?.owner;
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 const same=()=>!!scope&&cloudSync.accountDeletionScope()?.owner===scope.owner&&cloudSync.accountDeletionScope()?.localService===scope.localService;
 const act=async(f:()=>Promise<void>)=>{if(lock.current||!same())return;lock.current=true;setBusy(true);setError('');try{await f();}catch(e){if(alive.current)setError(e instanceof Error?e.message:'本次注销未能核对');}finally{lock.current=false;if(alive.current)setBusy(false);}};
 const load=async()=>{if(!scope)throw new Error('请先登录要注销的本人账号');const value=parseDeletionPreview(await cloudSync.prepareAccountDeletion(scope),scope);if(!same())throw new Error('账号已变化');setPreview(value);};
 useEffect(()=>{void act(load);},[]);
 if(!scope||status.owner!==pin)return <p role="alert">账号已变化，请关闭本页后重新核对。没有发起注销。</p>;
 return <><Panel className="deletion-intro" title="1. 核对影响范围"><span className="deletion-flag">不可恢复</span><p>这只处理当前本人账号。其他人的原训练、账号与已取得资格保留。团队和邀请中的本人身份按注销规则解除或匿名化。</p><p>请先保存需要保留的备份。你已导出或交给他人的文件、其他离线设备和平台历史备份，不会被本页即时擦除。</p><Button disabled={busy} onClick={()=>open('data')}>先到数据管理导出备份</Button>{hasPendingSave()&&<p role="alert">当前还有未保存内容，请先保存或导出；暂不允许提交注销。</p>}
 {!finalCheck&&error&&<p role="alert">{error}</p>}{message&&<p role="status">{message}</p>}
 {preview&&<><p>以下是当前云端关联数量；这是影响范围，不表示已经删除。</p><details className="deletion-inventory"><summary>逐项查看资料数量</summary><dl>{Object.entries(preview.counts).map(([key,count])=><React.Fragment key={key}><dt>{labels[key]??key}</dt><dd>{count}</dd></React.Fragment>)}</dl></details>{preview.blockers.map(b=><p role="alert" key={b.code}>{b.message}</p>)}<p>{preview.recentAuthentication?'近期本人验证已确认。':'请重新验证本人，刷新登录令牌不代替本人验证。'}</p></>}
 {busy&&!preview&&<p role="status">正在核对注销范围…</p>}</Panel>
 <Panel className="deletion-verify" title="2. 验证本人"><div role="group" aria-label="本人登录方式"><Button aria-pressed={channel==='phone'} disabled={busy} onClick={()=>{setChannel('phone');setDestination('');setSecret('');setKind('password');}}>手机号</Button><Button aria-pressed={channel==='email'} disabled={busy} onClick={()=>{setChannel('email');setDestination('');setSecret('');setKind('password');}}>邮箱</Button></div>
 <div role="group" aria-label="注销前重新验证"><Button aria-pressed={kind==='password'} disabled={busy} onClick={()=>{setKind('password');setSecret('');}}>使用密码</Button>{(channel==='phone'?phoneOtpReady:existingEmailOtpLoginReady)&&<Button aria-pressed={kind==='otp'} disabled={busy} onClick={()=>{setKind('otp');setSecret('');}}>使用验证码</Button>}</div>
 <Field label={channel==='phone'?'当前账号手机号':'当前账号邮箱'}><input type={channel==='phone'?'tel':'email'} autoComplete="username" value={destination} disabled={busy} onChange={e=>setDestination(e.target.value)}/></Field>
 {kind==='password'?<PasswordField label="当前密码" value={secret} onChange={setSecret} disabled={busy} autoComplete="current-password"/>:<><Field label={channel==='phone'?'本次短信验证码':'本次邮箱验证码'}><input inputMode="numeric" autoComplete="one-time-code" value={secret} maxLength={channel==='phone'?6:8} disabled={busy} onChange={e=>setSecret(e.target.value.replace(/\D/g,''))}/></Field><Button disabled={busy||!destination.trim()} onClick={()=>void act(async()=>{const result=await cloudSync.sendOtp(channel,channel==='phone'?mainlandPhone(destination):destination.trim().toLowerCase(),false);if(same())setMessage(result.message);})}>获取验证码</Button></>}
 <Button disabled={busy||!destination.trim()||!secret} onClick={()=>void act(async()=>{const value=secret;setSecret('');await cloudSync.reauthenticateAccountDeletion(scope,channel,destination,value,kind);await load();})}>验证本人并重新核对范围</Button>
 <Button disabled={busy} onClick={()=>void act(load)}>刷新注销范围</Button></Panel>
 <Panel className="deletion-review" title="3. 最终确认"><p>完成资料核对和本人验证后，可进入最终确认。永久注销无法撤销。</p><Button kind="danger" disabled={busy||!preview?.canDelete||hasPendingSave()} onClick={()=>setFinalCheck(true)}>进入最终确认</Button><Button disabled={busy} onClick={onClose}>返回，暂不注销</Button></Panel>
 {finalCheck&&<Modal title="确认永久注销" onClose={cancelFinal}><div className="deletion-final">{error&&<p role="alert">{error}</p>}{hasPendingSave()&&<p role="alert">本机有未保存内容，请先保留资料。</p>}<p>当前账号及已核对范围内的云端资料将永久删除。重新注册无法恢复这些内容。</p>
 <label className="check"><input type="checkbox" checked={understood} disabled={busy} onChange={e=>setUnderstood(e.target.checked)}/>我已保留需要的资料，理解这是永久注销，重新注册不会恢复旧身份。</label>
 <Field label="输入“注销此账号”确认"><input autoComplete="off" value={confirmed} disabled={busy} onChange={e=>setConfirmed(e.target.value)}/></Field>
 <Button kind="danger" disabled={busy||!understood||confirmed!=='注销此账号'||!preview?.canDelete||hasPendingSave()} onClick={()=>void act(async()=>{if(!preview||hasPendingSave())throw new Error('请先完成资料保存并核对范围');await flow.begin(scope,preview,confirmed);})}>永久注销此账号</Button><Button disabled={busy} onClick={cancelFinal}>取消，保留账号</Button></div></Modal>}
 </>;
}
/** Outside the ordinary login gate: completed accounts can still read their receipt. */
export function AccountDeletionBoundary({children}:{children:React.ReactNode}){
 if(window.Gongxingji)return <>{children}</>;
 return <WebAccountDeletionBoundary>{children}</WebAccountDeletionBoundary>;
}
function WebAccountDeletionBoundary({children}:{children:React.ReactNode}){
 const status=useSyncExternalStore(cloudSync.subscribe,cloudSync.getStatus,cloudSync.getStatus);
 const [journal,setJournal]=useState<DeletionJournal|null>(null),[loaded,setLoaded]=useState(false),[error,setError]=useState(''),[busy,setBusy]=useState(false),generation=useRef(0),lock=useRef(false);
 const load=async()=>{const n=++generation.current;try{const j=await deletionStore.read();if(n===generation.current){setJournal(j);setError('');setLoaded(true);}return j;}catch(e){if(n===generation.current){setError(e instanceof Error?e.message:'注销记录无法读取');setLoaded(true);}throw e;}};
 useEffect(()=>{void load().catch(()=>{});const changed=()=>void load().catch(()=>{});window.addEventListener(DELETION_EVENT,changed);return()=>{generation.current++;window.removeEventListener(DELETION_EVENT,changed);};},[]);
 const relevant=!!journal&&(!status.owner||status.owner===journal.scope.owner&&cloudSync.accountDeletionScope()?.localService===journal.scope.localService);
 useEffect(()=>{if(relevant&&journal&&!journal.localDone)void cloudSync.freezeAccountDeletion(journal.scope).catch(e=>setError(e instanceof Error?e.message:'本机暂停未完成，请关闭旧标签后继续核对'));},[relevant,journal?.requestId]);
 const act=async(f:()=>Promise<unknown>)=>{if(lock.current)return;lock.current=true;setBusy(true);setError('');try{await f();await load();}catch(e){setError(e instanceof Error?e.message:'本次注销尚未核对');}finally{lock.current=false;setBusy(false);}};
 if(!loaded)return <p role="status">正在核对本机账号状态…</p>;
 if(!journal&&!error||journal&&!relevant)return <>{children}</>;
 if(!journal)return <Panel title="本机注销记录待核对"><p role="alert">{error}</p><Button onClick={()=>void load().catch(()=>{})}>重新读取</Button><p>请勿清除浏览器数据或重复提交注销。</p></Panel>;
 return <main className="account-access"><Panel title={journal.receipt?.state==='completed'?'云端账号已永久注销':journal.notStarted?'注销尚未开始':'账号注销正在核对'}>
 {error&&<p role="alert">{error}</p>}
 {journal.receipt?.state==='completed'?<><p>原账号已不能登录。重新注册将得到新身份；需要邀请码时，务必在首次注册前填写。</p>{journal.localDone?<><p>当前浏览器中已确认属于此账号的资料已清理；其他账号保持。</p>{journal.warnings.map(w=><p role="status" key={w}>{w}</p>)}<p>其他离线设备、已导出文件和平台历史备份不代表已即时擦除。</p><Button disabled={busy} onClick={()=>void act(async()=>{await flow.dismiss();window.location.assign(window.location.pathname+'#/account');window.location.reload();})}>返回注册与登录</Button></>:<><p>本机清理尚未完成，原注销不会重复提交。</p><Button disabled={busy} onClick={()=>void act(()=>flow.cleanup())}>清理本机此账号资料</Button></>}</>:<>{!journal.notStarted&&<><p>结果未知时只查询原请求，本机训练暂时保留。</p><Button disabled={busy} onClick={()=>void act(()=>flow.read())}>读取原注销结果</Button></>}{journal.receipt?.state==='pending'&&<><p>云端仍有本次范围内的资料待处理。继续只推进原注销，不创建新的删除范围。</p><Button disabled={busy} onClick={()=>void act(()=>flow.resume())}>继续本次注销</Button></>}{(!journal.attempted||journal.notStarted)&&<><p>{journal.notStarted?'服务器已确认本次注销尚未开始。原资料保持，可返回重新验证并核对范围。':'注销尚未发出，可结束准备后重新登录核对。'}</p><Button disabled={busy} onClick={()=>void act(async()=>{const current=await deletionStore.read();if(!current||current.attempted&&!current.notStarted)throw new Error('状态已变化，只能读取原结果');await deletionStore.compareAndSet(current,null);window.location.reload();})}>返回重新核对</Button></>}</>}
 </Panel></main>;
}
