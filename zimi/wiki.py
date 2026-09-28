"""Zimipedia: every wiki in the library, as one.

Kiwix builds Wikipedia, its sister projects (Wiktionary, Wikivoyage,
Wikiquote, Wikibooks, Wikiversity, Wikinews, Wikisource, Wikispecies) and
the MediaWiki wikis beyond Wikimedia with one scraper, mwoffliner, so what
a ZIM is was already decided when the library was read (its ``kind`` is
``wiki``, its ``project`` read from its metadata Name). Nothing here opens
an archive to find the wikis: the list is a view of the library cache.

Today is one language at a time, a front door: the day's article from that
language's Wikipedia, with its picture (the page adds where you were and
the trails you took, which the browser keeps). Each wiki's pick is chosen by
the day, so it holds until midnight, and worked out once per wiki per day
and kept here, by a background pass soon after the server starts and after
each of its midnights, so the first page open of a day finds it ready. A
browser on another day (its time zone is not the server's) starts that
day's pass with its first ask.

The API (/wiki/today) answers the picks of the wikis a page names.

Zimipedia's reader asks about one article at a time (article(), below).

Only today, yesterday and tomorrow (the server's, covering every time zone
a browser may be in) can be asked for: a caller cannot make the server
work out a year of picks.

Eric, 2026-09-24: "a wiki app that like has pills for all the individual
wikis but builds a unified one and has the today page suggesting articles
or whatever and good scoped search and display views and whatnot."
Eric, 2026-09-25: "let's make that main view in Zimipedia awesome, dipping
into most/all included ZIMs" and "All features should be first-class in all
languages." Later that day: "I don't want all the languages together I want
it to support all languages well, separately. Doesn't real wiki have more
than that on their homepage? Make it really alive and interesting."
"""

import datetime
import hashlib
import logging
import random
import re
import threading
from urllib.parse import unquote

from zimi import server as _srv

log = logging.getLogger("zimi")

_lock = threading.Lock()
# (name, build date, day) -> the day's pick ({} when the wiki had nothing to
# give). A failure is never kept.
_pick_cache = {}
_inflight = {}  # key -> threading.Event, so two asks for one key read once
_warming = set()  # days a background pass is running for
# Every wiki a library could hold, three days over: small, and cleared whole
# rather than aged.
_CACHE_MAX = 512
# Random pages read to find a wiki's pick of the day: enough to find one
# with a picture in most wikis, few enough that a wiki made without
# pictures (a nopic build) settles quickly.
PICK_TRIES = 10
# How long an ask waits on the same key being worked out by someone else.
_INFLIGHT_WAIT = 30

# How a project is named on its pill. Wikimedia's own names, which are
# names, so the same in every language of the interface.
PROJECT_TITLES = {p: p.capitalize() for p in _srv.WIKI_PROJECTS}

# What each project gives Today. A wiki beyond Wikimedia gives an article.
ROLES = {
    "wikipedia": "article",
    "wiktionary": "word",
    "wikiquote": "quote",
    "wikivoyage": "place",
    "wikibooks": "book",
    "wikisource": "text",
    "wikiversity": "course",
    "wikinews": "news",
    "wikispecies": "species",
}
# A book, a text or a course is its front page, not chapter nine: a pick
# that lands on "Book/Chapter" is taken to "Book".
_WHOLE_WORKS = ("book", "text", "course")
# The roles that read as words, not pictures.
_TEXT_ROLES = ("word", "quote")

_LEAD_MIN = 40
_LEAD_CAP = 320
_QUOTE_MIN, _QUOTE_MAX = 25, 320
_DEF_CAP = 240


def project_of(name):
    """Which Wikimedia project a name belongs to (``wikipedia_fr_all`` is
    Wikipedia), or "" for a wiki beyond them. See server._wiki_project for
    the one the library keeps, read from the ZIM's metadata Name."""
    return _srv._wiki_project(name)


