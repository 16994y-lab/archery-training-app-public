/** Explicit, score-only projection. This module never sends a network request. */
import { LIMITS, scoreAt, validateConditions } from './domain';
import type { Arrow, Data, Session, Target } from './domain';
import { validateTargetContract } from '../target-contract';

export const SCORE_BACKUP_SCHEMA = 'score-backup/v1' as const;
export const SCORE_BACKUP_MAX_BYTES = 2 * 1024 * 1024;

export type ScoreBackupArrow = Pick<Arrow, 'id' | 'code' | 'x' | 'y' | 'face' | 'source' | 'enteredAt' | 'coordinateEvidence'>;
export type ScoreBackupEnd = { id: string; half: '' | '上半场' | '下半场'; capacity: number; arrows: ScoreBackupArrow[] };
export type ScoreBackupSession = {
  id: string; date: string; started: string; ended: string; status: 'completed'; revision: number;
  target: Target; size: number | null; distance: number; ends: ScoreBackupEnd[];
};
export type ScoreBackupDocument = { schema: typeof SCORE_BACKUP_SCHEMA; sessions: ScoreBackupSession[] };
export type ScoreBackupResponse = { revision: number; document: ScoreBackupDocument | null; updatedAt: string | null };

const obj = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}格式无效`);
  return value as Record<string, unknown>;
};
const exact = (value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []) => {
  const allowed = new Set([...required, ...optional]);
  if (required.some(key => !Object.prototype.hasOwnProperty.call(value, key)) || Object.keys(value).some(key => !allowed.has(key))) {
    throw new Error('成绩备份包含缺失或不允许的字段');
  }
};
const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 160;
const finite = (value: unknown, low: number, high: number): value is number => typeof value === 'number' && Number.isFinite(value) && value >= low && value <= high;
const integer = (value: unknown, low: number, high: number): value is number => Number.isInteger(value) && finite(value, low, high);
const time = (value: unknown): value is string => typeof value === 'string' && value.length <= 100 && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && !Number.isNaN(Date.parse(value));
const date = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!parts) return false;
  const year = Number(parts[1]), month = Number(parts[2]), day = Number(parts[3]);
  const parsed = new Date(0);
  parsed.setUTCFullYear(year, month - 1, day);
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() + 1 === month && parsed.getUTCDate() === day;
};
const fail = (message: string): never => { throw new Error(message); };

function projectTarget(t: Target): Target {
  validateConditions({ target: t, size: null, distance: 1, bow: '', equipment: null });
  if (t.scoring_mode !== 'RING_GEOMETRY' || !t.ring_rules || !t.layout || !t.plot || !t.rules_version || !t.coordinate_space || !t.boundary_policy) {
    throw new Error('该靶面尚不支持成绩备份');
  }
  return {
    id: t.id, name: t.name, target_type: t.target_type, scoring_mode: t.scoring_mode,
    face_count: t.face_count, sizeRatio: t.sizeRatio, rules_version: t.rules_version,
    allowed_score_codes: [...t.allowed_score_codes], coordinate_space: t.coordinate_space,
    boundary_policy: t.boundary_policy,
    ring_rules: t.ring_rules.map(r => ({ score_code: r.score_code, label: r.label, color: r.color, outer_radius_norm: r.outer_radius_norm })),
    layout: { kind: t.layout.kind, face_count: t.layout.face_count, faces: t.layout.faces.map(f => ({ index: f.index, anchor_x: f.anchor_x, anchor_y: f.anchor_y })) },
    plot: { coordinate_space: t.plot.coordinate_space, center_x: t.plot.center_x, center_y: t.plot.center_y, outer_scoring_radius_norm: t.plot.outer_scoring_radius_norm, calibration_boundary_score_code: t.plot.calibration_boundary_score_code, control_order: [...t.plot.control_order] },
    ...(t.scoring_profile !== undefined ? { scoring_profile: t.scoring_profile } : {}),
    ...(t.nominal_face_diameter_cm !== undefined ? { nominal_face_diameter_cm: t.nominal_face_diameter_cm } : {}),
    ...(t.scoring_diameter_cm !== undefined ? { scoring_diameter_cm: t.scoring_diameter_cm } : {}),
    ...(t.custom !== undefined ? { custom: t.custom } : {}),
  };
}

function projectSession(s: Session): ScoreBackupSession {
  if (s.status !== 'completed' || !s.ended) throw new Error('仅可选择已完成的训练成绩');
  validateConditions(s.conditions);
  const ends = s.ends.filter(end => end.arrows.length > 0).map(end => {
    if (!end.confirmed) throw new Error('本组成绩尚未确认');
    return {
      id: end.id, half: end.half, capacity: end.capacity,
      arrows: end.arrows.map(arrow => ({
        id: arrow.id, code: arrow.code, x: arrow.x, y: arrow.y, face: arrow.face,
        source: arrow.source, enteredAt: arrow.enteredAt,
        ...(arrow.coordinateEvidence === undefined ? {} : { coordinateEvidence: arrow.coordinateEvidence }),
      })),
    };
  });
  if (!ends.length) throw new Error('该场训练没有成绩');
  return {
    id: s.id, date: s.date, started: s.started, ended: s.ended, status: 'completed', revision: s.revision,
    target: projectTarget(s.conditions.target), size: s.conditions.size, distance: s.conditions.distance, ends,
  };
}

/** The caller must first show the selection and ask for the user's upload action. */
export function selectedScoreBackup(data: Pick<Data, 'sessions'>, selectedIds: readonly string[]): ScoreBackupDocument {
  if (!selectedIds.length || new Set(selectedIds).size !== selectedIds.length) throw new Error('请明确选择至少一场不同的已完成训练');
  const byId = new Map(data.sessions.map(session => [session.id, session]));
  const sessions = selectedIds.map(id => {
    const session = byId.get(id);
    if (!session) throw new Error('所选训练已变化，请重新选择');
    return projectSession(session);
  });
  return validateScoreBackupDocument({ schema: SCORE_BACKUP_SCHEMA, sessions });
}

function validateTarget(value: unknown): Target {
  const t = obj(value, '靶型');
  exact(t, ['id', 'name', 'target_type', 'scoring_mode', 'face_count', 'sizeRatio', 'rules_version', 'allowed_score_codes', 'coordinate_space', 'boundary_policy', 'ring_rules', 'layout', 'plot'], ['scoring_profile', 'nominal_face_diameter_cm', 'scoring_diameter_cm', 'custom']);
  if (!identifier(t.id) || typeof t.name !== 'string' || !t.name.trim() || t.name.length > 10000 || t.scoring_mode !== 'RING_GEOMETRY' || !finite(t.sizeRatio, 0, 1) || t.sizeRatio === 0) fail('靶面快照无效');
  if (t.custom !== undefined && typeof t.custom !== 'boolean') fail('靶面快照无效');
  for (const key of ['nominal_face_diameter_cm', 'scoring_diameter_cm']) if (t[key] !== undefined && t[key] !== null && !finite(t[key], 0, 1000)) fail('靶面直径无效');
  if (t.scoring_profile !== undefined && typeof t.scoring_profile !== 'string') fail('计分规则名称无效');
  const rings = t.ring_rules;
  if (!Array.isArray(rings)) throw new Error('靶面环带无效');
  if (!Array.isArray(t.allowed_score_codes)) fail('靶面环带无效');
  for (const ring of rings) exact(obj(ring, '环带'), ['score_code', 'label', 'color', 'outer_radius_norm']);
  const layout = obj(t.layout, '布局');
  exact(layout, ['kind', 'face_count', 'faces']);
  const faces = layout.faces;
  if (!Array.isArray(faces)) throw new Error('靶面布局无效');
  for (const face of faces) {
    const f = obj(face, '靶位'); exact(f, ['index', 'anchor_x', 'anchor_y']);
    if (!finite(f.anchor_x, 0, 1) || !finite(f.anchor_y, 0, 1)) fail('靶位坐标无效');
  }
  const plot = obj(t.plot, '画布');
  exact(plot, ['coordinate_space', 'center_x', 'center_y', 'outer_scoring_radius_norm', 'calibration_boundary_score_code', 'control_order']);
  if (!finite(plot.center_x, 0, 1) || !finite(plot.center_y, 0, 1) || !Array.isArray(plot.control_order) || plot.control_order.join() !== 'TOP,RIGHT,BOTTOM,LEFT') fail('画布规则无效');
  const target = t as Target;
  validateTargetContract(target);
  validateConditions({ target, size: null, distance: 1, bow: '', equipment: null });
  return target;
}

/** Parse downloaded data before preview or merge; rejects extra profile/media fields. */
export function validateScoreBackupDocument(value: unknown): ScoreBackupDocument {
  const doc = obj(value, '成绩备份');
  exact(doc, ['schema', 'sessions']);
  const sessions = doc.sessions;
  if (!Array.isArray(sessions)) throw new Error('成绩备份版本或场次数无效');
  if (doc.schema !== SCORE_BACKUP_SCHEMA || sessions.length < 1 || sessions.length > 5000) fail('成绩备份版本或场次数无效');
  const encoded = new TextEncoder().encode(JSON.stringify(doc));
  if (encoded.length > SCORE_BACKUP_MAX_BYTES) fail('成绩备份超过 2 MiB；未保存');
  const sessionIds = new Set<string>();
  const arrowIds = new Set<string>();
  for (const rawSession of sessions) {
    const session = obj(rawSession, '场次');
    exact(session, ['id', 'date', 'started', 'ended', 'status', 'revision', 'target', 'size', 'distance', 'ends']);
    const sessionId = session.id;
    if (!identifier(sessionId)) throw new Error('场次标识无效');
    if (sessionIds.has(sessionId) || !date(session.date) || !time(session.started) || !time(session.ended) || session.status !== 'completed' || !integer(session.revision, 1, Number.MAX_SAFE_INTEGER) || !finite(session.distance, Number.EPSILON, 1000) || (session.size !== null && !finite(session.size, Number.EPSILON, 1000))) fail('场次成绩无效');
    sessionIds.add(sessionId);
    const target = validateTarget(session.target);
    const ends = session.ends;
    if (!Array.isArray(ends)) throw new Error('分组成绩无效');
    if (ends.length < 1 || ends.length > 500) fail('分组成绩无效');
    const endIds = new Set<string>();
    let arrowCount = 0;
    for (const rawEnd of ends) {
      const end = obj(rawEnd, '分组'); exact(end, ['id', 'half', 'capacity', 'arrows']);
      const endId = end.id;
      const arrows = end.arrows;
      if (!identifier(endId)) throw new Error('分组标识无效');
      if (!Array.isArray(arrows)) throw new Error('分组成绩无效');
      if (endIds.has(endId) || !['', '上半场', '下半场'].includes(end.half as string) || !integer(end.capacity, 1, 300) || arrows.length < 1 || arrows.length > end.capacity) fail('分组成绩无效');
      endIds.add(endId);
      for (const rawArrow of arrows) {
        const arrow = obj(rawArrow, '单箭');
        exact(arrow, ['id', 'code', 'x', 'y', 'face', 'source', 'enteredAt'], ['coordinateEvidence']);
        const arrowId = arrow.id;
        if (!identifier(arrowId)) throw new Error('单箭标识无效');
        if (arrowIds.has(arrowId) || !target.allowed_score_codes.includes(arrow.code as string) || !integer(arrow.face, 1, target.face_count) || !['number', 'target', 'photo'].includes(arrow.source as string) || !time(arrow.enteredAt)) fail('单箭成绩无效');
        arrowIds.add(arrowId);
        const noPoint = arrow.x === null && arrow.y === null;
        const point = finite(arrow.x, -1.200000001, 1.200000001) && finite(arrow.y, -1.200000001, 1.200000001);
        if ((!noPoint && !point) || (arrow.source === 'number' && !noPoint)) fail('单箭落点无效');
        if (arrow.coordinateEvidence !== undefined && (arrow.coordinateEvidence !== 'manual-target-confirmed' || arrow.source !== 'photo' || !point)) fail('落点确认证据无效');
        if (point && scoreAt(target, arrow.x as number, arrow.y as number) !== arrow.code) fail('落点与环数不一致');
        arrowCount++;
      }
    }
    if (arrowCount > 30000) fail('单场箭数超过容量');
  }
  return doc as ScoreBackupDocument;
}

export function parseScoreBackupResponse(value: unknown): ScoreBackupResponse {
  const response = obj(value, '云端响应');
  exact(response, ['revision', 'document', 'updatedAt']);
  if (!integer(response.revision, 0, 999999999999999) || (response.updatedAt !== null && !time(response.updatedAt))) fail('云端版本无效');
  if ((response.revision === 0) !== (response.document === null)) fail('云端版本与备份内容不一致');
  if (response.document !== null) validateScoreBackupDocument(response.document);
  return response as ScoreBackupResponse;
}

/** Keep previously backed-up sessions; reject stale same-session edits. */
export function mergeSelectedScoreBackups(remote: ScoreBackupDocument | null, selected: ScoreBackupDocument): ScoreBackupDocument {
  validateScoreBackupDocument(selected);
  if (remote === null) return selected;
  validateScoreBackupDocument(remote);
  const merged = new Map(remote.sessions.map(session => [session.id, session]));
  for (const session of selected.sessions) {
    const prior = merged.get(session.id);
    if (prior && prior.revision >= session.revision && JSON.stringify(prior) !== JSON.stringify(session)) {
      throw new Error('云端同一场成绩较新或内容不同，请先核对，不能覆盖');
    }
    merged.set(session.id, session);
  }
  return validateScoreBackupDocument({ schema: SCORE_BACKUP_SCHEMA, sessions: [...merged.values()] });
}

/** Restore only missing score records. Existing local sessions are never overwritten. */
export function restoreSelectedScoreBackups(data: Data, remoteValue: unknown, selectedIds: readonly string[]): number {
  const remote = validateScoreBackupDocument(remoteValue);
  if (!selectedIds.length || new Set(selectedIds).size !== selectedIds.length) throw new Error('请明确选择要恢复的不同场次');
  if (data.sessions.length + selectedIds.length > LIMITS.sessions) throw new Error('本机训练场次已达容量上限，未恢复');
  const chosen = new Set(selectedIds);
  const matches = remote.sessions.filter(session => chosen.has(session.id));
  if (matches.length !== chosen.size) throw new Error('所选云端成绩已变化，请重新读取');
  const existing = new Set(data.sessions.map(session => session.id));
  const arrowIds = new Set(data.sessions.flatMap(session => session.ends.flatMap(end => end.arrows.map(arrow => arrow.id))));
  for (const session of matches) {
    if (existing.has(session.id)) throw new Error('本机已有同一场记录，未覆盖；请逐场核对');
    for (const end of session.ends) for (const arrow of end.arrows) {
      if (arrowIds.has(arrow.id)) throw new Error('本机已有相同单箭标识，未恢复');
      arrowIds.add(arrow.id);
    }
  }
  const restored: Session[] = matches.map(session => ({
    id: session.id,
    name: `云端恢复成绩 ${session.date}`,
    date: session.date,
    started: session.started,
    ended: session.ended,
    status: 'completed',
    conditions: { target: session.target, size: session.size, distance: session.distance, bow: '', equipment: null },
    plan: null, scheduleId: null, scheduleSnapshot: null,
    ends: session.ends.map(end => ({ ...end, blockId: 'restored', confirmed: true, arrows: end.arrows.map(arrow => ({ ...arrow })) })),
    currentEnd: session.ends.length - 1,
    blockIndex: 0, blockEnd: 0,
    rest: [], skippedRests: [], note: '', energy: null, fatigue: null, videoNotes: [],
    revision: session.revision,
  }));
  data.sessions.push(...restored);
  return restored.length;
}
