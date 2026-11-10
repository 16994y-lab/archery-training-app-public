import {advance,allArrows,confirmEnd,currentBlock,LIMITS,resolveMissingArrows,type Session} from './domain';

/** An overflow batch may enter only the immediately following score group. */
export function photoNextEndIssue(session:Session,expectedEndId:string,count:number):string|null{
  const end=session.ends[session.currentEnd];
  if(session.status!=='active'||!end||end.id!==expectedEndId||end.confirmed||session.currentEnd!==session.ends.length-1)
    return '当前分组已变化，请返回成绩页核对。';
  if(session.rest.some(rest=>!rest.ended)||currentBlock(session)?.kind==='rest')return '休息中不能自动开始下一组。';
  if(!end.arrows.length)return '上一组还没有已录成绩，请先核对候选或使用本组扩容。';
  if(!Number.isSafeInteger(count)||count<1||count>LIMITS.arrowsPerEnd)return '候选数量超出单组保护范围。';
  if(session.ends.length>=LIMITS.ends)return '已达到 500 组保护，请结束本场。';
  if(session.ends.reduce((total,item)=>total+item.arrows.length,0)+count>LIMITS.sessionArrows)return '已达到本场箭量保护，请结束本场。';
  let capacity=end.capacity;
  if(session.plan){
    const block=currentBlock(session);
    if(!block||block.kind!=='score')return '计划已结束，请从成绩页决定是否追加一组。';
    const nextIndex=session.blockEnd+1>=block.ends?session.blockIndex+1:session.blockIndex;
    const next=session.plan.blocks[nextIndex];
    if(!next)return '计划已结束，请从成绩页决定是否追加一组。';
    if(next.kind==='rest')return '下一段是计划休息，请先完成休息再录入。';
    capacity=next.arrows;
  }
  if(count>capacity)return `下一组只有 ${capacity} 个位置；请删除误点或先调整计划。`;
  return null;
}

/** Call inside one repository mutation together with writing the batch. */
export function preparePhotoNextEnd(session:Session,expectedEndId:string,count:number,expectedCount:number,expectedCapacity:number,missingMode:'M'|'skip',face:number){
  const issue=photoNextEndIssue(session,expectedEndId,count);
  if(issue)throw new Error(issue);
  const end=session.ends[session.currentEnd],missing=end.capacity-end.arrows.length;
  if(missingMode==='M'&&allArrows(session).length+missing+count>LIMITS.sessionArrows)
    throw new Error('补记 M 和照片候选后会超过本场箭量保护，未保存。');
  const previousIndex=session.currentEnd;
  resolveMissingArrows(session,expectedEndId,expectedCount,expectedCapacity,missingMode,face);
  confirmEnd(session);advance(session);
  const next=session.ends[session.currentEnd];
  if(session.currentEnd===previousIndex||!next||next.confirmed||next.arrows.length||next.capacity<count)
    throw new Error('下一组状态已变化，上一组与候选均未保存；请返回核对。');
  return next;
}
