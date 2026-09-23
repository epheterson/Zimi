"""Reddot: subreddits as ZIMs, made and read by Zimi.

Two halves. The maker wraps ArcticZim (MIT, github.com/IMayBeABitShy/
ArcticZim), which builds a subreddit's posts and comments from Arctic
Shift's public archive into a ZIM: installed into a sidecar venv on first
use like warc2zim, then run as its own pipeline (retrieve posts, retrieve
comments, import, build) with every line of its output in the job log.
Eric, 2026-09-19: "We should add it with the ability to make great Reddit
Zims."

The reader owns the view over what ArcticZim writes: a subreddit's post
lists (``r/<sub>/top_page_N``, ``new_page_N``), a post page with its
comment tree (``r/<sub>/<id>/``), the list of subreddits. Same pattern as
ZimiExchange: the pages are parsed on demand and kept for the life of the
process; nothing is re-indexed.
"""

import html as _html
import json
from html.parser import HTMLParser
import logging
import os
import posixpath
import random
import re
import shutil
import sys
import threading
import time

from zimi import server as _srv
from zimi.creator import CreateError, _finish_output, _try_register
from zimi.importer import _run_capture, _run_stream, _venv_bin

log = logging.getLogger("zimi")

# A source archive, not a git URL: the Docker image has no git, and pip
# unpacks a zip on its own. Pinned to a commit rather than a branch name:
# the repository's branch is "master" (a "main" URL was a 404, and every
# subreddit build on the NAS died installing the sidecar), and a pin means
# the same ArcticZim on every machine until Zimi moves it on purpose.
ARCTICZIM_COMMIT = "8281389c2bc27d56702a2eecb3a568a0af3749b9"  # master, 2026-03-22
ARCTICZIM_REQUIREMENT = "arcticzim[integration,optimize] @ https://github.com/IMayBeABitShy/ArcticZim/archive/%s.zip" % ARCTICZIM_COMMIT
SUBREDDIT_RE = re.compile(r"^[A-Za-z0-9_]{2,21}$")
_MARKER = ".zimi-sidecar.json"
_MAX_PAGE_BYTES = 8 * 1024 * 1024
# ArcticZim's retrieve asks Arctic Shift for what comes after the last item
# it saw, and at the end of a subreddit the archive answers with that last
# item again, one per request, forever (r/kiwix: ~1,000 posts in 15 s, then
# one post a second for an hour at the same cursor). This many requests at
# one cursor means the end was reached.
STALL_REQUESTS = 8
_WORKER_DEATH = "Traceback (most recent call last)"
_PROGRESS_RE = re.compile(r"Time=(\S+), requests=(\d+)")
_PROGRESS_EVERY_S = 2.0


# ── the maker ──────────────────────────────────────────────────────────────


def sidecar_dir():
    return os.path.join(_srv.ZIMI_DATA_DIR, "tools", "arcticzim")


def _exe():
    return _venv_bin(sidecar_dir(), "arcticzim")


# ArcticZim is run through this launcher rather than its own console script.
# Its build configures each worker process with psutil, and it takes every
# system that is not Linux for Windows: on macOS the workers die asking for
# Windows priority constants and the creator waits for them forever. The
# launcher keeps the worker's name and skips the priorities where they
# would fail; on Linux it changes nothing. Guarded for multiprocessing,
# which imports the main module again in every worker.
_LAUNCHER_NAME = "zimi_arcticzim.py"
_LAUNCHER_SRC = """\
# Written by Zimi. ArcticZim's entry point, with one patch for macOS.
import sys

if sys.platform != "linux":
    import arcticzim.zimbuild.builder as _builder

    def _config_process(name, nice=0, ionice=0):
        try:
            import setproctitle

            setproctitle.setproctitle(name)
        except Exception:
            pass

    _builder.config_process = _config_process

if __name__ == "__main__":
    from arcticzim.cli import main

    sys.exit(main())
"""


