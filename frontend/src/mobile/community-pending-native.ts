import type {CommunityPendingStore,PendingWrite} from './Community';

type NativePending={communityPendingRead?:(scope:string,owner:string)=>string;communityPendingWrite?:(scope:string,owner:string,value:string)=>string};

function response(raw:string):string|null{
  const parsed=JSON.parse(raw) as {ok?:boolean;data?:unknown;error?:unknown};
  if(parsed.ok!==true)throw new Error(typeof parsed.error==='string'?parsed.error:'社区安全暂存失败；原请求保留');
  if(parsed.data!==null&&parsed.data!==undefined&&typeof parsed.data!=='string')throw new Error('社区安全暂存响应格式无效');
  return (parsed.data??null) as string|null;
}
function validateScope(scope:string,owner:string){
  const url=new URL(scope);
  if(url.protocol!=='https:'||url.origin!==scope||!url.hostname||!/^[A-Za-z0-9_-]{1,128}$/.test(owner))
    throw new Error('社区账号或服务范围无效');
}
function valid(value:unknown,scope:string,owner:string):value is PendingWrite{
  if(!value||typeof value!=='object')return false;
  const pending=value as Partial<PendingWrite>;
  return pending.owner===owner&&pending.scope===scope&&['post','comment'].includes(pending.kind??'')
    &&typeof pending.body==='string'&&pending.body.length>0&&pending.body.length<=(pending.kind==='comment'?300:500)
    &&typeof pending.key==='string'&&/^[A-Za-z0-9_-]{8,128}$/.test(pending.key)
    &&(pending.kind==='post'?pending.postId===undefined:typeof pending.postId==='string'&&/^[0-9a-fA-F-]{36}$/.test(pending.postId));
}

/** Production-only adapter. The native side checks the current encrypted session on every call. */
export function createNativeCommunityPendingStore(
  nativeReader:()=>NativePending|undefined=()=>typeof window==='undefined'?undefined:window.Gongxingji,
):CommunityPendingStore{
  function native(){const bridge=nativeReader();if(!bridge?.communityPendingRead||!bridge.communityPendingWrite)throw new Error('此安装包尚未接入社区安全暂存');return bridge;}
  return {
    read(scope,owner){
      validateScope(scope,owner);
      const raw=response(native().communityPendingRead!(scope,owner));
      if(raw===null)return null;
      const value=JSON.parse(raw) as PendingWrite;
      if(!valid(value,scope,owner))throw new Error('社区待确认内容与当前账号不符；原内容保留');
      return value;
    },
    write(scope,owner,value){
      validateScope(scope,owner);
      if(value!==null&&(!valid(value,scope,owner)||new TextEncoder().encode(JSON.stringify(value)).length>16*1024))
        throw new Error('社区待确认内容无效，未发送');
      response(native().communityPendingWrite!(scope,owner,value===null?'':JSON.stringify(value)));
    },
  };
}
