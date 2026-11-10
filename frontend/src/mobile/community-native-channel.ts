import {validateProductionCommunityRequest,type ProductionCommunityChannel,type ProductionCommunityIdentity} from './community-api';

type NativeReply={id?:unknown;status?:unknown;body?:unknown;error?:unknown};
type Waiting={resolve:(response:Response)=>void;reject:(error:Error)=>void;signal?:AbortSignal;onAbort?:()=>void};
const waiting=new Map<string,Waiting>();

function same(left:ProductionCommunityIdentity|null,right:ProductionCommunityIdentity):boolean{
  return !!left&&left.owner===right.owner&&left.service===right.service
    &&left.generation===right.generation&&left.sessionKey===right.sessionKey;
}
if(typeof window!=='undefined')window.addEventListener('gongxingji-http',event=>{
  const reply=(event as CustomEvent<NativeReply>).detail,id=reply?.id;
  if(typeof id!=='string'||!id.startsWith('community-'))return;
  const pending=waiting.get(id);if(!pending)return;
  waiting.delete(id);
  if(pending.onAbort)pending.signal?.removeEventListener('abort',pending.onAbort);
  try{
    if(typeof reply.error==='string'&&reply.error)throw new Error(reply.error);
    if(typeof reply.status!=='number'||reply.status<200||reply.status>599||typeof reply.body!=='string')throw new Error('社区服务响应无效');
    pending.resolve(new Response([204,205,304].includes(reply.status)?null:reply.body,{status:reply.status,headers:{'Content-Type':'application/json'}}));
  }catch(error){pending.reject(error instanceof Error?error:new Error('社区服务响应无效'));}
});

/** The native worker obtains the bearer from Keystore after checking current owner and service. */
export function createNativeProductionCommunityChannel(source:{identity:()=>ProductionCommunityIdentity|null;enabled:()=>boolean}):ProductionCommunityChannel{
  const available=()=>typeof window!=='undefined'&&typeof window.Gongxingji?.communityRequest==='function'
    &&typeof window.Gongxingji?.communitySessionFingerprint==='function';
  return {
    identity:source.identity,
    enabled:()=>source.enabled()&&available(),
    async request(url,init,expected){
      if(!source.enabled()||!available())throw new Error('此安装包尚未接入正式社区网络');
      if(!same(source.identity(),expected))throw new Error('社区账号已切换，旧请求未发送');
      validateProductionCommunityRequest(url,init,expected.service);
      // Android HttpURLConnection cannot issue PATCH. Moderation must use an
      // independently accepted browser/admin channel before production opens.
      if(init.method==='PATCH')throw new Error('此安装包尚未接入社区审核操作');
      const bridge=window.Gongxingji!,id=`community-${crypto.randomUUID()}`;
      const fingerprintReply=JSON.parse(bridge.communitySessionFingerprint!(expected.service,expected.owner)) as {ok?:boolean;data?:unknown;error?:unknown};
      if(!fingerprintReply.ok||typeof fingerprintReply.data!=='string'||!/^[a-f0-9]{64}$/.test(fingerprintReply.data))
        throw new Error(typeof fingerprintReply.error==='string'?fingerprintReply.error:'社区登录会话无法核对');
      const sessionFingerprint=fingerprintReply.data;
      const headers=Object.fromEntries(new Headers(init.headers).entries());
      const response=await new Promise<Response>((resolve,reject)=>{
        const item:Waiting={resolve,reject,signal:init.signal??undefined};
        item.onAbort=()=>{if(waiting.delete(id))reject(new Error('社区连接超时；待确认内容保留原请求标识'));};
        if(init.signal?.aborted){reject(new Error('社区连接超时；待确认内容保留原请求标识'));return;}
        waiting.set(id,item);
        init.signal?.addEventListener('abort',item.onAbort,{once:true});
        try{bridge.communityRequest!(id,url,init.method??'GET',JSON.stringify(headers),typeof init.body==='string'?init.body:'',expected.service,expected.owner,sessionFingerprint);}
        catch(error){waiting.delete(id);init.signal?.removeEventListener('abort',item.onAbort);reject(error instanceof Error?error:new Error('社区网络入口不可用'));}
      });
      if(!same(source.identity(),expected)||!source.enabled())throw new Error('社区账号已切换，旧响应已丢弃');
      return response;
    },
  };
}