def _order(w):
    p = w["project"]
    rank = (
        _srv.WIKI_PROJECTS.index(p)
        if p in _srv.WIKI_PROJECTS
        else len(_srv.WIKI_PROJECTS)
    )
    return (rank, w["language"], w["title"].lower())


def _record(name):
    return next((z for z in _srv._zim_list_cache or [] if z.get("name") == name), {})


def _project(z):
    # The library keeps the project read from the ZIM's Name; a record from
    # a library read before it did falls back to the filename.
    return z["project"] if "project" in z else project_of(z.get("name"))


def _language(z):
    code = (z.get("language") or "").split(",")[0]
    return _srv._ISO639_3_TO_1.get(code, code)


def wikis():
    """The installed wikis this request may read: one per ZIM, grouped by
    project (Wikipedia first, the wikis beyond Wikimedia last), then by
    language, then by title. The library already keeps one file per name
    (a nopic beside a maxi of one wiki is one name, the richer kept), so
    every entry here is a wiki of its own."""
    out = []
    for z in _srv._zim_list_cache or []:
        name = z.get("name")
        if not name or z.get("kind") != "wiki" or not _srv.zim_allowed(name):
            continue
        project = _project(z)
        out.append(
            {
                "name": name,
                "title": z.get("title") or name,
                "project": project,
                "project_title": PROJECT_TITLES.get(project, ""),
                "role": ROLES.get(project, "article"),
                "language": _language(z),
                "icon": bool(z.get("has_icon")),
                "main_path": z.get("main_path") or "",
                "entries": z.get("entries") or 0,
                "description": z.get("description") or "",
                "date": z.get("date") or "",
                "flavour": _flavour(z),
            }
        )
    out.sort(key=_order)
    return out


def is_wiki(name):
    return any(w["name"] == name for w in wikis())


# ── the days that can be asked for ─────────────────────────────────────────


def _today():
    return datetime.date.today()


def open_days():
    """Yesterday, today and tomorrow on the server's clock, YYYYMMDD: the
    days any browser in any time zone can be on."""
    t = _today()
    return {(t + datetime.timedelta(days=k)).strftime("%Y%m%d") for k in (-1, 0, 1)}


def day_open(day):
    return isinstance(day, str) and day in open_days()


# ── kept once per key ──────────────────────────────────────────────────────


def _kept(cache, key, work):
    """``cache[key]``, working it out with ``work()`` when it is not there.
    One worker per key; the others wait for its answer. A failure (``work``
    raises) is logged, returned as None, and not kept, so the next ask
    tries again."""
    with _lock:
        if key in cache:
            return cache[key]
        ev = _inflight.get(key)
        owner = ev is None
        if owner:
            ev = _inflight[key] = threading.Event()
    if not owner:
        ev.wait(_INFLIGHT_WAIT)
        with _lock:
            return cache.get(key)
    got = None
    try:
        got = work()
    except Exception as e:
        log.warning("Zimipedia could not read %s: %s", key, e)
        got = None
    finally:
        with _lock:
            _inflight.pop(key, None)
            if got is not None:
                if len(cache) >= _CACHE_MAX:
                    cache.clear()
                cache[key] = got
        ev.set()
    return got


def _peek(cache, key):
    with _lock:
        return cache.get(key)


def _key(name, when):
    return (name, str(_record(name).get("date") or ""), when)


# ── reading one page ───────────────────────────────────────────────────────


def _archive(name):
    with _srv._zim_lock:
        archive = _srv.get_archive(name)
    if archive is None:
        raise LookupError("not open")
    return archive


def _read_page(archive, path):
    """``(path, title, html)`` of an article, its redirect followed, or None
    when the path is not an HTML page. Must be called with _zim_lock held."""
    try:
        entry = archive.get_entry_by_path(path)
    except KeyError:
        return None
    if entry.is_redirect:
        entry = entry.get_redirect_entry()
    item = entry.get_item()
    if not (item.mimetype or "").startswith("text/html"):
        return None
    return entry.path, entry.title or "", bytes(item.content).decode("utf-8", "replace")


