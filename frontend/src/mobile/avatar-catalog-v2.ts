/** Built-in presentation catalog only. This module grants no paid entitlement. */
const ordinaryRows = [
  ['furry-red-panda', '打弓团'],
  ['furry-otter', '打弓獭'],
  ['furry-arctic-fox', '打弓雪'],
  ['furry-rabbit', '打弓兔'],
  ['furry-bear', '打弓熊'],
  ['furry-cat', '打弓猫'],
  ['furry-fox', '打弓狐'],
  ['furry-raccoon', '打弓浣'],
  ['furry-hedgehog', '打弓刺'],
  ['furry-hamster', '打弓鼠'],
  ['furry-snow-leopard', '打弓豹'],
  ['furry-shiba', '打弓柴'],
] as const;
export type DefaultAvatarIdV2 = typeof ordinaryRows[number][0];
export type AvatarChoiceV2 = Readonly<{kind: 'preset'; id: DefaultAvatarIdV2}>;
export type AvatarCatalogItemV2 = Readonly<AvatarChoiceV2 & {
  name: string;
  /** Repository source path; the root integrator owns bundled runtime URLs. */
  assetPath: string;
}>;
export const DEFAULT_AVATARS_V2: readonly AvatarCatalogItemV2[] = Object.freeze(
  ordinaryRows.map(([id, name]) => Object.freeze({
    kind: 'preset' as const, id, name,
    assetPath: 'frontend/public/ui/avatars/' + id + '.png',
  })),
);
/** Locked metadata is separate from the ordinary grid and is never selectable. */
export const LOCKED_AVATAR_V2 = Object.freeze({
  kind: 'preset' as const,
  id: 'furry-emperor' as const,
  name: '打弓王',
  assetPath: 'frontend/public/ui/avatars-v2/furry-emperor.png',
  selectable: false as const,
  lockReason: '支付核验尚未开放',
});
export function getSelectableAvatarV2(id: unknown): AvatarCatalogItemV2 | null {
  if (typeof id !== 'string') return null;
  return DEFAULT_AVATARS_V2.find(item => item.id === id) ?? null;
}
/** Accept only a built-in preset choice; old photo records are not migrated here. */
export function isSelectableAvatarChoiceV2(value: unknown): value is AvatarChoiceV2 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const choice = value as {kind?: unknown; id?: unknown};
  return choice.kind === 'preset' && getSelectableAvatarV2(choice.id) !== null;
}
