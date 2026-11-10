import React,{useRef,useState} from 'react';
import {cloudSync} from './cloud-sync';
import {parseRegistration,registrationRewardsReady} from './registration-invitation';

export function RegistrationResult(){
 const [message,setMessage]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const lock=useRef(false);
 if(!registrationRewardsReady||!cloudSync.getStatus().authVerified)return null;
 async function read(){
  if(lock.current)return;
  const actor=cloudSync.registrationRewardsOwner();if(!actor)return;
  lock.current=true;setBusy(true);setError('');
  const current=()=>{const next=cloudSync.registrationRewardsOwner();return next?.owner===actor.owner&&next?.service===actor.service;};
  try{
   const value=parseRegistration(await cloudSync.registrationRewardsCall('status',{}));
   if(!current())return;
   if(value.owner!==actor.owner||value.service!==actor.service)throw new Error('账号已变化，邀请结果未采用');
   const notices:Record<string,string>={awarded:'本次邀请已核对，可刷新特别伙伴资格。',pending:'注册回执仍待核对。已保留原请求，请稍后读取。',registered_without_invite:'本次注册未使用邀请码',existing_or_unproven:'没有可核对的新注册回执，已有账号不能补填邀请码'};
   setMessage(notices[value.state]||'此邀请当前未产生有效资格');
  }catch(e){if(current())setError(e instanceof Error?e.message:'邀请结果暂时无法核对');}
  finally{lock.current=false;if(current())setBusy(false);}
 }
 return <section className="reward-card reward-receipt"><h2>本次邀请结果</h2><p role="status">{message||'可读取首次注册时留下的邀请回执。'}</p>{error&&<p role="alert">{error}</p>}<button type="button" onClick={()=>void read()} disabled={busy}>{busy?'正在核对…':'读取本次邀请结果'}</button></section>;
}
