import React,{useEffect,useRef,useState,useSyncExternalStore} from 'react';
import {useLocation,useNavigate} from 'react-router-dom';
import {Back,Button,Field,Panel,useApp} from './ui';
import {cloudSync} from './cloud-sync';
import {allArrows,scoreValue,localDate} from './domain';
import type {MyTeam as Team,TeamMe,SharingGrant} from './team-api';
import {sameIdentity,httpStatus,newRewardRequestId} from './rewards-api';
import {withOperationsPendingLock} from './operations-pending';
import {rememberTeamInvitation,pendingTeamInvitation,clearTeamInvitation} from './team-invitation';
import './team.css';

const stateName:Record<string,string>={invited:'待接收邀请',pending:'等待教练核对',active:'已加入',inactive:'已停用'};
export function MyTeam({onBack}:{onBack:()=>void}){
 const {data,ask,tell}=useApp(),location=useLocation(),navigate=useNavigate(),status=useSyncExternalStore(cloudSync.subscribe,cloudSync.getStatus,cloudSync.getStatus),queue=cloudSync.getTeamQueue(),queueStatus=useSyncExternalStore(queue.subscribe,queue.getStatus,queue.getStatus);
 const [teams,setTeams]=useState<Team[]>([]),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[invite,setInvite]=useState(()=>{rememberTeamInvitation(location.search);return pendingTeamInvitation()||'';}),ticket=useRef(0),alive=useRef(true);
 const load=async()=>{const id=++ticket.current,owner=cloudSync.getStatus().owner,scope=cloudSync.teamLocalScope();setBusy(true);setMessage('');try{await cloudSync.ensureTeamIdentity();const me=await cloudSync.getTeamApi().request<TeamMe>('/api/team/me');if(!alive.current||ticket.current!==id||cloudSync.getStatus().owner!==owner)return;setTeams(me.teams.filter(team=>!!team.memberId));await queue.adopt(me,scope||undefined);await queue.enqueue();await queue.flush();}catch(e){if(alive.current&&ticket.current===id)setMessage(e instanceof Error?e.message:'团队读取暂未完成');}finally{if(alive.current&&ticket.current===id)setBusy(false);}};
 useEffect(()=>{alive.current=true;setTeams([]);void queue.initialize().catch(e=>setMessage(e.message));void load();return()=>{alive.current=false;ticket.current++;};},[status.owner]);
 const accept=async()=>{if(busy)return;const owner=cloudSync.getStatus().owner,token=invite.trim();if(!/^[A-Za-z0-9_-]{32,128}$/.test(token)){setMessage('请粘贴教练发送的完整邀请码');return;}setBusy(true);setMessage('');try{await cloudSync.ensureTeamIdentity();if(cloudSync.getStatus().owner!==owner)throw new Error('账号已切换，请重新核对邀请');await cloudSync.getTeamApi().request('/api/team/invitations/accept','POST',{inviteToken:token});clearTeamInvitation();navigate('/team',{replace:true});setInvite('');await load();tell('邀请已接收，请等待教练核对。成绩共享仍由你选择。');}catch(e){setMessage(e instanceof Error?e.message:'邀请接收结果未确认，请先刷新团队');}finally{setBusy(false);}};
 const revoke=async(team:Team)=>{if(busy||!team.grant)return;const owner=cloudSync.getStatus().owner,scope=cloudSync.teamLocalScope();if(await ask('撤销团队成绩共享？','之后的新读取与导出会排除这些训练。已经查看或下载的内容无法追回，本人原训练保留。',['保留共享','撤销共享'])!==1)return;if(cloudSync.getStatus().owner!==owner)return;setBusy(true);setMessage('');try{await queue.requestRevoke(team.id,team.grant.version,scope);if(queue.getStatus().revoking.includes(team.id))setMessage('已停止本机后续提交；撤销正在等待服务器确认。');else {await load();tell('共享已撤销；本人训练保留。');}}catch(e){setMessage(e instanceof Error?e.message:'已停止本机提交，服务器撤销仍待确认');}finally{setBusy(false);}};
 return <><Back title="我的团队" onBack={onBack}/><p className="caption">教练安排队伍和比赛分组，你决定共享哪些已完成训练。</p><Panel title="接收教练邀请"><Field label="邀请码" hint="加入团队不会自动共享成绩。"><input autoComplete="off" value={invite} onChange={e=>setInvite(e.target.value)} placeholder="粘贴教练发送的邀请码" disabled={busy}/></Field><Button kind="primary" disabled={busy||!invite.trim()} onClick={()=>void accept()}>接收邀请</Button></Panel><div className="team-toolbar"><Button disabled={busy} onClick={()=>void load()}>刷新团队与共享状态</Button></div>{message&&<p className="team-message" role="status">{message}</p>}{teams.length===0&&!busy&&!message&&<Panel><p>还没有加入团队。接收教练的邀请后，在这里核对分组和训练条件。</p></Panel>}{teams.map(team=><Panel key={status.owner+'/'+team.id} title={team.name}><div className="team-heading"><span>教练：{team.coachName||'已授权教练'}</span><span className="team-status">{stateName[team.memberStatus]||'待核对'}</span></div>{team.memberStatus==='active'?<><h3>教练安排</h3>{team.groups.length?team.groups.map(g=><div className="team-arrangement" key={g.id}><strong>{g.name}</strong><span>{g.config.bow} · {g.config.distance}m · {g.config.size}cm</span><span>每人每局 {g.config.arrowsPerAthlete} 箭 · 最多 {g.config.ends} 局 · {g.config.scoring==='set'?'局分制':'累计环数'}</span></div>):<p className="caption">教练尚未安排比赛分组。</p>}<SharingForm team={team} disabled={busy||queueStatus.revoking.includes(team.id)} onSaved={load}/>{team.grant?.active&&<Button kind="danger" disabled={busy} onClick={()=>void revoke(team)}>撤销共享</Button>}</>:<p className="caption">{team.memberStatus==='pending'?'请等待教练核对本人；核对后你可以选择共享范围。':'当前成员关系未启用，教练无法读取新的成绩。'}</p>}</Panel>)}<Panel title="提交状态"><p className="caption">训练先保存在本机；“已回读确认”才表示服务器已收到。</p>{queueStatus.items.length?queueStatus.items.map(item=><div className="team-submission" key={item.teamId+'/'+item.sessionId}><span>{data.sessions.find(s=>s.id===item.sessionId)?.date||'历史训练'} · 第 {item.revision} 版</span><span>{item.message}</span></div>):<p className="caption">尚无团队提交；选择共享范围后才会提交。</p>}{queueStatus.message&&<p className="caption" role="status">{queueStatus.message}</p>}<Button disabled={busy} onClick={()=>void queue.enqueue().then(()=>queue.flush()).catch(e=>setMessage(e.message))}>核对并提交待传记录</Button></Panel></>;
}
function SharingForm({team,disabled,onSaved}:{team:Team;disabled:boolean;onSaved:()=>Promise<void>}){
 const {data,ask,tell}=useApp(),grant=team.grant;
 const [selected,setSelected]=useState(grant?.sessionIds||[]),[future,setFuture]=useState(grant?.includeFuture||false),[from,setFrom]=useState(grant?.futureFrom||localDate()),[expires,setExpires]=useState(grant?.expiresOn||''),[version,setVersion]=useState(grant?.version||0),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
 const alive=useRef(true),saveLock=useRef(false),mountedScope=useRef(cloudSync.teamLocalScope());
 type Requested={expectedVersion:number;sessionIds:string[];includeFuture:boolean;futureFrom:string|null;expiresOn:string|null};
 type Pending=Requested&{requestId:string};
 type Stored={kind:'empty'}|{kind:'pending';value:Pending}|{kind:'blocked'};
 const storageKey='gongxingji-team-sharing-pending-v1:'+JSON.stringify([mountedScope.current?.service,mountedScope.current?.owner,team.id]);
 const readStored=():Stored=>{try{
  const raw=localStorage.getItem(storageKey);if(raw===null)return {kind:'empty'};const p=JSON.parse(raw) as Pending;
  if(!p||typeof p!=='object'||Array.isArray(p)||Object.keys(p).sort().join()!=='expectedVersion,expiresOn,futureFrom,includeFuture,requestId,sessionIds'||typeof p.requestId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(p.requestId)||!Number.isInteger(p.expectedVersion)||p.expectedVersion<0||!Array.isArray(p.sessionIds)||p.sessionIds.length>5000||p.sessionIds.some(id=>typeof id!=='string')||new Set(p.sessionIds).size!==p.sessionIds.length||typeof p.includeFuture!=='boolean'||!(p.futureFrom===null||typeof p.futureFrom==='string')||!(p.expiresOn===null||typeof p.expiresOn==='string'))return {kind:'blocked'};
  return {kind:'pending',value:p};
 }catch{return {kind:'blocked'};}};
 const [initialPending]=useState<Stored>(readStored);
 const [pendingReadback,setPendingReadback]=useState<Pending|null>(initialPending.kind==='pending'?initialPending.value:null),[storageBlocked,setStorageBlocked]=useState(initialPending.kind==='blocked');
 const pendingRef=useRef(pendingReadback);
 const remember=(stored:Stored)=>{if(!alive.current)return;setStorageBlocked(stored.kind==='blocked');pendingRef.current=stored.kind==='pending'?stored.value:null;setPendingReadback(pendingRef.current);};
 const finish=async(p:Pending,current:()=>boolean)=>withOperationsPendingLock(storageKey,current,()=>{
  const stored=readStored();if(stored.kind==='blocked'||stored.kind==='pending'&&stored.value.requestId!==p.requestId){remember(stored);return false;}
  if(stored.kind==='pending')localStorage.removeItem(storageKey);
  const after=readStored();remember(after);return after.kind==='empty';
 });
 const validGrant=(value:unknown):value is SharingGrant=>{const g=value as SharingGrant;return !!g&&Number.isInteger(g.version)&&g.version>0&&typeof g.active==='boolean'&&Array.isArray(g.sessionIds)&&g.sessionIds.every(id=>typeof id==='string')&&new Set(g.sessionIds).size===g.sessionIds.length&&typeof g.includeFuture==='boolean'&&(g.futureFrom===null||typeof g.futureFrom==='string')&&(g.expiresOn===null||typeof g.expiresOn==='string');};
 const matches=(result:SharingGrant,requested:Requested)=>result.version===requested.expectedVersion+1&&result.active===true&&result.sessionIds.length===requested.sessionIds.length&&[...result.sessionIds].sort().every((id,index)=>id===[...requested.sessionIds].sort()[index])&&result.includeFuture===requested.includeFuture&&result.futureFrom===requested.futureFrom&&result.expiresOn===requested.expiresOn;
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 useEffect(()=>{if(typeof window==='undefined')return;const changed=(event:StorageEvent)=>{if(event.key===storageKey||event.key===null)remember(readStored());};window.addEventListener('storage',changed);return()=>window.removeEventListener('storage',changed);},[storageKey]);
 // Only a read is resumed after mounting. An old range never releases an unknown write.
 useEffect(()=>{if(initialPending.kind==='pending')void readPending();},[]);
 const records=data.sessions.filter(s=>s.status==='completed').sort((a,b)=>b.date.localeCompare(a.date));
 useEffect(()=>{if((grant?.version||0)!==version)setMessage('共享范围已更新。当前选择保留，请重新读取范围后再保存。');},[grant?.version]);
 const reload=()=>{setSelected(grant?.sessionIds||[]);setFuture(grant?.includeFuture||false);setFrom(grant?.futureFrom||localDate());setExpires(grant?.expiresOn||'');setVersion(grant?.version||0);setMessage('');};
 const save=async()=>{
  if(saveLock.current||busy||disabled||pendingReadback||storageBlocked||(grant?.version||0)!==version)return;
  const scope=cloudSync.teamLocalScope();
  const api=cloudSync.getTeamApi(),intent=api.identity();
  const current=()=>alive.current&&!!scope&&!!intent&&scope.owner===mountedScope.current?.owner&&scope.service===mountedScope.current?.service&&cloudSync.teamLocalScope()?.owner===scope.owner&&cloudSync.teamLocalScope()?.service===scope.service&&sameIdentity(api.identity(),intent);
  if(!current()){setMessage('请联网重新核对当前账号后调整共享范围。');return;}
  if(!selected.length&&!future){setMessage('请选择训练，或开启指定日期起的新训练共享。');return;}
  if(future&&!from){setMessage('请选择持续共享的开始日期。');return;}
  if(expires&&expires<localDate()){setMessage('到期日期不能早于今天。');return;}
  if(future&&expires&&expires<from){setMessage('到期日期不能早于持续共享的开始日期。');return;}
  saveLock.current=true;setBusy(true);setMessage('');let saveConfirmed=false,attempted:Pending|null=null;
  try{
   if(await ask('确认共享这些训练？','教练可查看成绩、训练条件和已核验的落点，并导出汇总。不会共享私人心得、体能、装备、照片、原图或草稿。',['继续调整','确认共享'])!==1||!current())return;
   await cloudSync.ensureTeamIdentity();if(!current())return;
   const bound=api.identity();if(!bound||bound.owner!==scope!.owner||bound.service!==scope!.service)return;
   const requested={expectedVersion:version,sessionIds:[...selected],includeFuture:future,futureFrom:future?from:null,expiresOn:expires||null};
   attempted=await withOperationsPendingLock(storageKey,current,()=>{
    const stored=readStored();if(stored.kind!=='empty'){remember(stored);return null;}
    const value:Pending={...requested,requestId:newRewardRequestId()};localStorage.setItem(storageKey,JSON.stringify(value));
    const saved=readStored();remember(saved);if(saved.kind!=='pending'||saved.value.requestId!==value.requestId)throw new Error('共享回查标识未能保存，本次没有提交。');return value;
   });
   if(!attempted){setMessage('已有共享操作待核对，未重新提交。');return;}
   if(!current()){await finish(attempted,()=>true);return;}
   const saved=await api.request<{grant:SharingGrant}>(`/api/team/member/teams/${team.id}/sharing`,'PUT',requested,bound);
   if(!current()||!sameIdentity(api.identity(),bound))return;
   const result=saved?.grant;
   if(!validGrant(result)||!matches(result,requested))throw new Error('共享保存结果无法核对，请先读取原共享结果；未重复提交。');
   saveConfirmed=true;if(!await finish(attempted,current)||!current()){if(current())setMessage('原保存已确认，另有共享操作仍待核对。');return;}setVersion(result.version);setMessage('');await onSaved();
   if(current()&&sameIdentity(api.identity(),bound))tell('共享范围已保存；提交状态可在下方查看。');
  }catch(e){if(current()){
   // These validation responses occur before mutation (or roll back the same
   // transaction). Auth, conflicts and unknown server failures still need readback.
   if(!saveConfirmed&&attempted&&[400,422].includes(httpStatus(e))){try{const cleared=await finish(attempted,current);if(current())setMessage(cleared?'内容未通过校验，本次未保存；当前选择已保留，请修改后重新确认。':'本次内容未通过校验；另有共享操作待核对，未重新提交。');}catch{if(current())setMessage('本次内容未通过校验，但回查标识尚未安全清除，请先读取原共享结果。');}}
   else setMessage(saveConfirmed?'共享范围已保存，列表刷新尚未完成，请稍后刷新。':e instanceof Error?e.message:'共享结果未确认，请先刷新范围');
  }}
  finally{saveLock.current=false;if(alive.current)setBusy(false);}
 };
 const readPending=async()=>{
  if(saveLock.current||busy||!pendingRef.current)return;
  const api=cloudSync.getTeamApi(),bound=api.identity();if(!bound||bound.owner!==mountedScope.current?.owner||bound.service!==mountedScope.current?.service)return;
  const current=()=>alive.current&&sameIdentity(api.identity(),bound);
  saveLock.current=true;setBusy(true);setMessage('');
  try{
   const pending=await withOperationsPendingLock(storageKey,current,()=>{const stored=readStored();remember(stored);return stored.kind==='pending'?stored.value:null;});
   if(!pending||!current())return;
   const value=await api.request<{grant:SharingGrant|null}>(`/api/team/member/teams/${team.id}/sharing`,'GET',undefined,bound);
   if(!current())return;
   if(value?.grant===null||validGrant(value?.grant)&&value.grant.version<=pending.expectedVersion){setMessage('尚未核到原保存结果，仍保留待核对状态；没有重新提交。');return;}
   if(!validGrant(value?.grant))throw new Error('当前共享范围无法核对，请稍后重新读取。');
   const confirmed=matches(value.grant,pending),g=value.grant;
   if(!await finish(pending,current)||!current()){if(current())setMessage('另有共享操作仍待核对，请继续只读核对。');return;}
   setSelected(g.sessionIds);setFuture(g.includeFuture);setFrom(g.futureFrom||localDate());setExpires(g.expiresOn||'');setVersion(g.version);
   await onSaved();if(current())setMessage(confirmed?'原共享保存已回读确认，没有重新提交。':'当前共享范围已变化，已读取服务器版本；请核对后再调整。');
  }catch(e){if(current())setMessage(e instanceof Error?e.message:'当前共享范围无法核对，请稍后重新读取。');}
  finally{saveLock.current=false;if(alive.current)setBusy(false);}
 };
 return <div className="team-sharing"><h3>成绩共享范围</h3><p className="caption">选择历史训练；持续共享只包含指定日期起完成的训练。</p><fieldset disabled={disabled||busy||!!pendingReadback||storageBlocked}>{records.map(s=><label className="team-record" key={s.id}><input type="checkbox" checked={selected.includes(s.id)} onChange={e=>setSelected(v=>e.target.checked?[...v,s.id]:v.filter(id=>id!==s.id))}/><span>{s.date}<small>{allArrows(s).length} 箭 · {allArrows(s).reduce((n,a)=>n+scoreValue(a.code),0)} 分 · {s.conditions.distance}m</small></span></label>)}{!records.length&&<p className="caption">暂无已完成训练。</p>}<label className="team-record"><input type="checkbox" checked={future} onChange={e=>setFuture(e.target.checked)}/><span>持续共享以后完成的训练</span></label>{future&&<Field label="新增训练开始日期"><input type="date" value={from} onChange={e=>setFrom(e.target.value)}/></Field>}<Field label="到期日期（可留空）"><input type="date" value={expires} onChange={e=>setExpires(e.target.value)}/></Field><p className="caption">编组不扩大共享范围；已经下载的报表无法通过撤销追回。</p><Button kind="primary" disabled={(grant?.version||0)!==version} onClick={()=>void save()}>确认范围并共享</Button></fieldset>{message&&<p className="team-message" role="status">{message}</p>}{storageBlocked&&<p className="team-message" role="alert">共享回查标识无法读取，已停止新提交；请保留本机资料后核查。</p>}{pendingReadback&&<div className="team-message"><p>原共享操作待核对，已停止重复提交。</p><Button disabled={busy} onClick={()=>void readPending()}>读取原共享结果</Button></div>}{(grant?.version||0)!==version&&<Button onClick={reload}>重新读取当前范围</Button>}</div>;
}
