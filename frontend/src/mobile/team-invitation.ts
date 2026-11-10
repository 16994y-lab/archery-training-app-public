const key='gongxingji-pending-team-invite/v1';
const valid=(v:string)=>/^[A-Za-z0-9_-]{32,128}$/.test(v);
export function rememberTeamInvitation(search:string){const value=new URLSearchParams(search).get('invite');if(value&&valid(value))sessionStorage.setItem(key,value);}
export function pendingTeamInvitation(){const value=sessionStorage.getItem(key);return value&&valid(value)?value:null;}
export function clearTeamInvitation(){sessionStorage.removeItem(key);}
export function teamInvitationRoute(){const token=pendingTeamInvitation();return token?'/team?invite='+encodeURIComponent(token):null;}
