import {maskEmail} from './account-display';
import {AccountAccess} from './AccountAccess';
import React,{useEffect,useRef,useState,useSyncExternalStore} from 'react';
import {useApp,Back,Button,Field,Panel} from './ui';
import {repository,exportText} from './store';
import {cloudConfig,cloudSync,type CloudConflict,type Resolutions} from './cloud-sync';
import {otpLength} from './api';
import {PASSWORD_RULE,newPasswordError} from './password-policy';
import type {Session} from './domain';
import {communityTestOnly,emailOtpReady,phoneOtpReady,trainingCloudUnavailable} from './release-mode';
import {mergeSelectedScoreBackups,parseScoreBackupResponse,restoreSelectedScoreBackups,selectedScoreBackup,type ScoreBackupResponse} from './score-backup';

const sessionScore=(session:{ends:{arrows:{code:string}[]}[]})=>session.ends.flatMap(end=>end.arrows).reduce((sum,arrow)=>sum+(arrow.code==='X'?10:arrow.code==='M'?0:Number(arrow.code)),0);
function ScoreBackupPanel({owner,email,busy}:{owner:string|null;email:string;busy:boolean}){
  const {data,update,ask,tell}=useApp();
  const [uploadIds,setUploadIds]=useState<string[]>([]);
  const [restoreIds,setRestoreIds]=useState<string[]>([]);
  const [remote,setRemote]=useState<ScoreBackupResponse|null>(null);
  const [remoteKey,setRemoteKey]=useState('');
  const [working,setWorking]=useState(false);
  const inFlight=useRef(false);
  useEffect(()=>{setUploadIds([]);setRestoreIds([]);setRemote(null);setRemoteKey('');},[owner]);
  const completed=data.sessions.filter(session=>session.status==='completed');
  const localIds=new Set(data.sessions.map(session=>session.id));
  const remoteSessions=remote?.document?.sessions??[];
  const restorable=remoteSessions.filter(session=>!localIds.has(session.id));
  const toggle=(id:string,ids:string[],setter:(ids:string[])=>void)=>setter(ids.includes(id)?ids.filter(item=>item!==id):[...ids,id]);
  async function act(work:()=>Promise<void>){
    if(inFlight.current)return;
    inFlight.current=true;setWorking(true);
    try{await work();}catch(error){tell(error instanceof Error?error.message:'成绩备份未完成，本机资料保持不变');}
    finally{inFlight.current=false;setWorking(false);}
  }
  async function identity(){return cloudSync.ensureScoreBackupIdentity();}
  async function readRemote(){
    const before=await identity(),received=parseScoreBackupResponse(await cloudSync.scoreBackupRequest('GET'));
    const after=await identity();
    if(before.sessionKey!==after.sessionKey)throw new Error('账号已切换，请重新读取云端成绩');
    setRemote(received);setRemoteKey(after.sessionKey);setRestoreIds([]);
  }
  async function upload(){
    const ids=[...uploadIds];
    const selected=selectedScoreBackup(repository.data,ids);
    const before=await identity(),current=parseScoreBackupResponse(await cloudSync.scoreBackupRequest('GET'));
    if((await identity()).sessionKey!==before.sessionKey)throw new Error('账号已切换，请重新选择成绩');
    const merged=mergeSelectedScoreBackups(current.document,selected);
    if(current.document&&JSON.stringify(merged)===JSON.stringify(current.document)){tell('所选成绩已在云端，无需重复上传');setRemote(current);setRemoteKey(before.sessionKey);return;}
    const choice=await ask('核对成绩备份上传',`将主动选择的 ${ids.length} 场已完成成绩上传到当前账号；云端其他场次会保留，同一场仅在本机版本更高时更新。仅包含日期、靶规则、每箭环数及已记录落点，不含照片、视频、笔记、头像或整库资料。确定上传吗？`,['取消','上传所选成绩']);
    if(choice!==1)return;
    if((await identity()).sessionKey!==before.sessionKey)throw new Error('账号已切换，请重新选择成绩');
    if(JSON.stringify(selectedScoreBackup(repository.data,ids))!==JSON.stringify(selected))throw new Error('所选本机成绩已变化，请重新核对后上传');
    const committed=parseScoreBackupResponse(await cloudSync.scoreBackupRequest('PUT',merged,current.revision));
    setRemote(committed);setRemoteKey(before.sessionKey);setUploadIds([]);
    tell(`已核对云端保存 ${committed.document?.sessions.length??0} 场成绩；本机资料未改变`);
  }
  async function restore(){
    const ids=[...restoreIds],preview=remote;
    if(!preview?.document||!ids.length)throw new Error('请先读取云端，并选择要恢复的成绩');
    const before=await identity();
    if(before.sessionKey!==remoteKey)throw new Error('账号已变化，请重新读取云端成绩');
    const latest=parseScoreBackupResponse(await cloudSync.scoreBackupRequest('GET'));
    if(latest.revision!==preview.revision||JSON.stringify(latest.document)!==JSON.stringify(preview.document)){
      setRemote(latest);setRestoreIds([]);throw new Error('云端成绩已变化，已刷新清单，请重新选择');
    }
    const choice=await ask('核对本机恢复',`将所选 ${ids.length} 场云端成绩加入本机。只恢复成绩字段；已有场次不覆盖，头像、笔记、照片及训练计划不会从云端补入。确定恢复吗？`,['取消','恢复所选成绩']);
    if(choice!==1)return;
    if((await identity()).sessionKey!==before.sessionKey)throw new Error('账号已切换，请重新读取云端成绩');
    let restored=0;
    const saved=await update(draft=>{restored=restoreSelectedScoreBackups(draft,latest.document,ids);});
    if(!saved)throw new Error('本机保存未完成，不能宣称恢复成功；原资料仍保留');
    setRestoreIds([]);tell(`已在本机保存 ${restored} 场恢复成绩，原有记录未覆盖`);
  }
  return <Panel title="可选云端成绩备份">
    <p>成绩保存在本机。只有你勾选已完成场次并确认上传时，才发送成绩字段；不会上传照片、视频、笔记、个人资料或整库记录。</p>
    {!owner?<p role="status">登录后可手动备份或恢复成绩；本机记分与导出不受影响。</p>:<>
      <p>本机已完成 {completed.length} 场。当前账号：{maskEmail(email)||'已登录'}</p>
      {completed.length===0?<p>暂无已完成的训练成绩可上传。</p>:<details><summary>选择要上传的本机成绩（当前选中 {uploadIds.length} 场）</summary>
        {completed.map(session=><label className="list-row" key={session.id}><input type="checkbox" checked={uploadIds.includes(session.id)} disabled={working||busy} onChange={()=>toggle(session.id,uploadIds,setUploadIds)}/><span>{session.date} · {session.name}<small>{session.ends.flatMap(end=>end.arrows).length} 箭 · {sessionScore(session)} 分</small></span></label>)}
      </details>}
      <div className="actions"><Button kind="primary" disabled={working||busy||uploadIds.length===0} onClick={()=>void act(upload)}>核对并上传所选成绩</Button><Button disabled={working||busy} onClick={()=>void act(readRemote)}>读取当前账号云端清单</Button></div>
      {remote&&remoteKey===cloudSync.communityIdentity()?.sessionKey&&<div>
        <p role="status">云端版本 {remote.revision} · {remoteSessions.length} 场{remote.updatedAt?` · 最近更新 ${new Date(remote.updatedAt).toLocaleString()}`:''}。读取清单不会改动本机。</p>
        {restorable.length===0?<p>云端没有本机缺少的场次。</p>:<details open><summary>选择要恢复的成绩（当前选中 {restoreIds.length} 场）</summary>
          {restorable.map(session=><label className="list-row" key={session.id}><input type="checkbox" checked={restoreIds.includes(session.id)} disabled={working||busy} onChange={()=>toggle(session.id,restoreIds,setRestoreIds)}/><span>{session.date} · {session.target.name}<small>{session.ends.flatMap(end=>end.arrows).length} 箭 · {sessionScore(session)} 分</small></span></label>)}
        </details>}
        <Button kind="primary" disabled={working||busy||restoreIds.length===0} onClick={()=>void act(restore)}>核对并恢复所选成绩到本机</Button>
      </div>}
    </>}
  </Panel>;
}

