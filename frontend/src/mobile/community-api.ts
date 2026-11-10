/** Text community transport; production requires an explicitly injected identity and channel. */

export type CommunityPost={id:string;nickname:string;body:string;createdAt:string;revision:number;mine:boolean;status:'visible'|'hidden'|'deleted';commentCount:number};
export type CommunityComment={id:string;postId:string;nickname:string;body:string;createdAt:string;revision:number;mine:boolean;status:'visible'|'hidden'|'deleted'};
export type CommunityPage<T>={items:T[];nextCursor:string|null};
export type CommunityReport={id:string;targetKind:'post'|'comment';targetId:string;reason:'spam'|'abuse'|'privacy'|'other';createdAt:string;body:string;nickname:string;targetStatus:string};
export type ReportReason='spam'|'abuse'|'privacy'|'other';
export type CommunitySession={owner:string;scope:string;accessToken:string};
export type ProductionCommunityIdentity={owner:string;service:string;generation:number;sessionKey:string};
export type ProductionCommunityChannel={
  identity:()=>ProductionCommunityIdentity|null;
  enabled:()=>boolean;
  /** Check expected again in the same synchronous step that reads the bearer token. */
  request:(url:string,init:RequestInit,expected:ProductionCommunityIdentity)=>Promise<Response>;
};
export class CommunityHttpError extends Error {constructor(message:string,readonly status:number){super(message);}}
const path='/api/community';
const q=(value:string)=>encodeURIComponent(value);
const uuid='[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const productionRoutes:[RegExp,readonly string[]][]=[
  [/^\/api\/community\/profile$/,['GET','PUT']],
  [/^\/api\/community\/posts$/,['GET','POST']],
  [new RegExp(`^/api/community/posts/${uuid}$`),['GET','DELETE']],
  [new RegExp(`^/api/community/posts/${uuid}/comments$`),['GET','POST']],
  [new RegExp(`^/api/community/comments/${uuid}$`),['DELETE']],
  [/^\/api\/community\/reports$/,['POST']],
  [/^\/api\/community\/moderation\/reports$/,['GET']],
  [new RegExp(`^/api/community/moderation/reports/${uuid}$`),['PATCH']],
];

/** Reuse this check before the injected transport attaches a bearer token. */
export function validateProductionCommunityRequest(target:string,init:RequestInit,approvedOrigin:string):void{
  const url=new URL(target),method=(init.method??'GET').toUpperCase();
  if(url.origin!==approvedOrigin||url.protocol!=='https:'||url.username||url.password||url.hash
    ||!productionRoutes.some(([route,methods])=>route.test(url.pathname)&&methods.includes(method)))throw new Error('社区正式请求路径或方法未获准');
  const listing=method==='GET'&&(url.pathname==='/api/community/posts'||new RegExp(`^/api/community/posts/${uuid}/comments$`).test(url.pathname));
  const keys=[...url.searchParams.keys()];
  if((!listing&&keys.length>0)||keys.some(key=>!['cursor','limit'].includes(key)||url.searchParams.getAll(key).length!==1)
    ||(url.searchParams.has('cursor')&&!/^[A-Za-z0-9_-]{1,256}$/.test(url.searchParams.get('cursor')??''))
    ||(url.searchParams.has('limit')&&!/^(?:[1-9]|[1-4][0-9]|50)$/.test(url.searchParams.get('limit')??'')))throw new Error('社区正式请求参数未获准');
  const headers=new Headers(init.headers);
  for(const key of headers.keys())if(!['accept','content-type','idempotency-key','if-match'].includes(key))throw new Error('社区正式请求头未获准');
  if(headers.get('accept')!=='application/json')throw new Error('社区正式请求需 JSON 响应');
  const writes=['POST','PUT','PATCH'].includes(method);
  if(writes){
    if(headers.get('content-type')!=='application/json'||typeof init.body!=='string'||new TextEncoder().encode(init.body).length>4096)throw new Error('社区正式请求正文无效');
  }else if(init.body!==undefined||headers.has('content-type'))throw new Error('社区正式请求不应携带正文');
  const create=method==='POST'&&(url.pathname==='/api/community/posts'||/\/comments$/.test(url.pathname));
  const key=headers.get('idempotency-key');
  if(create?!key||!/^[A-Za-z0-9_-]{8,128}$/.test(key):key!==null)throw new Error('社区正式请求标识无效');
  const revision=headers.get('if-match');
  if(method==='DELETE'?!revision||!/^[1-9][0-9]*$/.test(revision):revision!==null)throw new Error('社区正式请求修订号无效');
}

