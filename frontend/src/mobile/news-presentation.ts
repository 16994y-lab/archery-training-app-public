import type {NewsArticle,NewsCategory} from './news-feed';
import zhEdition from './news-zh.v1.json';
import abstracts from './news-abstracts.v1.json';
import {reviewedEventStoryFor} from './reviewed-event-news';
export const categoryLabels:Record<NewsCategory,string>={赛事:'赛事',训练:'训练观察',研究:'研究选读'};
export function newsIsPublished(article:NewsArticle){
 // An automatic digest is a candidate for editorial review, even in an older cached feed.
 if(article.id.startsWith('auto-')||article.id==='world-3d-qualifying-2026')return false;
 // Keep the explicitly requested training study as the dated exception to the news window.
 return article.date>='2025-01-01'||(
  article.id==='stability-study-2023'&&article.doi?.toLowerCase()==='10.1371/journal.pone.0285223'
 );
}
export function readingMinutes(article:NewsArticle){return Math.max(1,Math.ceil([article.summary,...article.paragraphs].join('').length/400));}
// Publication age is a cue, never a reason to hide reviewed research.
export function isHistorical(article:NewsArticle,reviewedAt:string){return Date.parse(reviewedAt+'T00:00:00Z')-Date.parse(article.date+'T00:00:00Z')>=365*86400000;}
export function articleSections(article:NewsArticle){
 // Preserve every reviewed paragraph verbatim. No sample size is inferred.
 if(article.doi&&article.paragraphs.length>=2)return [{title:'研究观察',paragraphs:article.paragraphs.slice(0,1)},{title:'限制与训练参考',paragraphs:article.paragraphs.slice(1)}];
 return [{title:article.category==='赛事'?'报道要点':'正文',paragraphs:article.paragraphs}];
}

// Curated topic labels only describe the already reviewed text, not new claims.
const topicTags=new Map<string,string[]>([
 ['national-championship-2026',['锦标赛','反曲弓']],
 ['world-3d-qualifying-2026',['3D','资格赛']],
 ['hand-dexterity-2026',['手部协调','握力']],
 ['aiming-rhythm-2025',['瞄准','节奏']],
 ['stability-study-2023',['侧桥','稳定性']],
]);
export function articleTags(article:NewsArticle){return [categoryLabels[article.category],...(topicTags.get(article.id)??[])];}
const zhArticles:Record<string,{sourceTitle:string;title:string;summary:string}>=zhEdition.articles;
export function newsReadingCopy(article:NewsArticle){
 const reviewed=reviewedEventStoryFor(article);
 if(reviewed)return {title:reviewed.title,summary:reviewed.summary,leadTitle:'导读',sections:reviewed.sections,translationPending:false,navigation:true};
 if(article.id==='national-championship-2026'&&article.url==='https://www.sport.gov.cn/n20001280/n20067662/n20067613/c29691316/content.html'){
  return {
   title:article.title,summary:article.summary,leadTitle:'导读',sourceLabel:'原报道 梁琰 · 中国体育报',
   navigation:true,translationPending:false,
   sections:[
    {title:'赛事概况',paragraphs:['淮南的全国锦标赛与安塔利亚世界杯赛站赛期重叠，参加世界杯的国手因此缺席。']},
    {title:'复合弓',paragraphs:['女子团体半决赛中，山西队的张月、王嘉慧和宋嘉欣射出236环，创该项淘汰赛全国纪录。河南队获得女团金牌。','张月和王嘉慧分别夺得女子个人金牌和银牌，河南队薛征夺得男子个人金牌。男子团体和混合团体金牌分别由福建队和上海队获得。']},
    {title:'反曲弓',paragraphs:['新疆队的马驰雲、刘家乐分获男子、女子个人冠军。海南男队和江苏女队在各自的团体决赛中通过附加一箭夺冠。上海队赢得混合团体冠军。']},
   ],
  };
 }
 if(article.id==='world-3d-qualifying-2026'&&article.url==='https://www.worldarchery.sport/news/202657/defending-champion-cinzia-noziglia-leads-qualifying-completes-yankton-world-3d'){
  return {
   title:article.title,summary:'美国扬克顿赛场结束资格赛后，意大利选手辛齐娅·诺齐利亚（Cinzia Noziglia）以921分排在女子裸弓首位。',
   leadTitle:'中文导读',translationPending:false,
   sections:[{title:'资格赛成绩',paragraphs:[
    '诺齐利亚两天分别得到468分和453分，领先排名第二的美国选手艾娃·琼斯（Ava Jones）20分。',
    '大卫·杰克逊（David Jackson）和尼科·维纳（Nico Wiener）分别领跑男子裸弓和男子复合弓。接下来进行个人与团体淘汰赛。',
   ]}],
  };
 }
 const translated=zhArticles[article.id];
 if(translated?.sourceTitle===article.title)return {title:translated.title,summary:translated.summary,leadTitle:'中文导读',sections:[],translationPending:false};
 const translationPending=!/\p{Script=Han}/u.test(article.title);
 return {title:article.title,summary:article.summary,leadTitle:translationPending?'中文导读':'导读',sections:translationPending||article.id.startsWith('auto-')?[]:articleSections(article),translationPending};
}

