import React, {useEffect,useMemo,useState,useSyncExternalStore} from 'react';
import {Community} from './Community';
import {createProductionCommunityApi} from './community-api';
import {createNativeProductionCommunityChannel} from './community-native-channel';
import {createNativeCommunityPendingStore} from './community-pending-native';
import {cloudSync} from './cloud-sync';
import {Back, Button, Panel} from './ui';

const configuredOrigin=(import.meta as ImportMeta&{env?:Record<string,string>}).env?.VITE_COMMUNITY_VERIFIED_ORIGIN??'';
function verifiedOrigin():string|null{
  try{
    const url=new URL(configuredOrigin);
    return url.protocol==='https:'&&url.origin===configuredOrigin&&url.pathname==='/'&&
      !url.username&&!url.password&&!url.search&&!url.hash?url.origin:null;
  }catch{return null;}
}
const approvedOrigin=verifiedOrigin();
const pendingStore=createNativeCommunityPendingStore();

/** A build opens the real community only after its HTTPS origin has passed cloud and device checks. */
export function CommunityProduction({onBack,onAccount,ask}:{onBack:()=>void;onAccount:()=>void;ask:(title:string,body:string,choices:string[])=>Promise<number>}){
  const cloudStatus=useSyncExternalStore(cloudSync.subscribe,cloudSync.getStatus);
  const [refreshAttempt,setRefreshAttempt]=useState(0);
  const [refreshState,setRefreshState]=useState<'idle'|'loading'|'failed'>('idle');
  const [refreshError,setRefreshError]=useState('');
  const [,renderAfterRefresh]=useState(0);
  const identity=cloudSync.communityIdentity();
  useEffect(()=>{
    if(!approvedOrigin||!cloudStatus.owner||identity)return;
    let live=true;
    setRefreshState('loading');setRefreshError('');
    void cloudSync.ensureCommunityIdentity().then(()=>{
      if(live){setRefreshState('idle');renderAfterRefresh(value=>value+1);}
    }).catch(error=>{
      if(live){setRefreshState('failed');setRefreshError(error instanceof Error?error.message:'社区会话刷新失败');}
    });
    return()=>{live=false;};
  },[cloudStatus.owner,refreshAttempt,!!identity]);
  const allowed=!!approvedOrigin&&identity?.service===approvedOrigin;
  const channel=useMemo(()=>createNativeProductionCommunityChannel({
    identity:cloudSync.communityIdentity,
    enabled:()=>!!approvedOrigin&&cloudSync.communityIdentity()?.service===approvedOrigin,
  }),[]);
  const api=useMemo(()=>allowed&&identity?createProductionCommunityApi(approvedOrigin!,channel,identity):null,
    [allowed,channel,identity?.owner,identity?.service,identity?.generation,identity?.sessionKey]);
  if(!approvedOrigin)return <section className="community-page"><Back title="社区" onBack={onBack}/><Panel title="社区服务验收中"><p>联网社区尚未通过验收；训练与手动记分可照常使用。</p></Panel></section>;
  if(!identity&&cloudStatus.owner)return <section className="community-page"><Back title="社区" onBack={onBack}/><Panel title="正在核对社区账号"><p>{refreshState==='loading'?'正在更新登录会话，待发内容保持原样。':refreshError||'社区会话尚未就绪，待发内容保持原样。'}</p>{refreshState!=='loading'&&<Button onClick={()=>setRefreshAttempt(value=>value+1)}>重试核对账号</Button>}</Panel></section>;
  if(!identity||!allowed||!api)return <section className="community-page"><Back title="社区" onBack={onBack}/><Panel title="先登录测试社区"><p>请使用与本次测试服务匹配的账号登录。原有本机训练不会自动上传或转给新账号。</p><Button onClick={onAccount}>前往账号设置</Button></Panel></section>;
  return <Community key={`${identity.service}:${identity.owner}:${identity.generation}:${identity.sessionKey}`}
    onBack={onBack} api={api} identity={{owner:identity.owner,scope:identity.service,generation:identity.generation,sessionKey:identity.sessionKey}}
    onAccount={onAccount} mode="production" securePendingStore={pendingStore}
    confirmDelete={async()=>await ask('删除这条社区内容？','删除后其他用户将不再看到，已有举报记录按社区安全规则保留。',['取消','确认删除'])===1}
    confirmAbandon={async()=>await ask('停止重试这次发布？','服务端可能已经接收；停止前请刷新核对。',['继续核对','停止重试'])===1}/>;
}
