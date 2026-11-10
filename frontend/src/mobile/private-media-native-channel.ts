import {validateNativeContributionRequest} from './photo-contribution-api';
import type {ProductionCommunityIdentity} from './community-api';

const MAX_FILE=50*1024*1024,MAX_JSON=1024*1024,CHUNK=256*1024;
const OBJECT='/api/private-media/[a-f0-9]{32}';
const ARCHIVE='/api/media-archives/[a-f0-9]{32}';
type Method='GET'|'POST'|'PUT'|'PATCH';
type Source={identity:()=>ProductionCommunityIdentity|null;enabled:()=>boolean};
type Reply={id?:unknown;phase?:unknown;status?:unknown;bytes?:unknown;sequence?:unknown;chunks?:unknown;body?:unknown;error?:unknown};
type Pending={expected:ProductionCommunityIdentity;binary:boolean;terminal?:{value:unknown};resolve:(value:unknown)=>void;reject:(error:Error)=>void;signal:AbortSignal;abort:()=>void;timer:ReturnType<typeof setTimeout>;poll:ReturnType<typeof setInterval>;buffer?:Uint8Array;position:number;sequence:number};
export class NativePrivateMediaHttpError extends Error {constructor(readonly status:number){super(`媒体请求未完成（${status}）；所选对象保留本机`);}}
function same(left:ProductionCommunityIdentity|null,right:ProductionCommunityIdentity){return !!left&&left.owner===right.owner&&left.service===right.service&&left.generation===right.generation&&left.sessionKey===right.sessionKey;}
function checkReply(raw:string):unknown{
  const value=JSON.parse(raw) as {ok?:unknown;data?:unknown;error?:unknown};
  if(value.ok!==true)throw new Error(typeof value.error==='string'?value.error:'媒体安装包入口未确认');return value.data;
}
function base64(bytes:Uint8Array){let text='';for(let i=0;i<bytes.length;i++)text+=String.fromCharCode(bytes[i]);return btoa(text);}
function decode(raw:unknown){
  if(typeof raw!=='string'||raw.length>4*Math.ceil(CHUNK/3)||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(raw))throw new Error('媒体回读分块无效');
  const text=atob(raw);if(text.length<1||text.length>CHUNK||btoa(text)!==raw)throw new Error('媒体回读分块无效');
  return Uint8Array.from(text,char=>char.charCodeAt(0));
}
export function validateNativePrivateMediaRequest(method:Method,path:string,body:unknown,extra:Record<string,string>){
  const content=new RegExp(`^${OBJECT}/content$`).test(path),training=new RegExp(`^${OBJECT}/training-consent$`).test(path);
  const effective=method==='PATCH'&&training?'POST':method;
  const read=effective==='GET'&&(path==='/api/private-media'||content||new RegExp(`^${OBJECT}/access$`).test(path));
  const json=effective==='POST'&&(path==='/api/private-media/intents'||training);
  const upload=effective==='PUT'&&content;
  if(!read&&!json&&!upload)throw new Error('媒体路径或方法未获准');
  const headers:Record<string,string>={accept:'application/json'};
  for(const [key,value] of Object.entries(extra)){
    const normalized=key.toLowerCase();if(!['content-type','x-media-access'].includes(normalized)||headers[normalized]!==undefined
      ||typeof value!=='string'||value.length>1024||/[\r\n]/.test(value))throw new Error('媒体请求头未获准');headers[normalized]=value;
  }
  const mime=headers['content-type'],access=headers['x-media-access'];
  if(upload){if(!(body instanceof Uint8Array)||body.byteLength<1||body.byteLength>MAX_FILE||!['image/png','image/jpeg','image/webp','video/mp4'].includes(mime))throw new Error('媒体文件超出容量或类型保护');}
  else if(json){if(body===undefined||body===null||typeof body!=='object'||body instanceof Uint8Array||Array.isArray(body)||mime!==undefined)throw new Error('媒体请求正文无效');headers['content-type']='application/json';}
  else if(body!==undefined||mime!==undefined)throw new Error('媒体读取不能附带正文');
  if(read&&content){if(typeof access!=='string'||!/^[-_A-Za-z0-9]{16,512}$/.test(access))throw new Error('媒体访问凭据无效');}
  else if(access!==undefined)throw new Error('媒体访问凭据不属于此路径');
  const text=json?JSON.stringify(body):'';if(new TextEncoder().encode(text).length>65536)throw new Error('媒体请求正文超出容量');
  return {method:effective as 'GET'|'POST'|'PUT',headers,json:text,bytes:upload?(body as Uint8Array).byteLength:0,binary:read&&content};
}

