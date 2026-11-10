import type { OfflineSyncSummary } from "../../sync-contract";
import { resolveTargetContract } from "../../target-contract";
import type {
  ApiScoreStatisticsV1,
  AuthoritativeScoreStatistics,
  ConfirmedHistorySnapshotApiV1,
  ConfirmedHistorySnapshotV1,
  HistoryComparisonSpecification,
  HistoryDataState,
  HistoryPeriod,
  HistoryReadMode,
  HistorySnapshotLoadFailureV1,
} from "./history-contract";
import { assertPeriod } from "./history-period";

export type HistoryOwnerContext = Readonly<{ ownerScope: string; generation: number }>;
export type HistoryRequestToken = Readonly<{
  ownerScope: string;
  ownerGeneration: number;
  requestSequence: number;
  period: HistoryPeriod;
}>;

function statistics(input: ApiScoreStatisticsV1): AuthoritativeScoreStatistics {
  return {
    arrowCount: input.arrow_count,
    hitCount: input.hit_count,
    totalScore: input.total_score,
    averageScore: input.average_score,
    hitRate: input.hit_rate,
    xCount: input.x_count,
    tenCount: input.ten_count,
    missCount: input.miss_count,
    ringDistribution: input.ring_distribution,
  };
}

function specification(input: ConfirmedHistorySnapshotApiV1["sessions"][number]["comparison"]["specification"]): HistoryComparisonSpecification {
  return {
    bowType: input.bow_type,
    distanceM: input.distance_m,
    target: resolveTargetContract(input.target),
    plannedEndCount: input.planned_end_count,
    arrowsPerEnd: input.arrows_per_end,
    completionMode: input.completion_mode,
    scoredBlocks: input.scored_blocks.map(block => ({
      position: block.position,
      blockType: block.block_type,
      endCount: block.end_count,
      arrowsPerEnd: block.arrows_per_end,
    })),
  };
}

function stateFor(api: ConfirmedHistorySnapshotApiV1, sync: OfflineSyncSummary, readMode: HistoryReadMode): HistoryDataState {
  // This literal only proves coverage of the score mutations implemented by
  // A today. It is not a promise that future history, plan, or sync sources are
  // complete; an unknown future value must therefore fail closed.
  if ((sync as { sourceCompleteness?: unknown }).sourceCompleteness !== "CONFIRMED_SCORE_MUTATIONS_ONLY") return "INCOMPLETE";
  if (sync.hasUnknownOwnerLegacyData) return "INCOMPLETE";
  if (sync.sessions.some(item => item.state === "CONFLICT")) return "CONFLICT";
  if (sync.sessions.some(item => item.state === "BLOCKED")) return "INCOMPLETE";
  if (sync.pending > 0 || sync.sessions.some(item => item.state === "PENDING" || item.state === "RETRYABLE")) return "PENDING_SYNC";
  if (api.coverage.period_membership !== "COMPLETE") return "INCOMPLETE";
  if (readMode === "OWNER_SCOPED_CACHE") return "STALE_CACHE";
  return "READY";
}

function samePeriod(left: HistoryPeriod, right: HistoryPeriod): boolean {
  return left.kind === right.kind
    && left.startLocalDate === right.startLocalDate
    && left.endLocalDateExclusive === right.endLocalDateExclusive
    && left.timeZone === right.timeZone;
}

