import React,{useEffect,useRef,useState} from 'react';
import {cloudSync} from './cloud-sync';
import type {CloudSaveStatus} from './cloud-save-queue';
import {AppIcon} from './AppIcon';
import {useApp,Button,Panel} from './ui';

const phaseLabels:Record<CloudSaveStatus['phase'],string>={
  off:'已关闭',local:'已存本机',pending:'等待保存',saving:'正在保存',verified:'云端已确认',
  conflict:'等待核对','auth-required':'需要登录',capacity:'容量不足','retry-exhausted':'需要重试',
  unknown:'等待回读',error:'保存未完成',
};
type Choices=Record<string,'local'|'remote'>;
const fieldLabels:Record<string,string>={
  name:'名称',date:'训练日期',status:'状态',note:'备注',notes:'备注',conditions:'训练条件',
  ends:'分组记录',blocks:'训练段',plan:'计划',equipment:'器材',calendar:'日程',archived:'归档状态',
  updated:'更新时间',revision:'版本',distance:'距离',bow:'弓种',size:'靶纸尺寸',
};
function changedValues(value:object,other:unknown) {
  const prior=other&&typeof other==='object'?other as Record<string,unknown>:{};
  const rows=Object.entries(value).filter(([key,v])=>key in fieldLabels&&JSON.stringify(v)!==JSON.stringify(prior[key]));
  return rows.slice(0,4).map(([key,v])=>{
    if(Array.isArray(v))return fieldLabels[key]+' · '+v.length+' 项';
    if(typeof v==='boolean')return fieldLabels[key]+' · '+(v?'是':'否');
    return typeof v==='object'?fieldLabels[key]+'有差异':fieldLabels[key]+' · '+String(v).slice(0,70);
  }).join('，')||'内容有差异，可展开查看此版本。';
}
function versionText(value:unknown){
  if(value===null)return '此版本已删除';
  if(typeof value==='string')return value||'未填写';
  return JSON.stringify(value,null,2);
}

