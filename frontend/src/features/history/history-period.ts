import type { HistoryPeriod, HistoryRangeKind } from "./history-contract";

const LOCAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseLocalDate(value: string): Date {
  const match = value.match(LOCAL_DATE);
  if (!match) throw new Error("日期必须使用 YYYY-MM-DD 格式");
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) throw new Error("日期不存在");
  return parsed;
}

function formatLocalDate(value: Date): string {
  return `${value.getUTCFullYear().toString().padStart(4, "0")}-${(value.getUTCMonth() + 1).toString().padStart(2, "0")}-${value.getUTCDate().toString().padStart(2, "0")}`;
}

function addUtcDays(value: Date, days: number): Date {
  const result = new Date(value);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

export function validateIanaTimeZone(timeZone: string): string {
  const value = timeZone.trim();
  if (!value) throw new Error("必须指定 IANA 时区");
  try {
    const formatter = new Intl.DateTimeFormat("zh-CN", { timeZone: value });
    formatter.format(0);
    const canonical = formatter.resolvedOptions().timeZone;
    if (canonical !== "UTC" && !canonical.includes("/")) throw new Error("not a named IANA zone");
    return canonical;
  } catch {
    throw new Error("必须指定有效的 IANA 时区");
  }
}

export function periodFor(kind: HistoryRangeKind, anchorLocalDate: string, timeZone: string): HistoryPeriod {
  const anchor = parseLocalDate(anchorLocalDate);
  const zone = validateIanaTimeZone(timeZone);
  let start: Date;
  let end: Date;
  if (kind === "WEEK") {
    const daysSinceMonday = (anchor.getUTCDay() + 6) % 7;
    start = addUtcDays(anchor, -daysSinceMonday);
    end = addUtcDays(start, 7);
  } else if (kind === "MONTH") {
    start = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), 1));
    end = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 1, 1));
  } else {
    throw new Error("报告周期仅支持 WEEK 或 MONTH");
  }
  return { kind, startLocalDate: formatLocalDate(start), endLocalDateExclusive: formatLocalDate(end), timeZone: zone };
}

export function assertPeriod(period: HistoryPeriod): HistoryPeriod {
  const expected = periodFor(period.kind, period.startLocalDate, period.timeZone);
  if (expected.startLocalDate !== period.startLocalDate || expected.endLocalDateExclusive !== period.endLocalDateExclusive) {
    throw new Error(period.kind === "WEEK" ? "周报告必须从周一开始并使用 7 天区间" : "月报告必须使用完整自然月区间");
  }
  return expected;
}

export function historySnapshotPath(period: HistoryPeriod): string {
  const valid = assertPeriod(period);
  const query = new URLSearchParams({
    range_kind: valid.kind,
    start_local_date: valid.startLocalDate,
    end_local_date_exclusive: valid.endLocalDateExclusive,
    time_zone: valid.timeZone,
  });
  return `/history/snapshot?${query}`;
}
