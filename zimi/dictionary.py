"""Dictionary: one word across every Wiktionary in the library.

Eric, 2026-09-28: "done really well might be nice, especially if it's like a
nice down the wormhole experience." 2026-10-01: "seeing the same word in all
is nice. Can it speak the word!? Properly!?"

A Wiktionary page is one word in every language that has it: a heading per
language (English Wiktionary's "French", French Wiktionary's "Français"),
and under it the word's etymology, pronunciation, parts of speech with
their senses, and the words around it (synonyms, derived terms,
translations). Every Wiktionary is built by mwoffliner, and the builds
differ only in their wrapping (``<details><summary>`` in 2024, a
``div.mw-heading`` in 2026, Parsoid's ``<section>``), so the page is read as
a flat run of headings and blocks whatever wraps them, and every heading is
classified by what is under it rather than by the edition's words alone: a
heading with a numbered list of senses is a part of speech in any language.

The language a word is in comes from the page's own markup: the headword
carries ``lang="fr"``, French Wiktionary's language heading carries its code.
So the same word from English and French Wiktionary lands in one group, the
French word, whichever Wiktionary said it.

What Wiktionary ZIMs carry for sound: the IPA, and the labels of the
recordings ("Audio (US)"), but not the recordings. Kiwix's
wiktionary_en_all_maxi_2024-05 has 8.2 million entries and not one audio
file (its Counter lists none; the audio cell of every table is an empty
span). A recording the ZIM does hold (another build, another scraper) is
offered; the rest is the browser's voice (dictionary.html), chosen by the
word's language.

Pages are read on demand, under the library lock one entry at a time, and
parsed outside it; the parsed page is kept (by ZIM, its build and path), so
a word visited again costs nothing.
"""

import collections
import html as _html
import logging
import posixpath
import random
import re
import threading
from urllib.parse import unquote

from zimi import server as _srv
from zimi import wikilang

log = logging.getLogger("zimi")

PROJECT = "wiktionary"
# Kept parsed pages, the most recently used last.
_CACHE_MAX = 256
# The words a list of synonyms, derived terms or rhymes gives, at most: a
# derived-terms list on English Wiktionary's "water" names over a thousand.
WORDS_MAX = 200
SENSES_MAX = 40
EXAMPLES_MAX = 3
EXAMPLE_CHARS = 400
ETY_CHARS = 1600
SUGGEST_MAX = 12
SUGGEST_PER_ZIM = 8
# A page bigger than this is read as far as this: English Wiktionary's
# "a" is 2.6 MB, and its first megabytes hold the languages read first.
PAGE_MAX = 3 * 1024 * 1024

_lock = threading.Lock()
_cache = collections.OrderedDict()  # (zim, build date, path) -> parsed page

# ── what a heading is ──────────────────────────────────────────────────────
#
# By its words, in the editions Zimi meets. A heading not named here is a
# part of speech when a numbered list of senses follows it, and otherwise a
# list of words under its own name (Hypernyms, Descendants, Anagrammes).

_KINDS = {
    "etymology": (
        "etymology",
        "étymologie",
        "etimoloġija",
        "etimologija",
        "etimología",
        "etimologia",
        "herkunft",
        "этимология",
        "語源",
        "词源",
        "詞源",
        "原語",
    ),
    "pronunciation": (
        "pronunciation",
        "prononciation",
        "pronunzja",
        "izgovor",
        "pronunciación",
        "pronúncia",
        "pronuncia",
        "aussprache",
        "произношение",
        "發音",
        "发音",
        "読み",
    ),
    "translations": (
        "translations",
        "traductions",
        "traduzzjonijiet",
        "prijevodi",
        "prijevod",
        "traducciones",
        "traduções",
        "tradução",
        "traduzioni",
        "übersetzungen",
        "перевод",
        "翻譯",
        "翻译",
    ),
    "synonyms": (
        "synonyms",
        "synonymes",
        "sinonimi",
        "sinónimos",
        "sinônimos",
        "synonyme",
        "синонимы",
    ),
    "antonyms": (
        "antonyms",
        "antonymes",
        "antonimi",
        "antónimos",
        "antônimos",
        "gegenwörter",
        "антонимы",
    ),
    "derived": (
        "derived terms",
        "dérivés",
        "derivati",
        "derivados",
        "abgeleitete begriffe",
        "compounds",
    ),
    "related": (
        "related terms",
        "related words",
        "apparentés étymologiques",
        "vocabulaire apparenté par le sens",
        "termini relatati",
        "términos relacionados",
    ),
    "homophones": ("homophones",),
}
# Read for nothing: lists of sources, tables of forms, notes for editors.
_SKIP = (
    "references",
    "further reading",
    "références",
    "sources",
    "bibliographie",
    "external links",
    "notes",
    "usage notes",
    "inflection",
    "declension",
    "conjugation",
    "conjugaison",
    "flexion",
    "mutation",
    "statistics",
    "quotations",
    "gallery",
    "see also",
    "voir aussi",
    "referenzen",
)
_HEADING_TAGS = ("h2", "h3", "h4", "h5", "h6")
# Inside a block, nothing of these is read.
_DROP_TAGS = (
    "style",
    "script",
    "sup",
    "audio",
    "video",
    "img",
    "figure",
    "math",
    "noscript",
)
_DROP_CLASSES = (
    "mw-editsection",
    "reference",
    "tpos",
    "trreq",
    "zim-footer",
    "audiotable",
    "audio-pronunciation",
    "thumb",
    "trad-exposant",
    "noprint",
    "maintenance-line",
)
# A link to a page that is not a word: help, categories, the wiki's own
# pages. English Wiktionary's reconstructions are words of their own.
_NOT_WORDS_RE = re.compile(
    r"^(?:wiktionary|wiktionnaire|wikizzjunarju|vikirječnik|appendix|annexe|aide|help|"
    r"category|catégorie|kategorija|file|fichier|image|template|modèle|portal|portail|"
    r"rhymes|rimes|special|spécial|user|utilisateur|talk|discussion|index|thésaurus|thesaurus|"
    r"wikisaurus|citations|module|mediawiki|w|wikipedia)\s*:",
    re.IGNORECASE,
)
_AUDIO_EXT_RE = re.compile(r"\.(?:ogg|oga|opus|mp3|wav|flac|m4a|webm)$", re.IGNORECASE)
_ACCENT_RE = re.compile(r"^\s*\(([^()]{1,80})\)")
_AUDIO_LABEL_RE = re.compile(r"\(([^()]{1,80})\)")
_SPACES_RE = re.compile(r"\s+")
# What an edition writes where it has nothing yet: French Wiktionary's
# "Étymologie manquante ou incomplète", its "\\Prononciation ?\\".
_PLACEHOLDER_RE = re.compile(r"manquante ou incomplète|région à préciser|^\\?Prononciation \?\\?$|missing or incomplete", re.I)
# The name of the language a page's own wiki writes in, as its heading says
# it, for the small Wiktionaries whose words carry no code.
_SELF_NAMES = {
    "mt": ("malti",),
    "tn": ("setswana",),
    "bs": ("bosanski", "bosanski jezik"),
    "hif": ("fiji hindi", "fiji baat"),
}


