export type ScoreCode = "X" | "10" | "9" | "8" | "7" | "6" | "5" | "4" | "3" | "2" | "1" | "M";
export type RingRule = { score_code: Exclude<ScoreCode, "M">; label: string; color: string; outer_radius_norm: number };
export type TargetContract = {
  id: string; name: string; target_type: string; scoring_mode: string; face_count: number;
  rules_version?: string; scoring_profile?: string; nominal_face_diameter_cm?: number | null;
  scoring_diameter_cm?: number | null; allowed_score_codes: string[];
  coordinate_space?: string | null; boundary_policy?: string | null; ring_rules?: RingRule[] | null;
  layout?: { kind: string; face_count: number; faces: { index: number; anchor_x: number; anchor_y: number }[] };
  plot?: { coordinate_space: string; center_x: number; center_y: number; outer_scoring_radius_norm: number; calibration_boundary_score_code: string; control_order: string[] } | null;
};

export const RULES_VERSION = "target-contract/v1";
export const LEGACY_RULES_VERSION = "legacy-v1";
export const PLOT_TARGET_RADIUS = 5 / 12;
const allCodes = new Set<ScoreCode>(["X", "10", "9", "8", "7", "6", "5", "4", "3", "2", "1", "M"]);

const colors: Record<string, string> = { X: "#F4D03F", "10": "#F4D03F", "9": "#F4D03F", "8": "#D64545", "7": "#D64545", "6": "#2F7DBB", "5": "#2F7DBB", "4": "#222222", "3": "#222222", "2": "#F7F7F7", "1": "#F7F7F7" };
const rings = (items: readonly (readonly [string, number])[]): RingRule[] => items.map(([score_code, outer_radius_norm]) => ({ score_code: score_code as Exclude<ScoreCode, "M">, label: score_code, color: colors[score_code], outer_radius_norm }));
const single = { kind: "SINGLE", face_count: 1, faces: [{ index: 1, anchor_x: .5, anchor_y: .5 }] };
const vertical = { kind: "VERTICAL_THREE", face_count: 3, faces: [{ index: 1, anchor_x: .5, anchor_y: .18 }, { index: 2, anchor_x: .5, anchor_y: .5 }, { index: 3, anchor_x: .5, anchor_y: .82 }] };
const full = rings([["X", .025], ["10", .05], ["9", .10], ["8", .15], ["7", .20], ["6", .25], ["5", .30], ["4", .35], ["3", .40], ["2", .45], ["1", .50]]);
const six = rings([["X", .05], ["10", .10], ["9", .20], ["8", .30], ["7", .40], ["6", .50]]);

function legacy(input: TargetContract, ring_rules: RingRule[], layout: TargetContract["layout"]): TargetContract {
  return { ...input, rules_version: LEGACY_RULES_VERSION, coordinate_space: "selected-face-scoring-square/v1", boundary_policy: "HIGHER_SCORE_INCLUSIVE", ring_rules, layout, plot: { coordinate_space: "face-with-white-buffer/v1", center_x: .5, center_y: .5, outer_scoring_radius_norm: PLOT_TARGET_RADIUS, calibration_boundary_score_code: ring_rules[ring_rules.length - 1].score_code, control_order: ["TOP", "RIGHT", "BOTTOM", "LEFT"] } };
}

export function resolveTargetContract(input: TargetContract | string): TargetContract {
  const target: TargetContract = typeof input === "string" ? { id: "legacy", name: "legacy", target_type: input, scoring_mode: "RING_GEOMETRY", face_count: input === "WA_VERTICAL_3_SPOT" ? 3 : 1, allowed_score_codes: [] } : input;
  if (target.rules_version === RULES_VERSION) return validateTargetContract(target);
  if (target.rules_version !== undefined && target.rules_version !== LEGACY_RULES_VERSION) throw new Error("未知靶面规则版本");
  if (target.target_type === "WA_10_RING") return validateTargetContract(legacy({ ...target, allowed_score_codes: ["X", "10", "9", "8", "7", "6", "5", "4", "3", "2", "1", "M"] }, full, single));
  if (target.target_type === "WA_VERTICAL_3_SPOT") return validateTargetContract(legacy({ ...target, allowed_score_codes: ["X", "10", "9", "8", "7", "6", "M"] }, six, vertical));
  if (target.target_type === "CUSTOM_SCORE_ONLY") return validateTargetContract({ ...target, rules_version: LEGACY_RULES_VERSION, ring_rules: null, layout: single, plot: null });
  throw new Error("未知靶面快照，不能自动按十环或脱靶解释");
}

export function validateTargetContract(target: TargetContract): TargetContract {
  if (target.rules_version !== RULES_VERSION && target.rules_version !== LEGACY_RULES_VERSION) throw new Error("未知靶面规则版本");
  if (!target.allowed_score_codes.length || new Set(target.allowed_score_codes).size !== target.allowed_score_codes.length || target.allowed_score_codes.some(code => !allCodes.has(code as ScoreCode))) throw new Error("靶面允许成绩配置无效");
  if (!Number.isInteger(target.face_count) || target.face_count < 1 || target.face_count > 3 || !target.layout || target.layout.face_count !== target.face_count || target.layout.faces.map(face => face.index).join() !== Array.from({ length: target.face_count }, (_, i) => i + 1).join()) throw new Error("靶面布局配置无效");
  if (target.scoring_mode !== "RING_GEOMETRY" && target.scoring_mode !== "SCORE_ONLY") throw new Error("未知靶面计分模式");
  if (target.scoring_mode === "SCORE_ONLY") {
    if (target.ring_rules != null || target.plot != null || target.coordinate_space != null) throw new Error("数字靶面不能配置环线");
    return target;
  }
  if (target.coordinate_space !== "selected-face-scoring-square/v1" || target.boundary_policy !== "HIGHER_SCORE_INCLUSIVE") throw new Error("靶面坐标或压线规则无效");
  if (!target.plot || target.plot.coordinate_space !== "face-with-white-buffer/v1" || target.plot.outer_scoring_radius_norm !== PLOT_TARGET_RADIUS) throw new Error("靶面画布契约无效");
  const rules = target.ring_rules;
  if (!rules?.length) throw new Error("靶面环线配置缺失");
  let previous = 0;
  for (const rule of rules) {
    if (!Number.isFinite(rule.outer_radius_norm) || rule.outer_radius_norm <= previous || rule.outer_radius_norm > .5) throw new Error("靶面环线配置无效");
    previous = rule.outer_radius_norm;
  }
  if (Math.abs(previous - .5) > 1e-12 || target.allowed_score_codes.join() !== [...rules.map(rule => rule.score_code), "M"].join()) throw new Error("靶面环线与允许成绩不一致");
  return target;
}

export function validFaceIndex(target: TargetContract, requested?: number | null): number | null {
  const contract = resolveTargetContract(target);
  if (contract.scoring_mode === "SCORE_ONLY") {
    if (requested != null) throw new Error("数字靶面不能填写靶面序号");
    return null;
  }
  if (contract.face_count === 1) {
    if (requested != null && requested !== 1) throw new Error("单靶面的靶面序号只能是 1");
    return 1;
  }
  if (!contract.layout!.faces.some(face => face.index === requested)) throw new Error(`多联靶请选择 1–${contract.face_count} 号靶面`);
  return requested!;
}
