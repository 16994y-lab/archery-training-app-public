import { allArrows, scoreAt, scoreValue } from './domain';
import type { Arrow, End, Session } from './domain';

export type ScoreSummary = { arrows: number; total: number; average: number | null };
export type EndInsight = ScoreSummary & { index: number; x: number; ten: number; miss: number; low: number };
export type ComparisonInsight = { sessions: number; arrows: number; average: number; delta: number; sourceIds: string[] };
export type SpatialInsight = { inside: Arrow[]; misses: Arrow[]; center: { x: number; y: number } | null };
export type SavedCoordinateCoverage = { trusted: Arrow[]; estimated: Arrow[]; target: number; photoManual: number; photoMapped: number; scoreOnly: number; numeric: number };
export type SessionInsight = ScoreSummary & {
  distribution: Record<string, number>;
  ends: EndInsight[];
  first: ScoreSummary | null;
  last: ScoreSummary | null;
  splitLabels: { first: string; last: string; mode: 'halves' | 'groups' } | null;
  comparison: ComparisonInsight | null;
  comparisonUnavailable: 'unknown-conditions' | 'no-prior' | null;
  spatial: SpatialInsight;
};

const CODES = ['X','10','9','8','7','6','5','4','3','2','1','M'];

function summarize(arrows: Arrow[]): ScoreSummary {
  const total = arrows.reduce((value, arrow) => value + scoreValue(arrow.code), 0);
  return { arrows: arrows.length, total, average: arrows.length ? total / arrows.length : null };
}

function scoreEnds(ends: End[]): EndInsight[] {
  return ends.flatMap((end, index) => {
    if (!end.arrows.length) return [];
    return [{...summarize(end.arrows), index, x:end.arrows.filter(a=>a.code==='X').length,
      ten:end.arrows.filter(a=>a.code==='10').length,
      miss:end.arrows.filter(a=>a.code==='M').length,
      low:end.arrows.filter(a=>a.code!=='M'&&scoreValue(a.code)<=7).length }];
  });
}

function validDate(date: string) { return /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date+'T12:00:00')); }
function validStarted(started: string) { return Number.isFinite(Date.parse(started)); }

// All fields are execution snapshots. Unknown physical size/equipment/rule version cannot prove equivalence.
export function strictComparisonKey(session: Session): string | null {
  const c=session.conditions,t=c.target;
  if (!Number.isFinite(c.distance)||c.distance<=0||!c.bow.trim()||c.size===null||!Number.isFinite(c.size)||c.size<=0||!c.equipment||!t.rules_version||!validDate(session.date)||!validStarted(session.started)) return null;
  const structure=session.ends.filter(e=>e.arrows.length).map(e=>[e.capacity,e.half]);
  return JSON.stringify([c.distance,c.bow,c.size,
    t.id,t.rules_version,t.target_type,t.face_count,t.allowed_score_codes,t.ring_rules,t.layout,t.sizeRatio,
    [c.equipment.bow,c.equipment.riser,c.equipment.limbs,c.equipment.arrows,c.equipment.sight,c.equipment.stabilizer,c.equipment.string,c.equipment.tab,c.equipment.other],
    Boolean(session.plan),structure]);
}

export function savedCoordinateCoverage(session: Session): SavedCoordinateCoverage {
  const trusted:Arrow[]=[],estimated:Arrow[]=[];
  let target=0,photoManual=0,photoMapped=0,scoreOnly=0,numeric=0;
  if(session.status==='completed') for(const end of session.ends) {
    if(!end.confirmed)continue;
    for(const arrow of end.arrows) {
      if(arrow.source==='number'){numeric++;continue;}
      const valid=arrow.x!==null&&arrow.y!==null&&Number.isFinite(arrow.x)&&Number.isFinite(arrow.y)&&Math.abs(arrow.x)<=1.2&&Math.abs(arrow.y)<=1.2&&Number.isInteger(arrow.face)&&arrow.face>=1&&arrow.face<=session.conditions.target.face_count&&scoreAt(session.conditions.target,arrow.x,arrow.y)===arrow.code;
      if(!valid){scoreOnly++;continue;}
      if(arrow.source==='target'){trusted.push(arrow);target++;}
      else if(arrow.coordinateEvidence==='manual-target-confirmed'){trusted.push(arrow);photoManual++;}
      else {estimated.push(arrow);photoMapped++;}
    }
  }
  return {trusted,estimated,target,photoManual,photoMapped,scoreOnly,numeric};
}

function reliableCoordinates(session: Session): SpatialInsight {
  const {trusted}=savedCoordinateCoverage(session);
  const inside=trusted.filter(arrow=>arrow.code!=='M'),misses=trusted.filter(arrow=>arrow.code==='M');
  const center=inside.length>=2?{x:inside.reduce((n,a)=>n+a.x!,0)/inside.length,y:inside.reduce((n,a)=>n+a.y!,0)/inside.length}:null;
  return {inside,misses,center};
}

export function sessionInsight(session: Session, allSessions: Session[]): SessionInsight {
  const arrows=allArrows(session),ends=scoreEnds(session.ends),summary=summarize(arrows);
  const distribution=Object.fromEntries(CODES.map(code=>[code,0])) as Record<string,number>;
  for(const arrow of arrows) if(Object.prototype.hasOwnProperty.call(distribution,arrow.code))distribution[arrow.code]++;
  // Use saved half facts when present; unlabelled free training is split by nonempty groups.
  const recorded=session.ends.filter(end=>end.arrows.length>0);
  const labelled=recorded.some(end=>Boolean(end.half));
  const validHalves=labelled&&recorded.every(end=>end.half==='上半场'||end.half==='下半场')
    &&recorded.some(end=>end.half==='上半场')&&recorded.some(end=>end.half==='下半场');
  const split=Math.ceil(recorded.length/2);
  const firstEnds=validHalves?recorded.filter(end=>end.half==='上半场'):!labelled?recorded.slice(0,split):[];
  const lastEnds=validHalves?recorded.filter(end=>end.half==='下半场'):!labelled?recorded.slice(split):[];
  const canSplit=firstEnds.length>0&&lastEnds.length>0;
  const first=canSplit?summarize(firstEnds.flatMap(end=>end.arrows)):null;
  const last=canSplit?summarize(lastEnds.flatMap(end=>end.arrows)):null;
  const splitLabels:SessionInsight['splitLabels']=canSplit?validHalves
    ?{first:'上半场',last:'下半场',mode:'halves'}
    :{first:`前 ${firstEnds.length} 组`,last:`后 ${lastEnds.length} 组`,mode:'groups'}:null;
  const key=strictComparisonKey(session);
  const earlier=key&&session.status==='completed'?allSessions.filter(s=>s.id!==session.id&&s.status==='completed'&&s.started<session.started&&strictComparisonKey(s)===key).sort((a,b)=>b.started.localeCompare(a.started)).slice(0,4):[];
  const prior=earlier.length?summarize(earlier.flatMap(allArrows)):null;
  const comparison=prior?.average!==null&&prior?.average!==undefined&&summary.average!==null?{
    sessions:earlier.length,arrows:prior.arrows,average:prior.average,delta:summary.average-prior.average,sourceIds:earlier.map(s=>s.id)
  }:null;
  return {...summary,distribution,ends,first,last,splitLabels,comparison,comparisonUnavailable:comparison?null:key?'no-prior':'unknown-conditions',spatial:reliableCoordinates(session)};
}