def _kind(text):
    t = _SPACES_RE.sub(" ", text).strip().lower()
    t = re.sub(r"\s*\d+$", "", t)  # "Etymology 2"
    for kind, words in _KINDS.items():
        if t in words:
            return kind
    if t in _SKIP:
        return "skip"
    return ""


# ── a page, as a tree ──────────────────────────────────────────────────────

_VOID = frozenset(
    (
        "area",
        "base",
        "br",
        "col",
        "embed",
        "hr",
        "img",
        "input",
        "link",
        "meta",
        "source",
        "track",
        "wbr",
    )
)


class Node:
    __slots__ = ("tag", "attrs", "kids", "parent", "_has_h")

    def __init__(self, tag, attrs=None, parent=None):
        self.tag = tag
        self.attrs = attrs or {}
        self.kids = []
        self.parent = parent
        self._has_h = None

    def cls(self):
        return self.attrs.get("class") or ""

    def has_class(self, name):
        return name in self.cls().split()

    def iter(self):
        """Every element under this one, in document order."""
        for k in self.kids:
            if isinstance(k, Node):
                yield k
                yield from k.iter()

    def find(self, pred):
        return next((n for n in self.iter() if pred(n)), None)

    def has_heading(self):
        if self._has_h is None:
            self._has_h = any(
                isinstance(k, Node) and (k.tag in _HEADING_TAGS or k.has_heading())
                for k in self.kids
            )
        return self._has_h


# A tag or a run of text. The standard library's HTMLParser read English
# Wiktionary's "water" (15,000 tags) in 0.6 s; this reads it in a fraction of
# that. Only what the reading needs is kept: no comments, no <style> or
# <script> bodies, and of the attributes only the ones looked at.
_TOKEN_RE = re.compile(
    r"<!--.*?-->|<(style|script)\b[^>]*>.*?</\1\s*>"
    r"|<(/?)([a-zA-Z][\w:-]*)((?:[^>\"']|\"[^\"]*\"|'[^']*')*)>|([^<]+|<)",
    re.S | re.I,
)
_ATTR_RE = re.compile(r"([\w:-]+)\s*=\s*(\"[^\"]*\"|'[^']*'|[^\s>]+)")
_KEPT_ATTRS = frozenset(("class", "lang", "href", "id", "src", "data-gloss"))


def _attrs(raw):
    out = {}
    if not raw:
        return out
    for m in _ATTR_RE.finditer(raw):
        k = m.group(1).lower()
        if k in _KEPT_ATTRS:
            v = m.group(2)
            if v[:1] in "\"'":
                v = v[1:-1]
            out[k] = _html.unescape(v) if "&" in v else v
    return out


def parse_tree(html_text):
    """A page as a tree of Nodes, forgiving as a browser is: an end tag
    closes back to its element, a stray one is passed over."""
    root = Node("#root")
    cur = root
    for m in _TOKEN_RE.finditer(html_text):
        text = m.group(5)
        if text is not None:
            cur.kids.append(_html.unescape(text) if "&" in text else text)
            continue
        tag = m.group(3)
        if not tag:
            continue  # a comment, a style or a script
        tag = tag.lower()
        if m.group(2):
            n = cur
            while n is not root and n.tag != tag:
                n = n.parent
            if n is not root:
                cur = n.parent
            continue
        raw = m.group(4)
        node = Node(tag, _attrs(raw), cur)
        cur.kids.append(node)
        if tag not in _VOID and not raw.rstrip().endswith("/"):
            cur = node
    return root



def _content_root(root):
    return (
        root.find(lambda n: n.tag == "div" and n.has_class("mw-parser-output"))
        or root.find(lambda n: n.tag == "body")
        or root
    )


def _flat(node):
    """The page as a flat run: ("h", level, heading) and ("b", block), whatever
    wraps them (a <section>, a <details>, a div.mw-heading): a container
    with a heading inside is opened, anything else is a block."""
    for k in node.kids:
        if not isinstance(k, Node):
            continue
        if k.tag in _HEADING_TAGS:
            yield ("h", int(k.tag[1]), k)
        elif k.has_heading():
            yield from _flat(k)
        elif k.tag not in _DROP_TAGS and not _dropped(k):
            yield ("b", k)


def _dropped(n):
    c = n.cls()
    return bool(c) and any(d in c.split() for d in _DROP_CLASSES)


def text_of(node, skip=()):
    """The words of a node, its spaces collapsed."""
    out = []

    def walk(n):
        for k in n.kids:
            if isinstance(k, Node):
                if k.tag in _DROP_TAGS or k.tag in skip or _dropped(k):
                    continue
                if k.tag == "br":
                    out.append(" ")
                walk(k)
            else:
                out.append(k)

    walk(node)
    return _SPACES_RE.sub(" ", "".join(out)).strip()


# ── links ──────────────────────────────────────────────────────────────────


def _page_dir(path):
    return posixpath.dirname(path)


def link_target(href, page_path):
    """A word a link leads to inside the ZIM, as ``word`` or ``word#Section``,
    or "" for a link that leaves the ZIM or goes to a page that is not a word.
    Resolved against the page's own path: English Wiktionary's translation
    pages (water/translations) link to "../noqá#Aari", a 2024 build's pages
    (A/water) to "liquid", which is A/liquid."""
    if not href or href.startswith(("http:", "https:", "//", "mailto:", "javascript:")):
        return ""
    frag = ""
    if "#" in href:
        href, frag = href.split("#", 1)
    if not href:
        word = _word_of_path(page_path)
    else:
        p = posixpath.normpath(posixpath.join(_page_dir(page_path), unquote(href)))
        if p.startswith(".."):
            return ""
        word = _word_of_path(p)
    if not word or _NOT_WORDS_RE.match(word):
        return ""
    frag = unquote(frag).replace("_", " ")
    return word + ("#" + frag if frag else "")


