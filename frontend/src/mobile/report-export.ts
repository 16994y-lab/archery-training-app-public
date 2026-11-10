import {isOfflineFileHost, saveOfflineFile} from './offline-file-export';
import {offlineAndroid} from './release-mode';

/** Rasterize only the locally generated, escaped report SVG. No external requests. */
export async function reportPng(svg:string):Promise<string> {
 const url=URL.createObjectURL(new Blob([svg],{type:'image/svg+xml;charset=utf-8'}));
 try {
  const image=new Image();
  await new Promise<void>((resolve,reject)=>{image.onload=()=>resolve();image.onerror=()=>reject(new Error('报告图片生成失败，请重试'));image.src=url;});
  const width=image.naturalWidth,height=image.naturalHeight;
  if(!width||!height||width>4096||height>32000||width*height>24_000_000)throw new Error('图片过长，请减少分享内容；完整记录仍可导出文件');
  const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
  const context=canvas.getContext('2d');if(!context)throw new Error('此设备暂不能生成图片，请使用文本报告');
  context.drawImage(image,0,0);
  const png=canvas.toDataURL('image/png');canvas.width=0;canvas.height=0;
  if(!png.startsWith('data:image/png;base64,')||png.length>28*1024*1024)throw new Error('图片超出设备保存上限，请减少分享内容');
  return png;
 } finally {URL.revokeObjectURL(url);}
}

export type ReportPngResult='native-share-requested'|'native-save-requested'|'web-share-returned'|'share-cancelled'|'download-requested'|'share-download-requested'|'offline-saved'|'offline-cancelled';

export function reportPngResultMessage(result:ReportPngResult):string {
 switch(result){
  case 'native-share-requested':return '已请求系统分享，请在系统界面确认';
  case 'native-save-requested':return '正在保存海报到相册，请以完成提示为准';
  case 'offline-saved':return '海报 PNG 已保存到所选位置';
  case 'offline-cancelled':return '已取消保存海报';
  case 'web-share-returned':return '系统分享已结束，请在接收应用中确认';
  case 'share-cancelled':return '已取消系统分享，训练记录保持不变';
  case 'share-download-requested':return '此浏览器不支持图片分享，已改为请求下载海报 PNG';
  case 'download-requested':return '已请求下载海报 PNG，请以浏览器提示为准';
 }
}

export async function saveReportPng(name:string,png:string,share=false):Promise<ReportPngResult> {
 if(!png.startsWith('data:image/png;base64,'))throw new Error('图片尚未准备好');
 if(offlineAndroid&&isOfflineFileHost()){
  if(share)throw new Error('请先将海报保存到本机');
  return await saveOfflineFile(name,png,'image/png')==='saved'?'offline-saved':'offline-cancelled';
 }
 if(window.Gongxingji){const result=JSON.parse(window.Gongxingji.exportFile(name,png,'image/png',share));if(!result.ok)throw new Error(result.error||'系统尚未接受海报保存请求');return share?'native-share-requested':'native-save-requested';}
 if(share&&navigator.share){
  const raw=atob(png.slice('data:image/png;base64,'.length));
  const file=new File([Uint8Array.from(raw,c=>c.charCodeAt(0))],name,{type:'image/png'});
  let supported=false;
  try{supported=navigator.canShare?.({files:[file]})===true;}catch{/* Unsupported capability checks have not sent a share request. */}
  if(supported){
   try{await navigator.share({files:[file],title:'弓行记训练报告'});return 'web-share-returned';}
   catch(error){
    if(error instanceof Error&&error.name==='AbortError')return 'share-cancelled';
    // A share may already have reached the system. Do not retry it or start a second download.
    throw new Error('系统分享未完成，可使用下载海报 PNG');
   }
  }
 }
 // Browsers decide their own download location; never claim a browser download is an album save.
 const link=document.createElement('a');link.href=png;link.download=name;link.click();
 return share?'share-download-requested':'download-requested';
}
