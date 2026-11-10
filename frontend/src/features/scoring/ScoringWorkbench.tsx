import { useEffect, useRef, useState } from "react";
import { PhotoScoring } from "../../PhotoScoring";
import type { PhotoBatch } from "../../photo-geometry";
import { createRecordingLock } from "../../recording";
import { scoreFromPlotCoordinates } from "../../scoring";
import { applyOfflineScore } from "../../scoring-session";
import type { ArrowInput, End, ScoreSession } from "../../scoring-session";
import { saveScoringMutation, writeCache, hasPendingSession, captureOfflineOwnerContext, isOfflineOwnerContextCurrent } from "../../offline";
import { validFaceIndex } from "../../target-contract";
import { isResumableSession, scoreKeyLayout } from "../../request-gate";
import { TargetCanvas } from "./TargetCanvas";
import { isLegacyPhotoTargetCompatible } from "./photo-tool-contract";

type SendScore = (path: string, options: RequestInit, base: Readonly<{ sessionId: string; revision: number }>) => Promise<ScoreSession>;

export function layoutScoreKeys(codes: readonly string[]) {
  return scoreKeyLayout(codes).map((item, index) => ({ ...item, column: item.code === "M" ? 6 : index % 6 + 1 }));
}

export const isResumableScoreSession = (session: ScoreSession | null): boolean => isResumableSession(session);

const blankEnd = (session: ScoreSession): End => ({
  sequence: session.ends.length + 1,
  expected_arrow_count: session.arrows_per_end,
  status: "DRAFT",
  arrows: [],
  summary: { arrow_count: 0, total_score: 0, x_count: 0, ten_count: 0 },
});

