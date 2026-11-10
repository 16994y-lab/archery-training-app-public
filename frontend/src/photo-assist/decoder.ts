/** Port of frozen phase11 8-connected regional maxima + radius NMS. */
export type ContactPeak={x:number;y:number;response:number};
export function decodeContact(probability:Float32Array,width:number,height:number):ContactPeak[]{
 if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||probability.length!==width*height)throw Error('Invalid probability dimensions');
 let count=0;for(const v of probability){if(!Number.isFinite(v))throw Error('Non-finite prediction');if(v>=.5)count++;}if(count>50000)throw Error('Dense prediction overflow');
 const seen=new Uint8Array(probability.length),maxima:ContactPeak[]=[];
 for(let index=0;index<probability.length;index++){
  const score=probability[index];if(score<.5||seen[index])continue;
  let representative=index,isMaximum=true;const frontier=[index];seen[index]=1;
  while(frontier.length){const i=frontier.pop()!,y=Math.floor(i/width),x=i%width;representative=Math.min(representative,i);
   for(let ny=Math.max(0,y-1);ny<Math.min(height,y+2);ny++)for(let nx=Math.max(0,x-1);nx<Math.min(width,x+2);nx++){
    const j=ny*width+nx,v=probability[j];if(v>score)isMaximum=false;else if(v===score&&!seen[j]){seen[j]=1;frontier.push(j);}
   }
  }
  if(isMaximum)maxima.push({x:representative%width,y:Math.floor(representative/width),response:score});
 }
 maxima.sort((a,b)=>b.response-a.response||a.y-b.y||a.x-b.x);const kept:ContactPeak[]=[];
 for(const p of maxima)if(kept.every(q=>(p.x-q.x)**2+(p.y-q.y)**2>9)){kept.push(p);if(kept.length>256)throw Error('Peak count overflow');}
 return kept;
}
