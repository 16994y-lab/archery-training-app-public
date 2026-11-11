import {AccountOverview} from './AccountOverview';
import {AccountDeletionEntry} from './AccountDeletion';
import {MainlandPhoneInput} from './MainlandPhoneInput';
import {ContributionLoginActions} from './PhotoContribution';
import {photoContributions} from './photo-contribution-runtime';
import React,{useId,useEffect,useRef,useState,useSyncExternalStore} from 'react';
import {cloudSync} from './cloud-sync';
import {mainlandPhone,otpLength} from './api';
import {phoneOtpReady,existingEmailOtpLoginReady,manualBackupReady,emailEnrollmentReady,accountDeletionReady} from './release-mode';
import {EmailRegistration} from './EmailRegistration';
import {ManualBackupPanel} from './ManualBackupPanel';
import {Back,Button,Field,Panel,useApp} from './ui';
import {EmailSecurity,EmailPasswordRecovery} from './EmailSecurity';
import {AccountChannelAccess} from './AccountChannelAccess';
import {CloudSavePanels} from './CloudSavePanels';
import {PhonePasswordRecovery} from './PhonePasswordRecovery';
import {PasswordField} from './PasswordField';
import {PASSWORD_RULE,requireNewPassword} from './password-policy';
import {maskEmail} from './account-display';
import {UsageNotice} from './UsageNotice';
import './account-access.css';
import {RegistrationInvitationFlow,registrationRewardsReady} from './registration-invitation';
import {invitationPhoneReady,readInvitationChoice,rememberInvitationCode,restoreInvitationPhone,finishInvitationChoice} from './registration-invitation-choice';

function PhoneEntry({value,onChange,disabled,password=false}:{value:string;onChange:(value:string)=>void;disabled:boolean;password?:boolean}){
 const id=useId();return <div className="field"><label htmlFor={id}>手机号</label><span className="account-phone-field"><span className="account-country" aria-hidden="true">+86</span><MainlandPhoneInput id={id} aria-label="中国大陆 +86 手机号" autoComplete={password?'username':'tel-national'} placeholder="11 位手机号" value={value} disabled={disabled} onValueChange={onChange}/></span></div>;
}