def _body(html):
    """The article itself, without the page's chrome or its boxes (an
    infobox, a notice that the book is unfinished): tables go, innermost
    first, so a paragraph inside one is never taken for the lead."""
    m = re.search(r'<div[^>]*id=["\']mw-content-text["\']', html)
    body = html[m.start() :] if m else html
    for _ in range(8):
        body, n = _TABLE_RE.subn(" ", body)
        if not n:
            break
    return body


_TABLE_RE = re.compile(
    r"<table\b[^>]*>(?:(?!<table\b).)*?</table>", re.DOTALL | re.IGNORECASE
)


def _drop_blocks(fragment):
    """A list item's own words: no nested lists (examples, sub-points), no
    small print, no footnote marks, no hidden parts."""
    for tag in ("ul", "ol", "dl", "table", "sup", "style", "script"):
        fragment = re.sub(
            r"<%s\b[^>]*>.*?</%s>" % (tag, tag),
            " ",
            fragment,
            flags=re.DOTALL | re.IGNORECASE,
        )
    return fragment


def _clean(text):
    text = re.sub(r"\[\s*[^\]\s][^\]]{0,14}\]", "", text)  # [1], [ note 1 ]
    text = re.sub(r"\s+([,.;:!?،。、])", r"\1", text)
    return re.sub(r"\s{2,}", " ", text).strip()


def _cap(text, n):
    return text if len(text) <= n else text[:n].rsplit(" ", 1)[0] + "…"


def _lead(html):
    """The article's first real paragraph."""
    from zimi.previews import inline_text

    for m in re.finditer(
        r"<p\b[^>]*>(.*?)</p>", _body(html), re.DOTALL | re.IGNORECASE
    ):
        text = _clean(inline_text(_drop_blocks(m.group(1))))
        if len(text) >= _LEAD_MIN:
            return _cap(text, _LEAD_CAP)
    return ""


def _definition(html):
    """A dictionary page's first sense, in whatever language the dictionary
    is written: the first numbered line (every Wiktionary numbers its senses)
    without its examples or register labels."""
    from zimi.previews import inline_text

    for m in re.finditer(
        r"<ol\b[^>]*>\s*<li\b[^>]*>(.*?)</li>", _body(html), re.DOTALL | re.IGNORECASE
    ):
        frag = re.sub(
            r"<small\b[^>]*>.*?</small>",
            " ",
            m.group(1),
            flags=re.DOTALL | re.IGNORECASE,
        )
        text = _clean(inline_text(_drop_blocks(frag)))
        # The sense, not the example quoted after it.
        text = re.split(r"(?<=[.!?:])\s+[”“„\"«]", text)[0]
        if len(text) > 3:
            return _cap(text, _DEF_CAP)
    return ""


_QUOTE_MARKS = "\"'“”„‟«»‹›「」『』״"


