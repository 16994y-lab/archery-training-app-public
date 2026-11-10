import React,{useEffect,useMemo,useRef,useState} from 'react';
import {useApp,Button,Panel,Field} from './ui';
import {repository} from './store';
import {cloudSync} from './cloud-sync';
import {maskEmail} from './account-display';
import {ManualBackup,type BackupPreview,type BackupSummary} from './manual-backup';

const summary=(s:BackupSummary)=>`${s.sessions} 场 / ${s.arrows} 箭（完成 ${s.completed} 场、草稿 ${s.drafts} 场）；计划 ${s.plans}、靶面 ${s.targets}、器材 ${s.equipment}、配件 ${s.accessories}、日历 ${s.schedules}、长期安排 ${s.programs}、目标 ${s.goals}；约 ${(s.bytes/1024).toFixed(1)} KB`;
export function ManualBackupPanel({owner,email,busy}:{owner:string|null;email:string;busy:boolean}){
  const {update,ask,tell}=useApp();
  const transfer=useMemo(()=>new ManualBackup({read:()=>repository.data,pending:()=>!!repository.pending,update:change=>cloudSync.manualBackupSave(()=>update(change))},{identity:()=>cloudSync.ensureManualBackupIdentity(),current:()=>cloudSync.manualBackupIdentity(),request:(method,identity,document,revision)=>cloudSync.manualBackupRequest(method,identity,document,revision)}),[update]);
  const [preview,setPreview]=useState<BackupPreview|null>(null),[strategy,setStrategy]=useState<'copy-imported'|'keep-existing'>('copy-imported'),[working,setWorking]=useState(false),[receipt,setReceipt]=useState('');
  const inFlight=useRef(false);
  useEffect(()=>{transfer.invalidate();setPreview(null);setReceipt('');},[transfer,owner]);
  async function act(work:()=>Promise<void>){if(inFlight.current)return;inFlight.current=true;setWorking(true);try{await work();}catch(e){setPreview(null);setReceipt('');tell(e instanceof Error?e.message:'备份未完成，本机资料保留');}finally{inFlight.current=false;setWorking(false);}}
  async function prepare(kind:'upload'|'restore'){setReceipt('');setPreview(await transfer.preview(kind,strategy));}
  async function confirm(){
    if(!preview)return;const p=preview;
    const choice=await ask(p.kind==='upload'?'确认账号归属与完整备份':'确认恢复到本机',`我确认这些资料属于当前登录账号。${p.kind==='upload'?'本机训练、计划、器材、日历、目标及个人资料将发送到现有完整备份服务，更新当前账号的一份云备份。':'将预览中的云资料加入本机；首次默认个人资料从云端恢复，已填写的本机资料、服务设置与当前训练保留。'}照片和视频文件不包含在内。冲突采用${p.strategy==='copy-imported'?'另存副本':'保留已有项'}，已存在的相同内容不重复加入。云端仅保留最新版本。\n本机：${summary(p.local)}\n云端：${p.remote?summary(p.remote):'尚无备份'}\n结果：${summary(p.result)}\n冲突 ${p.plan.conflicts.length} 项。`,['取消',p.kind==='upload'?'确认归属并上传':'确认归属并恢复']);
    if(choice!==1){transfer.invalidate();setPreview(null);return;}
    setPreview(null);
    if(p.kind==='upload'){const result=await transfer.upload(p.token,true);setReceipt(result.unchanged?`云端版本 ${result.revision} 已回读一致，无需重复上传`:`云端版本 ${result.revision} 已回读确认，本机与当前训练保留`);}
    else{await transfer.restore(p.token,true);setReceipt('恢复已在本机保存；请到计划与历史核对。当前训练保持原值');}
  }
  const disabled=busy||working||!owner;
  return <Panel title="完整云备份与恢复">
    <p>账号：{maskEmail(email)||'当前已登录账号'}。每次由你读取、核对并确认；不会自动上传。</p>
    <p className="caption">备份训练与草稿、逐箭成绩及落点、备注与快照、计划、器材、配件、日历、长期安排、目标及个人资料。照片与视频文件不包含在内。单份在线备份容量约 4 MB；超过时请保留本机资料并导出文件。仅保留当前账号最新一份备份。</p>
    <Field label="同一标识内容不同时"><select disabled={disabled} value={strategy} onChange={e=>{transfer.invalidate();setPreview(null);setReceipt('');setStrategy(e.target.value as typeof strategy);}}><option value="copy-imported">另存副本，保留两份内容</option><option value="keep-existing">保留已有项，跳过冲突内容</option></select></Field>
    <div className="actions"><Button disabled={disabled} onClick={()=>void act(()=>prepare('upload'))}>读取上传摘要</Button><Button disabled={disabled} onClick={()=>void act(()=>prepare('restore'))}>读取恢复预览</Button></div>
    {preview&&<><p>接收位置：{preview.destination} · 云端版本 {preview.revision} · {preview.updatedAt??'尚无备份'}</p><p>本机：{summary(preview.local)}</p><p>云端：{preview.remote?summary(preview.remote):'尚无备份'}</p><p>结果：{summary(preview.result)}</p><p>冲突 {preview.plan.conflicts.length} 项；相同内容 {preview.plan.identical.length} 项。</p>{preview.plan.conflicts.length>0&&<details><summary>查看冲突内容</summary>{preview.plan.conflicts.map(c=><p key={c.collection+':'+c.id}>{c.name}</p>)}</details>}<p className="caption">{preview.kind==='restore'?'默认个人资料从云端恢复，已填写的本机资料与连接设置保留；导入的进行中训练为草稿。':'云端已有的不同标识项目保留；本机个人资料会更新云端个人资料。保留已有项时，冲突的本机内容不会进入这次备份。'}</p><Button kind="primary" disabled={disabled} onClick={()=>void act(confirm)}>{preview.kind==='upload'?'核对并上传一次':'核对并恢复到本机'}</Button></>}
    {receipt&&<p role="status">{receipt}</p>}
  </Panel>;
}
