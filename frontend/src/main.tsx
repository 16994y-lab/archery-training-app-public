import { redirectAuthReturn } from "./auth-return";
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { configured, resolveAuthContext, signIn, signOut, signUp, token, verifiedTokenFor, isAuthStorageKey } from "./auth";
import type { AuthContext } from "./auth";
import { captureOfflineOwnerContext, flushQueue, hasPendingSession, isOfflineOwnerContextCurrent, pendingCount, readCache, registerServiceWorker, setOfflineOwnerScope, writeCache } from "./offline";
import type { OfflineOwnerContext } from "./offline";
import type { Arrow, ScoreSession } from "./scoring-session";
import { hasTargetCoordinates, scatterEllipse, targetToPlot } from "./review";
import { AppShell } from "./components/AppShell";
import { TrainingHome } from "./components/TrainingHome";
import { CommunityPage } from "./components/CommunityPage";
import { ReviewOverview } from "./components/ReviewOverview";
import type { ReviewPeriod, ReviewTrendPoint } from "./components/ReviewOverview";
import { ScoringWorkbench } from "./features/scoring/ScoringWorkbench";
import { TargetRings } from "./features/scoring/TargetCanvas";
import { createRequestGate, isResumableSession, isRetryableTransportError, nextNavigationState, StaleRequestError } from "./request-gate";
import { resolveTargetContract } from "./target-contract";
import { AlignedExperience, useModelPreview } from "./features/model-alignment/ModelPreview";
import { TrainingPlanEditor } from "./features/model-alignment/TrainingPlanEditor";
import { GuidedSpread } from "./features/model-alignment/GuidedSpread";
import { ActualGroupScores, MyOverview, RecordCalendar, ReviewExtensions, dateKey } from "./features/model-alignment/AlignedPages";

declare global {
  interface ImportMetaEnv { readonly VITE_API_URL?: string; readonly VITE_SUPABASE_URL?: string; readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string }
  interface ImportMeta { readonly env: ImportMetaEnv }
}

document.title = "弓行记";

type Block = { block_type: string; title: string; instructions?: string | null; end_count?: number | null; arrows_per_end?: number | null; duration_minutes?: number | null; is_scored: boolean };
type Plan = { id: string; revision: number; name: string; description?: string | null; bow_type: string; distance_m: number; target_definition_id: string; default_end_count: number; default_arrows_per_end: number; equipment_note?: string | null; status: string; blocks: Block[] };
type Target = { id: string; name: string; target_type: string; scoring_mode: string; face_count: number };
type Template = Omit<Plan, "id" | "status" | "revision"> & { key: string };


const activeSessionKeyFor = (owner: OfflineOwnerContext) => `archery-active-session-id:${encodeURIComponent(owner.ownerScope)}`;
const blankPlan = (): Omit<Plan, "id" | "status" | "revision"> => ({ name: "", description: "", bow_type: "RECURVE", distance_m: 18, target_definition_id: "builtin-wa-10-ring", default_end_count: 6, default_arrows_per_end: 6, equipment_note: "", blocks: [{ block_type: "TECHNIQUE", title: "技术练习", end_count: 6, arrows_per_end: 6, is_scored: false }] });
const apiRoot = import.meta.env.VITE_API_URL ?? "/api";
const requestGate = createRequestGate();

class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = "ApiError"; }
}

type ApiControl = Readonly<{ owner?: OfflineOwnerContext; accessToken?: string | null; lane?: string }>;

const responseRevision = (data: unknown): { sessionId: string; revision: number } | null => {
  if (!data || typeof data !== "object") return null;
  const record = data as { id?: unknown; revision?: unknown; session?: { id?: unknown; revision?: unknown } };
  if (typeof record.id === "string" && Number.isInteger(record.revision)) return { sessionId: record.id, revision: Number(record.revision) };
  if (typeof record.session?.id === "string" && Number.isInteger(record.session.revision)) return { sessionId: record.session.id, revision: Number(record.session.revision) };
  return null;
};

async function api<T>(path: string, options?: RequestInit, resource: { sessionId?: string; revision?: number } = {}, control: ApiControl = {}): Promise<T> {
  const owner = control.owner ?? captureOfflineOwnerContext();
  if (!owner) throw new Error("请先登录以访问此账户的数据");
  if (!isOfflineOwnerContextCurrent(owner)) throw new StaleRequestError();
  const method = options?.method?.toUpperCase() ?? "GET";
  const ticket = requestGate.capture(owner, { ...resource, lane: control.lane ?? `${method}:${path}` });
  if (method === "GET" && await hasPendingSession(path, owner)) {
    const pending = await readCache<T>(path, owner);
    if (pending !== undefined && requestGate.accepts(ticket, captureOfflineOwnerContext())) return pending;
  }
  const headers = new Headers(options?.headers);
  headers.set("Content-Type", "application/json");
  const accessToken = verifiedTokenFor(owner.ownerScope);
  if (control.accessToken !== undefined && control.accessToken !== accessToken) throw new StaleRequestError();
  if (accessToken) headers.set("Authorization", `Bearer ${accessToken}`);
  try {
    const response = await fetch(`${apiRoot}${path}`, { ...options, headers });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      if (!requestGate.accepts(ticket, captureOfflineOwnerContext())) throw new StaleRequestError();
      throw new ApiError(response.status, typeof body.detail === "string" ? body.detail : "请求内容无效，请核对后重试");
    }
    if (response.status === 204) {
      if (!requestGate.accepts(ticket, captureOfflineOwnerContext())) throw new StaleRequestError();
      return undefined as T;
    }
    const data = await response.json() as T;
    if (!requestGate.accepts(ticket, captureOfflineOwnerContext())) throw new StaleRequestError();
    const observed = responseRevision(data);
    if (observed) requestGate.observe(observed.sessionId, observed.revision);
    if (method === "GET") void writeCache(path, data, owner);
    return data;
  } catch (reason) {
    if (method === "GET" && isRetryableTransportError(reason)) {
      const cached = await readCache<T>(path, owner);
      if (cached !== undefined && requestGate.accepts(ticket, captureOfflineOwnerContext())) return cached;
    }
    throw reason;
  }
}

async function downloadExport(path: "/history/export.csv" | "/history/export.json") {
  const owner = captureOfflineOwnerContext();
  if (!owner) throw new Error("请先登录后导出");
  const ticket = requestGate.capture(owner, { lane: "history-export" });
  const accessToken = verifiedTokenFor(owner.ownerScope);
  const headers = new Headers(); if (accessToken) headers.set("Authorization", `Bearer ${accessToken}`);
  const response = await fetch(`${apiRoot}${path}`, { headers });
  if (!response.ok) {
    if (!requestGate.accepts(ticket, captureOfflineOwnerContext())) throw new StaleRequestError();
    throw new ApiError(response.status, "导出失败，请检查网络和登录状态");
  }
  const blob = await response.blob();
  if (!requestGate.accepts(ticket, captureOfflineOwnerContext())) throw new StaleRequestError();
  const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = path.endsWith("csv") ? "archery-history.csv" : "archery-history.json"; link.click(); URL.revokeObjectURL(link.href);
}

type HistoryItem = { id: string; confirmed_at: string; target_name: string; distance_m: number; statistics: { total_score: number; average_score: number | null; hit_rate: number | null; x_count: number; ten_count: number } };
type EndStat = { sequence: number; arrow_count: number; total_score: number; average_score: number | null };
type HistoryStatistics = { total_score: number; average_score: number | null; hit_rate: number | null; x_count: number; ten_count: number; arrow_count: number; ring_distribution: Record<string, number>; coordinate_count: number; dispersion_rms: number | null; end_stats: EndStat[]; phase_comparison: { first: { average_score: number | null }; second: { average_score: number | null } } };
type HistoryDetail = { session: ScoreSession; statistics: HistoryStatistics };
const shown = (value: number | null, digits = 2) => value === null ? "无数据" : value.toFixed(digits);
const fmtRecordDate = (iso: string) => { const d = new Date(iso); return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };

type TrendPoint = ReviewTrendPoint;

