import React,{useRef,useState} from 'react';
import {Back,Button,Modal,useApp} from './ui';
import {furryImage} from './avatar-local';
import {AppIcon} from './AppIcon';
import './support-pages.css';
import {AppSupportOperations} from './RewardsEntry';
const supportCode=new URL('../../public/ui/support/alipay-support.jpg',import.meta.url).href;
const feedbackCode=new URL('../../public/ui/support/qq-feedback-group.jpg',import.meta.url).href;
const groupNumber='1057139639';
function CodeAction({src,alt,primary=false}:{src:string;alt:string;primary?:boolean}){
 const [enlarged,setEnlarged]=useState(false),[failed,setFailed]=useState(false);
 return <><Button type="button" kind={primary?'primary':undefined} className={primary?'wide support-pay-action':'support-code-action'} onClick={()=>{setFailed(false);setEnlarged(true);}}><AppIcon name={primary?'heart':'qr'}/><span>查看{alt}</span>{!primary&&<span className="row-chevron" aria-hidden="true">›</span>}</Button>
 {enlarged&&<Modal title={alt} onClose={()=>setEnlarged(false)}><div className="support-code-expanded">{failed?<p role="status" className="support-image-error">图片暂时无法显示，请关闭后重试。</p>:<img src={src} alt={`${alt}完整原图`} onError={()=>setFailed(true)}/>}</div><p className="support-image-hint">请使用对应应用识别二维码，也可用另一台设备扫码。</p><Button type="button" className="wide" onClick={()=>setEnlarged(false)}>关闭大图</Button></Modal>}</>;
}
export function CommunityEntry(){const {open}=useApp();return <button type="button" className="community-entry" onClick={()=>open('feedback')}><img src={furryImage('furry-arctic-fox')} alt=""/><span><strong>反馈与交流群</strong><small>和弓友聊训练，和小弓聊建议</small></span><span aria-hidden="true">›</span></button>;}
export function SupportDeveloper({onBack}:{onBack:()=>void}){
 return <div className="support-page support-tea-page"><Back title="赞赏支持" onBack={onBack}/>
 <section className="support-tea-hero"><div className="support-tea-art"><span className="support-orbit orbit-one"/><span className="support-orbit orbit-two"/><img src={furryImage('furry-arctic-fox')} alt="官方小弓：打弓雪"/><span className="support-tea-token"><AppIcon name="tea"/></span><span className="support-spark" aria-hidden="true">✦</span></div><span className="support-kicker">谢谢你喜欢弓行记</span><h2>请小弓喝杯茶</h2><p>每一份心意，<br/>都陪着小弓再向前一箭。</p><p className="support-pay-hint">赞赏自愿，请先在支付宝核对收款信息。</p><CodeAction src={supportCode} alt="支付宝收款码" primary/></section>
 <div className="support-free-note"><AppIcon name="heart"/><p>心意随你，训练自在。<br/><span>赞赏完全自愿，记分、训练与复盘继续免费使用。</span></p></div><AppSupportOperations initialTab="donations"/><CommunityEntry/></div>;
}
export function FeedbackCommunity({onBack}:{onBack:()=>void}){
 const {open}=useApp(),[copyState,setCopyState]=useState<'idle'|'working'|'copied'|'manual'>('idle');
 const groupInput=useRef<HTMLInputElement>(null),copying=useRef(false);
 const copyGroup=async()=>{if(copying.current)return;copying.current=true;setCopyState('working');const trigger=document.activeElement;try{if(!navigator.clipboard||typeof navigator.clipboard.writeText!=='function')throw new Error('unavailable');await navigator.clipboard.writeText(groupNumber);setCopyState('copied');}catch{let copied=false;try{groupInput.current?.focus();groupInput.current?.select();copied=!!groupInput.current&&document.execCommand('copy');}catch{/* The visible number supports manual selection. */}setCopyState(copied?'copied':'manual');if(copied&&trigger instanceof HTMLElement)requestAnimationFrame(()=>{if(trigger.isConnected&&document.activeElement===groupInput.current)trigger.focus({preventScroll:true});});}finally{copying.current=false;}};
 return <div className="support-page support-feedback-page"><Back title="反馈与交流群" onBack={onBack}/>
 <section className="community-room"><header className="support-welcome"><div><span className="support-kicker">弓友们的小小会客厅</span><h2>来和小弓聊聊</h2><p>训练心得、问题和灵感，<br/>这里都欢迎。</p></div><img src={furryImage('furry-arctic-fox')} alt="官方小弓：打弓雪"/></header>
 <div className="support-group-card"><label htmlFor="gongxingji-feedback-group">弓行记｜射箭交流 · QQ群</label><div className="support-group-action"><input id="gongxingji-feedback-group" ref={groupInput} className="support-group-number" aria-label="QQ 群号" type="text" value={groupNumber} readOnly onClick={event=>event.currentTarget.select()}/><Button type="button" kind="primary" disabled={copyState==='working'} onClick={()=>void copyGroup()}>{copyState==='working'?'复制中…':'复制群号'}</Button></div><p className="support-copy-status" role="status">{copyState==='copied'?'已复制 · 去 QQ 搜索群号就能找到我们':copyState==='manual'?'自动复制未完成，请长按或选择群号复制。':'复制群号，在 QQ 搜索并申请加入'}</p></div></section>
 <details className="support-howto"><summary>用这部手机加入交流群</summary><ol><li><span>1</span><div><strong>复制群号</strong><small>轻点上面的按钮</small></div></li><li><span>2</span><div><strong>打开 QQ 搜索</strong><small>核对群名“弓行记｜射箭交流”</small></div></li><li><span>3</span><div><strong>申请加入，回来继续练</strong><small>切换应用会保留当前训练</small></div></li></ol></details>
 <div className="support-utilities"><CodeAction src={feedbackCode} alt="QQ 交流群二维码"/><details className="support-feedback-help"><summary><AppIcon name="chat"/><span>反馈时，说些什么？</span></summary><p>告诉我们在哪一页、做了什么、希望发生什么。附上版本号和相关截图，会更容易定位。</p><p>分享前请检查截图中的验证码、账号及不想公开的训练内容。</p></details></div>
 <AppSupportOperations/><div className="support-secondary"><span>喜欢这里的小弓？</span><Button type="button" className="text-action" onClick={()=>open('support')}>赞赏支持 ›</Button></div></div>;
}