def _word_of_path(path):
    """A page's word from its path: the old A/ namespace off, underscores
    as the spaces they are."""
    if path.startswith("A/"):
        path = path[2:]
    return path.replace("_", " ").strip()


def segments(node, page_path, skip=()):
    """A node's text as a run the page draws: strings, and ``[text, word]``
    for each word it links to. Nothing of the page's markup is passed on."""
    out = []

    def add(text, target=""):
        if not text:
            return
        if target:
            out.append([text, target])
        elif out and isinstance(out[-1], str):
            out[-1] += text
        else:
            out.append(text)

    def walk(n):
        for k in n.kids:
            if isinstance(k, Node):
                if k.tag in _DROP_TAGS or k.tag in skip or _dropped(k):
                    continue
                if k.tag == "br":
                    add(" ")
                    continue
                if k.tag == "a":
                    t = text_of(k)
                    add(t, link_target(k.attrs.get("href", ""), page_path))
                    continue
                walk(k)
            else:
                add(k)

    walk(node)
    # Spaces collapsed across the run, its ends trimmed.
    clean = []
    for s in out:
        if isinstance(s, str):
            s = _SPACES_RE.sub(" ", s)
            if s:
                clean.append(s)
        else:
            clean.append([_SPACES_RE.sub(" ", s[0]).strip(), s[1]])
    if clean and isinstance(clean[0], str):
        clean[0] = clean[0].lstrip()
    if clean and isinstance(clean[-1], str):
        clean[-1] = clean[-1].rstrip()
    return [s for s in clean if s and (not isinstance(s, list) or s[0])]


def _plain(segs):
    return "".join(s if isinstance(s, str) else s[0] for s in segs)


def _cap_segments(segs, limit):
    out, n = [], 0
    for s in segs:
        t = s if isinstance(s, str) else s[0]
        if n + len(t) > limit:
            room = limit - n
            if room > 20:
                out.append(t[:room].rsplit(" ", 1)[0] + "…")
            break
        out.append(s)
        n += len(t)
    return out


# ── the parts of an entry ──────────────────────────────────────────────────


def _code_of(node):
    """A language code a node says it is in ("fr", "ar"), its script and
    region off ("ar-Latn" is a transliteration, not Arabic)."""
    lang = (node.attrs.get("lang") or "").strip()
    if (
        not lang
        or lang.endswith("-Latn")
        and lang.count("-") == 1
        and lang != "sh-Latn"
    ):
        return ""
    return lang.lower()


def _words_in(node, page_path, limit=WORDS_MAX):
    """The words a block lists, once each: every link to a word, as
    ``{"w": text, "t": target}``."""
    out, seen = [], set()
    for a in node.iter():
        if a.tag != "a" or _inside_dropped(a, node):
            continue
        target = link_target(a.attrs.get("href", ""), page_path)
        text = text_of(a)
        if not target or not text or text in seen:
            continue
        seen.add(text)
        out.append({"w": text, "t": target})
        if len(out) >= limit:
            break
    return out


def _inside_dropped(n, top):
    p = n.parent
    while p is not None and p is not top:
        if p.tag in _DROP_TAGS or _dropped(p):
            return True
        p = p.parent
    return False


def _accent(text):
    """The accent a line of pronunciation names: in front, as English
    Wiktionary writes it ("(Received Pronunciation) IPA: ..."), or after the
    IPA, as French Wiktionary does ("\\ˈwɔː.tə\\ (Royaume-Uni)")."""
    m = _ACCENT_RE.match(text) or _AUDIO_LABEL_RE.search(text)
    return m.group(1).strip() if m else ""


def _unparen(text):
    """"(Région à préciser)" as the words inside its brackets."""
    t = text.strip()
    return t[1:-1].strip() if t.startswith("(") and t.endswith(")") else t


def _own_text(li):
    """A list item's words without the lists nested in it."""
    return text_of(li, skip=("ul", "ol", "dl"))


def parse_pronunciation(blocks, page_path, archive_has=None):
    """IPA by accent, recordings the ZIM holds, rhymes, homophones and
    hyphenation, from a pronunciation section's blocks.

    ``archive_has(path)`` says whether the ZIM holds an entry; without it no
    recording is offered (a page parsed without its ZIM cannot know)."""
    out = {
        "ipa": [],
        "audio": [],
        "rhymes": [],
        "rhymes_page": "",
        "homophones": [],
        "hyphenation": "",
    }
    seen_ipa = set()
    for block in blocks:
        for li in (
            [block] if block.tag == "li" else [n for n in block.iter() if n.tag == "li"]
        ):
            own = _own_text(li)
            low = own.lower()
            region = li.find(lambda n: n.has_class("audio-region"))
            accent = (
                _accent(own)
                or (_unparen(text_of(region)) if region is not None else "")
                or _inherited_accent(li)
            )
            if _PLACEHOLDER_RE.search(accent):
                accent = ""
            ipas = [
                text_of(n)
                for n in li.iter()
                if n.tag in ("span", "bdi")
                and ({"IPA", "API"} & set(n.cls().split()))
                and _owner_li(n) is li
            ]
            if low.startswith(("rhymes", "rime", "rimi", "rima")):
                out["rhymes"].extend(i for i in ipas if i)
                for a in li.iter():
                    if a.tag == "a":
                        href = unquote(a.attrs.get("href", "").split("#")[0])
                        p = (
                            posixpath.normpath(
                                posixpath.join(_page_dir(page_path), href)
                            )
                            if href
                            else ""
                        )
                        if re.match(r"^(?:A/)?(?:Rhymes|Rimes):", p):
                            out["rhymes_page"] = p
                continue
            if low.startswith(("hyphenation", "syllabification", "césure")):
                out["hyphenation"] = own.split(":", 1)[-1].strip()
                continue
            hom = li.find(lambda n: n.has_class("homophones"))
            if hom is not None or low.startswith("homophone"):
                out["homophones"].extend(_words_in(hom or li, page_path))
                continue
            ipas = [
                i for i in ipas if i and not i.startswith("-") and i not in seen_ipa
            ]
            if ipas:
                seen_ipa.update(ipas)
                out["ipa"].append({"accent": accent, "ipa": ipas})
    # Recordings: a table of them (English), a span per region (French).
    for block in blocks:
        for holder in [
            n
            for n in [block, *block.iter()]
            if n.has_class("audiotable") or n.has_class("audio-pronunciation")
        ]:
            label = _audio_label(holder)
            for src in _audio_sources(holder):
                path = _resolve(src, page_path)
                if path and archive_has and archive_has(path):
                    out["audio"].append(
                        {
                            "label": label,
                            "accent": _accent_of_label(label),
                            "path": path,
                        }
                    )
                    break
    return out


