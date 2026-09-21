"""ZimiExchange: every Stack Exchange site in the library, as one place.

Kiwix builds every Stack Exchange site with one scraper, sotoki, so one
reader serves them all. Each site ZIM holds a paged listing (``questions``,
``questions_page=N``), a listing per tag (``questions/tagged/<tag>``, paged
the same way), a ``tags`` page with counts, and a page per question with
its answers, scores and the accepted one marked. Nothing is re-indexed:
the listings are the site's own order (its most voted first), read on
demand and cached per page for the life of the process.

Eric, 2026-09-19: "ZimiExchange ... threading in real data and live
interface."
"""

import random
import html as _html
import logging
import posixpath
import re
import threading

from zimi import server as _srv

log = logging.getLogger("zimi")

_MAX_PAGE_BYTES = 8 * 1024 * 1024
_lock = threading.Lock()
_cache = {}  # (archive filename, path) -> parsed

_SUMMARY_SPLIT_RE = re.compile(r'<div class="question-summary"')
_ROW_RE = re.compile(
    r'<span class="vote-count-post"><strong>(?P<votes>-?\d+)</strong></span>.*?'
    r'<div class="status(?P<status>[^"]*)">\s*<strong>(?P<answers>\d+)</strong>.*?'
    r'<h3><a href="(?P<href>[^"]+)" class="question-hyperlink">(?P<title>.*?)</a></h3>\s*'
    r'(?:<div class="excerpt">(?P<excerpt>.*?)</div>)?(?P<rest>.*)',
    re.S,
)
_TAG_RE = re.compile(r'<a href="[^"]*questions/tagged/([^"]+)" class="post-tag[^"]*"[^>]*>', re.S)
_PAGES_RE = re.compile(r'_page=(\d+)')
_TAGS_PAGE_RE = re.compile(
    r'<a href="[^"]*questions/tagged/([^"]+)" class="post-tag"[^>]*>[^<]*</a>\s*</div>\s*</div>\s*'
    r'<div class="[^"]*v-truncate4">(.*?)</div>.*?<div class="grid--cell">(\d+) questions</div>',
    re.S,
)
_TITLE_RE = re.compile(r'<h1[^>]*itemprop="name"[^>]*>\s*<a[^>]*>(.*?)</a>', re.S)
_QVOTE_RE = re.compile(r'class="js-vote-count[^"]*"[^>]*data-value="(-?\d+)"', re.S)
_PROSE_RE = re.compile(r'<div class="s-prose js-post-body"[^>]*>(.*?)</div>\s*(?:<div class="mt24|<div class="post-taglist|</div>\s*<div class="postcell|<div class="grid mb0)', re.S)
_ANSWER_RE = re.compile(r'<div id="answer-(?P<id>\d+)" class="answer(?P<cls>[^"]*)"[^>]*data-score="(?P<score>-?\d+)"[^>]*>(?P<body>.*?)(?=<a name="\d+"></a>\s*<div id="answer-|<div id="answers-footer|</div>\s*<div class="grid mb0"|$)', re.S)
_AUTHOR_RE = re.compile(r'class="user-details"[^>]*>.*?itemprop="name">(.*?)</span>', re.S)
_ANSWER_PROSE_RE = re.compile(r'<div class="s-prose js-post-body"[^>]*>(.*?)</div>\s*<div class="mt24', re.S)
_SCRIPT_RE = re.compile(r'<script\b.*?</script>', re.S | re.I)
_URLATTR_RE = re.compile(r'\b(href|src)=(["\'])([^"\']*)\2', re.I)


def _read(archive, path):
    try:
        entry = archive.get_entry_by_path(path)
        if entry.is_redirect:
            entry = entry.get_redirect_entry()
        item = entry.get_item()
        if item.size > _MAX_PAGE_BYTES:
            return None
        return bytes(item.content).decode("utf-8", "replace")
    except Exception:
        return None


def _text(s):
    return _html.unescape(re.sub(r"<[^>]+>", "", s or "")).strip()


def _tags_in(fragment):
    return [_html.unescape(t) for t in _TAG_RE.findall(fragment or "")]


def rows_from_listing(text):
    """The question rows on a listing page: id, title, page, votes, answers,
    accepted, excerpt, tags. The site's own order."""
    out = []
    for block in _SUMMARY_SPLIT_RE.split(text or "")[1:]:
        m = _ROW_RE.search(block)
        if not m:
            continue
        href = _html.unescape(m.group("href")).lstrip("./")
        qid = href.split("/")[1] if href.startswith("questions/") and href.count("/") >= 1 else ""
        out.append(
            {
                "id": qid,
                "title": _text(m.group("title")),
                "page": href,
                "votes": int(m.group("votes")),
                "answers": int(m.group("answers")),
                "accepted": "accepted" in (m.group("status") or ""),
                "excerpt": _text(m.group("excerpt"))[:300],
                "tags": _tags_in(m.group("rest")),
            }
        )
    return out


def pages_in(text):
    """How many pages the listing says it has, from its own links."""
    nums = [int(n) for n in _PAGES_RE.findall(text or "")]
    return max(nums) if nums else 1


def tags_from_page(text, limit=40):
    """``[{tag, description, count}]`` from the site's tags page."""
    out = []
    for tag, desc, count in _TAGS_PAGE_RE.findall(text or ""):
        out.append({"tag": _html.unescape(tag), "description": _text(desc)[:200], "count": int(count)})
        if len(out) >= limit:
            break
    return out


