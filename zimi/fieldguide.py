"""Field Guide: what is happening to you, and what the open sources say.

Zimi writes no first-aid or survival instruction. The Field Guide is a way
in: a handful of situations (someone is bleeding, I need water, I am lost, a
flood is coming), their order, and under each the passages of public-domain
and openly licensed sources that answer it, quoted word for word with the
source, its edition, the place in it, its licence and a link
(assets/fieldguide-quotes.json). Our own words are the situation names and
the navigation. The quotes ship inside Zimi, so the guide works with an
empty library; the ZIMs you install are the depth behind each quote (the full
section, the pages around it, the rest of the manual), and a situation says
which ZIM adds what and how large it is.

What a situation is called, how it is searched for in ten languages, and
where each kind of ZIM keeps its pages is data (assets/fieldguide.json).

Search answers with a situation (``hint``): an in-memory lookup of the typed
words in a keyword table and the library list the server already holds.
Nothing is read from a ZIM and nothing is fetched on the search path.
Opening a situation finds its pages in the installed ZIMs, and keeps them.

``build_field_manual`` makes a ZIM from the public-domain manuals (TC 4-02.1,
FM 21-76, the Ranger Handbook) with Create's folder mode, for a library that
has none of them.

Eric, 2026-09-28: "build first aid and or a whole like how to live and
survive bucket. Like what the military would teach seals to handle where
ever they go." His bar: an app must beat the ZIM's own pages. Eric,
2026-10-14: "all stuff should be sourced from a ZIM right or we're going far
beyond?", then: each situation an intuitive, cited flow of verbatim quotes,
with no or minimal text of our own, working with an empty library.
"""

import json
import logging
import os
import re
import threading
import unicodedata
import urllib.error
import urllib.parse
import urllib.request

from zimi import renames as _renames
from zimi import server as _srv

log = logging.getLogger("zimi")

_ASSETS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets")
DATA_PATH = os.path.join(_ASSETS, "fieldguide.json")
QUOTES_PATH = os.path.join(_ASSETS, "fieldguide-quotes.json")
# The one sentence every situation carries. The page shows the shell's string
# for it (fg_disclaimer) in the reader's language; this is the English.
DISCLAIMER = "Not medical advice. Call emergency services if you can."
# The longest typed query that can name a situation.
MAX_QUERY_CHARS = 80
# Documents listed from one document library (a nautilus ZIM) for one situation.
MAX_DOCS = 8
# A source older than this is shown as dated.
DATED_BEFORE = 2000
# How long the catalog's sizes are kept before the catalog is read again.
_CATALOG_KEEP_S = 600
_CACHE_MAX = 64
# The field-manual ZIM's file name stem, and the listing a folder ZIM carries.
FIELD_MANUAL_NAME = "zimi-field-manual"

_lock = threading.Lock()
_data = None
_quotes = None
_index = None
_piece_res = {}
_resolved = {}  # (situation, language, library signature) -> the situation, resolved
_catalog_kept = (0.0, {})
_have_kept = (None, {})  # (the library list it was worked out for, the pieces)


def _load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def data():
    """assets/fieldguide.json, read once."""
    global _data
    with _lock:
        if _data is None:
            _data = _load(DATA_PATH)
        return _data


def quotes():
    """assets/fieldguide-quotes.json (sources and quotes), read once."""
    global _quotes
    with _lock:
        if _quotes is None:
            _quotes = _load(QUOTES_PATH)
        return _quotes


# ── what was typed ──────────────────────────────────────────────────────────


def normalize(text):
    """Words as they are compared: case folded, Latin and Cyrillic accents
    off (other scripts keep their marks), punctuation to spaces except the
    hyphen, apostrophes dropped."""
    t = unicodedata.normalize("NFKC", str(text or "")).casefold()
    t = unicodedata.normalize("NFD", t)
    t = "".join(c for c in t if not ("̀" <= c <= "ͯ"))
    t = unicodedata.normalize("NFC", t)
    out = []
    for c in t:
        if c in "'’ʼ":
            continue
        out.append(" " if unicodedata.category(c)[0] in "PSZC" and c != "-" else c)
    return " ".join("".join(out).split())


class _Tables:
    """One language's words: the whole query, a phrase anywhere in it, a
    run of CJK characters anywhere in it, and a bare word that is only a link."""

    __slots__ = ("exact", "within", "cjk", "link")

    def __init__(self):
        self.exact, self.within, self.cjk, self.link = {}, {}, {}, {}


_CJK = re.compile("[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]")
MAX_PHRASE_WORDS = 8
MAX_CJK_RUN = 8


