import React, {useEffect, useRef, useState} from 'react';
import {CommunityApi, type CommunityComment, type CommunityPost, type CommunityReport, type ReportReason} from './community-api';
import {afterCommentDelete,afterPostDelete} from './community-ui-state';
import {Back, Button, Panel} from './ui';
import './community.css';

export type PendingWrite={kind:'post'|'comment';postId?:string;body:string;key:string;owner:string;scope:string};
export type CommunityPendingStore={read:(scope:string,owner:string)=>PendingWrite|null;write:(scope:string,owner:string,value:PendingWrite|null)=>void};
type ReportTarget={kind:'post'|'comment';id:string};
const reasons:Record<ReportReason,string>={spam:'广告或刷屏',abuse:'辱骂或骚扰',privacy:'侵犯隐私',other:'其他违规'};

function pendingKey(scope:string,owner:string){return `gongxingji-community-pending:${encodeURIComponent(scope)}:${owner}`;}
function validPending(value:PendingWrite,scope:string,owner:string){return ['post','comment'].includes(value.kind)
  &&typeof value.body==='string'&&typeof value.key==='string'&&value.owner===owner&&value.scope===scope
  &&(value.kind!=='comment'||typeof value.postId==='string');}
function readPending(scope:string,owner:string):PendingWrite|null{
  try{
    const raw=sessionStorage.getItem(pendingKey(scope,owner));if(!raw)return null;
    const value=JSON.parse(raw) as PendingWrite;
    if(!validPending(value,scope,owner))return null;
    return value;
  }catch{return null;}
}
function writePending(scope:string,owner:string,value:PendingWrite|null){if(value)sessionStorage.setItem(pendingKey(scope,owner),JSON.stringify(value));else sessionStorage.removeItem(pendingKey(scope,owner));}
const localPendingStore:CommunityPendingStore={read:readPending,write:writePending};
function errorText(error:unknown){return error instanceof Error?error.message:'请求未完成，请稍后重试';}
function when(value:string){return Number.isFinite(Date.parse(value))?new Date(value).toLocaleString():'时间待核对';}