/** Archive routes have their own gate and never accept media uploads or access credentials. */
export function validateNativeMediaArchiveRequest(method:'GET'|'POST',path:string,body?:unknown){
  const chunk=method==='POST'&&new RegExp(`^${ARCHIVE}/content-chunk$`).test(path);
  const lease=method==='POST'&&new RegExp(`^${ARCHIVE}/download-lease$`).test(path);
  const revoke=method==='POST'&&new RegExp(`^${ARCHIVE}/revoke-download$`).test(path);
  const binary=chunk||(method==='GET'&&new RegExp(`^${ARCHIVE}/content$`).test(path));
  const read=method==='GET'&&(binary||new RegExp(`^${ARCHIVE}$`).test(path));
  const restore=method==='POST'&&new RegExp(`^${ARCHIVE}/verify-restore$`).test(path);
  const write=method==='POST'&&(path==='/api/media-archives'||path==='/api/media-archives/lookup'||restore||chunk||lease||revoke);
  if(!read&&!write)throw new Error('媒体归档路径或方法未获准');
  if(read&&body!==undefined)throw new Error('归档读取不能附带正文');
  const requestBody=(restore||lease)&&body===undefined?{}:body;
  if(write&&(!requestBody||typeof requestBody!=='object'||Array.isArray(requestBody)||requestBody instanceof Uint8Array))throw new Error('归档请求正文无效');
  if(chunk||revoke){
    const value=requestBody as Record<string,unknown>,keys=chunk?['leaseToken','offset','bytes']:['leaseToken'];
    if(Object.keys(value).length!==keys.length||keys.some(key=>!Object.prototype.hasOwnProperty.call(value,key))||typeof value.leaseToken!=='string'||!/^[-_A-Za-z0-9]{16,128}$/.test(value.leaseToken)
      ||(chunk&&(!Number.isSafeInteger(value.offset)||Number(value.offset)<0||!Number.isSafeInteger(value.bytes)||Number(value.bytes)<1||Number(value.bytes)>3*1024*1024)))throw new Error('归档固定分块或租约无效');
  }
  if(path==='/api/media-archives/lookup'){const value=requestBody as Record<string,unknown>;if(Object.keys(value).length!==1||typeof value.idempotencyKey!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value.idempotencyKey))throw new Error('归档原请求标识无效');}
  if(lease&&Object.keys(requestBody as object).length)throw new Error('归档租约不能指定外部对象');
  const json=write?JSON.stringify(requestBody):'';
  if(new TextEncoder().encode(json).length>65536)throw new Error('归档请求正文超出容量');
  const headers:Record<string,string>={accept:binary?'application/zip':'application/json'};
  if(write)headers['content-type']='application/json';
  return {method,headers,json,bytes:0,binary};
}

