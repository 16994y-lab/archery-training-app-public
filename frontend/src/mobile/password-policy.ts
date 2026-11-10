/** New passwords only. Existing passwords must reach the sign-in service unchanged. */
export const PASSWORD_RULE='至少 8 位，包含英文字母、数字和特殊符号；不要求同时包含大小写字母。';
export function newPasswordError(password:string):string{
  // ASCII punctuation; spaces, Chinese characters and emoji are not symbols.
  return Array.from(password).length>=8&&/[A-Za-z]/.test(password)&&/[0-9]/.test(password)&&/[!-/:-@\[-`{-~]/.test(password)?'':PASSWORD_RULE;
}
export function requireNewPassword(password:string){const error=newPasswordError(password);if(error)throw new Error(error);}