def _rebase(fragment, page, zim):
    """A question's HTML, made to work in Zimi's own page: scripts dropped,
    relative links and images pointed at the ZIM through /w/. A link to
    another question stays inside ZimiExchange (data-q), the rest open the
    ZIM's page."""
    fragment = _SCRIPT_RE.sub("", fragment or "")
    base = posixpath.dirname(page)

    def fix(m):
        attr, quote, url = m.group(1), m.group(2), m.group(3)
        if not url or url.startswith(("#", "http://", "https://", "mailto:", "data:", "/w/")):
            return m.group(0)
        target = posixpath.normpath(posixpath.join(base, url)) if base else posixpath.normpath(url)
        target = target.lstrip("./")
        extra = ' data-q="%s"' % _html.escape(target, quote=True) if attr == "href" and target.startswith("questions/") and "/tagged/" not in target else ""
        return '%s=%s/w/%s/%s%s%s' % (attr, quote, _srv.url_quote(zim) if hasattr(_srv, "url_quote") else zim, target, quote, extra)

    return _URLATTR_RE.sub(fix, fragment)


def question_from_page(text, page, zim):
    """One question, owned: title, body, tags, votes, answers scored with the
    accepted one first."""
    if not text:
        return None
    m = _TITLE_RE.search(text)
    if not m:
        return None
    title = _text(m.group(1))
    votes = _QVOTE_RE.search(text)
    prose = _PROSE_RE.search(text)
    body = prose.group(1) if prose else ""
    head_end = text.find('<div id="answers">')
    head = text[: head_end if head_end > 0 else len(text)]
    tags = _tags_in(head[head.find('class="post-taglist'):] if 'class="post-taglist' in head else "")
    author = _AUTHOR_RE.search(head)
    answers = []
    for am in _ANSWER_RE.finditer(text):
        ab = _ANSWER_PROSE_RE.search(am.group("body"))
        aa = _AUTHOR_RE.search(am.group("body"))
        answers.append(
            {
                "id": am.group("id"),
                "score": int(am.group("score")),
                "accepted": "accepted-answer" in am.group("cls"),
                "author": _text(aa.group(1)) if aa else "",
                "body": _rebase(ab.group(1) if ab else "", page, zim),
            }
        )
    answers.sort(key=lambda a: (not a["accepted"], -a["score"]))
    return {
        "title": title,
        "votes": int(votes.group(1)) if votes else 0,
        "author": _text(author.group(1)) if author else "",
        "tags": tags,
        "body": _rebase(body, page, zim),
        "answers": answers,
        "page": page,
    }


def _archive(name):
    from zimi.search import _get_fts_archive

    entry = next((z for z in (_srv._zim_list_cache or []) if z.get("name") == name), None)
    if not entry or entry.get("kind") != "qa" or not _srv.zim_allowed(name):
        return None, None
    try:
        archive, lock = _get_fts_archive(name)
    except Exception:
        return None, None
    return (archive, lock) if archive is not None and lock is not None else (None, None)


def _cached_page(name, path, parse):
    archive, lock = _archive(name)
    if archive is None:
        return None
    key = (getattr(archive, "filename", None) or name, path)
    with _lock:
        if key in _cache:
            return _cache[key]
    with lock:
        text = _read(archive, path)
    value = parse(text) if text is not None else None
    with _lock:
        _cache[key] = value
    return value


def sites():
    """The installed Stack Exchange sites, with their icons."""
    out = []
    for z in _srv._zim_list_cache or []:
        if z.get("kind") == "qa" and z.get("name") and _srv.zim_allowed(z["name"]):
            out.append({"name": z["name"], "title": z.get("title") or z["name"], "icon": bool(z.get("has_icon")), "description": z.get("description") or "",
                        "date": z.get("date") or "", "size_bytes": z.get("size_bytes") or 0})
    out.sort(key=lambda s: s["title"].lower())
    # A site once: a nopic beside a maxi, or last month's file beside this
    # month's, is one site, and the newest build is the one read.
    return _srv.newest_per(out, lambda s: s["title"].strip().lower())


def listing(name, page=1, tag=""):
    """One page of a site's questions, or of a tag's: the site's own order."""
    base = "questions/tagged/" + tag if tag else "questions"
    path = base if page <= 1 else "%s_page=%d" % (base, page)
    got = _cached_page(name, path, lambda t: {"rows": rows_from_listing(t), "pages": pages_in(t)})
    return got or {"rows": [], "pages": 0}


def tags(name):
    return _cached_page(name, "tags", tags_from_page) or []


def question(name, page):
    got = _cached_page(name, page, lambda t: question_from_page(t, page, name))
    return got


def random_question(rng=None):
    """Somewhere in the library's Q&A, for the dice: a site by chance, a
    page of its most-voted list by chance, a question on it by chance. None
    when no site is installed or nothing readable turns up."""
    rng = rng or random
    ss = sites()
    if not ss:
        return None
    for _ in range(4):
        s = rng.choice(ss)
        first = listing(s["name"], 1)
        pages = max(1, int(first.get("pages") or 1))
        pg = rng.randint(1, pages)
        # A page count the listing promises but the ZIM lacks falls back
        # to the first page rather than to nothing.
        rows = (first["rows"] if pg == 1 else listing(s["name"], pg)["rows"]) or first["rows"]
        rows = [r for r in rows if r.get("page")]
        if rows:
            r = rng.choice(rows)
            return {"zim": s["name"], "page": r["page"], "title": r.get("title") or ""}
    return None


def home():
    """Every site with its first page and its top tags: the shelves."""
    out = []
    for s in sites():
        first = listing(s["name"], 1)
        out.append(dict(s, rows=first["rows"][:12], pages=first["pages"], tags=tags(s["name"])[:12]))
    return {"sites": out}


def _reset_for_tests():
    with _lock:
        _cache.clear()
