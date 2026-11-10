import type {TeamIdentity} from './team-api';

export type RewardKey='sponsor'|'community'|'invite';
export type RewardMe={owner:string;service:string;inviteCode:string|null;writeReady:boolean;rewards:RewardKey[];revision:number;policyVersion:string};
export type RewardUser={userId:string;service:string;label:string;phoneMasked:string};
export type RewardSource={id:string;userId:string;reward:RewardKey;kind:'donation'|'community'|'invitation';active:boolean;version:number;createdAt:string;revokedAt:string|null};
export type ClaimState='pending'|'redeemed'|'expired'|'revoked';
export type RewardClaim={id:string;requestId:string;userId:string;state:ClaimState;createdAt:string;expiresAt:string;redeemedAt:string|null;version:number};
export type RewardContact={userId:string;version:number;qq:string|null;qqVerified:false;phone:string|null;phoneMasked:string;phoneVerified:boolean;eligible:boolean};
export type RewardPage<T>={items:T[];page:number;limit:number;hasMore:boolean;unavailableSources?:string[]};
export type RewardOperation='claim'|'issue'|'revoke_claim'|'donation'|'refund'|'revoke_source'|'contact';
export type RewardWriteResult={requestId:string;status:string;claim?:RewardClaim;claimId?:string;code?:string;sourceId?:string;reward?:RewardKey;revision?:number;version?:number;userId?:string;rewardRetained?:boolean};
export type RewardReceipt={found:boolean;requestId:string;operation:RewardOperation;result:RewardWriteResult|null};
export type RewardsTransport={identity:()=>TeamIdentity|null;request:<T>(path:string,method?:'GET'|'POST'|'PUT'|'DELETE',body?:unknown,bound?:TeamIdentity)=>Promise<T>};
export type RewardsConnection={api:RewardsTransport;subscribe:(listener:()=>void)=>()=>void};
export const rewardNames:Record<RewardKey,string>={sponsor:'星冠小弓',community:'披甲挽弓',invite:'结伴开弓'};
export const rewardImages:Record<RewardKey,string>={sponsor:'./ui/avatars-hidden/star-crown-v2.png',community:'./ui/avatars-hidden/armored-bow-v4.png',invite:'./ui/avatars-hidden/archery-friends-v7.png'};
export const rewardKeys:RewardKey[]=['sponsor','community','invite'];
export const identityKey=(identity:TeamIdentity|null)=>identity?JSON.stringify([identity.service,identity.owner,identity.epoch]):'';
export const sameIdentity=(a:TeamIdentity|null,b:TeamIdentity)=>identityKey(a)===identityKey(b);
export const httpStatus=(error:unknown)=>Number((error as {status?:unknown})?.status)||0;
export function rewardError(error:unknown){const status=httpStatus(error);return status===401?'账号已变化或登录已失效，请重新核对。':status===403?'当前账号没有此项权限，页面中的私密资料已清除。':status===409?'记录已变化或结果尚待核对，请先读取原请求结果。':status===429?'尝试较多，请稍后再核对。':status===503?'奖励服务暂未开放，请稍后刷新；原训练和头像保持。':status===400||status===422?'内容无法使用，请核对后重新填写。':'连接未完成，请稍后重新读取。';}
export function newRewardRequestId(){if(typeof crypto.randomUUID==='function')return crypto.randomUUID();const bytes=crypto.getRandomValues(new Uint8Array(16));bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;const s=[...bytes].map(b=>b.toString(16).padStart(2,'0')).join('');return `${s.slice(0,8)}-${s.slice(8,12)}-${s.slice(12,16)}-${s.slice(16,20)}-${s.slice(20)}`;}
export class RewardsClient{
 constructor(readonly connection:RewardsConnection){}
 identity=()=>this.connection.api.identity();
 subscribe=(listener:()=>void)=>this.connection.subscribe(listener);
 async readMe(bound:TeamIdentity):Promise<RewardMe>{
  const value=await this.connection.api.request<RewardMe>('/api/team/rewards/me','GET',undefined,bound);
  // service is the authentication domain (SUPABASE_URL), not TeamIdentity.service API origin.
  if(!sameIdentity(this.identity(),bound)||value.owner!==bound.owner||!/^https:\/\//.test(value.service)||!Array.isArray(value.rewards)||value.rewards.some(r=>!rewardKeys.includes(r))||!Number.isInteger(value.revision)||value.revision<0||(value.inviteCode!==null&&typeof value.inviteCode!=='string')||typeof value.writeReady!=='boolean')throw new Error('奖励响应无法核对');
  return value;
 }
 async read<T>(suffix:string,body:unknown,bound:TeamIdentity):Promise<T>{return this.connection.api.request<T>('/api/team/admin/rewards/'+suffix,'POST',body,bound);}
 async write(operation:RewardOperation,body:unknown,bound:TeamIdentity):Promise<RewardWriteResult>{
  const routes:Record<RewardOperation,string>={claim:'/api/team/rewards/claim',issue:'/api/team/admin/rewards/claims/issue',revoke_claim:'/api/team/admin/rewards/claims/revoke',donation:'/api/team/admin/rewards/donations/confirm',refund:'/api/team/admin/rewards/donations/refund',revoke_source:'/api/team/admin/rewards/sources/revoke',contact:'/api/team/admin/rewards/contacts/save'};
  return this.connection.api.request<RewardWriteResult>(routes[operation],'POST',body,bound);
 }
 async receipt(requestId:string,operation:RewardOperation,bound:TeamIdentity):Promise<RewardReceipt>{
  const path=operation==='claim'?'/api/team/rewards/requests/read':'/api/team/admin/rewards/requests/read';
  const value=await this.connection.api.request<RewardReceipt>(path,'POST',{requestId,operation},bound);
  if(value.requestId!==requestId||value.operation!==operation||typeof value.found!=='boolean'||value.found&&(!value.result||value.result.requestId!==requestId))throw new Error('请求回执无法核对');
  return value;
 }
}
