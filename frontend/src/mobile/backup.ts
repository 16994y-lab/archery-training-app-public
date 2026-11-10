import { copy, Data, initialData, LIMITS, Session, uid } from './domain';
import { validateData } from './store';

const collections = ['sessions', 'plans', 'targets', 'equipment', 'schedules', 'programs', 'goals', 'accessories'] as const;
export type BackupCollection = typeof collections[number];
type Entity = { id: string; name?: string; [key: string]: unknown };
type ExtendedData = Data & { accessories?: Entity[] };
export type BackupConflict = { collection: BackupCollection; id: string; name: string; kind: 'changed' | 'nested-id' | 'linked' };
export type BackupMergePlan = {
  conflicts: BackupConflict[];
  identical: { collection: BackupCollection; id: string; name: string }[];
  incomingCounts: Partial<Record<BackupCollection, number>>;
  warnings: string[];
};
export type BackupMergeReport = BackupMergePlan & {
  added: Partial<Record<BackupCollection, number>>;
  skipped: { collection: BackupCollection; id: string; reason: string }[];
  remapped: { collection: string; from: string; to: string }[];
};
const rows = (d: Data, key: BackupCollection): Entity[] => ((d as unknown as Record<string, unknown>)[key] ?? []) as Entity[];
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}';
  return JSON.stringify(value);
};
const title = (row: Entity) => typeof row.name === 'string' ? row.name : row.id;
function sizeCheck(value: string) { if (new TextEncoder().encode(value).length > LIMITS.bytes) throw new Error('备份超过 24 MB 容量保护；没有导入或截断任何记录。'); }
function checked(value: unknown): Data {
  const data = validateData(copy(value));
  const accessories = (data as ExtendedData).accessories;
  if (accessories !== undefined && (!Array.isArray(accessories) || accessories.some(a => !a || typeof a.id !== 'string' || !a.id) || new Set(accessories.map(a => a.id)).size !== accessories.length)) throw new Error('配件集合标识无效或重复');
  for (const s of data.sessions) {
    const ids = [...s.ends.map(e => e.id), ...s.rest.map(r => r.id), ...s.videoNotes.map(n => n.id)];
    if (ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) throw new Error('场次内分组、休息或视频备注标识无效或重复');
  }
  sizeCheck(JSON.stringify(data));
  return data;
}

/** Parsing is read-only. Callers must show the returned merge plan before applying it. */
export function inspectBackup(text: string): Data {
  sizeCheck(text);
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('备份不是完整的 JSON 文件，无法安全导入；请保留原文件并尝试另一份备份。'); }
  return checked(value);
}
function nestedIds(s: Session): string[] { return [...s.ends.flatMap(e => [e.id, ...e.arrows.map(a => a.id)]), ...s.rest.map(r => r.id), ...s.videoNotes.map(n => n.id)]; }
export function planBackupMerge(current: Data, incoming: Data): BackupMergePlan {
  checked(current); checked(incoming);
  const conflicts: BackupConflict[] = [], identical: BackupMergePlan['identical'] = [], incomingCounts: BackupMergePlan['incomingCounts'] = {};
  const occupied = new Set(current.sessions.flatMap(nestedIds));
  for (const key of collections) {
    incomingCounts[key] = rows(incoming, key).length;
    const existing = new Map(rows(current, key).map(r => [r.id, r]));
    for (const row of rows(incoming, key)) {
      const prior = existing.get(row.id);
      if (prior && canonical(prior) === canonical(row)) identical.push({ collection: key, id: row.id, name: title(row) });
      else if (prior) conflicts.push({ collection: key, id: row.id, name: title(row), kind: 'changed' });
      else if (key === 'sessions' && nestedIds(row as unknown as Session).some(id => occupied.has(id))) conflicts.push({ collection: key, id: row.id, name: title(row), kind: 'nested-id' });
    }
  }
  // Copy the calendar ownership of a copied execution. Historical plan,
  // target and equipment snapshots must never pull unchanged sessions into a
  // second import: doing so would duplicate completed scores.
  const changedSessions=new Set(conflicts.filter(c=>c.collection==='sessions').map(c=>c.id));
  const linkedSchedules=new Set(incoming.sessions.filter(s=>changedSessions.has(s.id)).map(s=>s.scheduleId).filter(Boolean));
  for(let i=identical.length-1;i>=0;i--){const item=identical[i];if(item.collection!=='schedules')continue;const row=incoming.schedules.find(a=>a.id===item.id)!;
    if(linkedSchedules.has(item.id)||(row.sessionId!==null&&changedSessions.has(row.sessionId))){identical.splice(i,1);conflicts.push({...item,kind:'linked'});}
  }
  return { conflicts, identical, incomingCounts, warnings: [
    '本机个人资料、连接设置与当前训练保持原值；导入的进行中训练保存为草稿。',
    '历史靶面、器材与计划快照保留原内容；照片和视频文件不在备份中。',
    ...(conflicts.some(c=>c.kind==='linked')?['有关联的冲突项目会一起保留本机或另存副本，避免日历与训练串联。']:[]),
  ] };
}