def _owner_li(n):
    p = n.parent
    while p is not None and p.tag != "li":
        p = p.parent
    return p


def _inherited_accent(li):
    """Simple English writes the accent once, "(UK)", over a list of its
    IPA and SAMPA."""
    p = li.parent
    while p is not None:
        if p.tag == "li":
            a = _accent(_own_text(p))
            if a:
                return a
        p = p.parent
    return ""


def _audio_label(holder):
    region = holder.find(lambda n: n.has_class("audio-region"))
    if region is not None:
        return _unparen(text_of(region))
    cell = holder.find(lambda n: n.tag == "td")
    return (text_of(cell) if cell is not None else text_of(holder)).rstrip(": ").strip()


def _accent_of_label(label):
    m = _AUDIO_LABEL_RE.search(label or "")
    return (
        m.group(1).strip()
        if m
        else ("" if (label or "").lower().startswith("audio") else (label or ""))
    )


def _audio_sources(holder):
    for n in [holder, *holder.iter()]:
        if n.tag == "source" and n.attrs.get("src"):
            yield n.attrs["src"]
        elif n.tag == "a" and _AUDIO_EXT_RE.search(
            n.attrs.get("href", "").split("?")[0]
        ):
            yield n.attrs["href"]
        elif n.tag == "audio" and n.attrs.get("src"):
            yield n.attrs["src"]


def _resolve(src, page_path):
    if not src or src.startswith(("http:", "https:", "//", "data:")):
        return ""
    src = unquote(src.split("?")[0].split("#")[0])
    p = posixpath.normpath(posixpath.join(_page_dir(page_path), src))
    return "" if p.startswith("..") else p


def parse_senses(ol, page_path, depth=0):
    """A numbered list of senses: each its definition, its examples, the
    synonyms and antonyms it names, and its own numbered senses."""
    out = []
    for li in ol.kids:
        if not isinstance(li, Node) or li.tag != "li":
            continue
        d = segments(li, page_path, skip=("ol", "ul", "dl"))
        sense = {"d": d}
        ex, nyms = [], {}
        for k in li.kids:
            if not isinstance(k, Node):
                continue
            if k.tag == "dl":
                for dd in k.kids:
                    if isinstance(dd, Node) and dd.tag == "dd":
                        _sense_extra(dd, page_path, ex, nyms)
            elif k.tag == "ul":
                for item in k.kids:
                    if isinstance(item, Node) and item.tag == "li":
                        _sense_extra(item, page_path, ex, nyms, ul_class=k.cls())
            elif k.tag == "ol" and depth < 2:
                sub = parse_senses(k, page_path, depth + 1)
                if sub:
                    sense["sub"] = sub
        # Inline nyms some editions put inside the definition's own line.
        for n in li.iter():
            if n.tag == "span" and "nyms" in n.cls().split() and _owner_li(n) is li:
                _nyms_into(n, page_path, nyms)
        if ex:
            sense["ex"] = ex[:EXAMPLES_MAX]
        for k, v in nyms.items():
            if v:
                sense[k] = v
        if _plain(d).strip() or sense.get("sub"):
            out.append(sense)
        if len(out) >= SENSES_MAX:
            break
    return out


def _nyms_into(node, page_path, nyms):
    c = node.cls()
    kind = "syn" if "synonym" in c else "ant" if "antonym" in c else ""
    if kind:
        got = nyms.setdefault(kind, [])
        have = {w["w"] for w in got}
        got.extend(w for w in _words_in(node, page_path, 24) if w["w"] not in have)


def _sense_extra(node, page_path, ex, nyms, ul_class=""):
    """One indented line under a sense: an example, a quotation (left out:
    a citation is a page of its own), or a line of synonyms."""
    c = node.cls() + " " + ul_class
    if "citation-whole" in c or node.find(
        lambda n: n.has_class("citation-whole") or n.has_class("cited-source")
    ):
        return
    nym = (
        node
        if ("nyms" in c or "onyms" in c)
        else node.find(
            lambda n: "nyms" in n.cls().split() or "onyms-collapse" in n.cls()
        )
    )
    if nym is not None:
        kind_src = nym.cls() + " " + c
        if "antonym" in kind_src:
            nyms.setdefault("ant", []).extend(_words_in(node, page_path, 24))
        elif "synonym" in kind_src or "nyms" in kind_src:
            nyms.setdefault("syn", []).extend(_words_in(node, page_path, 24))
        return
    sources = node.find(lambda n: n.has_class("sources"))
    text = (
        text_of(node, skip=("ul", "dl"))
        if sources is None
        else text_of(node, skip=("ul", "dl"))
    )
    if sources is not None:
        text = text.replace(text_of(sources), "").strip()
    text = text.strip(' «»"“”')
    if text and len(ex) < EXAMPLES_MAX:
        ex.append(text[:EXAMPLE_CHARS] + ("…" if len(text) > EXAMPLE_CHARS else ""))