export function ScoringWorkbench({ session, onChange, onExit, onReview, onSavingChange, onPhotoStateChange, send }: { session: ScoreSession; onChange(session: ScoreSession): void; onExit(): void; onReview(): void; onSavingChange(busy: boolean): void; onPhotoStateChange(open: boolean): void; send: SendScore }) {
  const [editing, setEditing] = useState<number | null>(null);
  const [faceIndex, setFaceIndex] = useState<number | null>(session.target.face_count === 1 && session.target.scoring_mode === "RING_GEOMETRY" ? 1 : null);
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState("");
  const [saving, setSaving] = useState(false);
  const [photoOpen, setPhotoOpen] = useState(false);
  const [finishOpen, setFinishOpen] = useState(false);
  const [finishQueued, setFinishQueued] = useState(false);
  const saveLock = useRef(createRecordingLock());
  const photoContext = useRef<{ session: ScoreSession; end: number; face: number; remaining: number } | null>(null);
  const activeEnd = session.status === "CONFIRMED" ? null : session.ends.find((item) => item.status !== "CONFIRMED") ?? (session.ends.length < session.planned_end_count ? blankEnd(session) : null);
  const end = activeEnd ?? session.ends[session.ends.length - 1] ?? blankEnd(session);
  const geometric = session.target.scoring_mode === "RING_GEOMETRY";
  const photoCompatible = isLegacyPhotoTargetCompatible(session.target);
  const canRecord = Boolean(activeEnd) && !saving && (editing !== null || end.arrows.length < end.expected_arrow_count);
  const doneEnds = session.ends.filter((item) => item.status === "CONFIRMED").length;
  useEffect(() => () => onPhotoStateChange(false), []);
  useEffect(() => {
    if (session.status !== "CONFIRMED") return;
    let active = true;
    const owner = captureOfflineOwnerContext();
    const check = async () => {
      try {
        const pending = await hasPendingSession(`/training-sessions/${session.id}`, owner);
        if (active && isOfflineOwnerContextCurrent(owner)) setFinishQueued(pending);
      } catch { /* Keep the last known sync state when local storage is unavailable. */ }
    };
    void check();
    const timer = window.setInterval(() => void check(), 1000);
    return () => { active = false; window.clearInterval(timer); };
  }, [session.id, session.status, session.revision]);

  const persist = async (path: string, options: RequestInit = {}): Promise<{ accepted: boolean; queued: boolean }> => {
    if (!saveLock.current.acquire()) return { accepted: false, queued: false };
    const base = { sessionId: session.id, revision: session.revision };
    const syncedOptions = { ...options, headers: { ...(options.headers ?? {}), "If-Match": String(base.revision) } };
    onSavingChange(true);
    setSaving(true);
    setError("");
    try {
      const result = await saveScoringMutation(path, syncedOptions, (p, opts) => send(p, opts, base), () => applyOfflineScore(session, path, syncedOptions));
      onChange(result.session);
      if (path.endsWith("/finish-early")) { setFinishQueued(result.queued); setFinishOpen(false); }
      if (!result.queued) void writeCache(`/training-sessions/${session.id}`, result.session).catch(() => undefined);
      setEditing(null);
      setFeedback(result.queued ? "离线保存成功；会在同一账户恢复联网后按顺序同步。" : "已保存");
      return { accepted: true, queued: result.queued };
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "保存失败，请重试");
      return { accepted: false, queued: false };
    } finally {
      onSavingChange(false);
      setSaving(false);
      saveLock.current.release();
    }
  };

  const record = (payload: ArrowInput) => {
    if (!activeEnd || !canRecord || saveLock.current.isLocked) return;
    try { validFaceIndex(session.target, geometric ? faceIndex : null); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "请先选择靶面"); return; }
    const preview = payload.score_code ?? scoreFromPlotCoordinates(session.target, payload.plot_x_norm!, payload.plot_y_norm!);
    setFeedback(`正在记录第 ${editing ?? end.arrows.length + 1} 箭：${preview === "M" ? "M" : `${preview} 环`}…`);
    const body = JSON.stringify({ ...payload, target_face_index: geometric ? faceIndex : null });
    const base = `/training-sessions/${session.id}/ends/${end.sequence}/arrows`;
    void persist(editing === null ? base : `${base}/${editing}`, { method: editing === null ? "POST" : "PUT", body });
  };

  const chooseArrow = (sequence: number) => {
    const arrow = end.arrows.find((item) => item.sequence === sequence);
    if (!arrow || saving) return;
    setEditing(sequence);
    setFaceIndex(arrow.target_face_index ?? faceIndex);
    setFeedback(`正在修改第 ${sequence} 箭；点靶或选择新环数后立即保存。`);
  };

  const confirmPhoto = async (batch: PhotoBatch) => {
    const context = photoContext.current;
    if (!context || !saveLock.current.acquire()) throw new Error("当前无法保存，请稍后重试");
    onSavingChange(true);
    setSaving(true);
    const path = `/training-sessions/${context.session.id}/ends/${context.end}/photo-confirmations`;
    const options = { method: "POST", headers: { "If-Match": String(context.session.revision) }, body: JSON.stringify(batch) };
    try {
      const base = { sessionId: context.session.id, revision: context.session.revision };
      const result = await saveScoringMutation(path, options, (p, opts) => send(p, opts, base), () => applyOfflineScore(context.session, path, options));
      onChange(result.session);
      setEditing(null);
      setError("");
      setFeedback(result.queued ? "照片候选已明确确认并保存到当前账户的离线队列；原照片已释放。" : "照片候选已明确确认并加入本组；原照片已释放。请继续确认本组。 ");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "照片候选保存失败");
      throw reason;
    } finally {
      onSavingChange(false);
      setSaving(false);
      saveLock.current.release();
    }
  };

  if (photoOpen && photoContext.current) return <div className="photo-tool-boundary"><p className="photo-boundary-note">照片辅助是临时工具：仅明确确认后的候选进入本组；关闭或离开页面会释放照片和未确认候选。</p><PhotoScoring target={photoContext.current.session.target} targetType={photoContext.current.session.target.target_type} face={photoContext.current.face} remaining={photoContext.current.remaining} onConfirm={confirmPhoto} onClose={() => { setPhotoOpen(false); photoContext.current = null; onPhotoStateChange(false); }} /></div>;

  if (!activeEnd) {
    const totalArrows = session.ends.reduce((sum, item) => sum + item.summary.arrow_count, 0);
    const totalScore = session.ends.reduce((sum, item) => sum + item.summary.total_score, 0);
    return <main className="workbench completion-page"><header className="page-header"><div className="page-title"><p className="eyebrow">弓行记 · 训练后</p><h1>{session.completion_mode === "EARLY" ? "已按实际成绩提前结束" : session.status === "CONFIRMED" ? "训练已完成" : "各组已确认"}</h1><p>{session.status === "CONFIRMED" ? (finishQueued ? "已保存在本机，等待联网同步。" : "成绩已进入正式历史，可继续复盘。") : "本组确认与整场确认是两个边界；请检查摘要后再确认整场。"}</p></div></header>{session.completion_mode==="EARLY" && <p className="completion-facts">原计划{session.planned_end_count}组 · 实录{session.ends.length}组、{totalArrows}箭。未执行部分不计M。{finishQueued?"已保存在本机队列，联网同步后可查看正式复盘。":"原计划保留，可在复盘补记心得。"}</p>}<section className="completion-summary"><span>本次训练</span><strong>{totalScore} 分</strong><p>{totalArrows} 箭 · {session.ends.length} 组 · X {session.ends.reduce((sum, item) => sum + item.summary.x_count, 0)} · 10 {session.ends.reduce((sum, item) => sum + item.summary.ten_count, 0)}</p></section>{error && <p className="notice error" role="alert">{error}</p>}<div className="actions">{session.status !== "CONFIRMED" && <button className="primary" disabled={saving} onClick={() => void persist(`/training-sessions/${session.id}/confirm`, { method: "POST" })}>确认整场训练</button>}{session.status === "CONFIRMED" && !finishQueued && <button className="primary" disabled={saving} onClick={onReview}>查看本次复盘</button>}<button disabled={saving} onClick={onExit}>返回训练</button></div></main>;
  }

  const points = end.arrows.filter(arrow => arrow.plot_x_norm !== null && arrow.plot_y_norm !== null).length;
  const mean = end.arrows.length ? (end.summary.total_score / end.arrows.length).toFixed(2) : "—";
  return <main className="workbench unified-workbench">
    <header className="workbench-header figma-page-heading"><div className="heading-lockup"><span className="page-logo"><img src="/ui/logo-mark.png" alt="" /></span><div><p className="eyebrow">{session.distance_m}米 · {session.target.name}</p><h1>第 {end.sequence} / {session.planned_end_count} 组 <small>{doneEnds}组已确认</small></h1></div></div><button disabled={saving} onClick={()=>setFinishOpen(true)}>结束／离开</button></header>
    {finishOpen && <div className="alignment-dialog-backdrop"><section className="alignment-dialog" role="dialog" aria-modal="true" aria-label="结束或保留训练"><h2>今天先练到这里？</h2><p>原计划{session.planned_end_count}组；已录{session.ends.reduce((n,e)=>n+e.arrows.length,0)}箭。保存后按实际箭数复盘，未射部分不记M，也不改变原计划。</p><button className="primary" disabled={saving||!session.ends.some(e=>e.arrows.length)} onClick={()=>void persist(`/training-sessions/${session.id}/finish-early`,{method:"POST"})}>保存已射成绩并提前结束</button><button disabled={saving} onClick={()=>{setFinishOpen(false);onExit();}}>保留草稿，稍后继续</button><button disabled={saving} onClick={()=>setFinishOpen(false)}>返回记分</button>{error&&<p role="alert">{error}</p>}</section></div>}
    <div className="record-feedback" role="status" aria-live="polite">{error ? <span className="error">{error}</span> : feedback || "数字键或点击靶面均会立即保存 · 误点可撤销或选中箭后重录"}{!navigator.onLine && <span className="offline-pill">离线</span>}</div>
    <section className="motion-metric-card scoring-metric" aria-label="本组得分"><div className="metric-topline"><span>本组得分</span><span className="metric-status">已录 {end.arrows.length}/{end.expected_arrow_count} 箭</span></div><div className="motion-metric-value"><strong>{end.summary.total_score}</strong><span>/ {end.expected_arrow_count * 10}</span></div><p>X {end.summary.x_count} · 普通 10 {end.summary.ten_count} · 可继续数字或点靶录入</p></section>
    <section className="score-card"><div className="arrow-strip" aria-label="本组已录成绩">{Array.from({ length: end.expected_arrow_count }, (_, index) => { const arrow = end.arrows[index]; return <button key={index} aria-label={arrow ? `修改第${index + 1}箭 ${arrow.score_code}` : `第${index + 1}箭待录`} className={`arrow-chip ${editing === index + 1 ? "selected" : ""} ${arrow ? "" : "is-empty"}`} disabled={!arrow || saving} onClick={() => arrow && chooseArrow(arrow.sequence)}><small>{index + 1}</small><b>{arrow?.score_code ?? "—"}</b></button>; })}</div></section>
    <div className="canvas-toolbar"><small>{geometric ? "轻点靶面立即记分 · 环外记M" : "此靶型仅支持数字"}</small>{geometric && <button disabled={!photoCompatible || !canRecord || editing !== null || (session.target.face_count > 1 && faceIndex === null)} onClick={() => { photoContext.current = { session: structuredClone(session), end: end.sequence, face: faceIndex ?? 1, remaining: end.expected_arrow_count - end.arrows.length }; setPhotoOpen(true); onPhotoStateChange(true); }}>{photoCompatible ? "照片辅助 · 实验" : "照片暂不支持"}</button>}</div>
    {session.target.face_count > 1 && geometric && <section className="face-picker"><strong>录入靶位</strong>{session.target.layout?.faces.map(face => <button key={face.index} disabled={saving} className={faceIndex === face.index ? "active" : ""} onClick={() => { setFaceIndex(face.index); setEditing(null); setFeedback(`已切换到 ${face.index} 号靶面；轻点落点后立即保存。`); }}>{face.index}号</button>)}</section>}
    <div className="workbench-canvas"><TargetCanvas target={session.target} arrows={end.arrows} faceIndex={faceIndex} selectedSequence={editing} disabled={!canRecord || session.target.face_count > 1 && faceIndex === null} onSelectArrow={chooseArrow} onPointSelect={point => { setError(""); record({ source: "MANUAL_TARGET", plot_x_norm: point.x, plot_y_norm: point.y }); }} />{!geometric && <p className="canvas-unavailable">无几何规则，不生成或伪造坐标。</p>}</div>
    <section className="score-keys" aria-label="数字记分键盘">{layoutScoreKeys(session.target.allowed_score_codes).map(({ code, column }) => <button key={code} style={{ gridColumn: column }} aria-label={code === "M" ? "M 脱靶" : `${code} 环`} className={code === "M" ? "key-miss" : ""} disabled={!canRecord} onClick={() => record({ score_code: code, source: "MANUAL_NUMBER" })}>{code}</button>)}</section>
    {editing !== null && <div className="edit-note"><span>修改第{editing}箭，点靶或选新环数后立即保存。</span><button disabled={saving} onClick={() => setEditing(null)}>取消修改</button></div>}
    <section className="score-actions"><button disabled={!end.arrows.length || saving} onClick={() => void persist(`/training-sessions/${session.id}/ends/${end.sequence}/undo`, { method: "POST" })}>撤销上一箭</button><button disabled={!end.arrows.length || saving} onClick={() => window.confirm("清空当前组已录成绩？确认后重新录入。") && void persist(`/training-sessions/${session.id}/ends/${end.sequence}/redo`, { method: "POST" })}>清空本组</button><button className="primary" disabled={saving || end.arrows.length !== end.expected_arrow_count} onClick={() => void persist(`/training-sessions/${session.id}/ends/${end.sequence}/confirm`, { method: "POST" })}>确认本组 {end.arrows.length}/{end.expected_arrow_count}</button></section>
    <section className="live-score-summary" aria-label="本组实时统计"><div><strong>{end.summary.total_score}</strong><small>本组总分</small></div><div><strong>{mean}</strong><small>平均环</small></div><div><strong>{end.summary.x_count} / {end.summary.ten_count}</strong><small>X / 普通10</small></div><div><strong>{points}/{end.arrows.length}</strong><small>已定位箭数</small></div></section>
  </main>;
}
