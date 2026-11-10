import { scoreFromTargetCoordinates } from '../scoring';
import { resolveTargetContract, validateTargetContract } from '../target-contract';
import type { TargetContract, ScoreCode } from '../target-contract';
import {nextUnnamedSessionName} from './session-label';

export type Target = TargetContract & { sizeRatio: number; custom?: boolean };
export type Equipment = { id: string; name: string; bow: string; riser: string; limbs: string; arrows: string; sight: string; stabilizer: string; string: string; tab: string; other: string; favorite: boolean };
export type Conditions = { target: Target; size: number | null; distance: number; bow: string; equipment: Equipment | null };
export type Block = { id: string; kind: 'score' | 'rest'; label: string; ends: number; arrows: number; minutes: number; half: '' | '上半场' | '下半场' };
export type Plan = { id: string; name: string; note: string; conditions: Conditions; blocks: Block[]; archived: boolean; updated: string };
export type Arrow = { id: string; code: string; x: number | null; y: number | null; face: number; source: 'number' | 'target' | 'photo'; enteredAt: string; note?: string; coordinateEvidence?: 'manual-target-confirmed' };
export type End = { id: string; blockId: string; half: Block['half']; capacity: number; arrows: Arrow[]; confirmed: boolean; note?: string };
export type Accessory = { id: string; category: string; name: string; note: string; favorite: boolean };
export type Rest = { id: string; blockId: string | null; started: string; ended: string | null; minutes: number | null; timer: boolean };
export type Session = { id: string; name: string; date: string; started: string; ended: string | null; status: 'active' | 'draft' | 'completed' | 'discarded'; conditions: Conditions; plan: Plan | null; scheduleId: string | null; scheduleSnapshot: Schedule | null; ends: End[]; currentEnd: number; blockIndex: number; blockEnd: number; rest: Rest[]; skippedRests: string[]; note: string; energy: number | null; fatigue: number | null; videoNotes: { id: string; time: number; note: string }[]; revision: number; halfBoundary?: number|null };
export type Schedule = { id: string; date: string; planId: string | null; name: string; arrows: number; programId: string | null; sessionId: string | null };
export type Program = { id: string; name: string; start: string; end: string; perWeek: number; weekdays: number[]; arrowsPerWeek: number; planId: string | null; note: string };
export type Goal = { id: string; name: string; type: 'arrows' | 'sessions' | 'average'; value: number; start: string; end: string; distance: number | null; targetId: string | null };
export type Data = { schema: 1; revision: number; activeId: string | null; sessions: Session[]; plans: Plan[]; targets: Target[]; equipment: Equipment[]; accessories?: Accessory[]; schedules: Schedule[]; programs: Program[]; goals: Goal[]; profile: { name: string; avatar?: string; bow: string; hand: string; experience: string; competition: string }; connection: { api: string; auth: string; publicKey: string }; updated: string };
export const LIMITS = { arrowsPerEnd: 300, ends: 500, sessionArrows: 30000, blocks: 200, sessions: 5000, bytes: 24 * 1024 * 1024 };
export const uid = () => {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes=crypto.getRandomValues(new Uint8Array(16));bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;
  const h=Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
};
export const now = () => new Date().toISOString();
export const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
export const localDate = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
export const initialData = (): Data => ({ schema: 1, revision: 0, activeId: null, sessions: [], plans: [], targets: [], equipment: [], schedules: [], programs: [], goals: [], profile: { name: '', avatar: 'initial', bow: '反曲弓', hand: '', experience: '', competition: '' }, connection: { api: '', auth: '', publicKey: '' }, updated: now() });
export function positive(value: number, label: string, max = 100000) { if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`${label}须为 1–${max} 的整数；不会删除或截断已有记录。`); return value; }
export const scoreValue = (code: string) => code === 'X' ? 10 : code === 'M' ? 0 : Number(code);
export const allArrows = (s: Session) => s.ends.flatMap(e => e.arrows);
export const plannedArrows = (p: Plan | null) => p?.blocks.reduce((n,b) => n + (b.kind === 'score' ? b.ends*b.arrows : 0),0) ?? null;

