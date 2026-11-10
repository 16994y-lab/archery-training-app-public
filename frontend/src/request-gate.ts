import type { OfflineOwnerContext } from "./offline";
import { resolveTargetContract } from "./target-contract";
import type { TargetContract } from "./target-contract";

export type RequestResource = Readonly<{ sessionId?: string; revision?: number }>;
export type RequestTicket = Readonly<{
  owner: OfflineOwnerContext;
  epoch: number;
  lane: string;
  sequence: number;
  resource: RequestResource & Readonly<{ lane?: string }>;
}>;

export class StaleRequestError extends Error {
  readonly status = 499;
  constructor() {
    super("账户、页面或记录版本已变化，旧请求结果已丢弃");
    this.name = "StaleRequestError";
  }
}

export function isRetryableTransportError(error: unknown): boolean {
  return error instanceof TypeError && !("status" in error);
}

export type NavigationPage = "home" | "plans" | "scoring" | "history" | "account";
export type NavigationState = Readonly<{ page: NavigationPage; scoringSessionId: string | null; resumeSessionId: string | null }>;

export function nextNavigationState(current: NavigationState, next: NavigationPage): NavigationState {
  if (next === "scoring") return { ...current, page: next, scoringSessionId: current.resumeSessionId };
  return { ...current, page: next, scoringSessionId: null };
}

export const isResumableSession = (session: Readonly<{ status: string }> | null): boolean => Boolean(session && session.status !== "CONFIRMED");

export function scoreKeyLayout(codes: readonly string[]) {
  return codes.map((code, index) => ({ code, index, column: code === "M" ? 3 : undefined }));
}

export function filterArrowsForFace<T extends Readonly<{ target_face_index: number | null }>>(arrows: readonly T[], faceIndex: number | null, faceCount: number): T[] {
  if (faceCount === 1) return arrows.filter((arrow) => arrow.target_face_index === null || arrow.target_face_index === 1);
  if (faceIndex === null) return [];
  return arrows.filter((arrow) => arrow.target_face_index === faceIndex);
}

export function targetRingVisuals(target: TargetContract) {
  const contract = resolveTargetContract(target);
  if (contract.scoring_mode !== "RING_GEOMETRY" || !contract.ring_rules) return [];
  return [...contract.ring_rules].reverse().map((rule) => ({ ...rule, radiusRatio: rule.outer_radius_norm / .5 }));
}

export function createRequestGate() {
  let epoch = 0;
  const laneSequences = new Map<string, number>();
  const revisions = new Map<string, number>();
  return {
    invalidate() { epoch += 1; laneSequences.clear(); revisions.clear(); },
    capture(owner: OfflineOwnerContext | null, resource: RequestResource & Readonly<{ lane?: string }> = {}): RequestTicket | null {
      if (!owner) return null;
      const lane = resource.lane ?? "default";
      const sequence = (laneSequences.get(lane) ?? 0) + 1;
      laneSequences.set(lane, sequence);
      return Object.freeze({ owner: Object.freeze({ ...owner }), epoch, lane, sequence, resource: Object.freeze({ ...resource, lane }) });
    },
    accepts(ticket: RequestTicket | null, owner: OfflineOwnerContext | null): boolean {
      if (!ticket || !owner) return false;
      if (ticket.epoch !== epoch || ticket.owner.ownerScope !== owner.ownerScope || ticket.owner.generation !== owner.generation) return false;
      if (laneSequences.get(ticket.lane) !== ticket.sequence) return false;
      if (ticket.resource.sessionId !== undefined && ticket.resource.revision !== undefined) {
        const currentRevision = revisions.get(ticket.resource.sessionId);
        if (currentRevision !== undefined && currentRevision !== ticket.resource.revision) return false;
      }
      return true;
    },
    observe(sessionId: string, revision: number) {
      if (!sessionId || !Number.isInteger(revision) || revision < 0) return;
      const current = revisions.get(sessionId);
      if (current === undefined || revision >= current) revisions.set(sessionId, revision);
    },
    revisionOf(sessionId: string) { return revisions.get(sessionId); },
    get epoch() { return epoch; },
  };
}

export type RequestGate = ReturnType<typeof createRequestGate>;
