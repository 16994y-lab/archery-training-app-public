import {archiveSha256,type ArchiveStorage} from './protected-archive';
import {browserArchiveStorage} from './cloud-media-local';
import type {SaveIdentity} from './cloud-save-queue';
import type {ArchiveMediaSelection,MediaArchiveJob} from './media-archive-client';
import {parsePinnedStoredMediaZip} from './media-archive-zip';

export type LocalMediaArchiveOptions={identity:()=>SaveIdentity|null;guard:()=>void;enabled?:()=>boolean;signal?:AbortSignal;storage?:(ownerScope:string,storeId:string)=>ArchiveStorage;now?:()=>number};
export type LocalMediaArchiveReceipt={schema:'media-local-restore/v1';archiveId:string;objectCount:number;totalBytes:number;manifestSha256:string;archiveSha256:string;selectionDigest:string;ownerScope:string;storeId:string;verifiedAt:string;reopenedAndReadBack:true;sourceRetained:true;deletionAuthorized:false;trainingConsentRestored:false;newTrainingConsentRequired:true;productDatabaseRestore:false;persistence:'unknown';retentionControl:'unknown';objects:{id:string;clientObjectId:string;selectionId:string;kind:string;mime:string;bytes:number;sha256:string;path:string}[]};
const encoder=new TextEncoder(),decoder=new TextDecoder('utf-8',{fatal:true}),MAX_ZIP=50*1024*1024,MAX_TOTAL=100*1024*1024,MAX_MANIFEST=1024*1024;
const active=new Set<string>();
const semantics='核对后恢复独立本地副本，不覆盖训练记录，不重授训练同意，不删除任何源资产。';
const id=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{32}$/.test(v);
const hash=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const remoteId=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(v);
const integer=(v:unknown,max=MAX_TOTAL):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=max;
const unix=(v:unknown):v is number=>integer(v,253402300799);
const iso=(v:unknown):v is string=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
function fail(message:string):never{throw new Error(message+'；原ZIP、请求账及本机副本保留');}
function exact(value:unknown,keys:string[],optional:string[]=[]):asserts value is Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value)||keys.some(k=>!Object.prototype.hasOwnProperty.call(value,k))||Object.keys(value).some(k=>!keys.includes(k)&&!optional.includes(k)))fail('归档字段缺失或未知');}
function canonical(v:unknown):string{if(Array.isArray(v))return '['+v.map(canonical).join(',')+']';if(v&&typeof v==='object')return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical((v as Record<string,unknown>)[k])).join(',')+'}';const result=JSON.stringify(v);if(result===undefined)fail('归档值不能稳定核对');return result;}
function same(a:SaveIdentity|null,b:SaveIdentity){return !!a&&a.owner===b.owner&&a.service===b.service&&a.sessionKey===b.sessionKey&&a.generation===b.generation;}
function media(kind:unknown,mime:unknown){if(typeof kind!=='string'||!['photo','video','avatar'].includes(kind)||typeof mime!=='string'||!['image/png','image/jpeg','image/webp','video/mp4'].includes(mime)||(kind==='video')!==(mime==='video/mp4'))fail('媒体类别和MIME不一致');}
function snapshotTraining(value:unknown){exact(value,['version','accepted','purpose','accessors','acceptedAt'],['changedAt']);if(value.version!=='media-training/v1'||typeof value.accepted!=='boolean'||!Array.isArray(value.accessors)||value.accessors.length>2||(value.accepted?(value.purpose!=='archery-assist-research/v1'||!value.accessors.length||value.accessors.some(v=>!['approved-researcher','approved-annotator'].includes(v))||new Set(value.accessors).size!==value.accessors.length||!unix(value.acceptedAt)):(value.purpose!==null||value.accessors.length!==0||value.acceptedAt!==null))||(value.changedAt!==undefined&&(!unix(value.changedAt)||(typeof value.acceptedAt==='number'&&value.changedAt<value.acceptedAt))))fail('原训练用途快照无效');}
/** Object hashes bind to the already server-verified originals. This additionally checks
 * container/MIME signatures; it is not a fresh image decoder or video playback verdict. */
