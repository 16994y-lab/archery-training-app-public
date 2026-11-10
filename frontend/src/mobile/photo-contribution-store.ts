import type {ContributionConflictReason} from './photo-contribution-api';
import type {ChoiceState,ChoiceWrite,Manifest} from './photo-contribution-contract';
export type ContributionIdentity={owner:string;authService:string;apiService:string;epoch:number};
export const scopeKey=(i:ContributionIdentity)=>JSON.stringify([i.authService,i.owner]);
export type Step='new'|'prepare-unknown'|'prepared'|'content-unknown'|'uploaded'|'finalize-unknown'|'received'|'stopped';
export type QueuedSample={sampleId:string;epoch:string;revision:number;manifest:Manifest;manifestSha256:string;image:Blob|null;step:Step;prepareId:string;contentId:string;finalizeId:string;conflict?:ContributionConflictReason};
export type ContributionScope={key:string;stopped:boolean;stopRequested:boolean;choice:ChoiceState|null;pendingChoice:(ChoiceWrite&{attempted:boolean})|null;tombstones:{sampleId:string;requestIds:string[]}[];samples:QueuedSample[];deleted?:true};
export const emptyScope=(key:string):ContributionScope=>({key,stopped:false,stopRequested:false,choice:null,pendingChoice:null,tombstones:[],samples:[]});
export interface ContributionStore{read(key:string):Promise<ContributionScope>;change(key:string,change:(scope:ContributionScope)=>void):Promise<ContributionScope>}
/** Separate database; never opens personal training, cloud backup or media stores. */
export class IndexedContributionStore implements ContributionStore{
 private db:Promise<IDBDatabase>|null=null;
 private open(){return this.db??=new Promise<IDBDatabase>((resolve,reject)=>{const request=indexedDB.open('gongxingji-photo-contributions-v1',1);request.onupgradeneeded=()=>request.result.createObjectStore('scopes',{keyPath:'key'});request.onerror=()=>reject(Error('贡献队列暂不可用'));request.onblocked=()=>reject(Error('贡献队列待关闭旧页面'));request.onsuccess=()=>resolve(request.result);});}
 async read(key:string){const db=await this.open();return new Promise<ContributionScope>((resolve,reject)=>{const tx=db.transaction('scopes','readonly'),r=tx.objectStore('scopes').get(key);r.onsuccess=()=>resolve(r.result??emptyScope(key));r.onerror=()=>reject(Error('贡献队列读取失败'));});}
 async change(key:string,change:(scope:ContributionScope)=>void){const db=await this.open();return new Promise<ContributionScope>((resolve,reject)=>{const tx=db.transaction('scopes','readwrite'),s=tx.objectStore('scopes'),r=s.get(key);let value:ContributionScope;r.onsuccess=()=>{try{value=r.result??emptyScope(key);if(value.deleted)throw Error('此账号已注销，旧贡献任务不能恢复');change(value);s.put(value);}catch{tx.abort();}};tx.oncomplete=()=>resolve(value);tx.onerror=tx.onabort=()=>reject(Error('贡献队列未持久保存'));});}
}
