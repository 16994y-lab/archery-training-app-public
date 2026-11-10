import { allArrows, scoreValue, type Arrow, type Session } from './domain';
import { savedCoordinateCoverage } from './analysis-insights';

export type LongTermPoint = {
  session: Session;
  id: string;
  date: string;
  label: string;
  n: number;
  total: number;
  average: number;
  highRate: number;
  groupMin: number | null;
  groupMax: number | null;
  conditionKey: string;
  trusted: number;
  centerX: number | null;
  centerY: number | null;
  rms: number | null;
};

export type LongTermCondition = {
  key: string;
  label: string;
  sessionId: string;
  known: boolean;
  count: number;
};

export type LongTermOptions = {
  start?: string;
  end?: string;
  condition?: string;
  face?: number;
};

export type CorrelationCell = { value: number | null; n: number };

export function validAnalysisDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value + 'T12:00:00Z'))
    && new Date(value + 'T12:00:00Z').toISOString().slice(0, 10) === value;
}

// Group count and the saved plan describe workload, not the scoring conditions.
export function longTermConditionKey(session: Session): string | null {
  const c = session.conditions, t = c.target, e = c.equipment;
  if (!Number.isFinite(c.distance) || c.distance <= 0 || !c.bow.trim()
    || c.size === null || !Number.isFinite(c.size) || c.size <= 0
    || !e || !t.rules_version || !Number.isFinite(t.sizeRatio) || t.sizeRatio <= 0) return null;
  return JSON.stringify([
    c.distance, c.bow, c.size, t.id, t.rules_version, t.target_type,
    t.face_count, t.allowed_score_codes, t.ring_rules?.map(r => [r.score_code, r.outer_radius_norm]) ?? null,
    t.layout, t.sizeRatio,
    [e.bow, e.riser, e.limbs, e.arrows, e.sight, e.stabilizer, e.string, e.tab, e.other],
  ]);
}

const keyFor = (session: Session) => longTermConditionKey(session) ?? `session:${session.id}`;

function conditionLabel(session: Session, known: boolean) {
  const c = session.conditions;
  const parts = [
    `${c.distance} 米`, `${c.size ?? '尺寸未知'}${c.size === null ? '' : ' cm 靶'}`,
    c.target.name, c.bow || '弓种未知', c.equipment?.name || '器材未填写',
  ];
  if (!known) parts.push(`${session.date} · ${session.name}`);
  return parts.join(' · ');
}

function summarizeSession(session: Session, face: number): LongTermPoint {
  const arrows = allArrows(session);
  const total = arrows.reduce((sum, arrow) => sum + scoreValue(arrow.code), 0);
  const groups = session.ends.filter(end => end.arrows.length).map(end =>
    end.arrows.reduce((sum, arrow) => sum + scoreValue(arrow.code), 0) / end.arrows.length);
  const trusted = savedCoordinateCoverage(session).trusted.filter(arrow => arrow.face === face);
  const inside = trusted.filter(arrow => arrow.code !== 'M');
  const size = session.conditions.size, ratio = session.conditions.target.sizeRatio;
  const factor = size !== null && Number.isFinite(size) && size > 0 && Number.isFinite(ratio) && ratio > 0
    ? size * ratio / 2 : null;
  let centerX: number | null = null, centerY: number | null = null, rms: number | null = null;
  if (factor !== null && inside.length >= 2) {
    const x = inside.reduce((sum, arrow) => sum + arrow.x!, 0) / inside.length;
    const y = inside.reduce((sum, arrow) => sum + arrow.y!, 0) / inside.length;
    centerX = x * factor;
    centerY = y * factor;
    rms = Math.sqrt(inside.reduce((sum, arrow) => sum + (arrow.x! - x) ** 2 + (arrow.y! - y) ** 2, 0) / inside.length) * factor;
  }
  return {
    session, id: session.id, date: session.date, label: session.date.slice(5),
    n: arrows.length, total, average: total / arrows.length,
    highRate: arrows.filter(arrow => scoreValue(arrow.code) >= 9).length / arrows.length * 100,
    groupMin: groups.length ? Math.min(...groups) : null,
    groupMax: groups.length ? Math.max(...groups) : null,
    conditionKey: keyFor(session), trusted: trusted.length, centerX, centerY, rms,
  };
}

