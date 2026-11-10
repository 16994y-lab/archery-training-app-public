import React,{useEffect,useState,useSyncExternalStore} from 'react';
import {cloudSync} from './cloud-sync';
import {automaticRecordsSaveReady} from './release-mode';
import {useApp} from './ui';
import {AppIcon} from './AppIcon';
/** A lightweight prompt on the login landing page; it never consents or uploads. */
export function CloudRestoreNotice(){
  const {open}=useApp(),account=useSyncExternalStore(cloudSync.subscribe,cloudSync.getStatus,cloudSync.getStatus);
  const queue=cloudSync.getAutomaticSave(),[dismissed,setDismissed]=useState<string|null>(null),[,refresh]=useState(0);
  useEffect(()=>queue?.subscribe(()=>refresh(n=>n+1)),[queue]);
  const state=queue?.getStatus();
  if(!automaticRecordsSaveReady||!account.authVerified||!account.phoneVerified||!state||state.enabled||!state.remoteAvailable||dismissed===account.owner)return null;
  return <aside className="cloud-restore-notice" aria-label="云备份提醒">
    <AppIcon name="data"/>
    <div role="status"><strong>发现此账号已有云备份</strong><small>确认恢复前不会上传本机资料。</small></div>
    <button type="button" className="restore-open" onClick={()=>open('account','cloud')} aria-label="查看云备份与恢复">查看备份</button>
    <button type="button" className="restore-later" aria-label="暂时继续本机使用" title="暂时继续本机使用" onClick={()=>setDismissed(account.owner)}>稍后</button>
  </aside>;
}
