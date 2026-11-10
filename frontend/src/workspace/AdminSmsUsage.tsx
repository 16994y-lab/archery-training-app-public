import {AdminProviderSmsUsage} from './AdminProviderSmsUsage';
import {AdminSmsConsoleReconciliation} from './AdminSmsConsoleReconciliation';
import React,{useEffect,useRef,useState} from 'react';
import {sameIdentity,httpStatus} from '../mobile/rewards-api';
import type {OperationsClient} from '../mobile/operations-api';
import type {TeamIdentity} from '../mobile/team-api';
import './admin-sms-usage.css';
type Outcome={status:string;count:number|null;definition:string};
type Summary={generatedAt:string;days:number;reservations:{total:number;today:number;thisMonth:number;firstRecordAt:string|null;latestRecordAt:string|null;definition:string;buckets:{date:string;count:number}[]};limits:{status:string;total:number|null;remainingReservations:number|null;month:number|null;monthRemaining:number|null;perPhoneDay:number|null;phoneDayTimezone:string|null;cooldownSeconds:number;validUntil:string|null;definition:string};providerAccepted?:Outcome;providerFailed?:Outcome;providerUnknown?:Outcome&{pendingCount:number|null;historicalUnknownCount:number|null};delivered:{count:number|null;definition:string};billing:{chargedMessages:number|null;amount:number|null;definition:string};consoleReconciliation?:unknown};
const stamp=(value:string|null)=>value?new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'暂无记录';
const outcomeCount=(outcome:Outcome|undefined,value:number|null|undefined)=>outcome?.status==='available'&&typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?value:'未知';
export function AdminSmsUsage({client,bound,onPermissionLost}:{client:OperationsClient;bound:TeamIdentity;onPermissionLost:()=>void}){
 const [days,setDays]=useState(7),[snapshot,setSnapshot]=useState<{key:string;value:Summary}|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[allowed,setAllowed]=useState(true);
 const key=JSON.stringify(bound),data=sameIdentity(client.identity(),bound)&&snapshot?.key===key?snapshot.value:null;
 const setData=(value:Summary|null)=>setSnapshot(value?{key,value}:null);
 const alive=useRef(false),ticket=useRef(0),permission=useRef(true);
 const current=()=>alive.current&&permission.current&&sameIdentity(client.identity(),bound);
 const losePermission=()=>{permission.current=false;ticket.current++;setAllowed(false);setData(null);onPermissionLost();};
 async function load(window=days){if(!current())return;const id=++ticket.current;setBusy(true);setError('');setData(null);try{
  const value=await client.read<Summary>('admin/operations/sms/summary',{days:window},bound);if(current()&&id===ticket.current)setData(value);
 }catch(e){if(current()&&id===ticket.current){if([401,403].includes(httpStatus(e)))losePermission();else setError('短信统计暂不可用，请稍后重新读取；未将失败显示为零。');}}
 finally{if(current()&&id===ticket.current)setBusy(false);}}
 useEffect(()=>{alive.current=true;permission.current=true;setAllowed(true);setData(null);setBusy(false);setError('');void load(days);return()=>{alive.current=false;permission.current=false;ticket.current++;};},[key,client]);
 if(!sameIdentity(client.identity(),bound))return <p role="status">账号已切换，短信统计已清除。</p>;
 if(!allowed)return <p role="alert">管理员权限已失效，短信统计已清除。</p>;
 const peak=Math.max(1,...(data?.reservations.buckets.map(b=>b.count)||[]));
 return <section className="reward-card admin-sms-usage" aria-label="短信使用情况"><h2>短信使用情况</h2>
  <div className="sms-controls"><label>趋势范围<select value={days} onChange={e=>{const v=Number(e.target.value);setDays(v);void load(v);}}><option value={7}>近7天</option><option value={30}>近30天</option></select></label><button disabled={busy} onClick={()=>void load()}>刷新统计</button></div>
  {busy&&<p role="status">正在读取短信预约记录…</p>}{error&&<p role="alert">{error}</p>}
  {data&&<AdminSmsConsoleReconciliation value={data.consoleReconciliation}/>}
  {data&&<><div className="operations-summary"><div><span>今日发送预约</span><strong>{data.reservations.today}</strong></div><div><span>本月发送预约</span><strong>{data.reservations.thisMonth}</strong></div><div><span>累计发送预约</span><strong>{data.reservations.total}</strong></div><div><span>剩余预约额度</span><strong>{data.limits.remainingReservations??'未知'}</strong></div></div>
   <p>{data.reservations.definition}</p><p className="ws-help">所有趋势日期均为北京时间；本月截至当前读取时刻。最早记录：{stamp(data.reservations.firstRecordAt)}；最近预约：{stamp(data.reservations.latestRecordAt)}。</p>
   <h3>每日预约趋势</h3><div className="sms-chart" role="img" aria-label={'近'+data.days+'天发送预约趋势，完整数字见下表'}>{data.reservations.buckets.map(b=><div className="sms-bar-column" key={b.date} title={b.date+'：'+b.count+'次'}><span className="sms-bar-number">{b.count}</span><div className="sms-bar-track"><i style={{height:(b.count/peak*100)+'%'}}/></div><small>{b.date.slice(5)}</small></div>)}</div>
   <details><summary>查看每日数字</summary><table><thead><tr><th>日期（北京时间）</th><th>发送预约次数</th></tr></thead><tbody>{data.reservations.buckets.map(b=><tr key={b.date}><td>{b.date}</td><td>{b.count}</td></tr>)}</tbody></table></details>
  </>}
  {data&&<section aria-label="应用发送结果"><h3>应用发送结果</h3><p className="ws-help">来自应用发送账本，截至本次读取的累计结果，不随上方7天／30天趋势范围变化。开始记录发送结果的时间未单独采集，历史未记录结果单列。</p>
   <dl className="sms-facts"><dt>供应商明确受理</dt><dd>{outcomeCount(data.providerAccepted,data.providerAccepted?.count)}</dd><dt>明确未发送或被拒绝</dt><dd>{outcomeCount(data.providerFailed,data.providerFailed?.count)}</dd><dt>发送结果未知</dt><dd>{outcomeCount(data.providerUnknown,data.providerUnknown?.count)}</dd><dt>等待结果确认</dt><dd>{outcomeCount(data.providerUnknown,data.providerUnknown?.pendingCount)}</dd><dt>历史未记录结果</dt><dd>{outcomeCount(data.providerUnknown,data.providerUnknown?.historicalUnknownCount)}</dd></dl>
   <p className="ws-help">{data.providerAccepted?.definition||'未取得供应商受理结果统计。'}</p><p className="ws-help">{data.providerFailed?.definition||'未取得明确未发送或拒绝的统计。'}</p><p className="ws-help">{data.providerUnknown?.definition||'未取得未知、待回写和历史未记录结果的分类统计。'}</p>
   <p className="ws-help">供应商受理不等于手机送达、验证码生效或登录成功；预约数、受理数均不能用于推算实际费用。</p>
  </section>}
  <div className="sms-provider-usage"><AdminProviderSmsUsage key={key} client={client} bound={bound} days={days} onPermissionLost={losePermission}/><p className="ws-help">手机实际送达：未知；尚未接入运营商送达回执，成功调用不代表手机送达。</p></div>
  {data&&<>
   <h3>当前发送保护</h3><dl className="sms-facts"><dt>累计预约保护上限</dt><dd>{data.limits.total??'未知'}</dd><dt>本月预约保护上限 / 剩余</dt><dd>{data.limits.month??(data.limits.status==='configured'?'未配置月限额':'未知')} / {data.limits.monthRemaining??(data.limits.status==='configured'?'不适用':'未知')}</dd><dt>每号码每日成功额度上限</dt><dd>{data.limits.perPhoneDay===0?'不限制':data.limits.perPhoneDay??'未知'}{data.limits.phoneDayTimezone?'（'+data.limits.phoneDayTimezone+'）':''}</dd><dt>重发间隔</dt><dd>{data.limits.cooldownSeconds} 秒</dd><dt>当前额度有效期</dt><dd>{data.limits.validUntil?stamp(data.limits.validUntil):'未配置 / 未知'}</dd></dl><p className="ws-help">{data.limits.definition}</p><p className="ws-help">每日成功额度仅计明确供应商受理成功；失败与未知不计入每日成功额度。当前没有逐号码今日剩余额度统计，不能用全体累计结果推算。</p><small>读取于 {stamp(data.generatedAt)}；此页不发送短信，不会扣减预约额度。</small>
  </>}
 </section>;
}
