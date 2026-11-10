/** Only a destination preference; it never conveys an account or permission. */
export type LoginDestination='user'|'coach';
const key='gongxingji-login-destination/v1';
let fallback:LoginDestination='user';
export function loginDestination():LoginDestination {
  if(typeof window==='undefined'||window.Gongxingji)return 'user';
  try{return sessionStorage.getItem(key)==='coach'?'coach':fallback;}catch{return fallback;}
}
export function chooseLoginDestination(value:LoginDestination){
  fallback=value;
  try{sessionStorage.setItem(key,value);}catch{/* Current-page preference remains usable. */}
}
export function workspacePath(path:string){return /^\/(coach|admin)(?:\/|$)/.test(path);}
export function loginLanding(personal='/training') {if(personal.startsWith('/team?')){chooseLoginDestination('user');return personal;}return loginDestination()==='coach'?'/coach':personal;}