def _launcher():
    """The launcher's path, written into the sidecar when it is not there
    yet (a sidecar installed by an earlier Zimi has none)."""
    path = os.path.join(sidecar_dir(), _LAUNCHER_NAME)
    try:
        with open(path, encoding="utf-8") as f:
            current = f.read() == _LAUNCHER_SRC
    except OSError:
        current = False
    if not current:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(_LAUNCHER_SRC)
    return path


def _cmd(*args):
    """An ArcticZim command line, through the launcher."""
    return [_venv_bin(sidecar_dir(), "python"), _launcher(), *args]


def sidecar_status():
    venv = sidecar_dir()
    installed = os.path.exists(_exe()) and os.path.exists(os.path.join(venv, _MARKER))
    return {"installed": installed, "dir": venv}


def _is_offline():
    from zimi import p2p

    return bool(p2p.is_offline())


def ensure_sidecar(sink=None):
    """The arcticzim console script, installing the sidecar venv on first
    use. Needs the internet once (it is a git install), and git."""
    say = sink or (lambda _line: None)
    venv = sidecar_dir()
    exe = _exe()
    if sidecar_status()["installed"]:
        return exe
    if _is_offline():
        raise CreateError(
            "the Reddit maker (ArcticZim) is not installed yet and offline mode is on. "
            "Install it once while connected: zimi create --setup-reddit"
        )
    if os.path.isdir(venv):
        shutil.rmtree(venv)
    os.makedirs(os.path.dirname(venv), exist_ok=True)
    say(f"creating the ArcticZim sidecar at {venv}")
    rc = _run_stream([sys.executable, "-m", "venv", venv], say)
    if rc == 0:
        rc = _run_stream([_venv_bin(venv, "python"), "-m", "pip", "install", "--upgrade", ARCTICZIM_REQUIREMENT], say)
    if rc != 0 or not os.path.exists(exe):
        shutil.rmtree(venv, ignore_errors=True)
        raise CreateError("ArcticZim sidecar install failed (the job log has pip's output). Nothing was left behind; re-run to try again.")
    with open(os.path.join(venv, _MARKER), "w", encoding="utf-8") as f:
        f.write('{"tool": "arcticzim"}\n')
    say("ArcticZim ready")
    return exe


def normalize_subreddit(text):
    """``r/Kiwix``, ``/r/kiwix/``, ``https://www.reddit.com/r/kiwix`` or
    ``kiwix`` → ``kiwix``; None when it is not a subreddit name."""
    t = (text or "").strip()
    m = re.search(r"(?:^|reddit\.com)/?r/([A-Za-z0-9_]+)/?$", t) or re.match(r"^r/([A-Za-z0-9_]+)/?$", t)
    if m:
        t = m.group(1)
    t = t.strip("/")
    return t if SUBREDDIT_RE.match(t) else None


def looks_like_subreddit(text):
    t = (text or "").strip()
    return bool(re.match(r"^(?:(?:https?://)?(?:www\.|old\.)?reddit\.com)?/?r/[A-Za-z0-9_]+/?$", t))


def _stall_watch():
    """A watcher for ``_run_stream``: True once the retrieve has sat at one
    cursor for STALL_REQUESTS requests, which is ArcticZim past the end."""
    state = {"time": None, "first": 0}

    def watch(line):
        m = _PROGRESS_RE.search(line)
        if not m:
            return False
        when, n = m.group(1), int(m.group(2))
        if when != state["time"]:
            state["time"], state["first"] = when, n
            return False
        return n - state["first"] >= STALL_REQUESTS

    return watch


def _worker_death_watch(line):
    """A watcher for the build: a traceback from a worker process. ArcticZim's
    creator then waits for that worker forever, so the job ends here, as a
    failure the log explains."""
    return "fail" if _WORKER_DEATH in line else False


_TQDM_RE = re.compile(r"^Retrieving (posts|comments): (\d+)\w* \[.*?Time=(\d{4}-\d{2}-\d{2})")


def _caption(line):
    """A tqdm redraw as a sentence: ``Retrieving posts: 1031posts [00:14,
    71.31posts/s, Time=2026-08-07T12:21:12, requests=4]`` becomes
    ``1,031 posts fetched, up to 2026-08-07``. Other lines pass as they are."""
    m = _TQDM_RE.match(line)
    if not m:
        return line
    return "%s %s fetched, up to %s" % (format(int(m.group(2)), ","), m.group(1), m.group(3))