/** Native owns the bearer; the JS side only sees a fingerprint and bounded byte chunks. */
export function createNativePrivateMediaChannel(source:Source,kind:'private-media'|'media-archive'|'photo-contribution'='private-media'){
  const pending=new Map<string,Pending>();
  let disposed=false;
  const fingerprint=kind==='photo-contribution'?'photoContributionFingerprint':kind==='media-archive'?'mediaArchiveFingerprint':'privateMediaFingerprint';
  const available=()=>!disposed&&typeof window!=='undefined'&&[fingerprint,'privateMediaBegin','privateMediaChunk','privateMediaFinish','privateMediaCancel'].every(key=>typeof (window.Gongxingji as unknown as Record<string,unknown>|undefined)?.[key]==='function');
  function finish(id:string,error?:Error,value?:unknown){
    const item=pending.get(id);if(!item)return;pending.delete(id);clearTimeout(item.timer);clearInterval(item.poll);item.signal.removeEventListener('abort',item.abort);
    if(error){try{window.Gongxingji?.privateMediaCancel?.(id);}catch{/* An uncertain prior write stays uncertain. */}item.buffer=undefined;item.reject(error);}else item.resolve(value);
  }
  const onReply=(event:Event)=>{
    const reply=(event as CustomEvent<Reply>).detail;if(typeof reply?.id!=='string')return;
    const id=reply.id,item=pending.get(id);if(!item)return;
    try{
      if(!source.enabled()||!same(source.identity(),item.expected)||item.signal.aborted)throw new Error('媒体账号或操作已变化，旧响应未采用');
      if(reply.phase==='error')throw new Error('媒体连接未确认；本机对象保留');
      if(reply.phase==='ready'){
        if(!item.terminal)throw new Error('媒体工作尚未释放；结果未确认');finish(id,undefined,item.terminal.value);return;
      }
      if(item.terminal)throw new Error('媒体终态响应重复或顺序无效');
      if(reply.phase==='json'){
        if(item.buffer||!Number.isInteger(reply.status)||Number(reply.status)<200||Number(reply.status)>599||typeof reply.body!=='string'||new TextEncoder().encode(reply.body).length>MAX_JSON||(item.binary&&Number(reply.status)<300))throw new Error('媒体清单响应无效');
        if(Number(reply.status)>=300)throw new NativePrivateMediaHttpError(Number(reply.status));
        const value=JSON.parse(reply.body);item.terminal={value};
      }else if(reply.phase==='binary-start'){
        if(!item.binary||item.buffer||!Number.isInteger(reply.bytes)||Number(reply.bytes)<1||Number(reply.bytes)>MAX_FILE||!Number.isInteger(reply.status)||Number(reply.status)<200||Number(reply.status)>=300)throw new Error('媒体回读长度或状态无效');
        item.buffer=new Uint8Array(Number(reply.bytes));
      }else if(reply.phase==='binary-chunk'){
        if(!item.buffer||reply.sequence!==item.sequence)throw new Error('媒体回读顺序无效');
        const bytes=decode(reply.body);if(item.position+bytes.length>item.buffer.length)throw new Error('媒体回读超出声明容量');item.buffer.set(bytes,item.position);item.position+=bytes.length;item.sequence++;
      }else if(reply.phase==='binary-complete'){
        if(!item.buffer||item.position!==item.buffer.length||reply.bytes!==item.position||reply.chunks!==item.sequence)throw new Error('媒体回读不完整；未记为保存成功');item.terminal={value:item.buffer};
      }else throw new Error('媒体响应步骤无效');
    }catch(error){finish(id,error instanceof Error?error:new Error('媒体响应无效'));}
  };
  const cancelAll=()=>{for(const id of [...pending.keys()])finish(id,new Error('媒体操作已暂停；本机对象保留，云结果仍需核对'));};
  const dispose=()=>{disposed=true;cancelAll();if(typeof window!=='undefined'){window.removeEventListener('gongxingji-media',onReply);window.removeEventListener('gongxingji-background',cancelAll);window.removeEventListener('pagehide',dispose);window.removeEventListener('beforeunload',dispose);}};
  if(typeof window!=='undefined'){window.addEventListener('gongxingji-media',onReply);window.addEventListener('gongxingji-background',cancelAll);window.addEventListener('pagehide',dispose);window.addEventListener('beforeunload',dispose);}
  return {
    available,isDisposed:()=>disposed,dispose,
    async request(method:Method,path:string,signal:AbortSignal,body?:unknown,extra:Record<string,string>={}):Promise<unknown>{
      if(!source.enabled()||!available())throw new Error('此安装包尚未开放私有媒体保存；本机对象保留');
      if(pending.size)throw new Error('请先完成或取消当前媒体核对');
      const identity=source.identity();if(!identity||signal.aborted||!['https://service-1.example.invalid','https://service-3.example.invalid'].includes(identity.service))throw new Error('媒体账号或服务尚未核对');
      if(kind==='media-archive'&&(method!=='GET'&&method!=='POST'||Object.keys(extra).length))throw new Error('归档请求方法或附加头未获准');
      const expected={...identity},packet=kind==='photo-contribution'?validateNativeContributionRequest(method,path,body,extra):kind==='media-archive'?validateNativeMediaArchiveRequest(method as 'GET'|'POST',path,body):validateNativePrivateMediaRequest(method,path,body,extra),bridge=window.Gongxingji!;
      const sha256=body instanceof Uint8Array?Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',Uint8Array.from(body).buffer)),value=>value.toString(16).padStart(2,'0')).join(''):'';
      if(pending.size||!available()||!source.enabled()||signal.aborted||!same(source.identity(),expected))throw new Error('媒体操作或账号已变化，请先核对原请求');
      const pin=checkReply((bridge as unknown as Record<string,(service:string,owner:string)=>string>)[fingerprint](expected.service,expected.owner));if(typeof pin!=='string'||!/^[a-f0-9]{64}$/.test(pin))throw new Error('媒体登录会话无法核对');
      const id=`media-${crypto.randomUUID()}`;
      return await new Promise<unknown>((resolve,reject)=>{
        const abort=()=>finish(id,new Error('媒体操作已取消；本机对象保留，云结果仍需核对'));
        const item:Pending={expected,binary:packet.binary,resolve,reject,signal,abort,timer:setTimeout(()=>finish(id,new Error('媒体连接超时；未确认的对象保留')),120000),poll:setInterval(()=>{if(!same(source.identity(),expected)||!source.enabled())finish(id,new Error('媒体登录会话已变化，旧响应未采用'));},250),position:0,sequence:0};
        pending.set(id,item);signal.addEventListener('abort',abort,{once:true});
        void (async()=>{
          try{
            if(signal.aborted||!same(source.identity(),expected))throw new Error('媒体操作或账号已变化');
            checkReply(bridge.privateMediaBegin!(id,expected.service+path,packet.method,JSON.stringify(packet.headers),packet.json,expected.service,expected.owner,pin,packet.bytes,sha256));
            if(body instanceof Uint8Array)for(let offset=0,sequence=0;offset<body.length;offset+=CHUNK,sequence++){
              if(!pending.has(id)||signal.aborted||!source.enabled()||!same(source.identity(),expected))throw new Error('媒体操作或账号已变化');
              checkReply(bridge.privateMediaChunk!(id,sequence,base64(body.subarray(offset,Math.min(offset+CHUNK,body.length)))));
              await new Promise<void>(resolve=>setTimeout(resolve,0));
            }
            if(!pending.has(id)||signal.aborted||!same(source.identity(),expected))throw new Error('媒体操作或账号已变化');
            checkReply(bridge.privateMediaFinish!(id));
          }catch(error){finish(id,error instanceof Error?error:new Error('媒体安装包入口未确认'));}
        })();
      });
    },
  };
}
