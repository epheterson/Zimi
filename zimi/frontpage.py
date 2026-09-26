"""A wiki's own front page, read into the things it featured.

mwoffliner keeps each wiki's Main Page as it was scraped, and the Main Page
is where a wiki puts what it is proud of that day: Wikipedia's featured
article, Did you know, the news and the picture of the day; Wiktionary's
word, Wikiquote's quote, Wikivoyage's destination, Wikibooks' book. Every
wiki lays its page out differently (an ``<h2>`` in Hebrew and Yiddish, a
coloured box title in French Wikiquote, a bold bar over a table in Hebrew
Wikibooks), so nothing here knows a wiki by name: the page is read as a
run of lines, a line that looks like a box's title names the box, and the
first line of real prose under it is what the box featured. A box of links
(portals, the other languages, the sister projects) has no such line and
gives nothing; so does the welcome, which talks about the wiki itself.

What comes back is what the wiki featured when the copy was made, and the
page says so with the copy's date: none of it is today's. A mini build
keeps only the start of every page, its front page included, and usually
gives nothing here.
"""

import re
from html.parser import HTMLParser
from urllib.parse import unquote

# Lines that start a new line of text.
_BLOCKS = {
    "p",
    "div",
    "li",
    "td",
    "th",
    "tr",
    "table",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "dd",
    "dt",
    "dl",
    "blockquote",
    "section",
    "center",
    "ul",
    "ol",
    "figure",
    "figcaption",
    "caption",
    "hr",
}
_VOID = {"img", "br", "meta", "hr", "input", "link", "source", "wbr", "col", "area"}
_SKIP = {"style", "script", "noscript"}
# What marks a line as a box's title: a heading, a title class, or a bold
# style on the element or just above it.
_TITLE_CLASS_RE = re.compile(
    r"(?:^|[\s_-])(?:titre|title|heading|header|kop)(?:$|[\s_-])", re.I
)
_BOLD_STYLE_RE = re.compile(r"font-weight\s*:\s*(?:bold|[6-9]00)", re.I)
_BG_STYLE_RE = re.compile(r"background(?:-color)?\s*:\s*#?[0-9a-z]", re.I)
_TITLE_LEVELS = 3
_LABEL_MAX = 40
_TEXT_MIN = 40
_TEXT_CAP = 300
_LINK_SHARE_MAX = 0.7
ITEMS_MAX = 6
# A dated line (1914 – ...): the front page's own On this day, which was
# the scrape's day, not this one.
# Hebrew and Yiddish front pages date theirs in the Hebrew calendar (ה'תרפ"ט).
_DATED_RE = re.compile(r"^\s*(?:\d{1,4}|ה'ת\S*)\s*[–—:\-]")
# A line about the wiki itself (the welcome, how to take part, the sister
# projects), in the scripts the wikis write their own names in; Hebrew and
# Yiddish glue a prefix to the name, so it is matched anywhere in a word.
_ABOUT_WIKI_RE = re.compile(
    r"wiki|wikt|ויקי|וויקי|װיקי|ویکی|вики|维基|維基|ウィキ|위키|विकि", re.I
)
# A line of separated words (a list of portals, of subjects): links in a
# ZIM that holds none of their pages, so they read as plain text.
_LIST_SEP_RE = re.compile(r"\s[-–•·|]\s")
_LIST_PARTS, _LIST_PART_LEN = 4, 25