def _quote(html, title):
    """A quote page's first quote and who said it, in any language: the
    first top-level list line of quote length, with an attribution from a
    "~ Author" tail or the line nested under it. ``(text, by)``."""
    from zimi.previews import inline_text

    body = _body(html)
    # Stop before the page's closing lists (see also, references, links).
    heads = [m.start() for m in re.finditer(r"<h2\b", body)]
    if len(heads) > 2:
        body = body[: heads[-2]]
    for m in re.finditer(r"<li\b[^>]*>(.*?)</li>", body, re.DOTALL | re.IGNORECASE):
        raw = m.group(1)
        own = raw.split("<ul", 1)[0].split("<dl", 1)[0]
        # A line that opens with a link names a page (a list of people, of
        # works); a quote opens with its own words.
        if re.match(r"\s*(?:<[^a/][^>]*>\s*)*<a\b", own):
            continue
        text = _clean(inline_text(_drop_blocks(own)))
        by = ""
        tail = re.search(r"\s*[~～]\s*([^~～]{2,80})$", text)
        if tail:
            text, by = text[: tail.start()].strip(), tail.group(1).strip()
        text = text.strip(_QUOTE_MARKS + " ").strip()
        if not (_QUOTE_MIN <= len(text) <= _QUOTE_MAX) or len(text.split()) < 4:
            continue
        # "Name - (1 November 1935 - 2003)", "A Title (novel)": a list of
        # people or of works, not a quote.
        if text.endswith(")"):
            continue
        # A line that is only links is a list of pages, not a quote.
        linked = sum(
            len(inline_text(a))
            for a in re.findall(r"<a\b[^>]*>(.*?)</a>", own, re.DOTALL)
        )
        if linked > 0.6 * len(text):
            continue
        if not by:
            nested = re.search(
                r"<(?:ul|dl)\b[^>]*>\s*<(?:li|dd)\b[^>]*>(.*?)</(?:li|dd)>",
                raw,
                re.DOTALL,
            )
            if nested:
                cand = _clean(inline_text(_drop_blocks(nested.group(1))))
                if 2 < len(cand) <= 80:
                    by = cand
        return text, by
    return "", ""


# Simple English Wiktionary's forms of another word ("The plural form of
# script"), which English Wiktionary's own check does not catch.
_INFLECTION_RE = re.compile(
    r"^(?:\(.*?\)\s*)*(?:the |an? )?(?:plural|past tense|past participle|present participle|third-person|"
    r"comparative|superlative|simple past|alternative)\b",
    re.IGNORECASE,
)


def _english_word(html, zim_name):
    """English Wiktionary's own reading (the English section, its part of
    speech, a sense that is not just "plural of"), or None when the page is
    not an English word worth showing."""
    from zimi.previews import _extract_preview_wiktionary

    got = {}
    _extract_preview_wiktionary(html, zim_name, got)
    if got.get("non_english") or got.get("boring") or not got.get("blurb"):
        return None
    if _INFLECTION_RE.match(got["blurb"]):
        return None
    return got["blurb"], got.get("part_of_speech") or ""


def _judge(role, name, lang, path, title, html):
    """What one page offers as this wiki's pick, and whether it is good
    enough to stop looking: ``(pick or None, good)``."""
    from zimi.previews import _extract_preview_wikiquote

    base = {"zim": name, "role": role, "path": path, "title": title, "lang": lang}
    if role == "word":
        # A word, not an abbreviation, a number or a phrase.
        if (
            len(title) > 30
            or title.count(" ") > 2
            or not re.fullmatch(r"[^\W\d_][\w\s\-־'’]*", title)
        ):
            return None, False
        if lang == "en":
            got = _english_word(html, name)
            if not got:
                return None, False
            return dict(base, blurb=_cap(got[0], _DEF_CAP), kick=got[1]), True
        text = _definition(html)
        return (dict(base, blurb=text), True) if text else (None, False)
    if role == "quote":
        text, by = "", ""
        if lang == "en":
            got = {"title": title}
            _extract_preview_wikiquote(html, got, title)
            text = (got.get("blurb") or "").strip(_QUOTE_MARKS + " ")
            by = got.get("attribution") or ""
        if not text:
            text, by = _quote(html, title)
        if not text:
            return None, False
        return dict(base, blurb=text, kick=by if by and by != title else ""), True
    lead = _lead(html)
    if not lead:
        return None, False
    return dict(base, blurb=lead), False  # good once it has a picture


