"""ZimiGames and the encyclopedia, linked both ways.

The games' Wikidata Q-IDs live in the ZIM's source (builtin/games/games.json:
Q-ID, the game's page, its English article title). Which installed Wikipedia
article carries each Q-ID is worked out in the background whenever the library
changes (``refresh_async``), from what Zimi already keeps: the per-ZIM Q-ID
index and the passive Q-ID cache, both plain SQLite reads, and for an English
ZIM with neither an exact-title probe. Nothing is built for this: a ZIM with no
Q-ID index only gets the links its cache holds (plus the English title probe).

``links()`` hands that answer to ``GET /games-links``, which the reader asks
for the first time a wiki article opens (never on page load). The reader then
checks its article's path in memory: a hit shows Play; the games' "About" link
(about.html?qid=) opens the article for the reader's language.
"""

import html
import json
import logging
import os
import random
import re
import threading
import time

import zimi.server as _srv
from zimi import ownzims
from zimi.safety import loggable
from zimi.interlang import (
    _ALMANAC_ENC_RE,
    _almanac_title_entry_path,
    _qid_find_in_zim,
)

log = logging.getLogger("zimi")

_GAMES_ZIM = "zimi_games"
_ALMANAC_ZIM = "zimi_almanac"
_ALMANAC_LINKS_JS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static", "almanac-links.js")
#: The Almanac's kinds that are something to look at in the sky (not a holiday, a city or a term).
_SKY_KINDS = ("planet", "star", "const", "shower", "eclipse", "belt", "probe")
_ALMANAC_ENTRY = re.compile(r"'([a-z]+:[A-Za-z0-9_.\-]+)':\s*\{\s*q:\s*'(Q\d+)'")
_lock = threading.Lock()
_rows = None  # games.json, read once
_memo = {"token": None, "articles": {}}
_building = threading.Lock()
_dirty = threading.Event()
#: After a build fails, the next try waits this long (seconds), however often
#: the answer is asked for: a broken index must not cost every request a rebuild.
_RETRY_AFTER_FAILURE_S = 300
_failed_at = None  # time.monotonic() of the last failed build, or None


def _here(name):
    return (
        ownzims.enabled()
        and any(z.get("name") == name for z in _srv._zim_list_cache or [])
        and _srv.zim_allowed(name)
    )


def games_here():
    """Whether the games ZIM is in the library for this request: removed or
    deleted (or off the account's list), nothing of it is offered."""
    return _here(_GAMES_ZIM)


def almanac_here():
    """Whether the Almanac ZIM is in the library for this request."""
    return _here(_ALMANAC_ZIM)


_almanac_keys = None  # {qid: entity key}, read once
_thumbs = {}  # game path -> the picture's /w/ URL or None, found once


def almanac_qids():
    """{Q-ID: the Almanac's key for it ("planet:moon")}: the closed set the
    Almanac links into the encyclopedia (static/almanac-links.js holds it,
    once; this reads it so a Wikipedia article on one can offer the Almanac)."""
    global _almanac_keys
    if _almanac_keys is None:
        try:
            with open(_ALMANAC_LINKS_JS, encoding="utf-8") as f:
                _almanac_keys = {q: k for k, q in _ALMANAC_ENTRY.findall(f.read()) if k.split(":")[0] in _SKY_KINDS}
        except OSError as e:
            log.warning("almanac-links.js unreadable: %s", e)
            _almanac_keys = {}
    return _almanac_keys


def rows():
    """games.json: [{qid, wiki, path, title, blurb}]."""
    global _rows
    if _rows is None:
        path = os.path.join(ownzims.SOURCE_ROOT, "games", "games.json")
        try:
            with open(path, encoding="utf-8") as f:
                _rows = json.load(f)
        except (OSError, ValueError) as e:
            log.warning("games.json unreadable: %s", e)
            _rows = []
    return _rows


#: The shelf as the page writes it: a section heading, a family card, the end of a family, a tile (page, English name).
_SHELF_TOKEN = re.compile(
    r'<h2 id="ar-([a-z]+)"|<div class="ar-family" data-name="([^"]*)"|(</div>)'
    r'|<a class="ar-game" href="([^"#?]+)\.html">.*?<strong>(.*?)</strong>',
    re.S,
)
_shelf = None  # [(page, stem, English name, section id, family name)], read once
_shelf_text = {}  # language -> {"game.x.title": ...}: only the keys the search reads


def _games_file(rel):
    """A text file of the games ZIM (the shelf page, a language's words), or None. Read from the ZIM, not the source
    folder: only games.json and the tile pictures of the source ship in the packages."""
    archive = _srv.get_archive(_GAMES_ZIM) if games_here() else None
    if archive is None:
        return None
    try:
        with _srv._zim_lock:
            return bytes(archive.get_entry_by_path(rel).get_item().content).decode("utf-8")
    except (KeyError, RuntimeError, UnicodeDecodeError) as e:
        log.debug("games ZIM has no %s: %s", loggable(rel), loggable(e))
        return None


