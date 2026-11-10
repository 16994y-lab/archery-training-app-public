import type { PhotoBatch } from "../../photo-geometry";
import { resolveTargetContract } from "../../target-contract";
import type { TargetContract } from "../../target-contract";

export type PhotoToolOpenContext = Readonly<{
  target: TargetContract;
  face: number;
  remaining: number;
  sessionId: string;
  sessionRevision: number;
  endSequence: number;
}>;

export type PhotoConfirmAcceptance = Readonly<{ state: "REMOTE_ACCEPTED" | "QUEUED_ACCEPTED" }>;

/** Labels describe scoring coverage, not a new target or a change to its rules. */
export function photoCalibrationOptions(target: TargetContract | string) {
  const contract = resolveTargetContract(target);
  if (contract.scoring_mode !== "RING_GEOMETRY" || !contract.ring_rules?.length) throw new Error("该靶型不支持照片校准");
  return [...contract.ring_rules].reverse().map(rule => ({
    code: rule.score_code,
    color: rule.color,
    ratio: rule.outer_radius_norm / .5,
    label: rule.score_code === "X" ? "X 圈边界" : `${rule.score_code} 环外沿`,
  }));
}

export function photoRangeMatches(target: TargetContract | string, outerCode: string): boolean {
  return photoCalibrationOptions(target)[0].code === outerCode;
}
export type PhotoCloseResult = Readonly<{ reason: "CANCELLED_UNSUBMITTED" | "ACCEPTED" | "UNKNOWN"; operationIds: readonly string[] }>;

export type PhotoToolProps = PhotoToolOpenContext & {
  onConfirm(batch: PhotoBatch): Promise<PhotoConfirmAcceptance>;
  onClose(result: PhotoCloseResult): void;
};

export function photoCloseReason(submitStarted: boolean, accepted: boolean, outcomeKnown: boolean): PhotoCloseResult["reason"] {
  if (accepted) return "ACCEPTED";
  if (!submitStarted) return "CANCELLED_UNSUBMITTED";
  return outcomeKnown ? "CANCELLED_UNSUBMITTED" : "UNKNOWN";
}

export function isLegacyPhotoTargetCompatible(target: TargetContract): boolean {
  try {
    const actual = resolveTargetContract(target);
    if (!["WA_10_RING", "WA_VERTICAL_3_SPOT"].includes(actual.target_type)) return false;
    const expected = resolveTargetContract(actual.target_type);
    return actual.scoring_mode === "RING_GEOMETRY"
      && actual.face_count === expected.face_count
      && actual.allowed_score_codes.join("/") === expected.allowed_score_codes.join("/")
      && JSON.stringify(actual.ring_rules) === JSON.stringify(expected.ring_rules)
      && JSON.stringify(actual.layout) === JSON.stringify(expected.layout)
      && JSON.stringify(actual.plot) === JSON.stringify(expected.plot);
  } catch {
    return false;
  }
}
