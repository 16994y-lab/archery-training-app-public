// Shared, deterministic calculations for the local coach preview and its tests.
export const dimensions = [['bow','弓种'],['distance','距离'],['targetId','靶型'],['size','靶面尺寸'],['rulesVersion','计分规则']];
export function selectSessions(sessions, query = new URLSearchParams(), memberIds = null) {
  const q = query instanceof URLSearchParams ? query : new URLSearchParams(query);
  if(q.get('from') && q.get('to') && q.get('from') > q.get('to')) return [];
  return sessions.filter(s => (!memberIds || memberIds.includes(s.memberId))
    && dimensions.every(([key]) => !q.get(key) || String(s.conditions[key] ?? 'unknown') === q.get(key))
    && (!q.get('from') || s.date >= q.get('from')) && (!q.get('to') || s.date <= q.get('to')));
}
export function oneCondition(sessions) { return sessions.length > 0 && sessions.every(s => s.groupKey && s.groupKey === sessions[0].groupKey); }
export function summarize(sessions) {
  const value = { sessions:sessions.length, arrows:0, score:0, points:0, X:0, ten:0, M:0 };
  for(const s of sessions){value.arrows += s.summary.arrows;value.score += s.summary.total;value.points += s.summary.trustedPoints;
    value.X += s.summary.distribution.X || 0;value.ten += s.summary.distribution['10'] || 0;value.M += s.summary.distribution.M || 0;}
  return {...value, average:value.arrows ? value.score/value.arrows : null};
}
export function cohorts(sessions) {
  const map = new Map();
  for(const s of sessions) { const key=s.groupKey || `unknown:${s.memberId}:${s.id}`; if(!map.has(key))map.set(key,[]);map.get(key).push(s); }
  return [...map.values()];
}
export function dailyTrend(sessions) {
  const map=new Map();for(const s of sessions){if(!map.has(s.date))map.set(s.date,[]);map.get(s.date).push(s);}
  return [...map].sort(([a],[b])=>a.localeCompare(b)).map(([date,rows])=>({date,...summarize(rows)}));
}
export function reportRows(sessions, members) {
  return members.flatMap(m=>cohorts(sessions.filter(s=>s.memberId===m.id)).map(rows=>({member:m.label,conditions:rows[0].conditions,comparable:oneCondition(rows),...summarize(rows)})));
}
export function csvCell(value) {let s=String(value??'');if(/^[\s]*[=+@-]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';}
export function reportCsv(rows, {from='',to='',generatedAt=''}) {
  const header=['数据性质','开始日期','结束日期（含）','队员','弓种','距离m','靶型','尺寸cm','计分规则','场数','箭数','总分','箭均','X','普通10','M','可信落点','生成时间'];
  return '\uFEFF'+[header,...rows.map(r=>['本地模拟数据',from,to,r.member,r.conditions.bow,r.conditions.distance,r.conditions.targetName,r.conditions.size,r.conditions.rulesVersion,r.sessions,r.arrows,r.score,r.comparable?r.average?.toFixed(4):'',r.X,r.ten,r.M,r.points,generatedAt])].map(row=>row.map(csvCell).join(',')).join('\r\n');
}
export const teamKinds = {mixed:'混合团体（1 男＋1 女）',men:'男子团体（3 人）',women:'女子团体（3 人）'};
export const presets = {
  'wa-recurve':{name:'WA 户外反曲弓 · 成年 / U21 团体淘汰赛',bow:'反曲弓',distance:70,size:122,targetId:'mobile-full',targetName:'122cm 十环靶',ends:4,arrowsPerAthlete:2,scoring:'set',rulesVersion:'target-contract/v1'},
  'wa-compound':{name:'WA 户外复合弓 · 团体淘汰赛',bow:'复合弓',distance:50,size:80,targetId:'mobile-five',targetName:'80cm 六环靶（5–10）',ends:4,arrowsPerAthlete:2,scoring:'cumulative',rulesVersion:'target-contract/v1'}
};
export function validateRoster(kind, ids, members) {
  const n=kind==='mixed'?2:3;
  if(!Object.hasOwn(teamKinds,kind)||!Array.isArray(ids)||ids.length!==n||new Set(ids).size!==n)return `请选择 ${n} 名不同队员`;
  const selected=ids.map(id=>members.find(m=>m.id===id));
  if(selected.some(m=>!m||m.status==='inactive'||!['men','women'].includes(m.category)))return '队员须属于当前团队，且已明确参赛类别';
  if(kind==='mixed'&&!(selected.filter(m=>m.category==='men').length===1&&selected.filter(m=>m.category==='women').length===1))return '混合团体需要 1 名男子队员和 1 名女子队员';
  if(kind!=='mixed'&&selected.some(m=>m.category!==kind))return '所选队员的参赛类别与分组不符';
  return null;
}
export function trainingRules(kind,config){const count=kind==='mixed'?2:3;return {athletes:count,arrowsPerEnd:count*config.arrowsPerAthlete,totalArrows:count*config.arrowsPerAthlete*config.ends,seconds:kind==='mixed'?80:120,shootOffSeconds:kind==='mixed'?40:60};}