def parse_translations(blocks, page_path):
    """Translations by sense: ``[{"gloss", "items": [{"lang", "name",
    "words": [{"w", "t", "tr"?}]}]}]``, and ``see``, the page holding them when
    this one only points there (English Wiktionary's water/translations)."""
    out, see = [], ""
    for block in blocks:
        tables = [
            n
            for n in [block, *block.iter()]
            if n.tag == "table" and n.has_class("translations")
        ]
        frames = [n for n in [block, *block.iter()] if n.has_class("NavFrame")]
        holders = (
            tables
            or [f.find(lambda n: n.has_class("NavContent")) or f for f in frames]
            or []
        )
        # "See water/translations § Noun."
        for a in block.iter():
            if a.tag == "a" and "/translations" in unquote(a.attrs.get("href", "")) and not see:
                href = unquote(a.attrs["href"])
                p, _, frag = href.partition("#")
                see = posixpath.normpath(posixpath.join(_page_dir(page_path), p)) + (
                    "#" + frag if frag else ""
                )
        if not holders and block.tag in ("ul", "ol"):
            holders = [block]
        for h in holders:
            gloss = h.attrs.get("data-gloss") or ""
            if not gloss:
                frame = h
                while frame is not None and not frame.has_class("NavFrame"):
                    frame = frame.parent
                head = (
                    frame.find(lambda n: n.has_class("NavHead"))
                    if frame is not None
                    else None
                )
                if head is not None:
                    title = head.find(lambda n: n.has_class("nav-head-title"))
                    gloss = text_of(title if title is not None else head)
            items = _translation_items(h, page_path)
            if items:
                out.append({"gloss": gloss, "items": items})
    return out, see


def _translation_items(holder, page_path):
    items = []
    for row in holder.iter():
        if row.tag not in ("li", "dd"):
            continue
        name = _row_language(row)
        if not name:
            continue
        words, code, seen = [], "", set()
        for n in _row_own(row):
            c = _code_of(n)
            if not c or n.tag not in ("span", "bdi", "i", "b"):
                continue
            # The word itself, not the span inside it that says its script.
            if n.parent is not None and _code_of(n.parent) == c and n.parent is not row:
                continue
            text = text_of(n)
            if not text or text in seen:
                continue
            a = n if n.tag == "a" else n.find(lambda x: x.tag == "a")
            target = (
                link_target(a.attrs.get("href", ""), page_path) if a is not None else ""
            )
            seen.add(text)
            w = {"w": text, "t": target or text}
            tr = _transliteration_after(n)
            if tr:
                w["tr"] = tr
            words.append(w)
            code = code or c
        if not words:
            # A build whose words carry no code (English Wiktionary in
            # 2024): the row's links, the language its name.
            for a in _row_own(row):
                if a.tag != "a" or _inside_dropped(a, row):
                    continue
                target = link_target(a.attrs.get("href", ""), page_path)
                text = text_of(a)
                if target and text and text not in seen:
                    seen.add(text)
                    words.append({"w": text, "t": target})
        if words:
            items.append({"lang": code, "name": name, "words": words})
    return items


def _row_language(row):
    """The language a translation row names: its words before the colon."""
    own = []
    for k in row.kids:
        if isinstance(k, Node):
            if k.tag in ("dl", "ul") or _code_of(k):
                break
            own.append(text_of(k))
        else:
            own.append(k)
            if ":" in k:
                break
    text = _SPACES_RE.sub(" ", "".join(own))
    if ":" not in text:
        return ""
    return text.split(":", 1)[0].strip("  ")


def _row_own(row):
    """A row's elements, without the rows nested in it."""
    for k in row.kids:
        if isinstance(k, Node):
            if k.tag in ("dl", "ul"):
                continue
            yield k
            for n in k.iter():
                yield n


def _transliteration_after(n):
    p = n.parent
    if p is None:
        return ""
    sibs = p.kids
    try:
        i = sibs.index(n)
    except ValueError:
        return ""
    for k in sibs[i + 1 : i + 6]:
        if isinstance(k, Node):
            if "tr" in k.cls().split():
                return text_of(k)
            if _code_of(k):
                return ""
    return ""


# ── a whole page ───────────────────────────────────────────────────────────


def _language_code(heading, blocks, wiki_lang, names):
    """The code of the language a section is the word in: French
    Wiktionary's heading says it (span.sectionlangue id="fr"), every
    edition's headword carries it (strong.headword lang="fr"); a small
    Wiktionary writing only its own language says neither, and its heading
    is its own language's name."""
    sl = heading.find(lambda n: n.has_class("sectionlangue") and n.attrs.get("id"))
    if sl is not None:
        return sl.attrs["id"].lower()
    for b in blocks:
        for n in [b, *b.iter()]:
            if (
                "headword" in n.cls().split() or "headword-line" in n.cls().split()
            ) and _code_of(n):
                return _code_of(n)
            if n.tag in ("strong", "b") and "headword" in n.cls() and _code_of(n):
                return _code_of(n)
    name = text_of(heading).lower()
    own = {x.lower() for x in names} | set(_SELF_NAMES.get(wiki_lang, ()))
    native = _native_name(wiki_lang)
    if native:
        own.add(native.lower())
    if name in own:
        return wiki_lang
    return ""


def _native_name(code):
    try:
        from zimi.interlang import _LANG_NATIVE_NAMES

        return _LANG_NATIVE_NAMES.get(code, "")
    except Exception:
        return ""


def parse_page(html_text, page_path, wiki_lang="", zim_name="", archive_has=None):
    """A Wiktionary page as the words it describes: ``{"langs": [{"code",
    "name", "groups": [{"ety", "parts": [...]}], "pron", "words"}]}``.

    A group is one etymology (English Wiktionary numbers them); a part is
    one part of speech, with its headword line, senses, and the words around
    it (synonyms, derived terms, translations...)."""
    root = _content_root(parse_tree(html_text))
    facts = wikilang.wiktionary_facts(wiki_lang, zim_name) or {}
    monolingual = bool(facts.get("monolingual"))
    names = facts.get("names", ())
    # The run of headings and the blocks under each.
    sections, lead = [], []
    for tok in _flat(root):
        if tok[0] == "h":
            if tok[1] == 1:
                continue
            sections.append(
                {"level": tok[1], "node": tok[2], "text": text_of(tok[2]), "blocks": []}
            )
        elif sections:
            sections[-1]["blocks"].append(tok[1])
        else:
            lead.append(tok[1])
    lang_level = 0 if monolingual else 2
    langs = []
    cur = None
    if monolingual or not any(s["level"] == 2 for s in sections):
        # One language, the wiki's own: Simple English Wiktionary has no
        # language headings and puts its parts of speech on <h2>.
        cur = _new_lang(
            wiki_lang,
            "",
        )
        langs.append(cur)
        lang_level = 0
        sections = (
            [{"level": 99, "node": Node("h9"), "text": "", "blocks": lead}] + sections
            if lead
            else sections
        )
    for s in sections:
        if lang_level and s["level"] == lang_level:
            cur = _new_lang(
                _language_code(
                    s["node"],
                    _blocks_until_next(sections, s, lang_level),
                    wiki_lang,
                    names,
                ),
                s["text"],
            )
            langs.append(cur)
            continue
        if cur is None:
            continue
        _section_into(cur, s, page_path, archive_has)
    out = []
    for lg in langs:
        _finish_lang(lg)
        if lg["groups"] or lg["pron"]["ipa"] or lg.get("trans_by"):
            out.append(lg)
    return {"langs": out}


