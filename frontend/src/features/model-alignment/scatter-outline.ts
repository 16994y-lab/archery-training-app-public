/** A descriptive hull of known plotted points, not a probability contour. */
export function scatterOutline(points: readonly { x: number; y: number }[]) {
  const sorted = [...new Map(points.filter(p=>Number.isFinite(p.x)&&Number.isFinite(p.y)).map(p=>[`${p.x},${p.y}`,p])).values()].sort((a,b)=>a.x-b.x||a.y-b.y);
  if(sorted.length<3)return sorted;
  const cross=(a:typeof sorted[number],b:typeof a,c:typeof a)=>(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
  const half=(list:typeof sorted)=>{const stack:typeof sorted=[];for(const p of list){while(stack.length>1&&cross(stack[stack.length-2],stack[stack.length-1],p)<=0)stack.pop();stack.push(p);}return stack.slice(0,-1);};
  return [...half(sorted),...half([...sorted].reverse())];
}
