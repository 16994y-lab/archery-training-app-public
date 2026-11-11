import React,{useEffect,useRef,useState,useSyncExternalStore} from 'react';
import {cloudSync} from './cloud-sync';
import {emailOtpReady} from './release-mode';
import {Button,Field,Panel} from './ui';
import type {EmailSecurityStatus,EmailBindingStatus} from './api';
import {PasswordField} from './PasswordField';
import {PASSWORD_RULE,requireNewPassword} from './password-policy';
import {maskEmail} from './account-display';

/** Proof never accepts or persists a native email-login session. */
export function EmailSecurity(){
 const status=useSyncExternalStore(cloudSync.subscribe,cloudSync.getStatus,cloudSync.getStatus);
 const [proof,setProof]=useState<EmailSecurityStatus|null>(null),[challenge,setChallenge]=useState(''),[code,setCode]=useState(''),[error,setError]=useState(''),[notice,setNotice]=useState(''),[retryAt,setRetryAt]=useState(0),[tick,setTick]=useState(0);
 const inFlight=useRef(false),[working,setWorking]=useState(false);
 const identityKey=status.owner+':'+status.email,latestIdentity=useRef(identityKey),alive=useRef(true),requestedProof=useRef('');latestIdentity.current=identityKey;
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 const busy=status.busy||working;
 const seconds=Math.max(0,Math.ceil((retryAt-Date.now())/1000));
 useEffect(()=>{if(seconds){const timer=setTimeout(()=>setTick(v=>v+1),1000);return()=>clearTimeout(timer);}},[seconds,tick]);
 const read=async()=>{setError('');try{const result=await cloudSync.emailSecurityStatus();setProof(result);setChallenge(result.challenge??'');setRetryAt(Date.now()+result.retryAfter*1000);setCode('');}catch(e){setError(e instanceof Error?e.message:'邮箱验证状态未能读取');}};
 useEffect(()=>{setProof(null);setChallenge('');setCode('');setError('');requestedProof.current='';},[status.owner,status.email,status.phoneVerified]);
 useEffect(()=>{if(!emailOtpReady||!status.email||!status.phoneVerified||status.busy||requestedProof.current===identityKey)return;requestedProof.current=identityKey;void cloudSync.emailSecurityStatus().then(result=>{if(alive.current&&latestIdentity.current===identityKey){setProof(result);setChallenge(result.challenge??'');setRetryAt(Date.now()+result.retryAfter*1000);}}).catch(e=>{if(alive.current&&latestIdentity.current===identityKey)setError(e instanceof Error?e.message:'邮箱验证状态未能读取');});},[identityKey,status.email,status.phoneVerified,status.busy]);
 const act=async(work:()=>Promise<void>)=>{if(inFlight.current)return;inFlight.current=true;setWorking(true);setError('');try{await work();}catch(e){setError(e instanceof Error?e.message:'邮箱验证未能完成');}finally{inFlight.current=false;setWorking(false);}};
 return <Panel title="账号安全">
  {status.phoneDisplay&&<p>已验证手机：{status.phoneDisplay}</p>}
  <p>手机已验证，可使用短信验证码登录和找回密码。</p>
  {!status.email?<EmailBinding/>:<>
   <p>登录邮箱：{maskEmail(status.email)}</p>
   <p>{proof?.emailVerified?'邮箱已验证，可使用邮箱验证码找回密码。':'验证一次邮箱后，可以增加邮箱验证码找回密码。平时邮箱密码登录无需重复收码。'}</p>
   {error&&<p role="alert" className="account-error">{error}</p>}{notice&&<p role="status">{notice}</p>}
   {!emailOtpReady?<p>邮箱安全验证暂不可用，请使用手机找回密码。</p>:<>
    {(!proof||error)&&<Button disabled={busy} onClick={()=>void read()}>重新读取邮箱状态</Button>}
    {proof&&!proof.emailVerified&&<>
     <Button disabled={busy||!proof.emailVerificationReady||seconds>0} onClick={()=>void act(async()=>{const result=await cloudSync.startEmailVerification();setChallenge(result.challenge);setCode('');setRetryAt(Date.now()+result.retryAfter*1000);setNotice(result.sent?'邮件已请求发送，请查看收件箱和垃圾邮件。':'邮件投递未能确认；若已收到邮件，可继续输入验证码。');})}>{seconds>0?`${seconds} 秒后可重发`:challenge?'重新发送邮箱验证码':'发送邮箱验证码'}</Button>
     {challenge&&<form onSubmit={event=>{event.preventDefault();if(busy||code.length!==6)return;void act(async()=>{const token=code;setCode('');await cloudSync.verifyEmailOwnership(challenge,token);setNotice('邮箱已验证。');setChallenge('');await read();});}}><Field label="6 位邮箱验证码"><input type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={e=>setCode(e.target.value.replace(/\D/g,''))}/></Field><Button type="submit" kind="primary" disabled={busy||code.length!==6}>验证邮箱</Button><p className="caption">本次验证码 5 分钟内有效；验证不会切换账号或上传训练。</p></form>}
    </>}
   </>}
  </>}
 </Panel>;
}