def _keyword_index():
    """({language: _Tables}, {language: filler words}). Per situation, three
    kinds of words: ``keywords`` (the whole query, or a phrase of two or more
    words anywhere in it), ``within`` (a single word safe inside any query:
    "bleeding" in "my friend is bleeding") and ``ambiguous`` (a bare word that
    names a situation only as a small link: "water", "storm"). "" is the Field
    Guide itself ("first aid", "survival"). First writer wins; the tests hold
    the table to no phrase in two places."""
    global _index
    with _lock:
        built = _index
    if built is not None:
        return built
    d = data()
    tables = {}

    def of(lang):
        return tables.setdefault(lang, _Tables())

    for lang, words in d["home"].items():
        for w in words:
            n = normalize(w)
            of(lang).exact.setdefault(n, "")
    for sid, sit in d["situations"].items():
        for lang, words in sit["keywords"].items():
            t = of(lang)
            for w in words:
                n = normalize(w)
                t.exact.setdefault(n, sid)
                if len(n.split()) >= 2:
                    t.within.setdefault(n, sid)
        for lang, words in sit.get("within", {}).items():
            t = of(lang)
            for w in words:
                n = normalize(w)
                (t.cjk if _CJK.search(n) else t.within).setdefault(n, sid)
        for lang, words in sit.get("ambiguous", {}).items():
            t = of(lang)
            for w in words:
                t.link.setdefault(normalize(w), sid)
    stop = {lang: {normalize(w) for w in words} for lang, words in d["stop"].items()}
    built = (tables, stop)
    with _lock:
        _index = built
    return built


def _whole(wholes, tables, langs):
    """The whole typed query (or what is left without filler) as a keyword
    ("card") or a bare ambiguous word ("link"); None when it is neither."""
    for whole in wholes:
        for x in langs:
            t = tables.get(x)
            if t and whole in t.exact:
                sid = t.exact[whole]
                return (sid, "card" if sid else "link")
        for x in langs:
            t = tables.get(x)
            if t and whole in t.link:
                return (t.link[whole], "link")
    return None


def _inside(words, q, tables, langs):
    """A phrase or a CJK run anywhere in the query, the longest first."""
    for n in range(min(len(words), MAX_PHRASE_WORDS), 0, -1):
        for i in range(len(words) - n + 1):
            gram = " ".join(words[i : i + n])
            for x in langs:
                t = tables.get(x)
                if t and gram in t.within:
                    return (t.within[gram], "card")
    if not _CJK.search(q):
        return None
    for n in range(min(len(q), MAX_CJK_RUN), 1, -1):
        for i in range(len(q) - n + 1):
            for x in langs:
                t = tables.get(x)
                if t and q[i : i + n] in t.cjk:
                    return (t.cjk[q[i : i + n]], "card")
    return None


def lookup(query, lang="en"):
    """``(situation id, kind)`` for what was typed, or None. ``kind`` is
    "card" (the words name an emergency: show its first passage) or "link"
    (a bare ambiguous word, or the Field Guide itself: a small link, nothing
    quoted). Only the reader's language and English are read. The whole
    query is tried first, then without filler words; then any phrase in it,
    the longest first ("my friend is bleeding"). Words that name nothing
    ("water cycle", "signal processing") name nothing."""
    q = normalize(query)
    if not q or len(q) > MAX_QUERY_CHARS:
        return None
    tables, stop = _keyword_index()
    langs = [lang] if lang in tables and lang != "en" else []
    langs.append("en")
    words = q.split()
    rest = " ".join(w for w in words if not any(w in stop.get(x, ()) for x in langs))
    wholes = [q] + ([rest] if rest and rest != q else [])
    return _whole(wholes, tables, langs) or _inside(words, q, tables, langs)


def who(query, lang="en"):
    """Who the words say needs help ("infant" for "baby choking"), or None:
    the situation's passages tagged for them come first. The reader's
    language and English are read, as in lookup."""
    q = normalize(query)
    if not q or len(q) > MAX_QUERY_CHARS:
        return None
    words = set(q.split())
    for name, by_lang in data().get("who", {}).items():
        for x in {lang, "en"}:
            for w in by_lang.get(x, ()):
                # A phrase or a CJK run anywhere in the text; one word whole.
                n = normalize(w)
                phrase = " " in n or _CJK.search(n)
                if (phrase and n in q) or (not phrase and n in words):
                    return name
    return None


def match(query, lang="en"):
    """The situation id a typed query names ("" for the Field Guide itself),
    or None; see lookup for what is read and in what order."""
    got = lookup(query, lang)
    return None if got is None else got[0]


# ── what the library holds ──────────────────────────────────────────────────


def _piece_re(pid):
    with _lock:
        rx = _piece_res.get(pid)
    if rx is None:
        rx = re.compile(data()["pieces"][pid]["match"])
        with _lock:
            _piece_res[pid] = rx
    return rx