function describe(value:unknown,collection:string){
  if(value===null)return '此端已删除这项资料';
  if(typeof value==='string')return value||'未填写';
  const item=value as Record<string,unknown>;
  if(collection==='sessions'){
    const s=value as Session,arrows=s.ends.flatMap(end=>end.arrows),score=arrows.reduce((n,a)=>n+(a.code==='X'?10:a.code==='M'?0:Number(a.code)),0);
    return `${s.date} · ${s.name}\n${arrows.length} 箭 · ${score} 分 · ${s.status==='completed'?'已结束':s.status==='discarded'?'已放弃':'草稿'}\n${s.conditions.distance} 米 · ${s.conditions.target.name} · ${s.conditions.equipment?.name??'未选器材'}\n心得：${s.note||'未填写'}\n${s.ends.map((end,index)=>`第 ${index+1} 组：${end.arrows.map(a=>a.code+(('note' in a&&a.note)?`（${a.note}）`:'')).join('、')||'未录入'}${end.note?`；组备注：${end.note}`:''}`).join('\n')}`;
  }
  return Object.entries(item).filter(([,v])=>typeof v==='string'||typeof v==='number'||typeof v==='boolean').filter(([key])=>!['id','updated'].includes(key)).map(([key,v])=>`${({name:'名称',note:'备注',date:'日期',start:'开始',end:'结束',category:'类别',arrows:'箭量',arrowsPerWeek:'每周箭量',perWeek:'每周次数',value:'目标值',bow:'弓种',favorite:'常用',archived:'已归档'} as Record<string,string>)[key]??key}：${String(v)}`).join('\n');
}
function ConflictItem({item,value,onChange}:{item:CloudConflict;value?:'local'|'remote';onChange:(value:'local'|'remote')=>void}){
  return <Panel title={item.label}><p>{item.kind==='edit-delete'?'一端删除，另一端修改。':'同一项在两端分别修改。'}选择后，这一整项以所选版本为准。</p><details><summary>查看本机与云端内容</summary><p><b>本机</b></p><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',maxHeight:'45vh',overflow:'auto'}}>{describe(item.local,item.collection)}</pre><p><b>云端</b></p><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',maxHeight:'45vh',overflow:'auto'}}>{describe(item.remote,item.collection)}</pre></details><div className="actions"><Button aria-pressed={value==='local'} kind={value==='local'?'primary':''} onClick={()=>onChange('local')}>{item.local===null?'采用本机删除':'保留本机版本'}</Button><Button aria-pressed={value==='remote'} kind={value==='remote'?'primary':''} onClick={()=>onChange('remote')}>{item.remote===null?'采用云端删除':'保留云端版本'}</Button></div></Panel>;
}

