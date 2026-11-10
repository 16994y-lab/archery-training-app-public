/** Local protected archive candidate. Adapters are owner-scoped; no deletion capability exists. */
export type ArchiveObjectKind = 'document' | 'photo' | 'video' | 'avatar' | 'attachment';
export type RestoreRelation = {
  entityKind: 'session' | 'profile' | 'plan' | 'equipment' | 'note' | 'calendar' | 'target' | 'goal' | 'document';
  entityId: string;
  role: string;
};
export type ArchiveSelection = {
  objectId: string;
  ownerId: string;
  kind: ArchiveObjectKind;
  restoreRelation: RestoreRelation;
  sourceVersion?: string;
  expectedByteLength?: number;
  expectedSha256?: string;
};
export type ArchiveEntry = {
  objectId: string;
  ownerId: string;
  kind: ArchiveObjectKind;
  path: string;
  byteLength: number;
  sha256: string;
  restoreRelation: RestoreRelation;
  sourceVersion?: string;
};
export type ProtectedArchiveManifest = {
  schema: 'gongxingji-protected-archive-v1';
  archiveId: string;
  ownerId: string;
  sourceStoreId: string;
  createdAt: string;
  totalByteLength: number;
  objects: ArchiveEntry[];
  sourceRetention: 'retain';
};
export interface ArchiveSource {
  readonly storeId: string;
  readonly ownerId: string;
  readObject(objectId: string): Promise<Uint8Array>;
}
/** Dedicated empty namespace. writeExclusive must atomically reject existing paths. */
export interface ArchiveStorage {
  readonly storeId: string;
  readonly ownerId: string;
  list(): Promise<string[]>;
  read(path: string): Promise<Uint8Array>;
  writeExclusive(path: string, bytes: Uint8Array): Promise<void>;
}
export type ArchiveLimits = { maxObjects: number; maxObjectBytes: number; maxTotalBytes: number };
export const PROTECTED_ARCHIVE_LIMITS: Readonly<ArchiveLimits> = Object.freeze({
  maxObjects: 1000, maxObjectBytes: 50 * 1024 * 1024, maxTotalBytes: 100 * 1024 * 1024,
});
export type ArchiveVerification = {
  manifest: ProtectedArchiveManifest;
  manifestSha256: string;
  storeId: string;
  objectCount: number;
  totalByteLength: number;
  verifiedAt: string;
  sourceRetained: true;
};
export type ArchiveRestoreReceipt = {
  archiveId: string;
  ownerId: string;
  manifestSha256: string;
  archiveStoreId: string;
  destinationStoreId: string;
  restoredAt: string;
  objects: (ArchiveEntry & { restoredPath: string; readBackSha256: string })[];
  sourceRetained: true;
};
export type ArchivePersistenceFacts = {
  access: 'granted' | 'denied' | 'unknown';
  persistence: 'granted' | 'denied' | 'unknown';
  retentionControl: 'user-managed' | 'policy-managed' | 'unknown';
};
export type ArchiveDurabilityReceipt = ArchiveVerification & {
  reopenedAndReadBack: true;
  facts: ArchivePersistenceFacts;
  durability: 'verified' | 'unverified';
};
export type ArchiveRetentionPolicy = {
  policyId: string;
  ownerId: string;
  manifestSha256: string;
  status: 'confirmed' | 'unknown';
  preserveArchiveUntil: string;
  minimumRetentionDays: number;
  restoreScopeAcknowledged: boolean;
};
export class ProtectedArchiveError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; this.name = 'ProtectedArchiveError'; }
}
const manifestPath = 'manifest.json';
const kinds = new Set(['document', 'photo', 'video', 'avatar', 'attachment']);
const entityKinds = new Set(['session', 'profile', 'plan', 'equipment', 'note', 'calendar', 'target', 'goal', 'document']);
const digestPattern = /^[a-f0-9]{64}$/;
const verificationReceipts = new WeakSet<object>();
const restoreReceipts = new WeakSet<object>();
const durabilityReceipts = new WeakSet<object>();
const encoder = new TextEncoder();
function fail(code: string, message: string): never { throw new ProtectedArchiveError(code, message); }
function identifier(v: unknown, name: string): asserts v is string {
  if (typeof v !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(v)) fail('invalid-identifier', `${name}无效`);
}
function ownerCheck(expected: string, actual: unknown) {
  identifier(expected, '当前归属');
  if (actual !== expected) fail('owner-mismatch', '归档或对象属于另一账号，未读取或恢复');
}
function date(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail('invalid-time', '归档时间无效');
}
function exactKeys(v: unknown, required: string[], optional: string[] = []): asserts v is Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) fail('invalid-manifest', '归档字段无效');
  const keys = Object.keys(v);
  if (required.some(k => !keys.includes(k)) || keys.some(k => !required.includes(k) && !optional.includes(k))) fail('invalid-manifest', '归档字段缺失或包含未批准内容');
}
function limits(value: ArchiveLimits = PROTECTED_ARCHIVE_LIMITS): ArchiveLimits {
  exactKeys(value, ['maxObjects', 'maxObjectBytes', 'maxTotalBytes']);
  for (const n of Object.values(value)) if (!Number.isSafeInteger(n) || n < 1) fail('invalid-limit', '容量保护无效');
  for (const key of Object.keys(PROTECTED_ARCHIVE_LIMITS) as (keyof ArchiveLimits)[]) if (value[key] > PROTECTED_ARCHIVE_LIMITS[key]) fail('invalid-limit', '不能由导入文件提高容量保护');
  return value;
}
function lengthCheck(n: unknown, max: number): asserts n is number {
  if (!Number.isSafeInteger(n) || (n as number) < 0 || (n as number) > max) fail('capacity', '归档超过容量保护或字节数无效');
}
export function assertSafeArchivePath(path: unknown): asserts path is string {
  if (typeof path !== 'string' || path.length > 256 || !/^[a-zA-Z0-9_./-]+$/.test(path)) fail('unsafe-path', '归档路径无效');
  const parts = path.split('/');
  if (parts.some(p => !p || p === '.' || p === '..' || p.endsWith('.') || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) fail('unsafe-path', '归档路径包含越界或系统保留名称');
}
function relation(v: unknown): asserts v is RestoreRelation {
  exactKeys(v, ['entityKind', 'entityId', 'role']);
  if (!entityKinds.has(v.entityKind as string)) fail('invalid-relation', '恢复关联类别无效');
  identifier(v.entityId, '恢复关联对象'); identifier(v.role, '恢复关联用途');
}
function snapshot<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function manifestText(m: ProtectedArchiveManifest): string {
  // Parsed manifests are normalized before hashing so key order cannot forge a receipt mismatch.
  return JSON.stringify({ schema: m.schema, archiveId: m.archiveId, ownerId: m.ownerId, sourceStoreId: m.sourceStoreId,
    createdAt: m.createdAt, totalByteLength: m.totalByteLength, objects: m.objects.map(o => ({ objectId: o.objectId,
      ownerId: o.ownerId, kind: o.kind, path: o.path, byteLength: o.byteLength, sha256: o.sha256,
      restoreRelation: { entityKind: o.restoreRelation.entityKind, entityId: o.restoreRelation.entityId, role: o.restoreRelation.role },
      ...(o.sourceVersion === undefined ? {} : { sourceVersion: o.sourceVersion }) })), sourceRetention: m.sourceRetention });
}
export async function archiveSha256(bytes: Uint8Array): Promise<string> {
  if (!(bytes instanceof Uint8Array)) fail('invalid-bytes', '读取结果不是原始字节');
  const isolated = Uint8Array.from(bytes);
  const result = await globalThis.crypto.subtle.digest('SHA-256', isolated.buffer);
  return Array.from(new Uint8Array(result), n => n.toString(16).padStart(2, '0')).join('');
}
export function inspectProtectedArchiveManifest(value: unknown, ownerId: string, archiveLimits?: ArchiveLimits): ProtectedArchiveManifest {
  const cap = limits(archiveLimits);
  exactKeys(value, ['schema', 'archiveId', 'ownerId', 'sourceStoreId', 'createdAt', 'totalByteLength', 'objects', 'sourceRetention']);
  if (value.schema !== 'gongxingji-protected-archive-v1' || value.sourceRetention !== 'retain') fail('invalid-manifest', '归档格式或源保留规则无效');
  ownerCheck(ownerId, value.ownerId); identifier(value.archiveId, '归档标识'); identifier(value.sourceStoreId, '源存储标识'); date(value.createdAt);
  if (!Array.isArray(value.objects) || !value.objects.length || value.objects.length > cap.maxObjects) fail('capacity', '归档对象数量无效');
  const ids = new Set<string>(), paths = new Set<string>(); let total = 0;
  for (const row of value.objects) {
    exactKeys(row, ['objectId', 'ownerId', 'kind', 'path', 'byteLength', 'sha256', 'restoreRelation'], ['sourceVersion']);
    identifier(row.objectId, '对象标识'); ownerCheck(ownerId, row.ownerId); assertSafeArchivePath(row.path);
    if (row.path !== `objects/${row.objectId}.bin`) fail('unsafe-path', '对象路径与清单身份不匹配');
    if (ids.has(row.objectId) || paths.has(row.path.toLowerCase())) fail('duplicate-object', '归档清单对象或路径重复');
    ids.add(row.objectId); paths.add(row.path.toLowerCase());
    if (!kinds.has(row.kind as string) || typeof row.sha256 !== 'string' || !digestPattern.test(row.sha256)) fail('invalid-manifest', '对象类型或摘要无效');
    lengthCheck(row.byteLength, cap.maxObjectBytes); relation(row.restoreRelation);
    if (row.sourceVersion !== undefined) identifier(row.sourceVersion, '源版本');
    total += row.byteLength;
  }
  lengthCheck(value.totalByteLength, cap.maxTotalBytes);
  if (total !== value.totalByteLength) fail('byte-mismatch', '清单总字节数不一致');
  return freeze(snapshot(value as unknown as ProtectedArchiveManifest));
}
function storageCheck(store: ArchiveStorage, ownerId: string) { ownerCheck(ownerId, store.ownerId); identifier(store.storeId, '存储标识'); }
async function exclusiveWrite(store: ArchiveStorage, ownerId: string, path: string, bytes: Uint8Array) {
  storageCheck(store, ownerId); assertSafeArchivePath(path);
  await store.writeExclusive(path, bytes); storageCheck(store, ownerId);
}
async function exactInventory(store: ArchiveStorage, expected: string[]) {
  const actual = await store.list();
  if (!Array.isArray(actual)) fail('invalid-storage', '存储清单无效');
  for (const path of actual) assertSafeArchivePath(path);
  if (new Set(actual).size !== actual.length) fail('duplicate-path', '存储中路径重复');
  const wanted = new Set(expected);
  if (actual.length !== expected.length || actual.some(p => !wanted.has(p))) fail('inventory-mismatch', '归档缺件或包含清单外文件');
}
async function checkedBytes(store: ArchiveStorage, entry: ArchiveEntry): Promise<Uint8Array> {
  storageCheck(store, entry.ownerId);
  const raw = await store.read(entry.path); storageCheck(store, entry.ownerId);
  if (!(raw instanceof Uint8Array)) fail('invalid-bytes', '存储读取结果不是原始字节');
  const value = Uint8Array.from(raw);
  if (value.byteLength !== entry.byteLength) fail('byte-mismatch', '对象字节数与清单不一致');
  if (await archiveSha256(value) !== entry.sha256) fail('digest-mismatch', '对象已损坏或内容与清单不一致');
  return value;
}
export async function verifyProtectedArchive(input: {
  ownerId: string; archiveStorage: ArchiveStorage; expectedManifestSha256?: string; now?: string; limits?: ArchiveLimits;
}): Promise<ArchiveVerification> {
  const { ownerId, archiveStorage } = input; storageCheck(archiveStorage, ownerId);
  const bytes = await archiveStorage.read(manifestPath);
  storageCheck(archiveStorage, ownerId);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > 2 * 1024 * 1024) fail('capacity', '归档清单超过容量保护');
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { fail('invalid-manifest', '归档清单损坏'); }
  const manifest = inspectProtectedArchiveManifest(parsed, ownerId, input.limits);
  const manifestSha256 = await archiveSha256(encoder.encode(manifestText(manifest)));
  if (input.expectedManifestSha256 !== undefined && input.expectedManifestSha256 !== manifestSha256) fail('manifest-mismatch', '归档清单版本已变化');
  await exactInventory(archiveStorage, [manifestPath, ...manifest.objects.map(o => o.path)]);
  for (const entry of manifest.objects) await checkedBytes(archiveStorage, entry);
  const verifiedAt = input.now ?? new Date().toISOString(); date(verifiedAt);
  const receipt: ArchiveVerification = freeze({ manifest, manifestSha256, storeId: archiveStorage.storeId,
    objectCount: manifest.objects.length, totalByteLength: manifest.totalByteLength, verifiedAt, sourceRetained: true });
  verificationReceipts.add(receipt); return receipt;
}
export async function createProtectedArchive(input: {
  ownerId: string; archiveId: string; selectedObjectIds: readonly string[]; catalog: readonly ArchiveSelection[];
  source: ArchiveSource; archiveStorage: ArchiveStorage; now?: string; limits?: ArchiveLimits;
}): Promise<ArchiveVerification> {
  const { ownerId, archiveId, source, archiveStorage } = input; const cap = limits(input.limits);
  ownerCheck(ownerId, source.ownerId); identifier(source.storeId, '源存储'); storageCheck(archiveStorage, ownerId); identifier(archiveId, '归档标识');
  if (source.storeId === archiveStorage.storeId) fail('storage-not-independent', '归档必须使用与源不同的存储');
  const selected = [...input.selectedObjectIds], catalog = snapshot(input.catalog);
  if (!selected.length || selected.length > cap.maxObjects || new Set(selected).size !== selected.length) fail('selection-required', '请明确选择不重复的归档对象');
  selected.forEach(id => identifier(id, '选择对象')); const rows = new Map<string, ArchiveSelection>();
  for (const item of catalog) { identifier(item.objectId, '目录对象'); if (rows.has(item.objectId)) fail('duplicate-object', '对象目录身份重复'); rows.set(item.objectId, item); }
  // Validate all selected owners and restore relations before reading the first source byte.
  for (const id of selected) {
    const item = rows.get(id); if (!item) fail('selection-missing', '所选对象不在当前明确目录中');
    assertSafeArchivePath(`objects/${id}.bin`);
    ownerCheck(ownerId, item.ownerId); relation(item.restoreRelation);
    if (!kinds.has(item.kind)) fail('invalid-manifest', '所选对象类型无效');
    if (item.sourceVersion !== undefined) identifier(item.sourceVersion, '源版本');
    if (item.expectedByteLength !== undefined) lengthCheck(item.expectedByteLength, cap.maxObjectBytes);
    if (item.expectedSha256 !== undefined && !digestPattern.test(item.expectedSha256)) fail('invalid-manifest', '源摘要无效');
  }
  if (new Set(selected.map(id => id.toLowerCase())).size !== selected.length) fail('duplicate-object', '对象名称在文件存储中冲突');
  await exactInventory(archiveStorage, []);
  const createdAt = input.now ?? new Date().toISOString(); date(createdAt);
  const objects: ArchiveEntry[] = []; let totalByteLength = 0;
  for (const id of selected) {
    const item = rows.get(id)!; ownerCheck(ownerId, source.ownerId);
    const raw = await source.readObject(id); ownerCheck(ownerId, source.ownerId);
    if (!(raw instanceof Uint8Array)) fail('invalid-bytes', '源对象读取失败'); const bytes = Uint8Array.from(raw);
    lengthCheck(bytes.byteLength, cap.maxObjectBytes); totalByteLength += bytes.byteLength; lengthCheck(totalByteLength, cap.maxTotalBytes);
    const sha256 = await archiveSha256(bytes);
    if (item.expectedByteLength !== undefined && item.expectedByteLength !== bytes.byteLength) fail('source-changed', '源对象大小已变化，请重新选择');
    if (item.expectedSha256 !== undefined && item.expectedSha256 !== sha256) fail('source-changed', '源对象内容已变化，请重新选择');
    const entry: ArchiveEntry = { objectId: id, ownerId, kind: item.kind, path: `objects/${id}.bin`, byteLength: bytes.byteLength,
      sha256, restoreRelation: snapshot(item.restoreRelation), ...(item.sourceVersion === undefined ? {} : { sourceVersion: item.sourceVersion }) };
    objects.push(entry); await exclusiveWrite(archiveStorage, ownerId, entry.path, bytes);
  }
  const manifest = inspectProtectedArchiveManifest({ schema: 'gongxingji-protected-archive-v1', archiveId, ownerId,
    sourceStoreId: source.storeId, createdAt, totalByteLength, objects, sourceRetention: 'retain' }, ownerId, cap);
  await exclusiveWrite(archiveStorage, ownerId, manifestPath, encoder.encode(manifestText(manifest)));
  return verifyProtectedArchive({ ownerId, archiveStorage, now: createdAt, limits: cap });
}
export async function restoreProtectedArchive(input: {
  ownerId: string; archiveStorage: ArchiveStorage; destination: ArchiveStorage;
  expectedManifestSha256?: string; now?: string; limits?: ArchiveLimits;
}): Promise<ArchiveRestoreReceipt> {
  storageCheck(input.destination, input.ownerId);
  const verified = await verifyProtectedArchive(input);
  if (input.destination.storeId === input.archiveStorage.storeId || input.destination.storeId === verified.manifest.sourceStoreId) fail('storage-not-independent', '恢复目的必须独立，不能覆盖源或归档');
  await exactInventory(input.destination, []);
  const objects: ArchiveRestoreReceipt['objects'] = [];
  for (const entry of verified.manifest.objects) {
    const bytes = await checkedBytes(input.archiveStorage, entry);
    const restoredPath = `restored/${entry.kind}/${entry.objectId}.bin`;
    await exclusiveWrite(input.destination, input.ownerId, restoredPath, bytes);
    objects.push({ ...entry, restoredPath, readBackSha256: entry.sha256 });
  }
  await exactInventory(input.destination, objects.map(o => o.restoredPath));
  // Re-read every persisted object after all writes, not the bytes sent to the adapter.
  for (const entry of objects) {
    await checkedBytes(input.destination, { ...entry, path: entry.restoredPath });
  }
  const restoredAt = input.now ?? new Date().toISOString(); date(restoredAt);
  const receipt: ArchiveRestoreReceipt = freeze({ archiveId: verified.manifest.archiveId, ownerId: input.ownerId,
    manifestSha256: verified.manifestSha256, archiveStoreId: input.archiveStorage.storeId,
    destinationStoreId: input.destination.storeId, restoredAt, objects, sourceRetained: true });
  restoreReceipts.add(receipt); return receipt;
}
/** The caller reopens a real store and queries permission/persistence facts; requested is not granted. */
export async function verifyDurableArchiveCopy(input: {
  ownerId: string; expectedManifestSha256: string; reopen: () => Promise<ArchiveStorage>;
  inspectPersistence: (storage: ArchiveStorage) => Promise<ArchivePersistenceFacts>; now?: string; limits?: ArchiveLimits;
}): Promise<ArchiveDurabilityReceipt> {
  const store = await input.reopen();
  const verified = await verifyProtectedArchive({ ownerId: input.ownerId, archiveStorage: store,
    expectedManifestSha256: input.expectedManifestSha256, now: input.now, limits: input.limits });
  if (store.storeId === verified.manifest.sourceStoreId) fail('storage-not-independent', '持久副本不能是源存储');
  const facts = snapshot(await input.inspectPersistence(store));
  exactKeys(facts, ['access', 'persistence', 'retentionControl']);
  if (!['granted', 'denied', 'unknown'].includes(facts.access) || !['granted', 'denied', 'unknown'].includes(facts.persistence) || !['user-managed', 'policy-managed', 'unknown'].includes(facts.retentionControl)) fail('invalid-facts', '持久保存事实无效');
  const receipt: ArchiveDurabilityReceipt = freeze({ ...verified, reopenedAndReadBack: true, facts,
    durability: facts.access === 'granted' && facts.persistence === 'granted' && facts.retentionControl !== 'unknown' ? 'verified' : 'unverified' });
  durabilityReceipts.add(receipt); return receipt;
}
export function evaluateArchiveReleaseReview(input: {
  ownerId: string; archive: ArchiveVerification; restore: ArchiveRestoreReceipt | null;
  durableCopy: ArchiveDurabilityReceipt | null; retention: ArchiveRetentionPolicy | null; now?: string;
}): { eligibleForSeparateReview: boolean; deletionAuthorized: false; sourceRetained: true; reasons: string[]; objectIds: string[] } {
  const reasons: string[] = [], archive = input.archive;
  ownerCheck(input.ownerId, archive.manifest.ownerId);
  if (!verificationReceipts.has(archive)) reasons.push('归档回执必须由当前模块重新核验');
  const restore = input.restore, durable = input.durableCopy, retention = input.retention;
  if (!restore || !restoreReceipts.has(restore) || restore.manifestSha256 !== archive.manifestSha256 || restore.ownerId !== input.ownerId || restore.archiveStoreId !== archive.storeId || restore.destinationStoreId === archive.manifest.sourceStoreId) reasons.push('独立目的存储的实际恢复回读未确认');
  if (!durable || !durabilityReceipts.has(durable) || durable.manifestSha256 !== archive.manifestSha256 || durable.manifest.ownerId !== input.ownerId || durable.durability !== 'verified') reasons.push('持久副本与权限事实未确认');
  const now = input.now ?? new Date().toISOString(); date(now);
  if ([archive.verifiedAt, restore?.restoredAt, durable?.verifiedAt].some(time => time && (Date.parse(now) < Date.parse(time) || Date.parse(now) - Date.parse(time) > 5 * 60000))) reasons.push('核验回执已过期，需重新打开并回读');
  if (!retention || retention.status !== 'confirmed' || retention.ownerId !== input.ownerId || retention.manifestSha256 !== archive.manifestSha256 || !retention.restoreScopeAcknowledged || !Number.isSafeInteger(retention.minimumRetentionDays) || retention.minimumRetentionDays < 1 || !Number.isFinite(Date.parse(retention.preserveArchiveUntil)) || Date.parse(retention.preserveArchiveUntil) - Date.parse(now) < retention.minimumRetentionDays * 86400000 || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(retention.policyId)) reasons.push('归档保留政策或可恢复范围未确认');
  return { eligibleForSeparateReview: reasons.length === 0, deletionAuthorized: false, sourceRetained: true,
    reasons, objectIds: archive.manifest.objects.map(o => o.objectId) };
}
export type PortableProtectedArchive = { schema: 'gongxingji-protected-archive-bundle-v1'; manifest: ProtectedArchiveManifest; files: { path: string; base64: string }[] };
function toBase64(bytes: Uint8Array): string {
  let text = ''; for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192)); return btoa(text);
}
function fromBase64(text: unknown, max: number): Uint8Array {
  if (typeof text !== 'string' || text.length > Math.ceil(max / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) fail('invalid-bundle', '归档对象编码无效');
  const decoded = atob(text); const bytes = Uint8Array.from(decoded, c => c.charCodeAt(0));
  if (toBase64(bytes) !== text) fail('invalid-bundle', '归档对象编码不规范'); return bytes;
}
export async function encodeProtectedArchive(input: { ownerId: string; archiveStorage: ArchiveStorage; limits?: ArchiveLimits }): Promise<string> {
  const verified = await verifyProtectedArchive(input); const files: PortableProtectedArchive['files'] = [];
  for (const entry of verified.manifest.objects) files.push({ path: entry.path, base64: toBase64(await checkedBytes(input.archiveStorage, entry)) });
  return JSON.stringify({ schema: 'gongxingji-protected-archive-bundle-v1', manifest: verified.manifest, files } satisfies PortableProtectedArchive);
}
/** Decode/verify is read-only. This does not claim a downloaded bundle is durably stored. */
export async function decodeProtectedArchive(text: string, ownerId: string, archiveLimits?: ArchiveLimits): Promise<{ manifest: ProtectedArchiveManifest; manifestSha256: string; files: Map<string, Uint8Array> }> {
  const cap = limits(archiveLimits);
  if (typeof text !== 'string' || text.length > Math.ceil(cap.maxTotalBytes / 3) * 4 + 2 * 1024 * 1024) fail('capacity', '归档文件超过容量保护');
  let value: unknown; try { value = JSON.parse(text); } catch { fail('invalid-bundle', '归档文件不是完整JSON'); }
  exactKeys(value, ['schema', 'manifest', 'files']);
  if (value.schema !== 'gongxingji-protected-archive-bundle-v1') fail('invalid-bundle', '归档文件格式不匹配');
  const manifest = inspectProtectedArchiveManifest(value.manifest, ownerId, cap);
  if (!Array.isArray(value.files) || value.files.length !== manifest.objects.length) fail('inventory-mismatch', '归档文件缺件或包含额外项');
  const files = new Map<string, Uint8Array>(), entries = new Map(manifest.objects.map(o => [o.path, o]));
  for (const file of value.files) {
    exactKeys(file, ['path', 'base64']); assertSafeArchivePath(file.path);
    const entry = entries.get(file.path); if (!entry || files.has(file.path)) fail('inventory-mismatch', '归档包含额外或重复文件');
    const bytes = fromBase64(file.base64, entry.byteLength);
    if (bytes.byteLength !== entry.byteLength || await archiveSha256(bytes) !== entry.sha256) fail('digest-mismatch', '归档字节损坏');
    files.set(file.path, bytes);
  }
  return { manifest, manifestSha256: await archiveSha256(encoder.encode(manifestText(manifest))), files };
}
/** Import into a fresh owner-scoped archive namespace, then read back; never into active product data. */
export async function importProtectedArchive(input: { text: string; ownerId: string; destination: ArchiveStorage; now?: string; limits?: ArchiveLimits }): Promise<ArchiveVerification> {
  storageCheck(input.destination, input.ownerId);
  const decoded = await decodeProtectedArchive(input.text, input.ownerId, input.limits);
  if (input.destination.storeId === decoded.manifest.sourceStoreId) fail('storage-not-independent', '导入目的不能覆盖源存储');
  await exactInventory(input.destination, []);
  for (const [path, bytes] of decoded.files) await exclusiveWrite(input.destination, input.ownerId, path, bytes);
  await exclusiveWrite(input.destination, input.ownerId, manifestPath, encoder.encode(manifestText(decoded.manifest)));
  return verifyProtectedArchive({ ownerId: input.ownerId, archiveStorage: input.destination, expectedManifestSha256: decoded.manifestSha256, now: input.now, limits: input.limits });
}