class _Lines(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack = []  # (tag, attrs dict)
        self.lines = []
        self.skip = 0
        self.link = None
        self.bold = 0
        self._new()

    def _new(self):
        if getattr(self, "cur", None) and self.cur["text"].strip():
            self.lines.append(self.cur)
        self.cur = {"text": "", "title": None, "links": [], "imgs": [], "bold": ""}

    def _titled(self):
        for i, (tag, a) in enumerate(reversed(self.stack)):
            if tag in ("h2", "h3", "h4"):
                return True
            if i > _TITLE_LEVELS:
                break
            if _TITLE_CLASS_RE.search(a.get("class") or ""):
                return True
            style = a.get("style") or ""
            if _BOLD_STYLE_RE.search(style):
                return True
            if _BG_STYLE_RE.search(style) and self.bold:
                return True
        return False

    def handle_starttag(self, tag, attrs):
        a = dict((k, v or "") for k, v in attrs)
        if tag in _SKIP:
            if tag not in _VOID:
                self.skip += 1
            return
        if tag in _BLOCKS:
            self._new()
        if tag == "br":
            self.cur["text"] += " "
        if tag == "img" and not self.skip:
            self.cur["imgs"].append(a.get("src") or "")
        if tag == "a" and not self.skip:
            self.link = {
                "href": a.get("href") or "",
                "foreign": _foreign(a),
                "text": "",
                "bold": bool(self.bold),
            }
            self.cur["links"].append(self.link)
        if tag in ("b", "strong"):
            self.bold += 1
        if tag not in _VOID:
            self.stack.append((tag, a))

    def handle_endtag(self, tag):
        if tag in _SKIP:
            self.skip = max(0, self.skip - 1)
            return
        if tag in _VOID:
            return
        if not any(t == tag for t, _ in self.stack):
            return
        while self.stack:
            t, _a = self.stack.pop()
            if t in ("b", "strong"):
                self.bold = max(0, self.bold - 1)
            if t == "a":
                self.link = None
            if t == tag:
                break
        if tag in _BLOCKS:
            self._new()

    def handle_data(self, data):
        if self.skip:
            return
        if not data.strip():
            self.cur["text"] += " " if data else ""
            return
        if self.cur["title"] is None:
            self.cur["title"] = self._titled()
        self.cur["text"] += data
        if self.link is not None:
            self.link["text"] += data
        if self.bold and not self.cur["bold"]:
            self.cur["bold"] = data.strip()

    def close(self):
        super().close()
        self._new()


def _foreign(a):
    cls = (a.get("class") or "") + " " + (a.get("rel") or "")
    return bool(re.search(r"\b(?:extiw|external|new|Interwiki)\b", cls))


def _norm(s):
    return re.sub(r"\s+", " ", re.sub(r"\[\s*\d+\s*\]", "", s or "")).strip()


def _internal(link):
    """A link's ZIM path when it names an article of this wiki, else ""."""
    return "" if link["foreign"] else internal_path(link["href"])


def internal_path(href):
    """An href as a ZIM path, "" for one that leaves the ZIM."""
    if not href or href.startswith(("#", "http:", "https:", "//", "mailto:", "data:")):
        return ""
    path = unquote(href.split("#")[0].split("?")[0])
    path = re.sub(r"^(?:\./|\.\./)+", "", path)
    path = re.sub(r"^(?:A/|/wiki/|/)", "", path)
    return path


def _namespaced(path):
    return ":" in path


def _is_list(text):
    parts = _LIST_SEP_RE.split(text)
    return len(parts) >= _LIST_PARTS and len(text) / len(parts) < _LIST_PART_LEN


def highlights(page_html):
    """The boxes of a front page and what each featured: ``[{label, text,
    link, img}]`` in the page's order, one per box, at most ITEMS_MAX.
    ``link`` is the article the box is about (its first bold link, else its
    first link), "" when it names none; ``img`` the first picture in the
    box, as the page wrote it; ``bold`` the box's first words in bold (the
    word, the book, the person)."""
    m = re.search(r'<div[^>]*id=["\']mw-content-text["\']', page_html or "")
    body = (page_html or "")[m.start() if m else 0 :]
    body = re.sub(r"<!--.*?-->", "", body, flags=re.DOTALL)
    p = _Lines()
    try:
        p.feed(body)
        p.close()
    except Exception:
        return []
    out, labels, texts = [], set(), set()
    label, taken, box = None, True, []
    for line in p.lines:
        text = _norm(line["text"])
        # A title names a box; one that calls out ("Visitez le Salon !") is
        # an invitation, not a box's name.
        titled = line["title"] and not text.endswith(("!", "！"))
        if titled and 2 <= len(text) <= _LABEL_MAX:
            label, taken, box = text.rstrip(":：").strip(), False, [line]
            continue
        box.append(line)
        if taken or label is None or len(text) < _TEXT_MIN:
            continue
        links = [(k, _internal(k)) for k in line["links"]]
        if any(_namespaced(path) for _k, path in links if path):
            continue
        linked = sum(len(_norm(k["text"])) for k in line["links"])
        if linked > _LINK_SHARE_MAX * len(text) or _DATED_RE.match(text):
            continue
        if (
            text.endswith((":", "：", "...)", "…)"))
            or _is_list(text)
            or _ABOUT_WIKI_RE.search(text + " " + label)
        ):
            continue
        taken = True
        key = label.lower()
        if key in labels or text[:80] in texts:
            continue
        labels.add(key)
        texts.add(text[:80])
        near = [
            (k, path)
            for ln in box
            for k, path in ((k, _internal(k)) for k in ln["links"])
            if path and not _namespaced(path)
        ]
        own = [(k, path) for k, path in links if path]
        link = (
            next((path for k, path in own if k["bold"]), "")
            or next((path for k, path in near if k["bold"]), "")
            # A box whose subject is in bold but not a link (the featured
            # article named, its first link a word in its first sentence)
            # is about its bold words, not about that word.
            or (
                ""
                if line["bold"] or any(ln["bold"] for ln in box[1:])
                else (own[0][1] if own else "")
            )
        )
        img = next(
            (
                s
                for ln in box
                for s in ln["imgs"]
                if s and not s.startswith("data:") and ".svg" not in s.lower()
            ),
            "",
        )
        bold = next((_norm(ln["bold"]) for ln in box[1:] if ln["bold"]), "")
        cap = (
            text if len(text) <= _TEXT_CAP else text[:_TEXT_CAP].rsplit(" ", 1)[0] + "…"
        )
        out.append(
            {"label": label, "text": cap, "link": link, "img": img, "bold": bold}
        )
        if len(out) >= ITEMS_MAX:
            break
    return out