def _short(prefix):
    return _srv._zim_base_name(prefix + "_2000-01.zim")


def _is_piece(rx, name):
    """A library name fits a piece's pattern, or did before the ZIM was renamed
    upstream (www.ready.gov is ready.gov now)."""
    if rx.search(name):
        return True
    return any(
        _short(new) == name and rx.search(_short(old))
        for old, new in _renames.table().items()
    )


def installed_zims():
    """{piece id: [library entries]} for the pieces the library holds, the
    biggest ZIM first (a piece can be several ZIMs: Wikipedia comes in many).
    Worked out once per library list (the server swaps the list when the
    library changes), so a search pays a comparison, not a scan."""
    global _have_kept
    zims = _srv.list_zims() or []
    with _lock:
        kept_for, kept = _have_kept
    if zims is kept_for:
        return kept
    out = {}
    for pid in data()["pieces"]:
        rx = _piece_re(pid)
        found = [z for z in zims if _is_piece(rx, z.get("name", ""))]
        if found:
            out[pid] = sorted(found, key=lambda z: -int(z.get("size_bytes") or 0))
    with _lock:
        _have_kept = (zims, out)
    return out


def _signature(have):
    return tuple(
        sorted(
            (z["name"], z.get("date", ""), int(z.get("size_bytes") or 0))
            for zs in have.values()
            for z in zs
        )
    )


def _pieces_of(sid):
    seen = []
    for a in data()["situations"][sid]["answers"]:
        if a["piece"] not in seen:
            seen.append(a["piece"])
    return seen


def hint(query, lang="en"):
    """What search says beside its results when the words name a situation:
    ``{"id", "kind", "href", "installed": [{"piece", "name"}]}``, or None.
    ``id`` is "" for the Field Guide itself; ``kind`` is "card" or "link"
    (see lookup); ``who`` is who the words say needs help (see who). Only the keyword table and the library list in memory are
    read, so the search path pays nothing for it."""
    got = lookup(query, lang)
    if got is None:
        return None
    sid, kind = got
    d = data()
    installed = []
    if sid and kind == "card":
        have = installed_zims()
        installed = [
            {"piece": p, "name": d["pieces"][p]["name"]}
            for p in _pieces_of(sid)
            if p in have
        ]
    return {
        "id": sid,
        "kind": kind,
        "href": "/#fieldguide" + ("/" + sid if sid else ""),
        "installed": installed,
        "who": who(query, lang) if sid and kind == "card" else None,
    }


# ── the front ───────────────────────────────────────────────────────────────


def home(bare=False):
    """The situations in their groups and order, with how many quotes each
    holds and how many of the sources that go deeper are installed. The
    library list only: no ZIM is read. ``bare`` is for a visitor the library
    is not shown to (the sign-in screen, a fresh install's setup): the
    quotes, nothing about what is installed."""
    d = data()
    q = quotes()["quotes"]
    have = {} if bare else installed_zims()
    groups = []
    for g in d["groups"]:
        rows = []
        for sid in g["situations"]:
            pieces = _pieces_of(sid)
            rows.append(
                {
                    "id": sid,
                    "mark": d["marks"].get(sid, ""),
                    "quotes": len(q.get(sid, [])),
                    "installed": sum(1 for p in pieces if p in have),
                    "of": len(pieces),
                }
            )
        groups.append({"id": g["id"], "order": g["order"], "situations": rows})
    return {"groups": groups, "disclaimer": DISCLAIMER}


# ── one situation ───────────────────────────────────────────────────────────


def _year(*texts):
    for t in texts:
        m = re.match(r"\s*(\d{4})", str(t or ""))
        if m:
            return int(m.group(1))
    return 0


def _page_in(zim, path):
    """(path, title) of a page of an installed ZIM, following one redirect, or
    None. The caller holds _zim_lock."""
    from zimi.search import _article_entry

    try:
        _archive, real, entry, _item = _article_entry(zim, path)
    except KeyError:
        return None
    except Exception as e:
        log.debug("fieldguide page %s %s: %s", zim, path, e)
        return None
    try:
        if entry.is_redirect:
            entry = entry.get_redirect_entry()
            real = entry.path
    except Exception:
        pass
    try:
        title = entry.title or path.rsplit("/", 1)[-1]
    except Exception:
        title = path.rsplit("/", 1)[-1]
    return real, title


def _title_page(zim, title):
    """A page of an installed ZIM by its title: the title as a path first
    (mwoffliner files "Heat stroke" as Heat_stroke), then the title index.
    The caller holds _zim_lock."""
    underscored = title.replace(" ", "_")
    for cand in (underscored, "A/" + underscored):
        got = _page_in(zim, cand)
        if got:
            return got
    from zimi.search import _title_index_exact

    for r in _title_index_exact(zim, title):
        return r["path"], r["title"]
    return None


