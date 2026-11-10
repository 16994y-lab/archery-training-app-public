export const dimensions: string[][];
export function oneCondition(sessions: {groupKey?: string | null}[]): boolean;
export function selectSessions<T extends {memberId: string; date: string; conditions: object}>(sessions: T[], query?: URLSearchParams, memberIds?: string[] | null): T[];
export function cohorts<T extends {id: string; memberId: string; groupKey?: string | null}>(sessions: T[]): T[][];
export function summarize(sessions: {summary: {arrows: number; total: number; trustedPoints: number; distribution: Record<string, number>}}[]): {sessions: number; arrows: number; score: number; points: number; X: number; ten: number; M: number; average: number | null};