type PlottedArrow = Arrow & { plot_x_norm: number; plot_y_norm: number };
type TargetArrow = Arrow & { x_norm: number; y_norm: number };
type ReviewEndFilter = "all" | number;

function ScatterChart({ detail, endFilter }: { detail: HistoryDetail; endFilter: ReviewEndFilter }) {
  const [showSeq, setShowSeq] = useState(false), [selectedArrow, setSelectedArrow] = useState<(PlottedArrow & { endSequence: number; sourceLabel: string }) | null>(null);
  const target = resolveTargetContract(detail.session.target);
  type PlottedWithEnd = PlottedArrow & { endSequence: number; sourceLabel: string };
  const sourceLabel = (source: string) => source === "MANUAL_TARGET" ? "点按录入" : source === "MANUAL_NUMBER" ? "数字录入" : "照片人工确认";
  const selectedEnds = detail.session.ends.filter((end) => endFilter === "all" || end.sequence === endFilter);
  const allArrows = selectedEnds.flatMap((end) => end.arrows);
  const plotted: PlottedWithEnd[] = selectedEnds.flatMap((end) => end.arrows.filter((arrow): arrow is PlottedArrow => arrow.plot_x_norm !== null && arrow.plot_y_norm !== null).map((arrow) => ({ ...arrow, endSequence: end.sequence, sourceLabel: sourceLabel(arrow.source) })));
  const targetArrows = allArrows.filter(hasTargetCoordinates) as TargetArrow[];
  const totalArrows = allArrows.length;
  const coordN = plotted.length;
  const noCoord = totalArrows - coordN;
  const numberM = allArrows.filter((arrow) => arrow.source === "MANUAL_NUMBER" && arrow.score_code === "M").length;
  const whiteM = allArrows.filter((arrow) => arrow.score_code === "M" && arrow.x_norm === null && arrow.plot_x_norm !== null && arrow.plot_y_norm !== null).length;
  const coverage = `有坐标 ${coordN}/${totalArrows} 箭`;
  if (target.scoring_mode !== "RING_GEOMETRY" || plotted.length === 0) {
    return <section className="chart-card"><div className="chart-head"><h3>靶面散布</h3><span className="coverage-note">{coverage}</span></div><div className="chart-empty">本场没有可绘制的落点：数字录入和未标记位置的 M 不保存坐标，不会伪造落点。</div></section>;
  }
  // 画布半径比例：靶面占 5/12，白边占 1/12
  const targetRadius = 5 / 12; // 0-1 坐标系中靶面半径
  const centerMark = (cx: number, cy: number) => <g className="scatter-center"><circle cx={cx} cy={cy} r="3.2" /><line x1={cx - 4.5} y1={cy} x2={cx + 4.5} y2={cy} /><line x1={cx} y1={cy - 4.5} x2={cx} y2={cy + 4.5} /></g>;
  const targetMark = (cx: number, cy: number) => <g className="target-center-mark"><circle cx={cx} cy={cy} r="2.4" /><line x1={cx - 4} y1={cy} x2={cx + 4} y2={cy} /><line x1={cx} y1={cy - 4} x2={cx} y2={cy + 4} /></g>;
  const ellipseMark = (items: TargetArrow[], cx: number, cy: number, scale: number) => {
    const ellipse = scatterEllipse(items.map((arrow) => ({ x: arrow.x_norm, y: arrow.y_norm })));
    if (!ellipse) return null;
    const center = targetToPlot(ellipse.center);
    const ex = ellipse.radiusX * (5 / 6) * scale;
    const ey = ellipse.radiusY * (5 / 6) * scale;
    const x = cx + (center.x - 0.5) * scale, y = cy + (center.y - 0.5) * scale;
    return <g className="scatter-ellipse" transform={`rotate(${ellipse.rotationDegrees} ${x} ${y})`}>{ey < 0.12 ? <line x1={x - ex} y1={y} x2={x + ex} y2={y} /> : <ellipse cx={x} cy={y} rx={ex} ry={ey} />}</g>;
  };
  const dot = (arrow: PlottedWithEnd, cx: number, cy: number, scale: number) => {
    const dx = cx + (arrow.plot_x_norm - 0.5) * scale, dy = cy + (arrow.plot_y_norm - 0.5) * scale;
    const desc = `第${arrow.endSequence}组 第${arrow.sequence}箭（${arrow.endSequence}-${arrow.sequence}） · ${arrow.score_code === "M" ? "脱靶" : `${arrow.score_code}环`} · ${arrow.sourceLabel}`;
    const isWhiteM = arrow.score_code === "M" && arrow.x_norm === null;
    const active = selectedArrow?.id === arrow.id;
    const select = () => setSelectedArrow(arrow);
    return <g key={arrow.id} className={`scatter-arrow ${isWhiteM ? "scatter-miss" : ""} ${active ? "selected" : ""}`} role="button" tabIndex={0} aria-label={`${desc}。点按查看详情。`} onClick={select} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select(); } }}><circle className="scatter-dot" cx={dx} cy={dy} r={isWhiteM ? "3.2" : "2.5"}><title>{desc}</title></circle>{isWhiteM && <text className="scatter-miss-label" x={dx} y={dy + 1.35} textAnchor="middle">M</text>}{showSeq && <text className="scatter-seq" x={dx} y={dy - 4} textAnchor="middle">{arrow.endSequence}-{arrow.sequence}</text>}</g>;
  };
  // 散布图画布大小 100x100，靶面半径 = 100 * 5/12 ≈ 41.67
  const faceR = 100 * targetRadius;
  return <section className="chart-card"><div className="chart-head"><h3>靶面散布</h3><div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}><label className="scatter-toggle"><input type="checkbox" checked={showSeq} onChange={(e) => setShowSeq(e.target.checked)} />显示箭序</label><span className="coverage-note">{coverage}</span></div></div><div className="scatter-wrap">{target.face_count > 1 ? (
    <svg className="scatter-svg spot" viewBox={`0 0 100 ${target.face_count * 110}`} role="img" aria-label={`${target.name} ${target.face_count} 个靶面的箭点散布图`}>{target.layout!.faces.map((face, index) => {
      const cy = 50 + index * 110;
      const items = plotted.filter((arrow) => arrow.target_face_index === face.index);
      const targetItems = targetArrows.filter((arrow) => arrow.target_face_index === face.index);
      const ellipse = targetItems.length ? scatterEllipse(targetItems.map((arrow) => ({ x: arrow.x_norm, y: arrow.y_norm }))) : null;
      const mean = ellipse ? targetToPlot(ellipse.center) : null;
      return <g key={face.index}><rect x="0" y={cy - 50} width="100" height="100" rx="3" fill="#fafafa" stroke="#d0d8e8" strokeWidth="0.3" /><text className="face-label" x="6" y={cy - 42}>{face.index} 号靶面</text><TargetRings target={target} cx={50} cy={cy} scoringRadius={faceR} />{targetMark(50, cy)}{ellipseMark(targetItems, 50, cy, 100)}{mean && centerMark(50 + (mean.x - 0.5) * 100, cy + (mean.y - 0.5) * 100)}{items.map((arrow) => dot(arrow, 50, cy, 100))}</g>;
    })}</svg>
  ) : (
    <svg className="scatter-svg" viewBox="0 0 100 100" role="img" aria-label={`${target.name}箭点散布图`}><rect x="0" y="0" width="100" height="100" rx="3" fill="#fafafa" stroke="#d0d8e8" strokeWidth="0.3" /><TargetRings target={target} cx={50} cy={50} scoringRadius={faceR} />{targetMark(50, 50)}{ellipseMark(targetArrows, 50, 50, 100)}{(() => { const ellipse = scatterEllipse(targetArrows.map((arrow) => ({ x: arrow.x_norm, y: arrow.y_norm }))); const mean = ellipse ? targetToPlot(ellipse.center) : null; return mean && centerMark(50 + (mean.x - 0.5) * 100, 50 + (mean.y - 0.5) * 100); })()}{plotted.map((arrow) => dot(arrow, 50, 50, 100))}</svg>
  )}</div>{selectedArrow && plotted.some((arrow) => arrow.id === selectedArrow.id) && <div className="arrow-inspector" role="status"><strong>已选：第 {selectedArrow.endSequence} 组 · 第 {selectedArrow.sequence} 箭</strong><span>{selectedArrow.score_code === "M" ? "M 脱靶" : `${selectedArrow.score_code} 环`} · {selectedArrow.sourceLabel}{selectedArrow.score_code === "M" && selectedArrow.x_norm === null ? " · 白区方向已记录" : ""}</span><button onClick={() => setSelectedArrow(null)}>收起</button></div>}<div className="scatter-legend"><span><i className="legend-target" />靶心</span><span><i className="legend-center" />靶内箭群中心</span><span><i className="legend-ellipse" />标准差离散椭圆</span><span><i className="legend-miss" />白区 M</span></div><div className="coord-breakdown"><span>有坐标 {coordN}/{totalArrows} 箭（点按或照片人工确认，含靶内与白区）；无坐标 {noCoord} 箭（数字录入）。</span>{whiteM > 0 && <span className="cb-miss">白区有位置脱靶 {whiteM} 箭：记为 M，保存了落点方向，但不参与箭群中心与离散椭圆。</span>}{numberM > 0 && <span className="cb-miss">数字录入 M {numberM} 箭：记为 M 且没有落点，图中不显示。</span>}</div><p className="chart-note">深色点为已记录的点按或照片人工确认落点；灰色十字固定表示靶心，绿色十字只表示靶内箭群中心。绿色椭圆是靶内坐标的标准差离散度，不是命中概率或 AI 诊断。{showSeq ? " 箭序格式为「组-箭」，如 3-2 表示第 3 组第 2 箭。" : " 开启「显示箭序」可查看每箭「组-箭」编号；点按箭点可见完整记录。"}</p></section>;
}