def _docs(zim, words, listing=None):
    """[(path, title, description)] of a document library's items whose title
    or description holds one of ``words`` ("*" is every item). The caller
    holds _zim_lock."""
    from zimi import nautilus

    archive = _srv.get_archive(zim)
    if archive is None:
        return []
    try:
        items = nautilus.items(archive, listing) if listing else nautilus.items(archive)
    except Exception as e:
        log.debug("fieldguide listing %s: %s", zim, e)
        return []
    out = []
    for it in items:
        hay = ((it.get("ti") or "") + " " + (it.get("dsc") or "")).lower()
        if "*" in words or any(w.lower() in hay for w in words):
            files = nautilus.files_of(it, "" if listing else nautilus.FILES_PREFIX)
            if files and nautilus.ext_kind(files[0]) == "document":
                out.append(
                    (
                        files[0],
                        it.get("ti") or nautilus.title_from_name(files[0]),
                        (it.get("dsc") or "").strip(),
                    )
                )
        if len(out) >= MAX_DOCS:
            break
    return out


def _rows_for(ans, pid, piece, zims):
    """The places one answer finds in the installed ZIMs of its piece."""
    rows = []
    base = {
        "piece": pid,
        "name": piece["name"],
        "tier": ans.get("tier", 3),
        "edition": ans.get("edition", ""),
    }
    for z in zims:
        zim = z["name"]
        here = dict(
            base, zim=zim, zim_title=z.get("title") or zim, built=z.get("date", "")
        )
        found = []
        for slug in ans.get("slugs", []):
            for tpl in piece.get("paths", []):
                got = _page_in(zim, tpl.format(slug=slug))
                if got:
                    found.append(dict(here, kind="page", path=got[0], title=got[1]))
                    break
        for title in ans.get("titles", []):
            got = _title_page(zim, title)
            if got and not any(f["path"] == got[0] for f in found):
                found.append(dict(here, kind="page", path=got[0], title=got[1]))
        if ans.get("docs"):
            for path, title, dsc in _docs(zim, ans["docs"], piece.get("listing")):
                found.append(
                    dict(here, kind="doc", path=path, title=title, summary=dsc)
                )
        if ans.get("search"):
            found.append(
                dict(here, kind="search", path="", title=ans["search"], q=ans["search"])
            )
        rows += found
        if found and piece.get("one_zim", True):
            break
    return rows


def _catalog_sizes():
    """{catalog name: {"size_bytes", "url", "date"}} from the catalog on disk
    or the one shipped, kept for a few minutes."""
    import time

    global _catalog_kept
    at, kept = _catalog_kept
    if kept and time.time() - at < _CATALOG_KEEP_S:
        return kept
    from zimi import library

    items, _source, _as_of = library.offline_catalog()
    out = {}
    for it in items:
        name = it.get("name")
        if name:
            out[name] = {
                "size_bytes": int(it.get("size_bytes") or it.get("size") or 0),
                "url": it.get("download_url") or it.get("url") or "",
                "date": it.get("date", ""),
            }
    _catalog_kept = (time.time(), out)
    return out


def _missing(pid, piece, sizes):
    """A piece the library lacks, as an option to add: what it is, how big,
    where it downloads from. None when the catalog has none of it."""
    for name in piece.get("catalog", []):
        got = sizes.get(name) or sizes.get(_renames.successor_name(name))
        if got:
            return {
                "piece": pid,
                "name": piece["name"],
                "note": piece.get("note", ""),
                "catalog": name,
                "size_bytes": got["size_bytes"],
                "url": got["url"],
                "date": got.get("date", ""),
            }
    if piece.get("build") and not _offline():
        return {
            "piece": pid,
            "name": piece["name"],
            "note": piece.get("note", ""),
            "build": piece["build"],
            "size_bytes": sum(m["bytes"] for m in MANUALS),
            "source": _manual_sources(),
            "url": "",
        }
    return None


def _offline():
    """Offline: nothing is built or fetched from here, so nothing is offered."""
    from zimi import p2p

    return p2p.is_offline()


# The places the manuals are fetched from, named for a person.
_MANUAL_HOSTS = {
    "armypubs.army.mil": "Army Publishing Directorate",
    "upload.wikimedia.org": "Wikimedia Commons",
}


def _manual_sources():
    names = []
    for m in MANUALS:
        host = urllib.parse.urlsplit(m["url"]).hostname
        name = _MANUAL_HOSTS.get(host, host)
        if name not in names:
            names.append(name)
    return " and ".join(names)