def _work_pick(name, day):
    """One wiki's pick for a day: random pages in an order seeded by the
    wiki and the day, the first that suits the wiki's role (with a picture,
    where the role has one). Reads under the library lock one page at a
    time, never across the search."""
    from zimi.previews import _extract_preview_thumbnail
    from zimi.search import _meta_title_re, random_entry

    z = _record(name)
    project, lang = _project(z), _language(z)
    role = ROLES.get(project, "article")
    main = z.get("main_path") or ""
    archive = _archive(name)
    seed = int(hashlib.md5(("%s|%s" % (name, day)).encode()).hexdigest()[:12], 16)
    rng = random.Random(seed)
    fallback, seen = None, set()
    for _ in range(PICK_TRIES):
        with _srv._zim_lock:
            got = random_entry(archive, max_attempts=4, rng=rng)
        if not got:
            continue
        path = got["path"]
        if role in _WHOLE_WORKS and "/" in path:
            path = path.split("/", 1)[0]
        # A namespace page (Wikipedia:, ויקיפדיה:, Portal:) or the front page
        # is not anybody's pick.
        if (
            path in seen
            or path == main
            or ":" in path
            or _meta_title_re.search(got.get("title") or "")
        ):
            continue
        seen.add(path)
        with _srv._zim_lock:
            page = _read_page(archive, path)
        if not page:
            continue
        path, title, html = page
        pick, good = _judge(role, name, lang, path, title.replace("_", " "), html)
        if not pick:
            continue
        if role not in _TEXT_ROLES:
            with _srv._zim_lock:
                thumb = _extract_preview_thumbnail(html[:80000], archive, name, path)
            if thumb:
                pick["thumbnail"] = thumb
                good = True
        if good:
            return pick
        fallback = fallback or pick
    return fallback or {}


def pick(name, day):
    """A wiki's pick for the day YYYYMMDD: ``{zim, role, path, title, lang,
    blurb, thumbnail?, kick?}``, {} when it has nothing to offer, None when
    it could not be read (not kept, so asked again next time)."""
    return _kept(_pick_cache, _key(name, day), lambda: _work_pick(name, day))


# ── the page's first ask ───────────────────────────────────────────────────


def _warm(day, names):
    """Work out every wiki's pick of the day, in the background, so the ones a
    page has not asked for yet are ready."""
    try:
        for name in names:
            pick(name, day)
    finally:
        with _lock:
            _warming.discard(day)


def _start_warm(day, names):
    """A background pass for a day, unless one is already running."""
    with _lock:
        if day in _warming:
            return False
        _warming.add(day)
    threading.Thread(
        target=_warm, args=(day, list(names)), name="zimipedia-today", daemon=True
    ).start()
    return True


# How long after the server starts, and after its midnight, the day is
# worked out: after the boot's own reads have settled.
WARM_DELAY = 30


def _seconds_to_midnight():
    now = datetime.datetime.now()
    nxt = datetime.datetime.combine(
        now.date() + datetime.timedelta(days=1), datetime.time()
    )
    return (nxt - now).total_seconds()


def warm_daily():
    """Work out Today for every wiki soon after the server starts and again
    soon after each of its midnights, so the first page open of a day finds
    it ready instead of reading every wiki while someone waits. Runs for
    the server, not for any one account: what a request may see is still
    decided when it asks."""
    import time

    time.sleep(WARM_DELAY)
    while True:
        try:
            if "wiki" in _srv.apps_shown():
                names = [
                    z["name"]
                    for z in _srv._zim_list_cache or []
                    if z.get("kind") == "wiki"
                ]
                if names:
                    _start_warm(_today().strftime("%Y%m%d"), names)
        except Exception as e:
            log.warning("Zimipedia could not start the day's pass: %s", e)
        time.sleep(_seconds_to_midnight() + WARM_DELAY)


def languages(ws):
    """The languages the wikis are in, most wikis first: ``[{code, wikis}]``."""
    n = {}
    for w in ws:
        n[w["language"]] = n.get(w["language"], 0) + 1
    return [
        {"code": c, "wikis": k}
        for c, k in sorted(n.items(), key=lambda x: (-x[1], x[0]))
    ]


