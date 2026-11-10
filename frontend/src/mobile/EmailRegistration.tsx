import React,{useEffect,useRef,useState,useSyncExternalStore} from 'react';
import {cloudSync} from './cloud-sync';
import {createEnrollmentStorage,newEnrollmentResume,type EnrollmentDraft} from './email-enrollment-storage';
import type {EnrollmentStatus} from './email-enrollment-contract';
import {canonicalEnrollmentEmail} from './email-enrollment-contract';
import {Button,Field} from './ui';
import {maskEmail} from './account-display';
import {EnrollmentNotStartedError} from './api';

/** Reopening reads progress only. Sending always requires an explicit button press. */
export function EmailRegistration(){
 const [enrollmentStorage]=useState(()=>createEnrollmentStorage());
 const account=useSyncExternalStore(cloudSync.subscribe,cloudSync.getStatus,cloudSync.getStatus);
 const [email,setEmail]=useState(''),[draft,setDraft]=useState<EnrollmentDraft|null>(null),[progress,setProgress]=useState<EnrollmentStatus|null>(null);
 const [correctable,setCorrectable]=useState(false);
 const [code,setCode]=useState(''),[error,setError]=useState(''),[ready,setReady]=useState(false),[working,setWorking]=useState(false),[retryAt,setRetryAt]=useState(0),[expiresAt,setExpiresAt]=useState(0),[tick,setTick]=useState(0);
 const epoch=useRef(0),inFlight=useRef(false),busy=working||account.busy;
 const complete=progress?.registrationComplete===true&&!!progress.owner;
 const seconds=Math.max(0,Math.ceil((retryAt-Date.now())/1000)),canVerify=!complete&&!!progress?.canVerify&&expiresAt>Date.now();
 useEffect(()=>{if(seconds||canVerify){const timer=setTimeout(()=>setTick(t=>t+1),1000);return()=>clearTimeout(timer);}},[seconds,canVerify,tick]);
 const apply=(p:EnrollmentStatus)=>{setProgress(p);setRetryAt(Date.now()+p.retryAfter*1000);setExpiresAt(Date.now()+p.expiresIn*1000);setCode('');};
 useEffect(()=>{
  const generation=++epoch.current;let disposed=false;
  void (async()=>{try{const saved=await enrollmentStorage.read();if(disposed)return;if(saved&&saved.service!==cloudSync.enrollmentService())throw new Error('注册进度属于另一个服务，已保留；请先恢复原服务配置');setDraft(saved);setReady(true);if(saved?.enrollment){const state=await cloudSync.emailEnrollmentStatus('status',{email:saved.email,resume:saved.resume,enrollment:saved.enrollment});if(!disposed&&generation===epoch.current)apply(state);}}catch(e){if(!disposed)setError(e instanceof Error?e.message:'注册进度未能读取');}})();
  return()=>{disposed=true;epoch.current++;cloudSync.cancelEmailEnrollment();};
 },[]);
 const act=async(work:(generation:number)=>Promise<void>)=>{if(inFlight.current)return;inFlight.current=true;setWorking(true);setError('');const generation=epoch.current;try{await work(generation);}catch(e){if(generation===epoch.current)setError(e instanceof Error?e.message:'注册尚未完成，请重新读取进度');}finally{inFlight.current=false;if(generation===epoch.current)setWorking(false);}};
 const adopt=async(current:EnrollmentDraft,state:EnrollmentStatus,generation:number)=>{if(generation!==epoch.current)return;const next={...current,enrollment:state.enrollment};await enrollmentStorage.write(next);if(generation===epoch.current){setDraft(next);apply(state);}};
 const start=()=>void act(async generation=>{
  let current=draft;
  if(!current){const target=canonicalEnrollmentEmail(email);if(!target)throw new Error('请输入格式正确、能接收邮件的本人邮箱');current={version:1,service:cloudSync.enrollmentService(),email:target,resume:newEnrollmentResume(),enrollment:null,createdAt:new Date().toISOString()};await enrollmentStorage.write(current);if(generation!==epoch.current)return;setDraft(current);setEmail('');}
  setCorrectable(false);
  try{const state=await cloudSync.emailEnrollmentStatus('start',{email:current.email,resume:current.resume});await adopt(current,state,generation);}
  catch(e){if(e instanceof EnrollmentNotStartedError&&!current.enrollment&&generation===epoch.current)setCorrectable(true);throw e;}
 });
 const request=(action:'status'|'resend')=>void act(async generation=>{if(!draft?.enrollment)throw new Error('请继续本次注册请求');const state=await cloudSync.emailEnrollmentStatus(action,{email:draft.email,resume:draft.resume,enrollment:draft.enrollment});await adopt(draft,state,generation);});
 const verify=()=>void act(async generation=>{
  if(!draft?.enrollment||!progress?.attempt||!progress.owner||!canVerify)throw new Error('请先读取当前注册状态');
  const token=code;setCode('');
  try{await cloudSync.verifyEmailEnrollment({email:draft.email,resume:draft.resume,enrollment:draft.enrollment,attempt:progress.attempt,token},progress.owner);}
  catch(e){if(generation===epoch.current){try{const latest=await cloudSync.emailEnrollmentStatus('status',{email:draft.email,resume:draft.resume,enrollment:draft.enrollment});if(generation===epoch.current)apply(latest);}catch{/* Preserve original failure; never resend. */}}throw e;}
 });
 return <div className="email-registration">
  <p className="account-step">第 1 步 · 验证邮箱</p>
  {error&&<p role="alert" className="account-error">{error}</p>}
  {!ready?<p role="status">{error?'注册进度未能载入，原内容已保留。':'正在读取注册进度；不会发送验证码。'}</p>:!draft?<form onSubmit={e=>{e.preventDefault();if(!busy)start();}}>
   <Field label="邮箱"><input type="email" autoComplete="email" autoCapitalize="none" spellCheck={false} maxLength={254} value={email} disabled={busy} onChange={e=>setEmail(e.target.value)}/></Field>
   <Button type="submit" kind="primary" className="wide" disabled={busy||!email.trim()}>发送邮箱验证码</Button>
  </form>:<>
   <p>本次注册：{maskEmail(draft.email)}</p>
   {!draft.enrollment?<><p className="caption">注册请求尚未确认。继续会接续同一次请求，若先前未送达服务才会首次发送。</p><Button disabled={busy} onClick={start}>继续本次注册请求</Button>{correctable&&<Button disabled={busy} onClick={()=>void act(async generation=>{await enrollmentStorage.write(null);if(generation===epoch.current){setEmail(draft.email);setDraft(null);setProgress(null);setCorrectable(false);}})}>更正邮箱</Button>}</>:<>
    {complete?<><p role="status">本次注册已经完成。请返回登录，使用已验证的手机号或已设置的密码登录。</p><Button disabled={busy} onClick={()=>void act(async generation=>{await enrollmentStorage.write(null);if(generation===epoch.current){setDraft(null);setProgress(null);setCorrectable(false);setCode('');}})}>结束本次注册</Button></>:<>
    {progress?.emailVerified&&<p role="status">邮箱核验记录已保存。本机尚未取得登录，请本人准备收信后重新验证以继续；不会创建另一个账号。</p>}
    {progress?.delivery==='unknown'&&<p role="status">投递结果尚未确认；若已收到邮件，可填写本次验证码。</p>}
    {canVerify&&<form onSubmit={e=>{e.preventDefault();if(!busy&&/^[0-9]{6,10}$/.test(code))verify();}}><Field label="邮箱验证码"><input type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={10} value={code} disabled={busy} onChange={e=>setCode(e.target.value.replace(/\D/g,''))}/></Field><Button type="submit" kind="primary" className="wide" disabled={busy||!/^[0-9]{6,10}$/.test(code)}>验证邮箱并继续</Button></form>}
    <div className="actions"><Button disabled={busy} onClick={()=>request('status')}>读取注册进度</Button><Button disabled={busy||!progress?.canResend||seconds>0} onClick={()=>request('resend')}>{seconds?`${seconds} 秒后可重发`:progress?.canResend?'重新发送验证码':'请先读取进度后重发'}</Button></div>
    {progress&&!canVerify&&!progress.emailVerified&&<p className="caption">当前验证码暂不可核验，请读取进度后再决定是否重发。</p>}
    </>}
   </>}
  </>}
  <p className="caption">验证邮箱后还需验证本人手机号。返回会保留注册进度，密码可在注册完成后设置。</p>
 </div>;
}
