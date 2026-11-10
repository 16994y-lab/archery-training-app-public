import {MainlandPhoneInput} from './MainlandPhoneInput';
import {ChoiceSelect} from './ChoiceSelect';
import React,{useEffect,useMemo,useState,useSyncExternalStore} from 'react';
import {ChannelChangeClient,allowedActions,normalizeTarget,channelCodeLength,type Actor,type Action,type ChannelKind,type ChannelTransport} from './channel-change-client';
import './account-channel-panel.css';

/** Root injects original-session transport. No localStorage, OTP/session adoption,
 * mount send, automatic retry or automatic cancelled-holding release. */
export function AccountChannelPanel({actor,transport,emailEnabled=false,phoneEnabled=false}:{actor:Actor;transport:ChannelTransport;emailEnabled?:boolean;phoneEnabled?:boolean}){
 const channelId=React.useId();
 const client=useMemo(()=>new ChannelChangeClient(actor,transport),[transport]);
 const v=useSyncExternalStore(client.subscribe,client.getSnapshot,client.getSnapshot);
 const [kind,setKind]=useState<ChannelKind>('email'),[target,setTarget]=useState(''),[oldCode,setOldCode]=useState(''),[newCode,setNewCode]=useState(''),[lost,setLost]=useState(false),[localError,setLocalError]=useState('');
 useEffect(()=>{client.changeActor(actor);setTarget('');setOldCode('');setNewCode('');setLocalError('');},[client,actor.owner,actor.sessionEpoch]);
 useEffect(()=>{client.activate();return()=>client.dispose();},[client]);
 const r=v.receipt,actualKind=(r?.state==='none'||r?.state==='completed')?kind:(r?.kind??kind),enabled=actualKind==='email'?emailEnabled:phoneEnabled,a=allowedActions(r,enabled,v.resultUnknown);
 const run=(action:Action,leg?:'old'|'new')=>{
  if(v.busy)return;setLocalError('');
  const code=leg==='new'?newCode:oldCode;
  if(action==='verify'||action==='old-verify'){setOldCode('');setNewCode('');}
  try{
   const body=action==='status'?{}:action==='target-check'?{kind:actualKind,target:normalizeTarget(actualKind,target)}:action==='begin'?{kind:actualKind,target:normalizeTarget(actualKind,target),lost_channel:actualKind==='phone'&&lost}:action==='cancel'||action==='reconcile'||action==='old-start'?{intent:r!.intent}:{intent:r!.intent,target:normalizeTarget(actualKind,target),...(action==='verify'?{leg,token:code}:action==='old-verify'?{token:code}:{})};
   void client.perform(action,body,enabled);
  }catch(e){setLocalError(e instanceof Error?e.message:'输入无效。');}
 };
 const held=r&&['cancelled_holding','expired_holding','invalidated'].includes(r.state);
 const codeField=(label:string,value:string,set:(v:string)=>void,action:Action,leg:'old'|'new')=>{
  const length=channelCodeLength(actualKind,action==='old-verify'?'authority':'native');
  return <form onSubmit={e=>{e.preventDefault();if(!v.busy&&value.length===length)run(action,leg);}}><label>{label}<input inputMode="numeric" autoComplete="off" pattern={'[0-9]{'+length+'}'} maxLength={length} value={value} disabled={v.busy} onChange={e=>set(e.target.value.replace(/\D/g,''))}/></label><button type="submit" disabled={v.busy||value.length!==length||!target.trim()}>确认{leg==='old'?'原渠道':'新渠道'}</button></form>;
 };
 return <section className="account-channel-panel" aria-label="账号渠道更换" aria-busy={v.busy}>
  <h3>更换邮箱或手机号</h3><p>保留原账号和训练记录。重新打开后只读取状态，发送和验码都需手动操作。</p>
  <button disabled={v.busy} onClick={()=>run('status')}>读取当前更换状态</button>
  {(v.error||localError)&&<p role="alert">{localError||v.error}</p>}{v.notice&&<p role="status">{v.notice}</p>}
  {r?.state==='none'||r?.state==='completed'?<div className="field"><label htmlFor={channelId}>要更换的渠道</label><ChoiceSelect id={channelId} aria-label="要更换的渠道" appearance="aurora" value={kind} disabled={v.busy} onChange={e=>{setKind(e.target.value as ChannelKind);setTarget('');setOldCode('');setNewCode('');}}><option value="email">邮箱</option><option value="phone">手机号</option></ChoiceSelect></div>:null}
  <label>{actualKind==='email'?'本次新邮箱':'本次新手机号（中国大陆）'}{actualKind==='phone'?<MainlandPhoneInput autoComplete="off" placeholder="11 位手机号" value={target} disabled={v.busy} onValueChange={setTarget}/>:<input type="email" autoComplete="off" autoCapitalize="none" spellCheck={false} value={target} maxLength={254} disabled={v.busy} onChange={e=>setTarget(e.target.value)}/>}</label>
  {a.has('begin')&&<>{actualKind==='phone'&&<label><input type="checkbox" checked={lost} onChange={e=>setLost(e.target.checked)} disabled={v.busy}/>原手机号无法收码（须由当前已证明邮箱授权）</label>}<button disabled={v.busy||!target.trim()} onClick={()=>run('target-check')}>核查目标是否可用</button><button disabled={v.busy||!target.trim()} onClick={()=>run('begin')}>建立更换请求</button></>}
  {a.has('old-start')&&<button disabled={v.busy} onClick={()=>run('old-start')}>向原安全渠道发送授权验证码</button>}
  {a.has('old-verify')&&codeField(`原${r?.authorityKind==='email'?'邮箱':'手机号'}验证码`,oldCode,setOldCode,'old-verify','old')}
  {a.has('request')&&<button disabled={v.busy||!target.trim()} onClick={()=>run('request')}>{actualKind==='email'?'发送原邮箱与新邮箱两封确认邮件':'向新手机号发送验证码'}</button>}
  {a.has('verify')&&<>{actualKind==='email'&&!r?.authorityVerified&&codeField('原邮箱验证码',oldCode,setOldCode,'verify','old')}{!r?.newVerified&&codeField(actualKind==='email'?'新邮箱验证码':'新手机号验证码',newCode,setNewCode,'verify','new')}</>}
  {v.resultUnknown&&<p role="status">上次结果未知。先读取或对账，不重发、不重验。</p>}
  {held&&<p role="status">{r.releaseRecorded===true&&r.reservationHeld===false?'已有安全释放记录。可手动重新核查目标；建立新请求时后台仍会重新核对。':'请求已停止，目标预约仍可能保留。等待安全核查；未确认释放前不能重新使用此目标。'}</p>}
  {a.has('reconcile')&&<button disabled={v.busy} onClick={()=>run('reconcile')}>对账已有请求</button>}
  {a.has('cancel')&&<button disabled={v.busy} onClick={()=>run('cancel')}>停止已有请求</button>}
  {r?.state==='completed'&&r.kind===actualKind&&<button disabled={v.busy||!target.trim()} onClick={()=>void client.confirm(r.kind!,target)}>核对原账号的当前渠道</button>}
  {!enabled&&<p>新的渠道更换尚未开放；已有请求仍可读取和对账。</p>}
 </section>;
}
