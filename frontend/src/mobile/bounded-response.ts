/** Stop oversized or cancelled streams before assembling a response in memory. */
export async function readBoundedResponse(response:Response,maxBytes:number,signal?:AbortSignal):Promise<Uint8Array>{
  const length=response.headers.get('content-length');
  if(length!==null&&(!/^\d+$/.test(length)||!Number.isSafeInteger(Number(length))||Number(length)>maxBytes)){
    await response.body?.cancel();throw new Error('服务响应超出容量保护');
  }
  if(signal?.aborted){await response.body?.cancel();throw new Error('服务读取已取消');}
  if(!response.body)throw new Error('服务没有返回可核对的内容');
  const reader=response.body.getReader(),parts:Uint8Array[]=[];let total=0;
  const stop=()=>{void reader.cancel().catch(()=>{});};signal?.addEventListener('abort',stop,{once:true});
  try{
    while(true){
      if(signal?.aborted)throw new Error('服务读取已取消');
      const chunk=await reader.read();if(signal?.aborted)throw new Error('服务读取已取消');
      if(chunk.done)break;
      if(total+chunk.value.byteLength>maxBytes)throw new Error('服务响应超出容量保护');
      parts.push(chunk.value);total+=chunk.value.byteLength;
    }
    const bytes=new Uint8Array(total);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.byteLength;}return bytes;
  }catch(error){await reader.cancel().catch(()=>{});throw error;}
  finally{signal?.removeEventListener('abort',stop);reader.releaseLock();}
}