def _shelf_tiles():
    """Every tile of the shelf with the section and family it sits in, read once from the page itself (the games
    are the page's, so a game added there is searchable with nothing else to edit)."""
    global _shelf
    if _shelf is None:
        tiles, section, family = [], "", ""
        page = _games_file("index.html")
        if page is None:
            return []   # not cached: the games ZIM may come back
        for sec, fam, end, href, name in _SHELF_TOKEN.findall(page):
            if sec:
                section, family = sec, ""
            elif fam:
                family = fam
            elif end:
                family = ""
            else:
                stem = href.replace("/", ".")
                tiles.append((href + ".html", stem, html.unescape(name), section, family))
        _shelf = tiles
    return _shelf


def _shelf_words(lang):
    """The games' words in one language ({} for a language the games lack)."""
    if lang not in _shelf_text:
        words, text = {}, _games_file("text/" + lang + ".json")
        if text is None and games_here():
            text = "{}"   # a language the games lack (the ZIM answered)
        if text is None:
            return {}
        try:
            words = {k: v for k, v in json.loads(text).items() if k.endswith(".title") or k.startswith("shelf.section.") or k.startswith("shelf.family.")}
        except ValueError:
            pass
        _shelf_text[lang] = words
    return _shelf_text[lang]


def _family_key(name):
    return "shelf.family." + re.sub(r"[^a-z]", "", name.lower())


def search_index(lang):
    """[{p: page, n: name, h: words}] for the main search's Games row: each game's name in `lang` (English where it has
    none), and the words it is found by (both names, its section and family). Read once per
    language from the games ZIM and kept, so only the first ask in a language reads it. Empty while the games ZIM is not
    in the library."""
    if not games_here():
        return []
    lang = lang if re.fullmatch(r"[a-z]{2,3}", lang or "") else "en"
    en, own = _shelf_words("en"), _shelf_words(lang)
    out = []
    for path, stem, name, section, family in _shelf_tiles():
        key = "game." + stem + ".title"
        shown = own.get(key) or name
        words = [name, shown]
        # "Library" is the shelf's drawer for games that read your library; as a word it would answer every search for one.
        for k in ("shelf.section." + section if section != "library" else "", _family_key(family) + ".name" if family else ""):
            words += [w for w in (own.get(k), en.get(k)) if w and k]
        out.append({"p": path, "n": shown, "h": " ".join(dict.fromkeys(words))})
    return out


def wiki_rows():
    """The rows that stand for an encyclopedia article (a puzzle with none has no Q-ID)."""
    return [r for r in rows() if r.get("qid")]


def warm():
    """Read what the answers are made of before a request needs it: games.json, the Almanac's closed set and each game's
    picture (all fixed files of the package). Called from the background pass."""
    almanac_qids()
    _shelf_tiles()
    for r in rows():
        thumbnail(r["path"])


def _wiki_zims():
    return [
        z
        for z in (_srv._zim_list_cache or [])
        if _ALMANAC_ENC_RE.match(z.get("name", ""))
    ]


def build():
    """{qid: [{zim, lang, path}]} over every installed encyclopedia ZIM."""
    games = wiki_rows()
    zims = _wiki_zims()
    articles = {}
    probe = []  # (zim, row) an English ZIM's index did not answer
    for z in zims:
        name, lang = z.get("name", ""), z.get("language", "")
        for r in games:
            path = _qid_find_in_zim(name, int(r["qid"][1:]))
            if path:
                articles.setdefault(r["qid"], []).append(
                    {"zim": name, "lang": lang, "path": path}
                )
            elif lang == "en" and r.get("wiki"):
                probe.append((name, r))
        for qid in almanac_qids():
            if qid in articles and any(a["zim"] == name for a in articles[qid]):
                continue
            path = _qid_find_in_zim(name, int(qid[1:]))
            if path:
                articles.setdefault(qid, []).append({"zim": name, "lang": lang, "path": path})
    if probe:
        with _srv._zim_lock:  # libzim: one hold for a few dozen memory-mapped probes
            for name, r in probe:
                path = _almanac_title_entry_path(name, r["wiki"])
                if path:
                    articles.setdefault(r["qid"], []).append(
                        {"zim": name, "lang": "en", "path": path}
                    )
    return articles


def _refresh():
    """Work the answer out now (callers are background threads, or the first
    request after a library change). A call during a pass asks it to go round
    again, so no change is lost."""
    global _failed_at
    _dirty.set()
    if not _building.acquire(blocking=False):
        return
    try:
        warm()  # before the first pass clears the flag: asks made meanwhile are covered by it
        while _dirty.is_set():
            _dirty.clear()
            token = _srv._listing_seen
            try:
                articles = build()
            except Exception as e:
                log.warning("games links not built: %s", e)
                _failed_at = time.monotonic()
                break
            with _lock:
                _memo["token"], _memo["articles"] = token, articles
            _failed_at = None
    finally:
        _building.release()


