import { scoreFromPlotCoordinates, targetCoordinatesFromPlot } from "./scoring";
import { resolveTargetContract, validFaceIndex } from "./target-contract";
import type { TargetContract } from "./target-contract";

export type Arrow = { id: string; sequence: number; score_code: string; x_norm: number | null; y_norm: number | null; plot_x_norm: number | null; plot_y_norm: number | null; target_face_index: number | null; source: string };
export type End = { id?: string; sequence: number; expected_arrow_count: number; status: string; arrows: Arrow[]; summary: { arrow_count: number; total_score: number; x_count: number; ten_count: number } };
export type ScoreSession = { id: string; revision: number; status: string; completion_mode?: string | null; note?: string | null; equipment_note?: string | null; target: TargetContract; distance_m: number; planned_end_count: number; arrows_per_end: number; ends: End[] };
export type ArrowInput = { id?: string; score_code?: string; x_norm?: number; y_norm?: number; plot_x_norm?: number; plot_y_norm?: number; target_face_index?: number | null; source: "MANUAL_NUMBER" | "MANUAL_TARGET" };

function updateSummary(end: End): End {
  const points = (code: string) => code === "X" || code === "10" ? 10 : code === "M" ? 0 : Number(code);
  return { ...end, arrows: end.arrows.map((arrow, index) => ({ ...arrow, sequence: index + 1 })), summary: { arrow_count: end.arrows.length, total_score: end.arrows.reduce((sum, arrow) => sum + points(arrow.score_code), 0), x_count: end.arrows.filter((arrow) => arrow.score_code === "X").length, ten_count: end.arrows.filter((arrow) => arrow.score_code === "10").length } };
}

