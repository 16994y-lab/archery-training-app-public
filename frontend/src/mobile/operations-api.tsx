import {useEffect,useRef,useState} from 'react';
import {RewardsClient,type RewardPage,sameIdentity,httpStatus,rewardError,newRewardRequestId} from './rewards-api';
import type {TeamIdentity} from './team-api';
import {withOperationsPendingLock} from './operations-pending';
export type OperationsRow={id:string;version:number;createdAt:string;updatedAt:string;userId?:string;state:string;category?:string;text?:string;appVersion?:string;page?:string;internalNote?:string;source?:string;amount?:string;reference?:string;sourceId?:string;kind?:string;detail?:string;originalRequestId?:string|null};
export type AnnouncementDraft={title:string;text:string;kind:'announcement'|'release';target:'user'|'coach'|'all';releaseVersion:string};
export type Announcement={id:string;version:number;draft:AnnouncementDraft;published:(AnnouncementDraft&{revision:number;publishedAt:string})|null;state:'draft'|'published'|'withdrawn';createdAt:string;updatedAt:string};
export type PublicAnnouncement=AnnouncementDraft&{id:string;revision:number;publishedAt:string};
export type OperationResult=Record<string,unknown>;
export const operationWritePaths=['operations/feedback/create','operations/donations/create','operations/incidents/create','admin/operations/feedback/update','admin/operations/feedback/create','admin/operations/donations/update','admin/operations/incidents/update','admin/operations/announcements/save','admin/operations/announcements/publish','admin/operations/announcements/withdraw'] as const;
export type OperationWritePath=typeof operationWritePaths[number];
export class OperationsClient{
 constructor(readonly rewards:RewardsClient){}
 identity=()=>this.rewards.identity();subscribe=(listener:()=>void)=>this.rewards.subscribe(listener);
 async read<T>(path:string,body:unknown,bound:TeamIdentity):Promise<T>{return this.rewards.connection.api.request<T>('/api/team/'+path,'POST',body,bound);}
 page<T>(kind:string,body:unknown,bound:TeamIdentity){return this.read<RewardPage<T>>(kind,body,bound);}
}
type Pending={requestId:string;path:OperationWritePath};
const feedbackVersionConflict='反馈已被更新，本次修改未保存。请重新查询后处理。';
export function useOperationsWrite(client:OperationsClient,bound:TeamIdentity,admin:boolean,success:(result:OperationResult)=>void,denied?:()=>void){
 const storageKey='gongxingji-operations-pending-v1:'+JSON.stringify([bound.service,bound.owner,admin]);
 type Stored={kind:'empty'}|{kind:'pending';value:Pending}|{kind:'unknown'};
 const unknownStorage='待确认标识无法核对，请保留当前页面并稍后重试；本次未发起新操作。';
 function readStored():Stored{try{
  const raw=localStorage.getItem(storageKey);if(raw===null)return {kind:'empty'};
  const v:unknown=JSON.parse(raw);
  if(typeof v!=='object'||v===null||Array.isArray(v)||Object.keys(v).length!==2||!('requestId'in v)||!('path'in v)||typeof v.requestId!=='string'||typeof v.path!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v.requestId)||!operationWritePaths.includes(v.path as OperationWritePath)||admin!==v.path.startsWith('admin/'))return {kind:'unknown'};
  return {kind:'pending',value:{requestId:v.requestId,path:v.path as OperationWritePath}};
 }catch{return {kind:'unknown'};}}
 const [initial]=useState<Stored>(readStored);
 const [pending,setPending]=useState<Pending|null>(initial.kind==='pending'?initial.value:null),[busy,setBusy]=useState(false),[message,setMessage]=useState(initial.kind==='unknown'?unknownStorage:'');
 const alive=useRef(true),lock=useRef(false),pendingRef=useRef(pending);useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 const current=()=>alive.current&&sameIdentity(client.identity(),bound);
 const remember=(value:Pending|null)=>{pendingRef.current=value;setPending(value);};
 const withPendingLock=<T,>(action:()=>T)=>withOperationsPendingLock(storageKey,current,action);
 async function finish(p:Pending,notice=''){
  try{return await withPendingLock(()=>{
  const stored=readStored();
  if(stored.kind==='unknown'){remember(p);setMessage([notice,unknownStorage].filter(Boolean).join(' '));return false;}
  if(stored.kind==='pending'&&(stored.value.requestId!==p.requestId||stored.value.path!==p.path)){
   remember(stored.value);setMessage([notice,'另有一笔操作仍待确认，请只读取原请求，不要重复提交。'].filter(Boolean).join(' '));return false;
  }
  // Only remove the record belonging to the response/receipt being completed.
  if(stored.kind==='pending')try{localStorage.removeItem(storageKey);}catch{remember(p);setMessage([notice,unknownStorage].filter(Boolean).join(' '));return false;}
  remember(null);setMessage(notice);return true;
  });}catch{if(current()){remember(p);setMessage([notice,'原请求已取得结果，但回查标识的更新尚未确认。请保留当前页面，稍后读取原请求结果。'].filter(Boolean).join(' '));}return false;}
 }
 async function submit(path:OperationWritePath,body:Record<string,unknown>){
  if(lock.current||!current()||admin!==path.startsWith('admin/'))return;
  lock.current=true;setBusy(true);setMessage('');let p:Pending|null=null;
  try{
   p=await withPendingLock(()=>{
    const stored=readStored();
    if(stored.kind==='unknown'){setMessage(unknownStorage);return null;}
    if(stored.kind==='pending'){remember(stored.value);setMessage('已有操作仍待确认，请只读取原请求，不要重复提交。');return null;}
    if(pendingRef.current)return null;
    const value:Pending={requestId:newRewardRequestId(),path};
    try{localStorage.setItem(storageKey,JSON.stringify(value));}catch{setMessage('无法保存回查标识，本次尚未发送。');return null;}
    const saved=readStored();
    if(saved.kind!=='pending'||saved.value.requestId!==value.requestId||saved.value.path!==value.path){remember(saved.kind==='pending'?saved.value:value);setMessage('无法核实已保存的回查标识，本次尚未发送。请保留当前页面。');return null;}
    remember(value);return value;
   });
   if(!p||!current())return;
   const result=await client.read<OperationResult>(path,{...body,requestId:p.requestId},bound);
   if(current()&&await finish(p)&&current())success(result);
  }catch(e){if(current()){
   if(!p)setMessage('当前浏览器暂时无法安全协调多页面操作，本次尚未发送。已有待确认标识保留，仍可读取原请求结果。');
   else if([401,403].includes(httpStatus(e))){denied?.();setMessage(rewardError(e));}
   else if(path==='admin/operations/feedback/update'&&httpStatus(e)===409&&typeof e==='object'&&e!==null&&'message'in e&&e.message===feedbackVersionConflict)await finish(p,feedbackVersionConflict);
   else if([400,404,422,429].includes(httpStatus(e)))await finish(p,rewardError(e));
   else setMessage('结果未确认。请只读取原请求，不要重复提交。');
  }}finally{lock.current=false;if(current())setBusy(false);}
 }
 async function readPending(){
  const p=pendingRef.current;if(lock.current||!p||!current())return;
  lock.current=true;setBusy(true);setMessage('');try{
   const result=await client.read<{found:boolean;result:OperationResult|null}>((admin?'admin/':'')+'operations/requests/read',{requestId:p.requestId},bound);
   if(current()){if(result.found&&result.result){if(await finish(p)&&current())success(result.result);}else setMessage('尚无最终回执，原操作仍待核对，未重新发送。');}
  }catch(e){if(current()){if([401,403].includes(httpStatus(e)))denied?.();setMessage(rewardError(e));}}finally{lock.current=false;if(current())setBusy(false);}
 }
 return {pending,busy,message,submit,readPending};
}