function BiasAnalysis({ detail, endFilter }: { detail: HistoryDetail; endFilter: ReviewEndFilter }) {
  const scopedEnds = detail.session.ends.filter((end) => endFilter === "all" || end.sequence === endFilter);
  const arrows = scopedEnds.flatMap((end) => end.arrows).filter(hasTargetCoordinates) as TargetArrow[];
  const total = scopedEnds.flatMap((end) => end.arrows).length;
  if (arrows.length < 3) return <section className="chart-card" id="review-bias"><div className="chart-head"><h3>偏向</h3><span className="coverage-note">基于 {arrows.length}/{total} 支有靶内坐标箭</span></div><div className="chart-empty">坐标不足，无法判断偏向。数字录入、数字 M 和白区 M 不参与此结论。</div></section>;
  const meanX = arrows.reduce((sum, arrow) => sum + arrow.x_norm, 0) / arrows.length;
  const meanY = arrows.reduce((sum, arrow) => sum + arrow.y_norm, 0) / arrows.length;
  const horizontal = (meanX - 0.5) / 0.5 * 100;
  const vertical = (0.5 - meanY) / 0.5 * 100;
  const describe = (value: number, positive: string, negative: string) => Math.abs(value) < 3 ? "接近靶心" : `${value > 0 ? positive : negative} ${Math.abs(value).toFixed(1)}%`;
  const pointX = 50 + (meanX - 0.5) * 80;
  const pointY = 50 + (meanY - 0.5) * 80;
  return <section className="chart-card" id="review-bias"><div className="chart-head"><h3>偏向</h3><span className="coverage-note">基于 {arrows.length}/{total} 支有靶内坐标箭</span></div><div className="bias-layout"><svg className="bias-svg" viewBox="0 0 100 100" role="img" aria-label={`平均落点：水平方向${describe(horizontal, "偏右", "偏左")}，垂直方向${describe(vertical, "偏上", "偏下")}`}><circle className="bias-ring" cx="50" cy="50" r="35" /><line className="bias-axis" x1="10" y1="50" x2="90" y2="50" /><line className="bias-axis" x1="50" y1="10" x2="50" y2="90" /><circle className="bias-center" cx="50" cy="50" r="2.5" /><line className="bias-vector" x1="50" y1="50" x2={pointX} y2={pointY} /><circle className="bias-point" cx={pointX} cy={pointY} r="3.5" /></svg><div className="bias-readout"><div><span>水平</span><strong>{describe(horizontal, "偏右", "偏左")}</strong></div><div><span>垂直</span><strong>{describe(vertical, "偏上", "偏下")}</strong></div></div></div><p className="chart-note">仅描述平均靶内落点相对靶心的位置，不构成动作、器材或 AI 诊断。白区 M 可在散布图查看方向，但不参与偏向与稳定性计算。</p></section>;
}

function GroupDrift({ detail }: { detail: HistoryDetail }) {
  const groups = detail.session.ends.map((end) => {
    const arrows = end.arrows.filter(hasTargetCoordinates) as TargetArrow[];
    if (arrows.length === 0) return null;
    return { sequence: end.sequence, count: arrows.length, x: arrows.reduce((sum, arrow) => sum + arrow.x_norm, 0) / arrows.length, y: arrows.reduce((sum, arrow) => sum + arrow.y_norm, 0) / arrows.length };
  }).filter((group): group is { sequence: number; count: number; x: number; y: number } => group !== null);
  if (groups.length < 2) return <section className="chart-card"><div className="chart-head"><h3>分组偏移轨迹</h3><span className="coverage-note">有坐标组 {groups.length}/{detail.session.ends.length}</span></div><div className="chart-empty">至少需要两组有靶内坐标，才能绘制真实的分组偏移轨迹。</div></section>;
  const coords = groups.map((group) => targetToPlot({ x: group.x, y: group.y }));
  const points = coords.map((point) => `${50 + (point.x - 0.5) * 80},${50 + (point.y - 0.5) * 80}`).join(" ");
  return <section className="chart-card"><div className="chart-head"><h3>分组偏移轨迹</h3><span className="coverage-note">有坐标组 {groups.length}/{detail.session.ends.length}</span></div><svg className="drift-svg" viewBox="0 0 100 100" role="img" aria-label="各组平均靶内落点轨迹"><circle className="bias-ring" cx="50" cy="50" r="35" /><line className="bias-axis" x1="10" y1="50" x2="90" y2="50" /><line className="bias-axis" x1="50" y1="10" x2="50" y2="90" /><polyline className="drift-line" points={points} />{groups.map((group, index) => { const point = coords[index]; const x = 50 + (point.x - 0.5) * 80, y = 50 + (point.y - 0.5) * 80; return <g key={group.sequence}><circle className="drift-point" cx={x} cy={y} r="3.2"><title>第 {group.sequence} 组：{group.count} 支有靶内坐标箭</title></circle><text x={x} y={y + 1.3} textAnchor="middle">{group.sequence}</text></g>; })}</svg><p className="chart-note">连线按组序表示各组平均靶内落点的变化；缺少坐标的组不补点、不连线。</p></section>;
}

function RingDistribution({ detail, endFilter }: { detail: HistoryDetail; endFilter: ReviewEndFilter }) {
  const codes = detail.session.target.allowed_score_codes;
  const arrows = detail.session.ends.filter((end) => endFilter === "all" || end.sequence === endFilter).flatMap((end) => end.arrows);
  const dist = arrows.reduce<Record<string, number>>((result, arrow) => ({ ...result, [arrow.score_code]: (result[arrow.score_code] ?? 0) + 1 }), {});
  const total = arrows.length;
  const max = Math.max(1, ...codes.map((code) => dist[code] ?? 0));
  const label = (code: string) => code === "M" ? "M" : `${code}环`;
  return <section className="chart-card"><div className="chart-head"><h3>环数分布</h3><span className="coverage-note">共 {total} 箭</span></div>{codes.map((code) => {
    const count = dist[code] ?? 0;
    const cls = code === "M" ? "code-miss" : code === "X" ? "code-x" : "";
    const pct = total > 0 ? Math.round(count / total * 100) : 0;
    return <div className="bar-row" key={code}><span className={`bar-label ${cls}`}>{label(code)}</span><div className="bar-track"><span className={`bar-fill ${cls}`} style={{ width: `${(count / max) * 100}%` }} /></div><span className="bar-count">{count}箭</span><span className="bar-pct">{pct}%</span></div>;
  })}<p className="chart-note">X 与普通 10 分开计数；M 计 0 分但计入总箭数和统计分母。</p></section>;
}

