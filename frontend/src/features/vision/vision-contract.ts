import type { TargetContract } from "../../target-contract";
export type { TargetContract };

export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

export type NormalizedPoint = Readonly<{ x: number; y: number }>;
export type NormalizedQuad = readonly [NormalizedPoint, NormalizedPoint, NormalizedPoint, NormalizedPoint];

export type VisionOpenContext = DeepReadonly<{
  sessionId: string;
  sessionRevision: number;
  endSequence: number;
  targetSnapshot: TargetContract;
  faceIndex: number;
  remainingArrowCount: number;
}>;

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

function positiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${label}必须是正整数`);
}

export function createVisionOpenContext(input: {
  sessionId: string;
  sessionRevision: number;
  endSequence: number;
  targetSnapshot: TargetContract;
  faceIndex: number;
  remainingArrowCount: number;
}): VisionOpenContext {
  if (!input.sessionId.trim()) throw new Error("训练场次标识不能为空");
  if (!Number.isInteger(input.sessionRevision) || input.sessionRevision < 0) throw new Error("训练版本必须是非负整数");
  positiveInteger(input.endSequence, "组序号");
  positiveInteger(input.faceIndex, "靶面序号");
  positiveInteger(input.remainingArrowCount, "剩余箭数");
  if (input.remainingArrowCount > 12) throw new Error("剩余箭数不能超过单组上限");

  const targetSnapshot = structuredClone(input.targetSnapshot);
  if (!targetSnapshot.rules_version
    || targetSnapshot.scoring_mode !== "RING_GEOMETRY"
    || !targetSnapshot.plot
    || !targetSnapshot.ring_rules?.length
    || !targetSnapshot.layout
    || targetSnapshot.layout.face_count !== targetSnapshot.face_count) {
    throw new Error("照片和视频箭点工具仅支持带完整几何规则的靶面快照");
  }
  if (input.faceIndex > targetSnapshot.face_count) throw new Error("靶面序号超出当前靶型范围");

  return deepFreeze({
    sessionId: input.sessionId,
    sessionRevision: input.sessionRevision,
    endSequence: input.endSequence,
    targetSnapshot,
    faceIndex: input.faceIndex,
    remainingArrowCount: input.remainingArrowCount,
  });
}

export const PHOTO_CANDIDATE_SOURCES = ["MANUAL_POINT", "LOCAL_HEURISTIC", "LOCAL_MODEL", "REMOTE_MODEL"] as const;
export type PhotoCandidateSource = typeof PHOTO_CANDIDATE_SOURCES[number];

export const PHOTO_REVIEW_STATES = ["UNREVIEWED", "ADJUSTED", "CONFIRMED", "REJECTED"] as const;
export type PhotoReviewState = typeof PHOTO_REVIEW_STATES[number];

export type VisionProviderDescriptor = Readonly<{
  id: string;
  version: string;
  executionBoundary: "LOCAL_MEMORY_ONLY" | "REMOTE_REQUIRES_EXPLICIT_CONSENT";
}>;

export type LocalVisionFrame = Readonly<{
  localAssetId: string;
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  localOnly: true;
}>;

export type TargetLocationCandidate = Readonly<{
  controls: NormalizedQuad;
  confidence: number | null;
  provider: VisionProviderDescriptor;
  warnings: readonly string[];
}>;

export type PhotoArrowCandidate = Readonly<{
  id: string;
  source: PhotoCandidateSource;
  imagePoint: NormalizedPoint;
  plotPoint: NormalizedPoint | null;
  confidence: number | null;
  provider: VisionProviderDescriptor | null;
  reviewState: PhotoReviewState;
  warnings: readonly string[];
}>;

export type TargetLocationRequest = Readonly<{
  context: VisionOpenContext;
  frame: LocalVisionFrame;
  signal: AbortSignal;
}>;

export interface TargetLocationProvider {
  readonly descriptor: VisionProviderDescriptor;
  locate(request: TargetLocationRequest): Promise<TargetLocationCandidate | null>;
}

export type ArrowDetectionRequest = Readonly<{
  context: VisionOpenContext;
  frame: LocalVisionFrame;
  calibration: NormalizedQuad;
  signal: AbortSignal;
}>;

export type ArrowDetectionResult = Readonly<{
  completeness: "NONE" | "PARTIAL" | "COMPLETE" | "UNKNOWN";
  candidates: readonly PhotoArrowCandidate[];
  warnings: readonly string[];
}>;

export interface ArrowDetectionProvider {
  readonly descriptor: VisionProviderDescriptor;
  detect(request: ArrowDetectionRequest): Promise<ArrowDetectionResult>;
}

export const VISION_UI_STATES = [
  "CLOSED",
  "SOURCE_SELECTION",
  "CAMERA_PERMISSION_REQUIRED",
  "CAMERA_PERMISSION_DENIED",
  "CAMERA_UNAVAILABLE",
  "ACQUIRING_IMAGE",
  "DECODING_IMAGE",
  "IMAGE_DECODE_FAILED",
  "CHECKING_CAPTURE_QUALITY",
  "CAPTURE_QUALITY_UNKNOWN",
  "CAPTURE_UNUSABLE",
  "LOCATING_TARGET",
  "TARGET_LOCATION_FOUND",
  "TARGET_LOCATION_NOT_FOUND",
  "MANUAL_CALIBRATION_REQUIRED",
  "CALIBRATING_MANUALLY",
  "CALIBRATION_INVALID",
  "CALIBRATION_CONFIRMED",
  "DETECTING_ARROWS",
  "DETECTION_FAILED",
  "NO_CANDIDATES",
  "PARTIAL_CANDIDATES",
  "LOW_CONFIDENCE_CANDIDATES",
  "REVIEWING_CANDIDATES",
  "READY_TO_CONFIRM",
  "SAVING_CONFIRMATION",
  "REMOTE_ACCEPTED",
  "QUEUED_ACCEPTED",
  "RESULT_UNKNOWN",
  "REVISION_CONFLICT_409",
  "HTTP_REJECTED",
  "CANCELLED_UNSUBMITTED",
] as const;
export type VisionUiState = typeof VISION_UI_STATES[number];

export type ConfirmedVisionArrow = Readonly<{
  id: string;
  plot_x_norm: number;
  plot_y_norm: number;
  target_face_index: number;
}>;

export type VisionConfirmationBatch = Readonly<{
  confirmed: true;
  arrows: readonly ConfirmedVisionArrow[];
}>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validNormalizedPoint(point: NormalizedPoint | null): point is NormalizedPoint {
  return point !== null
    && Number.isFinite(point.x)
    && Number.isFinite(point.y)
    && point.x >= 0
    && point.x <= 1
    && point.y >= 0
    && point.y <= 1;
}

/**
 * The only bridge from local photo/model state to the existing score API.
 * It intentionally strips image coordinates, confidence, provider metadata,
 * warnings and all local-media references.
 */
export function toVisionConfirmationBatch(
  context: VisionOpenContext,
  candidates: readonly PhotoArrowCandidate[],
): VisionConfirmationBatch {
  if (!candidates.length) throw new Error("至少确认一个箭点");
  if (candidates.length > context.remainingArrowCount) throw new Error("候选箭点超过本组剩余箭数");
  const ids = new Set<string>();
  const arrows = candidates.map((candidate): ConfirmedVisionArrow => {
    if (!UUID.test(candidate.id)) throw new Error("箭点必须使用稳定 UUID");
    if (ids.has(candidate.id)) throw new Error("箭点 UUID 重复");
    ids.add(candidate.id);
    if (candidate.reviewState !== "CONFIRMED") throw new Error("所有箭点必须经过人工确认");
    if (!validNormalizedPoint(candidate.plotPoint)) throw new Error("确认箭点必须具有 0–1 校正坐标");
    return Object.freeze({
      id: candidate.id,
      plot_x_norm: candidate.plotPoint.x,
      plot_y_norm: candidate.plotPoint.y,
      target_face_index: context.faceIndex,
    });
  });
  return deepFreeze({ confirmed: true as const, arrows });
}

/** Fixed-target video observations are candidates, never Arrow.sequence writes. */
export type FixedTargetShotObservation = DeepReadonly<{
  observationId: string;
  captureSessionId: string;
  observedAtMs: number;
  proposedShotOrder: number;
  plotPoint: NormalizedPoint | null;
  confidence: number | null;
  reviewState: PhotoReviewState;
  isolation: "SHOT_OBSERVATION_NOT_ARROW_SEQUENCE";
}>;

/** Technique analysis is session-linked evidence, separate from target scoring. */
export type TechniqueObservationCandidate = DeepReadonly<{
  observationId: string;
  captureSessionId: string;
  trainingSessionId: string;
  fromMs: number;
  toMs: number;
  label: string;
  confidence: number | null;
  reviewState: PhotoReviewState;
  isolation: "TECHNIQUE_EVIDENCE_NOT_SCORE";
}>;
