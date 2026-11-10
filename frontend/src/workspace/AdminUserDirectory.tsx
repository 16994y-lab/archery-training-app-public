import React,{useEffect,useRef,useState} from 'react';
import {OperationsClient} from '../mobile/operations-api';
import {sameIdentity,httpStatus,rewardError,type RewardUser} from '../mobile/rewards-api';
import type {TeamIdentity} from '../mobile/team-api';
import './admin-user-directory.css';

type Account={userId:string;phoneMasked:string|null;emailMasked:string|null;registeredAt:string|null;lastSignInAt:string|null;phoneVerified:boolean;bannedUntil:string|null;roles:string[];coachStatus:string|null;state:string};
type Directory={items:Account[];page:number;limit:number;hasMore:boolean;total:number;registeredTotal:number;phoneVerifiedTotal:number;population:string;activityDefinition:string;generatedAt:string};
type Detail={account:Account;training:{status:string;sessions:number|null;arrows:number|null;latestReceivedAt:string|null;coverage:string};activity:{lastObservedAt:string|null;lastSignInAt:string|null;lastSharedReceiptAt:string|null;definition:string};usageDuration:{status:string;seconds:number|null;collectionStartedAt:string|null;definition:string};generatedAt:string};
type Filters={query:string;role:string;state:string};
const initial:Filters={query:'',role:'all',state:'all'};
const names:Record<string,string>={user:'用户',coach:'教练',admin:'管理员',active:'手机已验证',pending_verification:'待手机验证',banned:'封禁中',approved:'已批准',pending:'待审核',rejected:'未批准',suspended:'已暂停'};
const date=(value:string|null)=>value?new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'暂无记录';
const label=(a:Account)=>a.phoneMasked||a.emailMasked||a.userId;
export function AdminUserDirectory({client,bound,onPermissionLost,onSelect,onClear}:{client:OperationsClient;bound:TeamIdentity;onPermissionLost:()=>void;onSelect:(user:RewardUser)=>void;onClear:()=>void}){
 const [draft,setDraft]=useState<Filters>(initial),[applied,setApplied]=useState<Filters>(initial),[data,setData]=useState<Directory|null>(null),[detail,setDetail]=useState<Detail|null>(null),[selected,setSelected]=useState<string|null>(null),[loading,setLoading]=useState(false),[detailLoading,setDetailLoading]=useState(false),[error,setError]=useState(''),[allowed,setAllowed]=useState(true);
 const alive=useRef(false),listVersion=useRef(0),detailVersion=useRef(0),permission=useRef(true);
 const current=()=>alive.current&&permission.current&&sameIdentity(client.identity(),bound);
 function clearDetail(){detailVersion.current++;setSelected(null);setDetail(null);setDetailLoading(false);onClear();}
 function fail(e:unknown){if(!current())return;if([401,403].includes(httpStatus(e))){permission.current=false;listVersion.current++;detailVersion.current++;setAllowed(false);setData(null);setDetail(null);setSelected(null);onClear();onPermissionLost();}else setError(httpStatus(e)===503?'注册目录暂不可用，请稍后重新读取；没有显示为零。':rewardError(e));}
 async function load(page=1,filters=applied){
  if(!current())return;const ticket=++listVersion.current;clearDetail();setData(null);setError('');setLoading(true);
  try{const value=await client.read<Directory>('admin/operations/users/search',{...filters,page,limit:20},bound);if(current()&&ticket===listVersion.current){setData(value);setApplied(filters);}}
  catch(e){if(ticket===listVersion.current)fail(e);}finally{if(current()&&ticket===listVersion.current)setLoading(false);}
 }
 async function open(a:Account){
  if(!current())return;const ticket=++detailVersion.current;setSelected(a.userId);setDetail(null);setDetailLoading(true);setError('');onClear();
  try{const value=await client.read<Detail>('admin/operations/users/detail',{userId:a.userId},bound);if(current()&&ticket===detailVersion.current){if(value.account.userId!==a.userId)throw new Error();setDetail(value);
   if(value.account.state==='active')onSelect({userId:a.userId,label:label(a),phoneMasked:a.phoneMasked||'',service:bound.service});}}
  catch(e){if(ticket===detailVersion.current)fail(e);}finally{if(current()&&ticket===detailVersion.current)setDetailLoading(false);}
 }
 useEffect(()=>{alive.current=true;void load(1,initial);return()=>{alive.current=false;listVersion.current++;detailVersion.current++;};},[]);
 // Parent keys the component by account/service and removes it on role loss.
 if(!allowed)return <p role="alert">管理员权限已失效，账户目录已清除。</p>;
 return <section className="admin-user-directory" aria-label="注册账户目录">
  <form className="directory-search" onSubmit={e=>{e.preventDefault();void load(1,draft);}}>
   <label>账号搜索<input type="search" maxLength={120} autoComplete="off" placeholder="账号标识、手机号或邮箱；留空查看全部" value={draft.query} onChange={e=>setDraft({...draft,query:e.target.value})}/></label>
   <label>角色<select value={draft.role} onChange={e=>setDraft({...draft,role:e.target.value})}><option value="all">全部角色</option><option value="user">普通用户</option><option value="coach">教练（含兼任管理员）</option><option value="admin">管理员</option></select></label>
   <label>账户状态<select value={draft.state} onChange={e=>setDraft({...draft,state:e.target.value})}><option value="all">全部状态</option><option value="active">手机已验证且未封禁</option><option value="pending_verification">待手机验证</option><option value="banned">封禁中</option></select></label>
   <button disabled={loading}>查询 / 刷新</button>
  </form>
  {error&&<p role="alert">{error}</p>}{loading&&<p role="status">正在读取注册账户…</p>}
  {data&&<><div className="operations-summary"><div><span>全部注册账户</span><strong>{data.registeredTotal}</strong></div><div><span>已验手机号 · 未封禁</span><strong>{data.phoneVerifiedTotal}</strong></div><div><span>当前筛选</span><strong>{data.total}</strong></div></div>
   <p className="ws-help">{data.population}</p><p className="ws-help">时间均为北京时间。列表按注册时间从新到旧排列。最近登录不代表在线状态。</p>
   <div className="ws-table-wrap"><table className="ws-responsive-table ws-account-table" role="table"><thead role="rowgroup"><tr role="row"><th scope="col" role="columnheader">账户</th><th scope="col" role="columnheader">注册时间</th><th scope="col" role="columnheader">角色 / 状态</th><th scope="col" role="columnheader">最近登录</th><th scope="col" role="columnheader">详情</th></tr></thead><tbody role="rowgroup">{data.items.map(a=><tr role="row" key={a.userId}><td role="cell">{label(a)}<small className="ws-sub">{a.emailMasked}</small><small className="ws-sub">{a.userId}</small></td><td role="cell"><span className="ws-mobile-cell-label" aria-hidden="true">注册时间</span>{date(a.registeredAt)}</td><td role="cell"><span className="ws-mobile-cell-label" aria-hidden="true">角色 / 状态</span>{a.roles.map(r=>names[r]||r).join('、')}<small className="ws-sub">{names[a.state]||a.state}</small></td><td role="cell"><span className="ws-mobile-cell-label" aria-hidden="true">最近登录</span>{date(a.lastSignInAt)}</td><td role="cell"><button aria-pressed={selected===a.userId} onClick={()=>void open(a)}>查看详情</button></td></tr>)}</tbody></table></div>
   {!data.items.length&&<p>当前筛选没有账户。</p>}
   <nav className="reward-pages" aria-label="账户目录分页"><button disabled={loading||data.page<=1} onClick={()=>void load(data.page-1)}>上一页</button><span>第 {data.page} 页 / {Math.max(1,Math.ceil(data.total/data.limit))} 页</span><button disabled={loading||!data.hasMore} onClick={()=>void load(data.page+1)}>下一页</button></nav><small>读取于 {date(data.generatedAt)}</small>
  </>}
  {detailLoading&&<p role="status">正在读取账户详情…</p>}
  {detail&&<article className="reward-selected" aria-label="账户详情"><h3>{label(detail.account)}</h3><dl className="directory-detail">
   <dt>账户标识</dt><dd>{detail.account.userId}</dd><dt>注册时间</dt><dd>{date(detail.account.registeredAt)}</dd>
   <dt>角色</dt><dd>{detail.account.roles.map(r=>names[r]||r).join('、')}</dd><dt>账户状态</dt><dd>{names[detail.account.state]||detail.account.state}{detail.account.state==='banned'?' · 至 '+date(detail.account.bannedUntil):''}</dd>
   <dt>教练审核</dt><dd>{detail.account.coachStatus?names[detail.account.coachStatus]||detail.account.coachStatus:'未申请'}</dd>
   <dt>最近可观测活动</dt><dd>{date(detail.activity.lastObservedAt)}</dd><dt>最近登录</dt><dd>{date(detail.activity.lastSignInAt)}</dd><dt>最近共享接收</dt><dd>{date(detail.activity.lastSharedReceiptAt)}</dd>
   <dt>已接收共享训练</dt><dd>{detail.training.sessions??'暂不可用'} 场</dd><dt>共享训练箭数</dt><dd>{detail.training.arrows??'暂不可用'} 箭</dd>
   <dt>App 使用时长</dt><dd>未采集</dd></dl>
   <p className="ws-help">{detail.training.coverage}</p>{detail.training.status!=='available'&&<p role="status">共享记录存在冲突或超出读取范围，箭数未作推算。</p>}<p className="ws-help">{detail.activity.definition}</p><p className="ws-help">{detail.usageDuration.definition}</p>
   {detail.account.state!=='active'&&<p>该账号当前不可进行奖励或反馈代办；此处保留只读账户信息。</p>}
  </article>}
 </section>;
}
