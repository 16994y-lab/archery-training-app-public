import {DEFAULT_AVATARS_V2} from './avatar-catalog-v2';
/** Device-only avatar blobs never enter training documents. */
/** User direction 2026-10-07: built-in choices only; retained local blobs are not deleted. */
export const USER_AVATAR_PICKER_ENABLED=false;
export const FURRY_AVATARS=Object.freeze(DEFAULT_AVATARS_V2.map(({id,name})=>[id,name] as const));
export type FurryId=typeof FURRY_AVATARS[number][0];
export type RewardAvatarId='sponsor'|'community'|'invite';
export type LocalAvatar={kind:'preset';id:FurryId}|{kind:'photo';blob:Blob}|{kind:'reward';id:RewardAvatarId;service:string};
export const rewardAvatarImage=(id:RewardAvatarId)=>({sponsor:'./ui/avatars-hidden/star-crown-v2.png',community:'./ui/avatars-hidden/armored-bow-v4.png',invite:'./ui/avatars-hidden/archery-friends-v7.png'}[id]);
export const AVATAR_INPUT_LIMIT=12*1024*1024,AVATAR_OUTPUT_LIMIT=512*1024,AVATAR_OUTPUT_SIZE=384;
const furrySources:Record<FurryId,string>={
 'furry-red-panda':new URL('../../public/ui/avatars/furry-red-panda.png',import.meta.url).href,
 'furry-otter':new URL('../../public/ui/avatars/furry-otter.png',import.meta.url).href,
 'furry-arctic-fox':new URL('../../public/ui/avatars/furry-arctic-fox.png',import.meta.url).href,
 'furry-rabbit':new URL('../../public/ui/avatars/furry-rabbit.png',import.meta.url).href,
 'furry-bear':new URL('../../public/ui/avatars/furry-bear.png',import.meta.url).href,
 'furry-cat':new URL('../../public/ui/avatars/furry-cat.png',import.meta.url).href,
 'furry-fox':new URL('../../public/ui/avatars/furry-fox.png',import.meta.url).href,
 'furry-raccoon':new URL('../../public/ui/avatars/furry-raccoon.png',import.meta.url).href,
 'furry-hedgehog':new URL('../../public/ui/avatars/furry-hedgehog.png',import.meta.url).href,
 'furry-snow-leopard':new URL('../../public/ui/avatars/furry-snow-leopard.png',import.meta.url).href,
 'furry-hamster':new URL('../../public/ui/avatars/furry-hamster.png',import.meta.url).href,
 'furry-shiba':new URL('../../public/ui/avatars/furry-shiba.png',import.meta.url).href,
};
/** Bundled for the reviewed hidden candidate; metadata alone never unlocks it. */
export const LOCKED_KING_IMAGE=new URL('../../public/ui/avatars-v2/furry-emperor.png',import.meta.url).href;
export function furryImage(id:FurryId){return furrySources[id];}
export function avatarOwner(owner:string){if(!owner||owner.length>200||/[\u0000-\u001f]/.test(owner))throw new Error('当前账号尚未确认，暂不能保存头像');return owner;}
export function validateAvatarInput(file:Pick<File,'size'|'type'>){
 if(!['image/jpeg','image/png','image/webp'].includes(file.type))throw new Error('请选择 JPG、PNG 或 WebP 图片');
 if(file.size<=0||file.size>AVATAR_INPUT_LIMIT)throw new Error('图片请控制在 12 MB 以内');
}
export function validateLocalAvatar(value:LocalAvatar){
 if(value.kind==='preset'){if(!FURRY_AVATARS.some(([id])=>id===value.id))throw new Error('头像款式不可用');}
 else if(value.kind==='reward'){if(!['sponsor','community','invite'].includes(value.id)||typeof value.service!=='string'||!/^https:\/\//.test(value.service))throw new Error('奖励头像记录不可用');}
 else if(value.kind==='photo'){if(!(value.blob instanceof Blob)||value.blob.type!=='image/jpeg'||!value.blob.size||value.blob.size>AVATAR_OUTPUT_LIMIT)throw new Error('裁剪图片未能保存，请重新选择');}
 else throw new Error('头像格式不可用');
 return value;
}
export type AvatarWriteGuard={currentOwner:()=>string|null;signal?:AbortSignal};
export type AvatarPort={read(owner:string):Promise<LocalAvatar|null>;write(owner:string,value:LocalAvatar,guard?:AvatarWriteGuard):Promise<void>};
export async function saveLocalAvatar(port:AvatarPort,owner:string,value:LocalAvatar,currentOwner:()=>string|null=()=>owner,signal?:AbortSignal){
 avatarOwner(owner);validateLocalAvatar(value);
 if(currentOwner()!==owner||signal?.aborted)throw new Error('账号已变化或编辑已取消，请重新打开头像编辑');
 await port.write(owner,value,{currentOwner,signal});
 // A completed transaction belongs to its original owner even if the UI has since changed.
 return currentOwner()===owner&&!signal?.aborted?'adopt' as const:'original-owner' as const;
}
function openDatabase():Promise<IDBDatabase>{return new Promise((resolve,reject)=>{
 if(typeof indexedDB==='undefined'){reject(new Error('此设备暂不能持久保存头像，原头像保留'));return;}
 let settled=false;const request=indexedDB.open('gongxingji-local-avatars-v1',1);
 const fail=(message:string)=>{if(settled)return;settled=true;clearTimeout(timer);reject(new Error(message));};
 const timer=setTimeout(()=>fail('本机头像存储响应超时，原头像保留'),6000);
 request.onupgradeneeded=()=>{if(!request.result.objectStoreNames.contains('avatars'))request.result.createObjectStore('avatars');};
 request.onsuccess=()=>{if(settled){request.result.close();return;}settled=true;clearTimeout(timer);resolve(request.result);};
 request.onerror=()=>fail('本机头像存储不可用，原头像保留');request.onblocked=()=>fail('头像存储正在被其他页面使用，请稍后重试');
});}
export const deviceAvatars:AvatarPort={
 async read(owner){avatarOwner(owner);const db=await openDatabase();try{return await new Promise<LocalAvatar|null>((resolve,reject)=>{
  const tx=db.transaction('avatars','readonly'),request=tx.objectStore('avatars').get(owner);let value:LocalAvatar|null=null;
  request.onsuccess=()=>{value=request.result??null;};tx.oncomplete=()=>{try{resolve(value?validateLocalAvatar(value):null);}catch{reject(new Error('本机头像记录不可读，显示原头像'));}};
  tx.onerror=tx.onabort=()=>reject(new Error('本机头像暂时无法读取'));
 });}finally{db.close();}},
 async write(owner,value,guard){avatarOwner(owner);validateLocalAvatar(value);const db=await openDatabase();try{
  if(guard&&(guard.currentOwner()!==owner||guard.signal?.aborted))throw new Error('账号已变化或编辑已取消，原头像保留');
  await new Promise<void>((resolve,reject)=>{
   const tx=db.transaction('avatars','readwrite');let complete=false;
   const cancel=()=>{if(!complete)try{tx.abort();}catch{}};
   const cleanup=()=>{complete=true;guard?.signal?.removeEventListener('abort',cancel);};
   guard?.signal?.addEventListener('abort',cancel,{once:true});
   if(guard?.signal?.aborted){cancel();}else tx.objectStore('avatars').put(value,owner);
   tx.oncomplete=()=>{cleanup();resolve();};tx.onerror=tx.onabort=()=>{cleanup();reject(new Error('头像未能存入本机，原头像保留。请检查存储空间后重试'));};
  });
 }finally{db.close();}}

};
export type AvatarCrop={zoom:number;x:number;y:number;rotation:0|90|180|270};
export const initialAvatarCrop:AvatarCrop={zoom:1,x:0,y:0,rotation:0};
export function avatarCropRect(width:number,height:number,crop:AvatarCrop){
 if(!Number.isFinite(width)||!Number.isFinite(height)||width<=0||height<=0||width*height>24_000_000)throw new Error('图片尺寸不可用，请选择较小图片');
 if(![0,90,180,270].includes(crop.rotation)||![crop.zoom,crop.x,crop.y].every(Number.isFinite))throw new Error('裁剪参数不可用');
 const rotatedWidth=crop.rotation%180?height:width,rotatedHeight=crop.rotation%180?width:height;
 const side=Math.min(rotatedWidth,rotatedHeight)/Math.min(4,Math.max(1,crop.zoom));
 return {width:rotatedWidth,height:rotatedHeight,side,left:(rotatedWidth-side)*(1+Math.min(1,Math.max(-1,crop.x)))/2,top:(rotatedHeight-side)*(1+Math.min(1,Math.max(-1,crop.y)))/2};
}
export function paintAvatar(canvas:HTMLCanvasElement,image:HTMLImageElement,crop:AvatarCrop){
 const rect=avatarCropRect(image.naturalWidth,image.naturalHeight,crop);canvas.width=canvas.height=AVATAR_OUTPUT_SIZE;
 const ctx=canvas.getContext('2d');if(!ctx)throw new Error('此设备暂不能裁剪图片');
 ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.save();ctx.scale(AVATAR_OUTPUT_SIZE/rect.side,AVATAR_OUTPUT_SIZE/rect.side);ctx.translate(-rect.left,-rect.top);ctx.translate(rect.width/2,rect.height/2);ctx.rotate(crop.rotation*Math.PI/180);ctx.drawImage(image,-image.naturalWidth/2,-image.naturalHeight/2);ctx.restore();
}
export function croppedAvatarBlob(canvas:HTMLCanvasElement){return new Promise<Blob>((resolve,reject)=>canvas.toBlob(blob=>{
 if(!blob||blob.size>AVATAR_OUTPUT_LIMIT){reject(new Error('裁剪结果过大或生成失败，原头像保留'));return;}resolve(blob);
},'image/jpeg',.88));}