def qids_changed(qid=None):
    """The Q-ID answers moved (an index was built, or a viewed article's Q-ID
    was learned): rework the links, unless that Q-ID is no game's."""
    if qid is None or any(r["qid"] == "Q%d" % qid for r in wiki_rows()) or "Q%d" % qid in almanac_qids():
        _refresh()


def refresh_async():
    """Rework the answer in the background (the library changed)."""
    threading.Thread(target=_refresh, name="games-links", daemon=True).start()


def links():
    """The last good answer, never a build (the build is the background's: it
    reads SQLite for every wiki ZIM and probes titles under the libzim lock).
    The data GET /games-links serves: {games: {qid: {zim, path, title}},
    almanac: {qid: entity key}, articles: {qid: [{zim, lang, path}]}}, for
    what this request may see. An app's entries are there only while its ZIM
    is in the library."""
    if not games_here() and not almanac_here():
        return {"games": {}, "almanac": {}, "articles": {}}
    with _lock:
        fresh = _memo["token"] is _srv._listing_seen
        articles = _memo["articles"]
    if not fresh and (_failed_at is None or time.monotonic() - _failed_at > _RETRY_AFTER_FAILURE_S):
        refresh_async()  # never built on this thread: the last good answer is served meanwhile
    games = {
        r["qid"]: {"zim": _GAMES_ZIM, "path": r["path"], "title": r["title"]}
        for r in wiki_rows()
        if games_here()
    }
    almanac = almanac_qids() if almanac_here() else {}
    shown = {
        q: [a for a in found if _srv.zim_allowed(a["zim"])]
        for q, found in articles.items()
    }
    return {
        "games": games,
        "almanac": {q: k for q, k in almanac.items() if shown.get(q)},
        "articles": {q: a for q, a in shown.items() if a},
    }


def _fnv1a(text):
    """FNV-1a over the UTF-8 bytes, 32 bits: recent.js's fnv1a, the same number."""
    h = 0x811C9DC5
    for b in text.encode("utf-8"):
        h = ((h ^ b) * 0x01000193) & 0xFFFFFFFF
    return h


def game_of_day(day, games=None):
    """The game of a day ("YYYY-MM-DD" or "YYYYMMDD"): the hash of the day over
    games.json's pages in order. The same pick as the shelf's Game of the day
    (builtin/games/recent.js dayPick), which is how Discover's card and the
    shelf agree without either asking the other. None for a day it cannot
    read."""
    digits = "".join(c for c in str(day) if c.isdigit())
    if len(digits) != 8:
        return None
    day = "%s-%s-%s" % (digits[:4], digits[4:6], digits[6:])
    seen, pages = set(), []
    for r in games if games is not None else rows():
        if r["path"] not in seen:
            seen.add(r["path"])
            pages.append(r)
    return pages[_fnv1a(day) % len(pages)] if pages else None


def thumbnail(game_path):
    """The day's game as a small picture inside the ZIM, as a /w/ URL: the
    tile's own art (thumbs/<game>.svg, thumbs/puzzles/<name>.svg for one of
    Tatham's puzzles, scripts/build_games_shelf.js) or, for a puzzle with no
    tile, its icon. None for a game with neither."""
    if game_path in _thumbs:
        return _thumbs[game_path]
    stem = os.path.splitext(os.path.basename(game_path))[0]
    folder = os.path.join(ownzims.SOURCE_ROOT, "games")
    own = os.path.splitext(game_path)[0]
    found = None
    for rel in ("thumbs/%s.svg" % own, "puzzles/icons/%s.png" % stem):
        if os.path.exists(os.path.join(folder, rel)):
            found = "/w/%s/%s" % (_GAMES_ZIM, rel)
            break
    _thumbs[game_path] = found   # the files never change under a running server: asked of the disk once, in the background
    return found


def random_card(exclude=None, served=False):
    """A random game from the shelf (games.json's pages, never about.html, a
    stylesheet or a script), in /random's shape, or None. ``exclude`` is the
    page being played: the dice move on to another game. ``served``: the caller
    has seen the ZIM in the library for this request, so nothing here waits on the
    library list being warm (a freshly built ZIM's list was not, and /random then
    drew any entry, README.txt included)."""
    if not served and not games_here():
        return None
    seen, pages = set(), []
    for r in rows():
        if r["path"] not in seen and r["path"] != exclude:
            seen.add(r["path"])
            pages.append(r)
    return _card(random.choice(pages)) if pages else None


def _card(g):
    return {
        "zim": _GAMES_ZIM,
        "path": g["path"],
        "title": g["title"],
        "blurb": g.get("why") or g.get("blurb"),
        "thumbnail": thumbnail(g["path"]),
    }


def day_card(day):
    """The game of the day as Discover's card, in /random's shape, or None
    (no such day, or the games ZIM is not here for this request)."""
    if not games_here():
        return None
    g = game_of_day(day)
    if not g:
        return None
    return _card(g)