def _throttled(say):
    """Progress lines at most every few seconds, as sentences; everything
    else at once. tqdm redraws ten times a second, and a job log is not a
    terminal."""
    last = [0.0]

    def sink(line):
        if line.startswith("Retrieving "):
            now = time.monotonic()
            if now - last[0] < _PROGRESS_EVERY_S:
                return
            last[0] = now
            line = _caption(line)
        say(line)

    return sink


def _dedupe_jsonl(path):
    """One line per id. The retrieve's tail repeats its last item, and
    ArcticZim's import keys posts and comments by id."""
    seen, kept = set(), []
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                try:
                    key = json.loads(line).get("id")
                except ValueError:
                    continue
                if key in seen:
                    continue
                seen.add(key)
                kept.append(line)
        with open(path, "w", encoding="utf-8") as f:
            f.writelines(kept)
    except OSError:
        pass
    return len(kept)


def create_reddit_zim(subreddit, *, title=None, out_dir=None, out_path=None, register=False, progress=None, stop=None):
    """Build one subreddit into a ZIM. Returns ``{"path", "name", "registered",
    "title"}``; raises CreateError with a sentence for the person."""
    say = progress or (lambda _line: None)
    sub = normalize_subreddit(subreddit)
    if not sub:
        raise CreateError("that is not a subreddit name (letters, digits and _ only, like r/kiwix)")
    ensure_sidecar(say)
    zim_name = f"reddit_{sub.lower()}"
    out = _finish_output(out_dir or _srv.ZIM_DIR, out_path, zim_name)
    work = os.path.join(_srv.ZIMI_DATA_DIR, "staging", f"reddot-{sub.lower()}-{int(time.time())}")
    os.makedirs(work, exist_ok=True)
    posts, comments, db = (os.path.join(work, n) for n in ("posts.jsonl", "comments.jsonl", "db.sqlite"))
    steps = [
        ("fetching posts of r/%s from Arctic Shift" % sub, _cmd("retrieve", "--subreddit", sub, "--sleep", "0.2", "posts", posts), posts, _stall_watch()),
        ("fetching comments", _cmd("retrieve", "--subreddit", sub, "--sleep", "0.2", "comments", comments), comments, _stall_watch()),
        ("importing", _cmd("import", "--posts-file", posts, "--comments-file", comments, "sqlite:///" + db), None, None),
        ("building the ZIM", _cmd("-v", "build", "sqlite:///" + db, out + ".part"), None, _worker_death_watch),
    ]
    try:
        for label, cmd, fetched, watch in steps:
            if stop is not None and getattr(stop, "hit", False):
                raise CreateError("stopped")
            say(label)
            rc = _run_stream(cmd, _throttled(say), watch=watch)
            if rc != 0:
                raise CreateError(f"ArcticZim failed while {label} (the job log has its output)")
            if fetched:
                say(f"{_dedupe_jsonl(fetched):,} {os.path.basename(fetched).split('.')[0]}")
        if not os.path.exists(out + ".part"):
            raise CreateError("ArcticZim finished without writing a ZIM")
        os.replace(out + ".part", out)
    finally:
        shutil.rmtree(work, ignore_errors=True)
        try:
            if os.path.exists(out + ".part"):
                os.remove(out + ".part")
        except OSError:
            pass
    registered = _try_register(out) if register else False
    say(f"ZIM written: {out}")
    return {"path": out, "name": zim_name, "registered": registered, "title": title or f"r/{sub}"}


# ── the reader ─────────────────────────────────────────────────────────────

_lock = threading.Lock()
_cache = {}

