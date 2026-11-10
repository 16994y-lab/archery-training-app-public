import { classifyOfflineSyncError, queueSafeOptions, withStableArrowId } from "./sync-contract";
import { isVerifiedOwnerCurrent } from "./auth";
import type { OfflineSessionSyncDescriptor, OfflineSyncIssue, OfflineSyncSummary } from "./sync-contract";

const DB_NAME = "archery-offline";
const STORE = "records";
let serial: Promise<unknown> = Promise.resolve();
let ownerScope: string | null = null;
let ownerGeneration = 0;

export type OfflineOwnerContext = Readonly<{ ownerScope: string; generation: number }>;

export function setOfflineOwnerScope(scope: string | null) {
  const next = scope?.trim() || null;
  if (next !== ownerScope) {
    ownerScope = next;
    ownerGeneration += 1;
  }
}

export function captureOfflineOwnerContext(): OfflineOwnerContext | null {
  return ownerScope && isVerifiedOwnerCurrent(ownerScope) ? Object.freeze({ ownerScope, generation: ownerGeneration }) : null;
}

export function isOfflineOwnerContextCurrent(context: OfflineOwnerContext | null): boolean {
  return context !== null && context.ownerScope === ownerScope && context.generation === ownerGeneration && isVerifiedOwnerCurrent(context.ownerScope);
}

function requireCurrent(context: OfflineOwnerContext): void {
  if (!isOfflineOwnerContextCurrent(context)) throw new Error("账户已切换；旧账户操作结果已丢弃，请在对应账户中重试");
}

const ownerPrefix = (scope: string) => `owner:${encodeURIComponent(scope)}:`;
const queueKey = (scope: string) => `${ownerPrefix(scope)}queue`;
const issueKey = (scope: string) => `${ownerPrefix(scope)}sync-issues`;
function exclusive<T>(context: OfflineOwnerContext | null, work: () => Promise<T>): Promise<T> {
  const lockName = `archery-scoring-queue:${context ? encodeURIComponent(context.ownerScope) : "unbound"}`;
  const run = async (): Promise<T> => typeof navigator !== "undefined" && navigator.locks ? await navigator.locks.request(lockName, work) : await work();
  const result = serial.then(run, run);
  serial = result.catch(() => undefined);
  return result;
}

export type PendingRequest = { id: string; ownerScope: string; path: string; options: { method: string; body?: string; headers?: Record<string, string> }; createdAt: number };
type StoredIssues = Record<string, OfflineSyncIssue>;

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function set(key: string, value: unknown) {
  return setMany([[key, value]]);
}

async function setMany(entries: Array<[string, unknown]>) {
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      for (const [key, value] of entries) tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error ?? new Error("本机保存中止"));
    });
  } finally { db.close(); }
}

async function get<T>(key: string): Promise<T | undefined> {
  const db = await database();
  const result = await new Promise<T | undefined>((resolve, reject) => { const request = db.transaction(STORE).objectStore(STORE).get(key); request.onsuccess = () => resolve(request.result as T | undefined); request.onerror = () => reject(request.error); });
  db.close();
  return result;
}

export const cacheKey = (path: string, scope = ownerScope) => scope ? `${ownerPrefix(scope)}cache:${path}` : `unbound:${path}`;
export async function readCache<T>(path: string, context = captureOfflineOwnerContext()): Promise<T | undefined> {
  if (!context) return undefined;
  const result = await get<T>(cacheKey(path, context.ownerScope));
  return isOfflineOwnerContextCurrent(context) ? result : undefined;
}
export function writeCache(path: string, value: unknown, context = captureOfflineOwnerContext()) {
  if (!context) return Promise.resolve();
  return exclusive(context, async () => {
    if (!isOfflineOwnerContextCurrent(context)) return;
    // A GET started before an offline save must not erase the optimistic snapshot.
    if (!await hasPendingSession(path, context)) {
      requireCurrent(context);
      await set(cacheKey(path, context.ownerScope), value);
    }
  });
}

