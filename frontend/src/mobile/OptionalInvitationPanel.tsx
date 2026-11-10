import React,{useEffect,useRef,useState} from 'react';
import type {Actor} from './channel-change-client';
type Result={owner:string;code?:string|null;attributed?:boolean;replayed?:boolean};
type InvitationTransport=(action:'status'|'create'|'attribute',body:Record<string,unknown>,actor:Actor,signal:AbortSignal)=>Promise<Result>;
/** Optional: no registration prerequisite, reward promise, auto attribution or
 * identity in shared text. Root transport keeps the original verified session. */
export function OptionalInvitationPanel({actor,transport,enabled=false}:{actor:Actor;transport:InvitationTransport;enabled?:boolean}){
 const [code,setCode]=useState(''),[mine,setMine]=useState(''),[attributed,setAttributed]=useState(false),[busy,setBusy]=useState(false),[notice,setNotice]=useState(''),[error,setError]=useState('');
 const generation=useRef(0),flight=useRef<AbortController|null>(null);
 useEffect(()=>{generation.current++;flight.current?.abort();flight.current=null;setCode('');setMine('');setAttributed(false);setBusy(false);setNotice('');setError('');return()=>{generation.current++;flight.current?.abort();};},[actor.owner,actor.sessionEpoch]);
 const perform=async(action:'status'|'create'|'attribute')=>{
  if(flight.current||!enabled&&action!=='status')return;
  const c=new AbortController(),g=generation.current;flight.current=c;setBusy(true);setError('');
  try{
   if(action==='attribute'&&!/^[A-Za-z0-9_-]{32}$/.test(code))throw new Error('请输入有效的32位邀请码。');
   const r=await transport(action,action==='attribute'?{code}:{},actor,c.signal);
   if(c.signal.aborted||g!==generation.current)return;
   if(r.owner!==actor.owner||r.code!=null&&!/^[A-Za-z0-9_-]{32}$/.test(r.code)||r.attributed!==undefined&&typeof r.attributed!=='boolean')throw new Error('邀请结果未能核对。');
   if(action==='attribute'&&r.attributed!==true)throw new Error('邀请来源尚未确认。');
   if(action==='status'){setMine(r.code??'');setAttributed(r.attributed===true);}
   else {if(typeof r.code==='string')setMine(r.code);if(r.attributed===true)setAttributed(true);}setNotice(action==='attribute'?'已记录邀请来源；不改变账号或训练归属。':'邀请状态已读取。');
  }catch(e){if(!c.signal.aborted&&g===generation.current)setError(e instanceof Error?e.message:'结果未知，请重新读取；不会自动重试。');}
  finally{if(!c.signal.aborted&&g===generation.current){flight.current=null;setBusy(false);}}
 };
 const share=async()=>{
  if(!mine)return;const text='弓行记邀请码：'+mine;
  try{if(navigator.share)await navigator.share({title:'弓行记邀请',text});else if(navigator.clipboard){await navigator.clipboard.writeText(text);setNotice('邀请码已复制。');}else setNotice('可手动复制下方邀请码。');}
  catch{setNotice('分享已取消或未完成。');}
 };
 return <section className="account-channel-panel" aria-label="可选邀请" aria-busy={busy}><h3>可选邀请</h3><p>可以跳过，不影响注册、登录或训练。没有默认奖励。</p>{error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}<button disabled={busy} onClick={()=>void perform('status')}>读取邀请状态</button>{enabled&&!mine&&<button disabled={busy} onClick={()=>void perform('create')}>创建我的邀请码</button>}{mine&&<><output>{mine}</output><button disabled={busy} onClick={()=>void share()}>主动分享邀请码</button></>}{enabled&&!attributed&&<form onSubmit={e=>{e.preventDefault();void perform('attribute');}}><label>他人的邀请码<input autoComplete="off" maxLength={32} value={code} disabled={busy} onChange={e=>setCode(e.target.value.trim())}/></label><button disabled={busy||code.length!==32}>记录邀请来源</button></form>}{attributed&&<p>已记录邀请来源，不可重复更换。</p>}</section>;
}
