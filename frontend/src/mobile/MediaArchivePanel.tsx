import React,{useEffect,useMemo,useRef,useState} from 'react';
import {cloudSync} from './cloud-sync';
import {protectedArchiveReady} from './release-mode';
import {useApp,Button,Panel} from './ui';
import {MediaArchiveClient,type MediaArchiveJob,type MediaArchiveRequest,type MediaArchiveExport} from './media-archive-client';
import type {MediaObject} from './private-media-client';
import {restoreLocalMediaArchive,reopenLocalMediaArchive} from './media-archive-local-restore';

export type MediaArchivePanelProps={objects:MediaObject[];request:MediaArchiveRequest;exportArchive?:MediaArchiveExport};
const allowed=()=>protectedArchiveReady;
const currentIdentity=()=>cloudSync.getStatus().authVerified&&cloudSync.getStatus().phoneVerified?cloudSync.manualBackupIdentity():null;
const summary=(rows:MediaArchiveJob['intent']['objects'])=>rows.map(o=>'ID '+o.id+'\nSHA256 '+o.sha256+'\n'+o.bytes+' 字节 · '+o.mime+'\n选择 '+o.clientObjectId+' / '+o.selectionId).join('\n\n');
const content=(o:MediaObject)=>JSON.stringify([o.id,o.ownerId,o.clientObjectId,o.selectionId,o.kind,o.mime,o.sha256,o.bytes,o.status]);
/** Record JSON remains separate. This panel has no text-export fallback or delete capability. */
export function MediaArchivePanel({objects,request,exportArchive}:MediaArchivePanelProps){
  const {ask,tell}=useApp(),[checked,setChecked]=useState<string[]>([]),[jobs,setJobs]=useState<MediaArchiveJob[]>([]),[working,setWorking]=useState(false),[message,setMessage]=useState('媒体归档保留源资料；没有自动归档或清理');
  const identityKey=JSON.stringify(currentIdentity());
  const client=useMemo(()=>new MediaArchiveClient(currentIdentity,request,{enabled:allowed}),[request,identityKey]),epoch=useRef(0),busy=useRef(false),controller=useRef<AbortController|null>(null),latestObjects=useRef(objects);latestObjects.current=objects;
  useEffect(()=>{const view=++epoch.current;client.invalidate();controller.current?.abort();busy.current=false;setWorking(false);setChecked([]);setJobs([]);setMessage('媒体归档保留源资料；没有自动归档或清理');
    if(allowed()&&currentIdentity())void client.list().then(v=>{if(view===epoch.current)setJobs(v);}).catch(e=>{if(view===epoch.current)setMessage(e instanceof Error?e.message:'原请求账未能读取；不新增归档');});
    return()=>{epoch.current++;controller.current?.abort();client.invalidate();};
  },[client,identityKey]);
  if(!allowed())return null;
  async function act(work:(guard:()=>void,signal:AbortSignal)=>Promise<void>){if(busy.current)return;const view=epoch.current,identity=currentIdentity(),c=new AbortController(),isCurrent=()=>view===epoch.current&&!c.signal.aborted&&allowed()&&!!identity&&JSON.stringify(identity)===JSON.stringify(currentIdentity()),guard=()=>{if(!isCurrent())throw new Error('账号、会话或页面已变化；旧归档结果未采用');};
    busy.current=true;controller.current=c;setWorking(true);try{guard();await work(guard,c.signal);guard();const v=await client.list(c.signal);guard();setJobs(v);}catch(e){if(isCurrent())tell(e instanceof Error?e.message:'归档未完成；原账与源保留');}finally{if(view===epoch.current){busy.current=false;controller.current=null;setWorking(false);}}
  }
  async function make(guard:()=>void,signal:AbortSignal){const chosen=checked.map(id=>objects.find(o=>o.id===id));if(!chosen.length||chosen.some(o=>!o||o.status!=='stored'))throw new Error('请选择已核保存的媒体');const rows=chosen as MediaObject[],before=rows.map(content);guard();
    const choice=await ask('另行自愿归档所选媒体',summary(rows)+'\n\n另行同意把这份精确选择建为服务器独立ZIP归档。此同意不贡献模型训练、不扫描相册、不覆盖训练或重授训练同意。明文ZIP需保存到你控制访问的目录；源保留，持久副本与保留政策待核。失回应只显式复用原key，最多3次尝试，不自动重发。',['取消','同意归档这些媒体']);guard();if(choice!==1)return;
    if(rows.some((o,n)=>content(latestObjects.current.find(v=>v.id===o.id)??({} as MediaObject))!==before[n]))throw new Error('所选媒体已变化，请重新核对');guard();
    const job=await client.prepare(rows,{version:'media-archive/v1',accepted:true},signal);guard();setJobs(v=>v.some(j=>j.intent.selectionDigest===job.intent.selectionDigest)?v:[...v,job]);
    const d=await client.create(job.intent.selectionDigest,signal);guard();setMessage('服务器归档 '+d.id+' 的清单与精确选择已核；尚未请求手机保存，源资料保留');
  }
  async function retry(job:MediaArchiveJob,guard:()=>void,signal:AbortSignal){guard();const lookup=job.createAttempts>0;const choice=await ask(lookup?'查询原归档请求':'显式复用原归档请求',summary(job.intent.objects)+'\n\n原key '+job.intent.idempotencyKey+'；已耐久登记 '+job.createAttempts+'/3 次。'+(lookup?'先前创建结果未知；本次仅查询原key，不新增创建尝试或重发创建。账与源保留。':'本次只使用原key，不创建替代key。账与源保留。'),['取消',lookup?'仅查询原请求':'显式复用此原请求']);guard();if(choice!==1)return;const d=await client.create(job.intent.selectionDigest,signal);guard();setMessage('原归档 '+d.id+' 已核清单与选择；源保留');}
  async function restore(job:MediaArchiveJob,guard:()=>void,signal:AbortSignal){guard();const choice=await ask('核对服务器独立恢复副本','原归档 '+job.pin?.archiveId+'\n'+summary(job.intent.objects)+'\n\n这是服务器独立副本回读核验，不是手机恢复或长期持久保存。关系只含clientObjectId/selectionId，不拼成训练场次、组或逐箭记录；训练贡献不恢复，源不删除。服务器和本机各保留有限原请求账。',['取消','核对服务器独立副本']);guard();if(choice!==1)return;const d=await client.restore(job.intent.selectionDigest,signal);guard();setMessage('服务器原归档 '+d.id+' 的独立恢复回执与逐件关系已核；不是手机或长期持久副本完成，不新增训练同意或删除源');}
  async function restoreLocal(job:MediaArchiveJob,file:File,guard:()=>void,signal:AbortSignal){
    guard();if(!job.pin||file.size!==job.pin.bytes||file.size>50*1024*1024)throw new Error('所选ZIP大小与原归档不一致；没有恢复或修改原件');
    const choice=await ask('从已保存ZIP恢复本机副本',`${job.intent.objects.length} 件媒体，共 ${job.intent.objects.reduce((n,o)=>n+o.bytes,0)} 字节。将核对你选择的ZIP与原归档摘要，再逐件恢复到本账号的独立空间并回读。\n不覆盖训练记录，不创建上传任务，不恢复训练同意，也不删除源文件。已有正确副本只核对；中断副本仅补缺，损坏内容不覆盖。`,['取消','核对并恢复本机副本']);
    guard();if(choice!==1)return;
    const receipt=await restoreLocalMediaArchive(file,job,{identity:currentIdentity,guard,enabled:allowed,signal});
    guard();setMessage(`已从所选ZIP核对 ${receipt.objectCount} 件媒体并恢复独立本机副本，逐件回读一致。原始关系保留；没有加入训练记录或上传，长期持久与保留期仍未确认。`);
  }
  async function reopenLocal(job:MediaArchiveJob,guard:()=>void,signal:AbortSignal){
    guard();const receipt=await reopenLocalMediaArchive(job,{identity:currentIdentity,guard,enabled:allowed,signal});
    guard();setMessage(`已重新打开独立本机副本，${receipt.objectCount} 件媒体与原归档摘要及关系一致。此次回读不代表长期持久保存；源资料保留。`);
  }
  return <div style={{minWidth:0,overflowWrap:'anywhere'}}><Panel title="所选媒体ZIP归档"><p role="status">{message}</p><p className="caption">此入口只归档你明确选择的已核媒体；完整训练记录JSON使用原记录归档入口。ZIP客户端下载保护50 MiB。下载时核整档长度与摘要；重新选择已保存ZIP后可逐件校验并恢复独立本机副本。</p>
    {!exportArchive&&<p role="status">此端未接二进制ZIP保存。保存读取已停止，不使用文本桥；可保留原请求并核对服务器清单。</p>}
    {objects.filter(o=>o.status==='stored').map(o=><label key={o.id}><input type="checkbox" checked={checked.includes(o.id)} disabled={working} onChange={e=>setChecked(v=>e.target.checked?[...v,o.id]:v.filter(id=>id!==o.id))}/>{o.kind==='video'?'视频':'图片'} · {o.bytes} 字节 · ID {o.id}<small> SHA256 {o.sha256}</small></label>)}
    <Button disabled={working||!checked.length||!currentIdentity()} onClick={()=>void act(make)}>核对选择并另行同意归档</Button>
    {jobs.map(job=><div key={job.intent.selectionDigest}><p>原请求 {job.intent.idempotencyKey} · 创建尝试 {job.createAttempts}/3 · 恢复尝试 {job.restoreAttempts}/3</p><p className="caption">{job.intent.objects.length} 件；选择摘要 {job.intent.selectionDigest}。本机请求账不是持久归档副本证明。</p>
      {!job.pin?<Button disabled={working} onClick={()=>void act((g,s)=>retry(job,g,s))}>{job.createAttempts>0?'查询原归档请求':'显式复用原请求'}</Button>:<>
        <p>原归档 {job.pin.archiveId} · {job.pin.bytes} 字节</p>
        <Button disabled={working} onClick={()=>void act(async(g,s)=>{g();const d=await client.read(job.intent.selectionDigest,s);g();setMessage('原归档 '+d.id+' 的清单与摘要已核；手机保存及长期持久/保留事实未确认，源保留');})}>只读核对原归档</Button>
        <Button disabled={working||!exportArchive||job.pin.bytes>50*1024*1024} onClick={()=>void act(async(g,s)=>{g();await client.download(job.intent.selectionDigest,exportArchive,s);g();setMessage('ZIP整档长度与摘要已核，二进制保存已请求；手机实际保存与长期持久事实未确认，源保留');})}>核摘要并请求保存ZIP</Button>
        {job.pin.bytes>50*1024*1024&&<p className="caption">原ZIP超过50 MiB，未读取保存；原归档与源保留。</p>}
        <label>选择已保存ZIP，核对并恢复本机副本<input type="file" accept="application/zip,.zip" disabled={working||job.pin.bytes>50*1024*1024||!currentIdentity()} onChange={e=>{const file=e.target.files?.[0];e.target.value='';if(file)void act((g,s)=>restoreLocal(job,file,g,s));}}/></label>
        <Button disabled={working||!currentIdentity()} onClick={()=>void act((g,s)=>reopenLocal(job,g,s))}>重新打开并核对本机副本</Button>
        <Button disabled={working||job.restoreAttempts>=3} onClick={()=>void act((g,s)=>restore(job,g,s))}>核对服务器独立恢复</Button>
      </>}
    </div>)}
    <p className="caption">清理与删除始终关闭。下载请求、服务器恢复回执与手机保存分别判断；受保护持久副本及实际保留政策未核时不能据此释放源资料。</p>
  </Panel></div>;
}
