import {copy,type Arrow,type Data,type End} from './domain';
import {validateData} from './store';

export type PhotoSaveState={data:Data;pending:Data|null};
export type PhotoSaveBinding={sessionId:string;endId:string;candidateIds:string[];previousEndId?:string};
export type PhotoSaveReceipt={kind:'photo-save-receipt/v1';revision:number;sessionId:string;target:string;end:End;rows:Arrow[];previous:End|null};
type Match={status:'complete'|'missing'|'conflict';reason?:string};
const same=(left:unknown,right:unknown)=>JSON.stringify(left)===JSON.stringify(right);

/** Capture actual inserted rows, including timestamps and M/skip effects, inside update. */
function capture(data:Data,binding:PhotoSaveBinding):PhotoSaveReceipt{
  validateData(data);
  const session=data.sessions.find(item=>item.id===binding.sessionId),end=session?.ends.find(item=>item.id===binding.endId);
  if(!session||!end||!binding.candidateIds.length||new Set(binding.candidateIds).size!==binding.candidateIds.length)throw new Error('照片保存归属无法核对');
  const rows=binding.candidateIds.map(id=>{
    const found=end.arrows.filter(arrow=>arrow.id===id);if(found.length!==1||found[0].source!=='photo')throw new Error('照片批次行无法核对');return copy(found[0]);
  });
  const previous=binding.previousEndId?session.ends.find(item=>item.id===binding.previousEndId):null;
  if(binding.previousEndId&&!previous)throw new Error('上一组保存结果无法核对');
  return {kind:'photo-save-receipt/v1',revision:data.revision+1,sessionId:session.id,target:JSON.stringify(session.conditions.target),end:copy(end),rows,previous:previous?copy(previous):null};
}

/** Read-only comparison never grants recognition accuracy or permission to write. */
export function comparePhotoSave(data:Data,receipt:PhotoSaveReceipt):Match{
  try{validateData(data);}catch{return {status:'conflict',reason:'重读资料无效，候选保留'};}
  const session=data.sessions.find(item=>item.id===receipt.sessionId),end=session?.ends.find(item=>item.id===receipt.end.id);
  if(!session||!end)return {status:'missing',reason:'场次或目标组尚未保存'};
  if(data.revision<receipt.revision||JSON.stringify(session.conditions.target)!==receipt.target)return {status:'conflict',reason:'资料版本或靶型变化'};
  for(const expected of receipt.rows){
    const found=data.sessions.flatMap(s=>s.ends.flatMap(e=>e.arrows.filter(a=>a.id===expected.id).map(arrow=>({sessionId:s.id,endId:e.id,arrow}))));
    if(!found.length)return {status:'missing',reason:'本批箭记录尚未完整保存'};
    if(found.length!==1||found[0].sessionId!==receipt.sessionId||found[0].endId!==receipt.end.id||!same(found[0].arrow,expected))return {status:'conflict',reason:'环值、位置、来源或组归属不符'};
  }
  if(!same(end,receipt.end)||receipt.previous&&!same(session.ends.find(e=>e.id===receipt.previous!.id),receipt.previous))return {status:'conflict',reason:'整组内容或上一组缺箭处理变化'};
  return {status:'complete'};
}

/** The existing App update keeps its authentication, lock and durable/cloud notifications. */
export async function savePhotoBatch(update:(change:(data:Data)=>void)=>Promise<boolean>,read:()=>PhotoSaveState,change:(data:Data)=>PhotoSaveBinding){
  let receipt:PhotoSaveReceipt|null=null;
  const saved=await update(data=>{receipt=capture(data,change(data));});
  const expected=receipt as PhotoSaveReceipt|null;
  if(!expected)return {status:'blocked' as const,receipt:null};
  const state=read();
  if(saved&&comparePhotoSave(state.data,expected).status==='complete')return {status:'saved' as const,receipt:expected};
  if(!saved&&state.pending&&comparePhotoSave(state.pending,expected).status==='complete')return {status:'pending' as const,receipt:expected};
  return {status:'conflict' as const,receipt:expected};
}