def choose_language(ws, wanted):
    """The language Today shows: the one asked for (a browser's choice, or
    its interface's language) when a wiki is in it, else English, else the
    language with the most wikis; "" when there is no wiki."""
    have = {w["language"] for w in ws}
    wanted = (wanted or "").strip()
    for c in (wanted, wanted.split("-")[0].lower(), "en"):
        if c and c in have:
            return c
    langs = languages(ws)
    return langs[0]["code"] if langs else ""


def home(day=None, lang=None):
    """The wikis this request may read and the languages they are in; the
    language Today shows (``lang``, see choose_language); and for a day that
    can be asked for, the picks already known of that language's wikis
    (``picks``: {name: pick}): kept answers only, never a read. The first
    ask of a day starts the background pass that works out the picks still
    missing, the language shown first."""
    ws = wikis()
    chosen = choose_language(ws, lang)
    out = {"wikis": ws, "languages": languages(ws), "lang": chosen}
    if not day_open(day):
        return out
    picks, missing = {}, []
    for w in ws:
        if w["language"] != chosen:
            continue
        got = _peek(_pick_cache, _key(w["name"], day))
        if got is None:
            missing.append(w["name"])
        else:
            picks[w["name"]] = got
    out.update(day=day, picks=picks)
    if missing:
        rest = [w["name"] for w in ws if w["language"] != chosen]
        _start_warm(day, dict.fromkeys(missing + rest))
    return out


# The most wikis one /wiki/today ask may name: the page asks in small
# batches so each answer lands on its own, and no one ask holds a request
# thread for the whole library.
TODAY_BATCH_MAX = 8


def today(day, names):
    """The day's pick of each wiki named that this request may read, worked
    out now where it is not known yet: ``{picks: {name: pick}, failed:
    [name]}``. A wiki not readable here is left out; one whose pick failed
    to read is named in ``failed`` and asked again next time."""
    mine = {w["name"] for w in wikis()}
    out = {"picks": {}, "failed": []}
    for name in dict.fromkeys(names):
        if name not in mine:
            continue
        got = pick(name, day)
        if got is None:
            out["failed"].append(name)
        else:
            out["picks"][name] = got
    return out


# ── one article: what Zimipedia's reader shows beside it ──────────────────
#
# Asked once an article is on screen, never before: the languages it is in
# (by its Wikidata Q-ID), Simple English as a reading level, the fuller
# build of a mini, and what the other wikis of its language hold on the same
# topic. The shell asks this in place of /article-languages for a wiki's
# article, so opening one costs no more requests than before.

# The sister projects the topic strip looks in, in the order it shows them.
TOPIC_PROJECTS = ("wiktionary", "wikivoyage", "wikiquote", "wikibooks", "wikisource")
# A Simple English wiki is named so by Kiwix (wikipedia_en_simple_all).
_SIMPLE_RE = re.compile(r"(?:^|_)simple(?:_|$)")
# A sister link in an article (the "Wikiquote has quotations related to" box,
# a Wikisource author page): its project and the page it names.
_SISTER_RE = re.compile(
    r'href="https?://[a-z-]+\.(%s)\.org/wiki/([^"#?]+)"' % "|".join(TOPIC_PROJECTS)
)


def _flavour(z):
    """A build's flavour, from its file name (Kiwix's _maxi, _nopic, _mini)."""
    m = _srv._FLAVOR_TOKEN_RE.search((z.get("file") or "").lower())
    return m.group(1) if m else ""


def is_simple(name):
    return bool(_SIMPLE_RE.search(name or ""))


def _norm_title(t):
    """A page name as a title compares: spaces and underscores alike, the
    first letter in either case (MediaWiki capitalises it)."""
    t = unquote(t or "").replace(" ", "_").strip("_")
    return t[:1].lower() + t[1:]


def _html_page(archive, path):
    """The HTML page a path names, its redirect followed: ``(path, title)``,
    or None. Reads no content. Call with the library lock held."""
    try:
        entry = archive.get_entry_by_path(path)
        if entry.is_redirect:
            entry = entry.get_redirect_entry()
        if not (entry.get_item().mimetype or "").startswith("text/html"):
            return None
    except Exception:
        return None
    return entry.path, (entry.title or entry.path).replace("_", " ")