_MONTHS = {
    m: i
    for i, m in enumerate("jan feb mar apr may jun jul aug sep oct nov dec".split(), 1)
}
_EDITION_DATE = re.compile(
    r"(?:(\d{1,2})/\d{1,2}/(\d{4}))"  # 03/10/2026, US order
    r"|(?:([A-Za-z]{3,9})\.?\s+\d{1,2},?\s+(\d{4}))"  # May 15, 2024 / Sept. 23, 2026
    r"|(?:\d{1,2}\s+([A-Za-z]{3,9})\s+(\d{4}))"  # 23 March 2026
    r"|(?:\b([A-Za-z]{3,9})\s+(\d{4}))"
)  # January 2016


def _as_of(edition, year):
    """The guidance's date as "YYYY-MM" from its edition line, the latest date
    the line names (a change outdates its base edition); "YYYY" from the year
    when the line names no month."""
    best = None
    for m in _EDITION_DATE.finditer(edition or ""):
        if m.group(1):
            mon, yr = int(m.group(1)), int(m.group(2))
        else:
            name, yr = next(
                (m.group(i), int(m.group(i + 1))) for i in (3, 5, 7) if m.group(i)
            )
            mon = _MONTHS.get(name[:3].lower())
            if not mon:
                continue
        if best is None or (yr, mon) > best:
            best = (yr, mon)
    if best:
        return "%04d-%02d" % best
    return "%04d" % year if year else ""


def _source_view(src_id, quote):
    s = quotes()["sources"][src_id]
    year = quote.get("year") or s["year"]
    edition = quote.get("edition") or s["edition"]
    return {
        "id": src_id,
        "title": s["title"],
        "edition": edition,
        "as_of": _as_of(edition, year),
        "publisher": s["publisher"],
        "licence": s["licence"],
        "licence_note": s.get("licence_note", ""),
        "superseded": s.get("superseded", ""),
        "year": year,
        "dated": year < DATED_BEFORE,
    }


def _carrier(quote, have, sizes):
    """Where a quote goes deeper: the installed ZIM that carries its source
    (the page, the document, or a search for the source's name inside the
    ZIM), or, with none installed, the ZIMs that would. ``open`` is
    {"zim", "path"} or {"zim", "q"}. The caller holds _zim_lock."""
    d = data()
    options = []
    for c in quotes()["sources"][quote["source"]].get("carriers", []):
        pid = c["piece"]
        piece = d["pieces"][pid]
        if pid not in have:
            m = _missing(pid, piece, sizes)
            if m:
                options.append(m)
            continue
        zim = have[pid][0]["name"]
        here = {"state": "installed", "piece": pid, "name": piece["name"], "zim": zim}
        if quote.get("slug"):
            for tpl in piece.get("paths", []):
                got = _page_in(zim, tpl.format(slug=quote["slug"]))
                if got:
                    return dict(here, open={"zim": zim, "path": got[0]})
        if c.get("doc"):
            docs = _docs(zim, [c["doc"]], piece.get("listing"))
            if docs:
                return dict(here, open={"zim": zim, "path": docs[0][0]})
        return dict(here, open={"zim": zim, "q": c.get("find") or quote["heading"]})
    return {"state": "missing", "options": options}


def _related(sid):
    """The situations the sources pair with this one (a quote's ``related``),
    in the order they first appear."""
    out = []
    for q in quotes()["quotes"].get(sid, []):
        for other in q.get("related", []):
            if other != sid and other not in out:
                out.append(other)
    return out


def situation_bare(sid):
    """A situation's quotes and nothing of the library: for a visitor it is
    not shown to. Free of the ZIMs altogether, so it works with none."""
    if sid not in data()["situations"]:
        return None
    return {
        "id": sid,
        "mark": data()["marks"].get(sid, ""),
        "quotes": [
            dict(
                x,
                source=_source_view(x["source"], x),
                library={"state": "missing", "options": []},
            )
            for x in quotes()["quotes"].get(sid, [])
        ],
        "answers": [],
        "missing": [],
        "related": _related(sid),
        "sky": sid in data()["sky_strip"],
        "disclaimer": DISCLAIMER,
    }