def _blocks_until_next(sections, s, level):
    i = sections.index(s)
    out = list(s["blocks"])
    for t in sections[i + 1 :]:
        if t["level"] <= level:
            break
        out.extend(t["blocks"])
    return out


def _new_lang(code, name):
    return {
        "code": code,
        "name": name,
        "groups": [{"ety": [], "parts": []}],
        "pron": {
            "ipa": [],
            "audio": [],
            "rhymes": [],
            "rhymes_page": "",
            "homophones": [],
            "hyphenation": "",
        },
        "words": [],
        "_part_level": 0,
    }


def _section_into(lg, s, page_path, archive_has):
    kind = _kind(s["text"])
    blocks = s["blocks"]
    if kind != "translations":
        lg["_last_head"] = s["text"]
    group = lg["groups"][-1]
    part = group["parts"][-1] if group["parts"] else None
    if kind == "skip":
        return
    if kind == "etymology":
        if group["ety"] or group["parts"]:
            group = {"ety": [], "parts": []}
            lg["groups"].append(group)
        segs = []
        for b in blocks:
            if (
                b.tag in ("p", "dl", "ul")
                or b.tag == "div"
                and not b.has_class("NavFrame")
            ):
                got = segments(b, page_path)
                if got:
                    if segs:
                        segs.append(" ")
                    segs.extend(got)
            if len(_plain(segs)) > ETY_CHARS:
                break
        group["ety"] = [] if _PLACEHOLDER_RE.search(_plain(segs)) else _cap_segments(segs, ETY_CHARS)
        lg["_part_level"] = 0
        return
    if kind == "pronunciation":
        got = parse_pronunciation(blocks, page_path, archive_has)
        p = lg["pron"]
        have = {tuple(x["ipa"]) for x in p["ipa"]}
        p["ipa"].extend(x for x in got["ipa"] if tuple(x["ipa"]) not in have)
        p["audio"].extend(got["audio"])
        p["rhymes"].extend(r for r in got["rhymes"] if r not in p["rhymes"])
        p["rhymes_page"] = p["rhymes_page"] or got["rhymes_page"]
        p["homophones"].extend(got["homophones"])
        p["hyphenation"] = p["hyphenation"] or got["hyphenation"]
        return
    in_part = part is not None and s["level"] > lg["_part_level"] > 0
    if kind == "translations":
        items, see = parse_translations(blocks, page_path)
        if part is None:
            # A page of translations only (water/translations): kept by the
            # part of speech the heading above names.
            if items:
                lg.setdefault("trans_by", {})[lg.get("_last_head", "").lower()] = items
            return
        part["trans"].extend(items)
        if see and not part.get("trans_see"):
            part["trans_see"] = see
        return
    ol = next((b for b in blocks if b.tag == "ol"), None)
    if not kind and ol is not None and not in_part:
        head = next((b for b in blocks if b.tag == "p" and text_of(b)), None)
        part = {
            "pos": s["text"],
            "head": segments(head, page_path) if head is not None else [],
            "senses": parse_senses(ol, page_path),
            "words": [],
            "trans": [],
        }
        # French writes the IPA in the headword line, and its own
        # pronunciation section often only after every part of speech.
        if head is not None:
            ipa = [
                text_of(n) for n in head.iter() if {"API", "IPA"} & set(n.cls().split())
            ]
            ipa = [i for i in ipa if i and not i.startswith("-") and not _PLACEHOLDER_RE.search(i)]
            if ipa:
                part["ipa"] = ipa
        group["parts"].append(part)
        lg["_part_level"] = s["level"]
        return
    if (
        kind == "homophones"
        or kind in ("synonyms", "antonyms", "derived", "related")
        or not kind
    ):
        words = []
        for b in blocks:
            words.extend(
                w
                for w in _words_in(b, page_path)
                if w["w"] not in {x["w"] for x in words}
            )
            if len(words) >= WORDS_MAX:
                break
        if not words:
            return
        entry = {
            "kind": kind or "other",
            "title": s["text"],
            "items": words[:WORDS_MAX],
        }
        (part["words"] if in_part else lg["words"]).append(entry)


def _finish_lang(lg):
    lg.pop("_part_level", None)
    lg.pop("_last_head", None)
    lg["groups"] = [g for g in lg["groups"] if g["parts"] or g["ety"]]
    # A pronunciation heard only in the headword line (French).
    if not lg["pron"]["ipa"]:
        seen = set()
        for g in lg["groups"]:
            for p in g["parts"]:
                for i in p.get("ipa", ()):
                    if i not in seen:
                        seen.add(i)
                        lg["pron"]["ipa"].append({"accent": "", "ipa": [i]})


# ── the library's Wiktionaries ─────────────────────────────────────────────


def wiktionaries():
    """The installed Wiktionaries this request may read, the largest first."""
    from zimi import wiki as _wiki

    out = [w for w in _wiki.wikis() if w["project"] == PROJECT]
    out.sort(key=lambda w: (-int(w.get("entries") or 0), w["name"]))
    return [
        {
            "name": w["name"],
            "title": w["title"],
            "lang": w["language"],
            # Its pages (the library's count of articles), not its entries:
            # a Wiktionary's entries count its stylesheets and redirects too.
            "entries": _record(w["name"]).get("article_count") or w["entries"],
            "flavour": w.get("flavour", ""),
        }
        for w in out
    ]


def is_dictionary(name):
    return any(w["name"] == name for w in wiktionaries())


def _record(name):
    return next((z for z in _srv._zim_list_cache or [] if z.get("name") == name), {})


def _read(archive, path):
    """(path, html) of an HTML entry, its redirect followed, or None. Must
    be called with _zim_lock held."""
    try:
        entry = archive.get_entry_by_path(path)
    except KeyError:
        return None
    if entry.is_redirect:
        entry = entry.get_redirect_entry()
    item = entry.get_item()
    if not (item.mimetype or "").startswith("text/html"):
        return None
    data = bytes(item.content)[:PAGE_MAX]
    return entry.path, data.decode("utf-8", "replace")