/** No persistence occurs here. Apply the returned data in one Repository mutation. */
export function mergeBackup(current: Data, incoming: Data, strategy: 'keep-existing' | 'copy-imported', makeId: () => string = uid): { data: Data; report: BackupMergeReport } {
  const plan = planBackupMerge(current, incoming);
  if (!['keep-existing', 'copy-imported'].includes(strategy)) throw new Error('请明确选择保留本机冲突项或复制导入');
  const data = copy(current), source = copy(incoming);
  const report: BackupMergeReport = { ...plan, added: {}, skipped: [], remapped: [] };
  const occupied = new Set<string>(collections.flatMap(k => [...rows(current, k), ...rows(incoming, k)].map(r => r.id)));
  current.sessions.concat(incoming.sessions).forEach(s => nestedIds(s).forEach(id => occupied.add(id)));
  current.plans.concat(incoming.plans).forEach(p => p.blocks.forEach(b => occupied.add(b.id)));
  current.sessions.concat(incoming.sessions).forEach(s => s.plan?.blocks.forEach(b => occupied.add(b.id)));
  const fresh = (collection: string, from: string) => {
    let to = ''; for (let tries = 0; tries < 100; tries++) { to = makeId(); if (typeof to === 'string' && to && !occupied.has(to)) break; to = ''; }
    if (!to) throw new Error('无法分配唯一导入标识，没有修改本机记录');
    occupied.add(to); report.remapped.push({ collection, from, to }); return to;
  };
  const maps = Object.fromEntries(collections.map(k => [k, new Map<string, string>()])) as Record<BackupCollection, Map<string, string>>;
  const identical = new Set(plan.identical.map(c => `${c.collection}:${c.id}`));
  const conflicts = new Map(plan.conflicts.map(c => [`${c.collection}:${c.id}`, c]));
  const imported = Object.fromEntries(collections.map(key => [key, rows(source, key).filter(row => {
    const k = `${key}:${row.id}`;
    if (identical.has(k)) { report.skipped.push({ collection: key, id: row.id, reason: '内容完全相同，已存在' }); return false; }
    if (conflicts.has(k) && strategy === 'keep-existing') { report.skipped.push({ collection: key, id: row.id, reason: '按选择保留本机冲突项，备份项未导入' }); return false; }
    maps[key].set(row.id, conflicts.has(k) ? fresh(key, row.id) : row.id); return true;
  })])) as Record<BackupCollection, Entity[]>;
  const ref = (key: BackupCollection, value: string | null) => value === null ? null : maps[key].get(value) ?? value;
  const conditions = (c: Data['sessions'][number]['conditions']) => {
    c.target.id = ref('targets', c.target.id)!;
    if (c.equipment) c.equipment.id = ref('equipment', c.equipment.id)!;
  };
  // Block identities are shared by a template and its execution snapshots. Keep that link,
  // but never replace snapshot content with the current template version.
  const blockMap = new Map<string, string>();
  const blockRef = (planId: string, blockId: string) => {
    if (ref('plans', planId) === planId) return blockId;
    const key = planId + ':' + blockId;
    if (!blockMap.has(key)) blockMap.set(key, fresh('blocks', blockId));
    return blockMap.get(key)!;
  };
  const planSnapshot = (p: Data['plans'][number]) => {
    const oldId = p.id; p.blocks.forEach(b => b.id = blockRef(oldId, b.id)); p.id = ref('plans', oldId)!; conditions(p.conditions);
  };
  const schedule = (a: Data['schedules'][number]) => { a.id = ref('schedules', a.id)!; a.planId = ref('plans', a.planId); a.programId = ref('programs', a.programId); a.sessionId = ref('sessions', a.sessionId); };
  for (const p of imported.plans as unknown as Data['plans']) planSnapshot(p);
  const nestedOccupied = new Set(current.sessions.flatMap(nestedIds));
  const nested = (kind: string, id: string) => { const next = nestedOccupied.has(id) ? fresh(kind, id) : id; nestedOccupied.add(next); return next; };
  for (const s of imported.sessions as unknown as Data['sessions']) {
    const originalPlanId = s.plan?.id;
    s.id = ref('sessions', s.id)!; conditions(s.conditions); s.scheduleId = ref('schedules', s.scheduleId);
    if (s.scheduleSnapshot) schedule(s.scheduleSnapshot);
    if (s.plan) planSnapshot(s.plan);
    for (const end of s.ends) { end.id = nested('ends', end.id); if (originalPlanId) end.blockId = blockRef(originalPlanId, end.blockId); end.arrows.forEach(a => a.id = nested('arrows', a.id)); }
    for (const rest of s.rest) { rest.id = nested('rests', rest.id); if (originalPlanId && rest.blockId) rest.blockId = blockRef(originalPlanId, rest.blockId); }
    s.videoNotes.forEach(n => n.id = nested('videoNotes', n.id));
    if (originalPlanId) s.skippedRests = s.skippedRests.map(id => blockRef(originalPlanId, id));
    if (s.status === 'active') { s.status = 'draft'; report.warnings.push(`“${s.name}”的进行中状态已改为草稿，可在导入后继续。`); }
  }
  for (const a of imported.schedules as unknown as Data['schedules']) schedule(a);
  for (const p of imported.programs as unknown as Data['programs']) { p.id = ref('programs', p.id)!; p.planId = ref('plans', p.planId); }
  for (const g of imported.goals as unknown as Data['goals']) { g.id = ref('goals', g.id)!; g.targetId = ref('targets', g.targetId); }
  for (const key of ['targets', 'equipment', 'accessories'] as const) for (const row of imported[key]) row.id = ref(key, row.id)!;
  for (const key of collections) {
    report.added[key] = imported[key].length;
    if (key !== 'accessories' || imported[key].length || (current as ExtendedData).accessories) (data as unknown as Record<string, unknown>)[key] = [...rows(data, key), ...imported[key]];
  }
  if (strategy === 'keep-existing' && plan.conflicts.length) report.warnings.push('保留本机冲突项后，导入日历与目标中的同名标识引用本机版本；执行历史仍使用备份自己的快照。');
  return { data: checked(data), report };
}

