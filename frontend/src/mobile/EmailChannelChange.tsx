import React,{useEffect,useRef,useState,useSyncExternalStore} from 'react';
import {cloudSync} from './cloud-sync';
import {emailChangeReady} from './release-mode';
import {Button,Field} from './ui';
import {changeEmail,type EmailChangeStatus} from './email-change-contract';

/** Reopening only reads. Target and OTP are deliberately not persisted. */
export function EmailChannelChange(){
 const account=useSyncExternalStore(cloudSync.subscribe,cloudSync.getStatus,cloudSync.getStatus);
 const [open,setOpen]=useState(false),[receipt,setReceipt]=useState<EmailChangeStatus|null>(null),[target,setTarget]=useState(''),[oldCode,setOld]=useState(''),[newCode,setNew]=useState(''),[error,setError]=useState(''),[notice,setNotice]=useState(''),[working,setWorking]=useState(false);
 const epoch=useRef(0),mounted=useRef(true),flight=useRef(false),identity=useRef('');
 const key=account.owner+':'+account.email;identity.current=key;
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;epoch.current++;};},[]);
 useEffect(()=>{epoch.current++;setOpen(false);setReceipt(null);setTarget('');setOld('');setNew('');setError('');setNotice('');setWorking(false);},[key]);
 const close=()=>{epoch.current++;setOpen(false);setReceipt(null);setTarget('');setOld('');setNew('');setError('');setNotice('');setWorking(false);};
 const act=async(work:(current:()=>boolean)=>Promise<void>)=>{
  if(flight.current)return;flight.current=true;setWorking(true);setError('');const e=epoch.current,k=identity.current;
  const current=()=>mounted.current&&epoch.current===e&&identity.current===k;
  try{await work(current);}catch(err){if(current())setError(err instanceof Error?err.message:'结果未确认，请重新读取状态');}
  finally{flight.current=false;if(current())setWorking(false);}
 };
 const apply=(result:EmailChangeStatus)=>{setReceipt(result);setOld('');setNew('');};
 const read=()=>void act(async current=>{const result=await cloudSync.emailChangeAction('status',{},current);if(current())apply(result);});
 const perform=(action:'begin'|'request'|'verify'|'cancel'|'reconcile',leg?:'old'|'new')=>void act(async current=>{
  const email=action==='cancel'?'':changeEmail(target),token=leg==='old'?oldCode:newCode;
  if(action==='verify'){setOld('');setNew('');}
  const body=action==='begin'?{kind:'email',target:email,lost_channel:false}:action==='cancel'||action==='reconcile'?{intent:receipt!.intent!}:{intent:receipt!.intent!,target:email,...(leg?{leg,token}: {})};
  const result=await cloudSync.emailChangeAction(action,body,current);if(!current())return;apply(result);
  if(result.state==='completed'){
   setNotice('后台已完成本次更换；请填写该次新邮箱核对原账号。');
   if(email){await cloudSync.confirmChangedEmail(email,current);if(current())setNotice('已核对原账号的新邮箱。请在账号安全中重新验证邮箱。');}
  }
 });
 if(!emailChangeReady||!account.authVerified||!account.owner||!account.email)return null;
 const busy=working||account.busy,active=!!receipt?.intent&&!['completed','cancelled_holding','expired_holding','invalidated'].includes(receipt.state),live=(receipt?.expiresIn??0)>0;
 return <div className="email-channel-change">
 {!open?<Button disabled={busy} onClick={()=>{setOpen(true);read();}}>更换邮箱</Button>:<>
  <h3>更换登录邮箱</h3><p>请分别确认原邮箱与新邮箱。本次操作保留原账号和训练记录。</p>
  {error&&<p role="alert" className="account-error">{error}</p>}{notice&&<p role="status">{notice}</p>}
  <Button disabled={busy} onClick={read}>重新读取更换状态</Button>
  <Button disabled={busy} onClick={()=>void act(async current=>{const result=await cloudSync.revalidateEmailChange(current);if(current()){apply(result);setNotice('已重新核验原账号并读取状态；没有重做更换请求。');}})}>重新核验当前登录</Button>
  <Field label="本次新邮箱"><input type="email" inputMode="email" autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={254} disabled={busy} value={target} onChange={e=>setTarget(e.target.value)}/></Field>
  <p className="caption">重开后请重新填写本次新邮箱；后台核对后才可继续，不会自动发送邮件。</p>
  {receipt?.state==='completed'&&<p>上次更换已完成。下一次更换前，请先验证当前邮箱，再填写新的目标邮箱。</p>}
  {(receipt?.state==='none'||receipt?.state==='completed')&&<Button disabled={busy||!target.trim()} onClick={()=>perform('begin')}>{receipt.state==='completed'?'开始下一次更换':'建立更换请求'}</Button>}
  {receipt?.state==='requesting'&&!receipt.requestClaimed&&live&&<Button disabled={busy||!target.trim()} onClick={()=>perform('request')}>发送两封确认邮件</Button>}
  {active&&receipt?.requestClaimed&&<p role="status">已有邮件请求，请检查两个收件箱；投递结果以收到的邮件为准。不会自动重发。</p>}
  {receipt?.state==='pending'&&live&&<>
   {!receipt.authorityVerified&&<form onSubmit={e=>{e.preventDefault();if(!busy&&oldCode.length===8&&target.trim())perform('verify','old');}}><Field label="原邮箱 8 位验证码"><input type="text" inputMode="numeric" autoComplete="off" maxLength={8} disabled={busy} value={oldCode} onChange={e=>setOld(e.target.value.replace(/\D/g,''))}/></Field><Button type="submit" disabled={busy||oldCode.length!==8||!target.trim()}>确认原邮箱</Button></form>}
   {!receipt.newVerified&&<form onSubmit={e=>{e.preventDefault();if(!busy&&newCode.length===8&&target.trim())perform('verify','new');}}><Field label="新邮箱 8 位验证码"><input type="text" inputMode="numeric" autoComplete="off" maxLength={8} disabled={busy} value={newCode} onChange={e=>setNew(e.target.value.replace(/\D/g,''))}/></Field><Button type="submit" disabled={busy||newCode.length!==8||!target.trim()}>确认新邮箱</Button></form>}
  </>}
  {['native_confirmed','completed'].includes(receipt?.state??'')&&<Button disabled={busy||!target.trim()} onClick={()=>receipt?.state==='completed'?void act(async current=>{await cloudSync.confirmChangedEmail(changeEmail(target),current);if(current())setNotice('已核对原账号的新邮箱；仍需重新验证邮箱。');}):perform('reconcile')}>核对原账号与新邮箱</Button>}
  {receipt&&['verifying','uncertain'].includes(receipt.state)&&<p role="status">上次结果尚未确认，请重新读取状态；不要再次发送或验码。</p>}
  {receipt&&['cancelled_holding','expired_holding','invalidated'].includes(receipt.state)&&<p role="status">本次请求已停止，地址占用仍保留，请联系支持核对后再开始。</p>}
  {active&&<Button disabled={busy} onClick={()=>perform('cancel')}>停止本次更换</Button>}
  <Button onClick={close}>收起更换邮箱</Button>
 </>}
 </div>;
}
