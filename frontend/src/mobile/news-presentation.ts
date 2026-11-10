import type {NewsArticle,NewsCategory} from './news-feed';
export const categoryLabels:Record<NewsCategory,string>={赛事:'赛事',训练:'训练观察',研究:'研究选读'};
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
function normalizeSearch(value:string){return value.normalize('NFKC').trim().toLocaleLowerCase('zh-CN').replace(/\s+/g,' ');}
export function searchArticles(articles:NewsArticle[],query:string){
 const terms=normalizeSearch(query).split(' ').filter(Boolean);
 if(!terms.length)return articles;
 return articles.filter(article=>{
  const text=normalizeSearch([article.title,article.summary,...article.paragraphs,article.source,article.date,article.category,...articleTags(article)].join(' '));
  return terms.every(term=>text.includes(term));
 });
}
