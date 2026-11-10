/** Descriptive geometry in units of the scoring radius. Never a causal diagnosis. */
export type SpreadPoint = { x: number; y: number; group?: number };
const distance = (a: SpreadPoint, b: SpreadPoint) => Math.hypot(a.x-b.x,a.y-b.y);
export function concentration(points: readonly SpreadPoint[]) {
  const p=points.filter(a=>Number.isFinite(a.x)&&Number.isFinite(a.y));
  if (!p.length) return null;
  const center={x:p.reduce((s,a)=>s+a.x,0)/p.length,y:p.reduce((s,a)=>s+a.y,0)/p.length};
  const radii=p.map(a=>distance(a,center)).sort((a,b)=>a-b);
  const radius=radii[Math.ceil(p.length*.8)-1];
  return { ...center, radius, count:p.length, included:radii.filter(r=>r<=radius+1e-10).length,
    rms:Math.sqrt(radii.reduce((s,r)=>s+r*r,0)/p.length) };
}

/** DBSCAN, deterministic spatial ordering. Unassigned points are not deleted. */
export function densityGroups(points: readonly SpreadPoint[], epsilon=.18, minimum=3) {
  if (!(epsilon>0) || minimum<2) throw new Error("Invalid grouping settings");
  const p=points.map((point,index)=>({...point,index})).filter(a=>Number.isFinite(a.x)&&Number.isFinite(a.y)).sort((a,b)=>a.x-b.x||a.y-b.y||a.index-b.index);
  const labels=Array<number>(p.length).fill(-2);
  const neighbours=(i:number)=>p.flatMap((a,j)=>distance(a,p[i])<=epsilon+1e-10?[j]:[]);
  let cluster=0;
  for(let i=0;i<p.length;i++) {
    if(labels[i]!==-2)continue;
    const near=neighbours(i);
    if(near.length<minimum){labels[i]=-1;continue;}
    labels[i]=cluster;
    const pending=[...near], queued=new Set(near);
    for(let q=0;q<pending.length;q++) {
      const j=pending[q];
      if(labels[j]===-1)labels[j]=cluster;
      if(labels[j]!==-2)continue;
      labels[j]=cluster;
      const next=neighbours(j);
      if(next.length>=minimum)for(const k of next)if(!queued.has(k)){queued.add(k);pending.push(k);}
    }
    cluster++;
  }
  return { groups:Array.from({length:cluster},(_,i)=>p.filter((_,j)=>labels[j]===i)), unassigned:p.filter((_,j)=>labels[j]===-1) };
}

export function spreadSummary(points: readonly SpreadPoint[]) {
  const circle=concentration(points), grouped=densityGroups(points);
  // Sensitivity is disclosed, not presented as validation of a latent physical group.
  const signature=(r:ReturnType<typeof densityGroups>)=>r.groups.map(g=>g.map(p=>p.index).sort((a,b)=>a-b).join(',')).sort().join('|');
  const sensitive=signature(grouped)!==signature(densityGroups(points,.15))||signature(grouped)!==signature(densityGroups(points,.21));
  return { circle, ...grouped, sufficient:points.length>=6, sensitive };
}