export function sourceTranslationFor(article:NewsArticle){
 const abstract=abstracts.find(item=>article.id===item.id&&article.doi?.toLowerCase()===item.doi&&article.url===item.url);
 if(abstract)return abstract;
 if(article.id!=='stability-study-2023'||article.doi?.toLowerCase()!=='10.1371/journal.pone.0285223'||
   article.url!=='https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0285223')return undefined;
 return {
  title:'论文摘要 · 原文与译文',
  sections:[
   {title:'背景',original:'In archery training, side bridges are performed in a posture similar to archery shooting for training the muscles around the shoulder joint and the shoulder girdle of the pusher.',text:'射箭训练中，射手会以类似射箭的姿势做侧桥，训练持弓侧肩关节周围和肩带的肌肉。'},
   {title:'目的',original:'The purpose of this study was to determine whether a low-tremor side-bridge exercise for 4 weeks improves bow tremor during archery movements.',text:'本研究旨在确定，为期 4 周的低震颤侧桥练习能否减轻射箭动作中的弓体震颤。'},
   {title:'方法',original:'Participants were 20 male college students. First, we measured the tremor during side bridges performed with trunk inclinations of 25˚, 40˚, 55˚, and 70˚ using an accelerometer attached to the elbow joint and identified low-tremor side bridges. The participants were then randomly divided into intervention and non-intervention groups, and the low-tremor side bridges were performed for 4 weeks.',text:'受试者为 20 名男性大学生。我们先用固定在肘关节处的加速度计，测量躯干倾角为 25°、40°、55° 和 70° 时做侧桥产生的震颤，找出震颤较小的侧桥姿势。随后将受试者随机分为干预组和非干预组，进行为期 4 周的低震颤侧桥练习。'},
   {title:'结果',original:'The effect of the intervention was determined by measuring the total tremor value using an accelerometer attached to the bow and changes in the median power frequency (MdPF) of the middle deltoid, upper trapezius, and lower trapezius. This intervention reduced the bow tremor and the median power frequency of the middle deltoid (p < 0.05).',text:'我们通过固定在弓上的加速度计测量总震颤值，并测量三角肌中束、斜方肌上部和下部的中位功率频率（MdPF）变化，以评估干预效果。干预降低了弓体震颤和三角肌中束的中位功率频率（p < 0.05）。'},
   {title:'结论',original:'The findings suggested that the tremor during the archery sighting phase could be reduced by performing side bridges with a specific trunk angle for a certain period of time. This intervention was also shown to reduce the intermediate frequency of the middle deltoid. The reduced tremor can shorten the sighting phase, which can facilitate injury prevention.',text:'研究结果提示，以特定的躯干角度做一段时间的侧桥练习，可以减轻射箭瞄准阶段的震颤。结果也显示，这一干预降低了三角肌中束的中间频率。震颤减轻可以缩短瞄准阶段，有助于预防损伤。'},
  ],
  credit:'© 2023 Shinohara 等 · PLOS ONE 18(5): e0285223。弓行记将原文摘要译为中文。',
  licenseUrl:'https://creativecommons.org/licenses/by/4.0/',
 };
}

function normalizeSearch(value:string){return value.normalize('NFKC').trim().toLocaleLowerCase('zh-CN').replace(/\s+/g,' ');}
export function deduplicateNewsRows(articles:NewsArticle[]){
 const seen=new Set<string>();
 return articles.filter(article=>{
  // World Archery retains old slugs when it changes a title. The numeric ID names the same article.
  const identity=article.url.match(/^https:\/\/www\.worldarchery\.sport\/news\/(\d+)(?:\/|$)/)?.[1];
  const key=identity?'worldarchery:'+identity:article.url;
  if(seen.has(key))return false;
  seen.add(key);return true;
 });
}
export function searchArticles(articles:NewsArticle[],query:string){
 const terms=normalizeSearch(query).split(' ').filter(Boolean);
 if(!terms.length)return articles;
 return articles.filter(article=>{
  const copy=newsReadingCopy(article);
  const text=normalizeSearch([copy.title,copy.summary,article.title,article.summary,...article.paragraphs,article.source,article.date,article.category,...articleTags(article)].join(' '));
  return terms.every(term=>text.includes(term));
 });
}
