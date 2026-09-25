"""Zimipedia: every wiki in the library, as one.

Kiwix builds Wikipedia, its sister projects (Wiktionary, Wikivoyage,
Wikiquote, Wikibooks, Wikiversity, Wikinews, Wikisource, Wikispecies) and
the MediaWiki wikis beyond Wikimedia with one scraper, mwoffliner, so what
a ZIM is was already decided when the library was read (its ``kind`` is
``wiki``). Nothing here opens an archive to find the wikis: the list is a
view of the library cache. The page itself (/static/wiki.html) builds its
Today view from endpoints Zimi already has (/random with a day seed, the
Discover card's reader) and searches through /search scoped to the wikis
chosen; the one thing added is On this day as a list, read from the
Wikipedia's own date page once per day and kept.

Eric, 2026-09-24: "a wiki app that like has pills for all the individual
wikis but builds a unified one and has the today page suggesting articles
or whatever and good scoped search and display views and whatnot."
"""

import logging
import threading

from zimi import server as _srv

log = logging.getLogger("zimi")

_lock = threading.Lock()
_otd_cache = {}  # (archive filename, mmdd) -> [event]
# A day's events for every Wikipedia a library could hold, several days
# over: small, and cleared whole rather than aged.
_OTD_CACHE_MAX = 64
OTD_LIMIT = 8

# How a project is named on its pill. Wikimedia's own names, which are
# names, so the same in every language of the interface.
PROJECT_TITLES = {p: p.capitalize() for p in _srv.WIKI_PROJECTS}


def project_of(name):
    """Which Wikimedia project a ZIM belongs to, from its name
    (``wikipedia_fr_all`` is Wikipedia), or "" for a wiki beyond them."""
    n = (name or "").lower()
    for p in _srv.WIKI_PROJECTS:
        if n.startswith(p):
            return p
    return ""


def _order(w):
    p = w["project"]
    rank = (
        _srv.WIKI_PROJECTS.index(p)
        if p in _srv.WIKI_PROJECTS
        else len(_srv.WIKI_PROJECTS)
    )
    return (rank, w["language"], w["title"].lower())


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
        project = project_of(name)
        out.append(
            {
                "name": name,
                "title": z.get("title") or name,
                "project": project,
                "project_title": PROJECT_TITLES.get(project, ""),
                "language": (z.get("language") or "").split(",")[0],
                "icon": bool(z.get("has_icon")),
                "main_path": z.get("main_path") or "",
                "entries": z.get("entries") or 0,
                "description": z.get("description") or "",
                "date": z.get("date") or "",
            }
        )
    out.sort(key=_order)
    return out


def home():
    return {"wikis": wikis()}


def is_wiki(name):
    return any(w["name"] == name for w in wikis())


def on_this_day(name, mmdd):
    """Today's dated events from a Wikipedia's own "Month_Day" page, each
    naming an article the ZIM holds: ``[{event_year, event_text, path,
    title}]``, in the page's order. [] for a wiki with no such page (a
    subset, another project, or a language whose date pages carry its own
    month names). Read once per ZIM per day and kept."""
    from zimi.search import otd_events

    if project_of(name) != "wikipedia" or not is_wiki(name):
        return []
    if len(mmdd or "") != 4 or not mmdd.isdigit():
        return []
    # Keyed by the build (name and date), so a new month's file is read
    # afresh; a hit never waits on the library lock.
    z = next((z for z in _srv._zim_list_cache or [] if z.get("name") == name), {})
    key = (name, str(z.get("date") or ""), mmdd)
    with _lock:
        if key in _otd_cache:
            return _otd_cache[key]
    with _srv._zim_lock:
        archive = _srv.get_archive(name)
        if archive is None:
            return []
        try:
            events = otd_events(archive, mmdd, limit=OTD_LIMIT)
        except Exception as e:
            log.debug("on this day failed for %s %s: %s", name, mmdd, e)
            events = []
    with _lock:
        if len(_otd_cache) >= _OTD_CACHE_MAX:
            _otd_cache.clear()
        _otd_cache[key] = events
    return events


def _reset_for_tests():
    with _lock:
        _otd_cache.clear()