export function buildLongTermAnalysis(sessions: Session[], options: LongTermOptions = {}) {
  const { start = '', end = '', condition = '', face = 1 } = options;
  const validRange = (!start || validAnalysisDate(start)) && (!end || validAnalysisDate(end)) && (!start || !end || start <= end);
  const available = sessions.filter(session => session.status === 'completed' && validAnalysisDate(session.date) && allArrows(session).length)
    .sort((a, b) => a.date.localeCompare(b.date) || Date.parse(a.started) - Date.parse(b.started) || a.id.localeCompare(b.id));
  const inRange = validRange ? available.filter(session => (!start || session.date >= start) && (!end || session.date <= end)) : [];
  const conditions: LongTermCondition[] = [];
  const byCondition = new Map<string, LongTermCondition>();
  for (const session of [...available].reverse()) {
    const key = keyFor(session), current = byCondition.get(key);
    if (current) current.count++;
    else {
      const known = longTermConditionKey(session) !== null;
      const entry = { key, label: conditionLabel(session, known), sessionId: session.id, known, count: 1 };
      conditions.push(entry);
      byCondition.set(key, entry);
    }
  }
  const latestKnown = [...inRange].reverse().find(session => longTermConditionKey(session) !== null);
  const latestInRange = inRange[inRange.length - 1];
  const defaultCondition = latestKnown ? keyFor(latestKnown) : latestInRange ? keyFor(latestInRange)
    : conditions.find(entry => entry.known)?.key ?? conditions[0]?.key ?? '';
  const activeCondition = byCondition.has(condition) ? condition : defaultCondition;
  const conditionSession = available.find(session => session.id === byCondition.get(activeCondition)?.sessionId);
  const activeFace = Number.isInteger(face) ? Math.max(1, Math.min(face, conditionSession?.conditions.target.face_count ?? 1)) : 1;
  const records = inRange.map(session => summarizeSession(session, activeFace));
  const same = records.filter(point => point.conditionKey === activeCondition);
  const targetSession = same[same.length - 1]?.session ?? null;
  const targetArrows: Arrow[] = same.flatMap(point => savedCoordinateCoverage(point.session).trusted
    .filter(arrow => arrow.face === activeFace).map(arrow => ({ ...arrow, id: `${point.id}:${arrow.id}` })));
  const totalArrows = same.reduce((sum, point) => sum + point.n, 0);
  const totalScore = same.reduce((sum, point) => sum + point.total, 0);
  return {
    validRange, records, conditions, activeCondition, activeFace, same, targetSession, targetArrows,
    targetTrusted: targetArrows.length, spatialSample: same.filter(point => point.rms !== null).length,
    weightedAverage: totalArrows ? totalScore / totalArrows : null, totalArrows,
    availableStart: available[0]?.date ?? '', availableEnd: available[available.length - 1]?.date ?? '',
  };
}

export function weightedMovingAverage(points: LongTermPoint[], window = 3): (number | null)[] {
  if (!Number.isSafeInteger(window) || window < 1) return points.map(() => null);
  const history = new Map<string, LongTermPoint[]>();
  return points.map(point => {
    if (!Number.isFinite(point.total) || !Number.isFinite(point.n) || point.n <= 0) return null;
    const previous = history.get(point.conditionKey) ?? [];
    const current = [...previous, point].slice(-window);
    history.set(point.conditionKey, current);
    if (current.length < window) return null;
    return current.reduce((sum, item) => sum + item.total, 0) / current.reduce((sum, item) => sum + item.n, 0);
  });
}

export function pearsonCorrelation(pairs: readonly (readonly [number | null, number | null])[]): CorrelationCell {
  let n = 0, meanX = 0, meanY = 0, sumX = 0, sumY = 0, covariance = 0;
  for (const [x, y] of pairs) {
    if (x === null || y === null || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    n++;
    const deltaX = x - meanX, deltaY = y - meanY;
    meanX += deltaX / n;
    meanY += deltaY / n;
    sumX += deltaX * (x - meanX);
    sumY += deltaY * (y - meanY);
    covariance += deltaX * (y - meanY);
  }
  const divisor = Math.sqrt(sumX) * Math.sqrt(sumY);
  return { n, value: n < 2 || divisor === 0 ? null : Math.max(-1, Math.min(1, covariance / divisor)) };
}

export function correlationMatrix(points: LongTermPoint[]) {
  const labels = ['均环', 'RMS 散布', '箭量'];
  const metrics = points.map(point => [point.average, point.rms, point.n]);
  const cells = labels.map((_, row) => labels.map((__, column) =>
    pearsonCorrelation(metrics.map(values => [values[row], values[column]] as const))));
  return { labels, cells };
}
