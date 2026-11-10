import type {CompetitionEvent} from './competition-calendar.types';

export const regionalEvents:readonly CompetitionEvent[]=[
  {
    id:'taoyuan-youth-traditional-2026',name:'乌尼囊关怀杯青少年传统射箭邀请赛',level:'青少年邀请赛',
    province:'台湾',city:'桃园',year:2026,checkedOn:'2026-11-03',
    startDate:'2026-12-12',endDate:'2026-12-12',venue:'复兴区三民里活动中心传统射箭场',
    eligibility:'限本学年在台湾（含离岛）就读幼儿园或小学的选手。小学四至六年级可个人申请，由主办方协助组队。',
    individualEntryFrom:'2026-10-06',entryDeadline:'2026-11-20',
    entryMethod:'从简章第 2 页扫码填表，再按简章寄送同意及保证书。家长同意书须于 11 月 27 日前送达。',
    entryNote:'比赛免费，分组限额。简章未列截止时刻。扫码后的表单是否仍有名额尚未核实。',
    links:[
      {kind:'notice',label:'赛事公告与报名文件',url:'https://www.wanrung.gov.tw/News_Content.aspx?n=8136&s=231753'},
      {kind:'entry',label:'竞赛简章第 2 页 · 扫码报名',url:'https://ws.hl.gov.tw/Download.ashx?n=56u26LO957Ch56ugLnBkZg%3D%3D&u=LzAwMS9VcGxvYWQvNDY3L3JlbGZpbGUvMTQzOTAvMjMxNzUzL2Y2ZTlmNWUxLWY1ZjktNDRhZS1hOWUzLTExNmNiYzM3NTgzYy5wZGY%3D#page=2'},
    ],
  },
  {
    id:'taichung-university-traditional-2026',name:'大专校院国术锦标赛 · 传统弓术',level:'高校赛',
    province:'台湾',city:'台中',year:2026,checkedOn:'2026-11-03',
    startDate:'2026-11-30',endDate:'2026-12-01',venue:'台湾体育运动大学体育馆（北区双十路一段 16 号）',
    dateNote:'日期为整届锦标赛赛期。',
    eligibility:'限大专院校体育总会会员学校本学期正式注册的学生，由学校统一报名。',
    entryDeadline:'2026-11-09T17:00:00+08:00',
    entryMethod:'由学校网上填报。领队或教练签名、学校盖章后电邮扫描件，并按规程于截止日寄出正本。',
    links:[
      {kind:'entry',label:'传统弓术专用报名表（学校填报）',url:'https://www.beclass.com/rid=30527da6a8e6f4449aa7'},
      {kind:'rules',label:'校方公告、参赛规程与附件',url:'https://www.ouk.edu.tw/ActivitiesDetailC001100.aspx?Cond=96901220-7fb7-4b85-9da5-5670dc29774a'},
    ],
  },
  {
    id:'xian-nwu-health-cup-2026',name:'西北大学体育文化节“健康杯”射艺比赛',level:'校内赛',
    province:'陕西',city:'西安',year:2026,checkedOn:'2026-11-03',
    startDate:'2026-05-30',endDate:'2026-05-31',venue:'西北大学长安校区射艺场（智华体育场西北角外）',
    eligibility:'长安、太白校区身体健康且有保险的在籍本科生和研究生，按院系组队。',
    entryDeadline:'2026-05-20',entryMethod:'院系领队下载学校报名表，按规程电邮给校方负责人。',
    format:'设传统弓、反曲弓和复合弓项目。',
    links:[{kind:'entry',label:'西北大学竞赛规程、报名表及递交方式',url:'https://tyb.nwu.edu.cn/info/1096/2953.htm'}],
  },
  {
    id:'guangzhou-tathlum-outdoor-2026',name:'尚盛·弓夫杯射箭星球室外邀请赛',level:'大众邀请赛',
    province:'广东',city:'广州',year:2026,checkedOn:'2026-11-03',
    startDate:'2026-04-11',endDate:'2026-04-12',venue:'广东女子职业技术学院番禺校区',
    dateNote:'报名通知原列 4 月 10 至 12 日，主办方赛后确认实际比赛为 11 至 12 日。',
    eligibility:'成人及青少年依弓种分组，另设初学者反曲弓 18 米组。',
    entryDeadline:'2026-04-03T18:00:00+08:00',entryMethod:'主办方比赛通知附报名说明及报名表下载二维码。',
    links:[
      {kind:'entry',label:'主办方比赛通知及报名表',url:'https://tathlum-archery.com/sys-nd/47.html'},
      {kind:'report',label:'主办方收官消息（4 月 14 日）',url:'https://www.tathlum-archery.com/sys-nr/?g=1'},
    ],
  },
  {
    id:'anji-field-2026',name:'全国野外射箭赛（浙江湖州）',level:'大众赛事',
    province:'浙江',city:'湖州',year:2026,checkedOn:'2026-11-03',
    startDate:'2026-06-12',endDate:'2026-06-14',venue:'安吉县杭垓镇大梅海景区',
    dateNote:'6 月 12 日报到，13 日开幕。',
    eligibility:'无代表单位的运动员可按当届规程个人报名。有代表单位的，单位须先在中国射箭协会注册。',
    entryDeadline:'2026-06-01',entryMethod:'扫描补充通知中的报名二维码。5 月 12 日开放，满 300 人提前截止。',
    links:[
      {kind:'notice',label:'射运中心补充通知及当届报名二维码（转载）',url:'https://npo0717xg.npoall.com/news/itemid-263489.html'},
      {kind:'report',label:'潮新闻现场报道',url:'https://tidenews.com.cn/news.html?id=3476044'},
    ],
  },
  {
    id:'chongqing-sichuan-youth-2026',name:'“奔跑吧·少年”川渝射箭交流活动',level:'地区青少年赛',
    province:'重庆',city:'重庆',year:2026,checkedOn:'2026-11-03',
    startDate:'2026-05-21',endDate:'2026-05-24',venue:'永川区体育中心',
    eligibility:'由川渝两地体育部门、体校、中小学校和俱乐部组队。按年龄分组，运动员须符合规程中的体检和保险要求。',
    entryDeadline:'2026-05-05',entryMethod:'代表队填写并盖章，按规程电邮报名材料。',
    links:[{kind:'entry',label:'重庆市体育局竞赛规程及代表队报名表',url:'https://tyj.cq.gov.cn/tygz/qsnty/202604/t20260421_15625844.html'}],
  },
  {
    id:'jinjiang-youth-open-2026',name:'全国青少年大众射箭公开赛（福建晋江）',level:'青少年公开赛',
    province:'福建',city:'泉州',year:2026,checkedOn:'2026-11-03',
    startDate:'2026-02-07',endDate:'2026-02-08',venue:'晋江市足球训练中心',
    dateNote:'本届沿用 2025 年赛事名称，延期至 2026 年 2 月举办。运动员 6 日报到，7 至 8 日比赛。',
    eligibility:'设 U12、U14、U16、U18 组。须符合当届参赛年龄及安全要求，未成年人需监护人同意。',
    entryDeadline:'2026-01-23',entryMethod:'按协会补充通知中的运动员报名二维码申报。通知列有俱乐部、协会及院校等参赛单位。',
    links:[
      {kind:'notice',label:'中国射箭协会补充通知及当届报名二维码（转载）',url:'https://npo0717xg.npoall.com/news/itemid-222364.html'},
      {kind:'report',label:'晋江经济报比赛报道',url:'https://jjjjb.fjdaily.com/pc/con/202602/09/content_512501.html'},
    ],
  },
];
