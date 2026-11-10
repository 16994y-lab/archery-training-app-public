/** Identity and view lifetime must remain current across archive encoding. */
export async function downloadCurrentArchive(input:{encode:()=>Promise<string>;isCurrent:()=>boolean;download:(text:string)=>void}){
  if(!input.isCurrent())throw new Error('账号或页面已变化；源归档保留，未触发下载');
  const text=await input.encode();
  if(!input.isCurrent())throw new Error('账号或页面已变化；源归档保留，未触发下载');
  input.download(text);
}