# ArcticZim writes minified pages: lowercase tags, attribute values without
# quotes (``class=postsummary data-post=1n5s13v``), paragraphs left open.
# The reader quotes the values first, once per page, so one set of patterns
# reads both that and a hand-written page.
_TAG_RE = re.compile(r"<[a-zA-Z][^<>]*>")
_UNQUOTED_RE = re.compile(r"(\s[a-zA-Z_:-]+)=([^\s\"'<>]+)")
_SUMMARY_SPLIT_RE = re.compile(r'<div class="postsummary"', re.I)
_ATTR_RE = re.compile(r'\b([a-zA-Z-]+)=(["\'])([^"\']*)\2')
_SCORE_RE = re.compile(r'class="postscore">(-?\d+)<', re.I)
_TITLE_RE = re.compile(r'<h1 class="posttitle"><a href="([^"]*)">(.*?)</a>', re.I | re.S)
_FLAIR_RE = re.compile(r'class="postflair"[^>]*>([^<]*)', re.I)
_META_RE = re.compile(r'class="postmeta">\s*Posted (.*?)\s*by <a class="authorlink"[^>]*>(.*?)</a>', re.I | re.S)
_PAGES_RE = re.compile(r'_page_(\d+)')
_SUBS_RE = re.compile(r'class="subredditinfo-link" href="[^"]*?r/([A-Za-z0-9_]+)/"', re.I)
_PAGE_TITLE_RE = re.compile(r"<title>(.*?)</title>", re.I | re.S)
_POSTBODY_RE = re.compile(r'<div class="postbodytext mdbody">(.*?)</div>', re.I | re.S)
_COMMENT_HEAD_RE = re.compile(r'<a class="authorlink"[^>]*>(.*?)</a>.*?<b>(-?\d+) points</b>\s*on ([^<]*)', re.I | re.S)
_COMMENT_LIST_RE = re.compile(r'<div class="commentlist"', re.I)
_COMMENT_BODY_RE = re.compile(r'<div class="commentbody mdbody">', re.I)
_SCRIPT_RE = re.compile(r"<script\b.*?</script>", re.S | re.I)
_URLATTR_RE = re.compile(r'\b(href|src)=(["\'])([^"\']*)\2', re.I)


def _quote_attrs(text):
    """Every attribute value in quotes. Only inside tags, so a ``--flag=value``
    in a post's own words is left alone."""
    return _TAG_RE.sub(lambda m: _UNQUOTED_RE.sub(r'\1="\2"', m.group(0)), text or "")


def _read(archive, path):
    try:
        entry = archive.get_entry_by_path(path)
        if entry.is_redirect:
            entry = entry.get_redirect_entry()
        item = entry.get_item()
        if item.size > _MAX_PAGE_BYTES:
            return None
        return _quote_attrs(bytes(item.content).decode("utf-8", "replace"))
    except Exception:
        return None


def _text(s):
    return _html.unescape(re.sub(r"<[^>]+>", "", s or "")).strip()


def _when(s):
    """ArcticZim's ``2025-09-01T08:39:03`` as a person reads it."""
    t = _text(s)
    return t[:16].replace("T", " ") if len(t) >= 16 and t[10:11] == "T" else t


def _rebase(fragment, page, zim):
    fragment = _SCRIPT_RE.sub("", fragment or "")
    base = posixpath.dirname(page.rstrip("/"))

    def fix(m):
        attr, quote, url = m.group(1), m.group(2), m.group(3)
        if not url or url.startswith(("#", "http://", "https://", "mailto:", "data:", "/w/", "javascript:")):
            return m.group(0)
        target = posixpath.normpath(posixpath.join(base, url)) if base else posixpath.normpath(url)
        target = target.lstrip("./")
        # ArcticZim's post pages end in a slash (r/<sub>/<id>/); normpath
        # eats it, and the ZIM knows the page by the slash.
        if url.endswith("/") and not target.endswith("/"):
            target += "/"
        return "%s=%s/w/%s/%s%s" % (attr, quote, _srv.url_quote(zim), target, quote)

    return _URLATTR_RE.sub(fix, fragment)