def _has_entry(archive, path):
    with _srv._zim_lock:
        try:
            archive.get_entry_by_path(path)
            return True
        except KeyError:
            return False


def _candidate_paths(word):
    p = word.strip().replace(" ", "_")
    out = [p, "A/" + p]
    low = p[:1].lower() + p[1:]
    if low != p:
        out += [low, "A/" + low]
    return out


def find_paths(name, word):
    """The pages of a Wiktionary named ``word``, and the open archive: the
    page by its own path first, then the other cases of it ("Water",
    "WATER") from the title index."""
    from zimi.search import _title_index_exact

    exact = None
    with _srv._zim_lock:
        archive = _srv.get_archive(name)
        if archive is None:
            return [], None
        for p in _candidate_paths(word):
            try:
                archive.get_entry_by_path(p)
            except KeyError:
                continue
            exact = p
            break
    others = []
    try:
        for h in _title_index_exact(name, word):
            if h["path"] != exact and h["path"] not in others:
                others.append(h["path"])
    except Exception as e:
        log.debug("title lookup failed for %s %r: %s", name, word, e)
    return ([exact] if exact else []) + others, archive


def _parsed(name, archive, path):
    z = _record(name)
    key = (name, str(z.get("date") or ""), path)
    with _lock:
        got = _cache.get(key)
        if got is not None:
            _cache.move_to_end(key)
            return got
    with _srv._zim_lock:
        page = _read(archive, path)
    if page is None:
        return None
    real_path, html_text = page
    from zimi import wiki as _wiki

    lang = _wiki._language(z) if z else ""
    got = parse_page(
        html_text, real_path, lang, name, archive_has=lambda p: _has_entry(archive, p)
    )
    got["path"] = real_path
    got["word"] = _word_of_path(real_path)
    with _lock:
        _cache[key] = got
        while len(_cache) > _CACHE_MAX:
            _cache.popitem(last=False)
    return got


def _translations_page(name, archive, see, pos):
    """English Wiktionary moves a long word's translations to a page of
    their own (water/translations): its section for this part of speech."""
    path, _, frag = see.partition("#")
    parsed = _parsed(name, archive, path)
    if not parsed:
        return []
    want = (frag or pos).replace("_", " ").lower()
    for lg in parsed["langs"]:
        got = lg.get("trans_by", {})
        if want in got:
            return got[want]
        # "Noun 2": the second noun's translations under the same heading.
        base = re.sub(r"\s*\d+$", "", want)
        if base in got:
            return got[base]
    return []


def _rhymes(name, archive, page):
    """The words a Rhymes: page lists, for the wormhole."""
    try:
        with _srv._zim_lock:
            got = _read(archive, page)
    except Exception:
        return []
    if not got:
        return []
    root = _content_root(parse_tree(got[1]))
    words = []
    for tok in _flat(root):
        if tok[0] == "b":
            words.extend(
                w
                for w in _words_in(tok[1], got[0], 60)
                if not w["t"].lower().startswith(("rhymes", "rimes"))
            )
        if len(words) >= 60:
            break
    return words[:60]


def _wanted(item, langs, names):
    return _primary(item["lang"]) in langs or (not item["lang"] and item["name"].lower() in names)


def _trans_view(trans, langs, names, every):
    """Translations into the reader's languages (by code, or by name where
    a build gives none), each sense saying how many there are in all;
    every one when asked."""
    out = []
    for t in trans:
        items = t["items"] if every else [i for i in t["items"] if _wanted(i, langs, names)]
        out.append({"gloss": t["gloss"], "items": items, "n": len(t["items"])})
    return out


def _primary(code):
    return (code or "").split("-")[0].lower()


def _lang_view(name, archive, lg, word, langs, names, every):
    """One language of a parsed page as a lookup gives it: translations
    narrowed, a moved list of translations fetched, rhyming words read. The
    kept page is not changed: what differs is copied."""
    groups = []
    for g in lg["groups"]:
        parts = []
        for p in g["parts"]:
            trans = p["trans"]
            if not trans and p.get("trans_see"):
                trans = _translations_page(name, archive, p["trans_see"], p["pos"])
            q = {k: v for k, v in p.items() if k not in ("trans", "trans_see")}
            q["trans"] = _trans_view(trans, langs, names, every)
            q["trans_n"] = max((len(t["items"]) for t in trans), default=0)
            parts.append(q)
        groups.append({"ety": g["ety"], "parts": parts})
    pron = {k: v for k, v in lg["pron"].items() if k != "rhymes_page"}
    pron["audio"] = [dict(a, zim=name) for a in lg["pron"]["audio"]]
    if lg["pron"].get("rhymes_page"):
        pron["rhyme_words"] = [r for r in _rhymes(name, archive, lg["pron"]["rhymes_page"]) if r["w"] != word]
    return {"code": lg["code"], "name": lg["name"], "groups": groups, "pron": pron, "words": lg["words"]}


def lookup(word, langs=(), names=(), every=False):
    """A word across every Wiktionary: ``{"w", "found", "sources", "langs",
    "also", "near"}``. ``langs``: the reader's languages (codes) and
    ``names`` their English names, whose translations are given (all of
    them with ``every``); their Wiktionaries are read first. The page puts
    the reader's languages first again, by the browser's own list."""
    word = _SPACES_RE.sub(" ", (word or "")).strip()[:200]
    langs = [_primary(c) for c in langs if c][:8]
    names = {n.strip().lower() for n in names if n and n.strip()}
    out = {"w": word, "found": False, "sources": [], "langs": [], "also": [], "near": []}
    if not word:
        return out
    groups = collections.OrderedDict()
    for w in _ordered_sources(langs):
        name = w["name"]
        paths, archive = find_paths(name, word)
        if not paths or archive is None:
            continue
        parsed = _parsed(name, archive, paths[0])
        if not parsed or not parsed["langs"]:
            continue
        for other in paths[1:] + [parsed["path"]]:
            ow = _word_of_path(other)
            # Another case of it, or the word a redirect files it under.
            if ow != word and ow not in out["also"]:
                out["also"].append(ow)
        out["sources"].append({"zim": name, "title": w["title"], "lang": w["lang"], "path": parsed["path"]})
        for lg in parsed["langs"]:
            if not lg["groups"]:
                continue
            entry = _lang_view(name, archive, lg, word, set(langs), names, every)
            entry.update(zim=name, zim_title=w["title"], wiki_lang=w["lang"])
            key = lg["code"] or ("name:" + lg["name"].lower())
            g = groups.setdefault(key, {"code": lg["code"], "names": {}, "entries": []})
            g["names"][name] = lg["name"]
            g["entries"].append(entry)
    out["langs"] = list(groups.values())
    out["found"] = bool(out["langs"])
    if not out["found"]:
        out["near"] = [s["w"] for s in suggest(word)["words"] if s["w"] != word][:8]
    return out


