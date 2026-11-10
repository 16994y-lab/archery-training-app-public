import React,{useEffect,useRef,useState} from 'react';
import {allArrows,scoreValue,type Session} from '../domain';
import {reportPng,reportPngResultMessage,saveReportPng} from '../report-export';
import {hasOfflineFileSaver,isOfflineFileHost} from '../offline-file-export';
import {offlineAndroid} from '../release-mode';
import {Button,useInnerBack} from '../ui';
import {PROMO_PAGE_VERIFIED,renderSessionPosterSvg} from './session-poster';
import './share-poster.css';

type Props={session:Session;nickname:string;onClose:()=>void;restoreFocus:()=>void};
export function SharePosterModal({session,nickname,onClose,restoreFocus}:Props){
  const dialogRef=useRef<HTMLDialogElement>(null),titleRef=useRef<HTMLHeadingElement>(null),largeTitle=useRef<HTMLHeadingElement>(null);
  const imageButton=useRef<HTMLButtonElement>(null),returnToImage=useRef(false),focusBack=useRef(restoreFocus);
  focusBack.current=restoreFocus;
  const [large,setLarge]=useState(false),[showName,setShowName]=useState(false),[saving,setSaving]=useState(false);
  const [image,setImage]=useState<{session:Session;name:string;png:string}|null>(null);
  const [error,setError]=useState(''),[result,setResult]=useState(''),[retry,setRetry]=useState(0);
  const saveFlight=useRef(false),alive=useRef(true);
  const name=showName?nickname.trim():'';
  const png=image?.session===session&&image.name===name?image.png:'';
  const arrows=allArrows(session),total=arrows.reduce((sum,a)=>sum+scoreValue(a.code),0);
  const localFilePicker=offlineAndroid&&isOfflineFileHost();
  const canSave=!localFilePicker||hasOfflineFileSaver();
  const leaveLarge=()=>{returnToImage.current=true;setLarge(false);};
  useInnerBack(true,large?leaveLarge:onClose,110);

  useEffect(()=>{
    alive.current=true;
    return()=>{alive.current=false;focusBack.current();};
  },[]);
  useEffect(()=>{
    if(large){
      largeTitle.current?.focus();
      const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();leaveLarge();}};
      window.addEventListener('keydown',escape);
      return()=>window.removeEventListener('keydown',escape);
    }
    const dialog=dialogRef.current;
    if(!dialog)return;
    const overflow=document.body.style.overflow;
    dialog.showModal();document.body.style.overflow='hidden';
    if(returnToImage.current){imageButton.current?.focus();returnToImage.current=false;}
    else titleRef.current?.focus();
    return()=>{if(dialog.open)dialog.close();document.body.style.overflow=overflow;};
  },[large]);
  useEffect(()=>{
    let current=true;
    setError('');setResult('');
    void renderSessionPosterSvg(session,'target',{nickname:name,includeNickname:!!name})
      .then(reportPng).then(png=>{if(current)setImage({session,name,png});})
      .catch(reason=>{if(current)setError(reason instanceof Error?reason.message:'海报生成失败，请重试');});
    return()=>{current=false;};
  },[session,name,retry]);
  async function save(share:boolean){
    if(saveFlight.current||!png)return;
    saveFlight.current=true;setSaving(true);setResult('');
    try{
      const outcome=await saveReportPng(`gongxingji-poster-${session.date}-${session.id.slice(0,8)}-target.png`,png,share);
      if(alive.current)setResult(reportPngResultMessage(outcome));
    }catch(reason){if(alive.current)setResult(reason instanceof Error?reason.message:'海报保存未完成');}
    finally{saveFlight.current=false;if(alive.current)setSaving(false);}
  }
  if(large)return <section className="share-poster-large" aria-labelledby="poster-large-heading">
    <header><div><small>训练分享 / 海报预览</small><h2 id="poster-large-heading" tabIndex={-1} ref={largeTitle}>海报大图</h2></div><Button onClick={leaveLarge}>返回分享面板</Button></header>
    <img src={png} alt="本场训练完整分享海报"/>
  </section>;
  return <dialog ref={dialogRef} className="share-poster-dialog" aria-labelledby="share-poster-title" onCancel={event=>{event.preventDefault();onClose();}}>
    <div className="share-poster-dialog-inner">
      <div className="share-poster-dialog-head"><div><span className="eyebrow">单场复盘 / 训练分享</span><h2 ref={titleRef} id="share-poster-title" tabIndex={-1}>制作分享海报</h2></div><Button onClick={onClose}>关闭</Button></div>
      <div className="share-poster-layout"><div className="share-poster-stage">
        <button ref={imageButton} type="button" className="share-preview-button" disabled={!png||saving} aria-label="查看海报大图" onClick={()=>setLarge(true)}>
          {png?<img width={760} height={1120} className="share-poster-image" src={png} alt="本场训练生成的分享海报"/>:<span role="status">{error?'海报暂不可用':'正在生成海报…'}</span>}
        </button>
        {png&&<button type="button" className="share-enlarge" disabled={saving} onClick={()=>setLarge(true)}>查看大图 ↗</button>}
      </div><section className="share-poster-options" aria-label="海报设置与分享">
        <small>{session.date} · 已完成训练</small><h3>{session.name.trim()||'本次训练'}</h3>
        <p className="share-poster-stats"><b>{total}</b> 分 <span>/</span> <b>{arrows.length}</b> 箭</p>
        {nickname.trim()?<label className="check share-poster-name"><input type="checkbox" checked={showName} disabled={saving} onChange={event=>setShowName(event.target.checked)}/><span>显示个人姓名<small>{nickname}</small></span></label>:<p className="caption">海报以“射手”署名。</p>}
        <div className="actions share-poster-actions" aria-busy={saving}>
          <Button kind="primary" disabled={!png||saving||!canSave} onClick={()=>void save(false)}>{localFilePicker?'保存海报 PNG':window.Gongxingji?'保存海报到相册':'下载海报 PNG'}</Button>
          {!localFilePicker&&<Button disabled={!png||saving} onClick={()=>void save(true)}>系统分享海报</Button>}
        </div>
        {error?<div className="share-poster-result" role="alert">{error} <Button onClick={()=>setRetry(v=>v+1)}>重新生成</Button></div>:<p className="share-poster-result" role="status">{saving?'正在请求系统…':result||(!canSave?'此设备当前支持预览，文件保存不可用。':localFilePicker?'请先核对画面，再选择本机保存位置。':'请先核对画面，再保存或发送。')}</p>}
      </section></div>
      <details className="share-poster-about"><summary>海报包含哪些内容</summary><p>图片使用本场实记的成绩、箭数、靶型和已记录的落点。{PROMO_PAGE_VERIFIED?'二维码进入弓行记宣传页。':'当前图片不含宣传页二维码。'}{localFilePicker?'保存位置由你选择。':'下载位置由浏览器决定，系统分享结果可在接收应用中核对。'}</p></details>
    </div>
  </dialog>;
}