def rows_from_listing(text):
    """The posts on a listing page: id, subreddit, title, page, score,
    flair, author, date, external (a link post's URL)."""
    out = []
    for block in _SUMMARY_SPLIT_RE.split(_quote_attrs(text))[1:]:
        head = block[: block.find(">") + 1]
        attrs = {k.lower(): v for k, _, v in _ATTR_RE.findall(head)}
        pid, sub = attrs.get("data-post", ""), attrs.get("data-subreddit", "")
        if not pid:
            continue
        score = _SCORE_RE.search(block)
        title = _TITLE_RE.search(block)
        flair = _FLAIR_RE.search(block)
        meta = _META_RE.search(block)
        href = _html.unescape(title.group(1)) if title else ""
        local = f"r/{sub}/{pid}/"
        out.append(
            {
                "id": pid,
                "subreddit": sub,
                "title": _text(title.group(2)) if title else "",
                "page": local,
                "score": int(score.group(1)) if score else 0,
                "flair": _text(flair.group(1)) if flair else "",
                "author": _text(meta.group(2)) if meta else "",
                "date": _when(meta.group(1)) if meta else "",
                "external": "" if (not href or href.endswith(local) or "/r/" in href) else href,
            }
        )
    return out


def pages_in(text):
    nums = [int(n) for n in _PAGES_RE.findall(text or "")]
    return max(nums) if nums else 1


def subreddits_from_page(text):
    seen, out = set(), []
    for name in _SUBS_RE.findall(_quote_attrs(text)):
        if name not in seen:
            seen.add(name)
            out.append(name)
    return out


class _CommentTree(HTMLParser):
    """ArcticZim nests each reply's DIV inside its parent's, so the tree is
    the DIV nesting: a comment opens at some depth and every comment that
    opens before it closes is its child."""

    def __init__(self, page, zim):
        super().__init__(convert_charrefs=False)
        self.page, self.zim = page, zim
        self.depth = 0
        self.open = []  # [node, depth it opened at, start offset]
        self.roots = []
        self.positions = []  # (node, start, end) in source offsets

    def handle_starttag(self, tag, attrs):
        if tag.lower() != "div":
            return
        self.depth += 1
        a = dict(attrs)
        cls = a.get("class") or ""
        if cls.startswith("comment ") and (a.get("id") or "").startswith("comment-"):
            node = {"id": a["id"][8:], "author": "", "score": 0, "date": "", "body": "", "children": []}
            (self.open[-1][0]["children"] if self.open else self.roots).append(node)
            self.open.append([node, self.depth, self.getpos()])

    def handle_endtag(self, tag):
        if tag.lower() != "div":
            return
        if self.open and self.open[-1][1] == self.depth:
            node, _d, start = self.open.pop()
            self.positions.append((node, start, self.getpos()))
        self.depth -= 1


def _offset(text, pos):
    line, col = pos
    return sum(len(x) + 1 for x in text.split("\n")[: line - 1]) + col


def _parse_comments(text, page, zim):
    tree = _CommentTree(page, zim)
    try:
        tree.feed(text)
    except Exception:
        return []
    for node, start, end in tree.positions:
        chunk = text[_offset(text, start):_offset(text, end)]
        # This comment's own head and body come before any child's.
        first_child = _COMMENT_LIST_RE.search(chunk)
        own = chunk[: first_child.start()] if first_child and first_child.start() > 0 else chunk
        head = _COMMENT_HEAD_RE.search(own)
        # The body runs from its open tag to its own close: a stray close tag
        # carried into the page shut the parent early and flattened the tree.
        body_html = ""
        bm = _COMMENT_BODY_RE.search(own)
        if bm:
            rest = own[bm.end():]
            cut = re.search(r"</div>", rest, re.I)
            body_html = rest[: cut.start()] if cut else rest
        node["author"] = _text(head.group(1)) if head else ""
        node["score"] = int(head.group(2)) if head else 0
        node["date"] = _when(head.group(3)) if head else ""
        node["body"] = _rebase(body_html, page, zim)
    return tree.roots


def post_from_page(text, page, zim):
    if not text:
        return None
    text = _quote_attrs(text)
    t = _PAGE_TITLE_RE.search(text)
    body = _POSTBODY_RE.search(text)
    m = re.match(r"r/([^/]+)/([^/]+)/?", page)
    meta = _META_RE.search(text)
    score = _SCORE_RE.search(text)
    flair = _FLAIR_RE.search(text)
    return {
        "title": _text(t.group(1)) if t else "",
        "subreddit": m.group(1) if m else "",
        "id": m.group(2) if m else "",
        "score": int(score.group(1)) if score else 0,
        "author": _text(meta.group(2)) if meta else "",
        "date": _when(meta.group(1)) if meta else "",
        "flair": _text(flair.group(1)) if flair else "",
        "body": _rebase(body.group(1) if body else "", page, zim),
        "comments": _parse_comments(text, page, zim),
        "page": page,
    }


