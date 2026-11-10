import {validateConditions,type Session} from './domain';

const required=['id','name','target_type','scoring_mode','face_count','sizeRatio','rules_version','allowed_score_codes','coordinate_space','boundary_policy','ring_rules','layout','plot'];
const optional=['scoring_profile','nominal_face_diameter_cm','scoring_diameter_cm','custom'];
export type SharedSource={id:string;date:string;revision:number;status:'completed';conditions:{bow:string;distance:number;size:number|null;target:Record<string,unknown>};ends:{index:number;capacity:number;half:string;arrows:{code:string;x:number|null;y:number|null;face:number;source:'number'|'target'|'photo';coordinateEvidence?:'manual-target-confirmed'}[]}[]};
export function projectTeamSource(session:Session):SharedSource{
 if(session.status!=='completed'||!Number.isSafeInteger(session.revision)||session.revision<1||!/^\d{4}-\d{2}-\d{2}$/.test(session.date)||!/^[A-Za-z0-9_-]{1,128}$/.test(session.id))throw new Error('只能共享有保存版本的已完成训练');
 validateConditions(session.conditions);
 const target=session.conditions.target as unknown as Record<string,unknown>;
 const sharedTarget=Object.fromEntries([...required,...optional].filter(k=>Object.prototype.hasOwnProperty.call(target,k)).map(k=>[k,target[k]]));
 sharedTarget.ring_rules=session.conditions.target.ring_rules?.map(r=>({score_code:r.score_code,label:r.label,color:r.color,outer_radius_norm:r.outer_radius_norm}))??null;
 const layout=session.conditions.target.layout;
 if(layout)sharedTarget.layout={kind:layout.kind,face_count:layout.face_count,faces:layout.faces.map(f=>({index:f.index,anchor_x:f.anchor_x,anchor_y:f.anchor_y}))};
 const plot=session.conditions.target.plot;
 sharedTarget.plot=plot?{coordinate_space:plot.coordinate_space,center_x:plot.center_x,center_y:plot.center_y,outer_scoring_radius_norm:plot.outer_scoring_radius_norm,calibration_boundary_score_code:plot.calibration_boundary_score_code,control_order:[...plot.control_order]}:null;
 const source:SharedSource={id:session.id,date:session.date,revision:session.revision,status:'completed',conditions:{bow:session.conditions.bow,distance:session.conditions.distance,size:session.conditions.size,target:sharedTarget},ends:session.ends.map((end,i)=>({index:i+1,capacity:end.capacity,half:end.half,arrows:end.arrows.map(a=>{
  const trusted=a.source==='target'||a.source==='photo'&&a.coordinateEvidence==='manual-target-confirmed';
  return {code:a.code,x:trusted?a.x:null,y:trusted?a.y:null,face:a.face,source:a.source,...(a.source==='photo'&&a.coordinateEvidence==='manual-target-confirmed'?{coordinateEvidence:a.coordinateEvidence}:{})};
 })}))};
 const raw=JSON.stringify(source);if(new TextEncoder().encode(raw).length>2*1024*1024-512)throw new Error('这场训练超过单次团队提交容量，原训练保持；请联系教练分批核对');
 return JSON.parse(raw) as SharedSource;
}
export function stableTeamValue(v:unknown):string{if(v===null||typeof v!=='object')return JSON.stringify(v);if(Array.isArray(v))return '['+v.map(stableTeamValue).join(',')+']';return '{'+Object.keys(v as object).sort().map(k=>JSON.stringify(k)+':'+stableTeamValue((v as Record<string,unknown>)[k])).join(',')+'}';}