function EndTrend({ detail }: { detail: HistoryDetail }) {
  const ends = detail.statistics.end_stats ?? [];
  if (ends.length < 2) return null;
  const maxScore = detail.session.arrows_per_end * 10;
  const width = 320, height = 150, padX = 26, padTop = 18, padBottom = 26;
  const stepX = (width - padX * 2) / (ends.length - 1);
  const points = ends.map((end) => ({ x: padX + (end.sequence - 1) * stepX, y: padTop + (1 - end.total_score / maxScore) * (height - padTop - padBottom) }));
  return <section className="chart-card"><div className="chart-head"><h3>每组走势</h3><span className="coverage-note">每组满分 {maxScore}</span></div><svg className="trend-svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="每组总分走势">{[0, 0.5, 1].map((ratio) => {
    const y = padTop + (1 - ratio) * (height - padTop - padBottom);
    return <g key={ratio}><line className="grid-line" x1={padX} y1={y} x2={width - padX} y2={y} /><text className="axis-label" x="2" y={y + 3}>{Math.round(maxScore * ratio)}</text></g>;
  })}<polyline className="trend-line" points={points.map((point) => `${point.x},${point.y}`).join(" ")} />{points.map((point, index) => <g key={index}><circle className="trend-point" cx={point.x} cy={point.y} r="2.6" /><text x={point.x} y={point.y - 5} textAnchor="middle">{ends[index].total_score}</text><text className="axis-label" x={point.x} y={height - 8} textAnchor="middle">{ends[index].sequence}</text></g>)}</svg><p className="chart-note">前段均分 {shown(detail.statistics.phase_comparison.first.average_score)}；后段均分 {shown(detail.statistics.phase_comparison.second.average_score)}（奇数组前段取前 ceil(n/2) 组，不重叠）。</p></section>;
}

type AppPage = "community" | "home" | "plans" | "scoring" | "history" | "account";