/** Explicit opt-in screen. Identity and API are injected; training cloud is untouched. */
export function Community({onBack,api,identity,onAccount,confirmDelete,confirmAbandon,mode='local',securePendingStore}:{onBack:()=>void;api:CommunityApi;identity:{owner:string;scope:string;generation?:number;sessionKey?:string}|null;onAccount:()=>void;confirmDelete:()=>Promise<boolean>;confirmAbandon:()=>Promise<boolean>;mode?:'local'|'production';securePendingStore?:CommunityPendingStore}){
  const owner=identity?.owner??null;
  const scope=identity?.scope??null;
  const pendingStore=mode==='production'?securePendingStore:localPendingStore;
  const [nickname,setNickname]=useState(''),[savedNickname,setSavedNickname]=useState<string|null>(null);
  const [loadedFor,setLoadedFor]=useState<string|null>(null);
  const [body,setBody]=useState(''),[posts,setPosts]=useState<CommunityPost[]>([]),[next,setNext]=useState<string|null>(null);
  const [expanded,setExpanded]=useState<string|null>(null),[comments,setComments]=useState<Record<string,CommunityComment[]>>({});
  const [commentDrafts,setCommentDrafts]=useState<Record<string,string>>({}),[pending,setPending]=useState<PendingWrite|null>(null);
  const [message,setMessage]=useState(''),[busy,setBusy]=useState(false),[reportTarget,setReportTarget]=useState<ReportTarget|null>(null);
  const [storageReady,setStorageReady]=useState(false);
  const [reason,setReason]=useState<ReportReason>('spam'),[reports,setReports]=useState<CommunityReport[]|null>(null);
  const busyRef=useRef(false),pendingRef=useRef<PendingWrite|null>(null);
  const identityKey=owner&&scope?`${scope}:${owner}:${identity?.generation??'local'}:${identity?.sessionKey??''}`:null;
  const ready=!!owner&&!!scope&&!!pendingStore&&storageReady&&loadedFor===identityKey&&!!identity&&api.identityMatches(identity);

  useEffect(()=>{
    let live=true;
    setLoadedFor(null);
    setNickname('');setSavedNickname(null);setBody('');setPosts([]);setNext(null);setComments({});setCommentDrafts({});setExpanded(null);setMessage('');setReports(null);
    let resumed:PendingWrite|null=null;
    try{
      resumed=owner&&scope&&pendingStore?pendingStore.read(scope,owner):null;
      if(resumed&&owner&&scope&&!validPending(resumed,scope,owner))throw new Error('Invalid pending owner');
      setStorageReady(!!pendingStore);
    }
    catch{setStorageReady(false);setMessage('无法核对待确认请求，社区写入保持关闭');}
    pendingRef.current=resumed;setPending(resumed);
    if(mode==='production'&&!pendingStore)setMessage('安全暂存未接入，社区写入保持关闭');
    if(owner&&scope){
      void Promise.all([api.profile(),api.posts()]).then(([profile,feed])=>{
        if(!live)return;setNickname(profile.nickname??'');setSavedNickname(profile.nickname);setPosts(feed.items);setNext(feed.nextCursor);
      }).catch(error=>{if(live)setMessage(errorText(error));}).finally(()=>{if(live)setLoadedFor(identityKey);});
      // Android's approved native transport has no moderation decision method.
      // Keep the local test controls, and leave production moderation to an
      // independently accepted admin channel before opening the service.
      if(mode==='local')void api.reports().then(queue=>{if(live)setReports(queue.items);}).catch(()=>{/* Non-moderators have no queue. */});
    }
    return()=>{live=false;};
  },[owner,scope,identityKey,api,mode,pendingStore]);
  useEffect(()=>{if(!reportTarget)return;const close=(event:KeyboardEvent)=>{if(event.key==='Escape')setReportTarget(null);};window.addEventListener('keydown',close);return()=>window.removeEventListener('keydown',close);},[reportTarget]);

  async function refresh(){const feed=await api.posts();setPosts(feed.items);setNext(feed.nextCursor);if(expanded){const page=await api.comments(expanded);setComments(old=>({...old,[expanded]:page.items}));}}
  async function run(work:()=>Promise<void>){if(busyRef.current)return;busyRef.current=true;setBusy(true);setMessage('');try{await work();}catch(error){setMessage(errorText(error));}finally{busyRef.current=false;setBusy(false);}}
  async function saveNickname(){if(!owner)return;await run(async()=>{const value=nickname.trim();if(value.length<2||value.length>20)throw new Error('昵称需要 2–20 字');const saved=await api.setNickname(value);setNickname(saved.nickname);setSavedNickname(saved.nickname);setMessage('社区昵称已保存');});}
  async function sendPending(job:PendingWrite){if(!owner||!scope||job.owner!==owner||job.scope!==scope)return;await run(async()=>{
    if(job.kind==='post')await api.createPost(job.body,job.key);
    else await api.createComment(job.postId!,job.body,job.key);
    pendingStore?.write(scope,owner,null);pendingRef.current=null;setPending(null);
    if(job.kind==='post')setBody('');else if(job.postId)setCommentDrafts(old=>({...old,[job.postId!]:''}));
    await refresh();setMessage('发布成功');
  });}
  async function abandonPending(){if(!owner||!scope||!pendingRef.current)return;
    const job=pendingRef.current;
    const approved=await confirmAbandon();if(!approved)return;
    if(!identity||!api.identityMatches(identity)||pendingRef.current!==job){setMessage('社区账号或待发内容已变化，未清除任何请求');return;}
    try{
      const stored=pendingStore?.read(scope,owner);
      if(!stored||stored.key!==job.key||stored.body!==job.body||stored.kind!==job.kind||stored.postId!==job.postId){setMessage('待发内容已变化，未清除任何请求');return;}
      pendingStore?.write(scope,owner,null);
    }catch{setMessage('无法清除待确认请求；请保留原请求标识并重试');return;}
    pendingRef.current=null;setPending(null);
    if(job.kind==='post')setBody('');else if(job.postId)setCommentDrafts(old=>({...old,[job.postId!]:''}));
    setMessage('已停止重试；服务端是否曾接收仍需刷新核对，不会自动再次发布。');
  }
  function publish(kind:'post'|'comment',postId?:string){if(!owner||!scope||!savedNickname||busyRef.current)return;
    if(!pendingStore){setMessage('安全暂存未接入，未发送社区内容');return;}
    if(pendingRef.current){void sendPending(pendingRef.current);return;}
    const text=(kind==='post'?body:commentDrafts[postId??'']??'').trim(),max=kind==='post'?500:300;
    if(!text||text.length>max){setMessage(`请输入 1–${max} 字`);return;}
    const job:PendingWrite={kind,postId,body:text,key:crypto.randomUUID(),owner,scope};
    try{pendingStore.write(scope,owner,job);pendingRef.current=job;setPending(job);}catch{setMessage('无法安全暂存待确认请求，未发送');return;}
    void sendPending(job);
  }
  async function more(){if(!next)return;await run(async()=>{const page=await api.posts(next);setPosts(old=>[...old,...page.items.filter(item=>!old.some(prior=>prior.id===item.id))]);setNext(page.nextCursor);});}
  async function toggleComments(postId:string){if(expanded===postId){setExpanded(null);return;}setExpanded(postId);await run(async()=>{const page=await api.comments(postId);setComments(old=>({...old,[postId]:page.items}));});}
  async function remove(kind:'post'|'comment',id:string,revision:number){
    if(!ready)return;
    if(!await confirmDelete())return;
    await run(async()=>{if(kind==='post'){
      await api.deletePost(id,revision);setPosts(old=>afterPostDelete(old,id));setComments(old=>{const next={...old};delete next[id];return next;});if(expanded===id)setExpanded(null);
    }else{
      await api.deleteComment(id,revision);setComments(old=>Object.fromEntries(Object.entries(old).map(([key,items])=>[key,afterCommentDelete(items,id)])));
      setPosts(old=>old.map(item=>({...item,commentCount:Math.max(0,item.commentCount-(item.id===expanded?1:0))})));
    }setMessage('已删除；可刷新核对服务端列表');});
  }
  async function sendReport(){if(!ready||!reportTarget)return;await run(async()=>{await api.report(reportTarget.kind,reportTarget.id,reason);setReportTarget(null);setMessage('举报已提交，等待审核');});}
  async function review(id:string,decision:'hide'|'dismiss'){
    if(!ready)return;
    await run(async()=>{await api.review(id,decision);const queue=await api.reports();setReports(queue.items);await refresh();setMessage(decision==='hide'?'内容已隐藏':'举报已驳回');});
  }

  if(owner&&identity&&(!api.identityMatches(identity)||loadedFor!==identityKey))return <section className="community-page"><Back title="社区" onBack={onBack}/><Panel title="正在核对社区账号"><p>切换账号或服务后，请等待当前页面重新载入；旧账号内容不会继续显示或发送。</p></Panel></section>;
  return <section className="community-page"><Back title={mode==='production'?'社区':'社区 · 本机试验'} onBack={onBack}/>
    <p className="community-intro">{mode==='production'?'文字交流；需已验证账号和已开放的 HTTPS 社区服务。':'文字交流试验版。仅连接明确配置的本机隔离服务；'}不上传训练照片，也不从训练成绩自动生成帖子。</p>
    {!owner?<Panel title={mode==='production'?'请先登录':'先选择隔离账号'}><p>{mode==='production'?'登录后仅公开社区昵称，不公开账号标识或训练档案。':'社区试验使用独立合成身份，不连接训练账号或训练档案。'}</p><Button onClick={onAccount}>{mode==='production'?'前往登录':'选择试验账号'}</Button></Panel>:<>
      <Panel title="社区昵称"><label className="community-label" htmlFor="community-nickname">公开显示给其他用户</label><div className="community-row"><input id="community-nickname" value={nickname} maxLength={20} disabled={busy||!ready} onChange={event=>setNickname(event.target.value)} placeholder="2–20 字"/><Button disabled={busy||!ready||nickname.trim()===savedNickname} onClick={()=>void saveNickname()}>保存</Button></div><p className="caption">不显示邮箱、账号标识或训练档案。</p></Panel>
      {pending&&<aside className="community-pending" role="alert"><b>上次发布结果尚未确认</b><p>{mode==='production'?'待确认正文保存在当前账号的受保护暂存区。':'正文暂存在本浏览器当前会话。'}重试会沿用同一请求标识，避免重复发布；永久失败可先刷新核对，再明确停止重试。</p><p className="community-body">{pending.body}</p><div className="community-actions"><Button disabled={busy} onClick={()=>void sendPending(pending)}>用同一请求重试</Button><Button disabled={busy} onClick={()=>void abandonPending()}>停止重试</Button></div></aside>}
      <Panel title="发布文字"><label className="community-label" htmlFor="community-post">正文（最多 500 字）</label><textarea id="community-post" value={body} maxLength={500} disabled={busy||!ready||!!pending||!savedNickname} onChange={event=>setBody(event.target.value)} placeholder="分享训练心得，不包含照片或个人隐私"/><div className="community-row"><span className="caption">{body.trim().length}/500</span><Button kind="primary" disabled={busy||!ready||!!pending||!savedNickname||!body.trim()} onClick={()=>publish('post')}>确认发布</Button></div></Panel>
      {message&&<p className="community-message" role="status">{message}</p>}
      <div className="community-heading"><h2>最新帖子</h2><Button disabled={busy} onClick={()=>void run(refresh)}>刷新</Button></div>
      {posts.length===0?<Panel><p>暂无可见帖子，或服务尚未返回内容。</p></Panel>:posts.map(post=><article className="community-card" key={post.id}>
        <div className="community-meta"><strong>{post.nickname}</strong><time dateTime={post.createdAt}>{when(post.createdAt)}</time></div>
        <p className="community-body">{post.body}</p>{post.status==='hidden'&&<p className="community-warning">此帖已被审核隐藏，仅作者可见。</p>}
        <div className="community-actions">{post.status==='visible'&&<Button disabled={busy} onClick={()=>void toggleComments(post.id)}>评论 {post.commentCount}</Button>}{post.mine?<Button disabled={busy||!ready} onClick={()=>void remove('post',post.id,post.revision)}>删除</Button>:<Button disabled={busy||!ready} onClick={()=>setReportTarget({kind:'post',id:post.id})}>举报</Button>}</div>
        {expanded===post.id&&<div className="community-comments"><h3>评论</h3>{(comments[post.id]??[]).map(comment=><div className="community-comment" key={comment.id}><div className="community-meta"><strong>{comment.nickname}</strong><time dateTime={comment.createdAt}>{when(comment.createdAt)}</time></div><p className="community-body">{comment.body}</p><div className="community-actions">{comment.mine?<Button disabled={busy||!ready} onClick={()=>void remove('comment',comment.id,comment.revision)}>删除评论</Button>:<Button disabled={busy||!ready} onClick={()=>setReportTarget({kind:'comment',id:comment.id})}>举报评论</Button>}</div></div>)}
          <label className="community-label" htmlFor={`comment-${post.id}`}>写评论（最多 300 字）</label><textarea id={`comment-${post.id}`} value={commentDrafts[post.id]??''} maxLength={300} disabled={busy||!!pending||!savedNickname} onChange={event=>setCommentDrafts(old=>({...old,[post.id]:event.target.value}))}/><Button kind="primary" disabled={busy||!!pending||!(commentDrafts[post.id]??'').trim()} onClick={()=>publish('comment',post.id)}>确认评论</Button></div>}
      </article>)}
      {next&&<Button className="wide" disabled={busy} onClick={()=>void more()}>查看更多</Button>}
      {reports!==null&&<Panel title={`待审核举报 · ${reports.length}`}><p className="caption">仅已授权审核员可见。隐藏只影响社区展示，不改训练记录。</p>{reports.map(item=><div className="community-comment" key={item.id}><p>{item.targetKind==='post'?'帖子':'评论'} · {reasons[item.reason]} · {item.nickname}</p><p className="community-body">{item.body}</p><div className="community-actions"><Button disabled={busy||!ready} onClick={()=>void review(item.id,'hide')}>隐藏内容</Button><Button disabled={busy||!ready} onClick={()=>void review(item.id,'dismiss')}>驳回举报</Button></div></div>)}</Panel>}
      {reportTarget&&<div className="community-report" role="dialog" aria-modal="true" aria-label="举报社区内容"><Panel title="举报内容"><label className="community-label" htmlFor="community-reason">原因</label><select id="community-reason" autoFocus value={reason} onChange={event=>setReason(event.target.value as ReportReason)}>{Object.entries(reasons).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select><div className="community-actions"><Button disabled={busy} onClick={()=>setReportTarget(null)}>取消</Button><Button kind="primary" disabled={busy} onClick={()=>void sendReport()}>确认举报</Button></div></Panel></div>}
    </>}
  </section>;
}
