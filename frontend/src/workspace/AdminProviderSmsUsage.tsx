import React,{useEffect,useRef,useState} from 'react';
import {sameIdentity,httpStatus} from '../mobile/rewards-api';
import type {OperationsClient} from '../mobile/operations-api';
import type {TeamIdentity} from '../mobile/team-api';
type Unknown={status:'unavailable';message:string};
type Usage={status:'available';total:number;success:number;failure:number;unknown:number;days:{date:string;success:number;failure:number;unknown:number}[]};
type Fees={status:'available';quantity:number|null;amount:string;currency:'CNY'};
type PackagePurchases={status:'available'|'unavailable';source:'aliyun_bss_instance_bill';billingCycle:string;currency:'CNY';purchaseQuantity:{value:string;unit:'次'}|null;payableAmount:string|null;cashPaid:null;complete:boolean};
type ProviderSummary={usage:Usage|Unknown;billing:Fees|Unknown;packagePurchases?:PackagePurchases;generatedAt:string;range:{start:string;end:string;month:string};scope:string;definition:string;billingDefinition:string;coverage:string};
const date=(value:string)=>value.slice(0,4)+'-'+value.slice(4,6)+(value.length===8?'-'+value.slice(6,8):'');
export function AdminProviderSmsUsage({client,bound,days,onPermissionLost}:{client:OperationsClient;bound:TeamIdentity;days:number;onPermissionLost:()=>void}){
 const [month,setMonth]=useState('current'),[data,setData]=useState<ProviderSummary|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[allowed,setAllowed]=useState(true);
 const alive=useRef(false),ticket=useRef(0),permission=useRef(true),lock=useRef(false);
 const current=()=>alive.current&&permission.current&&sameIdentity(client.identity(),bound);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;ticket.current++;};},[]);
 useEffect(()=>{ticket.current++;setData(null);setError('');},[days,month]);
 async function load(){if(!current()||lock.current)return;lock.current=true;const id=++ticket.current;setBusy(true);setData(null);setError('');try{
  const value=await client.read<ProviderSummary>('admin/operations/sms/provider/summary',{days,month},bound);if(current()&&id===ticket.current)setData(value);
 }catch(e){if(current()&&id===ticket.current){if([401,403].includes(httpStatus(e))){permission.current=false;ticket.current++;setAllowed(false);setData(null);onPermissionLost();}else setError('供应商统计读取未完成，数据未知；原发送预约记录仍可查看。');}}
 finally{lock.current=false;if(current())setBusy(false);}}
 if(!sameIdentity(client.identity(),bound))return <p role="status">账号已切换，供应商统计已清除。</p>;
 if(!allowed)return <p role="alert">管理员权限已失效，供应商统计已清除。</p>;
 const purchases=data?.packagePurchases,purchasesAvailable=purchases?.status==='available'&&purchases.complete===true&&purchases.source==='aliyun_bss_instance_bill'&&purchases.currency==='CNY';
 return <section aria-label="供应商用量与月消费"><h3>供应商用量与月消费</h3><p className="ws-help">按需读取阿里云统计与购买账单，不发送短信。查询范围为当前阿里云账号的短信认证服务。</p>
  <div className="sms-controls"><label>消费月份<select value={month} disabled={busy} onChange={e=>setMonth(e.target.value)}><option value="current">本月</option><option value="previous">上月</option></select></label><button disabled={busy} onClick={()=>void load()}>{busy?'正在读取供应商统计…':'读取供应商真实统计'}</button></div>
  {error&&<p role="alert">{error}</p>}{!data&&!busy&&!error&&<p className="ws-help">尚未查询；上方预约次数不代表供应商实际用量或费用。</p>}
  {data&&<><p className="ws-help">{data.scope}</p><p>用量日期 {date(data.range.start)} 至 {date(data.range.end)}；费用月份 {date(data.range.month)}</p>
   <h4>短信认证调用情况</h4>{data.usage.status==='available'?<><dl className="sms-facts"><dt>调用总量</dt><dd>{data.usage.total}</dd><dt>成功调用</dt><dd>{data.usage.success}</dd><dt>失败调用</dt><dd>{data.usage.failure}</dd><dt>结果未知</dt><dd>{data.usage.unknown}</dd></dl><details><summary>查看供应商每日统计</summary><div className="ws-table-wrap"><table><thead><tr><th>日期</th><th>成功调用</th><th>失败调用</th><th>未知</th></tr></thead><tbody>{data.usage.days.map(row=><tr key={row.date}><td>{date(row.date)}</td><td>{row.success}</td><td>{row.failure}</td><td>{row.unknown}</td></tr>)}</tbody></table></div>{!data.usage.days.length&&<p>供应商未返回每日记录，未补算为零。</p>}</details></>:<p role="status">{data.usage.message}</p>}<p className="ws-help">{data.definition}</p>
   <h4>供应商月消费</h4>{data.billing.status==='available'?<dl className="sms-facts"><dt>月计费量</dt><dd>{data.billing.quantity??'未知'}</dd><dt>月消费金额</dt><dd>{data.billing.amount} 元</dd><dt>现金已扣 / 套餐余额</dt><dd>未知</dd></dl>:<p role="status">{data.billing.message}</p>}<p className="ws-help">{data.billingDefinition}</p><p className="ws-help">{data.coverage}</p><small>读取于 {new Date(data.generatedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})}（北京时间）。</small>
    <section aria-label="短信认证套餐购买账单"><h4>短信认证套餐购买账单（应付）</h4><p className="ws-help">来源：阿里云 BSS 套餐购买账单；账期 {purchases?.billingCycle||date(data.range.month)}。</p>
     {purchasesAvailable?<dl className="sms-facts"><dt>套餐购买数量</dt><dd>{purchases.purchaseQuantity?`${purchases.purchaseQuantity.value} ${purchases.purchaseQuantity.unit}`:'未知'}</dd><dt>购买账单应付金额</dt><dd>{purchases.payableAmount===null?'未知':`${purchases.payableAmount} 元`}</dd><dt>现金实付</dt><dd>未知</dd></dl>:<p role="status">套餐购买账单暂不可用，购买数量与应付金额未知。</p>}
     <p className="ws-help">购买数量不代表已发送量或剩余套餐；账单应付不代表现金实付，也不是当月短信使用费。账单可能延迟约24小时，当月数据尚未最终结算。</p>
     <small>读取于 {new Date(data.generatedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})}（北京时间）。</small>
    </section>
  </>}
 </section>;
}
