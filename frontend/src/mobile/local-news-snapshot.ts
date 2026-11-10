import type {CompetitionEvent} from './competition-calendar.types';

export const localNewsReviewedOn = '2026-11-10';

type Source = {label: string; url: string};
type NewsSection = {title: string; paragraphs: readonly string[]};
type BilingualParagraph = {en: string; zh: string};
export interface LocalNewsArticle {
  id: string;
  category: '赛事' | '训练' | '研究';
  title: string;
  summary: string;
  date: string;
  source: string;
  url: string;
  eventId?: string;
  sections?: readonly NewsSection[];
  originalTitle?: string;
  bilingual?: readonly BilingualParagraph[];
  sources?: readonly Source[];
  image?: {src: string; alt: string; credit: string; sourceUrl: string; licenseUrl: string};
}

const liuzhouNotice = 'https://www.sports.edu.cn/b/a/c/content_3877.shtml';
const liuzhouPdf = 'https://www.sports.edu.cn/b/a/c/images/202610301793348554426_0_617.pdf';
const liuzhouSchool = 'https://news.nyist.edu.cn/info/1002/69277.htm';
const liyangOpen = 'https://jsnews.jschina.com.cn/cz/a/202611/t20261108_s6af001e8e4b0393f8aea8950.shtml';
const wareos = 'https://extranet.worldarchery.sport/wareos/';
const gtSpectator = 'https://www.strassen.lu/fr/agenda/event/2026-11-20/gt-open';
const plos = 'https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0285223';

