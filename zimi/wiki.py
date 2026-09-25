"""Zimipedia: every wiki in the library, as one.

Kiwix builds Wikipedia, its sister projects (Wiktionary, Wikivoyage,
Wikiquote, Wikibooks, Wikiversity, Wikinews, Wikisource, Wikispecies) and
the MediaWiki wikis beyond Wikimedia with one scraper, mwoffliner, so what
a ZIM is was already decided when the library was read (its ``kind`` is
``wiki``, its ``project`` read from its metadata Name). Nothing here opens
an archive to find the wikis: the list is a view of the library cache.

Today is made of one thing from each wiki, the kind of thing that wiki is
for (an article with its picture, a word with its meaning, a quote, a
place, a book, a species), in the wiki's own language, chosen by the day so
it holds until midnight; and On this day, read from every Wikipedia's own
date page in its own language (zimi.datepages knows what each calls it).
Both are worked out once per wiki per day and kept here, by a background
pass soon after the server starts and after each of its midnights, so the
first page open of a day finds them ready. A browser on another day (its
time zone is not the server's) starts that day's pass with its first ask,
and asks for the rest a few wikis at a time.

Only today, yesterday and tomorrow (the server's, covering every time zone
a browser may be in) can be asked for: a caller cannot make the server read
date pages for the whole year.

Eric, 2026-09-24: "a wiki app that like has pills for all the individual
wikis but builds a unified one and has the today page suggesting articles
or whatever and good scoped search and display views and whatnot."
Eric, 2026-09-25: "let's make that main view in Zimipedia awesome, dipping
into most/all included ZIMs" and "All features should be first-class in all
languages."
"""

import datetime
import hashlib
import logging
import random
import re
import threading

from zimi import datepages
from zimi import server as _srv

log = logging.getLogger("zimi")

_lock = threading.Lock()
# (name, build date, day) -> the day's pick ({} when the wiki had nothing to
# give) and (name, build date, mmdd) -> [event]. A failure is never kept.
_pick_cache = {}
_otd_cache = {}
_inflight = {}  # key -> threading.Event, so two asks for one key read once
_warming = set()  # days a background pass is running for
# Every wiki a library could hold, three days over: small, and cleared whole
# rather than aged.
_CACHE_MAX = 512
OTD_LIMIT = 8
# Lines of a date page tried for an article the ZIM holds: a subset holds
# few of them, and each try is a lookup.
OTD_TRIES = 40
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


def mmdd_open(mmdd):
    return datepages.valid_mmdd(mmdd) is not None and any(
        d[4:] == mmdd for d in open_days()
    )


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


def _work_otd(name, mmdd):
    from zimi.search import _otd_event_entry

    lang = _language(_record(name))
    archive = _archive(name)
    with _srv._zim_lock:
        page = datepages.read_page(archive, mmdd, lang or "en")
    if not page:
        return []
    out, seen = [], set()
    for ev in datepages.extract_events(page, lang or "en")[:OTD_TRIES]:
        with _srv._zim_lock:
            hit = _otd_event_entry(archive, ev)
        if hit and hit["path"] not in seen:
            seen.add(hit["path"])
            out.append(hit)
            if len(out) >= OTD_LIMIT:
                break
    return out


def on_this_day(name, mmdd):
    """The day's events from a Wikipedia's own date page, in its own
    language, each naming an article the ZIM holds: ``[{event_year,
    event_text, path, title}]`` in the page's order. [] for a wiki with no
    such page (a subset, a mini build, a language whose date pages Zimi
    cannot name) or one that is not a Wikipedia; None when the page could
    not be read (logged, not kept). Read once per ZIM per day and kept."""
    if project_of_name(name) != "wikipedia" or not datepages.valid_mmdd(mmdd):
        return []
    return _kept(_otd_cache, _key(name, mmdd), lambda: _work_otd(name, mmdd))


def project_of_name(name):
    """The project of an installed ZIM, as the library read it."""
    return _project(_record(name) or {"name": name})


# ── the page's first ask ───────────────────────────────────────────────────


def _warm(day, names):
    """Work out the day's picks and On this day for every wiki, in the
    background, so the ones a page has not asked for yet are ready."""
    try:
        for name in names:
            pick(name, day)
            if project_of_name(name) == "wikipedia":
                on_this_day(name, day[4:])
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


def home(day=None):
    """The wikis this request may read, and for a day that can be asked
    for, what is already known of it (``picks``, ``otd``): kept answers
    only, never a read. The first ask of a day starts the background pass
    that works out the rest."""
    ws = wikis()
    out = {"wikis": ws}
    if not day_open(day):
        return out
    picks, otd, missing = {}, {}, []
    for w in ws:
        p = _peek(_pick_cache, _key(w["name"], day))
        if p is None:
            missing.append(w["name"])
        else:
            picks[w["name"]] = p
        if w["project"] == "wikipedia":
            ev = _peek(_otd_cache, _key(w["name"], day[4:]))
            if ev is None:
                missing.append(w["name"])
            else:
                otd[w["name"]] = ev
    out.update(day=day, picks=picks, otd=otd)
    if missing:
        _start_warm(day, dict.fromkeys(missing))
    return out


# The most wikis one /wiki/today ask may name: the page asks in small
# batches so each answer lands on its own, and no one ask holds a request
# thread for the whole library.
TODAY_BATCH_MAX = 8


def today(day, names):
    """The day's picks and On this day for the wikis named that this
    request may read, worked out now where they are not known yet:
    ``{picks: {name: pick}, otd: {name: [event]}, failed: [name]}``. A wiki
    not readable here is left out; one that failed to read is named in
    ``failed`` and asked again next time."""
    mine = {w["name"]: w for w in wikis()}
    out = {"picks": {}, "otd": {}, "failed": []}
    for name in dict.fromkeys(names):
        w = mine.get(name)
        if not w:
            continue
        got = pick(name, day)
        if got is None:
            out["failed"].append(name)
        else:
            out["picks"][name] = got
        if w["project"] == "wikipedia":
            ev = on_this_day(name, day[4:])
            if ev is None:
                if name not in out["failed"]:
                    out["failed"].append(name)
            else:
                out["otd"][name] = ev
    return out


def _reset_for_tests():
    with _lock:
        _pick_cache.clear()
        _otd_cache.clear()
        _inflight.clear()
        _warming.clear()