function HistoryPage({ onNavigate, onSavingChange }: { onNavigate: (page: AppPage) => void; onSavingChange(busy: boolean): void }) {
  const [calendarDay, setCalendarDay] = useState<string | null>(null);
  const [reviewPeriod, setReviewPeriod] = useState<ReviewPeriod>(30);
  const reviewNow = useRef(Date.now());
  const query = new URLSearchParams(window.location.search);
  const requestedSession = query.get("session");
  const requestedTab = query.get("tab");
  const initialTab = requestedTab === "scatter" || requestedTab === "bias" || requestedTab === "trend" ? requestedTab : "base";
  const savedList = window.history.state?.archeryReviewList;
  const [items, setItems] = useState<HistoryItem[]>([]), [detail, setDetail] = useState<HistoryDetail | null>(null), [distance, setDistance] = useState<string>(savedList?.distance ?? ""), [statistics, setStatistics] = useState<{ overall: { average_score: number | null; arrow_count: number }; trend: TrendPoint[] } | null>(null), [error, setError] = useState(""), [mutating, setMutating] = useState(false), [analysisTab, setAnalysisTab] = useState<"base" | "scatter" | "bias" | "trend">(initialTab), [endFilter, setEndFilter] = useState<ReviewEndFilter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(requestedSession);
  const [listLoaded, setListLoaded] = useState(false);
  const mutationLock = useRef(false), detailRun = useRef(0);
  const listPosition = useRef<{ distance: string; scrollY: number; recordId?: string }>(savedList ?? { distance: "", scrollY: 0 });
  const appliedDistance = useRef<string>(savedList?.distance ?? "");
  const restoreList = useRef(!requestedSession);
  const detailHeading = useRef<HTMLHeadingElement>(null);
  const currentLocation = useRef({ url: window.location.href, state: window.history.state });
  const rememberLocation = () => { currentLocation.current = { url: window.location.href, state: window.history.state }; };
  const load = async (filter = appliedDistance.current) => {
    try {
      const suffix = filter ? `?distance_m=${encodeURIComponent(filter)}` : "";
      const [history, stats] = await Promise.all([api<HistoryItem[]>(`/history${suffix}`, undefined, {}, { lane: "history-list" }), api<{ overall: { average_score: number | null; arrow_count: number }; trend: TrendPoint[] }>("/history/statistics", undefined, {}, { lane: "history-statistics" })]);
      appliedDistance.current = filter; setItems(history); setStatistics(stats); setListLoaded(true);
    } catch (reason) { if (!(reason instanceof StaleRequestError)) setError(reason instanceof Error ? reason.message : "无法读取历史"); }
  };
  const listUrl = () => { const url = new URL(window.location.href); url.searchParams.set("view", "history"); ["session", "tab", "focus"].forEach(key => url.searchParams.delete(key)); return url; };
  const showList = () => {
    detailRun.current += 1; setSelectedId(null); setDetail(null); setError(""); restoreList.current = true;
    setDistance(listPosition.current.distance);
  };
  const backToList = () => {
    if (mutationLock.current) return;
    if (window.history.state?.archeryReviewDetail) window.history.back();
    else { window.history.replaceState({ ...window.history.state, archeryReviewList: listPosition.current }, "", listUrl()); rememberLocation(); showList(); }
  };
  const open = async (id: string, tab = "base", push = true) => {
    if (mutationLock.current) return;
    const run = ++detailRun.current;
    if (push) {
      listPosition.current = { distance: appliedDistance.current, scrollY: window.scrollY, recordId: id };
      const state = { ...window.history.state, archeryReviewList: listPosition.current, archeryReviewDetail: false };
      window.history.replaceState(state, "", listUrl());
      const url = listUrl(); url.searchParams.set("session", id);
      window.history.pushState({ ...state, archeryReviewDetail: true }, "", url);
    }
    rememberLocation(); restoreList.current = false; setSelectedId(id); setDetail(null); setError("");
    setAnalysisTab(tab === "scatter" || tab === "bias" || tab === "trend" ? tab : "base"); setEndFilter("all");
    try {
      const next = await api<HistoryDetail>(`/history/sessions/${id}`, undefined, { sessionId: id }, { lane: "history-detail" });
      if (run === detailRun.current) setDetail(next);
    } catch (reason) { if (run === detailRun.current && !(reason instanceof StaleRequestError)) setError(reason instanceof Error ? reason.message : "无法读取详情"); }
  };
  useLayoutEffect(() => {
    if (selectedId) { window.scrollTo(0, 0); detailHeading.current?.focus({ preventScroll: true }); }
    else if (listLoaded && restoreList.current) {
      restoreList.current = false;
      const record = document.querySelector<HTMLElement>(`[data-record-id="${listPosition.current.recordId ?? ""}"]`);
      record?.focus({ preventScroll: true }); window.scrollTo(0, listPosition.current.scrollY);
    }
  }, [selectedId, listLoaded]);
  useEffect(() => {
    const scrollRestoration = window.history.scrollRestoration; window.history.scrollRestoration = "manual";
    void load(); if (requestedSession) void open(requestedSession, initialTab, false);
    const onPop = () => {
      if (mutationLock.current) {
        window.history.pushState(currentLocation.current.state, "", currentLocation.current.url);
        window.alert("正在保存当前成绩，请稍候再离开。"); return;
      }
      const next = new URLSearchParams(window.location.search);
      const saved = window.history.state?.archeryReviewList;
      if (saved) listPosition.current = saved;
      rememberLocation();
      if (next.get("view") === "history" && next.get("session")) void open(next.get("session")!, next.get("tab") ?? "base", false);
      else showList();
    };
    window.addEventListener("popstate", onPop);
    return () => { detailRun.current += 1; window.removeEventListener("popstate", onPop); window.history.scrollRestoration = scrollRestoration; };
  }, []);
  const setBusy = (busy: boolean) => { mutationLock.current = busy; setMutating(busy); onSavingChange(busy); };
  const replace = async (end: number, arrow: Arrow, score: string) => {
    if (!detail || mutationLock.current || score === arrow.score_code) return;
    const snapshot = detail;
    try {
      setBusy(true); setError("");
      const updated = await api<HistoryDetail>(`/history/sessions/${snapshot.session.id}/ends/${end}/arrows/${arrow.sequence}`, { method: "PUT", headers: { "If-Match": String(snapshot.session.revision) }, body: JSON.stringify({ score_code: score, source: "MANUAL_NUMBER" }) }, { sessionId: snapshot.session.id, revision: snapshot.session.revision }, { lane: "history-detail" });
      setDetail(updated); await load();
    } catch (reason) { if (!(reason instanceof StaleRequestError)) setError(reason instanceof Error ? reason.message : "修改失败"); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    if (!detail || mutationLock.current || !window.confirm("删除这次已确认训练？删除后无法恢复。")) return;
    const snapshot = detail;
    try {
      setBusy(true); setError("");
      await api<void>(`/history/sessions/${snapshot.session.id}`, { method: "DELETE", headers: { "If-Match": String(snapshot.session.revision) } }, { sessionId: snapshot.session.id, revision: snapshot.session.revision }, { lane: "history-detail" });
      await load(); setBusy(false); backToList();
    } catch (reason) { if (!(reason instanceof StaleRequestError)) setError(reason instanceof Error ? reason.message : "删除失败，请刷新后重试"); }
    finally { setBusy(false); }
  };
  const saveReflection = async () => {
    if (!detail || mutationLock.current) return;
    const note=window.prompt("练后心得／提前结束原因（可选）",detail.session.note??"");
    if (note===null) return;
    if (note.length>2000) { setError("心得请控制在2000字以内"); return; }
    const snapshot=detail;
    try {
      setBusy(true);setError("");
      const updated=await api<HistoryDetail>(`/history/sessions/${snapshot.session.id}`,{method:"PUT",headers:{"If-Match":String(snapshot.session.revision)},body:JSON.stringify({note,equipment_note:snapshot.session.equipment_note??null})},{sessionId:snapshot.session.id,revision:snapshot.session.revision},{lane:"history-detail"});
      setDetail(updated);
    } catch(reason) { if (!(reason instanceof StaleRequestError)) setError(reason instanceof Error?reason.message:"心得未保存，请重试"); }
    finally {setBusy(false);}
  };
  const visibleItems = items.filter((item) => !calendarDay || dateKey(new Date(item.confirmed_at)) === calendarDay);
  const calendarDates = items.map((item) => dateKey(new Date(item.confirmed_at)));
  return <main className={selectedId ? "review-detail-page" : "review-list-page"}>
    {selectedId ? <header className="review-page-header"><button className="review-back" disabled={mutating} onClick={backToList}>‹ 返回训练记录</button><h1 tabIndex={-1} ref={detailHeading}>本次复盘</h1><p>单次训练 · 记录与分析</p></header> : <><header className="page-header figma-page-heading"><div className="heading-lockup"><span className="page-logo"><img src="/ui/logo-mark.png" alt="" /></span><div className="page-title"><p className="eyebrow">弓行记 · 训练后</p><h1>复盘</h1><p>从真实训练中看见节奏，而不是堆满指标。</p></div></div><button onClick={() => onNavigate("plans")}>训练计划</button></header>{statistics ? <ReviewOverview trend={statistics.trend} period={reviewPeriod} onPeriodChange={setReviewPeriod} now={reviewNow.current} /> : !error && <p className="notice" role="status">正在读取长期训练数据…</p>}<section className="history-tools" aria-label="训练记录筛选与导出"><div className="history-distance-filter"><input aria-label="按距离筛选" type="number" min="0.1" placeholder="距离（米）" value={distance} onChange={(e) => setDistance(e.target.value)} /><button onClick={() => { setError(""); void load(distance); }}>筛选</button></div><div className="history-export-actions"><button onClick={() => void downloadExport("/history/export.csv").catch((reason) => setError(reason instanceof Error ? reason.message : "导出失败"))}>CSV</button><button onClick={() => void downloadExport("/history/export.json").catch((reason) => setError(reason instanceof Error ? reason.message : "导出失败"))}>JSON</button></div></section><RecordCalendar dates={calendarDates} onSelect={setCalendarDay} />{calendarDay && <button className="calendar-filter-clear" onClick={()=>setCalendarDay(null)}>清除日期筛选 · {calendarDay}</button>}<section className="history-stream"><div className="section-title"><div><p className="eyebrow">记录流</p><h2>训练历史</h2></div><span>{visibleItems.length} 场已确认</span></div>{visibleItems.length > 0 ? <div className="history-list">{visibleItems.map((item) => <button className="history-row" key={item.id} data-record-id={item.id} onClick={() => void open(item.id)}><time>{fmtRecordDate(item.confirmed_at)}</time><strong>{item.target_name} · {item.distance_m} 米</strong><span>{item.statistics.total_score} 分 · 均分 {shown(item.statistics.average_score)} · 命中率 {shown(item.statistics.hit_rate === null ? null : item.statistics.hit_rate * 100, 1)}%</span><b aria-hidden="true">›</b></button>)}</div> : <div className="empty">{calendarDay ? "当天没有已确认训练。" : "暂无已确认训练。"}</div>}</section><ReviewExtensions /></>}
    {detail&&selectedId&&<section className="completion-facts"><strong>{detail.session.completion_mode==="EARLY"?"提前结束 · 已按实射保存":"已确认训练记录"}</strong><p>原计划{detail.session.planned_end_count}组 × {detail.session.arrows_per_end}箭；实录{detail.session.ends.length}组、{detail.statistics.arrow_count}箭。{detail.session.completion_mode==="EARLY"?`箭量完成度${Math.round(detail.statistics.arrow_count/(detail.session.planned_end_count*detail.session.arrows_per_end)*100)}%，未射部分不计M。`:""}</p><p style={{whiteSpace:"pre-wrap"}}>{detail.session.note||"练后心得可选填"}</p><button disabled={mutating} onClick={()=>void saveReflection()}>补记心得／结束原因</button></section>}
    {error && <p className="notice error" role="alert">{error}{selectedId && !detail && <button onClick={() => void open(selectedId, analysisTab, false)}>重试加载</button>}</p>}
    {selectedId && !detail && !error && <p className="notice" role="status">正在读取本次训练…</p>}
    {selectedId && detail && <section className="review-workspace"><header className="review-heading"><div><p className="eyebrow">本场复盘</p><h2>{detail.session.target.name} · {detail.session.distance_m} 米</h2><p>{detail.statistics.arrow_count} 箭 · 总分 {detail.statistics.total_score} · 平均 {shown(detail.statistics.average_score)}</p></div><button className="text" disabled={mutating} onClick={() => void remove()}>删除本次训练</button></header><nav className="review-nav" aria-label="训练复盘分区" role="tablist">{([ ["base", "基础数据"], ["scatter", "箭群散布"], ["bias", "偏向分析"], ["trend", "波动趋势"] ] as const).map(([tab, label]) => <button key={tab} role="tab" aria-selected={analysisTab === tab} className={analysisTab === tab ? "active" : ""} onClick={() => setAnalysisTab(tab)}>{label}</button>)}</nav><div className="end-filter" aria-label="复盘组别筛选"><span>查看范围</span><button className={endFilter === "all" ? "active" : ""} onClick={() => setEndFilter("all")}>全场</button>{detail.session.ends.map((end) => <button key={end.sequence} className={endFilter === end.sequence ? "active" : ""} onClick={() => setEndFilter(end.sequence)}>第 {end.sequence} 组</button>)}</div>{analysisTab === "base" && <><section className="stats-grid session-stats"><article><strong>{detail.statistics.total_score}</strong><span>本场总分</span></article><article><strong>{shown(detail.statistics.average_score)}</strong><span>平均环</span></article><article className="kpi"><div className="kpi-rows"><div className="kpi-line"><b className="gold">{detail.statistics.x_count}</b> X环</div><div className="kpi-line"><b>{detail.statistics.ten_count}</b> 10环</div></div></article></section><RingDistribution detail={detail} endFilter={endFilter} /><ActualGroupScores session={detail.session} disabled={mutating} onSelect={(sequence,arrow=1)=>{setEndFilter(sequence);requestAnimationFrame(()=>document.querySelectorAll<HTMLSelectElement>(".end-review select")[arrow-1]?.focus());}} /><section className="arrow-edit-card"><h3>逐箭校正</h3>{endFilter === "all" ? <p className="score-helper">先在“查看范围”选择具体组，再展开该组逐箭校正；全场视图保持紧凑。</p> : detail.session.ends.filter((end) => end.sequence === endFilter).map((end) => <div className="end-review" key={end.sequence}><strong>第 {end.sequence} 组</strong>{end.arrows.map((arrow) => <label key={arrow.id}>{arrow.sequence}<select disabled={mutating} value={arrow.score_code} onChange={(e) => void replace(end.sequence, arrow, e.target.value)}>{detail.session.target.allowed_score_codes.map((code) => <option key={code}>{code}</option>)}</select></label>)}</div>)}</section></>}{analysisTab === "scatter" && <GuidedSpread session={detail.session} endFilter={endFilter} />}{analysisTab === "bias" && <><GuidedSpread session={detail.session} endFilter={endFilter} bias /><GroupDrift detail={detail} /></>}{analysisTab === "trend" && <EndTrend detail={detail} />}<ReviewExtensions /></section>}</main>;
}

function AccountPage({ onNavigate, queued, auth, onAuthBoundaryStart, onAuthChanged }: { onNavigate: (page: AppPage) => void; queued: number; auth: AuthContext; onAuthBoundaryStart(): void; onAuthChanged(): Promise<void> }) {
  const [email, setEmail] = useState(""), [password, setPassword] = useState(""), [message, setMessage] = useState(""), [busy, setBusy] = useState(false);
  const loggedIn = auth.mode === "AUTHENTICATED";
  const offlineUnverified = auth.mode === "OFFLINE_UNVERIFIED";
  const submit = async (mode: "signin" | "signup") => { if (busy) return; const submittedPassword = password; setPassword(""); onAuthBoundaryStart(); try { setBusy(true); const result = mode === "signin" ? await signIn(email, submittedPassword) : await signUp(email, submittedPassword); await onAuthChanged(); if (result.access_token) setEmail(""); setMessage(result.access_token ? "已验证登录；当前账户的本机待同步记录会在联网时上传。" : "注册成功，请到邮箱完成验证后登录。"); } catch (reason) { await onAuthChanged(); setMessage(reason instanceof Error ? reason.message : "账户操作失败"); } finally { setBusy(false); } };
  const logout = async () => { if (busy) return; setBusy(true); signOut(); await onAuthChanged(); setBusy(false); };
  return <MyOverview email={auth.email} authenticated={loggedIn} queued={queued}><section className="account-page">
    <header className="page-header"><div className="page-title"><p className="eyebrow">弓行记 · 我的</p><h1>我的</h1><p>训练记录优先留在本机；登录后才同步到你的个人云端空间。</p></div><button onClick={() => onNavigate("plans")}>回到训练计划</button></header>
    {message && <p className="notice" role="status">{message}</p>}
    {offlineUnverified && <p className="notice" role="status">当前离线，无法向账户服务复核身份。现有凭证未被删除，但在重新联网验证前不会读取账户缓存或发送云端操作。</p>}
    <section className="account-hero"><div><span>同步状态</span><strong>{!configured ? "本机模式" : loggedIn ? "已登录并启用同步" : offlineUnverified ? "等待联网验证" : "尚未登录"}</strong><p>{queued ? `当前有 ${queued} 条待同步记录。` : "你的训练数据可随时从历史页导出。"}</p></div><i className={configured && loggedIn ? "account-orb online" : "account-orb"} aria-hidden="true" /></section>
    <section className="panel"><div className="sync-status"><h2 style={{ margin: 0, fontSize: "1.1rem" }}>账户与同步</h2>{!configured ? <span className="status-pill off"><span className="dot" />本机模式</span> : loggedIn ? <span className="status-pill on"><span className="dot" />已登录</span> : <span className="status-pill off"><span className="dot" />{offlineUnverified ? "待验证" : "未登录"}</span>}{queued > 0 && <span className="status-pill off"><span className="dot" />待同步 {queued} 条</span>}</div>
      {!configured ? <p style={{ color: "var(--neutral)", margin: "8px 0 0" }}>尚未配置云端账户服务。训练仍可本机使用和离线保存；部署时填入环境变量即可启用邮箱登录。</p> : loggedIn ? <div className="actions"><button disabled={busy} onClick={() => void logout()}>退出登录</button></div> : offlineUnverified ? <div className="actions"><button disabled={busy} onClick={() => void logout()}>清除本机登录凭证</button></div> : <form onSubmit={(event) => { event.preventDefault(); void submit("signin"); }}><label>邮箱<input type="email" required value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" /></label><label>密码（至少 8 位）<input type="password" minLength={8} required value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" /></label><div className="actions"><button className="primary" type="submit" disabled={busy}>登录</button><button type="button" disabled={busy} onClick={() => void submit("signup")}>注册</button></div></form>}
    </section>
    <section className="account-grid"><article className="panel"><h2>数据权利</h2><p>你可在“历史与统计”页导出 CSV 或 JSON；照片仅在浏览器临时处理，不上传或缓存；只保存你确认后的成绩与坐标。</p><button onClick={() => onNavigate("history")}>前往导出</button></article><article className="panel"><h2>隐私说明</h2><p>启用同步后，计划、记分、备注和统计会传至你选择的 Supabase 区域；密码由 Supabase 管理。</p></article></section>
    <section className="danger-zone"><h3>危险操作</h3><p>账户删除需要与离线队列锁共同完成。当前版本先安全禁用，避免清除其他账户或正在同步的数据。</p><button className="danger" disabled>删除我的训练数据（暂不可用）</button></section>
  </section></MyOverview>;
}

function App() {
  const alignment = useModelPreview();
  const initialized = useRef(false);
  const scoreBusy = useRef(false);
  const authRun = useRef(0), activeScoreId = useRef<string | null>(null), planActionLock = useRef(false);
  const [plans, setPlans] = useState<Plan[]>([]), [targets, setTargets] = useState<Target[]>([]), [templates, setTemplates] = useState<Template[]>([]);
  const [draft, setDraft] = useState<Omit<Plan, "id" | "status" | "revision">>(blankPlan()), [editingId, setEditingId] = useState<string | null>(null), [scoreSession, setScoreSession] = useState<ScoreSession | null>(null), [resume, setResume] = useState<ScoreSession | null>(null);
  const [auth, setAuth] = useState<AuthContext | null>(null);
  const requestedView = new URLSearchParams(window.location.search).get("view");
  const initialPage: AppPage = requestedView === "community" || requestedView === "history" || requestedView === "account" || requestedView === "plans" || requestedView === "scoring" ? requestedView : "home";
  const pageRef = useRef<AppPage>(initialPage);
  const [message, setMessage] = useState("正在载入训练计划…"), [error, setError] = useState(""), [page, setPage] = useState<AppPage>(initialPage), [queued, setQueued] = useState(0), [photoToolOpen, setPhotoToolOpen] = useState(false), [planAction, setPlanAction] = useState<string | null>(null), [editorOpen, setEditorOpen] = useState(false);
  const commitPage = (next: AppPage) => { pageRef.current = next; setPage(next); };
  const invalidateAccountState = () => { requestGate.invalidate(); setOfflineOwnerScope(null); activeScoreId.current = null; setScoreSession(null); setResume(null); setPlans([]); setTargets([]); setTemplates([]); setQueued(0); setDraft(blankPlan()); setEditingId(null); setEditorOpen(false); setPhotoToolOpen(false); };
  useEffect(() => { pageRef.current = page; }, [page]);
  const load = async () => { try { const [p, t, m] = await Promise.all([api<Plan[]>("/training-plans", undefined, {}, { lane: "plans" }), api<Target[]>("/targets", undefined, {}, { lane: "targets" }), api<Template[]>("/plan-templates", undefined, {}, { lane: "templates" })]); setPlans(p); setTargets(t); setTemplates(m); setMessage(p.length ? "" : "还没有计划。可从下方模板开始，或新建一个。"); } catch (reason) { if (!(reason instanceof StaleRequestError)) { setError(reason instanceof Error ? reason.message : "无法连接本机服务"); setMessage(""); } } };
  const loadResume = async () => {
    const owner = captureOfflineOwnerContext();
    if (!owner) return;
    const key = activeSessionKeyFor(owner);
    try {
      const id = localStorage.getItem(key);
      const candidate = id ? await api<ScoreSession>(`/training-sessions/${id}`, undefined, { sessionId: id }, { owner, lane: "resume" }) : await api<ScoreSession | null>("/training-sessions/drafts/latest", undefined, {}, { owner, lane: "resume" });
      if (!isOfflineOwnerContextCurrent(owner)) return;
      if (candidate && isResumableSession(candidate)) { requestGate.observe(candidate.id, candidate.revision); setResume(candidate); }
      else { localStorage.removeItem(key); setResume(null); }
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 404 && isOfflineOwnerContextCurrent(owner)) localStorage.removeItem(key);
      if (!(reason instanceof StaleRequestError) && !isRetryableTransportError(reason)) setError(reason instanceof Error ? reason.message : "无法恢复记分草稿");
    }
  };
  const sync = async () => {
    const owner = captureOfflineOwnerContext();
    if (!owner) return;
    const accessToken = verifiedTokenFor(owner.ownerScope);
    const result = await flushQueue(async (request) => {
      if (!isOfflineOwnerContextCurrent(owner)) throw new StaleRequestError();
      const match = request.path.match(/^\/training-sessions\/([^/]+)/);
      // If-Match still reaches the server. Local optimistic revisions must not
      // reject acknowledgements for earlier operations in the same serial queue.
      return api<ScoreSession>(request.path, request.options, { sessionId: match?.[1] }, { owner, accessToken, lane: `sync:${match?.[1] ?? request.id}` });
    });
    if (!isOfflineOwnerContextCurrent(owner)) return;
    setQueued(result.remaining);
    if (result.sent) {
      setMessage(`已同步 ${result.sent} 条离线记录。`);
      const id = localStorage.getItem(activeSessionKeyFor(owner));
      if (id) {
        const fresh = await readCache<ScoreSession>(`/training-sessions/${id}`, owner);
        if (fresh && isResumableSession(fresh)) { requestGate.observe(fresh.id, fresh.revision); setScoreSession(current => current?.id === id && fresh.revision >= current.revision ? fresh : current); setResume(fresh); }
        else if (fresh?.status === "CONFIRMED") { localStorage.removeItem(activeSessionKeyFor(owner)); setResume(null); }
      }
    }
  };
  const establishAuth = async () => {
    const run = ++authRun.current;
    invalidateAccountState();
    setMessage("正在建立安全工作区…"); setError("");
    const next = await resolveAuthContext();
    if (run !== authRun.current) return;
    setOfflineOwnerScope(next.ownerScope);
    setAuth(next);
    if (!next.ownerScope) { commitPage("account"); setMessage(""); setError(next.mode === "OFFLINE_UNVERIFIED" ? "当前离线，无法验证账户；凭证已保留，重新联网后会自动复核。" : "请先登录；未验证身份时不会读取任何账户缓存或数据。"); return; }
    const owner = captureOfflineOwnerContext();
    if (!owner) return;
    await Promise.all([load(), loadResume(), pendingCount(owner).then(count => { if (run === authRun.current && isOfflineOwnerContextCurrent(owner)) setQueued(count); })]);
    if (run === authRun.current && isOfflineOwnerContextCurrent(owner) && navigator.onLine) await sync();
  };
  useEffect(() => {
    registerServiceWorker();
    const refresh = () => { if (configured && token() && !captureOfflineOwnerContext()) void establishAuth(); else if (captureOfflineOwnerContext()) { const owner = captureOfflineOwnerContext()!; void pendingCount(owner).then(count => { if (isOfflineOwnerContextCurrent(owner)) setQueued(count); }); void sync(); } };
    window.addEventListener("online", refresh);
    const storageChanged = (e: StorageEvent) => { if (configured && e.storageArea === localStorage && isAuthStorageKey(e.key)) { setAuth(null); void establishAuth(); } };
    window.addEventListener("storage", storageChanged);
    if (!initialized.current) { initialized.current = true; void establishAuth(); }
    return () => { window.removeEventListener("online", refresh); window.removeEventListener("storage", storageChanged); };
  }, []);
  const chooseTemplate = (template: Template) => { const { key: _key, ...data } = template; setDraft({ ...data, blocks: data.blocks.map((block) => ({ ...block })) }); setEditingId(null); setEditorOpen(true); setError(""); window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" }); };
  const runPlanAction = async (key: string, work: () => Promise<void>) => { if (planActionLock.current || planAction !== null) return; try { planActionLock.current = true; setPlanAction(key); setError(""); await work(); } catch (reason) { if (!(reason instanceof StaleRequestError)) setError(reason instanceof Error ? reason.message : "操作失败，请重试"); } finally { planActionLock.current = false; setPlanAction(null); } };
  const save = async (event: React.FormEvent) => { event.preventDefault(); await runPlanAction("save", async () => { const saved = await api<Plan>(editingId ? `/training-plans/${editingId}` : "/training-plans", { method: editingId ? "PUT" : "POST", body: JSON.stringify(draft) }); setDraft(blankPlan()); setEditingId(null); setEditorOpen(false); await load(); setMessage(`已保存“${saved.name}”。现在可以开始训练。`); }); };
  const edit = (plan: Plan) => { const { id: _id, status: _status, revision: _revision, ...data } = plan; setDraft({ ...data, blocks: data.blocks.map((block) => ({ ...block })) }); setEditingId(plan.id); setEditorOpen(true); setError(""); window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" }); };
  const copy = async (plan: Plan) => { await runPlanAction(`copy:${plan.id}`, async () => { await api(`/training-plans/${plan.id}/copy`, { method: "POST" }); await load(); setMessage("已创建副本，可继续编辑。"); }); };
  const archive = async (plan: Plan) => { if (!window.confirm(`归档“${plan.name}”？归档后不能直接开始训练。`)) return; await runPlanAction(`archive:${plan.id}`, async () => { await api(`/training-plans/${plan.id}/archive`, { method: "POST" }); await load(); setMessage("计划已归档，历史训练不受影响。"); }); };
  const openScore = (session: ScoreSession) => { if (!isResumableSession(session)) return; requestGate.invalidate(); requestGate.observe(session.id, session.revision); const owner = captureOfflineOwnerContext(); if (owner) localStorage.setItem(activeSessionKeyFor(owner), session.id); activeScoreId.current = session.id; setResume(session); setScoreSession(session); commitPage("scoring"); };
  const applyScoreChange = (session: ScoreSession) => { if (activeScoreId.current !== session.id) return; requestGate.observe(session.id, session.revision); setScoreSession(session); const owner = captureOfflineOwnerContext(); if (session.status === "CONFIRMED") { if (owner) localStorage.removeItem(activeSessionKeyFor(owner)); setResume(null); } else { if (owner) localStorage.setItem(activeSessionKeyFor(owner), session.id); setResume(session); } };
  const start = async (plan: Plan) => { if (resume) { if (window.confirm("已有未完成训练。为避免遗失，先继续并结束当前训练？")) openScore(resume); return; } await runPlanAction(`start:${plan.id}`, async () => { const created = await api<{ id: string }>(`/training-plans/${plan.id}/start`, { method: "POST" }); const session = await api<ScoreSession>(`/training-sessions/${created.id}`, undefined, { sessionId: created.id }, { lane: "start-session" }); openScore(session); }); };
  const leaveScore = (next: AppPage) => { requestGate.invalidate(); activeScoreId.current = null; if (scoreSession?.status === "CONFIRMED") { const owner = captureOfflineOwnerContext(); if (owner) localStorage.removeItem(activeSessionKeyFor(owner)); setResume(null); } else if (scoreSession) setResume(scoreSession); setScoreSession(null); setPhotoToolOpen(false); commitPage(next); };
  const exitScore = () => { if (!scoreBusy.current) leaveScore("home"); };
  const reviewScore = () => { if (!scoreSession || scoreBusy.current) return; const url = new URL(window.location.href); url.searchParams.set("view", "history"); url.searchParams.set("session", scoreSession.id); window.history.replaceState(null, "", url); leaveScore("history"); };
  useEffect(() => { const warn = (e: BeforeUnloadEvent) => { if (scoreBusy.current || queued > 0) { e.preventDefault(); e.returnValue = ""; } }; window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn); }, [queued]);
  const navigate = (next: AppPage) => {
    if (scoreBusy.current) { window.alert("正在保存当前成绩，请稍候再离开。"); return; }
    if (pageRef.current === "scoring" && next !== "scoring" && photoToolOpen && !window.confirm("离开会释放当前照片、校准和未确认候选；已确认保存的成绩不受影响。确定离开？")) return;
    if (pageRef.current === "history" || next === "history") {
      const url = new URL(window.location.href); url.searchParams.set("view", next);
      ["session", "tab", "focus"].forEach(key => url.searchParams.delete(key));
      window.history.replaceState(null, "", url);
      if (pageRef.current === "history" && next === "history") { window.dispatchEvent(new PopStateEvent("popstate")); return; }
    }
    const desired = nextNavigationState({ page: pageRef.current === "community" ? "home" : pageRef.current, scoringSessionId: activeScoreId.current, resumeSessionId: resume?.id ?? null }, next === "community" ? "home" : next);
    if (next === "scoring") { if (resume) openScore(resume); else { requestGate.invalidate(); commitPage("scoring"); } return; }
    if (desired.scoringSessionId === null && pageRef.current === "scoring") leaveScore(next);
    else { requestGate.invalidate(); commitPage(next); }
  };
  const setShowHistory = (show: boolean) => { if (show) navigate("history"); };
  const setShowAccount = (show: boolean) => { if (show) navigate("account"); };
  alignment.guard.current = () => { if (scoreBusy.current || planActionLock.current) { window.alert("正在保存，请稍候再打开示例。"); return false; } if (photoToolOpen) { window.alert("请先完成或取消当前照片核对，再打开示例。"); return false; } return true; };
  if (!auth) return <main className="loading-page"><p className="eyebrow">弓行记</p><h1>正在建立安全工作区…</h1><p>账户身份确认完成前不会读取本机训练缓存。</p></main>;
  if (page === "scoring" && scoreSession) return <AppShell active="scoring" onNavigate={navigate} queued={queued}><ScoringWorkbench session={scoreSession} onChange={applyScoreChange} onExit={exitScore} onReview={reviewScore} onSavingChange={(busy) => { scoreBusy.current = busy; }} onPhotoStateChange={setPhotoToolOpen} send={(path, options, base) => api<ScoreSession>(path, options, base, { lane: `score:${base.sessionId}` })} /></AppShell>;
  if (page === "history") return <AppShell active="history" onNavigate={navigate} queued={queued}><HistoryPage onNavigate={navigate} onSavingChange={(busy) => { scoreBusy.current = busy; }} /></AppShell>;
  if (page === "account") return <AppShell active="account" onNavigate={navigate} queued={queued}><AccountPage onNavigate={navigate} queued={queued} auth={auth} onAuthBoundaryStart={invalidateAccountState} onAuthChanged={establishAuth} /></AppShell>;
  if (page === "scoring") return <AppShell active="scoring" onNavigate={navigate} queued={queued}><main className="empty-score-page"><p className="eyebrow">弓行记 · 记分</p><h1>还没有进行中的训练</h1><p>这次怎么训练？数字与点靶始终共用同一份记录。</p><section className="alignment-card"><button className="alignment-feature" onClick={()=>navigate("plans")}><span><strong>训练计划</strong><small>选择已有计划或新建 · 真实保存</small></span><span>›</span></button><button className="alignment-feature" onClick={()=>alignment.open("quick")}><span><strong>临时训练</strong><small>靶面与距离 → 录入 · 示例，不保存</small></span><span>›</span></button></section><button onClick={()=>alignment.open("builder")}>查看完整训练编排</button></main></AppShell>;
  if (page === "community") return <AppShell active="community" onNavigate={navigate} queued={queued}><CommunityPage /></AppShell>;
  if (page === "home") return <AppShell active="home" onNavigate={navigate} queued={queued}><TrainingHome resume={resume} planCount={plans.filter(p => p.status === "ACTIVE").length} error={error} onStart={() => resume ? openScore(resume) : navigate("plans")} onPlans={() => navigate("plans")} onReview={() => navigate("history")} /></AppShell>;
return <AppShell active="plans" onNavigate={navigate} queued={queued}><main className="plans-page"><header className="score-header figma-page-heading"><div className="heading-lockup"><span className="page-logo"><img src="/ui/logo-mark.png" alt="" /></span><div><p className="eyebrow">弓行记 · 训练前</p><h1>训练计划</h1><p>选择模板，按自己的训练量调整后开始。</p></div></div><div className="actions"><button className="primary" onClick={() => { setDraft(blankPlan()); setEditingId(null); setEditorOpen(true); window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" }); }}>新建计划</button><button onClick={() => setShowHistory(true)}>历史与统计</button><button onClick={() => setShowAccount(true)}>我的{queued ? ` · 待同步 ${queued}` : ""}</button></div></header>{error && <p className="notice error" role="alert">{error}</p>}{message && <p className="notice" role="status">{message}</p>}{resume && <section className="resume"><div><strong>有未完成的记分草稿</strong><p>{resume.target.name} · 已录入 {resume.ends.reduce((sum, end) => sum + end.arrows.length, 0)} 箭</p></div><button className="primary" onClick={() => openScore(resume)}>恢复草稿</button></section>}<section><h2>从模板开始</h2><div className="cards">{templates.map((template) => <article className="card" key={template.key}><h3>{template.name}</h3><p>{template.description}</p><small>{template.default_end_count} 组 × {template.default_arrows_per_end} 箭 · {template.distance_m} 米</small><button onClick={() => chooseTemplate(template)}>使用此模板</button></article>)}</div></section><section><h2>我的计划</h2>{plans.length === 0 ? <div className="empty">尚未保存计划。模板不会自动写入你的数据；选择后保存才会创建计划。</div> : <div className="cards">{plans.map((plan) => <article className="card" key={plan.id}><div className="row"><h3>{plan.name}</h3><span className={plan.status === "ARCHIVED" ? "tag archived" : "tag"}>{plan.status === "ARCHIVED" ? "已归档" : "可使用"}</span></div><p>{plan.distance_m} 米 · {plan.default_end_count} 组 × {plan.default_arrows_per_end} 箭 · {plan.blocks.length} 个区块</p><div className="actions"><button onClick={() => edit(plan)}>编辑</button><button onClick={() => copy(plan)}>复制</button>{plan.status === "ACTIVE" && <><button className="primary" onClick={() => start(plan)}>开始训练</button><button className="text" onClick={() => archive(plan)}>归档</button></>}</div></article>)}</div>}</section>{editorOpen && <TrainingPlanEditor value={draft} targets={targets} editing={Boolean(editingId)} busy={planAction==='save'} onChange={setDraft} onSave={save} onCancel={()=>{setEditingId(null);setDraft(blankPlan());setEditorOpen(false);}} /> }</main></AppShell>;
}
window.addEventListener('hashchange',redirectAuthReturn);
if (!redirectAuthReturn()) createRoot(document.getElementById("root")!).render(<React.StrictMode><AlignedExperience><App /></AlignedExperience></React.StrictMode>);
