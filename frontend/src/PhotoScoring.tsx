import React, { useEffect, useMemo, useRef, useState } from "react";
import { buildPhotoBatch, calibration, CONTROL_LABELS, locateTarget, project, projectInPlot } from "./photo-geometry";
import type { Candidate, PhotoBatch, Point, Quad } from "./photo-geometry";
import { importPhoto, rectifyPhoto, rotatePhoto } from "./photo-image";
import type { LocalPhoto } from "./photo-image";
import { scoreFromPlotCoordinates } from "./scoring";
import { resolveTargetContract } from "./target-contract";
import type { TargetContract } from "./target-contract";
import { photoCalibrationOptions, photoRangeMatches } from "./features/scoring/photo-tool-contract";

type Props = { targetType: string; target?: TargetContract; face: number; remaining: number; onConfirm: (batch: PhotoBatch) => Promise<void>; onClose: () => void };

export function PhotoScoring({ targetType, target, face, remaining, onConfirm, onClose }: Props) {
  const contract = useMemo(() => resolveTargetContract(target ?? targetType), [target, targetType]);
  const ringOptions = useMemo(() => photoCalibrationOptions(contract), [contract]);
  const [photoRange, setPhotoRange] = useState<string>(ringOptions[0].code);
  const [boundaryCode, setBoundaryCode] = useState<string>(ringOptions[0].code);
  const [setupConfirmed, setSetupConfirmed] = useState(false);
  const matched = photoRangeMatches(contract, photoRange);
  const boundary = ringOptions.find(ring => ring.code === boundaryCode)!;
  const rangeLabel = (code: string) => code === "1" ? "全环 · X、10–1 环" : code === "other" ? "其他／不确定" : `局部环 · X、10–${code} 环`;
  const changeSetup = (range: string, code: string, requireConfirmation: boolean) => {
    if (frozen) return;
    setPhotoRange(range); setBoundaryCode(code);
    if (requireConfirmation) setSetupConfirmed(false);
    setControls([]); setPreviewReady(false); setStep("calibrate"); setSelected(0);
    setCandidates(items => items.map(c => ({ ...c, reviewed: false }))); drag.current = null;
    setError(""); setNotice("设置已更改，请按所选环线重新定位四点；已有候选均需重新确认。");
  };
  const [photo, setPhoto] = useState<LocalPhoto | null>(null), [controls, setControls] = useState<Point[]>([]);
  const [candidates, setCandidates] = useState<Candidate[]>([]), [step, setStep] = useState<"calibrate" | "arrows">("calibrate");
  const [selected, setSelected] = useState(0), [selectedArrow, setSelectedArrow] = useState<string | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState(""), [zoom, setZoom] = useState(1);
  const [pending, setPending] = useState<PhotoBatch | null>(null), [previewReady, setPreviewReady] = useState(false);
  const preview = useRef<HTMLCanvasElement>(null), drag = useRef<{ type: "control" | "arrow"; key: number | string } | null>(null);
  const livePhoto = useRef<LocalPhoto | null>(null), generation = useRef(0), mounted = useRef(true), submitting = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const [question, setQuestion] = useState<{ message: string; resolve: (answer: boolean) => void } | null>(null);
  const questionBox = useRef<HTMLDivElement>(null);
  const frozen = busy || pending !== null || question !== null;
  useEffect(() => {
    if (!question) return;
    const previous = document.activeElement as HTMLElement | null;
    questionBox.current?.querySelector('button')?.focus();
    return () => { question.resolve(false); previous?.focus(); };
  }, [question]);
  const ask = (message: string) => new Promise<boolean>(resolve => setQuestion({ message, resolve }));
  const answer = (value: boolean) => { question?.resolve(value); setQuestion(null); };
  useEffect(() => {
    mounted.current = true; heading.current?.focus();
    return () => { mounted.current = false; generation.current++; livePhoto.current?.dispose(); livePhoto.current = null; };
  }, []);
  useEffect(() => {
    if (!photo) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [photo]);
  const geometry = useMemo(() => {
    if (!setupConfirmed || !matched || controls.length !== 4) return { value: null, error: `请在${boundary.label}的上、右、下、左四个对应点定位` };
    try { return { value: calibration(controls as Quad, boundary.ratio), error: "" }; }
    catch (e) { return { value: null, error: e instanceof Error ? e.message : "校准无效" }; }
  }, [controls, boundary.ratio, setupConfirmed, matched]);
  useEffect(() => {
    setPreviewReady(false);
    if (!photo || !geometry.value || !preview.current) return;
    const abort = new AbortController();
    void rectifyPhoto(photo.canvas, preview.current, geometry.value.toImage, abort.signal).then(() => { if (!abort.signal.aborted) setPreviewReady(true); }).catch(() => { if (!abort.signal.aborted) setError("校正预览失败，请重新定位或缩小照片"); });
    return () => abort.abort();
  }, [photo, geometry]);

  function changeControls(next: Point[]) {
    setPreviewReady(false); setControls(next); setStep("calibrate"); setCandidates(items => items.map(c => ({ ...c, reviewed: false }))); setError("");
  }
  function moveCandidate(id: string, point: Point) {
    setCandidates(items => items.map(c => c.id === id ? { ...c, point, reviewed: false } : c)); setError("");
  }
  function install(next: LocalPhoto) {
    livePhoto.current?.dispose(); livePhoto.current = next; setPhoto(next);
    const small = document.createElement("canvas");
    small.width = Math.max(1, Math.round(next.canvas.width * 300 / Math.max(next.canvas.width, next.canvas.height)));
    small.height = Math.max(1, Math.round(next.canvas.height * 300 / Math.max(next.canvas.width, next.canvas.height)));
    const ctx = small.getContext("2d")!; ctx.drawImage(next.canvas, 0, 0, small.width, small.height);
    const found = boundary.ratio === 1 ? locateTarget(ctx.getImageData(0, 0, small.width, small.height).data, small.width, small.height, targetType) : null;
    setControls(found ?? []); setCandidates([]); setSelected(0); setSelectedArrow(null); setStep("calibrate"); setZoom(1); setPending(null);
    setNotice(found ? "实验候选：已按靶色估计位置，请校准外圈四点并核对所有环线。此方法不是 AI，也没有准确率承诺。" : `请在${boundary.label}依次标出上、右、下、左四点。${boundary.ratio < 1 ? "内环定位使用人工校准，不套用外圈候选。" : "未找到可靠靶面候选，仍可手动校准。"}`);
  }
  async function load(file: File | undefined) {
    if (!file || frozen || !setupConfirmed || !matched) return;
    if (photo && !await ask("替换照片会清除当前校准与未保存箭点，继续？")) return;
    const ticket = ++generation.current; setBusy(true); setError("");
    try {
      const next = await importPhoto(file);
      if (!mounted.current || ticket !== generation.current) { next.dispose(); return; }
      install(next);
    } catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : "照片导入失败"); }
    finally { if (mounted.current && ticket === generation.current) setBusy(false); }
  }
  async function rotate() {
    if (!photo || frozen || (candidates.length > 0 && !await ask("旋转后需要重新定位和标箭，继续？"))) return;
    setBusy(true); setError("");
    try { const next = await rotatePhoto(photo); if (!mounted.current) next.dispose(); else install(next); }
    catch { setError("旋转失败，请重新导入"); }
    finally { if (mounted.current) setBusy(false); }
  }
  async function close() {
    if (submitting.current || question) return;
    if (pending && !await ask("保存结果尚未核实。退出不会撤回可能已保存的成绩，请回记分页核对，避免再次导入相同箭点。继续退出？")) return;
    if (!pending && photo && !await ask("取消照片处理？未确认候选不会写入成绩，照片与校准将释放。")) return;
    onClose();
  }
  const scoreOf = (c: Candidate) => {
    if (!setupConfirmed || !matched || !geometry.value) return "待校准";
    const p = projectInPlot(geometry.value.toPlot, c.point);
    return p ? scoreFromPlotCoordinates(contract, p.x, p.y) : "超出白边";
  };
  const allReviewed = candidates.length > 0 && candidates.every(c => c.reviewed && scoreOf(c) !== "超出白边");
  async function save() {
    if (submitting.current || busy || question || !setupConfirmed || !matched || !geometry.value || !previewReady) return;
    submitting.current = true; setBusy(true); setError("");
    try {
      const batch = pending ?? buildPhotoBatch(candidates, controls as Quad, face, remaining, boundary.ratio);
      setPending(batch);
      await onConfirm(batch);
      onClose();
    } catch (e) {
      // Keep exactly the submitted IDs and coordinates after uncertain delivery.
      setError(e instanceof Error ? e.message : "保存未完成，请重试或退出后核对本组");
    } finally { submitting.current = false; if (mounted.current) setBusy(false); }
  }
  function pointAt(e: React.PointerEvent<SVGSVGElement>): Point {
    const box = e.currentTarget.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - box.left) / box.width)), y: Math.min(1, Math.max(0, (e.clientY - box.top) / box.height)) };
  }
  function canvasDown(e: React.PointerEvent<SVGSVGElement>) {
    if (frozen || !setupConfirmed || !matched || e.button !== 0) return;
    const point = pointAt(e);
    if (step === "calibrate") {
      if (controls.length < 4) { setSelected(controls.length); changeControls([...controls, point]); }
      else changeControls(controls.map((p, i) => i === selected ? point : p));
    } else if (candidates.length < remaining) {
      const id = crypto.randomUUID(); setCandidates(items => [...items, { id, point, reviewed: false }]); setSelectedArrow(id);
    } else setError("候选数已达到本组剩余箭数；可拖动或删除现有点");
  }
  function startDrag(e: React.PointerEvent<SVGGElement>, type: "control" | "arrow", key: number | string) {
    e.stopPropagation(); if (frozen) return;
    if (type === "control") setSelected(Number(key)); else setSelectedArrow(String(key));
    drag.current = { type, key }; e.currentTarget.ownerSVGElement?.setPointerCapture(e.pointerId);
  }
  function move(e: React.PointerEvent<SVGSVGElement>) {
    if (!drag.current || frozen) return;
    const p = pointAt(e), item = drag.current;
    if (item.type === "control") changeControls(controls.map((old, i) => i === item.key ? p : old));
    else moveCandidate(String(item.key), p);
  }
  function nudge(key: string, point: Point, change: (p: Point) => void, e: React.KeyboardEvent) {
    const directions: Record<string, Point> = { ArrowLeft: { x: -.002, y: 0 }, ArrowRight: { x: .002, y: 0 }, ArrowUp: { x: 0, y: -.002 }, ArrowDown: { x: 0, y: .002 } };
    if (!directions[key] || frozen) return;
    e.preventDefault(); const d = directions[key]; change({ x: Math.min(1, Math.max(0, point.x + d.x)), y: Math.min(1, Math.max(0, point.y + d.y)) });
  }
  const selectedCandidate = candidates.find(c => c.id === selectedArrow);
  const activePoint = step === "calibrate" ? controls[selected] : selectedCandidate?.point;
  const updateActive = (p: Point) => step === "calibrate" ? changeControls(controls.map((v, i) => i === selected ? p : v)) : selectedCandidate && moveCandidate(selectedCandidate.id, p);
  const h = photo ? 1000 * photo.canvas.height / photo.canvas.width : 1000;
  const radii = ringOptions.map(ring => ring.ratio);
  return <main className="photo-workspace">
    {question && <div className="photo-confirm-backdrop"><div className="panel" role="alertdialog" aria-modal="true" aria-label="照片操作确认" aria-describedby="photo-question" ref={questionBox} onKeyDown={e => {
      if (e.key === 'Escape') { e.preventDefault(); answer(false); }
      if (e.key === 'Tab') { e.preventDefault(); const buttons = questionBox.current!.querySelectorAll('button'); (document.activeElement === buttons[0] ? buttons[1] : buttons[0]).focus(); }
    }}><p id="photo-question">{question.message}</p><div className="actions"><button onClick={() => answer(false)}>继续处理照片</button><button className="primary" onClick={() => answer(true)}>确认此操作</button></div></div></div>}
    <header className="page-header"><div className="page-title"><p className="eyebrow">照片辅助 · 人工核对</p><h1 tabIndex={-1} ref={heading}>{setupConfirmed ? "校准照片，确认箭点" : "先确认靶型与环线"}</h1><p>当前 {face} 号靶面 · 本组剩余 {remaining} 箭</p></div><button disabled={!!question || (busy && submitting.current)} onClick={() => void close()}>取消照片处理</button></header>
    <p className="photo-privacy">照片仅在本浏览器临时处理，不上传、不保存到离线缓存。刷新或退出会丢失照片；只有你确认的成绩与坐标会保存及同步。</p>
    <div className="photo-steps" aria-label="照片记分步骤"><span className={!setupConfirmed ? "active" : ""}>1 靶型与环线</span><span className={setupConfirmed && step === "calibrate" ? "active" : ""}>2 导入与校准</span><span className={step === "arrows" ? "active" : ""}>3 标箭与确认</span></div>
    <section className="panel photo-setup" aria-label="照片靶型与校准环线">
      <h2>照片中的靶面</h2>
      <div className="photo-target-summary"><svg viewBox="0 0 120 120" role="img" aria-label={`本次训练靶面示意：${rangeLabel(ringOptions[0].code)}`}>{ringOptions.map(ring => <circle key={ring.code} cx="60" cy="60" r={50 * ring.ratio} fill={ring.color} stroke="#607588" strokeWidth=".4" />)}</svg><div><strong>{contract.name}</strong><p>{rangeLabel(ringOptions[0].code)} · {contract.face_count === 1 ? "单靶" : `第 ${face} / ${contract.face_count} 靶位`}</p><small>计分规则沿用本次训练；请核对照片的颜色、环线及靶位。</small></div></div>
      <label>照片实际计分范围<select aria-label="照片实际计分范围" value={photoRange} disabled={frozen} onChange={e => changeSetup(e.target.value, boundaryCode, true)}>{Array.from(new Set([ringOptions[0].code, "1", "5", "6"])).map(code => <option key={code} value={code}>{rangeLabel(code)}</option>)}<option value="other">其他／不确定</option></select></label>
      {!matched && <p role="alert" className="notice error">照片靶型与本次训练不一致或尚未确认，不能继续录入。请返回核对训练靶型或更换照片；这里不会修改已有成绩。不同计分范围不能仅靠选择校准环线互相替代。</p>}
      <label>四点要选在哪一环？<select aria-label="校准环线" value={boundaryCode} disabled={frozen || !matched} onChange={e => changeSetup(photoRange, e.target.value, false)}>{ringOptions.map(ring => <option key={ring.code} value={ring.code}>{ring.label}{ring.ratio === 1 ? "（计分最外圈，推荐）" : ""}</option>)}</select></label>
      <p className="score-helper">四点都放在同一条环线，不选纸角。所选环越小，微小点选误差放大越明显，优先选择清晰的大环。</p>
      {setupConfirmed ? <p className="photo-setup-confirmed" role="status">已确认靶型 · 使用{boundary.label}校准</p> : <button className="primary" disabled={frozen || !matched} onClick={() => { setSetupConfirmed(true); setError(""); }}>确认靶型并开始校准</button>}
    </section>
    {error && <p className="notice error" role="alert">{error}</p>}
    {busy && <p role="status" className="save-feedback">正在处理，请稍候…</p>}
    {setupConfirmed && matched && <section className="photo-import panel"><h2>选择一张靶面照片</h2><p>JPEG / PNG / WebP，最多 20 MB。拍摄时保持靶纸平整、外圈完整，尽量正对靶面。</p><div className="actions">
      <label className={`photo-file ${frozen ? "disabled" : ""}`}>从相册导入<input type="file" accept="image/jpeg,image/png,image/webp" disabled={frozen} onChange={e => { void load(e.target.files?.[0]); e.target.value = ""; }} /></label>
      <label className={`photo-file ${frozen ? "disabled" : ""}`}>拍摄照片<input type="file" accept="image/jpeg,image/png,image/webp" capture="environment" disabled={frozen} onChange={e => { void load(e.target.files?.[0]); e.target.value = ""; }} /></label>
    </div><p className="score-helper">拍摄入口由设备提供；桌面或不支持拍摄的浏览器可从相册导入。HEIC 请先在设备上转换。</p></section>}
    {photo && setupConfirmed && matched && <>
      <p className="notice" role="status">{notice}</p>
      <div className="photo-columns"><section className="panel photo-editor"><div className="row"><h2>{step === "calibrate" ? `定位${boundary.label}四点` : "在照片上标记箭点"}</h2><button disabled={frozen} onClick={() => void rotate()}>顺时针旋转 90°</button></div>
        {step === "calibrate" ? <><p>按靶纸方向，将四点放到<strong>{boundary.label}</strong>“上、右、下、左”的对应位置（两条互相垂直直径的端点），不要选四个纸角。没有明确对应点时请重新正对拍摄。</p><div className="photo-control-picker">{CONTROL_LABELS.map((label, i) => <button key={label} className={selected === i ? "primary" : ""} disabled={frozen || i >= controls.length} onClick={() => setSelected(i)}>{label}{i >= controls.length ? "：待标" : "：调整"}</button>)}</div><p className="score-helper">{controls.length < 4 ? `下一点：${CONTROL_LABELS[controls.length]}。点击照片定位。` : "拖动控制点，或先选中上/右/下/左，再点击照片重新定位。"}</p></> : <p>点击照片补充箭点；拖动调整、列表删除。每点须人工确认。此版本不自动识别箭支。</p>}
        <label className="photo-zoom">照片放大 {zoom.toFixed(1)}×<input aria-label="照片放大" disabled={!!question} type="range" min="1" max="3" step=".25" value={zoom} onChange={e => setZoom(Number(e.target.value))} /></label>
        <div className="photo-scroll"><svg style={{ width: `${zoom * 100}%`, aspectRatio: `1000 / ${h}` }} viewBox={`0 0 1000 ${h}`} className="photo-canvas" aria-label={step === "calibrate" ? "照片校准画布" : "照片箭点画布"} onPointerDown={canvasDown} onPointerMove={move} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}>
          <image href={photo.url} x="0" y="0" width="1000" height={h} preserveAspectRatio="none" />
          {geometry.value && radii.map(r => <polyline key={r} data-calibration-ring={r === boundary.ratio || undefined} className="photo-ring-overlay" points={Array.from({ length: 65 }, (_, i) => { const a = i * Math.PI / 32; const p = project(geometry.value!.toImage, { x: .5 + 5 / 12 * r * Math.cos(a), y: .5 + 5 / 12 * r * Math.sin(a) }); return `${p.x * 1000},${p.y * h}`; }).join(" ")} />)}
          {step === "calibrate" && controls.map((p, i) => <g key={i} tabIndex={frozen ? -1 : 0} role="button" aria-label={`校准${CONTROL_LABELS[i]}点，方向键微调`} className={`photo-control ${selected === i ? "selected" : ""}`} onPointerDown={e => startDrag(e, "control", i)} onKeyDown={e => nudge(e.key, p, v => changeControls(controls.map((old, j) => i === j ? v : old)), e)}><circle className="photo-hit" cx={p.x * 1000} cy={p.y * h} r="30" /><circle cx={p.x * 1000} cy={p.y * h} r="13" /><text x={p.x * 1000} y={p.y * h - 21}>{CONTROL_LABELS[i]}</text></g>)}
          {candidates.map((c, i) => <g key={c.id} tabIndex={frozen || step !== "arrows" ? -1 : 0} role="button" aria-label={`照片第${i + 1}箭，${scoreOf(c)}，${c.reviewed ? "已确认" : "待确认"}`} className={`photo-dot ${c.reviewed ? "reviewed" : ""} ${selectedArrow === c.id ? "selected" : ""}`} onPointerDown={e => { if (step === "arrows") startDrag(e, "arrow", c.id); else e.stopPropagation(); }} onKeyDown={e => nudge(e.key, c.point, p => moveCandidate(c.id, p), e)}><circle className="photo-hit" cx={c.point.x * 1000} cy={c.point.y * h} r="28" /><circle cx={c.point.x * 1000} cy={c.point.y * h} r="12" /><text x={c.point.x * 1000} y={c.point.y * h - 20}>{i + 1}</text></g>)}
        </svg></div>
        {activePoint && <div className="photo-fine"><strong>{step === "calibrate" ? `${CONTROL_LABELS[selected]}控制点` : `选中箭点`}微调（照片百分比）</strong>{(["x", "y"] as const).map(axis => <label key={axis}>{axis === "x" ? "水平" : "垂直"}<input type="number" min="0" max="100" step=".1" value={Number((activePoint[axis] * 100).toFixed(2))} disabled={frozen} onChange={e => { const value = e.target.valueAsNumber / 100; if (Number.isFinite(value) && value >= 0 && value <= 1) updateActive({ ...activePoint, [axis]: value }); }} /></label>)}</div>}
      </section><section className="panel photo-preview"><h2>透视校正预览</h2><p className="photo-boundary-label">当前校准：{boundary.label} · 虚线突出显示</p><p>核对外圈、内环和靶心是否对齐；灰色区域表示照片没有覆盖，不能补造箭点。</p>
        {!geometry.value && <p className="notice">{geometry.error}</p>}
        <div className="photo-preview-square" hidden={!geometry.value}><canvas ref={preview} aria-label="校正后的照片" /><svg viewBox="0 0 120 120" aria-label="校正靶面环线">{radii.map(r => <circle key={r} data-calibration-ring={r === boundary.ratio || undefined} cx="60" cy="60" r={50 * r} />)}<path d="M57 60h6M60 57v6" />{geometry.value && candidates.map((c, i) => { const p = projectInPlot(geometry.value!.toPlot, c.point); return p ? <g key={c.id}><circle className="preview-dot" cx={p.x * 120} cy={p.y * 120} r="1.5" /><text x={p.x * 120 + 2} y={p.y * 120}>{i + 1}</text></g> : null; })}</svg></div>
        {geometry.value && !previewReady && <p role="status">正在生成校正预览…</p>}
        {step === "calibrate" ? <div className="actions"><button className="primary" disabled={frozen || !geometry.value || !previewReady} onClick={() => { setStep("arrows"); setError(""); }}>确认校准并标箭</button><button disabled={frozen} onClick={() => { changeControls([]); setSelected(0); }}>重新定位四点</button></div> : <button disabled={frozen} onClick={() => { setStep("calibrate"); setCandidates(items => items.map(c => ({ ...c, reviewed: false }))); }}>返回校准（箭点需重新确认）</button>}
      </section></div>
      {step === "arrows" && <section className="panel photo-candidates"><h2>待确认箭点 {candidates.length}/{remaining}</h2><p>环数是校准后的点坐标估计；压线有疑问请人工核对。正式写入后仍可修改成绩。</p>{!candidates.length && <p className="empty">还没有箭点。请在照片上点击真实落点添加。</p>}
        <ol>{candidates.map((c, i) => <li key={c.id} className={selectedArrow === c.id ? "selected" : ""}><button disabled={frozen} onClick={() => setSelectedArrow(c.id)} aria-label={`选择照片第${i + 1}箭`}>第 {i + 1} 箭 <strong>{scoreOf(c)}</strong></button><label className="check"><input type="checkbox" aria-label={`确认照片第${i + 1}箭`} checked={c.reviewed} disabled={frozen || scoreOf(c) === "超出白边"} onChange={e => setCandidates(items => items.map(item => item.id === c.id ? { ...item, reviewed: e.target.checked } : item))} />{c.reviewed ? "已确认" : "确认此点"}</label><button className="text" disabled={frozen} onClick={() => { setCandidates(items => items.filter(item => item.id !== c.id)); if (selectedArrow === c.id) setSelectedArrow(null); }}>删除第 {i + 1} 箭</button></li>)}</ol>
        <p className="score-helper">白边内的靶外点记为 M 并保存方向；超出白边范围的点请删除，返回后用数字 M 记录。</p>
        {pending && <p className="notice">此批已发起确认。为避免重复记分，重试使用同一批箭点；若版本冲突，请退出并核对本组，未核对前不要重新导入相同箭支。</p>}
        <button className="primary photo-save" disabled={busy || !!question || (!pending && (!allReviewed || candidates.length > remaining))} onClick={() => void save()}>{pending ? "重试保存同一批箭点" : `确认并加入本组 ${candidates.length} 箭`}</button>
        <p className="score-helper">仅在点击此按钮后保存；不会自动确认本组或整场训练。</p>
      </section>}
    </>}
  </main>;
}