export function AutomaticCloudSavePanel({conflictsOnly=false}:{conflictsOnly?:boolean}={}){
  const {ask,open,tell}=useApp();
  const [,refresh]=useState(0),[working,setWorking]=useState(false),[choices,setChoices]=useState<Choices>({});
  const [failure,setFailure]=useState('');
  const inFlight=useRef(false),queue=cloudSync.getAutomaticSave(),status=queue?.getStatus();
  useEffect(()=>queue?.subscribe(()=>refresh(n=>n+1)),[queue]);
  useEffect(()=>{setChoices({});},[status?.owner,status?.conflicts]);
  useEffect(()=>{setFailure('');},[status?.owner]);
  if(!queue||!status){
    const error=cloudSync.getAutomaticSaveError();
    return error?<Panel title="自动云保存"><p role="status">{error}；本机与原队列保留，请先导出本机记录。</p></Panel>:null;
  }
  async function act(work:()=>Promise<void>){
    if(inFlight.current)return;
    inFlight.current=true;setWorking(true);setFailure('');
    try{await work();}
    catch(error){setFailure(error instanceof Error?error.message:'云保存未完成，本机记录保留。');}
    finally{inFlight.current=false;setWorking(false);}
  }
  async function enable(){
    const identity=cloudSync.manualBackupIdentity();
    if(!identity){tell('请先登录并核对当前账号');return;}
    const restore=queue!.getStatus().remoteAvailable;
    const selected=await ask(restore?'恢复并开启完整记录云保存':'开启完整记录云保存',`我确认本机资料属于当前账号。先读取云备份并合并恢复；同项冲突须逐项选择，本机空库不会直接覆盖云记录。开启后，逐箭训练与草稿、落点和备注、计划、靶型、器材与配件、日历、长期安排、目标和文字个人资料将保存到 ${new URL(identity.service).hostname} 的私有账号备份。\n本机先保存，联网后有限重试；云端保留最新一份，约4 MB容量。照片、视频和本机头像文件不包含在内。训练贡献独立默认关闭，不开启训练贡献也能保存。\n关闭会停止后续请求并保留本机、耐久任务和云资料；已发送的请求可能完成。`,['取消',restore?'确认恢复并开启保存':'确认归属并开启保存']);
    if(selected!==1)return;
    if(JSON.stringify(identity)!==JSON.stringify(cloudSync.manualBackupIdentity()))throw new Error('账号已变化，请重新确认');
    await queue!.enable({ownershipConfirmed:true,saveConsent:true,scope:'complete-records'});
  }

  const conflicts=status.conflicts;
  if(conflictsOnly){
    const chosen=conflicts.filter(item=>choices[item.key]).length;
    return <Panel className="records-cloud cloud-compare">
      <h2>逐项核对版本</h2>
      <p role="status">{conflicts.length?`已选 ${chosen} / ${conflicts.length} 项。确认前，本机与云端均保留原内容。`:status.message}</p>
      {conflicts.map((item,index)=><fieldset key={item.key}>
        <legend>{index+1}. {item.label}</legend>
        {item.key==='recovery:empty-local'&&<p className="cloud-error">采用空本机会用空记录替换云端已有备份。需要取回旧训练时，请选择恢复云端。</p>}
        <div className="cloud-versions">{(['local','remote'] as const).map(side=><div key={side} className={choices[item.key]===side?'cloud-version selected':'cloud-version'}>
          <label><input type="radio" name={'save-'+item.key} checked={choices[item.key]===side} disabled={working} onChange={()=>setChoices(previous=>({...previous,[item.key]:side}))}/>{item.key==='recovery:empty-local'?(side==='local'?'采用空本机':'恢复现有云备份'):(side==='local'?'保留本机版本':'保留云端版本')}</label>
          {typeof item[side]==='object'&&item[side]!==null?<><p>{changedValues(item[side] as object,item[side==='local'?'remote':'local'])}</p><details><summary>查看完整内容</summary><pre>{versionText(item[side])}</pre></details></>:<p>{item.key==='recovery:empty-local'&&side==='local'?'本机当前无记录':versionText(item[side])}</p>}
        </div>)}</div>
      </fieldset>)}
      {failure&&<p className="cloud-error" role="alert">{failure}</p>}
      {conflicts.length>0&&<Button kind="primary" disabled={working||chosen!==conflicts.length} onClick={()=>void act(()=>queue.resolve(choices))}>{working?'正在核对…':'确认逐项选择'}</Button>}
    </Panel>;
  }
  return <Panel className="records-cloud">
    <div className="cloud-panel-head"><div className="cloud-icon"><AppIcon name="shield"/></div><div><span className="cloud-kicker">完整训练记录</span><h2>自动云保存</h2></div><span className="cloud-status" data-state={status.phase}>{phaseLabels[status.phase]}</span></div>
    <p className="cloud-summary" role="status">{status.message}</p>
    {!status.enabled&&<p className="cloud-discovery" role="status">{status.discoveryMessage||'登录后查找本账号的备份，确认归属后才会上传。'}</p>}
    <dl className="cloud-facts"><div><dt>保存位置</dt><dd>{status.enabled?'本机与当前账号的私有备份':'本机优先保存'}</dd></div><div><dt>最近云端回读</dt><dd>{status.lastConfirmed?<time dateTime={status.lastConfirmed}>{new Date(status.lastConfirmed).toLocaleString('zh-CN',{hour12:false})}</time>:'暂无确认记录'}</dd></div></dl>
    <p className="cloud-scope">开启后先读取并合并已有云备份。照片、视频和本机头像需单独处理。</p>
    {conflicts.length>0&&<div className="cloud-attention"><strong>{conflicts.length} 项资料待核对</strong><p>两端的版本有差异，逐项选好后再保存。</p><Button kind="primary" onClick={()=>open('account','cloud-conflicts')}>核对冲突详情</Button></div>}
    {failure&&<p className="cloud-error" role="alert">{failure}</p>}
    <div className="actions cloud-actions" aria-busy={working||status.phase==='saving'}>
      <Button kind={status.enabled?'':'primary'} disabled={working||!status.owner} onClick={()=>void act(status.enabled?()=>queue.disable():enable)}>{status.enabled?'关闭自动云保存':status.remoteAvailable?'恢复并开启自动保存':'确认归属并开启'}</Button>
      {!status.enabled&&<Button disabled={working||!status.owner||status.discovery==='checking'} onClick={()=>void act(()=>queue.discover())}>{status.discovery==='checking'?'正在查找云备份…':'重新查找云备份'}</Button>}
      {status.enabled&&<Button disabled={working||status.phase==='saving'||status.phase==='conflict'} onClick={()=>void act(()=>queue.retry())}>{status.phase==='saving'?'正在读取核对…':'重新读取核对'}</Button>}
    </div>
    <details className="cloud-explainer"><summary>保存范围与关闭后的影响</summary><p>云端保留最近一份完整记录，容量约 4 MB。关闭后，本机和已有云备份都会保留，已发送的请求可能完成。训练贡献可独立选择。</p></details>
  </Panel>;
}
