import type {NewsArticle} from './news-feed';
export type ReviewedNewsImage={articleUrl:string;doi?:string;src:string;alt:string;caption:string;credit:string;licenseUrl:string;sourceUrl?:string};
// Keep the exact reviewed originals local so WebView can also render them offline.
const frontiersAimingFigure=new URL('../../public/ui/frontiers-aiming-rhythm-figure-1.webp',import.meta.url).href;
const frontiersDexterityFigure=new URL('../../public/ui/frontiers-hand-dexterity-figure-1.webp',import.meta.url).href;
const plosStabilityFigure=new URL('../../public/ui/plos-one-stability-study-figure-1.png',import.meta.url).href;
const frangilliPhoto=new URL('../../public/ui/michele-frangilli-2004.jpg',import.meta.url).href;
export const nanjingVenuePhoto={
 src:new URL('../../public/ui/nanjing-xuanwu-yingzhou-2014.webp',import.meta.url).href,
 alt:'2014 年南京玄武湖樱洲景色',
 caption:'决赛场地资料图 · 南京玄武湖樱洲（2014）',
 credit:'helkonig · CC BY 3.0 · 缩放',
 sourceUrl:'https://commons.wikimedia.org/wiki/File:%E5%8D%97%E4%BA%AC%E7%8E%84%E6%AD%A6%E6%B9%96%E6%A8%B1%E6%B4%B2_-_panoramio_(1).jpg',
 licenseUrl:'https://creativecommons.org/licenses/by/3.0/',
};
export const reviewedImages:Record<string,ReviewedNewsImage>={
 'auto-3822a77f285dfb6704bc1287':{
  articleUrl:'https://www.worldarchery.sport/news/202714/michele-frangilli-breaks-fourth-50-world-record-familiar-venue',
  src:frangilliPhoto,alt:'米凯莱·弗兰吉利在射箭场拉弓的资料照片',
  caption:'米凯莱·弗兰吉利 · 2004 年资料照',credit:'Fieldarcher.org · CC BY 3.0 Netherlands',
  sourceUrl:'https://commons.wikimedia.org/wiki/File:Michele_Frangilli_001.jpg',licenseUrl:'https://creativecommons.org/licenses/by/3.0/nl/',
 },
 'nanjing-outdoor-nationals-2026':{
  articleUrl:'https://www.sport.gov.cn/n20001280/n20067662/n20067613/c30129234/content.html',...nanjingVenuePhoto,
 },
 'aiming-rhythm-2025':{articleUrl:'https://www.frontiersin.org/journals/sports-and-active-living/articles/10.3389/fspor.2025.1650300/full',doi:'10.3389/fspor.2025.1650300',src:frontiersAimingFigure,alt:'原论文图1，射手身上的传感器位置示意',caption:'原论文图1：传感器布置。用于说明研究方法。',credit:'Jacquot 等，2025 · Frontiers · CC BY · 原图完整显示',licenseUrl:'https://creativecommons.org/licenses/by/4.0/'},
 'hand-dexterity-2026':{articleUrl:'https://www.frontiersin.org/journals/physiology/articles/10.3389/fphys.2026.1880932/full',doi:'10.3389/fphys.2026.1880932',src:frontiersDexterityFigure,alt:'原论文图1，三组受试者的手部操作和握力比较图',caption:'原论文图1：三组比较。研究为横断面设计，图中差异不能解释为训练因果。',credit:'Gao 等，2026 · Frontiers · CC BY · 原图完整显示',licenseUrl:'https://creativecommons.org/licenses/by/4.0/'},
 'stability-study-2023':{articleUrl:'https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0285223',doi:'10.1371/journal.pone.0285223',src:plosStabilityFigure,alt:'原论文图1，实验中射箭任务的姿势示意与角度标注',caption:'原论文图1：实验任务姿势。图示用于说明实验条件，不是通用训练处方。',credit:'Shinohara 等，2023 · PLOS ONE · CC BY · 原图完整显示',licenseUrl:'https://creativecommons.org/licenses/by/4.0/'},
};
export function imageForArticle(article:NewsArticle){const image=Object.prototype.hasOwnProperty.call(reviewedImages,article.id)?reviewedImages[article.id]:undefined;return image&&article.url===image.articleUrl&&article.doi?.toLowerCase()===image.doi?image:undefined;}
