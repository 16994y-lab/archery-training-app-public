import type {NewsArticle} from './news-feed';
import stories from './reviewed-event-news.json';

type ReviewedStory=NewsArticle&{
 eventId?:string;
 sections:readonly {title:string;paragraphs:readonly string[]}[];
 sources?:readonly {label:string;url:string}[];
};

export const reviewedEventNews:readonly ReviewedStory[]=stories.map(story=>({
 ...story,category:'赛事',paragraphs:story.sections.flatMap(section=>section.paragraphs),
}));

export function reviewedEventStoryFor(article:NewsArticle){
 return reviewedEventNews.find(story=>story.id===article.id&&story.url===article.url);
}
