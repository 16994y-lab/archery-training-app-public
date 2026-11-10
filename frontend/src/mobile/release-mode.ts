/** Set by the reviewed mobile build configuration, never by saved user data. */
export const teamSharingReady =
  (import.meta as ImportMeta & {env?: Record<string,string>}).env?.VITE_TEAM_SHARING_READY === 'true';
export const communityTestOnly =
  (import.meta as ImportMeta & {env?: Record<string,string>}).env?.VITE_COMMUNITY_TEST_ONLY === 'true';

/** Delivery is opt-in only after the external provider has passed acceptance. */
export const phoneOtpReady =
  (import.meta as ImportMeta & {env?: Record<string,string>}).env?.VITE_PHONE_OTP_READY === 'true';
export const emailOtpReady =
  (import.meta as ImportMeta & {env?: Record<string,string>}).env?.VITE_EMAIL_OTP_READY === 'true';
/** Existing verified accounts only; this does not enable email enrollment/binding. */
export const existingEmailOtpLoginReady =
  (import.meta as ImportMeta & {env?: Record<string,string>}).env?.VITE_EXISTING_EMAIL_OTP_LOGIN_READY === 'true';
/** New-registration lifecycle requires its own server and native acceptance. */
export const emailEnrollmentReady =
  (import.meta as ImportMeta & {env?: Record<string,string>}).env?.VITE_EMAIL_ENROLLMENT_READY === 'true';

/** Original Auth over the verified API path; never a saved-data switch. */
export const nativeSessionRelayReady =
  (import.meta as ImportMeta & {env?: Record<string,string>}).env?.VITE_NATIVE_SESSION_RELAY_READY === 'true';

/** Enable only after continuous archery and spoken feedback pass acceptance. */
export const videoCoachReady =
  (import.meta as ImportMeta & {env?: Record<string,string>}).env?.VITE_VIDEO_COACH_READY === 'true';

export const emailChangeReady =
  (import.meta as ImportMeta & {env?: Record<string,string>}).env?.VITE_EMAIL_CHANGE_READY === 'true';
export const phoneChangeReady =
  (import.meta as ImportMeta & {env?: Record<string,string>}).env?.VITE_PHONE_CHANGE_READY === 'true';
export const invitationsReady =
  (import.meta as ImportMeta & {env?: Record<string,string>}).env?.VITE_ACCOUNT_INVITATIONS_READY === 'true';



/** Review candidate only. Enabling this never enables the old automatic sync. */
export const manualBackupReady =
  (import.meta as ImportMeta & {env?: Record<string,string>}).env?.VITE_MANUAL_BACKUP_READY === 'true';

/** Separate acceptance gates. Saved account data never enables these capabilities. */
export const automaticRecordsSaveReady =
  (import.meta as ImportMeta & {env?: Record<string,string>}).env?.VITE_AUTOMATIC_RECORDS_SAVE_READY === 'true';
export const privateMediaSaveReady =
  (import.meta as ImportMeta & {env?: Record<string,string>}).env?.VITE_PRIVATE_MEDIA_SAVE_READY === 'true';
export const protectedArchiveReady =
  (import.meta as ImportMeta & {env?: Record<string,string>}).env?.VITE_PROTECTED_ARCHIVE_READY === 'true';

export const trainingCloudUnavailable = automaticRecordsSaveReady
  ? '训练先保存在本机；可在账号页明确开启完整记录云保存与换机恢复。照片、视频和本机头像文件不包含在内。'
  : '登录后进入应用，训练保存在本机。整库自动同步尚未开放；可选成绩备份仅在你手选已完成场次并确认后尝试。';

/** Activated only with the reviewed server deletion route. */
export const accountDeletionReady=(import.meta as ImportMeta & {env?:Record<string,string>}).env?.VITE_ACCOUNT_DELETION_READY==='true';
