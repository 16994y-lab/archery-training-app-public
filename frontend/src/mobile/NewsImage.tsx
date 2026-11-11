import React,{useState} from 'react';
import type {NewsArticle} from './news-feed';
import {imageForArticle,type ReviewedNewsImage} from './news-images';
export function ReviewedImage({article,variant,fallback=null}:{article:NewsArticle;variant:'card'|'detail';fallback?:React.ReactNode}){
 const image=imageForArticle(article);
 return image?<ImageResource key={image.src} image={image} variant={variant} fallback={fallback}/>:<>{fallback}</>;
}
function ImageResource({image,variant,fallback}:{image:ReviewedNewsImage;variant:'card'|'detail';fallback:React.ReactNode}){
 const [failed,setFailed]=useState(false);
 if(failed)return variant!=='detail'?<>{fallback}</>:<p className="news-image-unavailable">配图暂时无法加载，可用文末的「查看原文」打开来源页。</p>;
 if(variant==='card')return <span className="news-remote-thumbnail"><img crossOrigin="anonymous" src={image.src} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={()=>setFailed(true)}/></span>;
 const target=window.Gongxingji?'_self':'_blank';
 return <figure className="news-original-figure"><img crossOrigin="anonymous" src={image.src} alt={image.alt} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={()=>setFailed(true)}/>
  <figcaption className="news-image-credit">
   {image.sourceUrl&&<p>{image.caption}</p>}
   <details><summary>图片说明与许可</summary>
    {!image.sourceUrl&&<p>{image.caption}</p>}
    <p>{image.credit} · {image.sourceUrl&&<><a href={image.sourceUrl} target={target} rel="noopener noreferrer">图片来源</a> · </>}<a href={image.licenseUrl} target={target} rel="noopener noreferrer">许可说明</a></p>
   </details>
  </figcaption>
 </figure>;
}