/** Full account flow; mounting it does not itself bind or upload the local archive. */
export function CloudPanel({onBack,startup=false,section,onSecondaryLogin}:{onBack?:()=>void;startup?:boolean;section?:string;onSecondaryLogin?:(active:boolean)=>void}={}){
  const {data,update,open,tell,ask}=useApp(),status=useSyncExternalStore(cloudSync.subscribe,cloudSync.getStatus,cloudSync.getStatus);
  const [email,setEmail]=useState(''),[password,setPassword]=useState(''),[newPassword,setNewPassword]=useState(''),[confirmPassword,setConfirmPassword]=useState(''),[code,setCode]=useState(''),[verifyType,setVerifyType]=useState<'signup'|'recovery'>('recovery');
  const [testRoute,setTestRoute]=useState<'phone'|'email'|'legacy'>('phone');
  const codeDigits=otpLength(testRoute==='email'?'email':'phone');
  const [otpStage,setOtpStage]=useState<'entry'|'verify'>('entry'),[phone,setPhone]=useState(''),[otpDestination,setOtpDestination]=useState('');
  const [otpMode,setOtpMode]=useState<'login'|'register'>('login'),[otpTick,setOtpTick]=useState(0);
  const [config,setConfig]=useState(()=>cloudConfig(data)),[choices,setChoices]=useState<Resolutions>({}),[advanced,setAdvanced]=useState(false);
  const retrySeconds=cloudSync.otpRetrySeconds(testRoute==='email'?'email':'phone',otpDestination||(testRoute==='email'?email:phone));
  useEffect(()=>{if(retrySeconds===0)return;const timer=window.setTimeout(()=>setOtpTick(otpTick+1),1000);return()=>window.clearTimeout(timer);},[otpTick,retrySeconds]);
  useEffect(()=>{void cloudSync.initialize({read:()=>repository.data,update,pending:()=>!!repository.pending}).catch(error=>tell(error.message));},[update,tell]);
  useEffect(()=>{setChoices({});},[status.conflicts]);
  useEffect(()=>{setNewPassword('');setConfirmPassword('');},[status.recoveryEmail]);
  useEffect(()=>()=>{cloudSync.cancelRecovery();},[]);
  async function act(action:()=>Promise<void>){try{await action();}catch(error){tell(error instanceof Error?error.message:'账号操作未完成，本机资料保留');}}
  async function submit(mode:'login'|'register'){
    if(!email.trim()||!email.includes('@')){tell('填写有效邮箱');return;}if(!password){tell('请输入密码');return;}if(mode==='register'&&newPasswordError(password)){tell(PASSWORD_RULE);return;}
    const secret=password;setPassword('');await act(async()=>{
      if(mode==='login')await cloudSync.login(email,secret);
      else await cloudSync.register(email,secret);
    });
  }
  async function sendTestOtp(resend=false){
    const kind=testRoute==='phone'?'phone':'email';
    const destination=resend?otpDestination:kind==='phone'?'+86'+phone:email.trim();
    if(kind==='phone'?!/^\+861[3-9]\d{9}$/.test(destination):!/^\S+@\S+\.\S+$/.test(destination)){
      tell(kind==='phone'?'请输入有效的 11 位中国大陆手机号':'请输入有效邮箱');return;
    }
    await act(async()=>{await cloudSync.sendOtp(kind,destination,otpMode==='register');setOtpDestination(destination);setCode('');setOtpStage('verify');setOtpTick(tick=>tick+1);});
  }
  async function verifyTestOtp(){
    const token=code.trim();if(token.length!==codeDigits||!/^\d+$/.test(token)){tell(`请输入 ${codeDigits} 位验证码`);return;}
    const kind=testRoute==='phone'?'phone':'email';setCode('');
    await act(async()=>{await cloudSync.verifyOtp(kind,otpDestination,token);setOtpStage('entry');setOtpDestination('');});
  }
  function selectTestRoute(route:'phone'|'email'|'legacy'){
    if(status.busy)return;setTestRoute(route);setOtpStage('entry');setOtpMode('login');setOtpDestination('');setCode('');setPassword('');
  }
  async function bind(){
    const switching=!!status.boundEmail;
    const choice=await ask(switching?'切换本机训练账号':'绑定本机训练资料',switching?`当前资料属于 ${maskEmail(status.boundEmail)}。切换时会在本机隔离保留该账号全部资料，再载入 ${maskEmail(status.email)} 的本机隔离档案或云资料；不会把原账号资料上传给新账号。`:`将本机的记录、计划、器材、靶面、日历、目标和个人训练资料绑定到 ${maskEmail(status.email)}，之后与该账号双向同步。照片和视频文件不上传。首次合并若同项资料不同，会逐项请你选择。`,['取消',switching?'隔离保存并切换':'确认绑定']);
    if(choice!==1)return;await act(async()=>{await cloudSync.bind();await cloudSync.sync();});
  }
  if(communityTestOnly)return <AccountAccess startup={startup} onBack={onBack} section={section} onSecondaryLogin={onSecondaryLogin}/>;

  if(status.recoveryEmail)return <Panel title="设置新密码"><p>已验证 {maskEmail(status.recoveryEmail)}，原账号与训练资料保留。</p><p className="caption">{PASSWORD_RULE}</p><Field label="设置新密码"><input type="password" value={newPassword} onChange={e=>setNewPassword(e.target.value)}/></Field><Field label="确认新密码"><input type="password" value={confirmPassword} onChange={e=>setConfirmPassword(e.target.value)}/></Field><Button disabled={status.busy} onClick={()=>void act(async()=>{if(newPassword!==confirmPassword)throw new Error('两次输入的密码不一致');await cloudSync.updatePassword(newPassword);setNewPassword('');setConfirmPassword('');})}>保存新密码</Button><Button disabled={status.busy} onClick={()=>cloudSync.cancelRecovery()}>取消找回</Button></Panel>;

  return <><Back title="账号与云同步" onBack={onBack??(()=>open('profile'))}/><Panel title={status.owner?maskEmail(status.email)||'已登录':'登录弓行记'}><p role="status">{status.message}</p><p>全部训练先真实保存在本机。同步包括完整训练资料与文字复盘；照片、视频文件和设备配置不上传。</p>{status.lastSync&&<p>最近成功同步：{new Date(status.lastSync).toLocaleString()} · {status.dirty?'本机还有更新':'已核对当前本机资料'}</p>}
    {status.owner?<><div className="actions">{status.needsBinding?<Button kind="primary" disabled={status.busy} onClick={()=>void bind()}>{status.boundEmail?'切换到此账号的资料':'确认资料归属并同步'}</Button>:<Button kind="primary" disabled={status.busy||status.phase==='conflict'} onClick={()=>void act(()=>cloudSync.sync())}>立即同步</Button>}<Button disabled={status.busy} onClick={()=>void act(()=>cloudSync.logout())}>退出登录</Button></div><p>退出仅清除登录凭据，本机资料仍保留原账号归属。切换账号后，可再登录原账号恢复其本机隔离资料。</p><details><summary>修改密码</summary><p className="caption">{PASSWORD_RULE}</p><Field label="新密码"><input type="password" autoComplete="new-password" minLength={8} value={newPassword} onChange={e=>setNewPassword(e.target.value)}/></Field><Button disabled={status.busy} onClick={()=>{const secret=newPassword;setNewPassword('');void act(()=>cloudSync.updatePassword(secret));}}>更新密码</Button></details></>:<><Field label="邮箱"><input type="email" autoComplete="email" value={email} onChange={e=>setEmail(e.target.value)}/></Field><Field label="密码"><input type="password" autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)}/></Field><div className="actions"><Button kind="primary" disabled={status.busy||status.phase==='unconfigured'} onClick={()=>void submit('login')}>登录</Button><Button disabled={status.busy||status.phase==='unconfigured'} onClick={()=>void submit('register')}>注册</Button></div><details><summary>找回密码或验证注册邮箱</summary><p>邮件发送由账号服务处理。验证码与验证链接只用于这次账号操作，不保存在训练档案中。</p><Button disabled={status.busy||!email.trim()} onClick={()=>void act(()=>cloudSync.recover(email))}>发送找回邮件</Button><Field label="验证用途"><select value={verifyType} onChange={e=>setVerifyType(e.target.value as 'signup'|'recovery')}><option value="recovery">找回密码</option><option value="signup">确认注册</option></select></Field><Field label="邮件验证码或验证链接"><input type="text" autoComplete="one-time-code" value={code} onChange={e=>setCode(e.target.value)}/></Field><Button disabled={status.busy||!code.trim()} onClick={()=>{const token=code;setCode('');void act(()=>cloudSync.verify(email,token,verifyType));}}>验证邮箱</Button></details></>}
  </Panel>
  {status.conflicts.length>0&&<><Panel title="两端资料需要核对"><p>独立新增或修改已经自动合并。下列同项冲突需要逐项选择；取消页面不会丢失本机记录，下次会重新核对。</p></Panel>{status.conflicts.map(item=><ConflictItem key={item.key} item={item} value={choices[item.key]} onChange={value=>setChoices({...choices,[item.key]:value})}/>)}<Button kind="primary" disabled={status.busy||status.conflicts.some(item=>!choices[item.key])} onClick={()=>void act(()=>cloudSync.resolve(choices))}>保存所选版本并继续同步</Button></>}
  {cloudSync.getRecoveryArchiveBackups().length>0&&<Panel title="恢复前的隔离档案"><p>这些是本机资料恢复之前，为当前账号保留的已有档案版本。可导出为标准备份，之后通过资料恢复入口取回；不会自动覆盖当前训练。</p>{cloudSync.getRecoveryArchiveBackups().map((archive,index)=><div className="list-row" key={archive.id}><span>{new Date(archive.savedAt).toLocaleString()}<small>{archive.data.sessions.length} 场 · {archive.data.plans.length} 个计划</small></span><Button onClick={()=>{try{exportText(`gongxingji-before-recovery-${archive.savedAt.slice(0,10)}-${index+1}.json`,JSON.stringify(archive.data,null,2),'application/json');tell('已打开备份保存；以系统完成提示为准');}catch(error){tell(error instanceof Error?error.message:'备份导出失败');}}}>导出备份</Button></div>)}</Panel>}
  <Panel><Button onClick={()=>open("legacy-account")}>查看旧版云记录（只读）</Button><p className="caption">旧接口的历史仍保留；不把缺少字段的旧记录猜测成新格式。</p></Panel><Panel><Button onClick={()=>setAdvanced(!advanced)} aria-expanded={advanced}>高级服务设置</Button>{advanced&&<><p>测试服务地址与公开客户端密钥可以随安装包提供。修改服务前请先退出账号；服务端秘密密钥不能填在这里。</p><Field label="资料服务地址"><input type="url" value={config.api} onChange={e=>setConfig({...config,api:e.target.value.trim()})}/></Field><Field label="Supabase 项目地址"><input type="url" value={config.auth} onChange={e=>setConfig({...config,auth:e.target.value.trim()})}/></Field><Field label="公开客户端密钥"><input type="text" autoComplete="off" value={config.publicKey} onChange={e=>setConfig({...config,publicKey:e.target.value.trim()})}/></Field><Button disabled={status.busy||!!status.owner} onClick={()=>void act(async()=>{const {validateCloudConfig}=await import('./api');validateCloudConfig(config);if(await update(d=>{d.connection={...config};})){await cloudSync.configurationChanged();tell('服务设置已保存在本机');}})}>保存服务设置</Button></>}</Panel></>;
}
export const Cloud=CloudPanel;
