import React,{useEffect,useRef,useState} from 'react';
import {RewardsClient,type RewardKey,type RewardMe,type RewardWriteResult,rewardKeys,rewardNames,rewardImages,rewardError,sameIdentity} from './rewards-api';
import type {TeamIdentity} from './team-api';
import {useRewardWrite,useRewardsIdentity} from './rewards-state';
import {Button,useInnerBack} from './ui';
import {FirstBatchHeader} from './FirstBatchHeader';
import {AccountLink} from './AccountOverview';
import './rewards.css';

type Details='claim'|'partners';
type PageProps={
 client:RewardsClient;onBack:()=>void;onChooseAvatar:(reward?:RewardKey)=>void;onSupport:()=>void;onFeedback:()=>void;
 section?:string;onDetail?:(detail:Details)=>void;resultSlot?:React.ReactNode;
};
export function RewardsPage(props:PageProps){
 const {client,onBack,onDetail}=props,{key,identity}=useRewardsIdentity(client);
 const [local,setLocal]=useState<Details|null>(null);
 const detail=onDetail?props.section:local;
 const back=()=>{if(local&&!onDetail)setLocal(null);else onBack();};
 useInnerBack(!!local&&!onDetail,back);
 const title=detail==='claim'?'领取入群伙伴':detail==='partners'?'我的特别伙伴':'邀请与特别伙伴';
 return <section className="rewards-page reward-center">
  <Button className="account-back-link" onClick={back}>‹ {detail?'返回邀请权益':'返回'}</Button>
  <FirstBatchHeader eyebrow={detail?'邀请权益 / 详情':'我的 / 邀请权益'} title={title} description={detail==='claim'?'使用管理员签发的一次性领取码。':detail==='partners'?'查看当前资格，选择已获得的伙伴头像。':'邀请新弓友，或领取专属的伙伴头像。'}/>
  {identity?<RewardsBody key={key} {...props} section={detail??undefined} onDetail={onDetail??setLocal} onBack={back} bound={identity}/>:<p role="status">请联网核对当前账号后查看。原训练和头像保持。</p>}
 </section>;
}
function RewardsBody({client,bound,onChooseAvatar,onSupport,onFeedback,section,onDetail,onBack,resultSlot}:PageProps&{bound:TeamIdentity;onDetail:(detail:Details)=>void}){
 const [data,setData]=useState<RewardMe|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState(''),[notice,setNotice]=useState(''),[code,setCode]=useState(''),[denied,setDenied]=useState(false),[copyStatus,setCopyStatus]=useState('');
 const [touched,setTouched]=useState(false);
 const validCode=/^[A-Za-z0-9_-]{32}$/.test(code),invalid=touched&&code.length>0&&!validCode;
 const generation=useRef(0),alive=useRef(true),copyLock=useRef(false),invite=useRef<HTMLInputElement>(null);
 const current=(ticket:number)=>alive.current&&ticket===generation.current&&sameIdentity(client.identity(),bound);
 async function refresh(){const ticket=++generation.current;setLoading(true);setError('');try{const value=await client.readMe(bound);if(current(ticket)){setData(old=>old&&old.revision>value.revision?old:value);setDenied(false);}}catch(e){if(current(ticket)){setData(null);setError(rewardError(e));}}finally{if(current(ticket))setLoading(false);}}
 useEffect(()=>{alive.current=true;void refresh();return()=>{alive.current=false;generation.current++;};},[]);
 function success(result:RewardWriteResult,fromReceipt:boolean){setCode('');setNotice(result.status==='redeemed'?'披甲挽弓已领取，可查看当前资格并选择头像。':result.status==='unavailable'?'领取码当前不可用，请联系签发管理员核对。':result.status==='rate_limited'?'尝试较多，请稍后核对。':fromReceipt?'原请求已核对。':'操作已完成。');void refresh();}
 const write=useRewardWrite(client,bound,'user',success,()=>{setData(null);setCode('');setDenied(true);});
 async function copy(){if(copyLock.current||!data?.inviteCode)return;copyLock.current=true;try{if(!navigator.clipboard?.writeText)throw new Error();await navigator.clipboard.writeText(data.inviteCode);if(alive.current&&sameIdentity(client.identity(),bound))setCopyStatus('邀请码已复制。');}catch{if(alive.current&&sameIdentity(client.identity(),bound)){invite.current?.focus();invite.current?.select();setCopyStatus('请长按或手动复制邀请码。');}}finally{copyLock.current=false;}}
 return <>
  {(error||notice||write.message)&&<div className="rewards-notices reward-status" aria-live="polite">{error&&<p role="alert">{error}</p>}{notice&&<p>{notice}</p>}{write.message&&<p>{write.message}</p>}</div>}
  {write.pending&&<div className="reward-pending"><strong>原请求待核对</strong><p>领取按钮已锁定，可读取当时提交的结果。</p><button disabled={write.busy||denied} onClick={()=>void write.readPending()}>读取原请求结果</button></div>}
  {section==='claim'?<section className="reward-card"><h2>一次性领取码</h2><p>加入交流群后向管理员领码。请在 12 小时内用领码时的账号兑换「披甲挽弓」。</p>
    <form onSubmit={e=>{e.preventDefault();if(data?.writeReady&&!denied&&validCode)void write.submit('claim',{code});}}>
     <label htmlFor="partner-claim-code">领取码</label>
     <div className={'partner-code-field'+(invalid?' is-invalid':'')}><input id="partner-claim-code" aria-label="一次性领取码" placeholder="输入 32 位领取码" value={code} aria-invalid={invalid||undefined} aria-describedby="partner-code-hint" maxLength={32} autoCapitalize="none" autoComplete="off" spellCheck={false} disabled={!data?.writeReady||write.busy||!!write.pending||denied} onBlur={()=>setTouched(true)} onChange={e=>setCode(e.target.value.trim())}/><span aria-hidden="true">{code.length}/32</span></div>
     <p className={'partner-field-hint'+(invalid?' is-invalid':'')} id="partner-code-hint" aria-live="polite">{invalid?'请核对完整的 32 位领取码。':'允许英文字母、数字、下划线与短横线。'}</p>
     <button className="primary" disabled={!data?.writeReady||write.busy||!!write.pending||denied||!validCode}>{write.busy?'正在核对…':'领取披甲挽弓'}</button>
    </form>{data&&!data.writeReady&&<p role="status">领取当前暂停，已有资格仍可查看。</p>}{(error||!data)&&<button disabled={loading||write.busy} onClick={()=>void refresh()}>{loading?'正在读取…':'刷新资格'}</button>}</section>
   :section==='partners'?<section className="reward-card"><div className="partner-card-heading"><h2>伙伴图鉴</h2><button disabled={loading||write.busy} onClick={()=>void refresh()}>{loading?'正在读取…':'刷新资格'}</button></div><div className="reward-partners">{rewardKeys.map(key=>{const earned=!!data?.rewards.includes(key);return <article key={key}><div className={'reward-art'+(!earned?' locked':'')}><img src={rewardImages[key]} alt=""/></div><h3>{rewardNames[key]}</h3><span>{earned?'已获得':data?'尚未获得':'等待核对'}</span>{earned?<button onClick={()=>onChooseAvatar(key)}>选择头像</button>:<button onClick={key==='sponsor'?onSupport:key==='community'?onFeedback:onBack}>{key==='sponsor'?'了解赞赏支持':key==='community'?'查看交流群':'查看邀请方式'}</button>}</article>;})}</div><p>赞赏经核实可获得「星冠小弓」，退款后仍可保留。资格有误可在反馈页核对。</p><button onClick={()=>onChooseAvatar()}>查看全部头像</button></section>
   :null}
   <div hidden={section==='partners'||section==='claim'}>
    <div className="partner-overview">
     <section className="reward-card reward-invitation"><div className="partner-card-heading"><span className="reward-kicker">邀请好友</span><img src={rewardImages.invite} alt="" width="62" height="62"/></div><h2>我的邀请码</h2><p>新弓友首次注册前填写邀请码，完成有效注册后双方可获得「结伴开弓」。</p>
      {data?.inviteCode?<div className="reward-copy"><input ref={invite} aria-label="我的稳定邀请码" value={data.inviteCode} readOnly autoComplete="off"/><button className="primary" onClick={()=>void copy()}>复制邀请码</button></div>:<p role="status">{loading?'正在读取邀请码…':'邀请码当前尚不可用，请稍后刷新。'}</p>}
      <p className="partner-copy-status" role="status">{copyStatus}</p>
      <details className="partner-rules"><summary>查看邀请规则</summary><p>在发送首次注册验证码前填写。也可以选择跳过，已有账号不能补填。奖励以服务端回执和当前资格为准。</p></details>
     </section>
     {resultSlot}
    </div>
    <div className="partner-card-heading partner-section-heading"><h2>我的权益</h2><button disabled={loading||write.busy} onClick={()=>void refresh()}>{loading?'正在读取…':'刷新资格'}</button></div>
    <div className="account-destinations">
     <AccountLink icon="bow" title="我的特别伙伴" detail={data?`已获得 ${data.rewards.length} / ${rewardKeys.length} 位 · 查看头像与资格`:'获取资格后可查看已获得的头像'} tone="violet" onClick={()=>onDetail('partners')}/>
     <AccountLink icon="qr" title="领取入群伙伴" detail="使用 12 小时内签发的专属领取码" tone="mint" onClick={()=>onDetail('claim')}/>
    </div>
   </div>
 </>;
}
