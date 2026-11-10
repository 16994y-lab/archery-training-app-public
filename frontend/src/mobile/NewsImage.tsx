import React,{useState} from 'react';
import type {NewsArticle} from './news-feed';
import {imageForArticle,type ReviewedNewsImage} from './news-images';
export function ReviewedImage({article,variant,fallback=null}:{article:NewsArticle;variant:'card'|'detail';fallback?:React.ReactNode}){
 const image=imageForArticle(article);
 return image?<ImageResource key={image.src} image={image} variant={variant} fallback={fallback}/>:<>{fallback}</>;
}
function ImageResource({image,variant,fallback}:{image:ReviewedNewsImage;variant:'card'|'detail';fallback:React.ReactNode}){
 const [failed,setFailed]=useState(false);
 if(failed)return variant==='card'?<>{fallback}</>:<p className="news-image-unavailable">配图暂时无法加载，可点标题下的“阅读完整原文”查看。</p>;
 if(variant==='card')return <span className="news-remote-thumbnail"><img crossOrigin="anonymous" src={image.src} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={()=>setFailed(true)}/><span>原文配图</span></span>;
 return <figure className="news-original-figure"><img crossOrigin="anonymous" src={image.src} alt={image.alt} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={()=>setFailed(true)}/><figcaption><details className="news-image-credit"><summary>图片说明与许可</summary><p>{image.caption}</p><p>{image.credit} · <a href={image.licenseUrl} target="_blank" rel="noopener noreferrer">许可说明</a></p></details></figcaption></figure>;
}
