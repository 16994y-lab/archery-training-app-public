import React,{useEffect,useState} from 'react';
import {cloudSync} from './cloud-sync';
import {AppIcon,type AppIconName} from './AppIcon';
import {FirstBatchHeader} from './FirstBatchHeader';
import {Button,useApp} from './ui';
import {maskEmail} from './account-display';
import {accountDeletionReady,automaticRecordsSaveReady,manualBackupReady,privateMediaSaveReady,protectedArchiveReady} from './release-mode';
import './account-center.css';

export function AccountLink({icon,title,detail,onClick,tone='blue'}:{icon:AppIconName;title:string;detail:string;onClick:()=>void;tone?:string}){
 return <button className={'account-destination account-tone-'+tone} onClick={onClick} type="button" data-return-focus={title}><span className="account-symbol"><AppIcon name={icon}/></span><span><strong>{title}</strong><small>{detail}</small></span><span className="account-chevron" aria-hidden="true">›</span></button>;
}
export function AccountDeletionLink({onClick}:{onClick:()=>void}){
 return <div className="account-destinations"><AccountLink icon="info" title="永久注销账号" detail="查看影响范围 · 注销后无法恢复" tone="rose" onClick={onClick}/></div>;
}
export function AccountOverview({status,onBack}:{status:ReturnType<typeof cloudSync.getStatus>;onBack:()=>void}){
 const {open,hasPendingSave}=useApp(),queue=status.authVerified&&automaticRecordsSaveReady?cloudSync.getAutomaticSave():null;
 const [,refresh]=useState(0);
 useEffect(()=>queue?.subscribe(()=>refresh(n=>n+1)),[queue]);
 const backup=queue?.getStatus(),current=backup?.owner&&backup.owner===status.owner?backup:null;
 const cloudAvailable=status.phoneVerified&&(manualBackupReady||status.authVerified&&(automaticRecordsSaveReady||privateMediaSaveReady||protectedArchiveReady));
 return <section className="account-access account-center">
  <Button className="account-back-link" onClick={onBack}>‹ 返回</Button>
  <FirstBatchHeader eyebrow="我的 / 账号管理" title="账号中心" description="管理登录方式、备份训练，查看你的邀请权益。" meta={status.authVerified?'已登录':'等待联网核对'}/>
  {hasPendingSave()&&<p className="account-notice" role="status">本机还有未保存的修改。请先保存或导出，再进行账号操作。</p>}
  <h2 className="account-group-label">账号与资料</h2>
  <div className="account-destinations">
   <AccountLink icon="shield" title="账号安全" detail={status.authVerified?(status.email?maskEmail(status.email)+' · 管理登录方式':'手机号已验证 · 管理登录方式'):'查看连接状态与重新验证方式'} onClick={()=>open('account','security')}/>
   {cloudAvailable&&<AccountLink icon="data" title="云保存" tone="mint" detail={current?.conflicts.length?`${current.conflicts.length} 项冲突待处理`:current?.enabled?current.message:current?.remoteAvailable?'发现云备份 · 可核对并恢复':current?'自动保存已关闭':'备份、恢复与保存状态'} onClick={()=>open('account','cloud')}/>}
   <AccountLink icon="person" title="邀请与特别伙伴" tone="violet" detail="我的邀请码、注册结果与奖励" onClick={()=>open('rewards')}/>
  </div>
  {accountDeletionReady&&status.authVerified&&<><h2 className="account-group-label">账号管理</h2><AccountDeletionLink onClick={()=>open('account','deletion')}/></>}
 </section>;
}