export class CommunityApi {
  readonly scope:string;
  constructor(base:string,private readonly session:()=>CommunitySession|null,private readonly http:typeof fetch=globalThis.fetch.bind(globalThis),private readonly production?:ProductionCommunityChannel,private readonly productionExpected?:ProductionCommunityIdentity){
    const url=new URL(base);
    if(production){
      if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/'||!url.hostname)throw new Error('正式社区只允许核定 HTTPS 服务根地址');
    }else if(url.protocol!=='http:'||!['localhost','127.0.0.1'].includes(url.hostname)||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw new Error('社区试验服务只允许本机回环地址');
    this.scope=url.origin;
  }
  identityMatches(identity:{owner:string;scope:string;generation?:number;sessionKey?:string}):boolean{
    if(identity.scope!==this.scope)return false;
    if(!this.production)return this.session()?.owner===identity.owner;
    const current=this.production.identity(),expected=this.productionExpected;
    return !!current&&!!expected&&current.owner===identity.owner&&current.service===identity.scope
      &&current.generation===identity.generation&&current.sessionKey===identity.sessionKey
      &&expected.owner===current.owner&&expected.service===current.service
      &&expected.generation===current.generation&&expected.sessionKey===current.sessionKey;
  }
  private async request<T>(route:string,method:'GET'|'POST'|'PUT'|'PATCH'|'DELETE'='GET',body?:unknown,options:{idempotencyKey?:string;revision?:number}={}):Promise<T>{
    if(!this.production&&typeof window!=='undefined'&&(window as Window&{Gongxingji?:unknown}).Gongxingji)throw new Error('当前 APK 原生网络桥未接入社区；请使用隔离浏览器验收页');
    if(!route.startsWith(`${path}/`)||route.includes('..'))throw new Error('社区接口路径无效');
    const endpoint=new URL(route,this.scope);
    if(endpoint.origin!==this.scope||!endpoint.pathname.startsWith(`${path}/`))throw new Error('社区接口路径无效');
    const current=this.production?this.production.identity():this.session();
    if(this.production){
      if(!this.production.enabled())throw new CommunityHttpError('社区正式服务尚未开放',503);
      if(!current||!current.owner||!('service' in current)||current.service!==this.scope||!Number.isSafeInteger(current.generation)||current.generation<0
        ||!current.sessionKey||!this.productionExpected||current.owner!==this.productionExpected.owner
        ||current.service!==this.productionExpected.service||current.generation!==this.productionExpected.generation
        ||current.sessionKey!==this.productionExpected.sessionKey)throw new CommunityHttpError('社区账号已切换，请重新打开',401);
    }else if(!current||!current.owner||!('accessToken' in current)||!current.accessToken||current.scope!==this.scope)throw new CommunityHttpError('请使用隔离试验账号',401);
    const headers:Record<string,string>={Accept:'application/json'};
    if(!this.production&&current&&'accessToken' in current)headers.Authorization=`Bearer ${current.accessToken}`;
    if(body!==undefined)headers['Content-Type']='application/json';
    if(options.idempotencyKey)headers['Idempotency-Key']=options.idempotencyKey;
    if(options.revision!==undefined)headers['If-Match']=String(options.revision);
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),30000);
    let response:Response;
    try{
      const init:RequestInit={method,cache:'no-store',credentials:'omit',redirect:'error',referrerPolicy:'no-referrer',headers,body:body===undefined?undefined:JSON.stringify(body),signal:controller.signal};
      if(this.production)validateProductionCommunityRequest(endpoint.toString(),init,this.scope);
      response=await (this.production?this.production.request(endpoint.toString(),init,{...this.productionExpected!}):this.http(endpoint.toString(),init));
    }
    finally{clearTimeout(timer);}
    const sameIdentity=()=>{
      const after=this.production?this.production.identity():this.session();
      return !!after&&after.owner===current.owner&&(!this.production||this.production.enabled())
        &&(this.production?('service' in after&&'service' in current&&after.service===current.service&&after.generation===current.generation&&after.sessionKey===current.sessionKey):('accessToken' in after&&'accessToken' in current&&after.scope===current.scope&&after.accessToken===current.accessToken));
    };
    if(!sameIdentity())throw new Error('账号已切换，旧社区响应已丢弃');
    if(!response.ok){let detail='';try{const result=await response.json();if(typeof result.detail==='string')detail='：'+result.detail.slice(0,220);}catch{/* Keep HTTP status. */}
      if(!sameIdentity())throw new Error('账号已切换，旧社区响应已丢弃');
      throw new CommunityHttpError(response.status===409?'社区内容已变化，请刷新核对后再试':response.status===429?'操作过于频繁，请稍后再试':`社区请求未完成（${response.status}）${detail}`,response.status);}
    if(response.status===204)return undefined as T;
    const value=await response.json() as T;
    if(!sameIdentity())throw new Error('账号已切换，旧社区响应已丢弃');
    return value;
  }
  profile(){return this.request<{nickname:string|null}>(`${path}/profile`);}
  setNickname(nickname:string){return this.request<{nickname:string}>(`${path}/profile`,'PUT',{nickname});}
  posts(cursor?:string){return this.request<CommunityPage<CommunityPost>>(`${path}/posts${cursor?`?cursor=${q(cursor)}`:''}`);}
  createPost(body:string,idempotencyKey:string){return this.request<CommunityPost>(`${path}/posts`,'POST',{body},{idempotencyKey});}
  deletePost(id:string,revision:number){return this.request<void>(`${path}/posts/${q(id)}`,'DELETE',undefined,{revision});}
  comments(postId:string,cursor?:string){return this.request<CommunityPage<CommunityComment>>(`${path}/posts/${q(postId)}/comments${cursor?`?cursor=${q(cursor)}`:''}`);}
  createComment(postId:string,body:string,idempotencyKey:string){return this.request<CommunityComment>(`${path}/posts/${q(postId)}/comments`,'POST',{body},{idempotencyKey});}
  deleteComment(id:string,revision:number){return this.request<void>(`${path}/comments/${q(id)}`,'DELETE',undefined,{revision});}
  report(target_kind:'post'|'comment',target_id:string,reason:ReportReason){return this.request<{id:string;status:string}>(`${path}/reports`,'POST',{target_kind,target_id,reason});}
  reports(){return this.request<{items:CommunityReport[]}>(`${path}/moderation/reports`);}
  review(id:string,decision:'hide'|'dismiss'){return this.request<{id:string;status:string;decision:string}>(`${path}/moderation/reports/${q(id)}`,'PATCH',{decision});}
}

/** No default production instance is created. The caller owns auth and native HTTP allowlists. */
export function createProductionCommunityApi(base:string,channel:ProductionCommunityChannel,expected:ProductionCommunityIdentity):CommunityApi{
  if(!channel||typeof channel.identity!=='function'||typeof channel.enabled!=='function'||typeof channel.request!=='function'||!expected||!expected.owner||!expected.sessionKey)throw new Error('正式社区需明确身份与网络通道');
  return new CommunityApi(base,()=>null,undefined,channel,expected);
}