function buildConfirmedHistorySnapshot(
  api: ConfirmedHistorySnapshotApiV1,
  sync: OfflineSyncSummary,
  readMode: HistoryReadMode,
): ConfirmedHistorySnapshotV1 {
  if (api.version !== 1) throw new Error("不支持的历史快照版本");
  if (sync.ownerScope !== api.owner_scope) throw new Error("历史快照与当前账户不一致，已拒绝使用");
  if (api.sessions.some(session => session.status !== "CONFIRMED")) throw new Error("历史快照包含未确认训练，已拒绝使用");
  const state = stateFor(api, sync, readMode);
  const range = assertPeriod({
    kind: api.range.kind,
    startLocalDate: api.range.start_local_date,
    endLocalDateExclusive: api.range.end_local_date_exclusive,
    timeZone: api.range.time_zone,
  });
  return {
    version: 1,
    ownerScope: api.owner_scope,
    range,
    coverage: {
      kind: api.coverage.kind,
      queryConsistency: api.coverage.query_consistency,
      periodMembership: api.coverage.period_membership,
      allHistoryClaimed: api.coverage.all_history_claimed,
      unlocatedLegacyDateSessionCount: api.coverage.unlocated_legacy_date_session_count,
      legacyFallbackShownCount: api.coverage.legacy_fallback_shown_count,
      unknownDateSessionCount: api.coverage.unknown_date_session_count,
    },
    source: {
      authority: "BACKEND_CONFIRMED",
      readMode,
      state,
      comparisonEligible: state === "READY",
      sync,
    },
    sessions: api.sessions.map(session => ({
      id: session.id,
      revision: session.revision,
      status: session.status,
      dateEvidence: {
        basis: session.date_evidence.basis,
        localDate: session.date_evidence.local_date,
        startedAtUtc: session.date_evidence.started_at_utc,
        confirmedAtRaw: session.date_evidence.confirmed_at_raw,
        timeZone: session.date_evidence.time_zone,
        trustedForPeriodComparison: session.date_evidence.trusted_for_period_comparison,
      },
      comparison: {
        eligible: state === "READY" && session.comparison.eligible,
        reason: session.comparison.reason ?? (state === "READY" ? null : "SOURCE_NOT_TRUSTED"),
        key: session.comparison.key,
        specification: specification(session.comparison.specification),
      },
      statistics: statistics(session.statistics),
    })),
    groups: state === "READY" ? api.groups.map(group => ({
      comparisonKey: group.comparison_key,
      specification: specification(group.specification),
      sessionCount: group.session_count,
      statistics: statistics(group.statistics),
      trend: group.trend.map(point => ({
        sessionId: point.session_id,
        localDate: point.local_date,
        arrowCount: point.arrow_count,
        totalScore: point.total_score,
        averageScore: point.average_score,
      })),
    })) : [],
    warnings: api.warnings,
  };
}

/**
 * Owns the request epoch, so callers cannot validate a late response by
 * accidentally re-reading only the current owner or period. Each begin call
 * supersedes the previous token, even when owner and period are unchanged.
 */
export class HistorySnapshotRequestGate {
  private requestSequence = 0;
  private active: HistoryRequestToken | null = null;
  private readonly readCurrentOwner: () => HistoryOwnerContext | null;

  constructor(readCurrentOwner: () => HistoryOwnerContext | null) {
    this.readCurrentOwner = readCurrentOwner;
  }

  begin(period: HistoryPeriod): HistoryRequestToken {
    const owner = this.readCurrentOwner();
    if (!owner) throw new Error("尚未建立账户作用域，不能读取历史快照");
    const token = Object.freeze({
      ownerScope: owner.ownerScope,
      ownerGeneration: owner.generation,
      requestSequence: ++this.requestSequence,
      period: Object.freeze(assertPeriod(period)),
    });
    this.active = token;
    return token;
  }

  invalidate(): void {
    this.requestSequence += 1;
    this.active = null;
  }

  private assertCurrent(token: HistoryRequestToken): void {
    const currentOwner = this.readCurrentOwner();
    if (token !== this.active) throw new Error("历史请求已被更新请求取代，已拒绝迟到响应");
    if (!currentOwner || token.ownerScope !== currentOwner.ownerScope || token.ownerGeneration !== currentOwner.generation) {
      throw new Error("账户作用域已变化，已拒绝迟到历史响应");
    }
  }

  accept(
    token: HistoryRequestToken,
    api: ConfirmedHistorySnapshotApiV1,
    sync: OfflineSyncSummary,
    readMode: HistoryReadMode,
  ): ConfirmedHistorySnapshotV1 {
    this.assertCurrent(token);
    if (api.owner_scope !== token.ownerScope || sync.ownerScope !== token.ownerScope) {
      throw new Error("历史快照、缓存与当前账户不一致，已拒绝使用");
    }
    const responsePeriod = assertPeriod({
      kind: api.range.kind,
      startLocalDate: api.range.start_local_date,
      endLocalDateExclusive: api.range.end_local_date_exclusive,
      timeZone: api.range.time_zone,
    });
    if (!samePeriod(responsePeriod, token.period)) throw new Error("历史响应周期与当前请求不一致，已拒绝使用");
    const result = buildConfirmedHistorySnapshot(api, sync, readMode);
    this.active = null;
    return result;
  }

  fail(
    token: HistoryRequestToken,
    sync: OfflineSyncSummary,
    message: string,
  ): HistorySnapshotLoadFailureV1 {
    this.assertCurrent(token);
    if (sync.ownerScope !== token.ownerScope) throw new Error("同步状态与当前账户不一致，已拒绝使用");
    const result: HistorySnapshotLoadFailureV1 = {
      version: 1,
      ownerScope: token.ownerScope,
      range: token.period,
      source: {
        authority: null, readMode: "NONE", state: "LOAD_FAILED",
        comparisonEligible: false, sync,
      },
      sessions: [], groups: [], warnings: [],
      error: { code: "LOAD_FAILED", message },
    };
    this.active = null;
    return result;
  }
}
