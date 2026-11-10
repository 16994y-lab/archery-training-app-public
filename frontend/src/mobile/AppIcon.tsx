import React from 'react';
const paths={
 bow:'M6 3c8 1 8 17 0 18 M6 3l5 9-5 9 M3 12h18 M18 9l3 3-3 3',
 compound:'M8 4c9 2 9 14 0 16 M8 5v14 M6 4a2 2 0 1 0 4 0 2 2 0 0 0-4 0 M6 20a2 2 0 1 0 4 0 2 2 0 0 0-4 0 M3 12h18',
 barebow:'M7 3c9 3 9 15 0 18 M7 3l4 9-4 9 M4 12h16',
 longbow:'M7 3q14 9 0 18V3 M3 12h18 M18 9l3 3-3 3',
 ruler:'M3 7h18v10H3z M7 7v4 M11 7v3 M15 7v4 M19 7v3',
 hand:'M8 11V5a1.5 1.5 0 0 1 3 0v5-7a1.5 1.5 0 0 1 3 0v7-5a1.5 1.5 0 0 1 3 0v7-3a1.5 1.5 0 0 1 3 0v6c0 4-3 6-6 6h-2c-2 0-3-1-4-3l-4-5c-1-2 1-3 3-1l1 1',
 clock:'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18 M12 7v5l4 2',
 chart:'M4 20V4 M4 20h17 M8 16v-4 M13 16V7 M18 16V9',
 camera:'M3 7h4l2-3h6l2 3h4v14H3z M12 10a4 4 0 1 0 0 8 4 4 0 0 0 0-8',
 back:'M20 12H4 M10 6l-6 6 6 6',
 settings:'M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1z M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8',
 person:'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8 M17 8h5 M19.5 5.5v5',
 target:'M12 3a9 9 0 1 0 9 9 M12 7a5 5 0 1 0 5 5 M12 12l9-9 M16 3h5v5',
 kit:'M4 7h16v14H4z M9 7V3h6v4 M4 12h16 M10 12v3h4v-3',
 calendar:'M4 5h16v16H4z M4 10h16 M8 3v4 M16 3v4 M8 14h2 M14 14h2 M8 18h2',
 draft:'M6 3h12v18H6z M9 8h6 M9 12h6 M9 16h3',
 shield:'M12 3l8 3v6c0 5-8 9-8 9s-8-4-8-9V6z M8 12l3 3 5-6',
 data:'M4 5h16v14H4z M4 10h16 M8 15h3',
 book:'M12 5c-3-2-6-2-9-1v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-3-1-6-1-9 1v15',
 info:'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18 M12 11v6 M12 7v1',
 chat:'M21 11a8 8 0 0 1-8 8H7l-4 3v-6a8 8 0 0 1 7-13h3a8 8 0 0 1 8 8 M7 10h10 M7 14h6',
 qr:'M3 3h6v6H3z M15 3h6v6h-6z M3 15h6v6H3z M15 15h2v2h-2z M21 13v4h-2v4h-6v-2 M11 3v3 M3 11h4 M11 11h4',
 heart:'M12 21 3.5 12.5a5.5 5.5 0 0 1 8-7.5l.5.5.5-.5a5.5 5.5 0 0 1 8 7.5z',
 tea:'M4 8h13v7a6 6 0 0 1-6 6H10a6 6 0 0 1-6-6z M17 9h2a3 3 0 0 1 0 6h-2 M7 3v2 M11 2v3 M15 3v2',
 arrow:'M4 12h16 M14 6l6 6-6 6',
};
export type AppIconName=keyof typeof paths;
export function choiceIcon(label:string,field=''):AppIconName|undefined{
 if(/复合弓/.test(label))return 'compound';
 if(/光弓/.test(label))return 'barebow';
 if(/传统弓|长弓/.test(label))return 'longbow';
 if(/反曲弓|弓种/.test(label+field))return 'bow';
 if(/持弓|左手|右手/.test(label+field))return 'hand';
 if(/距离|米$|厘米|尺寸|直径/.test(label+field))return 'ruler';
 if(/靶面|靶型|均环|环值/.test(label+field))return 'target';
 if(/器材|套组|配件/.test(label+field))return 'kit';
 if(/时间|日期|训练|^\d{2,4}[-/年]/.test(label+field))return 'calendar';
 if(/箭数|箭量|分数|成绩/.test(label+field))return 'chart';
 return undefined;
}
export function AppIcon({name,className=''}:{name:AppIconName;className?:string}){return <svg className={`app-line-icon ${className}`} width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]}/></svg>;}
