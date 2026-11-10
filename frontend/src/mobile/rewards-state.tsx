import {useEffect,useRef,useState,useSyncExternalStore} from 'react';
import type {TeamIdentity} from './team-api';
import {RewardsClient,type RewardOperation,type RewardWriteResult,identityKey,sameIdentity,httpStatus,newRewardRequestId,rewardError} from './rewards-api';
import {withOperationsPendingLock} from './operations-pending';

export function useRewardsIdentity(client:RewardsClient){const key=useSyncExternalStore(client.subscribe,()=>identityKey(client.identity()),()=> '');return {key,identity:key?client.identity():null};}
type Pending={requestId:string;operation:RewardOperation};
const validPending=(v:unknown,audience:'user'|'admin'):v is Pending=>{const p=v as Pending;return !!p&&typeof p==='object'&&!Array.isArray(p)&&Object.keys(p).length===2&&typeof p.requestId==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(p.requestId)&&(audience==='user'?p.operation==='claim':['issue','revoke_claim','donation','refund','revoke_source','contact'].includes(p.operation));};
// Only the request identifier and operation survive interruption; never codes, search terms, contacts, or mutation bodies.
export function useRewardWrite(client:RewardsClient,bound:TeamIdentity,audience:'user'|'admin',onSuccess:(result:RewardWriteResult,fromReceipt:boolean)=>void,onDenied?:()=>void){
 const storageKey='gongxingji-reward-pending-v1:'+JSON.stringify([bound.service,bound.owner,audience]);
 type Stored={kind:'empty'}|{kind:'pending';value:Pending}|{kind:'unknown'};
 const unknownStorage='待确认标识无法核对，请保留当前页面并稍后重试；本次未发起新操作。';
 const readStored=():Stored=>{try{const raw=localStorage.getItem(storageKey);if(raw===null)return {kind:'empty'};const value:unknown=JSON.parse(raw);return validPending(value,audience)?{kind:'pending',value}:{kind:'unknown'};}catch{return {kind:'unknown'};}};
 const [initial]=useState<Stored>(readStored);
 const [pending,setPending]=useState<Pending|null>(initial.kind==='pending'?initial.value:null),[busy,setBusy]=useState(false),[message,setMessage]=useState(initial.kind==='unknown'?unknownStorage:'');
 const lock=useRef(false),alive=useRef(true),pendingRef=useRef(pending);useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 const current=()=>alive.current&&sameIdentity(client.identity(),bound);
 const remember=(value:Pending|null)=>{pendingRef.current=value;setPending(value);};
 const withPendingLock=<T,>(action:()=>T)=>withOperationsPendingLock(storageKey,current,action);
 async function finish(p:Pending,notice=''){
  try{return await withPendingLock(()=>{
   const stored=readStored();
   if(stored.kind==='unknown'){remember(p);setMessage([notice,unknownStorage].filter(Boolean).join(' '));return false;}
   if(stored.kind==='pending'&&(stored.value.requestId!==p.requestId||stored.value.operation!==p.operation)){remember(stored.value);setMessage('另有一笔操作仍待确认，请只读取原请求，不要重复提交。');return false;}
   if(stored.kind==='pending')try{localStorage.removeItem(storageKey);}catch{remember(p);setMessage(unknownStorage);return false;}
   remember(null);setMessage(notice);return true;
  });}catch{if(current()){remember(p);setMessage('原请求已有结果，但回查标识的更新尚未确认。请保留当前页面，稍后读取原请求结果。');}return false;}
 }
 async function submit(operation:RewardOperation,body:Record<string,unknown>){
  if(lock.current||!current()||(audience==='user')!==(operation==='claim'))return;lock.current=true;setBusy(true);setMessage('');let p:Pending|null=null;
  try{
   p=await withPendingLock(()=>{
    const stored=readStored();
    if(stored.kind==='unknown'){setMessage(unknownStorage);return null;}
    if(stored.kind==='pending'){remember(stored.value);setMessage('已有操作仍待确认，请只读取原请求，不要重复提交。');return null;}
    if(pendingRef.current)return null;
    const value:Pending={requestId:newRewardRequestId(),operation};
    try{localStorage.setItem(storageKey,JSON.stringify(value));}catch{setMessage('无法保存请求回查标识，本次尚未提交。');return null;}
    const saved=readStored();
    if(saved.kind!=='pending'||saved.value.requestId!==value.requestId||saved.value.operation!==value.operation){remember(saved.kind==='pending'?saved.value:value);setMessage('无法核实回查标识，本次尚未提交。请保留当前页面。');return null;}
    remember(value);return value;
   });
   if(!p||!current())return;
   const result=await client.write(operation,{...body,requestId:p.requestId},bound);if(!current())return;if(result.requestId!==p.requestId)throw new Error('请求回执无法核对');if(await finish(p)&&current())onSuccess(result,false);
  }
  catch(error){if(!current())return;const status=httpStatus(error);if(!p)setMessage('当前浏览器暂时无法安全协调多页面操作，本次尚未发送。已有待确认标识保留。');else if([401,403].includes(status)){onDenied?.();setMessage(rewardError(error));}else if([400,404,422,429].includes(status))await finish(p,rewardError(error));else setMessage('结果尚未确认。请读取原请求结果，不要重复提交。');}
  finally{lock.current=false;if(current())setBusy(false);}
 }
 async function readPending(){const p=pendingRef.current;if(lock.current||!p||!current())return;lock.current=true;setBusy(true);setMessage('');try{const receipt=await client.receipt(p.requestId,p.operation,bound);if(!current())return;if(receipt.found&&receipt.result){if(receipt.result.requestId!==p.requestId)throw new Error('请求回执无法核对');if(await finish(p)&&current())onSuccess({...receipt.result,code:undefined},true);}else setMessage('尚未查到最终回执，原操作仍待核对；未重新提交。');}catch(error){if(current()){if([401,403].includes(httpStatus(error)))onDenied?.();setMessage(rewardError(error));}}finally{lock.current=false;if(current())setBusy(false);}}
 return {pending,busy,message,submit,readPending};
}