def _ordered_sources(langs):
    """The reader's own languages' Wiktionaries first, then the largest."""
    ws = wiktionaries()
    return sorted(
        ws,
        key=lambda w: (
            0 if w["lang"] in langs else 1,
            langs.index(w["lang"]) if w["lang"] in langs else 0,
        ),
    )


def suggest(q, limit=SUGGEST_MAX):
    """Words starting with ``q`` across the Wiktionaries: ``{"words": [{"w",
    "zims"}]}``, each word once, in the order the indexes give them."""
    from zimi.search import (
        _get_suggest_archive,
        _title_index_search,
        suggest_search_zim,
    )

    q = _SPACES_RE.sub(" ", q or "").strip()[:100]
    out = collections.OrderedDict()
    if not q:
        return {"q": q, "words": []}
    for w in wiktionaries():
        name = w["name"]
        hits = None
        try:
            hits = _title_index_search(name, q, limit=SUGGEST_PER_ZIM)
        except Exception as e:
            log.debug("dictionary suggest: title index failed for %s: %s", name, e)
        if hits is None:
            archive, lock = _get_suggest_archive(name)
            if archive is None:
                continue
            with lock:
                hits = suggest_search_zim(archive, q, limit=SUGGEST_PER_ZIM)
        for h in hits:
            word = (
                _word_of_path(h.get("path") or "") if not h.get("title") else h["title"]
            )
            word = word.replace("_", " ")
            if not word or ":" in word or "/" in word:
                continue
            out.setdefault(word, []).append(name)
    words = sorted(
        out.items(),
        key=lambda kv: (
            not kv[0].lower().startswith(q.lower()),
            kv[0].lower() != q.lower(),
            len(kv[0]),
        ),
    )
    return {"q": q, "words": [{"w": k, "zims": v} for k, v in words[:limit]]}


def home():
    return {"wiktionaries": wiktionaries()}


# Settings' Hear: "Some dictionary words are: X, Y, Z." 3 to 5 plain words
# (letters only, short enough that the sentence fits voices.SAMPLE_MAX).
SAMPLE_WORDS = (3, 5)
SAMPLE_WORD_RE = re.compile(r"^[^\W\d_]{2,12}$")
SAMPLE_TRIES = 40  # random entries read at most, for the words


def sample_words(lang="", rng=None):
    """A few random words from a Wiktionary in ``lang`` (else the largest):
    ``{"lang": its language, "words": [...]}``, words [] with none here.
    The page keeps them for the session."""
    import random

    from zimi.search import random_entry

    rng = rng or random.Random()
    ws = wiktionaries()
    lang = _primary(lang)
    w = next((x for x in ws if _primary(x["lang"]) == lang), ws[0] if ws else None)
    if w is None:
        return {"lang": "", "words": []}
    want = rng.randint(*SAMPLE_WORDS)
    words = []
    with _srv._zim_lock:
        archive = _srv.get_archive(w["name"])
        for _ in range(SAMPLE_TRIES if archive is not None else 0):
            hit = random_entry(archive, max_attempts=4, rng=rng)
            word = ((hit or {}).get("title") or "").strip()
            if SAMPLE_WORD_RE.match(word) and word not in words:
                words.append(word)
                if len(words) >= want:
                    break
    return {"lang": _primary(w["lang"]), "words": words}


def today(day):
    """Each Wiktionary's word of the day (Discover's and Zimipedia's own,
    zimi/wiki.py), for the day YYYYMMDD on the reader's clock, and
    ``more``: each Wiktionary's other words of the day, chosen the same way
    (wiki.words), for the page to order by the reader's languages."""
    from zimi import wiki as _wiki

    words, more = [], []
    if not _wiki.day_open(day):
        return {"day": day, "words": [], "more": []}
    for w in wiktionaries():
        # The day's other words (the More words shelf), kept with the day's
        # picks, so this answer is still one ask.
        try:
            got = _wiki.words(w["name"], day) or []
        except Exception as e:
            log.debug("no more words from %s: %s", w["name"], e)
            got = []
        more.extend(
            {"w": x["title"], "zim": w["name"], "lang": w["lang"]} for x in got[1:]
        )
        try:
            card = _wiki.daily_card(w["name"], day)
        except Exception as e:
            log.debug("no word of the day from %s: %s", w["name"], e)
            card = None
        if card and card.get("title"):
            words.append(
                {
                    "w": card["title"],
                    "zim": w["name"],
                    "lang": w["lang"],
                    "blurb": card.get("blurb", ""),
                    "pos": card.get("part_of_speech", ""),
                }
            )
    return {"day": day, "words": words, "more": more}


def random_words(langs=()):
    """A handful of words by chance (the front's Shuffle), chosen as the
    day's are, from the Wiktionaries in the reader's languages (``langs``,
    primary codes) or, when none is, from all of them: ``{words: [{w, zim,
    lang}]}``, at most wiki.MORE_WORDS. Reads one Wiktionary after another
    until it has enough."""
    from zimi import wiki as _wiki

    ws = wiktionaries()
    mine = [w for w in ws if _primary(w["lang"]) in langs]
    ws = mine or ws
    random.shuffle(ws)
    out, seen = [], set()
    for w in ws:
        try:
            got = _wiki.words_by_chance(w["name"])
        except Exception as e:
            log.debug("no words by chance from %s: %s", w["name"], e)
            continue
        for x in got:
            if x["title"] not in seen:
                seen.add(x["title"])
                out.append({"w": x["title"], "zim": w["name"], "lang": w["lang"]})
        if len(out) >= _wiki.MORE_WORDS:
            break
    return {"words": out[: _wiki.MORE_WORDS]}


def _reset_for_tests():
    with _lock:
        _cache.clear()
