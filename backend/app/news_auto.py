"""Bounded official-source briefs. This publisher uses rules, not a language model."""
from __future__ import annotations
import copy
import hashlib
import json
import re
import time
from datetime import date, timedelta
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urljoin, urlsplit
from urllib.request import Request, HTTPRedirectHandler, ProxyHandler, build_opener

ASSETS = Path(__file__).with_name('news_assets')
WA_LIST = 'https://www.worldarchery.sport/news'
SPORT_LIST = 'https://www.sport.gov.cn/n20001280/n20067662/n20067613/index.html'
MAX_BYTES = 180000
MAX_GETS = 6

def encode(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8')

def digest(value):
    return hashlib.sha256(encode(value)).hexdigest()

def baseline():
    feed = json.loads((ASSETS / 'manual-feed.json').read_text(encoding='utf-8'))
    return {'schema': 'gxj-news-publication-v1', 'feed': feed,
            'detailBaseline': copy.deepcopy(feed),
            'details': json.loads((ASSETS / 'manual-details.json').read_text(encoding='utf-8')),
            'provenance': []}

def clean(value):
    return re.sub(r'\s+', ' ', value).strip()

def safe(value, maximum):
    return isinstance(value, str) and 0 < len(value.encode('utf-16-le')) // 2 <= maximum and not re.search(r'[<>\x00-\x1f\x7f]', value)

def official_url(url, listing=False):
    if not isinstance(url, str):
        return False
    p = urlsplit(url)
    if p.scheme != 'https' or p.username or p.password or p.port or p.query or p.fragment:
        return False
    if listing and url in (WA_LIST, SPORT_LIST):
        return True
    return ((p.hostname == 'www.worldarchery.sport' and bool(re.fullmatch(r'/news/\d+/[a-z0-9-]+', p.path))) or
            (p.hostname == 'www.sport.gov.cn' and bool(re.fullmatch(r'/n\d+(?:/n\d+)*/c\d+/content.html', p.path))))

class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None

class BudgetFetcher:
    def __init__(self):
        self.deadline = time.monotonic() + 40
        self.gets = 0
        self.opener = build_opener(ProxyHandler({}), NoRedirect())

    def __call__(self, url):
        remaining = self.deadline - time.monotonic()
        if not official_url(url, True) or self.gets >= MAX_GETS or remaining <= 0:
            raise ValueError('SOURCE_BUDGET_OR_URL')
        self.gets += 1
        request = Request(url, headers={'User-Agent': 'Gongxingji-News/1.0', 'Accept': 'text/html', 'Accept-Encoding': 'identity'})
        with self.opener.open(request, timeout=min(8, remaining)) as response:
            if response.status != 200 or response.geturl() != url or response.headers.get_content_type() != 'text/html':
                raise ValueError('SOURCE_RESPONSE')
            raw = bytearray()
            while len(raw) <= 1000000:
                if time.monotonic() >= self.deadline:
                    raise ValueError('SOURCE_DEADLINE')
                chunk = response.read(min(16384, 1000001 - len(raw)))
                if not chunk:
                    break
                raw.extend(chunk)
            if len(raw) > 1000000:
                raise ValueError('SOURCE_TOO_LARGE')
            return bytes(raw)

class Page(HTMLParser):
    """Only known article containers, not global navigation or scripts."""
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack = []
        self.meta = {}
        self.canonicals = []
        self.links = []
        self.times = []
        self.paragraphs = []
        self.pieces = []
        self.paragraph_depth = None
        self.link = None
        self.link_words = []
        self.title_words = []
        self.category_words = []

    def primary(self):
        return any(t == 'article' and 'article--full' in a.get('class', '').split() for t, a in self.stack)

    def header(self):
        return self.primary() and any('article__header' in a.get('class', '').split() for _, a in self.stack)

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'meta':
            self.meta.setdefault((attrs.get('property') or attrs.get('name') or '').lower(), []).append(attrs.get('content', ''))
        if tag == 'link' and attrs.get('rel') == 'canonical':
            self.canonicals.append(attrs.get('href', ''))
        if tag in ('meta', 'link', 'img', 'br', 'hr', 'input', 'source', 'wbr'):
            return
        self.stack.append((tag, attrs))
        if tag == 'time' and self.header() and any('article__field-publish-date' in a.get('class', '') for _, a in self.stack):
            self.times.append(attrs.get('datetime', ''))
        if tag == 'a':
            self.link = attrs.get('href', '')
            self.link_words = []
        if tag == 'p' and any((self.primary() and 'wysiwyg__field-body' in a.get('class', '').split()) or a.get('id') == 'zoom' for _, a in self.stack):
            self.paragraph_depth = len(self.stack)
            self.pieces = []

    def handle_endtag(self, tag):
        if tag == 'p' and self.paragraph_depth is not None:
            text = clean(''.join(self.pieces))
            if text:
                self.paragraphs.append(text)
            self.paragraph_depth = None
        if tag == 'a' and self.link is not None:
            self.links.append((self.link, clean(''.join(self.link_words))))
            self.link = None
        for i in range(len(self.stack) - 1, -1, -1):
            if self.stack[i][0] == tag:
                del self.stack[i:]
                break

    def handle_data(self, data):
        if any(t in ('script', 'style', 'iframe', 'template', 'noscript') for t, _ in self.stack):
            return
        if self.paragraph_depth is not None:
            self.pieces.append(data)
        if self.link is not None:
            self.link_words.append(data)
        if self.header() and any(t == 'h1' for t, _ in self.stack):
            self.title_words.append(data)
        if self.header() and any('article__field-content-category' in a.get('class', '').split() for _, a in self.stack):
            self.category_words.append(data)

def parse_page(raw):
    if len(raw) > 1000000:
        raise ValueError('SOURCE_TOO_LARGE')
    page = Page()
    page.feed(raw.decode('utf-8', errors='strict'))
    return page

def article(raw, url, today):
    page = parse_page(raw)
    if urlsplit(url).hostname == 'www.worldarchery.sport':
        title = clean(''.join(page.title_words))
        dates = page.times
        if clean(''.join(page.category_words)) != 'News':
            raise ValueError('NON_NEWS')
    else:
        # Fail closed if the official Chinese source's declared metadata changes.
        title = clean(''.join(page.meta.get('articletitle', [])))
        dates = page.meta.get('pubdate', [])
    canonical = page.canonicals or page.meta.get('og:url', [])
    if len(canonical) != 1 or canonical[0] != url or len(dates) != 1:
        raise ValueError('SOURCE_IDENTITY_OR_DATE')
    published = date.fromisoformat(dates[0][:10])
    if not today - timedelta(days=14) <= published <= today:
        raise ValueError('SOURCE_DATE_WINDOW')
    body = ' '.join(page.paragraphs)
    if not safe(title, 160) or not 200 <= len(body) <= 120000 or not re.search(r'archer|archery|recurve|compound|射箭|反曲弓|复合弓', title + ' ' + body, re.I):
        raise ValueError('SOURCE_BODY_OR_TOPIC')
    # Original title plus quote together stay within 25 words / 160 Chinese characters.
    is_chinese = bool(re.search(r'[\u4e00-\u9fff]', title))
    if is_chinese:
        if len(title) >= 120:
            raise ValueError('TITLE_COPY_BUDGET')
        quote = page.paragraphs[0][:min(80, 160 - len(title))]
    else:
        remaining = 25 - len(title.split())
        if remaining < 3:
            raise ValueError('TITLE_COPY_BUDGET')
        quote = ' '.join(page.paragraphs[0].split()[:min(remaining, 15)])
    publisher = '国家体育总局' if urlsplit(url).hostname == 'www.sport.gov.cn' else '世界射箭联合会'
    paragraphs = ['原文短节选：“' + quote + '…”', '本篇为自动整理的赛事快讯。完整赛况、赛制及后续变化，请以原文为准。']
    # Independent, narrowly anchored facts; no inferred winners or scientific conclusions.
    teams = re.search(r'features (six|\d+) teams and a total of (\d+) archers', body)
    if teams:
        count = '6' if teams[1] == 'six' else teams[1]
        if 1 <= int(count) <= 100 and 1 <= int(teams[2]) <= 10000:
            paragraphs.insert(1, f'报道介绍的联赛共有{count}支队伍、{teams[2]}名射手。人数描述属于本届赛事，不能套用到其它比赛。')
    item = {'id': 'auto-' + hashlib.sha256(url.encode()).hexdigest()[:24], 'category': '赛事', 'title': title,
            'date': published.isoformat(), 'source': publisher, 'url': url,
            'summary': f'{publisher}于{published.isoformat()}发布赛事报道。阅读官方短节选与赛况信息。',
            'paragraphs': paragraphs, 'attribution': '弓行记自动快讯；保留原文标题与有界短节选，未作全文翻译或人工分析。'}
    proof = {'id': item['id'], 'url': url, 'date': published.isoformat(), 'sourceSHA256': hashlib.sha256(raw).hexdigest(),
             'bodySHA256': hashlib.sha256(body.encode()).hexdigest(), 'mode': 'automatic-brief',
             'imageLicense': 'unknown-not-published', 'humanApproved': False}
    return item, proof

def validate(bundle):
    expected = baseline()
    if bundle.get('schema') != expected['schema'] or bundle.get('details') != expected['details'] or bundle.get('detailBaseline') != expected['detailBaseline']:
        raise ValueError('MANUAL_APPROVAL_CHANGED')
    feed = bundle['feed']
    if feed.get('schema') != 1 or type(feed.get('revision')) is not int or feed['revision'] < 1 or not 5 <= len(feed['articles']) <= 100:
        raise ValueError('FEED_CONTRACT')
    day = date.fromisoformat(feed['reviewedAt'])
    ids, urls = set(), set()
    base_ids = {a['id'] for a in expected['feed']['articles']}
    proofs = bundle.get('provenance', [])
    hold = set(json.loads((ASSETS / 'hold-urls.json').read_text(encoding='utf-8')))
    if len({p['id'] for p in proofs}) != len(proofs):
        raise ValueError('PROOF_DUPLICATE')
    for a in feed['articles']:
        if a['id'] in ids or a['url'] in urls or date.fromisoformat(a['date']) > day:
            raise ValueError('DUPLICATE_OR_DATE')
        ids.add(a['id']); urls.add(a['url'])
        if not re.fullmatch('[a-z0-9-]{1,80}', a['id']) or a['category'] not in ('赛事', '训练', '研究') or not safe(a['title'], 160) or not safe(a['summary'], 600) or not safe(a['source'], 160) or not 1 <= len(a['paragraphs']) <= 12 or any(not safe(p, 1200) for p in a['paragraphs']):
            raise ValueError('ARTICLE_CONTRACT')
        if a['id'] not in base_ids and not official_url(a['url']):
            raise ValueError('SOURCE_URL')
        if a['id'] not in base_ids and (a['url'] in hold or a['category'] != '赛事' or not re.fullmatch('auto-[a-f0-9]{24}', a['id'])):
            raise ValueError('AUTO_POLICY_OR_HOLD')
        if a['id'] not in base_ids and not any(p['id'] == a['id'] and p['url'] == a['url'] and p['date'] == a['date'] and p['humanApproved'] is False and re.fullmatch('[a-f0-9]{64}', p['sourceSHA256']) for p in proofs):
            raise ValueError('SOURCE_PROOF')
    for a in expected['feed']['articles']:
        if a not in feed['articles']:
            raise ValueError('MANUAL_ARTICLE_CHANGED')
    if {p['id'] for p in proofs} != ids - base_ids:
        raise ValueError('SOURCE_PROOF_SET')
    if len(encode(bundle)) > MAX_BYTES:
        raise ValueError('PUBLICATION_TOO_LARGE')
    return bundle

def collect(current, fetch, today):
    validate(current)
    hold = set(json.loads((ASSETS / 'hold-urls.json').read_text(encoding='utf-8')))
    existing = {a['url'] for a in current['feed']['articles']}
    selected, seen, diagnostics = [], set(), {'listsOK': 0, 'sourceFailures': 0, 'skipped': 0, 'published': 0}
    for listing in (WA_LIST, SPORT_LIST):
        try:
            page = parse_page(fetch(listing)); diagnostics['listsOK'] += 1
            for href, title in page.links:
                url = urljoin(listing, href)
                if not official_url(url) or url in existing or url in hold or url in seen:
                    continue
                if listing == SPORT_LIST and not re.search('射箭|反曲弓|复合弓', title):
                    continue
                seen.add(url); selected.append(url)
        except Exception:
            diagnostics['sourceFailures'] += 1
    result = copy.deepcopy(current)
    for url in selected[:MAX_GETS - 2]:
        try:
            a, proof = article(fetch(url), url, today)
            candidate = copy.deepcopy(result)
            candidate['feed']['articles'].append(a); candidate['provenance'].append(proof)
            candidate['feed']['revision'] = current['feed']['revision'] + 1
            candidate['feed']['reviewedAt'] = today.isoformat()
            if len(candidate['feed']['articles']) > 100:
                oldest = min((item for item in candidate['feed']['articles'] if item['id'].startswith('auto-')), key=lambda item: (item['date'], item['id']))
                candidate['feed']['articles'].remove(oldest)
                candidate['provenance'] = [p for p in candidate['provenance'] if p['id'] != oldest['id']]
            validate(candidate); result = candidate; diagnostics['published'] += 1
        except Exception:
            diagnostics['skipped'] += 1
    if not diagnostics['published']:
        result = copy.deepcopy(current)
    else:
        result['feed']['articles'].sort(key=lambda a: (a['date'], a['id']), reverse=True)
    return validate(result), diagnostics
