import React from 'react';

export type ConsoleReconciliation={version:1;status:'recorded';realtime:false;source:'aliyun-pnvs-console';observedAt:string;timezone:'Asia/Shanghai';usageMonth:string;sentMessages:number;package:{totalMessages:number;remainingMessages:number;cashPaid:string;currency:'CNY';purchasedAt:string;expiresAt:string}};
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const keys=(value:Record<string,unknown>,names:string)=>Object.keys(value).sort().join(',')===names.split(',').sort().join(',');
const count=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
function timestamp(value:unknown):number|null{
 if(typeof value!=='string'||!/^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/.test(value))return null;
 const ms=Date.parse(value);if(!Number.isFinite(ms)||new Date(ms+8*3600000).toISOString().slice(0,19)!==value.slice(0,19))return null;
 return ms;
}
/** This is a historical console observation, never a replacement for API results. */
export function parseConsoleReconciliation(value:unknown,now=Date.now()):ConsoleReconciliation|null{
 if(!record(value)||!keys(value,'version,status,realtime,source,observedAt,timezone,usageMonth,sentMessages,package')
  ||value.version!==1||value.status!=='recorded'||value.realtime!==false||value.source!=='aliyun-pnvs-console'||value.timezone!=='Asia/Shanghai'
  ||typeof value.usageMonth!=='string'||!/^(?!0000)\d{4}-(0[1-9]|1[0-2])$/.test(value.usageMonth)||!count(value.sentMessages))return null;
 const observed=timestamp(value.observedAt),p=value.package;
 if(observed===null||!Number.isFinite(now)||observed>now||value.usageMonth>(value.observedAt as string).slice(0,7)
  ||!record(p)||!keys(p,'totalMessages,remainingMessages,cashPaid,currency,purchasedAt,expiresAt')
  ||!count(p.totalMessages)||p.totalMessages===0||!count(p.remainingMessages)||p.remainingMessages>p.totalMessages
  ||p.currency!=='CNY'||typeof p.cashPaid!=='string'||!/^(0|[1-9]\d{0,8})\.\d{2}$/.test(p.cashPaid))return null;
 const purchased=timestamp(p.purchasedAt),expires=timestamp(p.expiresAt);
 if(purchased===null||expires===null||purchased>observed||expires<=purchased)return null;
 return value as ConsoleReconciliation;
}
const stamp=(value:string)=>value.slice(0,10)+' '+value.slice(11,19);
export function AdminSmsConsoleReconciliation({value}:{value:unknown}){
 const snapshot=parseConsoleReconciliation(value);if(!snapshot)return null;
 return <section className="reward-card" aria-label="最近一次控制台核对（非实时）"><h3>最近一次控制台核对（非实时）</h3>
  <p className="ws-help">来源：阿里云号码认证控制台。以下为已记录的人工核对快照，不是实时查询结果。</p>
  <dl className="sms-facts"><dt>核对时间（北京时间）</dt><dd>{stamp(snapshot.observedAt)}</dd><dt>快照统计月份</dt><dd>{snapshot.usageMonth}</dd>
   <dt>供应商发送次数</dt><dd>{snapshot.sentMessages} 次</dd><dt>套餐总量</dt><dd>{snapshot.package.totalMessages} 次</dd><dt>套餐余量</dt><dd>{snapshot.package.remainingMessages} 次</dd>
   <dt>套餐购买实付金额（CNY）</dt><dd>{snapshot.package.cashPaid} 元</dd><dt>套餐购买时间（北京时间）</dt><dd>{stamp(snapshot.package.purchasedAt)}</dd><dt>套餐到期时间（北京时间）</dt><dd>{stamp(snapshot.package.expiresAt)}</dd></dl>
  <p className="ws-help">购买实付是该套餐的购买金额，不是本月短信消耗费用；余量按控制台核对值记录，未按发送次数推算。刷新统计和切换查询月份不会更新这份快照的核对时间或统计月份。</p>
 </section>;
}