def _page_qid(name, archive, path):
    """A page's Q-ID from the index or cache, else read from its HTML (and
    cached); None when it carries none. Call with the library lock held."""
    from zimi import interlang as il

    qid = il._qid_lookup(name, path)
    if qid is None:
        qid = il._qid_extract_from_html(archive, path)
        if qid is not None:
            il._qid_cache_store(name, path, qid)
    return qid


def _twin(w, paths, qid):
    """The same article in the wiki ``w``: by its Q-ID where that wiki's index
    or cache knows it, else the first of ``paths`` it holds, taken only when
    the page there does not carry a different Q-ID. ``{zim, path, title}``
    or None. Takes the library lock per read."""
    from zimi import interlang as il

    name = w["name"]
    try:
        archive = _archive(name)
    except LookupError:
        return None
    if qid is not None:
        hit = il._qid_find_in_zim(name, qid)
        if hit:
            with _srv._zim_lock:
                got = _html_page(archive, hit)
            if got:
                return {"zim": name, "path": got[0], "title": got[1]}
    for cand in dict.fromkeys(paths):
        with _srv._zim_lock:
            got = _html_page(archive, cand)
            if not got:
                continue
            # Words are not Wikidata items: a dictionary page is taken by name.
            other = (
                None
                if w["project"] == "wiktionary" or qid is None
                else _page_qid(name, archive, got[0])
            )
        if other is not None and other != qid:
            continue
        return {"zim": name, "path": got[0], "title": got[1]}
    return None


def _by_richness(ws):
    """Wikis, the fullest build first (the library's own ranking of builds,
    server._FLAVOR_RANKS: maxi, an untagged build, nopic, mini), then the
    biggest."""
    return sorted(
        ws,
        key=lambda w: (-_srv._FLAVOR_RANKS[w["flavour"] or None], -(w["entries"] or 0)),
    )


def _borrowed_qid(same, path, simple):
    """The Q-ID of this page in a fuller build of its wiki, for a copy that
    does not carry one (an older English mini): the page at the same path
    there, itself and not a redirect (which may land on another topic), and
    at the same reading level (Simple English's page of a name may be another
    article than English's). None when no build has it. Takes the library
    lock per read."""
    for w in _by_richness(
        [w for w in same if w["flavour"] != "mini" and is_simple(w["name"]) == simple]
    ):
        try:
            other = _archive(w["name"])
        except LookupError:
            continue
        with _srv._zim_lock:
            got = _html_page(other, path)
            q = _page_qid(w["name"], other, path) if got and got[0] == path else None
        if q is not None:
            return q
    return None