const makeTarget = (id: string, name: string, mode: 'full' | 'six' | 'five', layout: 'single' | 'vertical' | 'triangle', x: boolean, compound = false): Target => {
  const t = copy(resolveTargetContract(mode === 'full' ? 'WA_10_RING' : 'WA_VERTICAL_3_SPOT'));
  t.id=id; t.name=name; t.rules_version='target-contract/v1'; t.target_type='WA_CONCENTRIC';
  const min = mode === 'full' ? 1 : mode === 'five' ? 5 : 6, count = 11-min;
  t.ring_rules = Array.from({length:count},(_,i) => ({score_code:String(10-i) as ScoreCode as '10',label:String(10-i),color:10-i>=9?'#f5cf36':10-i>=7?'#e34747':10-i>=5?'#299ed2':10-i>=3?'#202329':'#ffffff',outer_radius_norm:(i+1)/count*.5}));
  if(compound)t.ring_rules[0].outer_radius_norm *= .5;
  if(x)t.ring_rules.unshift({...t.ring_rules[0],score_code:'X',label:'X',outer_radius_norm:t.ring_rules[0].outer_radius_norm/2});
  t.allowed_score_codes=[...t.ring_rules.map(r=>r.score_code),'M'];
  t.face_count=layout==='single'?1:3;
  t.layout={kind:layout.toUpperCase(),face_count:t.face_count,faces:layout==='single'?[{index:1,anchor_x:.5,anchor_y:.5}]:layout==='vertical'?[{index:1,anchor_x:.5,anchor_y:.17},{index:2,anchor_x:.5,anchor_y:.5},{index:3,anchor_x:.5,anchor_y:.83}]:[{index:1,anchor_x:.25,anchor_y:.73},{index:2,anchor_x:.5,anchor_y:.24},{index:3,anchor_x:.75,anchor_y:.73}]};
  t.plot!.calibration_boundary_score_code=String(min);
  return {...validateTargetContract(t),sizeRatio:count/10};
};
export const builtTargets: Target[] = [
  makeTarget('mobile-full','十环靶 · X / 10–1','full','single',true),
  makeTarget('mobile-six','6–10 环单靶 · 反曲','six','single',false),
  makeTarget('mobile-five','5–10 环单靶 · X','five','single',true),
  makeTarget('mobile-vertical-r','竖向三联 · 反曲 6–10','six','vertical',false),
  makeTarget('mobile-triangle-r','三角三联 · 反曲 6–10','six','triangle',false),
  makeTarget('mobile-vertical-c','竖向三联 · 复合内十环','six','vertical',false,true),
  makeTarget('mobile-triangle-c','三角三联 · 复合内十环','six','triangle',false,true),
  makeTarget('mobile-six-x','6–10 环训练靶 · X','six','single',true),
];
export const defaultConditions = (): Conditions => ({target:copy(builtTargets[0]),size:null,distance:18,bow:'反曲弓',equipment:null});
export const scoreBlock = (): Block => ({id:uid(),kind:'score',label:'计分段',ends:6,arrows:6,minutes:10,half:''});
export const newPlan = (): Plan => ({id:uid(),name:'我的训练计划',note:'',conditions:defaultConditions(),blocks:[scoreBlock()],archived:false,updated:now()});
export function competitionPlan(): Plan { const p=newPlan(); p.name='72 箭计分模拟'; p.blocks=[{...scoreBlock(),half:'上半场',label:'上半场'}, {...scoreBlock(),kind:'rest',label:'中场休息',minutes:10}, {...scoreBlock(),half:'下半场',label:'下半场'}]; return p; }
export const unexecutedGroups = (s:Session) => s.plan?.blocks.reduce((n,b)=>n+(b.kind==='score'?Math.max(0,b.ends-s.ends.filter(e=>e.blockId===b.id&&e.arrows.length>0).length):0),0)??null;
export const sessionPlannedArrows = (s: Session) => s.scheduleSnapshot?.arrows ?? plannedArrows(s.plan);
export function validateConditions(c: Conditions) {
  validateTargetContract(c.target); if(!(Number.isFinite(c.target.sizeRatio)&&c.target.sizeRatio>0&&c.target.sizeRatio<=1)) throw new Error('靶面尺寸比例无效');
  if(typeof c.bow!=='string'||typeof c.target.name!=='string'||c.target.ring_rules?.some(r=>!/^#[0-9a-f]{6}$/i.test(r.color))||c.target.layout?.faces.some(f=>!Number.isFinite(f.anchor_x)||!Number.isFinite(f.anchor_y)||f.anchor_x<0||f.anchor_x>1||f.anchor_y<0||f.anchor_y>1))throw new Error('靶面颜色、布局或弓种无效');
  if(!Number.isFinite(c.distance)||c.distance<=0||c.distance>1000)throw new Error('距离须在 0–1000 米之间且大于 0');
  if(c.size!==null&&(!Number.isFinite(c.size)||c.size<=0||c.size>1000))throw new Error('尺寸须大于 0；不知道时选择未知');
}
export function validatePlan(p: Plan) {
  validateConditions(p.conditions); if(!p.name.trim())throw new Error('填写计划名称');
  if(!p.blocks.some(b=>b.kind==='score')||p.blocks.length>LIMITS.blocks)throw new Error(`至少一个计分段，最多 ${LIMITS.blocks} 个区块`);
  if(new Set(p.blocks.map(b=>b.id)).size!==p.blocks.length||p.blocks.some(b=>!['score','rest'].includes(b.kind)||!['','上半场','下半场'].includes(b.half)||typeof b.label!=='string'))throw new Error('编排标识、区块或半场无效');
  let ends=0,arrows=0;
  for(const b of p.blocks) { if(b.kind==='score') {positive(b.ends,'组数',LIMITS.ends);positive(b.arrows,'每组箭数',LIMITS.arrowsPerEnd);ends+=b.ends;arrows+=b.ends*b.arrows;} else if(!Number.isFinite(b.minutes)||b.minutes<0||b.minutes>1440)throw new Error('休息时长须为 0–1440 分钟'); }
  if(ends>LIMITS.ends||arrows>LIMITS.sessionArrows)throw new Error(`单场最多 ${LIMITS.ends} 组、${LIMITS.sessionArrows} 箭；请拆分场次。`);
}
export function startSession(data: Data, c: Conditions, arrows: number, plan: Plan|null, disposition: 'keep'|'discard', scheduleId: string|null = null): Session {
  validateConditions(c);positive(arrows,'每组箭数',LIMITS.arrowsPerEnd);if(plan)validatePlan(plan);
  if(data.sessions.length>=LIMITS.sessions)throw new Error('已达 5000 场容量保护，请先导出备份；未删除任何记录。');
  const old=data.sessions.find(s=>s.id===data.activeId); if(old)old.status=disposition==='keep'?'draft':'discarded';
  const started=now();
  const s: Session={id:uid(),name:nextUnnamedSessionName(data.sessions),date:localDate(new Date(started)),started,ended:null,status:'active',conditions:copy(c),plan:plan?copy(plan):null,scheduleId,scheduleSnapshot:copy(data.schedules.find(a=>a.id===scheduleId)??null),ends:[],currentEnd:0,blockIndex:0,blockEnd:0,rest:[],skippedRests:[],note:'',energy:null,fatigue:null,videoNotes:[],revision:1};
  if(!plan||plan.blocks[0].kind==='score')s.ends.push(createEnd(plan?.blocks[0],arrows));
  data.sessions.push(s);data.activeId=s.id; return s;
}
export function createEnd(b: Block|undefined, capacity=6): End {return {id:uid(),blockId:b?.id??'free',half:b?.half??'',capacity:b?.arrows??capacity,arrows:[],confirmed:false};}
export function currentBlock(s: Session) {return s.plan?.blocks[s.blockIndex];}
export function addArrow(s: Session, code: string, face: number, selected: string|null, point?: {x:number;y:number}, source: Arrow['source']='number') {
  const end=s.ends[s.currentEnd]; if(!end)throw new Error('先完成或跳过当前休息');
  if(!s.conditions.target.allowed_score_codes.includes(code))throw new Error('该分值不属于本场靶面规则');
  if(!Number.isInteger(face)||face<1||face>s.conditions.target.face_count)throw new Error('请先选择靶位');
  if(point) {if(!Number.isFinite(point.x)||!Number.isFinite(point.y)||Math.abs(point.x)>1.2+1e-9||Math.abs(point.y)>1.2+1e-9)throw new Error('落点超出白区');if(scoreAt(s.conditions.target,point.x,point.y)!==code)throw new Error('分值与坐标不一致');}
  const index=selected?end.arrows.findIndex(a=>a.id===selected):-1;
  if(selected&&index<0)throw new Error('选中的箭已变化，请重新选择');
  if(index<0&&end.confirmed)throw new Error('已确认组只能修改已录箭');
  if(index<0&&end.arrows.length>=end.capacity)throw new Error('本组已满，可增加本组箭数后继续录入');
  if(index<0&&allArrows(s).length>=LIMITS.sessionArrows)throw new Error('达到单场箭量保护，请结束并另开一场');
  const a: Arrow={id:index>=0?end.arrows[index].id:uid(),code,x:point?.x??null,y:point?.y??null,face,source,enteredAt:index>=0?end.arrows[index].enteredAt:now()};
  if(index>=0){if(end.arrows[index].note!==undefined)a.note=end.arrows[index].note;end.arrows[index]=a;}else end.arrows.push(a);s.revision++;
}
export const scoreAt = (target: Target,x:number,y:number) => scoreFromTargetCoordinates(target,.5+x/2,.5-y/2);
/** Only a deliberate target-pane tap may call this for a photo candidate. */
export function confirmedPhotoTargetPoint(target:Target,code:string,point:{x:number;y:number}){
  if(!Number.isFinite(point.x)||!Number.isFinite(point.y)||Math.abs(point.x)>1.2||Math.abs(point.y)>1.2)throw new Error('请在靶纸白边以内标记位置');
  const actual=scoreAt(target,point.x,point.y);
  if(actual!==code)throw new Error(`该位置按本场靶型为 ${actual}，当前候选为 ${code}；请调整位置或先更正环值`);
  return {x:point.x,y:point.y};
}
export function resizeEnd(s: Session,n:number) {positive(n,'本组箭数',LIMITS.arrowsPerEnd);const e=s.ends[s.currentEnd];if(n<e.arrows.length)throw new Error(`已有 ${e.arrows.length} 箭，不能缩减至 ${n}，成绩已保留。`);e.capacity=n;s.revision++;}
/** Apply only the user's explicit decision for unrecorded positions, in the same save transaction. */
export function resolveMissingArrows(s:Session,expectedEndId:string,expectedCount:number,expectedCapacity:number,mode:'M'|'skip',face:number){
  const e=s.ends[s.currentEnd];
  if(s.status!=='active'||!e||e.id!==expectedEndId||e.confirmed||e.arrows.length!==expectedCount||e.capacity!==expectedCapacity)
    throw new Error('本组成绩或箭数已变化，请重新核对缺失箭；未保存。');
  if(mode!=='M'&&mode!=='skip')throw new Error('请选择缺失箭如何记录。');
  const missing=e.capacity-e.arrows.length;
  if(missing<0)throw new Error('本组箭数超出容量，未保存。');
  if(mode==='M'){
    if(allArrows(s).length+missing>LIMITS.sessionArrows)throw new Error('补记 M 后会超过本场箭量保护，未保存。');
    for(let i=0;i<missing;i++)addArrow(s,'M',face,null,undefined,'number');
  }
  return missing;
}
/** Correct a previously saved short group only after the user confirms the missing arrows were misses. */
export function appendConfirmedMisses(s:Session,index:number,expectedEndId:string,expectedCount:number,expectedCapacity:number,expectedRevision:number,face:number){
  const e=s.ends[index];
  if(!['active','draft','completed'].includes(s.status)||s.revision!==expectedRevision||!e||e.id!==expectedEndId||!e.confirmed||e.arrows.length!==expectedCount||e.capacity!==expectedCapacity)
    throw new Error('已保存组或场次已变化，请重新核对；未补记 M。');
  const missing=e.capacity-e.arrows.length;
  if(missing<=0||e.arrows.length===0)throw new Error('本组没有可补记的缺失箭。');
  if(!s.conditions.target.allowed_score_codes.includes('M'))throw new Error('该靶面不支持 M。');
  if(!Number.isInteger(face)||face<1||face>s.conditions.target.face_count)throw new Error('请先选择靶位。');
  if(allArrows(s).length+missing>LIMITS.sessionArrows)throw new Error('补记 M 后会超过本场箭量保护；原成绩保持不变。');
  for(let i=0;i<missing;i++)e.arrows.push({id:uid(),code:'M',x:null,y:null,face,source:'number',enteredAt:now()});
  s.revision++;
  return missing;
}
export function confirmEnd(s: Session) {const e=s.ends[s.currentEnd];if(!e?.arrows.length)throw new Error('空组不能确认，空位不会算 M');e.confirmed=true;s.revision++;}
export function advance(s: Session) {
  const b=currentBlock(s),e=s.ends[s.currentEnd];
  if(b?.kind==='rest') {const r=s.rest.find(r=>r.blockId===b.id&&!r.ended);if(r)r.ended=now();else s.skippedRests.push(b.id);s.blockIndex++;s.blockEnd=0;}
  else {if(!e?.confirmed)throw new Error('请先确认本组');if(s.plan){s.blockEnd++;if(s.blockEnd>=b!.ends){s.blockIndex++;s.blockEnd=0;}}}
  const next=currentBlock(s);
  if(s.plan&&!next)return;
  if(next?.kind==='rest')return;
  if(s.ends.length>=LIMITS.ends)throw new Error('达到 500 组容量保护，请结束本场');
  const created=createEnd(next,e?.capacity);if(!s.plan&&s.halfBoundary!=null)created.half=s.ends.length<s.halfBoundary?'上半场':'下半场';s.ends.push(created);s.currentEnd=s.ends.length-1;s.revision++;
}
export function setTemporaryHalves(s:Session,boundary:number|null) {if(s.plan)throw new Error('计划场次沿用执行快照中的半场编排');if(boundary!==null)positive(boundary,'上半场组数',LIMITS.ends);s.halfBoundary=boundary;s.ends.forEach((e,i)=>{e.half=boundary===null?'':i<boundary?'上半场':'下半场';});s.revision++;}
export function beginRest(s: Session, minutes:number|null,timer:boolean) {if(s.rest.some(r=>!r.ended))throw new Error('当前休息尚未结束');s.rest.push({id:uid(),blockId:currentBlock(s)?.kind==='rest'?currentBlock(s)!.id:null,started:now(),ended:null,minutes,timer});s.revision++;}
export function finishSession(data: Data,s:Session) {if(!allArrows(s).length)throw new Error('还没有成绩，可保留草稿或放弃');s.ends.forEach(e=>{if(e.arrows.length)e.confirmed=true;});s.rest.filter(r=>!r.ended).forEach(r=>r.ended=now());s.status='completed';s.ended=now();s.revision++;if(data.activeId===s.id)data.activeId=null;const schedule=data.schedules.find(a=>a.id===s.scheduleId);if(schedule)schedule.sessionId=s.id;}
/** Explicitly abandon only this session. Scores stay in the backup data, but never enter history/statistics. */
export function discardSession(data:Data,s:Session){
 if(!['active','draft'].includes(s.status))throw new Error('本轮训练状态已变化，未重复放弃');
 s.rest.filter(r=>!r.ended).forEach(r=>r.ended=now());s.status='discarded';s.ended=now();s.revision++;
 if(data.activeId===s.id)data.activeId=null;
 const schedule=data.schedules.find(a=>a.sessionId===s.id);if(schedule)schedule.sessionId=null;
}
export function resumeSession(data:Data,id:string,disposition:'keep'|'discard') {const s=data.sessions.find(s=>s.id===id);if(!s||!['active','draft'].includes(s.status))throw new Error('草稿不可用');const old=data.sessions.find(s=>s.id===data.activeId);if(old&&old.id!==id)old.status=disposition==='keep'?'draft':'discarded';s.status='active';data.activeId=id;}
export function isTap(start:{x:number;y:number;time:number},end:{x:number;y:number;time:number},moved:boolean) {return !moved&&Math.hypot(start.x-end.x,start.y-end.y)<=9&&end.time-start.time<650;}
export function customTarget(name:string,rows:{score:number;radius:number;color:string}[],xRadius:number|null):Target {
  if(!name.trim())throw new Error('填写靶面名称');if(!rows.length||rows.length>10)throw new Error('可配置 1–10 个环带');
  let previous=0,lastScore=11;
  const rings=rows.map(r=>{positive(r.score,'分值',10);if(!Number.isFinite(r.radius)||r.score>=lastScore||r.radius<=previous||r.radius>100||!/^#[0-9a-f]{6}$/i.test(r.color))throw new Error('由内向外半径递增至100%，分值递减，颜色须有效');previous=r.radius;lastScore=r.score;return {score_code:String(r.score) as '10',label:String(r.score),color:r.color,outer_radius_norm:r.radius/200};});
  if(previous!==100)throw new Error('最外环半径须为100%');
  if(xRadius!==null){if(rows[0].score!==10||xRadius<=0||xRadius>=rows[0].radius)throw new Error('X 须位于10环内');rings.unshift({score_code:'X' as '10',label:'X',color:rows[0].color,outer_radius_norm:xRadius/200});}
  const t=copy(builtTargets[0]);t.id=uid();t.name=name;t.custom=true;t.ring_rules=rings;t.allowed_score_codes=[...rings.map(r=>r.score_code),'M'];t.plot!.calibration_boundary_score_code=String(rows[rows.length-1].score);return {...validateTargetContract(t),sizeRatio:1,custom:true};
}