def situation(sid, lang="en"):
    """One situation: its quotes in the order the data gives (what to do in
    the next minute first), each with its source, edition, place, licence
    and link and where the library goes deeper, the pages the installed ZIMs
    hold on it, and the ZIMs that would add more. None for an unknown id.
    What depends on the library's ZIMs for the pieces is kept; the reader's
    own-language Wikipedia is looked up after, so a ZIM added or removed
    shows at once."""
    d = data()
    sit = d["situations"].get(sid)
    if sit is None:
        return None
    have = installed_zims()
    lang = lang if lang in d["stop"] else "en"
    key = (sid, _signature(have))
    with _lock:
        kept = _resolved.get(key)
    if kept is None:
        kept = _resolve(sid, sit, have)
        with _lock:
            if len(_resolved) >= _CACHE_MAX:
                _resolved.clear()
            _resolved[key] = kept
    rows = [dict(r) for r in kept["answers"]] + _language_rows(sit, lang)
    for i, r in enumerate(rows):
        r["_i"] = i
        r["year"] = _year(r.get("edition"), r.get("built"))
        r["dated"] = bool(r["year"]) and r["year"] < DATED_BEFORE
    # Pages and documents before searches; then tier; then newest; then data order.
    rows.sort(key=lambda r: (r["kind"] == "search", r["tier"], -r["year"], r["_i"]))
    for r in rows:
        r.pop("_i", None)
    return dict(kept, answers=rows)


def _resolve(sid, sit, have):
    """A situation worked out against the pieces the library holds (not the
    reader's language): its quotes and carriers, the pages found, the pieces
    missing."""
    d = data()
    sizes = _catalog_sizes()
    rows = []
    qs = []
    with _srv._zim_lock:
        for quote in quotes()["quotes"].get(sid, []):
            qs.append(
                dict(
                    quote,
                    source=_source_view(quote["source"], quote),
                    library=_carrier(quote, have, sizes),
                )
            )
        for ans in sit["answers"]:
            pid = ans["piece"]
            if pid in have:
                rows += _rows_for(ans, pid, d["pieces"][pid], have[pid])
        for pid in _pieces_of(sid):
            if pid in have and not any(r["piece"] == pid for r in rows):
                z = have[pid][0]
                q = sit["keywords"]["en"][0]
                rows.append(
                    {
                        "piece": pid,
                        "name": d["pieces"][pid]["name"],
                        "tier": 3,
                        "edition": "",
                        "zim": z["name"],
                        "zim_title": z.get("title") or z["name"],
                        "built": z.get("date", ""),
                        "kind": "search",
                        "path": "",
                        "title": q,
                        "q": q,
                    }
                )
    missing = []
    for pid in _pieces_of(sid):
        piece = d["pieces"][pid]
        if pid not in have:
            m = _missing(pid, piece, sizes)
            if m:
                missing.append(m)
    return {
        "id": sid,
        "mark": d["marks"].get(sid, ""),
        "quotes": qs,
        "answers": rows,
        "missing": missing,
        "related": _related(sid),
        "sky": sid in data()["sky_strip"],
        "disclaimer": DISCLAIMER,
    }


def _language_rows(sit, lang):
    """The reader's own language's Wikipedia, searched in that language's
    words, as the library's answer where no first-aid ZIM exists in it. The
    caller holds nothing: the library list only."""
    if lang == "en":
        return []
    fb = data()["lang_fallback"]
    rx = re.compile(fb["pattern"].format(lang=re.escape(lang)))
    found = [z for z in (_srv.list_zims() or []) if rx.search(z.get("name", ""))]
    if not found:
        return []
    found.sort(
        key=lambda z: (fb["prefer"] not in z["name"], -int(z.get("size_bytes") or 0))
    )
    z = found[0]
    words = sit["keywords"].get(lang) or sit["keywords"]["en"]
    return [
        {
            "piece": "wikipedia_" + lang,
            "name": fb["name"],
            "tier": 3,
            "edition": "",
            "zim": z["name"],
            "zim_title": z.get("title") or z["name"],
            "built": z.get("date", ""),
            "kind": "search",
            "path": "",
            "title": words[0],
            "q": words[0],
        }
    ]


def print_all():
    """Every situation's quotes in the data's order, for one printed set. No
    ZIM is read and nothing depends on the library."""
    d = data()
    q = quotes()["quotes"]
    out = []
    for g in d["groups"]:
        for sid in g["situations"]:
            out.append(
                {
                    "id": sid,
                    "quotes": [
                        dict(x, source=_source_view(x["source"], x))
                        for x in q.get(sid, [])
                    ],
                }
            )
    return {"situations": out, "disclaimer": DISCLAIMER}


# ── the guide with no server ────────────────────────────────────────────────

_offline_bytes = None


def offline_bundle():
    """Everything the page needs to run with no server: the matcher's tables
    (read from the same data as ``lookup`` and ``who``; static/
    fieldguide-offline.js reads them, and the tests hold the two to the same
    answers), the front, and each situation's quotes with the library left
    out. Public text, the same a visitor at the sign-in screen is shown."""
    d = data()
    return {
        "matcher": {
            "home": d["home"],
            "stop": d["stop"],
            "who": d.get("who", {}),
            "situations": {
                sid: {k: sit.get(k, {}) for k in ("keywords", "within", "ambiguous")}
                for sid, sit in d["situations"].items()
            },
        },
        "home": home(bare=True),
        "situations": {sid: situation_bare(sid) for sid in d["situations"]},
    }