/** The server owns the pending operation; reopening never sends another email. */
function EmailBinding(){
 const account=useSyncExternalStore(cloudSync.subscribe,cloudSync.getStatus,cloudSync.getStatus);
 const [open,setOpen]=useState(false),[binding,setBinding]=useState<EmailBindingStatus|null>(null),[email,setEmail]=useState(''),[code,setCode]=useState(''),[error,setError]=useState(''),[notice,setNotice]=useState(''),[working,setWorking]=useState(false),[retryAt,setRetryAt]=useState(0),[tick,setTick]=useState(0);
 const mounted=useRef(true),inFlight=useRef(false),busy=account.busy||working;
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
 const seconds=Math.max(0,Math.ceil((retryAt-Date.now())/1000));
 useEffect(()=>{if(seconds){const timer=setTimeout(()=>setTick(t=>t+1),1000);return()=>clearTimeout(timer);}},[seconds,tick]);
 const apply=(result:EmailBindingStatus)=>{if(!mounted.current)return;setBinding(result);setRetryAt(Date.now()+result.retryAfter*1000);setCode('');};
 const act=async(work:()=>Promise<void>)=>{if(inFlight.current)return;inFlight.current=true;setWorking(true);setError('');try{await work();}catch(e){if(mounted.current)setError(e instanceof Error?e.message:'绑定未能完成，请重新读取状态');}finally{inFlight.current=false;if(mounted.current)setWorking(false);}};
 const read=()=>void act(async()=>{apply(await cloudSync.emailBindingStatus());});
 const pending=!!binding?.intent&&seconds>0;
 return <>
  <p>给当前手机账号添加本人邮箱，可增加邮箱密码登录和邮箱验证码找回。原手机号和训练记录保持。</p>
  {!emailOtpReady?<p>绑定邮箱暂未开放，当前可使用手机登录和找回。</p>:<>
   {!open?<Button disabled={busy} onClick={()=>{setOpen(true);read();}}>绑定邮箱</Button>:<>
    {error&&<p role="alert" className="account-error">{error}</p>}{notice&&<p role="status">{notice}</p>}
    <Button disabled={busy} onClick={read}>重新读取绑定状态</Button>
    {pending&&<p role="status">{binding?.canVerify?'已有绑定请求，请填写该次邮箱和收到的验证码。':'当前请求暂不可验码，请先读取状态；若仍不可验证，请等待后重新开始。'}{seconds} 秒后可重新请求邮件。</p>}
    {binding?.state==='verifying'&&<p>上次验证结果尚未确认，请先重新读取状态。</p>}
    <form onSubmit={event=>{event.preventDefault();if(busy||!binding)return;if(pending){if(!/^[0-9]{6,10}$/.test(code)||!binding.canVerify)return;void act(async()=>{const token=code;setCode('');try{await cloudSync.verifyEmailBinding(binding.intent!,email,token);}catch(error){try{apply(await cloudSync.emailBindingStatus());}catch{/* Preserve the original error and never resend. */}throw error;}});}else{void act(async()=>{const result=await cloudSync.startEmailBinding(email);apply(result);if(mounted.current)setNotice(result.delivery==='accepted'?'邮件已请求发送，请查看收件箱和垃圾邮件。':'投递结果尚未确认，请先检查收件箱并读取状态，避免重复请求。');});}}}>
     <Field label={pending?'本次绑定的邮箱':'本人邮箱'}><input type="email" inputMode="email" autoComplete="email" autoCapitalize="none" spellCheck={false} maxLength={254} value={email} disabled={busy} onChange={e=>setEmail(e.target.value)}/></Field>
     {pending&&binding?.canVerify&&<Field label="邮箱验证码"><input type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={10} value={code} disabled={busy} onChange={e=>setCode(e.target.value.replace(/\D/g,''))}/></Field>}
     <Button kind="primary" type="submit" disabled={busy||!binding||!email.trim()||(pending&&(!/^[0-9]{6,10}$/.test(code)||!binding.canVerify))}>{pending?'验证并绑定邮箱':'发送绑定验证码'}</Button>
     <p className="caption">请在本次请求开始后 5 分钟内完成。绑定后还需设置邮箱登录密码；关闭页面不会撤销已发送的验证码。</p>
    </form>
    <Button disabled={busy} onClick={()=>{setOpen(false);setEmail('');setCode('');setNotice('');}}>收起</Button>
   </>}
  </>}
 </>;
}

