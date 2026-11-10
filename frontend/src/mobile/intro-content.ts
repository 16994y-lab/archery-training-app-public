/** Public product explanation only. Images are current UI with synthetic demo records. */
export const INTRO_VERSION = '2026-10-04-v1';
export type IntroPage = { id: string; title: string; description: string; image: string; imageAlt: string; steps: readonly string[] };
export const introPages: readonly IntroPage[] = [
 {id:'welcome',title:'让每一箭，有迹可循',description:'从一次训练开始，留下自己的练习记录。',image:new URL('../../public/assets/onboarding/training-demo.png', import.meta.url).href,imageAlt:'训练首页的当前训练卡，显示开始时间、已录箭数及继续训练入口。',steps:['训练前安排计划，或直接开始临时训练。','训练中逐箭记分，训练后查看历史与复盘。','记录每一箭，看见每一次进步。']},
 {id:'plan',title:'先定方向，再开始',description:'按自己的训练量安排，组数和箭数由你决定。',image:new URL('../../public/assets/onboarding/plan-demo.png', import.meta.url).href,imageAlt:'训练编排卡中的计分段、组数、箭数和添加区块按钮。',steps:['从“计划库”选择计划，或新建自己的计划。','设置靶型、距离、组数和每组箭数。','通过“计划日历”安排训练，也可立即开始。']},
 {id:'score',title:'记下每一箭，也能改',description:'数字录入或点靶录入，按实际成绩核对。',image:new URL('../../public/assets/onboarding/scoring-demo.png', import.meta.url).href,imageAlt:'数字记分页，已录的 X、10 和 M 分别显示，下方为环值键盘。',steps:['X 和普通 10 都计 10 分，分别保留；M 表示确认脱靶。','录错可撤销，或选中已有成绩修改；数字录入不生成落点。','保存本组后继续，结束时确认完成；照片候选须逐箭核对。']},
 {id:'review',title:'回头看，练得更清楚',description:'从已完成的记录中读成绩与变化。',image:new URL('../../public/assets/onboarding/review-demo.png', import.meta.url).href,imageAlt:'复盘概览中的日期范围、实际箭数、场数和均环，数据来自演示训练。',steps:['到“复盘”查看历史、趋势和数据分析。','缺坐标、少样本和未知条件会如实提示。','在“我的”打开使用指南，或到数据管理导出备份。']}
];