def offline_bundle_bytes():
    """The bundle as served (static/fieldguide-offline.json), made once."""
    global _offline_bytes
    with _lock:
        built = _offline_bytes
    if built is None:
        built = json.dumps(offline_bundle(), ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        with _lock:
            _offline_bytes = built
    return built


# ── get the library ─────────────────────────────────────────────────────────


def library():
    """The ZIMs that fill the guide: each with its size from the catalog,
    whether it is installed and its download address; in sets (the core and
    what deepens it)."""
    d = data()
    have = installed_zims()
    sizes = _catalog_sizes()
    sets = []
    for s in d["library"]["sets"]:
        rows = []
        for pid in s["pieces"]:
            piece = d["pieces"][pid]
            row = {
                "piece": pid,
                "name": piece["name"],
                "note": piece.get("note", ""),
                "installed": pid in have,
            }
            if pid in have:
                row["zim"] = have[pid][0]["name"]
            m = _missing(pid, piece, sizes)
            if m and m.get("catalog"):
                row.update(
                    catalog=m["catalog"], size_bytes=m["size_bytes"], url=m["url"]
                )
            elif m:
                row.update(
                    build=m["build"], size_bytes=m["size_bytes"], source=m["source"]
                )
            rows.append(row)
        todo = [r for r in rows if not r["installed"] and r.get("url")]
        sets.append(
            {
                "id": s["id"],
                "pieces": rows,
                "missing": len(todo),
                "missing_bytes": sum(r["size_bytes"] for r in todo),
            }
        )
    return {"sets": sets}


def _reset_for_tests():
    global _catalog_kept, _have_kept
    with _lock:
        _resolved.clear()
        _have_kept = (None, {})
    _catalog_kept = (0.0, {})
    _set_manual(state="idle", done=0, message="")


# ── the field manual: a ZIM of the Army's public-domain manuals ─────────────

_COMMONS = "https://upload.wikimedia.org/wikipedia/commons/"
# Each manual's original, on the Army Publishing Directorate or Wikimedia
# Commons (works of the US Army, approved for public release), with the size
# and SHA-256 of the file as it was read when these addresses were checked: a
# file that is not that file is refused.
_ARMYPUBS = "https://armypubs.army.mil/epubs/DR_pubs/DR_a/"
MANUALS = (
    {
        "file": "ATP_4-02.11_Casualty_Response.pdf",
        "title": "ATP 4-02.11 Casualty Response",
        "date": "2026-03-23",
        "description": "Army Techniques Publication 4-02.11, 23 March 2026. Supersedes TC 4-02.1.",
        "url": _ARMYPUBS + "ARN46159-ATP_4-02.11-000-WEB-1.pdf",
        "bytes": 12665561,
        "sha256": "a4a0650f5bb14c1c7163b9b1e9f08bcc012fb3fe49ea4432f0ccaffb9af86542",
    },
    {
        "file": "TC_4-02.1_First_Aid.pdf",
        "title": "TC 4-02.1 First Aid",
        "date": "2018-12-07",
        "description": "Training Circular 4-02.1, January 2016, Change 2 of 7 December 2018.",
        "url": _COMMONS
        + "0/09/TC_4-02.1_First_Aid_%28Change_2%2C_ARN14135-TC_4-02.1-002-WEB-3%29.pdf",
        "bytes": 1627734,
        "sha256": "03a9505bd7fa1f5a13b2ea89b18d9ac1d0d2f9bdd50b0806eb1c692b19004791",
    },
    {
        "file": "FM_21-76_Survival.pdf",
        "title": "FM 21-76 Survival",
        "date": "1992-06-05",
        "description": "Field Manual 21-76, 5 June 1992.",
        "url": _COMMONS + "5/52/FM_21-76_Survival_June_1992.pdf",
        "bytes": 52401363,
        "sha256": "0a79b47f18a44206ea7830ea9dff740350786d2c0096e52f49a7291a3496469e",
    },
    {
        "file": "TC_3-21.76_Ranger_Handbook.pdf",
        "title": "TC 3-21.76 Ranger Handbook",
        "date": "2017-04-01",
        "description": "Training Circular 3-21.76, April 2017.",
        "url": _COMMONS + "9/92/TC_3-21.76_Ranger_Handbook_%282017%29.pdf",
        "bytes": 15319579,
        "sha256": "90d31edd58cc3fb8f01dfa2cb5cd49490f83b8a5d8e61f50fb34a4bab2af95bc",
    },
)
_DOWNLOAD_CHUNK = 256 * 1024
_DOWNLOAD_TIMEOUT_S = 60
_manual = {"state": "idle", "done": 0, "total": len(MANUALS), "message": ""}
_manual_lock = threading.Lock()


def manual_status():
    """{state: idle|running|done|error, done, total, message} of the build."""
    with _manual_lock:
        return dict(_manual)


def _set_manual(**kw):
    with _manual_lock:
        _manual.update(kw)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """The pinned addresses answer themselves: a redirect is a file that has
    moved, and the one expected is checked by its hash, not trusted by its
    path."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _fetch_pinned(url):
    """Open one of the manuals' pinned addresses: https, no redirects."""
    from zimi import creator

    if not url.startswith("https://"):
        raise creator.CreateError("a manual is fetched over https only")
    req = urllib.request.Request(url, headers={"User-Agent": creator.zimi_user_agent()})
    return urllib.request.build_opener(_NoRedirect).open(req, _DOWNLOAD_TIMEOUT_S)


def _download_manual(item, dest, fetch):
    """One manual into ``dest``, checked against its size and SHA-256."""
    import hashlib

    from zimi.creator import CreateError

    digest, n = hashlib.sha256(), 0
    try:
        with fetch(item["url"]) as resp, open(dest, "wb") as out:
            while True:
                chunk = resp.read(_DOWNLOAD_CHUNK)
                if not chunk:
                    break
                n += len(chunk)
                if n > item["bytes"]:
                    break
                digest.update(chunk)
                out.write(chunk)
    except urllib.error.HTTPError as e:
        if 300 <= e.code < 400:
            raise CreateError(
                "%s has moved: the address this build expects redirected"
                % item["title"]
            )
        raise CreateError("%s could not be fetched (HTTP %d)" % (item["title"], e.code))
    except OSError as e:
        if isinstance(e, urllib.error.URLError):
            raise CreateError(
                "%s could not be fetched: the network failed" % item["title"]
            )
        raise
    if n != item["bytes"] or digest.hexdigest() != item["sha256"]:
        raise CreateError("%s is not the file this build expects" % item["title"])


def build_field_manual(out_dir=None, progress=None, fetch=None, manuals=None):
    """Download the Army's manuals and package them as one ZIM with Create's
    folder mode (so it reads in the reader and the Bookshelf like any folder
    ZIM, and the Field Guide finds its manuals in it). Returns Create's
    summary. It runs as a Create job (zimi.manage, mode "fieldmanual"): one
    slot, a queue, a journal and a cancel at every line of ``progress``.
    ``fetch(url)`` opens an address (pinned, https, no redirects by default)."""
    import shutil
    import tempfile

    from zimi import creator, p2p

    if p2p.is_offline():
        raise creator.CreateError(
            "ZIMI_OFFLINE is set: nothing is fetched from the internet"
        )
    fetch = fetch or _fetch_pinned
    manuals = manuals or MANUALS
    say = progress or (lambda _t: None)
    _set_manual(state="running", done=0, total=len(manuals), message="")
    scratch = tempfile.mkdtemp(
        prefix=FIELD_MANUAL_NAME + "-", dir=creator.scratch_dir(out_dir)
    )
    folder = os.path.join(scratch, FIELD_MANUAL_NAME)
    os.makedirs(folder)
    try:
        for i, item in enumerate(manuals):
            say("Downloading %s" % item["title"])
            _set_manual(message="Downloading %s" % item["title"])
            _download_manual(item, os.path.join(folder, item["file"]), fetch)
            with open(
                os.path.join(folder, item["file"] + ".txt"), "w", encoding="utf-8"
            ) as f:
                f.write(
                    "title: %s\nauthor: Headquarters, Department of the Army\ndate: %s\ndescription: %s\n"
                    % (item["title"], item["date"], item["description"])
                )
            _set_manual(done=i + 1)
        say("Packaging")
        out = creator.create_folder_zim(
            folder,
            out_dir=out_dir or _srv.ZIM_DIR,
            title="Field manual",
            description="First aid, survival and the Ranger Handbook: public-domain manuals of the US Army.",
            language="eng",
            creator_name="Zimi",
            publisher="Zimi",
            tags="medicine;preppers;army",
            register=True,
            progress=say,
        )
        _set_manual(state="done", message="")
        return out
    except creator.CreateError as e:
        _set_manual(state="error", message=str(e))
        raise
    except Exception:
        log.exception("field manual build failed")
        _set_manual(
            state="error", message="The build failed. The server log has the details."
        )
        raise
    finally:
        shutil.rmtree(scratch, ignore_errors=True)


def installed_manual():
    """True when the field manual ZIM is in the library."""
    return "field_manual" in installed_zims()
