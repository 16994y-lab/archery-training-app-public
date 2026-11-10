import type {RewardMe,RewardKey} from './rewards-api';
import React,{useEffect,useRef,useState} from 'react';
import {Button,Field,Modal,useApp} from './ui';
import {deviceAvatars,FURRY_AVATARS,furryImage,rewardAvatarImage,saveLocalAvatar,validateAvatarInput,paintAvatar,croppedAvatarBlob,initialAvatarCrop,USER_AVATAR_PICKER_ENABLED,type LocalAvatar,type AvatarPort,type FurryId,type AvatarCrop} from './avatar-local';
import './profile-next.css';
import {ORDINARY_AVATAR_CHOICES,HIDDEN_AVATAR_DISCOVERY,isOrdinaryAvatarId,type HiddenAvatarDiscovery} from './avatar-discovery';
import './avatar-discovery.css';
// Preview-only URLs already emitted by approvedAvatarArt; these are not selectable IDs.
const hiddenAvatarPreviews:Record<HiddenAvatarDiscovery['key'],string>={
 sponsor:'./ui/avatars-hidden/star-crown-v2.png',
 community:'./ui/avatars-hidden/armored-bow-v4.png',
 invite:'./ui/avatars-hidden/archery-friends-v7.png',
};
function HiddenAvatarPreview({kind,onReady,onFail}:{kind:HiddenAvatarDiscovery['key'];onReady?:()=>void;onFail?:()=>void}){
 const [failed,setFailed]=useState(false);
 return <span className="avatar-discovery-question" aria-hidden="true">{!failed&&<img className="avatar-discovery-image" src={hiddenAvatarPreviews[kind]} alt="" decoding="async" onLoad={onReady} onError={()=>{setFailed(true);onFail?.();}}/>}<span className="avatar-discovery-veil"/></span>;
}
const changed='gongxingji-local-avatar';
export function useLocalAvatar(owner:string|null,port:AvatarPort=deviceAvatars){
 const [state,setState]=useState<{owner:string|null;value:LocalAvatar|null;error:string}>({owner:null,value:null,error:''});
 useEffect(()=>{let epoch=0,live=true;const load=()=>{const ticket=++epoch;if(!owner){setState({owner:null,value:null,error:''});return;}void port.read(owner).then(value=>{if(live&&ticket===epoch)setState({owner,value,error:''});},e=>{if(live&&ticket===epoch)setState({owner,value:null,error:e instanceof Error?e.message:'头像暂时无法读取'});});};load();
 const refresh=(event:Event)=>{if((event as CustomEvent<string>).detail===owner)load();};window.addEventListener(changed,refresh);return()=>{live=false;epoch++;window.removeEventListener(changed,refresh);};},[owner,port]);
 return state.owner===owner?state:{owner,value:null,error:''};
}
export function DeviceAvatar({value,fallback}:{value:LocalAvatar|null;fallback:React.ReactNode}){
 const [src,setSrc]=useState(''),[failed,setFailed]=useState(false),activeSource=useRef('');activeSource.current=src;
 useEffect(()=>{setFailed(false);if(!value){setSrc('');return;}const url=value.kind==='photo'?URL.createObjectURL(value.blob):value.kind==='reward'?rewardAvatarImage(value.id):furryImage(value.id);setSrc(url);return()=>{if(value.kind==='photo')URL.revokeObjectURL(url);};},[value]);
 return value&&src&&!failed&&(USER_AVATAR_PICKER_ENABLED||value.kind==='preset'||value.kind==='reward')?<img key={src} className={'profile-device-avatar'+(value.kind==='preset'?' profile-furry-avatar':'')} src={src} alt="本机头像" onError={()=>{if(activeSource.current===src)setFailed(true);}}/>:<>{fallback}</>;
}
export function AvatarEditor({owner,onClose,onSaved,port=deviceAvatars,currentOwner,currentAvatar=null,rewardProof=null,authorizeReward}:{rewardProof?:RewardMe|null;authorizeReward?:(reward:RewardKey)=>Promise<RewardMe>;owner:string;onClose:()=>void;onSaved:()=>void;port?:AvatarPort;currentOwner:()=>string|null;currentAvatar?:LocalAvatar|null}){
 const {open}=useApp();
 const [rewardReady,setRewardReady]=useState<ReadonlySet<RewardKey>>(new Set());
 const [discovery,setDiscovery]=useState<HiddenAvatarDiscovery|null>(null);
 const camera=useRef<HTMLInputElement>(null),gallery=useRef<HTMLInputElement>(null),canvas=useRef<HTMLCanvasElement>(null),generation=useRef(0),alive=useRef(true),saving=useRef(false),objectUrl=useRef<string|null>(null),saveAbort=useRef(new AbortController());
 const [photo,setPhoto]=useState<HTMLImageElement|null>(null),[crop,setCrop]=useState<AvatarCrop>(initialAvatarCrop),[error,setError]=useState(''),[busy,setBusy]=useState(false),[ready,setReady]=useState<ReadonlySet<FurryId>>(new Set()),[failed,setFailed]=useState<ReadonlySet<FurryId>>(new Set());
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;generation.current++;saveAbort.current.abort();if(objectUrl.current)URL.revokeObjectURL(objectUrl.current);};},[]);
 useEffect(()=>{if(photo&&canvas.current)try{paintAvatar(canvas.current,photo,crop);}catch(e){setError(e instanceof Error?e.message:'图片无法裁剪');}},[photo,crop]);
 const selectedId=currentAvatar?.kind==='preset'?currentAvatar.id:null;
 const retainedChoice=selectedId&&!isOrdinaryAvatarId(selectedId)?FURRY_AVATARS.find(([id])=>id===selectedId):undefined;
 const close=()=>{if(!saving.current)onClose();};
 const openDiscoveryDestination=()=>{
  if(!discovery||!alive.current||saving.current||busy)return;
  if(currentOwner()!==owner){setDiscovery(null);setError('账号已变化，请重新打开头像编辑');return;}
  const destination=discovery.destination;setDiscovery(null);onClose();open(destination);
 };
 async function select(file:File|undefined){
  if(!USER_AVATAR_PICKER_ENABLED||!file||saving.current)return;const ticket=++generation.current;setError('');setBusy(true);let url:string|null=null;
  try{validateAvatarInput(file);if(currentOwner()!==owner)throw new Error('账号已变化，请重新打开头像编辑');url=URL.createObjectURL(file);const image=new Image();image.src=url;
   await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('图片读取超时，请重新选择')),12000);image.onload=()=>{clearTimeout(timer);resolve();};image.onerror=()=>{clearTimeout(timer);reject(new Error('图片读取失败，原头像保留'));};});
   const check=document.createElement('canvas');paintAvatar(check,image,initialAvatarCrop);
   if(!alive.current||ticket!==generation.current||currentOwner()!==owner)return;
   if(objectUrl.current)URL.revokeObjectURL(objectUrl.current);objectUrl.current=url;url=null;setPhoto(image);setCrop({...initialAvatarCrop});
  }catch(e){if(alive.current&&ticket===generation.current)setError(e instanceof Error?e.message:'图片选择未完成，原头像保留');}
  finally{if(url)URL.revokeObjectURL(url);if(alive.current&&ticket===generation.current)setBusy(false);}
 }
 async function save(value:LocalAvatar|(()=>Promise<LocalAvatar>)){
  if(!alive.current||saving.current||busy)return;saving.current=true;setBusy(true);setError('');
  try{const selected=typeof value==='function'?await value():value;if(!alive.current)return;if(selected.kind==='preset'&&!isOrdinaryAvatarId(selected.id))throw new Error('这款头像暂不可新选择，原头像保留');if(selected.kind==='reward'){const proof=await authorizeReward?.(selected.id);if(!proof||proof.owner!==owner||proof.service!==selected.service||!proof.rewards.includes(selected.id)||currentOwner()!==owner||!alive.current)throw new Error('当前奖励资格未能核对，原头像保留');}const adoption=await saveLocalAvatar(port,owner,selected,currentOwner,saveAbort.current.signal);if(alive.current&&adoption==='adopt'){window.dispatchEvent(new CustomEvent(changed,{detail:owner}));onSaved();onClose();}}
  catch(e){if(alive.current)setError(e instanceof Error?e.message:'头像保存失败，原头像保留');}
  finally{saving.current=false;if(alive.current)setBusy(false);}
 }
 async function savePhoto(){const preview=canvas.current;if(!preview||!photo||busy)return;await save(async()=>({kind:'photo',blob:await croppedAvatarBlob(preview)}));}
 function reset(){generation.current++;if(objectUrl.current)URL.revokeObjectURL(objectUrl.current);objectUrl.current=null;setPhoto(null);setError('');}
 return <><Modal title={photo?'裁剪头像':'选择头像'} onClose={close}><div className="avatar-editor" aria-busy={busy}>
  <p className="caption">选择内置的打弓伙伴。头像选择保存在本机，暂不开放自选图片。</p>{error&&<p className="avatar-error" role="alert">{error}</p>}
  {photo?<><canvas ref={canvas} className="avatar-crop-preview" role="img" aria-label="裁剪后的头像预览"/>
   <Field label={`放大 ${crop.zoom.toFixed(1)} 倍`}><input type="range" min="1" max="4" step=".05" value={crop.zoom} disabled={busy} onChange={e=>setCrop({...crop,zoom:Number(e.target.value)})}/></Field>
   <Field label="左右移动"><input type="range" min="-1" max="1" step=".02" value={crop.x} disabled={busy} onChange={e=>setCrop({...crop,x:Number(e.target.value)})}/></Field>
   <Field label="上下移动"><input type="range" min="-1" max="1" step=".02" value={crop.y} disabled={busy} onChange={e=>setCrop({...crop,y:Number(e.target.value)})}/></Field>
   <div className="avatar-actions"><Button disabled={busy} onClick={()=>setCrop({...crop,rotation:((crop.rotation+90)%360) as AvatarCrop['rotation']})}>旋转 90°</Button><Button disabled={busy} onClick={()=>setCrop({...initialAvatarCrop})}>重置裁剪</Button></div>
   <Button kind="primary" className="wide" disabled={busy} onClick={()=>void savePhoto()}>保存本机头像</Button><Button className="wide" disabled={busy} onClick={reset}>重新选择</Button>
  </>:<>{USER_AVATAR_PICKER_ENABLED&&<div className="avatar-actions"><Button disabled={busy} onClick={()=>camera.current?.click()}>拍照</Button><Button disabled={busy} onClick={()=>gallery.current?.click()}>从相册选择</Button></div>}
   {retainedChoice&&<section className="avatar-retained-choice" aria-label="当前历史头像"><DeviceAvatar value={currentAvatar} fallback={<span aria-hidden="true">◎</span>}/><div><strong>当前头像：{retainedChoice[1]}</strong><small>历史选择仍保留。取消不会改变；选择其他头像后，这款将不在普通选项中。</small></div></section>}
   <h3>毛茸茸伙伴</h3><div className="avatar-presets" role="group" aria-label="6款动物头像">{ORDINARY_AVATAR_CHOICES.map(({id,name})=><button type="button" key={id} aria-pressed={selectedId===id} disabled={busy||!ready.has(id)||failed.has(id)} aria-label={`使用${name}头像${failed.has(id)?'，图片暂不可用':''}`} onClick={()=>void save({kind:'preset',id})}>
    {failed.has(id)?<span className="avatar-unavailable">暂不可用</span>:<img src={furryImage(id)} alt="" onLoad={()=>setReady(previous=>new Set([...previous,id]))} onError={()=>setFailed(previous=>new Set([...previous,id]))}/>}<span>{name}</span>{selectedId===id&&<span className="avatar-current" aria-hidden="true">当前头像</span>}</button>)}</div>
   {failed.size>0&&<p role="status" className="caption">部分伙伴图片暂不可用，请选择其它内置伙伴。</p>}
   <section className="avatar-discovery-section" aria-label="特别伙伴"><h3>特别伙伴</h3><p className="caption">已获得的伙伴可选择；其余轻触了解获得方式。离线不会新增资格。</p><div className="avatar-discovery-grid">{HIDDEN_AVATAR_DISCOVERY.map(item=>{const earned=rewardProof?.owner===owner&&rewardProof.rewards.includes(item.key);return <button type="button" key={item.key} className={"avatar-discovery-card"+(earned?" avatar-reward-earned":"")} disabled={busy||!!earned&&!rewardReady.has(item.key)} aria-pressed={currentAvatar?.kind==="reward"&&currentAvatar.id===item.key} aria-label={`${item.name}，${earned?"已获得，选择头像":"了解获得方式，尚未获得"}`} onClick={()=>earned&&rewardProof?void save({kind:"reward",id:item.key,service:rewardProof.service}):setDiscovery(item)}><HiddenAvatarPreview kind={item.key} onReady={()=>setRewardReady(old=>new Set([...old,item.key]))} onFail={()=>setRewardReady(old=>{const next=new Set(old);next.delete(item.key);return next;})}/><strong>{item.name}</strong></button>;})}</div></section>
  </>}
  {USER_AVATAR_PICKER_ENABLED&&<><input ref={camera} hidden type="file" accept="image/jpeg,image/png,image/webp" capture="user" onChange={e=>{const file=e.target.files?.[0];e.target.value='';void select(file);}}/>
  <input ref={gallery} hidden type="file" accept="image/jpeg,image/png,image/webp" onChange={e=>{const file=e.target.files?.[0];e.target.value='';void select(file);}}/></>}
  <Button className="wide" disabled={saving.current} onClick={close}>取消</Button>
 </div></Modal>{discovery&&<Modal title={`${discovery.name} · 获得方式`} onClose={()=>setDiscovery(null)}><div className="avatar-discovery-dialog"><HiddenAvatarPreview key={discovery.key} kind={discovery.key}/><p><strong>{discovery.method}</strong></p><p>{discovery.description}</p><Button type="button" kind="primary" onClick={openDiscoveryDestination}>{discovery.action}</Button><Button type="button" onClick={()=>setDiscovery(null)}>返回头像选择</Button></div></Modal>}</>;
}
