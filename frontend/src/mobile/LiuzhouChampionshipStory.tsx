import {useLayoutEffect,useRef} from 'react';
import {useLocation,useNavigate} from 'react-router-dom';
import {Back,useInnerBack} from './ui';
import {NewsArticleHeading,NewsSections,PressStoryRow} from './NewsArticleBody';
import {liuzhouResultsPdf} from './events-domestic';
import type {NewsArticle} from './news-feed';

export const liuzhouStoryId='liuzhou-university-2026';
const resultsNotice='https://www.sports.edu.cn/b/a/c/content_3877.shtml';
const entriesNotice='https://www.sports.edu.cn/b/a/c/content_3836.shtml';
export const liuzhouStoryArticle:NewsArticle={
  id:liuzhouStoryId,category:'赛事',source:'弓行记',date:'2026-11-08',url:resultsNotice,paragraphs:[],
  title:'全国大学生射箭锦标赛柳州赛后回顾',
  summary:'汇总柳州铁道职业技术学院、南阳理工学院等参赛队的赛果，附学体联官方成绩册。',
};
export const liuzhouStorySources=[
  {id:'liuzhou-2026-sctu',title:'四川旅游学院参加柳州全国大学生射箭锦标赛',name:'四川旅游学院',date:'2026-10-27',url:'https://www.sctu.edu.cn/info/1006/42330.htm',note:'校队赛后稿，确认举办地点为柳州铁道职业技术学院。'},
  {id:'liuzhou-2026-hzau',title:'华中农业大学在柳州射箭锦标赛获一银一铜',name:'华中农业大学南湖新闻网',date:'2026-10-27',url:'https://news.hzau.edu.cn/info/1009/89718.htm',note:'报道校队获得一银一铜，并交代了参赛阵容。'},
  {id:'liuzhou-2026-eol-xac',title:'西安培华学院在柳州射箭锦标赛获三金一银',name:'教育在线陕西站',date:'2026-10-27',url:'https://www.eol.cn/shaanxi/shxgd/202610/t20261027_2787032.shtml',note:'媒体刊载西安培华学院射箭队三金一银的赛后消息。'},
  {id:'liuzhou-2026-nyist',title:'南阳理工学院男队获柳州射箭锦标赛团体冠军',name:'南工新闻网',date:'2026-10-26',url:'https://news.nyist.edu.cn/info/1002/69277.htm',note:'报道南阳理工学院男队从团体排位第二到淘汰赛夺冠。'},
  {id:'liuzhou-2026-jxpu',title:'江西职业技术大学报道柳州射箭锦标赛乙组赛况',name:'江西职业技术大学',date:'2026-10-26',url:'https://www.jxpu.edu.cn/info/1021/34570.htm',note:'报道高职乙组的复合弓、反曲弓赛况，并给出参赛规模。'},
];

export const liuzhouReportArticles:NewsArticle[]=liuzhouStorySources.map(({id,title,name,date,url,note})=>({
  id,title,source:name,date,url,category:'赛事',summary:note,paragraphs:[],
}));

function External({url,children}:{url:string;children:string}){
  return <a href={url} target={window.Gongxingji?'_self':'_blank'} rel="noopener noreferrer">{children}<span aria-hidden="true"> ↗</span></a>;
}

export function LiuzhouSourceRows(){
  return <>{liuzhouStorySources.map(source=><PressStoryRow key={source.url} link={{href:source.url}} title={source.name+'赛后报道'} summary={source.note}
    meta={<>报道原文<span>·</span><time dateTime={source.date}>{source.date}</time></>}/>)}</>;
}

export function LiuzhouChampionshipStory(){
  const navigate=useNavigate();
  const location=useLocation();
  const title=useRef<HTMLHeadingElement>(null);
  const fromMeet=Boolean(location.state?.fromMeetDetail);
  const back=()=>{if(fromMeet||location.state?.fromLiuzhouCard||location.state?.fromNewsList===liuzhouStoryId)navigate(-1);else navigate('/news',{replace:true});};
  useInnerBack(true,back,30);
  useLayoutEffect(()=>{window.scrollTo(0,0);title.current?.focus({preventScroll:true});},[]);
  return <div className="news-page">
    <Back title="资讯详情" label={fromMeet?'返回赛事详情':'返回资讯'} onBack={back}/>
    <article className="news-article">
      <NewsArticleHeading title={liuzhouStoryArticle.title} titleRef={title} source="弓行记 · 赛事专题" date={liuzhouStoryArticle.date}/>
      <NewsSections sections={[
      {title:'从报名到比赛',body:<>
      <p>2026年10月18日至24日，全国大学生射箭锦标赛在广西柳州举行。学体联成绩册列明，中国学生体育联合会主办，广西学校体育卫生艺术学会承办。四川旅游学院赛后报道确认比赛设在柳州铁道职业技术学院。江西职业技术大学报道本届共有56所高校、405名运动员参赛。</p>
      <p>参赛以高校代表队为单位，赛前由学体联公示参赛名单。成绩册按反曲弓、复合弓及不同组别组织，分别列出个人、团体和混合团体的排位或淘汰赛成绩。南工新闻网报道比赛于10月23日落幕，学体联成绩册封面列出的整体赛期到10月24日。</p>
      <p><External url={entriesNotice}>学体联赛前参赛名单公示</External></p>
      </>},
      {title:'赛场结果',body:
      <ul className="event-story-results">
        <li><strong>柳州铁道职业技术学院</strong>在复合弓男子乙组团体排位赛获第三，三人合计1539环，团体淘汰赛也列第三。该组团体决赛前两名是许昌职业技术学院、江西职业技术大学。<External url={liuzhouResultsPdf+'#page=122'}>团体排位（PDF第122页）</External> · <External url={liuzhouResultsPdf+'#page=126'}>团体决赛（第126页）</External></li>
        <li><strong>南阳理工学院</strong>在反曲弓男子甲组团体排位以1876环列第二，随后获得团体淘汰赛冠军。<External url={liuzhouResultsPdf+'#page=29'}>团体排位（第29页）</External> · <External url={liuzhouResultsPdf+'#page=34'}>团体决赛（第34页）</External></li>
        <li><strong>华中农业大学</strong>在反曲弓女子甲组个人30米双轮以656环获第二，另获反曲弓甲组混合团体淘汰赛第三。<External url={liuzhouResultsPdf+'#page=19'}>个人排位（第19页）</External> · <External url={liuzhouResultsPdf+'#page=37'}>混合团体决赛（第37页）</External></li>
        <li><strong>上海工程技术大学</strong>选手吴宇洲在复合弓男子丁组个人50米双轮以667环获第一，个人淘汰赛也获第一。<External url={liuzhouResultsPdf+'#page=159'}>个人排位（第159页）</External> · <External url={liuzhouResultsPdf+'#page=160'}>个人决赛（第160页）</External></li>
      </ul>},
      {title:'赛后报道与成绩查询',body:<>
      <p>中国学生体育联合会于10月30日发布成绩公示。查成绩时可先从 PDF 第2页进入目录，再按弓种、组别、项目定位。排位赛名次和淘汰赛名次分别公布。</p>
      <div className="event-story-actions"><External url={liuzhouResultsPdf}>打开或下载成绩册 PDF（161页）</External><External url={resultsNotice}>学体联成绩公示</External></div>
      <ul className="press-list"><LiuzhouSourceRows/></ul>
      </>},
      ]}/>
    </article>
  </div>;
}