function signature(bytes:Uint8Array,mime:string){
  const word=(at:number,n:number)=>String.fromCharCode(...bytes.subarray(at,at+n));
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  const valid=mime==='image/png'?bytes.length>=8&&[137,80,78,71,13,10,26,10].every((v,n)=>bytes[n]===v)
    :mime==='image/jpeg'?bytes.length>=4&&bytes[0]===255&&bytes[1]===216&&bytes[bytes.length-2]===255&&bytes[bytes.length-1]===217
    :mime==='image/webp'?bytes.length>=20&&word(0,4)==='RIFF'&&word(8,4)==='WEBP'&&view.getUint32(4,true)+8===bytes.length
    :mime==='video/mp4'?bytes.length>=16&&word(4,4)==='ftyp'&&view.getUint32(0,false)>=16&&view.getUint32(0,false)<=bytes.length:false;
  if(!valid)fail('实际媒体容器签名与原MIME不一致');
}
type Context={job:MediaArchiveJob&{pin:NonNullable<MediaArchiveJob['pin']>};identity:SaveIdentity;ownerScope:string;storeId:string;key:string;options:LocalMediaArchiveOptions;guard:()=>void;wait:<T>(work:()=>Promise<T>)=>Promise<T>;open:()=>ArchiveStorage};
async function context(job:MediaArchiveJob,options:LocalMediaArchiveOptions):Promise<Context>{
  if(!options.enabled?.())fail('媒体本地归档恢复尚未开放');options.guard();if(options.signal?.aborted)fail('本地恢复已取消');const current=options.identity();
  if(!current||!['https://service-1.example.invalid','https://service-3.example.invalid'].includes(current.service)||typeof current.owner!=='string'||!current.owner||current.owner.length>128||typeof current.sessionKey!=='string'||!current.sessionKey||!integer(current.generation,Number.MAX_SAFE_INTEGER))fail('当前恢复身份未核定');
  const identity={...current};const guard=()=>{options.guard();if(options.signal?.aborted||!options.enabled?.()||!same(options.identity(),identity))fail('账号、会话、页面或恢复授权已变化');};
  const wait=async<T>(work:()=>Promise<T>)=>{guard();const result=await work();guard();return result;};
  const frozen:unknown=JSON.parse(JSON.stringify(job));exact(frozen,['intent','createAttempts','restoreAttempts','pin']);
  if(!integer(frozen.createAttempts,3)||frozen.createAttempts<1||!integer(frozen.restoreAttempts,3))fail('原请求尝试账无效');const intent=frozen.intent,pin=frozen.pin;
  exact(intent,['version','owner','service','selectionDigest','idempotencyKey','createdAt','archiveConsent','objects']);exact(pin,['version','selectionDigest','idempotencyKey','archiveId','manifestSha256','archiveSha256','bytes']);exact(intent.archiveConsent,['version','accepted']);
  if(intent.version!=='media-archive-intent/v1'||intent.owner!==identity.owner||intent.service!==identity.service||!hash(intent.selectionDigest)||!id(intent.idempotencyKey)||!iso(intent.createdAt)||intent.archiveConsent.version!=='media-archive/v1'||intent.archiveConsent.accepted!==true||!Array.isArray(intent.objects)||!intent.objects.length||intent.objects.length>100||pin.version!=='media-archive-pin/v1'||pin.selectionDigest!==intent.selectionDigest||pin.idempotencyKey!==intent.idempotencyKey||!id(pin.archiveId)||!hash(pin.manifestSha256)||!hash(pin.archiveSha256)||!integer(pin.bytes,MAX_ZIP)||pin.bytes<22)fail('原归档绑定与所选账号不一致');
  let total=0,previous='';const paths=new Set<string>();
  for(const value of intent.objects){exact(value,['id','ownerId','clientObjectId','selectionId','kind','mime','sha256','bytes']);if(!id(value.id)||value.ownerId!==identity.owner||!remoteId(value.clientObjectId)||!remoteId(value.selectionId)||!hash(value.sha256)||!integer(value.bytes,MAX_ZIP)||value.bytes<1||value.id<=previous||paths.has(value.id)||(total+=value.bytes)>MAX_TOTAL)fail('原媒体选择、顺序、归属或容量无效');media(value.kind,value.mime);previous=value.id;paths.add(value.id);}
  if(await wait(()=>archiveSha256(encoder.encode(canonical(intent.objects))))!==intent.selectionDigest)fail('原选择摘要不匹配');
  const ownerScope='owner-'+await wait(()=>archiveSha256(encoder.encode(identity.service+'|'+identity.owner))),storeId='archive-local-media-'+pin.archiveId,key=ownerScope+'|'+storeId;
  if(active.has(key))fail('本归档本地恢复正在进行');active.add(key);
  const open=()=>{guard();const store=(options.storage??browserArchiveStorage)(ownerScope,storeId);if(store.ownerId!==ownerScope||store.storeId!==storeId)fail('恢复目的不是原账号独立空间');return store;};
  return {job:frozen as Context['job'],identity,ownerScope,storeId,key,options,guard,wait,open};
}
async function validateManifest(raw:Uint8Array,c:Context){
  if(!(raw instanceof Uint8Array)||raw.length<1||raw.length>MAX_MANIFEST)fail('归档清单超限');let manifest:unknown;try{manifest=JSON.parse(decoder.decode(raw));}catch{fail('归档清单不是完整UTF-8 JSON');}
  exact(manifest,['schema','archiveId','ownerId','createdAt','archiveConsent','totalBytes','objects','restoreSemantics']);exact(manifest.archiveConsent,['version','accepted']);const chosen=c.job.intent.objects;
  if(manifest.schema!=='private-media-archive/v1'||manifest.archiveId!==c.job.pin.archiveId||manifest.ownerId!==c.identity.owner||!unix(manifest.createdAt)||manifest.archiveConsent.version!=='media-archive/v1'||manifest.archiveConsent.accepted!==true||manifest.restoreSemantics!==semantics||!Array.isArray(manifest.objects)||manifest.objects.length!==chosen.length||manifest.totalBytes!==chosen.reduce((n,o)=>n+o.bytes,0))fail('归档清单与原请求不一致');
  for(let i=0;i<chosen.length;i++){const row=manifest.objects[i],original=chosen[i];exact(row,['id','ownerId','path','sha256','bytes','mime','kind','restoreRelation','saveConsent','trainingConsentSnapshot']);exact(row.restoreRelation,['clientObjectId','selectionId']);exact(row.saveConsent,['version','accepted','acceptedAt','selectionId']);
    if(row.id!==original.id||row.ownerId!==original.ownerId||row.path!=='objects/'+original.id||row.sha256!==original.sha256||row.bytes!==original.bytes||row.mime!==original.mime||row.kind!==original.kind||row.restoreRelation.clientObjectId!==original.clientObjectId||row.restoreRelation.selectionId!==original.selectionId||row.saveConsent.version!=='media-save/v1'||row.saveConsent.accepted!==true||!unix(row.saveConsent.acceptedAt)||row.saveConsent.selectionId!==original.selectionId)fail('归档对象、MIME或原恢复关系不一致');snapshotTraining(row.trainingConsentSnapshot);
  }
  if(decoder.decode(raw)!==canonical(manifest)||await c.wait(()=>archiveSha256(raw))!==c.job.pin.manifestSha256)fail('原清单字节与摘要不匹配');return manifest;
}
async function verifyObject(bytes:Uint8Array,row:ArchiveMediaSelection,c:Context){if(!(bytes instanceof Uint8Array)||bytes.length!==row.bytes||await c.wait(()=>archiveSha256(bytes))!==row.sha256)fail('恢复对象缺失或字节摘要损坏');signature(bytes,row.mime);c.guard();}
function inventory(paths:string[],allowed:string[],requireComplete=false){if(!Array.isArray(paths)||paths.length>102||new Set(paths).size!==paths.length||paths.some(p=>typeof p!=='string'||!allowed.includes(p))||(requireComplete&&paths.length!==allowed.length))fail('本地归档有未知、缺失或重复对象');return new Set(paths);}
function receipt(c:Context,verifiedAt:string):LocalMediaArchiveReceipt{return {schema:'media-local-restore/v1',archiveId:c.job.pin.archiveId,objectCount:c.job.intent.objects.length,totalBytes:c.job.intent.objects.reduce((n,o)=>n+o.bytes,0),manifestSha256:c.job.pin.manifestSha256,archiveSha256:c.job.pin.archiveSha256,selectionDigest:c.job.intent.selectionDigest,ownerScope:c.ownerScope,storeId:c.storeId,verifiedAt,reopenedAndReadBack:true,sourceRetained:true,deletionAuthorized:false,trainingConsentRestored:false,newTrainingConsentRequired:true,productDatabaseRestore:false,persistence:'unknown',retentionControl:'unknown',objects:c.job.intent.objects.map(row=>({id:row.id,clientObjectId:row.clientObjectId,selectionId:row.selectionId,kind:row.kind,mime:row.mime,bytes:row.bytes,sha256:row.sha256,path:'objects/'+row.id}))};}
const paths=(c:Context)=>['manifest.json',...c.job.intent.objects.map(o=>'objects/'+o.id),'receipt.json'];
async function verifyStored(c:Context,requireReceipt:boolean):Promise<LocalMediaArchiveReceipt|null>{
  const store=c.open(),expected=paths(c),found=inventory(await c.wait(()=>store.list()),requireReceipt?expected:expected.slice(0,-1),true);
  if(!found.has('manifest.json'))fail('本地清单尚未完成');await validateManifest(await c.wait(()=>store.read('manifest.json')),c);
  for(const row of c.job.intent.objects)await verifyObject(await c.wait(()=>store.read('objects/'+row.id)),row,c);
  if(!requireReceipt)return null;
  const raw=await c.wait(()=>store.read('receipt.json'));if(!(raw instanceof Uint8Array)||raw.length>256*1024)fail('本地恢复收据超限');let saved:unknown;try{saved=JSON.parse(decoder.decode(raw));}catch{fail('本地恢复收据损坏');}
  if(!saved||typeof saved!=='object'||!iso((saved as Record<string,unknown>).verifiedAt))fail('本地恢复收据日期无效');const wanted=receipt(c,(saved as {verifiedAt:string}).verifiedAt);if(canonical(saved)!==canonical(wanted))fail('本地恢复收据与原绑定不一致');c.guard();return Object.freeze(wanted);
}
/** Explicit file only. No network, media upload jobs, training repository or consent writes. */
export async function restoreLocalMediaArchive(file:Blob,job:MediaArchiveJob,options:LocalMediaArchiveOptions):Promise<LocalMediaArchiveReceipt>{
  const c=await context(job,options);try{
    if(!(file instanceof Blob)||file.size!==c.job.pin.bytes||file.size>MAX_ZIP)fail('所选ZIP长度与原绑定不一致');
    const bytes=new Uint8Array(await c.wait(()=>file.arrayBuffer()));if(bytes.length!==c.job.pin.bytes||await c.wait(()=>archiveSha256(bytes))!==c.job.pin.archiveSha256)fail('所选ZIP整档摘要与原绑定不一致');
    const expected=new Map<string,number|null>([['manifest.json',null],...c.job.intent.objects.map(o=>['objects/'+o.id,o.bytes] as [string,number])]);
    const contents=parsePinnedStoredMediaZip(bytes,expected,c.guard),manifest=contents.get('manifest.json')!;await validateManifest(manifest,c);
    for(const row of c.job.intent.objects)await verifyObject(contents.get('objects/'+row.id)!,row,c);
    const store=c.open(),allowed=paths(c),found=inventory(await c.wait(()=>store.list()),allowed);
    if(found.has('receipt.json'))return (await verifyStored(c,true))!;
    // Verify every retained partial object before filling only missing paths.
    for(const name of found){const actual=await c.wait(()=>store.read(name)),wanted=contents.get(name)!;if(!(actual instanceof Uint8Array)||actual.length!==wanted.length||await c.wait(()=>archiveSha256(actual))!==await c.wait(()=>archiveSha256(wanted)))fail('已有恢复残片不一致，不覆盖或重建');}
    for(const name of allowed.slice(0,-1)){if(found.has(name))continue;await c.wait(()=>store.writeExclusive(name,Uint8Array.from(contents.get(name)!)));}
    await verifyStored(c,false);
    const verifiedAt=new Date((options.now??Date.now)()).toISOString();if(!iso(verifiedAt))fail('恢复完成时间未知');const saved=receipt(c,verifiedAt);await c.wait(()=>store.writeExclusive('receipt.json',encoder.encode(canonical(saved))));
    return (await verifyStored(c,true))!;
  }finally{active.delete(c.key);}
}
/** Reopens the deterministic original namespace; never requires a React-only receipt. */
export async function reopenLocalMediaArchive(job:MediaArchiveJob,options:LocalMediaArchiveOptions):Promise<LocalMediaArchiveReceipt>{const c=await context(job,options);try{return (await verifyStored(c,true))!;}finally{active.delete(c.key);}}