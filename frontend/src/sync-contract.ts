const ARROW_CREATE_PATH = /^\/training-sessions\/[^/]+\/ends\/\d+\/arrows$/;
const ARROW_ITEM_PATH = /^\/training-sessions\/[^/]+\/ends\/\d+\/arrows\/\d+$/;
const PHOTO_CONFIRMATION_PATH = /^\/training-sessions\/[^/]+\/ends\/\d+\/photo-confirmations$/;
const BODYLESS_SCORING_PATH = /^\/training-sessions\/[^/]+\/(?:ends\/\d+\/(?:undo|redo|confirm)|confirm|finish-early)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SCORE = /^(?:X|10|[1-9]|M)$/;

/** Add one stable resource ID before the first network attempt or local apply. */
export function withStableArrowId(path: string, options: RequestInit): RequestInit {
  if (options.method?.toUpperCase() !== "POST" || !ARROW_CREATE_PATH.test(path) || typeof options.body !== "string") return options;
  const payload = JSON.parse(options.body) as Record<string, unknown>;
  if (!payload.id) payload.id = crypto.randomUUID();
  return { ...options, body: JSON.stringify(payload) };
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]) {
  return Object.keys(value).every(key => allowed.includes(key));
}

const unitNumber = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
const faceIndex = (value: unknown) => value === null || value === undefined || Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 3;

function validArrowPayload(payload: Record<string, unknown>) {
  if (payload.id !== undefined && (typeof payload.id !== "string" || !UUID.test(payload.id))) return false;
  if (!faceIndex(payload.target_face_index)) return false;
  if (payload.source === "MANUAL_NUMBER") {
    return typeof payload.score_code === "string" && SCORE.test(payload.score_code) && payload.plot_x_norm === undefined && payload.plot_y_norm === undefined;
  }
  return payload.source === "MANUAL_TARGET" && payload.score_code === undefined && unitNumber(payload.plot_x_norm) && unitNumber(payload.plot_y_norm);
}

/** Persist only the confirmed score fields understood by the scoring API. */
export function queueSafeOptions(path: string, options: RequestInit) {
  const headers = new Headers(options.headers);
  headers.delete("Authorization");
  const hasBody = options.body !== undefined && options.body !== null;
  const body = typeof options.body === "string" ? options.body : undefined;
  const method = options.method?.toUpperCase();
  const revisionHeader = headers.get("If-Match")?.trim();
  const revisionMatch = revisionHeader?.match(/^(?:"(\d+)"|(\d+))$/);
  const revision = revisionMatch ? Number(revisionMatch[1] ?? revisionMatch[2]) : Number.NaN;
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new Error("离线记分请求必须携带合法 If-Match 修订号");
  }

  const isArrowCreate = method === "POST" && ARROW_CREATE_PATH.test(path);
  const isArrowUpdate = method === "PUT" && ARROW_ITEM_PATH.test(path);
  const isArrowDelete = method === "DELETE" && ARROW_ITEM_PATH.test(path);
  const isPhotoConfirmation = method === "POST" && PHOTO_CONFIRMATION_PATH.test(path);
  const isBodylessScoring = method === "POST" && BODYLESS_SCORING_PATH.test(path);

  if (isArrowCreate || isArrowUpdate) {
    if (!body) throw new Error("离线记分请求缺少成绩内容");
    const payload = JSON.parse(body) as unknown;
    if (!payload || typeof payload !== "object" || Array.isArray(payload) || !hasOnlyKeys(payload as Record<string, unknown>, ["id", "score_code", "plot_x_norm", "plot_y_norm", "target_face_index", "source"]) || !validArrowPayload(payload as Record<string, unknown>)) {
      throw new Error("离线队列只能保存已确认成绩字段");
    }
  } else if (isPhotoConfirmation) {
    if (!body) throw new Error("照片确认请求缺少成绩内容");
    const payload = JSON.parse(body) as { confirmed?: unknown; arrows?: unknown };
    if (!payload || typeof payload !== "object" || Array.isArray(payload) || !hasOnlyKeys(payload as Record<string, unknown>, ["confirmed", "arrows"]) || payload.confirmed !== true || !Array.isArray(payload.arrows) || !payload.arrows.length || payload.arrows.some(item => !item || typeof item !== "object" || Array.isArray(item) || !hasOnlyKeys(item as Record<string, unknown>, ["id", "plot_x_norm", "plot_y_norm", "target_face_index"]) || typeof item.id !== "string" || !UUID.test(item.id) || !unitNumber(item.plot_x_norm) || !unitNumber(item.plot_y_norm) || !Number.isInteger(item.target_face_index) || Number(item.target_face_index) < 1 || Number(item.target_face_index) > 3)) {
      throw new Error("离线队列只能保存明确确认的照片成绩字段");
    }
  } else if ((isArrowDelete || isBodylessScoring) && !hasBody) {
    // Valid bodyless scoring mutation.
  } else {
    throw new Error("该请求不属于可离线保存的记分操作");
  }
  const safeHeaders: Record<string, string> = {};
  for (const name of ["Content-Type", "If-Match"]) {
    const value = headers.get(name);
    if (value !== null) safeHeaders[name] = value;
  }
  return { method, ...(body !== undefined ? { body } : {}), headers: safeHeaders };
}

export type OfflineSyncErrorKind = "REVISION_CONFLICT" | "HTTP_REJECTED" | "RETRYABLE_TRANSPORT";
export type OfflineSyncIssue = { kind: OfflineSyncErrorKind; httpStatus: number | null };
export type OfflineSessionSyncDescriptor = {
  sessionPath: string;
  baseRevision: number | null;
  pending: number;
  state: "PENDING" | "CONFLICT" | "BLOCKED" | "RETRYABLE";
  issue: OfflineSyncIssue | null;
};
export type OfflineSyncSummary = {
  ownerScope: string | null;
  pending: number;
  hasUnknownOwnerLegacyData: boolean;
  sourceCompleteness: "CONFIRMED_SCORE_MUTATIONS_ONLY";
  sessions: OfflineSessionSyncDescriptor[];
};

export function classifyOfflineSyncError(error: unknown): OfflineSyncIssue {
  const status = error && typeof error === "object" && "status" in error && typeof error.status === "number" ? error.status : null;
  if (status === 409) return { kind: "REVISION_CONFLICT", httpStatus: status };
  if (status !== null) return { kind: "HTTP_REJECTED", httpStatus: status };
  return { kind: "RETRYABLE_TRANSPORT", httpStatus: null };
}
