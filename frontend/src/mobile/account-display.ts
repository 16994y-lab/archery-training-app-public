/** Display only. Never pass masked values to identity checks or requests. */
export function maskEmail(value:string):string{
 const match=/^([^\s@]+)@([^\s@]+\.[^\s@]+)$/.exec(value.trim());
 if(!match)return value?'***':'';
 const local=Array.from(match[1]);
 // Always hide at least one original character, including short usernames.
 const visible=local.length>=5?`${local.slice(0,2).join('')}***${local.slice(-2).join('')}`:local.length>=3?`${local[0]}***${local[local.length-1]}`:local.length===2?`${local[0]}***`:'***';
 return `${visible}@${match[2]}`;
}

export function maskPhone(value:string):string{
 const compact=value.replace(/[\s()-]/g,'');
 const match=/^(?:\+?86|0086)?(1[3-9]\d{9})$/.exec(compact);
 return match?`${match[1].slice(0,2)}*****${match[1].slice(-4)}`:'';
}
