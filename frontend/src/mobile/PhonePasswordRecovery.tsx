import {MainlandPhoneInput} from './MainlandPhoneInput';
import React,{useEffect,useRef,useState,useSyncExternalStore} from 'react';
import {cloudSync} from './cloud-sync';
import {mainlandPhone,PasswordOutcomeUnknownError,RecoverySessionExpiredError} from './api';
import {phoneOtpReady} from './release-mode';
import {Button,Field,Panel} from './ui';
import {PasswordField} from './PasswordField';
import {PASSWORD_RULE,requireNewPassword} from './password-policy';
import {maskPhone} from './account-display';

/** The verified session stays in memory until reset or cancellation. */
export function PhonePasswordRecovery({onClose,returnToAccount=false}:{onClose:()=>void;returnToAccount?:boolean}){
 const status=useSyncExternalStore(cloudSync.subscribe,cloudSync.getStatus,cloudSync.getStatus),accountService=cloudSync.enrollmentService();
 const [phone,setPhone]=useState(''),[target,setTarget]=useState(''),[code,setCode]=useState('');
 const [password,setPassword]=useState(''),[confirm,setConfirm]=useState('');
 const [step,setStep]=useState<'request'|'code'|'password'|'done'>('request');
 const [error,setError]=useState(''),[notice,setNotice]=useState(''),[working,setWorking]=useState(false),[tick,setTick]=useState(0),[loginChecked,setLoginChecked]=useState(false);
 const smsEpoch=useRef(0),mounted=useRef(true),smsPending=useRef(false),[sending,setSending]=useState(false);
 const inFlight=useRef(false),busy=status.busy||working,seconds=cloudSync.otpRetrySeconds('phone',target||phone);
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;smsEpoch.current++;cloudSync.cancelRecovery();};},[]);
 useEffect(()=>{smsEpoch.current++;smsPending.current=false;setSending(false);},[status.owner,status.authVerified,accountService]);
 useEffect(()=>{if(seconds){const timer=setTimeout(()=>setTick(v=>v+1),1000);return()=>clearTimeout(timer);}},[seconds,tick]);
 const act=async(work:()=>Promise<void>)=>{if(inFlight.current)return;inFlight.current=true;setWorking(true);setError('');try{await work();}catch(e){setError(e instanceof Error?e.message:'找回未能完成');}finally{inFlight.current=false;setWorking(false);}};
 const send=()=>void (async()=>{
  if(smsPending.current||busy)return;
  const epoch=++smsEpoch.current,service=cloudSync.enrollmentService(),owner=status.owner,verified=status.authVerified;
  const current=()=>mounted.current&&smsEpoch.current===epoch&&cloudSync.enrollmentService()===service&&cloudSync.getStatus().owner===owner&&cloudSync.getStatus().authVerified===verified;
  smsPending.current=true;setSending(true);setError('');setNotice('');
  try{const destination=mainlandPhone(target||phone),receipt=await cloudSync.sendOtp('phone',destination,false);if(!current())return;setTarget(destination);setCode('');setStep('code');setNotice(receipt.message);}
  catch(e){if(current())setError(e instanceof Error?e.message:'发送结果未确认，请先核对收到的短信');}
  finally{if(current()){smsPending.current=false;setSending(false);}}
 })();
 const invalidateSms=()=>{smsEpoch.current++;smsPending.current=false;setSending(false);};
 const useReceived=()=>void act(async()=>{invalidateSms();setTarget(mainlandPhone(phone));setCode('');setStep('code');setNotice('此操作不会重新发送短信。');});
 const verify=()=>void act(async()=>{invalidateSms();const token=code;if(!/^\d{6}$/.test(token))throw new Error('请输入 6 位验证码');setCode('');await cloudSync.verifyPhoneRecovery(target,token);setStep('password');setNotice('手机已验证，请设置新密码。');});
 const save=()=>void act(async()=>{
  requireNewPassword(password);if(password!==confirm)throw new Error('两次输入的密码不一致');
  const secret=password;setPassword('');setConfirm('');try{await cloudSync.updatePassword(secret);}catch(e){if(e instanceof PasswordOutcomeUnknownError){setStep('done');setPhone(target);setTarget('');setNotice(e.message);}else if(e instanceof RecoverySessionExpiredError){setCode('');setStep('code');setNotice('请重新核对验证码。需要新短信时由你点击发送，本页面不会自动发送。');}throw e;}
  setStep('done');setPhone(target);setTarget('');setNotice('密码已更新，请在下方用新密码核对原账号。');
 });
 const checkPassword=()=>void act(async()=>{const destination=mainlandPhone(phone),secret=password;if(!secret)throw new Error('请输入新密码');setPassword('');await cloudSync.loginPhone(destination,secret);setLoginChecked(true);setPhone('');setNotice('已用新密码登录核对原账号，本机训练资料保留。');});
 const close=()=>{invalidateSms();cloudSync.cancelRecovery();setPassword('');setConfirm('');setCode('');onClose();};
 return <Panel className="account-recovery-card" title="手机验证码找回密码">
  <ol className="account-recovery-steps" aria-label="找回步骤">
   <li aria-current={step==='request'||step==='code'?'step':undefined}>1. 验证手机</li>
   <li aria-current={step==='password'||step==='done'?'step':undefined}>2. 设置新密码</li>
  </ol>
  {error&&<p role="alert" className="account-error">{error}</p>}{notice&&<p role="status">{notice}</p>}
  {sending&&<p role="status">正在发送，请稍候，可返回登录使用密码</p>}
  {step!=='done'&&<form className="account-entry-form" onSubmit={event=>{event.preventDefault();if(busy)return;if(step==='request'){if(phoneOtpReady&&seconds===0)send();}else if(step==='code'){if(code.length===6)verify();}else save();}}>
   {step==='request'?<>
    <Field label="已绑定的中国大陆手机号"><MainlandPhoneInput autoComplete="tel-national" placeholder="11 位手机号" value={phone} disabled={busy||sending} onValueChange={setPhone}/></Field>
    <p className="caption">验证已绑定的手机后设置新密码。</p>
    <div className="actions">
     <Button type="submit" kind="primary" disabled={busy||sending||!phone.trim()||seconds>0||!phoneOtpReady}>{sending?'正在申请…':seconds?`${seconds} 秒后可发送`:'发送找回验证码'}</Button>
     <Button type="button" disabled={busy||!phone.trim()||!phoneOtpReady} onClick={useReceived}>已收到短信，继续验证</Button>
    </div>
   </>:step==='code'?<>
    <p>接收手机：{maskPhone(target)}</p>
    <Field label="6 位短信验证码"><input type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} disabled={busy} onChange={e=>setCode(e.target.value.replace(/\D/g,''))}/></Field>
    <Button type="submit" kind="primary" className="wide" disabled={busy||code.length!==6}>验证并设置新密码</Button>
    <div className="actions">
     <Button type="button" disabled={busy||sending||seconds>0||!phoneOtpReady} onClick={send}>{sending?'正在申请…':seconds?`${seconds} 秒后可重发`:'重新发送验证码'}</Button>
     <Button type="button" disabled={busy} onClick={()=>{invalidateSms();setTarget('');setCode('');setError('');setNotice('');setStep('request');}}>重新填写手机号</Button>
    </div>
   </>:<>
    <p className="caption">{PASSWORD_RULE}</p>
    <PasswordField label="新密码" value={password} onChange={setPassword} disabled={busy} autoComplete="new-password"/>
    <PasswordField label="再次输入新密码" value={confirm} onChange={setConfirm} disabled={busy} autoComplete="new-password"/>
    <Button type="submit" kind="primary" className="wide" disabled={busy||!password||!confirm}>保存新密码</Button>
   </>}
  </form>}
  {step==='done'&&!loginChecked&&<form className="account-entry-form" onSubmit={event=>{event.preventDefault();if(!busy)checkPassword();}}>
   <p>核对只验证登录，不会再次发送短信或提交改密。</p>
   <Field label="原账号手机号"><MainlandPhoneInput autoComplete="tel-national" placeholder="11 位手机号" value={phone} disabled={busy} onValueChange={setPhone}/></Field>
   <PasswordField label="新密码" value={password} onChange={setPassword} disabled={busy} autoComplete="current-password"/>
   <Button type="submit" disabled={busy||!phone.trim()||!password}>使用新密码核对登录</Button>
  </form>}
  {!phoneOtpReady&&step==='request'&&<p role="status">手机验证码找回暂不可用。</p>}
  <Button type="button" className="account-recovery-return" disabled={busy} onClick={close}>{returnToAccount?'返回账号':'返回登录'}</Button>
 </Panel>;
}
