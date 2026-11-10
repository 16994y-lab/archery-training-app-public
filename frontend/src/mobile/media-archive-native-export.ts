import type {ProductionCommunityIdentity} from './community-api';

const MAX_BYTES=50*1024*1024,CHUNK=256*1024;
type Source={identity:()=>ProductionCommunityIdentity|null;enabled:()=>boolean};
type Pending={id:string;identity:ProductionCommunityIdentity;signal:AbortSignal;abort:()=>void;timer:ReturnType<typeof setTimeout>;poll:ReturnType<typeof setInterval>;awaitingPicker:boolean;resolve:()=>void;reject:(error:Error)=>void};
const same=(a:ProductionCommunityIdentity|null,b:ProductionCommunityIdentity)=>!!a&&a.owner===b.owner&&a.service===b.service&&a.generation===b.generation&&a.sessionKey===b.sessionKey;
const reply=(raw:string)=>{const value=JSON.parse(raw) as {ok?:unknown;data?:unknown;error?:unknown};if(value.ok!==true)throw new Error(typeof value.error==='string'?value.error:'归档文件保存入口未确认');return value.data;};
function base64(bytes:Uint8Array){let raw='';for(const value of bytes)raw+=String.fromCharCode(value);return btoa(raw);}

/** Dedicated binary system-file port. A completed write is not a durable-copy attestation. */
export function createNativeMediaArchiveExporter(source:Source){
  let active:Pending|null=null,preparing=false,disposed=false,preparationEpoch=0;
  const available=()=>!disposed&&typeof window!=='undefined'&&['mediaArchiveFingerprint','mediaArchiveExportBegin','mediaArchiveExportChunk','mediaArchiveExportFinish','mediaArchiveExportCancel'].every(name=>typeof (window.Gongxingji as unknown as Record<string,unknown>|undefined)?.[name]==='function');
  const assert=(identity:ProductionCommunityIdentity,signal:AbortSignal)=>{if(!available()||!source.enabled()||signal.aborted||!same(source.identity(),identity))throw new Error('账号或页面已变化，归档文件保存停止；原对象保留');};
  function complete(error?:Error){
    const item=active;if(!item)return;active=null;clearTimeout(item.timer);clearInterval(item.poll);item.signal.removeEventListener('abort',item.abort);
    if(error){try{window.Gongxingji?.mediaArchiveExportCancel?.(item.id);}catch{/* A system destination is never deleted here. */}item.reject(error);}else item.resolve();
  }
  const onResult=(event:Event)=>{
    const value=(event as CustomEvent<{id?:unknown;phase?:unknown}>).detail,item=active;
    if(!item||value?.id!==item.id)return;
    try{
      assert(item.identity,item.signal);
      if(!item.awaitingPicker)throw new Error('归档文件结果先于完整传输，未确认保存');
      if(value.phase==='saved')complete();
      else if(value.phase==='cancelled')complete(new Error('已取消归档文件保存；原对象保留'));
      else if(value.phase==='error')complete(new Error('归档文件保存未完成；原对象保留，请核对目标位置后重试'));
      else throw new Error('归档文件保存回应无效');
    }catch(error){complete(error instanceof Error?error:new Error('归档文件保存未确认'));}
  };
  // Opening the system picker backgrounds the WebView. Only a fully uploaded,
  // fingerprint-bound payload may wait there; unfinished chunks are cancelled.
  const onBackground=()=>{if(active?.awaitingPicker)return;preparationEpoch++;if(active)complete(new Error('归档页面进入后台，未完成文件传输已停止'));};
  const dispose=()=>{disposed=true;complete(new Error('归档页面已关闭；原对象保留'));if(typeof window!=='undefined'){window.removeEventListener('gongxingji-archive-export',onResult);window.removeEventListener('gongxingji-background',onBackground);window.removeEventListener('pagehide',dispose);window.removeEventListener('beforeunload',dispose);}};
  if(typeof window!=='undefined'){window.addEventListener('gongxingji-archive-export',onResult);window.addEventListener('gongxingji-background',onBackground);window.addEventListener('pagehide',dispose);window.addEventListener('beforeunload',dispose);}
  return {
    available,isDisposed:()=>disposed,dispose,
    async export(name:string,bytes:Uint8Array,identity:ProductionCommunityIdentity,signal:AbortSignal):Promise<void>{
      assert(identity,signal);
      if(active||preparing)throw new Error('请先完成或取消上一次归档文件保存');
      if(!/^[A-Za-z0-9._-]{1,96}\.zip$/.test(name)||!(bytes instanceof Uint8Array)||bytes.byteLength<1||bytes.byteLength>MAX_BYTES)throw new Error('归档文件名或容量未通过保护');
      if(!['https://service-1.example.invalid','https://service-3.example.invalid'].includes(identity.service))throw new Error('归档文件账号服务尚未核对');
      preparing=true;
      try{
        const expected={...identity},epoch=preparationEpoch,snapshot=Uint8Array.from(bytes);
        const sha256=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',snapshot.buffer)),value=>value.toString(16).padStart(2,'0')).join('');
        assert(expected,signal);
        if(epoch!==preparationEpoch)throw new Error('归档页面已进入后台，未完成文件传输已停止；原对象保留');
        const bridge=window.Gongxingji!,pin=reply(bridge.mediaArchiveFingerprint!(expected.service,expected.owner));
        if(typeof pin!=='string'||!/^[a-f0-9]{64}$/.test(pin))throw new Error('归档文件登录会话无法核对');
        const id='archive-export-'+crypto.randomUUID();
        return await new Promise<void>((resolve,reject)=>{
          const abort=()=>complete(new Error('归档文件保存已停止；已请求的目标结果仍需核对，原对象保留'));
          const item:Pending={id,identity:expected,signal,abort,awaitingPicker:false,resolve,reject,timer:setTimeout(()=>complete(new Error('归档文件保存等待超时；目标结果未确认，原对象保留')),120000),poll:setInterval(()=>{try{assert(expected,signal);}catch(error){complete(error instanceof Error?error:new Error('归档会话已变化'));}},250)};
          active=item;signal.addEventListener('abort',abort,{once:true});
          void (async()=>{
            try{
              assert(expected,signal);reply(bridge.mediaArchiveExportBegin!(id,name,expected.service,expected.owner,pin,snapshot.length,sha256));
              for(let offset=0,sequence=0;offset<snapshot.length;offset+=CHUNK,sequence++){
                assert(expected,signal);if(active!==item)throw new Error('归档文件操作已停止');
                const chunk=snapshot.subarray(offset,Math.min(snapshot.length,offset+CHUNK));
                reply(bridge.mediaArchiveExportChunk!(id,sequence,base64(chunk)));
                await new Promise<void>(done=>setTimeout(done,0));
              }
              assert(expected,signal);if(active!==item)throw new Error('归档文件操作已停止');
              item.awaitingPicker=true;reply(bridge.mediaArchiveExportFinish!(id));
            }catch(error){if(active===item)complete(error instanceof Error?error:new Error('归档文件入口未确认'));}
          })();
        });
      }finally{preparing=false;}
    },
  };
}
