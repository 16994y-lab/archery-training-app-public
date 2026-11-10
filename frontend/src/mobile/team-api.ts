import {readBoundedResponse} from './bounded-response';

export type TeamIdentity={owner:string;service:string;epoch:number};
export type CoachStatus='pending'|'approved'|'suspended'|'rejected';
export type SharingGrant={version:number;active:boolean;sessionIds:string[];includeFuture:boolean;futureFrom:string|null;expiresOn:string|null};
export type MyTeam={id:string;name:string;coachId:string;coachName:string;memberId:string;memberStatus:string;grant:SharingGrant|null;groups:TeamGroup[]};
export type TeamGroup={id:string;name:string;kind:'mixed'|'men'|'women';memberIds:string[];preset:string;version:number;config:{bow:string;distance:number;size:number;targetId:string;ends:number;arrowsPerAthlete:number;scoring:'set'|'cumulative'}};
export type TeamMe={roles:string[];coach:{status:CoachStatus;version:number;name:string;organisation:string}|null;teams:MyTeam[]};
export type TeamChannel={identity:()=>TeamIdentity|null;prepare?:()=>Promise<void>;request:(url:string,init:RequestInit,expected:TeamIdentity)=>Promise<Response>};
export class TeamHttpError extends Error{constructor(message:string,readonly status:number){super(message);this.name='TeamHttpError';}}
const uuid='[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const sourceId='[A-Za-z0-9_-]{1,128}';
const routes:[RegExp,readonly string[]][]=[
 [/^\/api\/team\/rewards\/me$/,['GET']],
 [/^\/api\/team\/rewards\/(?:claim|requests\/read)$/,['POST']],
 [/^\/api\/team\/admin\/rewards\/(?:users\/search|sources\/(?:search|revoke)|claims\/(?:search|issue|revoke)|donations\/(?:confirm|refund)|contacts\/(?:read|save)|requests\/read)$/,['POST']],
 [/^\/api\/team\/operations\/(?:feedback\/(?:create|search)|donations\/(?:create|search)|incidents\/create|announcements\/read|requests\/read)$/,['POST']],
 [/^\/api\/team\/admin\/operations\/(?:home|profile|metrics|sms\/(?:summary|provider\/summary)|users\/(?:search|detail)|feedback\/(?:search|update|create)|donations\/(?:search|update)|incidents\/(?:search|update)|announcements\/(?:search|save|publish|withdraw)|audits\/search|requests\/read)$/,['POST']],
 [/^\/api\/team\/me$/,['GET']],
 [/^\/api\/team\/coach-application$/,['POST']],
 [/^\/api\/team\/admin\/coaches$/,['GET']],
 [new RegExp(`^/api/team/admin/coaches/${uuid}$`),['PUT']],
 [/^\/api\/team\/coach\/teams$/,['GET']],
 [new RegExp(`^/api/team/coach/teams/${uuid}/invites$`),['POST']],
 [new RegExp(`^/api/team/coach/teams/${uuid}/members/${uuid}$`),['PUT']],
 [/^\/api\/team\/invitations\/accept$/,['POST']],
 [new RegExp(`^/api/team/member/teams/${uuid}/sharing$`),['GET','PUT','DELETE']],
 [new RegExp(`^/api/team/member/teams/${uuid}/sessions/${sourceId}$`),['GET','PUT']],
 [new RegExp(`^/api/team/coach/teams/${uuid}/review$`),['GET']],
 [new RegExp(`^/api/team/coach/teams/${uuid}/sessions/${uuid}/${sourceId}$`),['GET']],
 [new RegExp(`^/api/team/coach/teams/${uuid}/(?:groups|notes)$`),['PUT']],
 [new RegExp(`^/api/team/coach/teams/${uuid}/report$`),['POST']],
];
export function validateTeamRequest(url:string,init:RequestInit,origin:string){
 const target=new URL(url),method=(init.method||'GET').toUpperCase();
 if(target.origin!==origin||target.protocol!=='https:'||target.username||target.password||target.hash||target.search
  ||!routes.some(([pattern,methods])=>pattern.test(target.pathname)&&methods.includes(method)))throw new Error('团队请求地址或方法无效');
 const h=new Headers(init.headers);
 if([...h.keys()].some(k=>!['accept','content-type'].includes(k))||h.get('accept')!=='application/json')throw new Error('团队请求头无效');
 if(method==='GET'){if(init.body!==undefined||h.has('content-type'))throw new Error('读取团队不应携带正文');}
 else if(h.get('content-type')!=='application/json'||typeof init.body!=='string'||new TextEncoder().encode(init.body).length>2*1024*1024)throw new Error('团队请求正文超过范围');
}
const same=(a:TeamIdentity|null,b:TeamIdentity)=>!!a&&a.owner===b.owner&&a.service===b.service&&a.epoch===b.epoch;
export class TeamApi{
 constructor(private channel:TeamChannel){}
 identity(){return this.channel.identity();}
 async request<T>(path:string,method:'GET'|'POST'|'PUT'|'DELETE'='GET',body?:unknown,bound?:TeamIdentity):Promise<T>{
  const before=this.channel.identity();
  await this.channel.prepare?.();
  const expected=this.channel.identity();if(!expected)throw new TeamHttpError('请联网核对当前账号后使用团队功能',401);
  if(bound&&!same(expected,bound)||before&&(before.owner!==expected.owner||before.service!==expected.service))throw new TeamHttpError('账号已变化，旧操作未发送',401);
  const init:RequestInit={method,cache:'no-store',credentials:'omit',redirect:'error',referrerPolicy:'no-referrer',headers:{Accept:'application/json',...(method==='GET'?{}:{'Content-Type':'application/json'})},...(method==='GET'?{}:{body:JSON.stringify(body??{})})};
  const url=expected.service+path;validateTeamRequest(url,init,expected.service);
  let response:Response;try{response=await this.channel.request(url,init,expected);}catch(error){if(!same(this.channel.identity(),expected))throw new TeamHttpError('账号已变化，旧请求结果未采用',401);throw error;}
  const text=new TextDecoder().decode(await readBoundedResponse(response,2*1024*1024+8192));if(!same(this.channel.identity(),expected))throw new TeamHttpError('账号已变化，旧响应未采用',401);
  let result:unknown;try{result=JSON.parse(text);}catch{throw new TeamHttpError('团队服务响应无法核对，请稍后重新读取',response.status||502);}
  if(!response.ok){const detail=(result as {detail?:unknown}).detail;throw new TeamHttpError(typeof detail==='string'?detail:'团队操作未完成，请重新核对权限与当前状态',response.status);}
  return result as T;
 }
}
