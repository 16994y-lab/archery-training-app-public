import React,{useEffect,useRef,useState} from 'react';
import {cloudSync,cloudDocument,cloudEqual,applyCloudDocument,validateCloudDocument} from './cloud-sync';
import {repository,exportText} from './store';
import {initialData} from './domain';
import {mergeBackup,planBackupMerge} from './backup';
import {browserArchiveStorage} from './cloud-media-local';
import {archiveSha256,createProtectedArchive,encodeProtectedArchive,decodeProtectedArchive,importProtectedArchive,restoreProtectedArchive} from './protected-archive';
import {downloadCurrentArchive} from './protected-archive-download';
import {protectedArchiveReady} from './release-mode';
import {useApp,Button,Panel} from './ui';
const id=()=>crypto.randomUUID().replace(/-/g,'');
async function ownerScope(identity:{owner:string;service:string}){return 'owner-'+await archiveSha256(new TextEncoder().encode(identity.service+'|'+identity.owner));}
export function ProtectedArchivePanel(){const {ask,tell,update}=useApp(),[working,setWorking]=useState(false),[message,setMessage]=useState('本地归档保留源资料，不删除云资产');
  const alive=useRef(true),inFlight=useRef(false);useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  if(!protectedArchiveReady)return null;
  async function act(work:()=>Promise<void>){if(inFlight.current)return;inFlight.current=true;setWorking(true);try{await work();}catch(e){tell(e instanceof Error?e.message:'归档未完成；源资料保留');}finally{inFlight.current=false;if(alive.current)setWorking(false);}}
  async function exportRecords(){if(repository.pending)throw new Error('请先处理未保存的本机内容');const identity=cloudSync.manualBackupIdentity();if(!identity)throw new Error('请先登录并核对归档账号');const before=JSON.stringify(repository.data),document=validateCloudDocument(cloudDocument(repository.data)),bytes=new TextEncoder().encode(JSON.stringify(document)),ownerId=await ownerScope(identity);
    const choice=await ask('归档所选完整记录',`我确认当前完整训练与逐箭备注、计划、器材、日历和目标属于本账号。将 ${bytes.byteLength} 字节记录文档归档到本机独立目录并回读校验，再供下载。\n照片、视频和本机头像文件不含在这个记录归档中。下载文件为明文，请放在你控制访问的目录。下载成功不证明持久副本、恢复可用或允许删除；本机及云端源资料均保留。`,['取消','确认归属并归档记录']);if(choice!==1)return;
    if(!alive.current||before!==JSON.stringify(repository.data)||!cloudEqual(identity,cloudSync.manualBackupIdentity())||repository.pending)throw new Error('账号或本机内容已变化，请重新核对');
    const archiveId=id(),store=browserArchiveStorage(ownerId,'archive-'+archiveId),hash=await archiveSha256(bytes);
    const verified=await createProtectedArchive({ownerId,archiveId,selectedObjectIds:['records-v1'],catalog:[{objectId:'records-v1',ownerId,kind:'document',restoreRelation:{entityKind:'document',entityId:'training-records',role:'complete'},expectedByteLength:bytes.byteLength,expectedSha256:hash}],source:{ownerId,storeId:'device-records',readObject:async objectId=>{if(objectId!=='records-v1')throw new Error('未选择此对象');return Uint8Array.from(bytes);}},archiveStorage:store});
    await downloadCurrentArchive({encode:()=>encodeProtectedArchive({ownerId,archiveStorage:store}),isCurrent:()=>alive.current&&cloudEqual(identity,cloudSync.manualBackupIdentity()),download:text=>exportText('gongxingji-protected-records-'+archiveId+'.json',text,'application/json')});setMessage(`已核归档清单摘要 ${verified.manifestSha256.slice(0,12)}…，对象1件/${bytes.byteLength}字节。下载已请求；持久副本与实际保留政策未确认，不允许删除源资料。`);
  }
  async function restoreRecords(file:File){if(file.size>140*1024*1024)throw new Error('归档文件超过容量保护');if(repository.pending)throw new Error('请先处理未保存的本机内容');const identity=cloudSync.manualBackupIdentity();if(!identity)throw new Error('请先核对恢复账号');const ownerId=await ownerScope(identity),text=await file.text(),decoded=await decodeProtectedArchive(text,ownerId);
    if(decoded.manifest.objects.length!==1||decoded.manifest.objects[0].objectId!=='records-v1'||decoded.manifest.objects[0].kind!=='document'||decoded.manifest.objects[0].restoreRelation.entityKind!=='document'||decoded.manifest.objects[0].restoreRelation.entityId!=='training-records'||decoded.manifest.objects[0].restoreRelation.role!=='complete')throw new Error('此入口只恢复完整记录归档；媒体引用需使用对应的对象恢复入口');
    const before=JSON.stringify(repository.data),importStore=browserArchiveStorage(ownerId,'archive-import-'+id());await importProtectedArchive({text,ownerId,destination:importStore});const destination=browserArchiveStorage(ownerId,'archive-restore-'+id()),receipt=await restoreProtectedArchive({ownerId,archiveStorage:importStore,destination,expectedManifestSha256:decoded.manifestSha256});
    const raw=await destination.read(receipt.objects[0].restoredPath),doc=validateCloudDocument(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw))),incoming=initialData();applyCloudDocument(incoming,doc,null);const plan=planBackupMerge(repository.data,incoming);
    if(!alive.current||!cloudEqual(identity,cloudSync.manualBackupIdentity()))throw new Error('账号或页面已变化；恢复副本保留，未加入本机');const choice=await ask('核对归档恢复',`归档已在独立目录真实恢复并回读摘要。记录：${doc.sessions.length}场、${doc.sessions.reduce((n,s)=>n+s.ends.reduce((m,e)=>m+e.arrows.length,0),0)}箭；计划${doc.plans.length}、器材${doc.equipment.length}、日历${doc.schedules.length}、目标${doc.goals.length}。\n冲突${plan.conflicts.length}项，将另存副本；本机当前训练、个人资料与连接设置保留。源归档、本机资料和云资产不删除。`,['取消','确认加入本机并保留冲突副本']);if(choice!==1)return;
    if(!alive.current||!cloudEqual(identity,cloudSync.manualBackupIdentity())||before!==JSON.stringify(repository.data)||repository.pending)throw new Error('核对期间账号或本机内容已变化，请重新预览');const merged=mergeBackup(repository.data,incoming,'copy-imported');
    const saved=await cloudSync.manualBackupSave(()=>update(data=>{if(before!==JSON.stringify(data)||!cloudEqual(identity,cloudSync.manualBackupIdentity()))throw new Error('本机或账号已变化，恢复未覆盖');Object.assign(data,merged.data);}));if(!saved)throw new Error('本机恢复未保存完成；独立恢复副本和原资料保留');setMessage('归档已校验、独立恢复并加入本机；当前训练与源资料保留。');
  }
  return <Panel title="受保护本地归档与恢复"><p role="status">{message}</p><p className="caption">精确清单记录归属、字节、摘要和恢复关系。独立目录校验与本机恢复分开确认；持久权限和保留政策未证实时不允许清理源资产。</p><Button disabled={working||!cloudSync.getStatus().owner} onClick={()=>void act(exportRecords)}>核对并归档完整记录</Button><label>选择记录归档并预览恢复<input type="file" accept="application/json,.json" disabled={working||!cloudSync.getStatus().owner} onChange={e=>{const f=e.target.files?.[0];e.target.value='';if(f)void act(()=>restoreRecords(f));}}/></label></Panel>;
}