export type BackupRescueResult = { data: Data; recovered: Partial<Record<BackupCollection, number>>; skipped: { collection: string; index: number; id: string | null; reason: string }[]; warnings: string[] };
/** Salvage is explicit and item-by-item; a malformed session is never partially scored. */
export function rescueBackupSessions(text: string): BackupRescueResult {
  sizeCheck(text); let raw: Record<string, unknown>;
  try { raw = JSON.parse(text); } catch { throw new Error('文件不是完整 JSON，无法安全逐项恢复。请保留原文件，不会猜测残缺的箭数或成绩。'); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('缺少可检查的数据对象');
  if (raw.schema !== 1) throw new Error('备份数据版本未知，不能按当前规则猜测恢复；请保留原文件。');
  const result: BackupRescueResult = { data: initialData(), recovered: {}, skipped: [], warnings: ['这是逐项救援预览；原文件未修改。未通过校验的项目完整跳过，不补 M 或截断箭数。', '个人资料、服务连接和当前场次选择不自动恢复；恢复的进行中训练均为草稿。'] };
  const arrowIds = new Set<string>();
  for (const key of collections) {
    const list = raw[key];
    if (list === undefined && key === 'accessories') continue;
    if (!Array.isArray(list)) { result.skipped.push({ collection: key, index: -1, id: null, reason: '集合缺失或不是列表' }); continue; }
    result.recovered[key] = 0;
    const entityIds = new Set<string>();
    list.forEach((item, index) => {
      try {
        if (!item || typeof item !== 'object') throw new Error('项目不是有效对象');
        const probe = initialData(), entry = copy(item);
        if (entityIds.has(entry.id)) throw new Error('数据标识重复，保留先通过校验的项目');
        if (key === 'sessions' && entry.status === 'active') entry.status = 'draft';
        (probe as unknown as Record<string, unknown>)[key] = [entry];
        checked(probe);
        if (key === 'sessions') {
          if (result.data.sessions.length >= LIMITS.sessions) throw new Error('超过 5000 场容量，未截断或覆盖已恢复记录');
          const ids = (entry as Session).ends.flatMap(e => e.arrows.map(a => a.id));
          if (ids.some(id => arrowIds.has(id))) throw new Error('单箭标识与已恢复的场次重复');
          ids.forEach(id => arrowIds.add(id));
        }
        (result.data as unknown as Record<string, unknown>)[key] = [...rows(result.data, key), entry];
        entityIds.add(entry.id); result.recovered[key]!++;
      } catch (e) { result.skipped.push({ collection: key, index, id: typeof item?.id === 'string' ? item.id : null, reason: e instanceof Error ? e.message : '校验失败' }); }
    });
  }
  const links: { collection: BackupCollection; id: string | null; label: string }[] = [];
  for (const s of result.data.sessions) if (s.scheduleId) links.push({ collection: 'schedules', id: s.scheduleId, label: s.name + ' 的日历关联' });
  for (const a of result.data.schedules) { links.push({ collection: 'plans', id: a.planId, label: a.name + ' 的计划关联' }, { collection: 'programs', id: a.programId, label: a.name + ' 的长期安排关联' }, { collection: 'sessions', id: a.sessionId, label: a.name + ' 的完成记录关联' }); }
  for (const p of result.data.programs) links.push({ collection: 'plans', id: p.planId, label: p.name + ' 的计划关联' });
  links.filter(l => l.id && !rows(result.data, l.collection).some(r => r.id === l.id)).forEach(l => result.warnings.push(`${l.label}所引用的项目未恢复；保留原引用和历史快照供后续核对。`));
  checked(result.data);
  return result;
}