export async function enqueue(path: string, options: RequestInit) {
  const context = captureOfflineOwnerContext();
  if (!context) throw new Error("尚未建立账户级离线隔离，不能保存离线成绩");
  return exclusive(context, async () => {
    requireCurrent(context);
    const safe = queueSafeOptions(path, withStableArrowId(path, options));
    const queue = (await get<PendingRequest[]>(queueKey(context.ownerScope))) ?? [];
    requireCurrent(context);
    queue.push({ id: crypto.randomUUID(), ownerScope: context.ownerScope, path, options: safe, createdAt: Date.now() });
    await set(queueKey(context.ownerScope), queue);
    requireCurrent(context);
  });
}

export async function pendingCount(context = captureOfflineOwnerContext()) {
  if (!context) return 0;
  const count = ((await get<PendingRequest[]>(queueKey(context.ownerScope))) ?? []).length;
  return isOfflineOwnerContextCurrent(context) ? count : 0;
}

const sessionPathOf = (path: string) => path.match(/^\/training-sessions\/[^/]+/)?.[0] ?? null;
const requestRevision = (request: PendingRequest) => {
  const raw = new Headers(request.options.headers).get("If-Match");
  const parsed = raw === null ? NaN : Number(raw.replace(/"/g, ""));
  return Number.isInteger(parsed) ? parsed : null;
};

async function drainQueue(send: (request: PendingRequest) => Promise<unknown>, context: OfflineOwnerContext) {
  requireCurrent(context);
  const scope = context.ownerScope;
  const queue = (await get<PendingRequest[]>(queueKey(scope))) ?? [];
  const issues = (await get<StoredIssues>(issueKey(scope))) ?? {};
  let sent = 0;
  while (queue.length) {
    const request = queue[0];
    requireCurrent(context);
    if (request.ownerScope !== scope) throw new Error("离线队列账户归属无效，已停止同步");
    try {
      const result = await send(request);
      requireCurrent(context);
      const remaining = queue.slice(1);
      const path = sessionPathOf(request.path);
      if (path) delete issues[path];
      const entries: Array<[string, unknown]> = [[queueKey(scope), remaining], [issueKey(scope), issues]];
      if (path && result && !remaining.some(item => item.path.startsWith(`${path}/`))) entries.push([cacheKey(path, scope), result]);
      await setMany(entries);
      requireCurrent(context);
      queue.shift(); sent += 1;
    }
    catch (error) {
      if (!isOfflineOwnerContextCurrent(context)) throw error;
      const path = sessionPathOf(request.path);
      if (path) {
        issues[path] = classifyOfflineSyncError(error);
        await set(issueKey(scope), issues);
      }
      break;
    } // A conflict or disconnected network must preserve the remaining local work.
  }
  return { sent, remaining: queue.length };
}

export function flushQueue(send: (request: PendingRequest) => Promise<unknown>) {
  const context = captureOfflineOwnerContext();
  return exclusive(context, () => context ? drainQueue(send, context) : Promise.resolve({ sent: 0, remaining: 0 }));
}

export async function hasPendingSession(path: string, context = captureOfflineOwnerContext()) {
  if (!context) return false;
  const pending = ((await get<PendingRequest[]>(queueKey(context.ownerScope))) ?? []).some(item => item.path.startsWith(`${path}/`));
  return isOfflineOwnerContextCurrent(context) && pending;
}

export async function offlineSyncSummary(): Promise<OfflineSyncSummary> {
  const context = captureOfflineOwnerContext();
  const db = await database();
  try {
    const keys = await new Promise<IDBValidKey[]>((resolve, reject) => { const request = db.transaction(STORE).objectStore(STORE).getAllKeys(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    if (!context) return { ownerScope: null, pending: 0, hasUnknownOwnerLegacyData: keys.some(key => key === "queue" || String(key).startsWith("cache:")), sourceCompleteness: "CONFIRMED_SCORE_MUTATIONS_ONLY", sessions: [] };
    const queue = (await get<PendingRequest[]>(queueKey(context.ownerScope))) ?? [];
    const issues = (await get<StoredIssues>(issueKey(context.ownerScope))) ?? {};
    requireCurrent(context);
    const grouped = new Map<string, PendingRequest[]>();
    for (const request of queue) {
      const path = sessionPathOf(request.path);
      if (request.ownerScope === context.ownerScope && path) grouped.set(path, [...(grouped.get(path) ?? []), request]);
    }
    const sessions: OfflineSessionSyncDescriptor[] = [...grouped].map(([sessionPath, requests]) => {
      const issue = issues[sessionPath] ?? null;
      const revisions = requests.map(requestRevision).filter((revision): revision is number => revision !== null);
      const state = issue?.kind === "REVISION_CONFLICT" ? "CONFLICT" : issue?.kind === "HTTP_REJECTED" ? "BLOCKED" : issue?.kind === "RETRYABLE_TRANSPORT" ? "RETRYABLE" : "PENDING";
      return { sessionPath, baseRevision: revisions.length ? Math.min(...revisions) : null, pending: requests.length, state, issue };
    });
    return { ownerScope: context.ownerScope, pending: queue.length, hasUnknownOwnerLegacyData: keys.some(key => key === "queue" || String(key).startsWith("cache:")), sourceCompleteness: "CONFIRMED_SCORE_MUTATIONS_ONLY", sessions };
  } finally { db.close(); }
}

/** Confirmed score JSON only. The operation and optimistic cache commit atomically. */
export function saveScoringMutation<T>(path: string, options: RequestInit, send: (path: string, options: RequestInit) => Promise<T>, apply: () => T): Promise<{ session: T; queued: boolean }> {
  const context = captureOfflineOwnerContext();
  return exclusive(context, async () => {
    const stableOptions = withStableArrowId(path, options);
    if (stableOptions !== options) Object.assign(options, stableOptions);
    let transportIssue: OfflineSyncIssue | null = null;
    if (navigator.onLine) {
      const result = context ? await drainQueue(request => send(request.path, request.options), context) : { sent: 0, remaining: 0 };
      if (result.remaining) throw new Error("先前离线记录尚未同步，可能存在版本冲突。候选已保留，请核对后重试。");
      try {
        if (context) requireCurrent(context);
        const session = await send(path, stableOptions);
        if (context) requireCurrent(context);
        return { session, queued: false };
      } catch (error) {
        if (context && !isOfflineOwnerContextCurrent(context)) throw error;
        if (error && typeof error === "object" && "status" in error) throw error;
        transportIssue = classifyOfflineSyncError(error);
      }
    }
    if (!context) throw new Error("尚未建立账户级离线隔离，不能保存离线成绩");
    requireCurrent(context);
    const session = apply();
    const scope = context.ownerScope;
    const queue = (await get<PendingRequest[]>(queueKey(scope))) ?? [];
    requireCurrent(context);
    queue.push({ id: crypto.randomUUID(), ownerScope: scope, path, options: queueSafeOptions(path, stableOptions), createdAt: Date.now() });
    const sessionPath = sessionPathOf(path);
    if (!sessionPath) throw new Error("无效记分路径");
    const entries: Array<[string, unknown]> = [[queueKey(scope), queue], [cacheKey(sessionPath, scope), session]];
    if (transportIssue) {
      const issues = (await get<StoredIssues>(issueKey(scope))) ?? {};
      issues[sessionPath] = transportIssue;
      entries.push([issueKey(scope), issues]);
    }
    requireCurrent(context);
    await setMany(entries);
    requireCurrent(context);
    return { session, queued: true };
  });
}

export function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  const register = () => { void navigator.serviceWorker.register("/service-worker.js", { updateViaCache: "none" }).catch(() => undefined); };
  if (document.readyState === "complete") register();
  else window.addEventListener("load", register, { once: true });
}
