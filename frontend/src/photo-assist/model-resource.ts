export const MAX_MODEL_BYTES=64*1024*1024;
const DOWNLOAD_IDLE_MS=30000,PROGRESS_BYTES=1024*1024;
export class ModelDownloadTimeout extends Error{constructor(){super('PHOTO_MODEL_STALLED');}}

// Exactly one explicit request per worker. Read bounded chunks; never fall back
// to arrayBuffer() or an ORT URL request when streaming is unavailable.
export async function fetchModelBytes(url:string,onProgress?:(receivedBytes:number)=>void):Promise<Uint8Array<ArrayBuffer>>{
 const controller=new AbortController();let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
 let timer:ReturnType<typeof setTimeout>|undefined,timedOut=false,complete=false,idleDeadline=0;
 let rejectPending:((reason:unknown)=>void)|undefined;
 // Only one pending read is retained; do not attach every chunk to a never-settled idle promise.
 const wait=<T>(operation:Promise<T>):Promise<T>=>new Promise((resolve,reject)=>{
  rejectPending=reject;operation.then(value=>{if(rejectPending===reject)rejectPending=undefined;resolve(value);},error=>{if(rejectPending===reject)rejectPending=undefined;reject(error);});
 });
 const arm=()=>{clearTimeout(timer);idleDeadline=performance.now()+DOWNLOAD_IDLE_MS;timer=setTimeout(()=>{timedOut=true;controller.abort();rejectPending?.(new ModelDownloadTimeout());},DOWNLOAD_IDLE_MS);};
 const checkIdle=()=>{if(performance.now()>=idleDeadline){timedOut=true;throw new ModelDownloadTimeout();}};
 try{
  arm();const response=await wait(fetch(url,{credentials:'omit',signal:controller.signal}));checkIdle();
  if(!response.ok)throw Error('PHOTO_MODEL_FETCH');
  const declared=Number(response.headers.get('content-length'));
  if(Number.isFinite(declared)&&declared>MAX_MODEL_BYTES||!response.body)throw Error('PHOTO_MODEL_FETCH');
  reader=response.body.getReader();let received=0,reported=0;
  // Bounded contiguous storage avoids unbounded per-chunk metadata on tiny responses.
  let bytes=new Uint8Array(Number.isSafeInteger(declared)&&declared>0?declared:PROGRESS_BYTES);
  while(true){
   const part=await wait(reader.read());checkIdle();if(part.done)break;
   const chunk=part.value;if(!(chunk instanceof Uint8Array)||chunk.byteLength>MAX_MODEL_BYTES-received)throw Error('PHOTO_MODEL_FETCH');
   if(!chunk.byteLength)continue; // Headers/empty chunks cannot keep a stalled request alive.
   const needed=received+chunk.byteLength;
   if(needed>bytes.byteLength){const grown=new Uint8Array(Math.min(MAX_MODEL_BYTES,Math.max(needed,bytes.byteLength*2)));grown.set(bytes.subarray(0,received));bytes=grown;}
   bytes.set(chunk,received);received=needed;arm();
   if(Math.floor(received/PROGRESS_BYTES)>Math.floor(reported/PROGRESS_BYTES)){reported=received;onProgress?.(received);}
  }
  if(received<1)throw Error('PHOTO_MODEL_FETCH');
  if(received!==reported)onProgress?.(received);complete=true;return bytes.subarray(0,received);
 }catch{controller.abort();throw timedOut?new ModelDownloadTimeout():Error('PHOTO_MODEL_FETCH');}
 finally{
  clearTimeout(timer);rejectPending=undefined;
  if(!complete){controller.abort();try{void reader?.cancel().catch(()=>{});}catch{/* Cancellation never exposes a reader error. */}}
  try{reader?.releaseLock();}catch{}
 }
}

export async function contributionModelHash(bytes:Uint8Array<ArrayBuffer>):Promise<string|null>{
 try{
  const hash=new Uint8Array(await crypto.subtle.digest('SHA-256',bytes));
  if(hash.length!==32)return null;
  return Array.from(hash,value=>value.toString(16).padStart(2,'0')).join('');
 }catch{return null;}
}
