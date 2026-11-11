package app.gongxingji.training.debug;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.Set;
import java.net.URI;
public final class ReviewedNewsImagePolicy {
 public static final int MAX_BYTES=600000;
 private static final Set<String> URLS=Collections.unmodifiableSet(new HashSet<>(Arrays.asList(
  "https://www.frontiersin.org/files/Articles/1650300/xml-images/fspor-07-1650300-g001.webp",
  "https://www.frontiersin.org/files/Articles/1880932/xml-images/fphys-17-1880932-g001.webp",
  "https://journals.plos.org/plosone/article/figure/image?id=10.1371%2Fjournal.pone.0285223.g001&size=inline"
 )));
 private static final String LIUZHOU_RESULTS="https://www.sports.edu.cn/b/a/c/images/202610301793348554426_0_617.pdf";
 private static final Set<String> COMPETITION_LINKS=Collections.unmodifiableSet(new HashSet<>(Arrays.asList(
  "https://www.beclass.com/rid=30527da6a8e6f4449aa7",
  "https://www.ouk.edu.tw/ActivitiesDetailC001100.aspx?Cond=96901220-7fb7-4b85-9da5-5670dc29774a",
  "https://www.gt-s.lu/registration-272627v4",
  "https://documents.worldarchery.sport/?doc=7773",
  "https://www.strassen.lu/fr/agenda/event/2026-11-20/gt-open",
  "https://www.gt-s.lu/gt-open-world-series-272598v4",
  "https://extranet.worldarchery.sport/wareos/",
  "https://documents.worldarchery.sport/?doc=7804",
  "https://parqueolimpico.rio.br/indoor-world-series-rio-250-trara-duelo-marcus-dalmeida-e-brady-ellison/",
  "https://www.wanrung.gov.tw/News_Content.aspx?n=8136&s=231753",
  "https://ws.hl.gov.tw/Download.ashx?n=56u26LO957Ch56ugLnBkZg%3D%3D&u=LzAwMS9VcGxvYWQvNDY3L3JlbGZpbGUvMTQzOTAvMjMxNzUzL2Y2ZTlmNWUxLWY1ZjktNDRhZS1hOWUzLTExNmNiYzM3NTgzYy5wZGY%3D#page=2",
  "https://www.archery.org.hk/taxonomy/term/41",
  "https://www.archery.org.hk/system/files/EventCalendar2026-2027_1.pdf",
  "https://documents.worldarchery.sport/Events/World_Ranking/2026/26_WRE_Asia_Cup_Legg_lll_CHN/2026_Hangzhou_China_Invitation_package_V1.0.pdf",
  "https://extranet.worldarchery.sport/documents/?dir=1403",
  "https://www.sports.edu.cn/b/a/c/content_3836.shtml",
  "https://www.sports.edu.cn/b/a/c/content_3877.shtml",
  "https://www.sports.edu.cn/web/html/competition/wonderful-apply.html",
  "https://www.sctu.edu.cn/info/1006/42330.htm",
  "https://news.nyist.edu.cn/info/1002/69277.htm",
  "https://news.hzau.edu.cn/info/1009/89718.htm",
  "https://www.jxpu.edu.cn/info/1021/34570.htm",
  "https://www.eol.cn/shaanxi/shxgd/202610/t20261027_2787032.shtml",
  "https://tyj.jl.gov.cn/xwzx/tzgg/202605/P020260513503464928913.pdf",
  "https://weibo.com/2/detail/5332641482020377",
  "https://jsnews.jschina.com.cn/cz/a/202611/t20261108_s6af001e8e4b0393f8aea8950.shtml",
  "https://npo0717xg.npoall.com/news/itemid-243523.html",
  "https://npo0717xg.npoall.com/news/itemid-262610.html",
  "https://npo0717xg.npoall.com/news/itemid-294442.html",
  "https://www.zd.gov.cn/columns/1ebb97b2-ca47-4434-a3ce-48a6de0713c3/202606/01/1aa9f661-d2a3-4ff9-8441-f2dc591f8556.html",
  "https://www.njgc.gov.cn/jrgc/gcyw/202604/t20260421_5827217.html",
  "https://www.yzwb.net/news/ty/202604/t20260418_343623.html",
  "https://www.elongoutdoor.com/cn/new/new-30-51.html",
  "https://paper.ycnews.cn/wb/wap/content/202610/14/content_366000.html",
  "https://m.weibo.cn/2/detail/5356521216279409",
  "https://m.sohu.com/a/1060655195_362042",
  "https://bd.hebccw.cn/system/2026/08/16/102213684.shtml",
  "https://tathlum-archery.com/sys-nd/47.html",
  "https://www.tathlum-archery.com/sys-nr/?g=1",
  "https://www.jinjiang.gov.cn/xxgk/zdxxgk/ggwhty/gyxtysshhd/202604/t20260413_3283025.htm",
  "https://jjjjb.fjdaily.com/pc/att/202604/27/31c887c9-a5e3-43e4-9f89-b5af952df818.pdf",
  LIUZHOU_RESULTS
 )));
 private static final Set<String> EDITORIAL_SOURCES=Collections.unmodifiableSet(new HashSet<>(Arrays.asList(
  "https://sports.nanjing.gov.cn/gzdt/202610/t20261026_6025580.html",
  "https://www.sport.org.cn/shouye/jd/2026/1023/712529.html",
  "https://www.sports.cn/tcdt/tcjsby/2026/1030/713213.html",
  "https://tyj.xinjiang.gov.cn/xjtyj/c112527/202610/9ccf2318b11445578d42759ef69576b6.shtml",
  "https://www.fitarco.it/media-fitarco/news/34-internazionale/11958-frangilli-e-noziglia-da-record-a-gallarate.html",
  "https://www.fitarco-italia.org/arcieri/situazione.php?Codice=3671",
  "https://commons.wikimedia.org/wiki/File:Michele_Frangilli_001.jpg",
  "https://creativecommons.org/licenses/by/3.0/nl/",
  "https://commons.wikimedia.org/wiki/File:%E5%8D%97%E4%BA%AC%E7%8E%84%E6%AD%A6%E6%B9%96%E6%A8%B1%E6%B4%B2_-_panoramio_(1).jpg",
  "https://creativecommons.org/licenses/by/3.0/"
 )));
 public static boolean allowed(String url,String method){return "GET".equals(method)&&URLS.contains(url);}
 public static boolean allowedRedirect(String original,String target){
  if(!"https://journals.plos.org/plosone/article/figure/image?id=10.1371%2Fjournal.pone.0285223.g001&size=inline".equals(original)||target==null)return false;
  try {URI uri=new URI(target);return "https".equals(uri.getScheme())&&"storage.googleapis.com".equals(uri.getHost())&&uri.getPort()==-1&&uri.getRawUserInfo()==null&&uri.getRawFragment()==null&&"/plos-corpus-prod/10.1371/journal.pone.0285223/1/pone.0285223.g001.PNG_I".equals(uri.getRawPath());}
  catch(Exception invalid){return false;}
 }
 public static boolean allowedBrowserLink(String url){
  return COMPETITION_LINKS.contains(url)||EDITORIAL_SOURCES.contains(url)||isLiuzhouResultsPage(url)
   ||"https://www.frontiersin.org/journals/physiology/articles/10.3389/fphys.2026.1880932/full".equals(url)
   ||"https://www.frontiersin.org/journals/sports-and-active-living/articles/10.3389/fspor.2025.1650300/full".equals(url)
   ||"https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0285223".equals(url)
   ||"https://www.dvidshub.net/news/168267/army-team-sweeps-gold-during-dod-warrior-games-archery".equals(url)
   ||"https://www.dvidshub.net/news/203837/archers-compete-first-ever-visual-impairment-category-warrior-games".equals(url)
   ||"https://www.dvidshub.net/image/2030581/army-sweeps-gold-dod-warrior-games".equals(url)
   ||"https://www.dvidshub.net/image/2719192/2016-warrior-games-archery".equals(url)
   ||"https://www.dvidshub.net/image/2669558/2016-warrior-games-archery".equals(url)
     ||"https://creativecommons.org/licenses/by/4.0/".equals(url)
     ||"https://commons.wikimedia.org/wiki/File:Arena_Carioca_3.jpg".equals(url)
     ||"https://creativecommons.org/licenses/by/3.0/br/".equals(url);
 }
 private static boolean isLiuzhouResultsPage(String url){
  String prefix=LIUZHOU_RESULTS+"#page=";
  if(url==null||!url.startsWith(prefix))return false;
  String page=url.substring(prefix.length());
  return page.matches("[1-9][0-9]{0,2}")&&Integer.parseInt(page)<=161;
 }
 public static boolean validPayload(String mime,byte[] bytes){
  if(bytes==null||bytes.length<12||bytes.length>MAX_BYTES)return false;
  if("image/webp".equals(mime))return bytes[0]=='R'&&bytes[1]=='I'&&bytes[2]=='F'&&bytes[3]=='F'&&bytes[8]=='W'&&bytes[9]=='E'&&bytes[10]=='B'&&bytes[11]=='P';
  if("image/png".equals(mime))return (bytes[0]&255)==137&&bytes[1]==80&&bytes[2]==78&&bytes[3]==71&&bytes[4]==13&&bytes[5]==10&&bytes[6]==26&&bytes[7]==10;
  return "image/jpeg".equals(mime)&&(bytes[0]&255)==255&&(bytes[1]&255)==216&&(bytes[2]&255)==255;
 }
 private ReviewedNewsImagePolicy(){}
}
