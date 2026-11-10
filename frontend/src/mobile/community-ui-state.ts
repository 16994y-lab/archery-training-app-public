/** Pure UI transitions used after confirmed server outcomes. */
export function afterPostDelete<T extends {id:string}>(items:T[],id:string):T[]{return items.filter(item=>item.id!==id);}
export function afterCommentDelete<T extends {id:string}>(items:T[],id:string):T[]{return items.filter(item=>item.id!==id);}
export function pendingAfterExplicitExit<T>(value:T|null,approved:boolean):T|null{return approved?null:value;}
