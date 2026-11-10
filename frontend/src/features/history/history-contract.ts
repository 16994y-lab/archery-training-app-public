import type { OfflineSyncSummary } from "../../sync-contract";
import type { ScoreCode, TargetContract } from "../../target-contract";

export type HistoryRangeKind = "WEEK" | "MONTH";
export type HistoryReadMode = "LIVE" | "OWNER_SCOPED_CACHE";
export type HistoryDataState = "READY" | "STALE_CACHE" | "PENDING_SYNC" | "CONFLICT" | "INCOMPLETE" | "LOAD_FAILED";
export type HistoryDateBasis = "STARTED_AT" | "CONFIRMED_AT_LEGACY" | "UNKNOWN";

export type HistoryPeriod = {
  kind: HistoryRangeKind;
  startLocalDate: string;
  endLocalDateExclusive: string;
  timeZone: string;
};

export type HistoryDateEvidence = {
  basis: HistoryDateBasis;
  localDate: string | null;
  startedAtUtc: string | null;
  confirmedAtRaw: string | null;
  timeZone: string | null;
  trustedForPeriodComparison: boolean;
};

export type HistoryComparisonSpecification = {
  bowType: string;
  distanceM: number;
  target: TargetContract;
  plannedEndCount: number;
  arrowsPerEnd: number;
  completionMode: string | null;
  scoredBlocks: Array<{
    position: number | null;
    blockType: string | null;
    endCount: number | null;
    arrowsPerEnd: number | null;
  }>;
};

export type AuthoritativeScoreStatistics = {
  arrowCount: number;
  hitCount: number;
  totalScore: number;
  averageScore: number | null;
  hitRate: number | null;
  xCount: number;
  tenCount: number;
  missCount: number;
  ringDistribution: Record<ScoreCode, number>;
};

export type ConfirmedHistorySessionV1 = {
  id: string;
  revision: number;
  status: "CONFIRMED";
  dateEvidence: HistoryDateEvidence;
  comparison: {
    eligible: boolean;
    reason: "UNTRUSTED_TRAINING_DATE" | "SOURCE_NOT_TRUSTED" | null;
    key: string;
    specification: HistoryComparisonSpecification;
  };
  statistics: AuthoritativeScoreStatistics;
};

export type ConfirmedHistoryGroupV1 = {
  comparisonKey: string;
  specification: HistoryComparisonSpecification;
  sessionCount: number;
  statistics: AuthoritativeScoreStatistics;
  trend: Array<{
    sessionId: string;
    localDate: string;
    arrowCount: number;
    totalScore: number;
    averageScore: number | null;
  }>;
};

export type ConfirmedHistorySnapshotV1 = {
  version: 1;
  ownerScope: string;
  range: HistoryPeriod;
  coverage: {
    kind: "REQUESTED_PERIOD_ONLY";
    queryConsistency: "SINGLE_SQL_STATEMENT";
    periodMembership: "COMPLETE" | "INCOMPLETE_UNTRUSTED_DATES";
    allHistoryClaimed: false;
    unlocatedLegacyDateSessionCount: number;
    legacyFallbackShownCount: number;
    unknownDateSessionCount: number;
  };
  source: {
    authority: "BACKEND_CONFIRMED";
    readMode: HistoryReadMode;
    state: HistoryDataState;
    comparisonEligible: boolean;
    sync: OfflineSyncSummary;
  };
  sessions: ConfirmedHistorySessionV1[];
  groups: ConfirmedHistoryGroupV1[];
  warnings: string[];
};

export type HistorySnapshotLoadFailureV1 = {
  version: 1;
  ownerScope: string;
  range: HistoryPeriod;
  source: {
    authority: null;
    readMode: "NONE";
    state: "LOAD_FAILED";
    comparisonEligible: false;
    sync: OfflineSyncSummary;
  };
  sessions: [];
  groups: [];
  warnings: string[];
  error: { code: "LOAD_FAILED"; message: string };
};

export type ApiScoreStatisticsV1 = {
  arrow_count: number;
  hit_count: number;
  total_score: number;
  average_score: number | null;
  hit_rate: number | null;
  x_count: number;
  ten_count: number;
  miss_count: number;
  ring_distribution: Record<ScoreCode, number>;
};

export type ConfirmedHistorySnapshotApiV1 = {
  version: 1;
  owner_scope: string;
  range: {
    kind: HistoryRangeKind;
    start_local_date: string;
    end_local_date_exclusive: string;
    time_zone: string;
  };
  coverage: {
    kind: "REQUESTED_PERIOD_ONLY";
    query_consistency: "SINGLE_SQL_STATEMENT";
    period_membership: "COMPLETE" | "INCOMPLETE_UNTRUSTED_DATES";
    all_history_claimed: false;
    unlocated_legacy_date_session_count: number;
    legacy_fallback_shown_count: number;
    unknown_date_session_count: number;
  };
  sessions: Array<{
    id: string;
    revision: number;
    status: "CONFIRMED";
    date_evidence: {
      basis: HistoryDateBasis;
      local_date: string | null;
      started_at_utc: string | null;
      confirmed_at_raw: string | null;
      time_zone: string | null;
      trusted_for_period_comparison: boolean;
    };
    comparison: {
      eligible: boolean;
      reason: "UNTRUSTED_TRAINING_DATE" | null;
      key: string;
      specification: {
        bow_type: string;
        distance_m: number;
        target: TargetContract;
        planned_end_count: number;
        arrows_per_end: number;
        completion_mode: string | null;
        scored_blocks: Array<{
          position: number | null;
          block_type: string | null;
          end_count: number | null;
          arrows_per_end: number | null;
        }>;
      };
    };
    statistics: ApiScoreStatisticsV1;
  }>;
  groups: Array<{
    comparison_key: string;
    specification: ConfirmedHistorySnapshotApiV1["sessions"][number]["comparison"]["specification"];
    session_count: number;
    statistics: ApiScoreStatisticsV1;
    trend: Array<{
      session_id: string;
      local_date: string;
      arrow_count: number;
      total_score: number;
      average_score: number | null;
    }>;
  }>;
  warnings: string[];
};