def article(zim, path, languages_only=False):
    """What the reader shows beside a wiki's article, for this request:
    ``{qid, flavour, languages, level, full, topic}``; with
    ``languages_only`` (the shell's ask for its language menu, on any wiki's
    article) ``{qid, flavour, languages}``, without reading the article.

    - ``qid``: its Wikidata Q-ID ("Q937"), "" when unknown. A copy that
      does not carry it (an older English mini) borrows it from a fuller
      build of the same wiki holding the same page (see _borrowed_qid), for
      this answer only: it is never kept as this copy's own.
    - ``languages``: the installed languages that have it ([{lang, name,
      zim, path}], verified by Q-ID: see interlang.get_article_languages).
    - ``level``: Simple English as a reading level: from an English article,
      the Simple one; from a Simple one, the full English. ``{zim, path,
      title, simple}`` or None.
    - ``full``: for a mini, the same article in a fuller build of its
      language, or None.
    - ``topic``: what the other wikis of its language hold on it: the
      Wiktionary entry, the Wikivoyage guide, Wikiquote, Wikibooks,
      Wikisource ([{project, zim, path, title}]), by the article's own sister
      links and its name, checked by Q-ID where both pages carry one.

    None when the ZIM is not a wiki this request may read, or the page is
    not in it."""
    from zimi import interlang as il
    from zimi.search import unglue_zim_path

    ws = wikis()
    me = next((w for w in ws if w["name"] == zim), None)
    if me is None:
        return None
    try:
        archive = _archive(zim)
    except LookupError:
        return None
    path = _srv.split_entry_fragment(path)[0]
    with _srv._zim_lock:
        path = unglue_zim_path(archive, zim, path)
        page = _html_page(archive, path)
        if not page:
            return None
        path = page[0]
        qid = _page_qid(zim, archive, path)
    lang, project, simple = me["language"], me["project"], is_simple(zim)
    same = [
        w
        for w in ws
        if w["name"] != zim and w["language"] == lang and w["project"] == project
    ]
    if qid is None and project == "wikipedia":
        qid = _borrowed_qid(same, path, simple)
    with _srv._zim_lock:
        languages = il.get_article_languages(zim, path, qid=qid).get("languages", [])
    # A language is its full encyclopedia: Simple English is a reading level
    # (below), not the English a Hebrew reader is sent to.
    for i, lg in enumerate(languages):
        if not is_simple(lg["zim"]):
            continue
        full = [w for w in ws if w["language"] == lg["lang"] and w["project"] == project and not is_simple(w["name"])]
        for w in _by_richness(full):
            got = _twin(w, [lg["path"]], qid)
            if got:
                languages[i] = dict(lg, zim=got["zim"], path=got["path"])
                break
    out = {
        "qid": "Q%d" % qid if qid is not None else "",
        "flavour": me["flavour"],
        "languages": languages,
    }
    if languages_only:
        return out
    level = None
    if project == "wikipedia":
        # Up from Simple English goes to the full article, never to a mini's
        # introduction: that is less to read than the Simple article, not more.
        cands = [
            w
            for w in same
            if is_simple(w["name"]) != simple and (not simple or w["flavour"] != "mini")
        ]
        for w in _by_richness(cands):
            got = _twin(w, [path], qid)
            if got:
                level = dict(got, simple=not simple)
                break
    full = None
    if me["flavour"] == "mini":
        for w in _by_richness(
            [
                w
                for w in same
                if w["flavour"] != "mini" and is_simple(w["name"]) == simple
            ]
        ):
            got = _twin(w, [path], qid)
            if got:
                full = got
                break
    with _srv._zim_lock:
        try:
            html = bytes(archive.get_entry_by_path(path).get_item().content).decode(
                "utf-8", "replace"
            )
        except Exception:
            html = ""
    title = _norm_title(path)
    sister = {}
    for proj, target in _SISTER_RE.findall(html):
        # Its own sister links, not a word linked in the text: a link whose
        # page is this article's name ("Author:Albert Einstein" included).
        if _norm_title(target.rsplit(":", 1)[-1]) == title:
            sister.setdefault(proj, [])
            if target not in sister[proj]:
                sister[proj].append(target.replace(" ", "_"))
    topic = []
    for proj in TOPIC_PROJECTS:
        cands = [w for w in ws if w["project"] == proj and w["language"] == lang]
        # A Simple English article's words are in Simple English Wiktionary first.
        cands.sort(key=lambda w: (is_simple(w["name"]) != simple, -(w["entries"] or 0)))
        paths = [unquote(t) for t in sister.get(proj, [])] + [path]
        if proj == "wiktionary":
            # A dictionary files a word in lower case: "water", not "Water".
            paths.insert(0, path[:1].lower() + path[1:])
        for w in cands:
            got = _twin(w, paths, qid)
            if got:
                topic.append(dict(got, project=proj))
                break
    return dict(out, level=level, full=full, topic=topic)


def _reset_for_tests():
    with _lock:
        _pick_cache.clear()
        _inflight.clear()
        _warming.clear()