export const localCompetitions: readonly CompetitionEvent[] = [
  {
    id: '2026-liyang-archery-open',
    name: '“一带一路”群众体育系列赛·国际射箭公开赛',
    level: '大众公开赛', province: '江苏', city: '常州', year: 2026,
    startDate: '2026-11-07', checkedOn: '2026-11-10',
    venue: '溧阳市曹山旅游度假区',
    dateNote: '11月7日开赛。所引报道未注明结束日期。',
    eligibilitySummary: '社会组、国际组、青少年组',
    eligibility: '设社会组、国际组和青少年组，具体资格以当届规程为准。',
    entryNote: '本地快照未收录调整赛期后的报名办法和截止时间。',
    format: '设反曲弓、复合弓、传统弓和光弓，设个人、团体及混合团体项目。',
    links: [{kind: 'report', label: '中国江苏网开赛报道', url: liyangOpen}],
  },
  {
    id: '2026-hangzhou-asia-cup',
    name: '射箭亚洲杯第三站',
    level: '国际赛', province: '浙江', city: '杭州', year: 2026,
    startDate: '2026-11-16', endDate: '2026-11-21', checkedOn: '2026-11-03',
    venue: '黄龙体育场、黄龙东广场',
    eligibilitySummary: '会员协会代表队',
    eligibility: '由世界射箭联合会会员协会组队。',
    entryMethod: '由会员协会通过 WAREOS 提交报名。',
    entryDeadline: '2026-10-25',
    format: '设反曲弓和复合弓，赛程以当届组委会文件为准。',
    links: [
      {kind: 'notice', label: '世界射箭联合会赛事日程', url: 'https://extranet.worldarchery.sport/documents/index.php/Federation/Newsletter_Info/English/2026/01_Jan2026-e.pdf'},
      {kind: 'rules', label: '组委会邀请函（PDF）', url: 'https://documents.worldarchery.sport/Events/World_Ranking/2026/26_WRE_Asia_Cup_Legg_lll_CHN/2026_Hangzhou_China_Invitation_package_V1.0.pdf'},
    ],
  },
  {
    id: 'gt-open-strassen-2026',
    name: 'GT Open 室内射箭世界系列赛',
    level: '室内公开赛', country: '卢森堡', province: '卢森堡', city: '斯特拉森', year: 2026,
    startDate: '2026-11-20', endDate: '2026-11-22', checkedOn: '2026-11-10',
    venue: 'Marcel Balthasar 射箭馆',
    eligibilitySummary: '反曲弓、复合弓射手',
    eligibility: '反曲弓、复合弓设成年、青年及 50 岁以上组别。',
    entryMethod: '从世界射箭联合会赛事报名目录找到本届比赛。',
    individualEntryFrom: '2026-08-30', entryDeadline: '2026-11-09', entryDeadlineZone: 'UTC',
    schedule: ['11月20日：资格赛。', '11月21日：资格赛与个人淘汰赛。', '11月22日：个人淘汰赛与决赛。'],
    spectator: {status: '免费入场', admission: '市政公告确认观众可免费入场，场地停车位有限。', broadcast: '本地快照未收录当届官方直播链接。'},
    links: [
      {kind: 'entry', label: 'WAREOS 赛事报名目录', url: wareos},
      {kind: 'rules', label: '主办方竞赛规程', url: 'https://documents.worldarchery.sport/?doc=7773'},
      {kind: 'schedule', label: '市政赛程公告', url: gtSpectator},
      {kind: 'spectator', label: '斯特拉森市政观赛公告', url: gtSpectator},
    ],
  },
  {
    id: '2026-liuzhou-university-championship',
    name: '学体联全国大学生射箭锦标赛',
    level: '大学生赛', province: '广西', city: '柳州', year: 2026,
    startDate: '2026-10-18', endDate: '2026-10-24', checkedOn: '2026-11-08',
    venue: '柳州铁道职业技术学院',
    dateNote: '10月18日至24日为学校报道所列赛期，南阳理工学院报道10月23日结束竞赛。',
    eligibilitySummary: '高校代表队',
    eligibility: '本科和高职院校组织代表队参加。',
    entryMethod: '通过中国学生体育联合会赛事报名平台办理。',
    entryDeadline: '2026-09-24T18:00:00+08:00',
    format: '设个人、团体和混合团体项目，排位与淘汰阶段分开计列。',
    result: '成绩公示附官方成绩册，查找时可按弓种、组别和项目定位。',
    links: [
      {kind: 'notice', label: '学体联参赛名单公示', url: 'https://www.sports.edu.cn/b/a/c/content_3836.shtml'},
      {kind: 'report', label: '南阳理工学院赛后报道', url: liuzhouSchool},
      {kind: 'results', label: '中国学生体育联合会成绩公示', url: liuzhouNotice},
      {kind: 'results', label: '官方成绩册 PDF', url: liuzhouPdf},
    ],
  },
  {
    id: 'rio-indoor-250-2026',
    name: '里约室内射箭世界系列赛 250',
    level: '室内公开赛', country: '巴西', province: '巴西', city: '里约热内卢', year: 2026,
    startDate: '2026-12-04', endDate: '2026-12-06', checkedOn: '2026-11-08',
    venue: '里约奥林匹克公园 Arena 3（Isabel Salgado 体育馆）',
    eligibilitySummary: '反曲弓、复合弓及裸弓',
    eligibility: '设反曲弓、复合弓及裸弓，年龄组别以规程为准。',
    entryMethod: '个人通过 Open WAREOS 办理。11月12日为最终报名及缴费期限。',
    entryDeadline: '2026-11-12', entryDeadlineZone: 'UTC',
    entryNote: '预报名已截止。是否接受此前未报名的新申请，须向主办方核对。',
    links: [
      {kind: 'entry', label: '世界射箭联合会报名目录', url: wareos},
      {kind: 'rules', label: '主办方竞赛规程 v2.0', url: 'https://documents.worldarchery.sport/?doc=7804'},
      {kind: 'spectator', label: '里约奥林匹克公园赛事消息', url: 'https://parqueolimpico.rio.br/indoor-world-series-rio-250-trara-duelo-marcus-dalmeida-e-brady-ellison/'},
    ],
  },
];