export function applyOfflineScore(session: ScoreSession, path: string, options: RequestInit): ScoreSession {
  const next = structuredClone(session);
  if (["CONFIRMED", "DISCARDED"].includes(next.status)) throw new Error("训练已经结束，请在复盘中校正成绩");
  next.target = resolveTargetContract(next.target);
  const parts = path.split("/");
  const endSequence = Number(parts[4]);
  let end = next.ends.find(item => item.sequence === endSequence);
  if (!end && path.includes("/ends/")) {
    if (endSequence < 1 || endSequence > next.planned_end_count || next.ends.filter(e => e.sequence < endSequence && e.status === "CONFIRMED").length !== endSequence - 1) throw new Error("请先确认前一组");
    end = { sequence: endSequence, expected_arrow_count: next.arrows_per_end, status: "DRAFT", arrows: [], summary: { arrow_count: 0, total_score: 0, x_count: 0, ten_count: 0 } };
    next.ends.push(end);
  }
  const payload = options.body ? JSON.parse(String(options.body)) : undefined;
  const arrowFrom = (input: { id?: string; source: string; score_code?: string; plot_x_norm?: number; plot_y_norm?: number; target_face_index?: number | null }, sequence: number): Arrow => {
    if (!["MANUAL_NUMBER", "MANUAL_TARGET", "VISION_CONFIRMED"].includes(input.source)) throw new Error("仅支持正式数字、点靶或已确认照片成绩");
    const positioned = input.source === "MANUAL_TARGET" || input.source === "VISION_CONFIRMED";
    const px = positioned ? input.plot_x_norm : undefined, py = positioned ? input.plot_y_norm : undefined;
    if (positioned && (px === undefined || py === undefined || !Number.isFinite(px) || !Number.isFinite(py) || px < 0 || py < 0 || px > 1 || py > 1)) throw new Error("画布坐标必须成对位于 0–1");
    if (!positioned && (input.score_code === undefined || !next.target.allowed_score_codes.includes(input.score_code))) throw new Error("该靶面不支持此环数");
    const face = validFaceIndex(next.target, input.target_face_index);
    const xy = positioned ? targetCoordinatesFromPlot(px!, py!, next.target) : null;
    const score = positioned ? scoreFromPlotCoordinates(next.target, px!, py!) : input.score_code!;
    if (!next.target.allowed_score_codes.includes(score)) throw new Error("该靶面不支持此环数");
    return { id: input.id ?? crypto.randomUUID(), sequence, score_code: score, x_norm: xy?.[0] ?? null, y_norm: xy?.[1] ?? null, plot_x_norm: px ?? null, plot_y_norm: py ?? null, target_face_index: face, source: input.source };
  };
  const sameArrow = (a: Arrow, b: Arrow) => ["score_code", "x_norm", "y_norm", "plot_x_norm", "plot_y_norm", "target_face_index", "source"].every(key => a[key as keyof Arrow] === b[key as keyof Arrow]);
  let changed = true;
  if (end && path.endsWith("/photo-confirmations")) {
    if (payload?.confirmed !== true || !payload.arrows.length || end.status === "CONFIRMED" || next.status === "CONFIRMED") throw new Error("照片候选尚未确认或该组已结束");
    const photoArrows = payload.arrows as { id: string; plot_x_norm: number; plot_y_norm: number; target_face_index: number }[];
    const incoming: Arrow[] = photoArrows.map((a, i) => arrowFrom({ ...a, source: "VISION_CONFIRMED" }, end!.arrows.length + i + 1));
    const existing = incoming.map(a => end!.arrows.find(item => item.id === a.id));
    if (existing.some(Boolean)) {
      if (!existing.every((item, i) => item && sameArrow(item, { ...incoming[i], sequence: item.sequence }))) throw new Error("照片确认标识已使用且内容不一致");
      changed = false;
    } else {
      if (end.arrows.length + incoming.length > end.expected_arrow_count) throw new Error("候选箭点超过本组剩余箭数");
      end.arrows.push(...incoming); next.status = "IN_PROGRESS";
    }
  } else if (end && path.endsWith("/arrows") && options.method === "POST" && payload) {
    const incoming = arrowFrom(payload, end.arrows.length + 1);
    const existing = end.arrows.find(item => item.id === incoming.id);
    if (existing) {
      if (!sameArrow(existing, { ...incoming, sequence: existing.sequence })) throw new Error("箭点标识已使用且内容不一致");
      changed = false;
    } else {
      if (end.arrows.length >= end.expected_arrow_count) throw new Error("本组箭数已满");
      end.arrows.push(incoming); next.status = "IN_PROGRESS";
    }
  } else if (end && /\/arrows\/\d+$/.test(path) && options.method === "PUT" && payload) {
    const index = Number(parts[parts.length - 1]) - 1;
    if (end.arrows[index]) end.arrows[index] = arrowFrom({ ...payload, id: end.arrows[index].id }, index + 1);
  } else if (end && /\/arrows\/\d+$/.test(path) && options.method === "DELETE") end.arrows.splice(Number(parts[parts.length - 1]) - 1, 1);
  else if (end && path.endsWith("/undo")) end.arrows.pop();
  else if (end && path.endsWith("/redo")) end.arrows = [];
  else if (end && path.endsWith("/confirm")) {
    if (end.arrows.length !== end.expected_arrow_count) throw new Error("本组箭数不足，不能确认");
    end.status = "CONFIRMED";
    next.status = next.ends.filter(e => e.status === "CONFIRMED").length === next.planned_end_count ? "PENDING_CONFIRMATION" : "IN_PROGRESS";
  } else if (path.endsWith("/finish-early") && options.method === "POST") {
    const recorded=next.ends.filter(e=>e.arrows.length).sort((a,b)=>a.sequence-b.sequence);
    if (!recorded.length) throw new Error("尚未记录箭，不生成空成绩");
    if (recorded.some((e,i)=>e.sequence!==i+1 || i<recorded.length-1 && e.status!=="CONFIRMED")) throw new Error("请先核对之前各组的成绩");
    next.ends=recorded.map(e=>({...e,status:"CONFIRMED"}));
    next.status="CONFIRMED";
    next.completion_mode="EARLY";
  } else if (path.endsWith("/confirm")) {
    if (next.ends.length !== next.planned_end_count || next.ends.some(item => item.status !== "CONFIRMED" || item.arrows.length !== item.expected_arrow_count)) throw new Error("请先确认本次训练的每一组");
    next.status = "CONFIRMED";
  }
  if (end) next.ends[next.ends.indexOf(end)] = updateSummary(end);
  if (changed) next.revision += 1;
  return next;
}
