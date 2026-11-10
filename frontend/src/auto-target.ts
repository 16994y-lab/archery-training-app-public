/** Experimental near-frontal 5–10 target geometry. No model, arrow count or manual points. */
export type AutoPoint = { x: number; y: number };
export type AutoFace = {
  center: AutoPoint; shape: [number, number, number, number]; inverse: [number, number, number, number];
  controls: [AutoPoint, AutoPoint, AutoPoint, AutoPoint];
  axisRatio: number; radius: number; residual: number; colorCoverage: number[];
};
export type AutoTargetResult = { ok: true; face: AutoFace; facesFound: number; method: 'color-ellipse-affine-v1' }
  | { ok: false; reason: 'invalid-image' | 'no-reliable-target' | 'ambiguous-target'; facesFound: number };
const med = (a: number[]) => [...a].sort((x,y)=>x-y)[Math.floor(a.length / 2)];
function solve(a: number[][]): number[] | null {
  for(let i=0;i<a.length;i++) {
    let p=i; for(let j=i+1;j<a.length;j++)if(Math.abs(a[j][i])>Math.abs(a[p][i]))p=j;
    if(Math.abs(a[p][i])<1e-9)return null;
    [a[i],a[p]]=[a[p],a[i]]; const t=a[i][i]; for(let k=i;k<=a.length;k++)a[i][k]/=t;
    for(let j=0;j<a.length;j++)if(j!==i){const q=a[j][i];for(let k=i;k<=a.length;k++)a[j][k]-=q*a[i][k];}
  } return a.map(r=>r[a.length]);
}
function fit(points: AutoPoint[], seed: AutoPoint, scale: number) {
  const normal=Array.from({length:5},()=>Array(6).fill(0));
  for(const p of points) { const x=(p.x-seed.x)/scale,y=(p.y-seed.y)/scale,v=[x*x,2*x*y,y*y,x,y];
    for(let i=0;i<5;i++){for(let j=0;j<5;j++)normal[i][j]+=v[i]*v[j];normal[i][5]+=v[i];}}
  const q=solve(normal); if(!q)return null;
  const [a,b,c,d,e]=q,det=a*c-b*b; if(a<=0||det<=0)return null;
  const cx=-(c*d-b*e)/(2*det),cy=-(-b*d+a*e)/(2*det),k=1+a*cx*cx+2*b*cx*cy+c*cy*cy;
  const disc=Math.hypot(a-c,2*b),lo=(a+c-disc)/2,hi=(a+c+disc)/2;
  if(lo<=0||k<=0)return null;
  const angle=.5*Math.atan2(2*b,a-c),cs=Math.cos(angle),sn=Math.sin(angle);
  const r1=scale*Math.sqrt(k/hi),r2=scale*Math.sqrt(k/lo);
  const shape: [number,number,number,number]=[cs*cs*r1+sn*sn*r2,cs*sn*(r1-r2),cs*sn*(r1-r2),sn*sn*r1+cs*cs*r2];
  const inverse: [number,number,number,number]=[cs*cs/r1+sn*sn/r2,cs*sn*(1/r1-1/r2),cs*sn*(1/r1-1/r2),sn*sn/r1+cs*cs/r2];
  return {center:{x:seed.x+cx*scale,y:seed.y+cy*scale},shape,inverse,axisRatio:r1/r2,radius:r2};
}
/** Pixel-edge coordinates in, circle coordinates out; +y points down like the photo. Never clamps. */
export function targetUnit(face: AutoFace, p: AutoPoint): AutoPoint {
  const x=p.x-face.center.x,y=p.y-face.center.y,[a,b,c,d]=face.inverse;
  return {x:a*x+b*y,y:c*x+d*y};
}
/** Canonical existing score canvas has outer radius 5/12 and a white buffer. */
export function targetPlot(face: AutoFace,p: AutoPoint): AutoPoint {
  const u=targetUnit(face,p);return {x:.5+u.x*5/12,y:.5+u.y*5/12};
}
export function locateStandardTarget(rgba: Uint8ClampedArray, width: number, height: number): AutoTargetResult {
  const fail=(reason: 'invalid-image'|'no-reliable-target'|'ambiguous-target',facesFound=0):AutoTargetResult=>({ok:false,reason,facesFound});
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<32||height<32||width*height>40000000||rgba.length!==width*height*4)return fail('invalid-image');
  const ratio=Math.min(1,768/Math.max(width,height)),w=Math.round(width*ratio),h=Math.round(height*ratio),sx=width/w,sy=height/h;
  const colors=new Uint8Array(w*h),seen=new Uint8Array(w*h),queue=new Int32Array(w*h);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++) {
    const i=(Math.min(height-1,Math.floor((y+.5)*sy))*width+Math.min(width-1,Math.floor((x+.5)*sx)))*4;
    const r=rgba[i],g=rgba[i+1],b=rgba[i+2]; if(rgba[i+3]<200)continue;
    colors[y*w+x]=r>95&&g>70&&Math.min(r,g)>b*1.5&&r<g*1.8?1:r>70&&r>g*1.45&&r>b*1.25?2:b>60&&b>r*1.3&&b>g*1.03?3:0;
  }
  const seeds: {center:AutoPoint; r:number; area:number}[]=[];
  for(let n=0;n<colors.length;n++)if(colors[n]===1&&!seen[n]) {
    let start=0,end=1,sumx=0,sumy=0;queue[0]=n;seen[n]=1;
    while(start<end){const i=queue[start++],x=i%w,y=Math.floor(i/w);sumx+=x+.5;sumy+=y+.5;
      for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){const xx=x+dx,yy=y+dy,j=yy*w+xx;if(xx>=0&&xx<w&&yy>=0&&yy<h&&!seen[j]&&colors[j]===1){seen[j]=1;queue[end++]=j;}}}
    if(end>=w*h*.0015)seeds.push({center:{x:sumx/end,y:sumy/end},r:Math.sqrt(end/Math.PI),area:end});
  }
  const color=(x:number,y:number)=>{const ix=Math.floor(x),iy=Math.floor(y);if(ix<1||iy<1||ix>=w-1||iy>=h-1)return 0;
    const count=[0,0,0,0];for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++)count[colors[(iy+dy)*w+ix+dx]]++;
    const best=count.indexOf(Math.max(...count));return count[best]>=4?best:0;};
  const faces: AutoFace[]=[];
  for(const seed of seeds.sort((a,b)=>b.area-a.area).slice(0,12)) {
    const points:AutoPoint[]=[];
    for(let i=0;i<64;i++){
      const a=i*Math.PI/32,dx=Math.cos(a),dy=Math.sin(a);let first=-1,last=-1,gap=0,bestStart=-1,bestEnd=-1;
      for(let r=Math.floor(seed.r*1.6);r<=seed.r*3.9;r++) {
        const blue=color(seed.center.x+dx*r,seed.center.y+dy*r)===3;
        if(blue){if(first<0)first=r;last=r;gap=0;}else gap++;
        if(gap>3||r+1>seed.r*3.9){if(last-first>bestEnd-bestStart){bestStart=first;bestEnd=last;}first=-1;last=-1;gap=0;}
      }
      if(bestStart>=0&&bestEnd-bestStart>seed.r*.35)points.push({x:seed.center.x+dx*(bestEnd+.5),y:seed.center.y+dy*(bestEnd+.5)});
    }
    if(points.length<48)continue;
    let f=fit(points,seed.center,seed.r*3);if(!f)continue;
    const error=(p:AutoPoint)=>Math.abs(Math.hypot(...Object.values(targetUnit(f as AutoFace,p)))-1);
    const sorted=points.map(p=>({p,e:error(p)})).sort((a,b)=>a.e-b.e);
    f=fit(sorted.slice(0,Math.ceil(sorted.length*.85)).map(z=>z.p),seed.center,seed.r*3);if(!f)continue;
    const residual=med(points.map(error));
    const [a,b,,c]=f.shape,rx=Math.hypot(a,b),ry=Math.hypot(b,c),ctr=f.center;
    if(f.axisRatio<.78||f.radius<Math.min(w,h)*.15||residual>.025||Math.hypot(ctr.x-seed.center.x,ctr.y-seed.center.y)>seed.r*.45)continue;
    if(ctr.x-rx<3||ctr.x+rx>w-3||ctr.y-ry<3||ctr.y+ry>h-3)continue;
    const coverage=[0,0,0],radii=[[.18,.28],[.43,.55,.62],[.75,.85,.93]];
    radii.forEach((rs,k)=>{let hits=0;for(const r of rs)for(let j=0;j<48;j++){const t=j*Math.PI/24,x=r*Math.cos(t),y=r*Math.sin(t);if(color(ctr.x+a*x+b*y,ctr.y+b*x+c*y)===k+1)hits++;}coverage[k]=hits/(rs.length*48);});
    if(coverage.some(v=>v<.7))continue;
    const result:AutoFace={...f,center:{x:ctr.x*sx,y:ctr.y*sy},shape:[a*sx,b*sx,b*sy,c*sy],inverse:[f.inverse[0]/sx,f.inverse[1]/sy,f.inverse[2]/sx,f.inverse[3]/sy],residual,colorCoverage:coverage,controls:[] as unknown as AutoFace['controls']};
    // Use exact independent resize factors, including noninteger aspect rounding.
    result.controls=[{x:(ctr.x-b)/w,y:(ctr.y-c)/h},{x:(ctr.x+a)/w,y:(ctr.y+b)/h},{x:(ctr.x+b)/w,y:(ctr.y+c)/h},{x:(ctr.x-a)/w,y:(ctr.y-b)/h}];
    result.radius=f.radius*Math.max(sx,sy);
    faces.push(result);
  }
  if(!faces.length)return fail('no-reliable-target');
  const distance=(f:AutoFace)=>Math.hypot(f.center.x-width/2,f.center.y-height/2);
  faces.sort((a,b)=>distance(a)-distance(b));
  if(distance(faces[0])>Math.min(width,height)*.35)return fail('no-reliable-target',faces.length);
  if(faces.length>1&&distance(faces[1])-distance(faces[0])<Math.min(width,height)*.12)return fail('ambiguous-target',faces.length);
  return {ok:true,face:faces[0],facesFound:faces.length,method:'color-ellipse-affine-v1'};
}