export const localNewsArticles: readonly LocalNewsArticle[] = [
  {
    id: 'liyang-open-2026', eventId: '2026-liyang-archery-open', category: '赛事',
    title: '溧阳曹山射箭公开赛开赛',
    summary: '曹山站设置社会、国际和青少年组，反曲弓、复合弓等四类弓同场参赛。',
    date: '2026-11-08', source: '中国江苏网', url: liyangOpen,
    sections: [
      {title: '项目设置', paragraphs: ['11月7日，公开赛在江苏溧阳曹山开赛。除个人项目外，赛制还安排团体和混合团体，让不同弓种的射手在各自组别比试。']},
      {title: '查看当届信息', paragraphs: ['报道给出了地点和开赛日。本地赛历将未核实的结束日期、报名截止及观赛条件留空。']},
    ],
  },
  {
    id: 'liuzhou-university-2026', eventId: '2026-liuzhou-university-championship', category: '赛事',
    title: '柳州全国大学生射箭锦标赛：怎样查成绩册',
    summary: '柳铁职院赛区汇集本科与高职队伍，官方成绩册按弓种、组别和项目列出名次。',
    date: '2026-10-30', source: '中国学生体育联合会 · 高校报道', url: liuzhouNotice,
    sections: [
      {title: '赛事概况', paragraphs: ['这届比赛在柳州铁道职业技术学院举行。参赛学校报道均提到有56所高校参赛，各报道使用的参赛人数口径有所不同。']},
      {title: '排位赛和淘汰赛分别查', paragraphs: ['以南阳理工学院反曲弓男子甲组为例，校方报道记载该队排位赛第二、淘汰赛夺冠。查询时先找到弓种和组别，再分清个人、团体以及比赛阶段。']},
    ],
    sources: [
      {label: '官方成绩册 PDF', url: liuzhouPdf},
      {label: '南阳理工学院赛后报道', url: liuzhouSchool},
      {label: '四川旅游学院赛后报道', url: 'https://www.sctu.edu.cn/info/1006/42330.htm'},
    ],
  },
  {
    id: 'stability-study-2023', category: '研究',
    title: '训练选读：躯干稳定性与瞄准抖动',
    summary: 'PLOS ONE 的研究测试了针对性练习对瞄准抖动的影响。',
    date: '2023-05-01', source: 'PLOS ONE', url: plos,
    sections: [
      {title: '研究怎么做', paragraphs: ['作者围绕瞄准阶段的上肢抖动，设计了包含侧桥的训练安排，用测量信号比较练习前后的变化。']},
      {title: '怎么看结果', paragraphs: ['观察结果针对这项研究的测量任务和参与者。图1展示研究测量时采用的射箭姿势，具体数据和试验限制可查看原论文。']},
    ],
    image: {
      src: new URL('./assets/plos-one-stability-study-figure-1.png', import.meta.url).href,
      alt: 'PLOS ONE 论文图1：研究中测量时采用的射箭姿势',
      credit: '© 2023 Shinohara 等 / PLOS ONE，图1，未修改',
      sourceUrl: plos,
      licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
    },
  },
  {
    id: 'dvids-203837', category: '赛事',
    title: '双语选读：勇士运动会首次设立视障射箭组',
    summary: '2016年，西点赛场以触觉定位与场边反馈辅助视障组射手。',
    date: '2016-06-20', source: 'Shannon Collins / DVIDS', url: 'https://www.dvidshub.net/news/203837/archers-compete-first-ever-visual-impairment-category-warrior-games',
    originalTitle: 'Archers Compete in First-Ever Visual Impairment Category at Warrior Games',
    bilingual: [
      {en: 'The 2016 Warrior Games at West Point introduced a division for archers with visual impairments.', zh: '2016年在西点举行的勇士运动会首次设置视障射箭组。'},
      {en: 'A tactile reference helped archers repeat their setup. A coach beside the shooting line reported where the arrows had landed.', zh: '触觉参照帮助射手重复定位。场边教练则反馈箭着在靶上的位置。'},
    ],
    sources: [{label: 'DVIDS 版权说明', url: 'https://www.dvidshub.net/about/copyright'}],
  },
];