/** A pending email identity may only verify its own phone or sign out. */
export function AccountAccess({startup=false,section,onBack}:{startup?:boolean;section?:string;onBack?:()=>void}){
 const {open}=useApp(),status=useSyncExternalStore(cloudSync.subscribe,cloudSync.getStatus,cloudSync.getStatus);
 const accountService=cloudSync.enrollmentService();
 const verifiedAccount=!!status.owner&&status.authVerified;
 const unifiedLogin=!status.authVerified&&(status.reauthenticationRequired===true||!!status.owner&&!status.phoneVerified);
 const loginEntry=!status.owner||unifiedLogin;
 const [route,setRoute]=useState<'phone'|'email'|'email-otp'|'phone-password'>('phone'),[mode,setMode]=useState<'login'|'register'>('login');
 const [reconnecting,setReconnecting]=useState(false);
 const [phone,setPhone]=useState(''),[email,setEmail]=useState(''),[password,setPassword]=useState(''),[confirm,setConfirm]=useState(''),[code,setCode]=useState(''),[destination,setDestination]=useState(''),[error,setError]=useState(''),[tick,setTick]=useState(0);
 const [reset,setReset]=useState(false),[working,setWorking]=useState(false);
 const inFlight=useRef(false),smsCode=useRef<HTMLInputElement>(null),pendingSmsFocus=useRef(false),smsCodeId=useId();
 const emailVerificationInFlight=useRef(false),smsEpoch=useRef(0),mounted=useRef(true),smsInFlight=useRef<number|null>(null);
 const [smsWorking,setSmsWorking]=useState(false),[smsNotice,setSmsNotice]=useState(''),[invitationWorking,setInvitationWorking]=useState(false);
 const previousEmail=useRef(status.email);
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;smsEpoch.current++;if(emailVerificationInFlight.current)cloudSync.cancelPendingOtpLogin();cloudSync.cancelRegistrationPresentation();};},[]);
 const [bindingNotice,setBindingNotice]=useState('');
 const invitationInput=useRef<HTMLInputElement>(null),[,redrawInvitation]=useState(0);
 const [skippedPhone,setSkippedPhone]=useState<{service:string;phone:string}|null>(null);
 const skipInvitation=skippedPhone?.service===accountService && skippedPhone.phone===(destination||phone).replace(/^\+86/,'');
 const setSkipInvitation=(skip:boolean)=>setSkippedPhone(skip?{service:accountService,phone:(destination||phone).replace(/^\+86/,'')}:null);
 const [resumeInvitation,setResumeInvitation]=useState(false),[canRestartInvitation,setCanRestartInvitation]=useState(false),[invitationMessage,setInvitationMessage]=useState(''),[invitationFlow]=useState(()=>new RegistrationInvitationFlow());
 const invitationChoice=readInvitationChoice(accountService),invitationCode=invitationChoice.code;
 const editInvitation=(value:string)=>{
  if(smsInFlight.current!==null)return;
  if(value.trim()||invitationChoice.kind==='selected'||invitationChoice.code)rememberInvitationCode(accountService,value,destination||phone);
  setResumeInvitation(false);setInvitationMessage('');setError('');redrawInvitation(n=>n+1);
 };
 const invitationRequest=(action:'prepare'|'read'|'status'|'complete',body:Record<string,unknown>={})=>cloudSync.registrationRewardsCall(action,body);
 const readInvitation=()=>void act(async()=>{const service=cloudSync.enrollmentService(),owner=cloudSync.getStatus().owner,state=await invitationFlow.read(service,invitationRequest);if(cloudSync.enrollmentService()!==service||cloudSync.getStatus().owner!==owner)throw new Error('账号或服务已变化，邀请结果未采用');setResumeInvitation(state==='prepared'||state==='bound');setCanRestartInvitation(state==='expired'||state==='missing');setInvitationMessage(state==='prepared'?'邀请码选择已保存，可继续原手机号验证':state==='bound'?'新建尝试已记录，完成原手机号验证后核对资格':state==='rejected'?'上次邀请准备未受理，请核对邀请码后重试':state==='none'?'没有已保存的邀请码选择':state==='expired'||state==='missing'?'原邀请准备已失效。请填写本轮邀请码，再点“重新准备邀请码”；不会自动发送短信。':'原准备结果仍无法确认，不会自动重发');});
 const restartInvitation=()=>void(async()=>{
  if(smsInFlight.current!==null||busy)return;
  const attempt=++smsEpoch.current,service=cloudSync.enrollmentService(),owner=cloudSync.getStatus().owner;
  const current=()=>mounted.current&&smsEpoch.current===attempt&&cloudSync.enrollmentService()===service&&cloudSync.getStatus().owner===owner;
  smsInFlight.current=attempt;setInvitationWorking(true);setError('');
  try{await invitationFlow.restart(service,mainlandPhone(destination||phone),invitationCode,invitationRequest);if(!current())return;setCanRestartInvitation(false);setResumeInvitation(true);setSkipInvitation(false);setInvitationMessage('本轮邀请码已准备，可点击获取验证码。原进度已保留。');}
  catch(e){if(current())setError(e instanceof Error?e.message:'邀请准备未能确认，请读取原进度');}
  finally{if(current()){smsInFlight.current=null;setInvitationWorking(false);}}
 })();
 const [emailRecovery,setEmailRecovery]=useState(false);
 const [recoveryChoices,setRecoveryChoices]=useState(false),[phoneRecovery,setPhoneRecovery]=useState(false);
 const recoveryChoicesId=useId();
 const pending=verifiedAccount&&!status.phoneVerified,seconds=cloudSync.otpRetrySeconds(route==='email-otp'?'email':'phone',destination||(route==='email-otp'?email:phone)),busy=status.busy||working;
 const sendingSms=smsWorking||cloudSync.otpSendPending('phone',destination||phone),invitationLocked=sendingSms||invitationWorking;
 const emailRoute=route==='email'||route==='email-otp',emailDigits=otpLength('email');
 const verifyingOriginal=!unifiedLogin&&reconnecting&&!!status.owner&&status.phoneVerified===true&&!status.authVerified;
 useEffect(()=>{if(seconds>0){const t=setTimeout(()=>setTick(tick+1),1000);return()=>clearTimeout(t);}},[seconds,tick]);
 useEffect(()=>{smsEpoch.current++;smsInFlight.current=null;setSmsWorking(false);setInvitationWorking(false);setSmsNotice('');pendingSmsFocus.current=false;setPassword('');setConfirm('');setCode('');setDestination('');setReset(false);setRecoveryChoices(false);setPhoneRecovery(false);setEmailRecovery(false);setError('');setBindingNotice('');setSkipInvitation(false);setResumeInvitation(false);setCanRestartInvitation(false);setInvitationMessage('');},[status.owner,status.authVerified,accountService]);
 useEffect(()=>{
  let active=true;
  if(registrationRewardsReady&&!status.owner&&/^1[3-9]\d{9}$/.test(phone))
   void restoreInvitationPhone(accountService,phone,()=>active).then(()=>{if(active)redrawInvitation(n=>n+1);});
  return ()=>{active=false;};
 },[accountService,status.owner,phone]);
 useEffect(()=>{if(!previousEmail.current&&status.email&&status.phoneVerified){setReset(true);setBindingNotice('邮箱已添加。手机号与邮箱共用登录密码，可在这里设置或修改。');}previousEmail.current=status.email;},[status.email,status.phoneVerified]);
 // Transfer focus only when a new SMS step opens, never on countdown or resend.
 useEffect(()=>{if(destination&&!busy&&pendingSmsFocus.current&&smsCode.current){pendingSmsFocus.current=false;smsCode.current.focus();}},[destination,busy]);
 useEffect(()=>{if(section!=='security'){setPassword('');setConfirm('');setReset(false);}},[section]);
 const act=async(work:()=>Promise<void>)=>{if(inFlight.current)return;inFlight.current=true;setWorking(true);setError('');try{await work();}catch(e){setError(e instanceof Error?e.message:'操作未完成，请重试');}finally{inFlight.current=false;setWorking(false);}};
 const invalidateSms=()=>{smsEpoch.current++;smsInFlight.current=null;setSmsWorking(false);setInvitationWorking(false);setSmsNotice('');};
 const clearEntry=()=>{invalidateSms();if(emailVerificationInFlight.current)cloudSync.cancelPendingOtpLogin();pendingSmsFocus.current=false;cloudSync.cancelRegistrationPresentation();setDestination('');setCode('');setPassword('');setConfirm('');setError('');setRecoveryChoices(false);setPhoneRecovery(false);};
 const changeRoute=(value:'phone'|'email'|'email-otp'|'phone-password')=>{clearEntry();setMode('login');setRoute(value);};
 const changeMode=(value:'login'|'register')=>{clearEntry();setMode(value);if(value==='register'&&route==='phone-password')setRoute('phone');if(value==='register'&&route==='email-otp')setRoute('email');};
 const send=()=>void (async()=>{
  if(smsInFlight.current!==null||busy)return;
  const attempt=++smsEpoch.current,service=cloudSync.enrollmentService(),owner=cloudSync.getStatus().owner,verified=cloudSync.getStatus().authVerified;
  const current=()=>mounted.current&&smsEpoch.current===attempt&&cloudSync.enrollmentService()===service&&cloudSync.getStatus().owner===owner&&cloudSync.getStatus().authVerified===verified;
  smsInFlight.current=attempt;setSmsWorking(true);setError('');setSmsNotice('');
  try{
   const target=mainlandPhone(destination||phone);
   let capability:string|undefined;
   if(!pending&&!owner&&!skipInvitation){
    // Autofill and mobile keyboards may update the native control before React.
    const typed=invitationInput.current?.value.trim();
    if(typed!==undefined && typed!==invitationCode){
     rememberInvitationCode(service,typed,target);redrawInvitation(n=>n+1);
    }
    const choice=registrationRewardsReady?await restoreInvitationPhone(service,target,current):readInvitationChoice(service);
    if(!current())return;
    if(choice.kind==='unavailable')throw new Error('当前邀请码选择未能核对，请重新填写后重试，或明确选择本次不使用邀请码。');
    if(choice.kind==='selected'||resumeInvitation){
     if(!registrationRewardsReady)throw new Error('邀请服务暂未就绪，请稍后重试。');
     if(choice.kind==='selected'&&!choice.code)throw new Error('本次已选择使用邀请码，请重新填写后重试，或明确选择本次不使用邀请码。');
     try{
      capability=await invitationFlow.prepare(service,target,choice.code,invitationRequest,resumeInvitation);
      if(!capability||!/^[A-Za-z0-9_-]{43}$/.test(capability))throw new Error('邀请准备尚未确认');
     }catch(e){throw new Error(`${e instanceof Error?e.message:'邀请准备未完成'}。尚未发送验证码，请核对后重试，或明确选择本次不使用邀请码。`);}
    }else if(registrationRewardsReady&&await invitationFlow.unfinishedRequest(service,target)){
     throw new Error('这个手机号有未完成的邀请准备。请读取已保存的邀请进度，或明确选择本次不使用邀请码。');
    }
   }
   if(!current())return;
   const receipt=pending?await cloudSync.startPhoneBinding(target):await cloudSync.sendOtp('phone',target,!owner,capability);
   if(!current())return;
   if(!destination)pendingSmsFocus.current=true;
   setDestination(target);setSmsNotice(receipt.message);setTick(t=>t+1);
  }catch(e){if(current())setError(e instanceof Error?e.message:'验证码申请未能确认，请先核对收到的短信');}
  finally{if(current()){smsInFlight.current=null;setSmsWorking(false);}}
 })();
 // The visible code field also accepts an already received SMS. It never sends
 // implicitly, and both paths still use the same real verification boundary.
 const verify=(choice?:'participate'|'decline')=>void act(async()=>{
  invalidateSms();
  if(!phoneOtpReady)throw new Error('短信验证尚未开放');
  const target=mainlandPhone(destination||phone),token=code.trim(),service=accountService;
  if(!/^\d{6}$/.test(token))throw new Error('请输入 6 位验证码');
  const finishEntry=registrationRewardsReady&&!status.owner&&!pending&&!verifyingOriginal;
  const revision=finishEntry?readInvitationChoice(service).revision:undefined;
  let originalRequest:string|null=null;
  if(finishEntry)try{originalRequest=await invitationFlow.unfinishedRequest(service,target);}catch{/* Authentication still works if local cleanup is unavailable. */}
  if(cloudSync.enrollmentService()!==service||cloudSync.getStatus().owner!==status.owner)throw new Error('账号或服务已变化，请重新核对');
  setCode('');
  if(pending)await cloudSync.verifyPhoneBinding(target,token);
  else await photoContributions.login(choice,async()=>{
   await cloudSync.verifyOtp('phone',target,token,verifyingOriginal?status.owner??undefined:undefined);
   if(finishEntry&&cloudSync.registrationRewardsOwner()&&cloudSync.enrollmentService()===service){
    try{
     if(revision)await finishInvitationChoice(service,target,revision);
     if(originalRequest)await invitationFlow.finishRequest(service,target,originalRequest);
    }catch{setInvitationMessage('手机号已验证，本机邀请草稿清理待核对。');}
   }
  });
  setDestination('');
  if(registrationRewardsReady&&!pending&&!verifyingOriginal){
   try{
    await invitationFlow.completeOnce(invitationRequest,()=>cloudSync.registrationRewardsOwner());
   }catch{setInvitationMessage('邀请核对结果待确认，登录和本机训练保持；可在账号页读取结果。');}
  }
 });
 const submitPhonePassword=(choice?:'participate'|'decline')=>void act(async()=>{const target=mainlandPhone(phone);if(!password)throw new Error('请输入密码');const secret=password;setPassword('');await photoContributions.login(choice,()=>cloudSync.loginPhone(target,secret));});
 const submitEmail=(choice?:'participate'|'decline')=>void act(async()=>{const address=email.trim();if(!/^\S+@\S+\.\S+$/.test(address)||address.length>254)throw new Error('请输入有效邮箱');if(!password)throw new Error('请输入密码');const secret=password;setPassword('');await photoContributions.login(choice,()=>cloudSync.login(address,secret));});
 const sendEmailLogin=()=>void act(async()=>{if(!existingEmailOtpLoginReady)throw new Error('邮箱验证码登录尚未开放');const address=(destination||email).trim().toLowerCase();if(!/^\S+@\S+\.\S+$/.test(address)||address.length>254)throw new Error('请输入有效邮箱');await cloudSync.sendOtp('email',address,false);pendingSmsFocus.current=true;setDestination(address);setCode('');setTick(t=>t+1);});
 const verifyEmailLogin=(choice?:'participate'|'decline')=>void act(async()=>{const token=code.trim();if(token.length!==emailDigits||!/^\d+$/.test(token))throw new Error(`请输入 ${emailDigits} 位验证码`);setCode('');emailVerificationInFlight.current=true;try{await photoContributions.login(choice,()=>cloudSync.verifyOtp('email',destination,token));setDestination('');}finally{emailVerificationInFlight.current=false;}});
 const hub=!startup&&verifiedAccount&&status.phoneVerified;
 const security=hub&&section==='security';
 if(emailRecovery)return <section className="account-access"><EmailPasswordRecovery onClose={()=>setEmailRecovery(false)}/></section>;
 if(phoneRecovery)return <section className="account-access"><PhonePasswordRecovery returnToAccount={security} onClose={()=>setPhoneRecovery(false)}/></section>;
 const back=onBack??(()=>open(section?'account':'profile'));
 if(hub&&(section==='cloud'||section==='cloud-conflicts'))return <section className="account-access account-detail">
  <Back title={section==='cloud'?'云保存':'核对云保存冲突'} onBack={back} label={section==='cloud'?'返回账号中心':'返回云保存'}/>
  <CloudSavePanels conflictsOnly={section==='cloud-conflicts'}/>
  {section==='cloud'&&manualBackupReady&&<ManualBackupPanel owner={status.owner!} email={status.email} busy={busy}/>}
 </section>;
 if(hub&&section==='deletion'&&accountDeletionReady)return <section className="account-access account-detail"><Back title="账号管理" onBack={back} label="返回账号中心"/><AccountDeletionEntry key={status.owner}/></section>;
 if(hub&&section!=='security')return <AccountOverview status={status} onBack={back}/>;
 const recoveryControl=<div className="account-recovery-control">
  <Button type="button" className="account-forgot" aria-expanded={recoveryChoices} aria-controls={recoveryChoices?recoveryChoicesId:undefined} disabled={busy} onClick={()=>{setRecoveryChoices(!recoveryChoices);setPassword('');setConfirm('');setCode('');}}>忘记密码？</Button>
  {recoveryChoices&&<div id={recoveryChoicesId} className="account-recovery-choices" role="group" aria-label="选择找回方式">
   <p>选择已经验证的安全渠道</p>
   <Button type="button" disabled={busy} onClick={()=>{clearEntry();setPhoneRecovery(true);}}>使用手机验证码找回</Button>
   <Button type="button" disabled={busy} onClick={()=>{clearEntry();setEmailRecovery(true);}}>使用邮箱验证码找回密码</Button>
   <p className="caption">邮箱找回需要先在账号安全中完成邮箱验证。</p>
  </div>}
 </div>;
 return <section className={hub?"account-access account-security":"account-access"}>
  {hub?<Back title="账号安全" onBack={back} label="返回账号中心"/>:!startup&&status.localAllowed&&!unifiedLogin&&<Button className="account-back-link" onClick={back}>‹ 返回</Button>}
  <Panel className="account-card" title={unifiedLogin?'登录弓行记':pending?'验证手机，完成注册':status.owner&&!unifiedLogin?'账号与登录':emailRoute?'邮箱登录':route==='phone-password'?'手机号密码登录':'首次注册或登录'}>
   {loginEntry&&<>
    {unifiedLogin&&<p role="status">请重新登录，继续使用账号服务。已有训练资料保留。</p>}
    {!status.owner&&!emailRoute&&route==='phone'&&<p className="caption">未注册手机号验证后创建账号，已注册手机号验证后登录。</p>}
    <div className="account-tabs account-login-ways" role="group" aria-label="登录方式">
     <Button type="button" aria-pressed={route==='phone'} aria-label={route==='phone'?'验证码登录':'返回验证码登录'} disabled={busy} onClick={()=>{if(route!=='phone')changeRoute('phone');}}>验证码登录</Button>
     <Button type="button" aria-pressed={route==='phone-password'} disabled={busy} onClick={()=>{if(route!=='phone-password')changeRoute('phone-password');}}>使用密码登录</Button>
     <Button type="button" aria-pressed={emailRoute} disabled={busy} onClick={()=>{if(!emailRoute)changeRoute('email');}}>邮箱登录</Button>
    </div>
    {emailRoute&&emailEnrollmentReady&&<div className="account-mode" role="group" aria-label="邮箱登录或注册"><Button type="button" aria-pressed={mode==='login'} disabled={busy} onClick={()=>changeMode('login')}>登录</Button><Button type="button" aria-pressed={mode==='register'} disabled={busy} onClick={()=>changeMode('register')}>首次注册</Button></div>}
    {mode==='login'&&emailRoute&&existingEmailOtpLoginReady&&<div className="account-secondary"><span>{route==='email-otp'?'验证码登录':'密码登录'}</span><Button type="button" disabled={busy} onClick={()=>changeRoute(route==='email-otp'?'email':'email-otp')}>{route==='email-otp'?'使用密码':'使用邮箱验证码'}</Button></div>}
   </>}
   {error&&<p role="alert" className="account-error">{error}</p>}
   {status.owner&&!pending&&!verifyingOriginal&&!unifiedLogin?<>
    <p>{status.authVerified?'已登录':busy?'账号操作正在处理中':'已保存账号，等待连接确认'}{security&&status.email?` · ${maskEmail(status.email)}`:''}</p><p>{security?'手机已验证，重开应用无需重复收码。':busy?'请稍候，本机训练记录保留。':'联网确认后可继续，已有训练保存在本机。'}</p>
    {!security&&<Button disabled={busy} onClick={()=>void act(()=>cloudSync.verifySession())}>重新连接已保存账号</Button>}
    {!status.authVerified&&<Button disabled={busy} onClick={()=>{clearEntry();setRoute('phone');setMode('login');setReconnecting(true);}}>使用原手机号重新验证</Button>}
    {security&&<>{bindingNotice&&<p role="status">{bindingNotice}</p>}<Button disabled={busy} onClick={()=>{setReset(!reset);setPassword('');setConfirm('');}}>设置登录密码</Button>{reset&&<form onSubmit={event=>{event.preventDefault();if(busy)return;void act(async()=>{requireNewPassword(password);if(password!==confirm)throw new Error('两次输入的密码不一致');const secret=password;setPassword('');setConfirm('');try{await cloudSync.updatePassword(secret);}catch(e){throw new Error(`密码保存未能确认，已有登录渠道保留。${e instanceof Error?e.message:'请稍后核对重试'}`);}setBindingNotice('登录密码已保存，已绑定的手机号和邮箱共用此密码。');setReset(false);});}}>
     <p className="caption">{PASSWORD_RULE}</p>
     <PasswordField key="reset-password" label="新密码" value={password} onChange={setPassword} disabled={busy} autoComplete="new-password"/>
     <PasswordField key="reset-confirm" label="再次输入新密码" value={confirm} onChange={setConfirm} disabled={busy} autoComplete="new-password"/>
     <Button type="submit" disabled={busy||!password||!confirm}>保存新密码</Button>
    </form>}</>}
    {security&&phoneOtpReady&&<Button disabled={busy} onClick={()=>{clearEntry();setPhoneRecovery(true);}}>使用手机验证码找回</Button>}
    {!security&&<Button disabled={busy} onClick={()=>void act(()=>cloudSync.logout())}>切换账号</Button>}
   </>:<>
    {verifyingOriginal&&<><p>请验证原账号手机号。已有登录和训练资料保留，验证为其它账号时不会采用。</p><Button type="button" disabled={busy} onClick={()=>{clearEntry();setReconnecting(false);}}>取消重新验证</Button></>}
    {pending&&<><p className="account-step">第 2 步 · 验证手机</p><p>验证当前账号的本人手机号后，即可开始训练。</p><p className="caption">手机号已属于其他账号时，请使用原账号登录。</p></>}
    {!pending&&route==='email'&&mode==='register'?(emailEnrollmentReady?<EmailRegistration/>:<p role="status">邮箱验证码注册正在接入，可先使用手机号注册。</p>):<form className="account-entry-form" onSubmit={event=>{event.preventDefault();if(busy)return;if(pending||route==='phone'){if(phoneOtpReady&&(destination||phone.trim())&&code.length===6)verify();}else if(route==='phone-password'){if(phone.trim()&&password)submitPhonePassword();}else if(route==='email-otp'){if(destination&&code.length===emailDigits)verifyEmailLogin();else if(!destination&&email.trim()&&seconds===0&&existingEmailOtpLoginReady)sendEmailLogin();}else if(email.trim()&&password)submitEmail();}}>
    {pending||route==='phone'?<>
     <PhoneEntry value={phone} onChange={value=>{invalidateSms();setSkipInvitation(false);setPhone(value);setError('');}} disabled={busy||invitationLocked||!!destination}/>

     <div className="field account-sms-field"><label htmlFor={smsCodeId}>验证码</label><div className="account-code-entry"><input id={smsCodeId} ref={smsCode} aria-label="6 位短信验证码" inputMode="numeric" type="text" autoComplete="one-time-code" placeholder="输入 6 位验证码" maxLength={6} value={code} disabled={busy} onChange={e=>setCode(e.target.value.replace(/\D/g,''))}/><Button type="button" className="account-sms-send" disabled={busy||invitationLocked||!(destination||phone.trim())||seconds>0||!phoneOtpReady} onClick={send}>{sendingSms?'正在申请…':seconds>0?`${seconds} 秒后重发`:destination?'重新获取':'获取验证码'}</Button></div></div>
     {registrationRewardsReady&&!pending&&!verifyingOriginal&&!status.owner&&<details className="review-data-details"><summary>注册邀请码（可选）</summary><Field label="邀请码"><input ref={invitationInput} value={invitationCode} maxLength={32} autoComplete="off" spellCheck={false} disabled={busy||invitationLocked||!!destination||skipInvitation||!invitationPhoneReady(phone)} onChange={event=>editInvitation(event.target.value)}/></Field><p className="caption">填过邀请码后，获取验证码会先核对本次邀请。清空输入后可重新填写，或勾选本次不使用邀请码。</p><label className="check"><input type="checkbox" checked={skipInvitation} disabled={busy||invitationLocked||!!destination} onChange={event=>setSkipInvitation(event.target.checked)}/>本次不使用邀请码，保留原进度</label><Button type="button" disabled={busy||invitationLocked} onClick={readInvitation}>读取已保存的邀请进度</Button>{canRestartInvitation&&<Button type="button" disabled={busy||invitationLocked||!!destination||skipInvitation} onClick={restartInvitation}>{invitationWorking?'正在准备…':'重新准备邀请码'}</Button>}{invitationMessage&&<p role="status">{invitationMessage}</p>}</details>}
     <p className="caption account-code-hint">验证码有效期以服务核验为准，已收到可直接填写。换设备或重新打开页面仍需遵守同一号码的发送间隔。</p>
     {sendingSms&&<p role="status">{loginEntry?'正在发送，请稍候，可切换密码登录':'正在发送，请稍候'}</p>}
     {smsNotice&&<p role="status">{smsNotice}</p>}
     {destination&&<Button type="button" className="account-text-link account-change-phone" disabled={busy} onClick={()=>{invalidateSms();setDestination('');setCode('');setError('');}}>更换手机号</Button>}
     {pending||verifyingOriginal?<Button type="submit" kind="primary" className="wide" disabled={busy||!phoneOtpReady||!(destination||phone.trim())||code.length!==6}>{pending?'验证手机并进入训练':verifyingOriginal?'验证原账号并进入训练':'首次注册或登录'}</Button>:<ContributionLoginActions disabled={busy||!phoneOtpReady||!(destination||phone.trim())||code.length!==6} label={pending?'验证手机并进入训练':verifyingOriginal?'验证原账号并进入训练':'首次注册或登录'} onLogin={verify}/>}
     {!phoneOtpReady&&<p role="status">短信接线正在验收，发送尚未开放。</p>}
    </>:route==='phone-password'?<>
     <PhoneEntry value={phone} onChange={setPhone} disabled={busy} password/>
     <PasswordField key="phone-login-password" label="密码" value={password} onChange={setPassword} disabled={busy} autoComplete="current-password"/>
     {recoveryControl}
     <p className="caption">使用已验证的手机号和登录密码。尚未设密，可先用短信登录后设置。</p>
     <ContributionLoginActions disabled={busy||!phone.trim()||!password} label="使用手机号和密码登录" onLogin={submitPhonePassword}/>
    </>:route==='email-otp'?<>
     <p className="caption">使用原账号已验证的邮箱登录，无需修改密码。首次使用请先完成手机号注册。</p>
     {!destination?<><Field label="已验证邮箱"><input type="email" autoComplete="username" inputMode="email" autoCapitalize="none" spellCheck={false} maxLength={254} value={email} disabled={busy} onChange={e=>setEmail(e.target.value)}/></Field><Button type="submit" kind="primary" className="wide" disabled={busy||!email.trim()||seconds>0||!existingEmailOtpLoginReady}>{seconds>0?`${seconds} 秒后可发送`:'发送邮箱登录验证码'}</Button></>:<><Field label={`${emailDigits} 位邮箱验证码`}><input ref={smsCode} type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={emailDigits} value={code} disabled={busy} onChange={e=>setCode(e.target.value.replace(/\D/g,''))}/></Field><ContributionLoginActions disabled={busy||code.length!==emailDigits} label="验证并进入训练" onLogin={verifyEmailLogin}/><Button type="button" disabled={busy} onClick={clearEntry}>返回填写邮箱</Button></>}
     {recoveryControl}
    </>:<>
     <Field label="邮箱"><input type="email" autoComplete="username" inputMode="email" autoCapitalize="none" spellCheck={false} value={email} disabled={busy} onChange={e=>setEmail(e.target.value)}/></Field>
     <PasswordField key={mode+'-password'} label="密码" value={password} onChange={setPassword} disabled={busy} autoComplete={mode==='register'?'new-password':'current-password'}/>
     {recoveryControl}
     <p className="caption">使用已绑定邮箱和密码登录。尚未设密可返回手机号验证码入口。</p>
     <ContributionLoginActions disabled={busy||!email.trim()||!password} label="使用邮箱密码登录" onLogin={submitEmail}/>
    </>}
    </form>}
    {pending&&<Button disabled={busy} onClick={()=>void act(()=>cloudSync.logout())}>退出此账号</Button>}
   </>}
   {loginEntry&&<UsageNotice/>}
  </Panel>
  {security&&<><EmailSecurity key={status.owner+':'+status.email}/><AccountChannelAccess/>
   {emailEnrollmentReady&&<Button disabled={busy} onClick={()=>void act(()=>cloudSync.resumeCompletedRegistration())}>核对未完成的首次注册介绍</Button>}
   <Panel title="当前设备"><p className="caption">退出后，本机已保存的训练保留在当前账号下。</p><Button disabled={busy} onClick={()=>void act(()=>cloudSync.logout())}>退出登录</Button></Panel>
  </>}
 </section>;
}