def _archive(name):
    from zimi.search import _get_fts_archive

    entry = next((z for z in (_srv._zim_list_cache or []) if z.get("name") == name), None)
    if not entry or entry.get("kind") != "reddit" or not _srv.zim_allowed(name):
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


def zims():
    out = []
    for z in _srv._zim_list_cache or []:
        if z.get("kind") == "reddit" and z.get("name") and _srv.zim_allowed(z["name"]):
            out.append({"name": z["name"], "title": z.get("title") or z["name"], "icon": bool(z.get("has_icon")), "subreddits": subreddits(z["name"]),
                        "date": z.get("date") or "", "size_bytes": z.get("size_bytes") or 0})
    out.sort(key=lambda s: s["title"].lower())
    return _claim_subreddits(out)


def _claim_subreddits(zims_):
    """A subreddit once: when two ZIMs carry it (a Zimi build beside an
    ArcticZim bundle, or last week's build beside today's), the newest
    build keeps it and the other ZIM's copy is not listed."""
    claimed = set()
    for z in sorted(zims_, key=_srv.build_rank, reverse=True):
        mine = [s for s in z["subreddits"] if s not in claimed]
        claimed.update(mine)
        z["subreddits"] = mine
    return zims_


# ArcticZim's listing pages end in a slash (``r/Kiwix/top_page_1/``), and
# the subreddit index is ``subreddits/``; the front page lists them too.
SUBREDDITS_PATHS = ("subreddits/", "subreddits", "index.html")


def _first_page(name, paths, parse):
    for path in paths:
        got = _cached_page(name, path, parse)
        if got:
            return got
    return None


def subreddits(name):
    return _first_page(name, SUBREDDITS_PATHS, subreddits_from_page) or []


def listing(name, sub, sort="top", page=1):
    sort = sort if sort in ("top", "new") else "top"
    base = f"r/{sub}/{sort}_page_{page}"
    got = _first_page(name, (base + "/", base), lambda t: {"rows": rows_from_listing(t), "pages": pages_in(t)} if rows_from_listing(t) else None)
    return got or {"rows": [], "pages": 0}


def post(name, page):
    # An agent may send "<zim>/r/sub/id/" (openzim/Zimi#54's glued form).
    from zimi.search import read_unglued

    return read_unglued(name, page, lambda p: _cached_page(name, p, lambda t: post_from_page(t, p, name)))


def random_post(rng=None):
    """Somewhere in the library's subreddits, for the dice: a subreddit by
    chance (every subreddit an even chance, whichever ZIM carries it), a
    page of its top posts by chance, a post on it by chance."""
    rng = rng or random
    pairs = [(z["name"], sub) for z in zims() for sub in z.get("subreddits") or []]
    if not pairs:
        return None
    for _ in range(4):
        name, sub = rng.choice(pairs)
        first = listing(name, sub, "top", 1)
        pages = max(1, int(first.get("pages") or 1))
        pg = rng.randint(1, pages)
        rows = (first["rows"] if pg == 1 else listing(name, sub, "top", pg)["rows"]) or first["rows"]
        rows = [r for r in rows if r.get("page")]
        if rows:
            r = rng.choice(rows)
            return {"zim": name, "page": r["page"], "title": r.get("title") or "", "subreddit": sub}
    return None


def home():
    out = []
    for z in zims():
        subs = []
        for sub in z["subreddits"][:12]:
            first = listing(z["name"], sub, "top", 1)
            subs.append({"subreddit": sub, "rows": first["rows"][:12], "pages": first["pages"]})
        out.append(dict(z, shelves=subs))
    return {"zims": out}


def _reset_for_tests():
    with _lock:
        _cache.clear()