/** Reuse native recovery in a temporary client, keeping the App identity. */
export function EmailPasswordRecovery({onClose}:{onClose:()=>void}){
 useEffect(()=>()=>cloudSync.cancelRecovery(),[]);
 const status=useSyncExternalStore(cloudSync.subscribe,cloudSync.getStatus,cloudSync.getStatus);
 const [email,setEmail]=useState(''),[code,setCode]=useState(''),[password,setPassword]=useState(''),[confirm,setConfirm]=useState(''),[step,setStep]=useState<'request'|'code'|'password'>('request'),[error,setError]=useState(''),[notice,setNotice]=useState(''),[retryAt,setRetryAt]=useState(()=>Date.now()+cloudSync.emailRecoveryRetrySeconds()*1000),[tick,setTick]=useState(0);
 const inFlight=useRef(false),[working,setWorking]=useState(false);
 const busy=status.busy||working;
 const seconds=Math.max(0,Math.ceil((retryAt-Date.now())/1000));
 useEffect(()=>{if(seconds){const timer=setTimeout(()=>setTick(v=>v+1),1000);return()=>clearTimeout(timer);}},[seconds,tick]);
 const act=async(work:()=>Promise<void>)=>{if(inFlight.current)return;inFlight.current=true;setWorking(true);setError('');try{await work();}catch(e){setError(e instanceof Error?e.message:'找回未能完成');}finally{inFlight.current=false;setWorking(false);}};
 const close=()=>{cloudSync.cancelRecovery();setPassword('');setConfirm('');setCode('');onClose();};
 const validateEmail=()=>{if(!/^\S+@\S+\.\S+$/.test(email.trim()))throw new Error('请输入已在账号安全验证过的邮箱');};
 const send=()=>void act(async()=>{
  validateEmail();
  try{await cloudSync.recover(email.trim());setStep('code');setCode('');setNotice('如果此邮箱已验证并可用，请查看找回邮件。');}
  catch(error){setNotice('发送结果未能确认。若已收到找回邮件，可继续输入验证码；请勿连续重发。');throw error;}
  finally{setRetryAt(Date.now()+cloudSync.emailRecoveryRetrySeconds()*1000);}
 });
 const useReceivedCode=()=>void act(async()=>{validateEmail();setStep('code');setCode('');setNotice('请填写这次找回邮件中的验证码；此操作不会重新发送邮件。');});
 const verify=()=>void act(async()=>{const token=code;setCode('');await cloudSync.verify(email,token,'recovery');setStep('password');setNotice('验证码已核对，请设置新密码。');});
 const save=()=>void act(async()=>{requireNewPassword(password);if(password!==confirm)throw new Error('两次输入的密码不一致');const secret=password;setPassword('');setConfirm('');await cloudSync.updatePassword(secret);setStep('request');setNotice('密码已更新，请返回使用新密码登录。');});
 return <Panel className="account-recovery-card" title="邮箱验证码找回密码">
  <ol className="account-recovery-steps" aria-label="找回步骤">
   <li aria-current={step==='request'||step==='code'?'step':undefined}>1. 验证邮箱</li>
   <li aria-current={step==='password'?'step':undefined}>2. 设置新密码</li>
  </ol>
  <p>请使用已在账号安全验证过的邮箱；也可以返回使用手机验证码找回。</p>
  {!emailOtpReady&&<p role="status">邮箱验证码找回暂不可用，请返回使用手机验证码找回。</p>}
  {error&&<p role="alert" className="account-error">{error}</p>}{notice&&<p role="status">{notice}</p>}
  <form className="account-entry-form" onSubmit={event=>{event.preventDefault();if(busy)return;if(step==='request'){if(emailOtpReady&&seconds===0)send();}else if(step==='code'){if(/^\d{6,10}$/.test(code))verify();}else save();}}>
  {step!=='password'?<>
   <Field label="已验证的登录邮箱"><input type="email" autoComplete="email" value={email} disabled={busy||step==='code'} onChange={e=>setEmail(e.target.value)}/></Field>
   {step==='request'?<div className="actions">
    <Button type="submit" kind="primary" disabled={busy||seconds>0||!emailOtpReady}>{seconds?`${seconds} 秒后可重发`:'发送找回邮件'}</Button>
    <Button type="button" disabled={busy||!emailOtpReady||!email.trim()} onClick={useReceivedCode}>已收到验证码，继续验证</Button>
   </div>:<>
    <Field label="邮件验证码"><input type="text" inputMode="numeric" autoComplete="one-time-code" value={code} maxLength={10} onChange={e=>setCode(e.target.value.replace(/\D/g,''))}/></Field>
    <Button type="submit" kind="primary" className="wide" disabled={busy||!/^\d{6,10}$/.test(code)}>验证找回码</Button>
    <div className="actions"><Button type="button" disabled={busy||seconds>0||!emailOtpReady} onClick={send}>{seconds?`${seconds} 秒后可重发`:'重新发送找回邮件'}</Button></div>
   </>}
  </>:<>
   <p className="caption">{PASSWORD_RULE}</p><PasswordField label="新密码" value={password} onChange={setPassword} disabled={busy} autoComplete="new-password"/><PasswordField label="再次输入新密码" value={confirm} onChange={setConfirm} disabled={busy} autoComplete="new-password"/>
   <Button type="submit" kind="primary" className="wide" disabled={busy}>保存新密码</Button>
  </>}
  </form>
  <Button type="button" className="account-recovery-return" disabled={busy} onClick={close}>返回登录</Button>
 </Panel>;
}
