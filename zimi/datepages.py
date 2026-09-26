"""Wikipedia's date pages, in every language Wikipedia writes them.

Every Wikipedia keeps a page per day of the year listing what happened on
it, and each names that page in its own words: ``September_25`` in English,
``25._September`` in German, ``25_septembre`` in French, ``9月25日`` in
Chinese and Japanese, ``25_בספטמבר`` in Hebrew. The events sit under a
heading of the language's own (Events, Ereignisse, Événements, 大事记,
אירועים) as list lines that start with a year and a separator (``1066 –``,
``1066:``, ``1066年：``), sometimes in the language's own digits (Persian
``۱۸۹۷``) and sometimes behind a hidden sort key (German and Portuguese
write ``0275`` with the ``0`` hidden).

This module knows those names and shapes, and read_page opens the page in
an archive (the caller holds the libzim lock). Zimipedia's On this day and
the Discover card's dated pick both read a date page through it, so there
is one copy of what a date page is called and how its events are read.

Checked against each language's real date page (the Parsoid HTML mwoffliner
builds its ZIMs from) for en, simple, de, fr, es, pt, it, ru, uk, zh, ja, ko,
he, yi, ar, fa, hi, nl, pl, tr, sv, id and vi. A language not listed here falls
back to the English name and the numeric CJK name, and to any heading that
any listed language uses for its events.
"""

import html
import re
from urllib.parse import unquote

from zimi.previews import inline_text

# Month names as each language's date page titles write them (the genitive
# where the language declines: 25 сентября, 25 września).
_MONTHS = {
    "en": "January February March April May June July August September October November December",
    "de": "Januar Februar März April Mai Juni Juli August September Oktober November Dezember",
    "fr": "janvier février mars avril mai juin juillet août septembre octobre novembre décembre",
    "es": "enero febrero marzo abril mayo junio julio agosto septiembre octubre noviembre diciembre",
    "pt": "janeiro fevereiro março abril maio junho julho agosto setembro outubro novembro dezembro",
    "it": "gennaio febbraio marzo aprile maggio giugno luglio agosto settembre ottobre novembre dicembre",
    "ca": "gener febrer març abril maig juny juliol agost setembre octubre novembre desembre",
    "ru": "января февраля марта апреля мая июня июля августа сентября октября ноября декабря",
    "uk": "січня лютого березня квітня травня червня липня серпня вересня жовтня листопада грудня",
    "pl": "stycznia lutego marca kwietnia maja czerwca lipca sierpnia września października listopada grudnia",
    "cs": "ledna února března dubna května června července srpna září října listopadu prosince",
    "nl": "januari februari maart april mei juni juli augustus september oktober november december",
    "sv": "januari februari mars april maj juni juli augusti september oktober november december",
    "tr": "Ocak Şubat Mart Nisan Mayıs Haziran Temmuz Ağustos Eylül Ekim Kasım Aralık",
    "id": "Januari Februari Maret April Mei Juni Juli Agustus September Oktober November Desember",
    "he": "בינואר בפברואר במרץ באפריל במאי ביוני ביולי באוגוסט בספטמבר באוקטובר בנובמבר בדצמבר",
    "ar": "يناير فبراير مارس أبريل مايو يونيو يوليو أغسطس سبتمبر أكتوبر نوفمبر ديسمبر",
    "fa": "ژانویه فوریه مارس آوریل مه ژوئن ژوئیه اوت سپتامبر اکتبر نوامبر دسامبر",
    # Hindi's pages exist under both spellings of several months, one a
    # redirect to the other; either lands on the page.
    "hi": "जनवरी फ़रवरी मार्च अप्रैल मई जून जुलाई अगस्त सितंबर अक्टूबर नवंबर दिसंबर",
    "yi": "יאנואר פעברואר מערץ אפריל מאי יוני יולי אויגוסט סעפטעמבער אקטאבער נאוועמבער דעצעמבער",
}
_MONTHS = {k: v.split() for k, v in _MONTHS.items()}
_HI_ALT = (
    "जनवरी फरवरी मार्च अप्रैल मई जून जुलाई अगस्त सितम्बर अक्तूबर नवम्बर दिसम्बर".split()
)

# Digits a date page may be titled or dated in, to ASCII.
_DIGITS = {}
for _zero in (
    0x0660,
    0x06F0,
    0x0966,
    0x09E6,
):  # Arabic-Indic, Persian, Devanagari, Bengali
    for _i in range(10):
        _DIGITS[chr(_zero + _i)] = str(_i)
_DIGIT_TABLE = str.maketrans(_DIGITS)


def _native(n, zero):
    return "".join(chr(zero + int(c)) for c in str(n))


# The heading each Wikipedia puts over its day's events. Matched as a
# substring of the heading's text, so "Wydarzenia w Polsce" and
# "Wydarzenia na świecie" are both events and "प्रमुख घटनाएँ" is too.
EVENT_HEADINGS = {
    "en": ("Events",),
    "de": ("Ereignisse",),
    "fr": ("Événements", "Evénements"),
    "es": ("Acontecimientos",),
    "pt": ("Eventos",),
    "it": ("Eventi",),
    "ca": ("Esdeveniments",),
    "ru": ("События",),
    "uk": ("Події",),
    "pl": ("Wydarzenia",),
    "cs": ("Události",),
    "nl": ("Gebeurtenissen",),
    "sv": ("Händelser",),
    "tr": ("Olaylar",),
    "id": ("Peristiwa",),
    "vi": ("Sự kiện",),
    "zh": ("大事记", "大事記"),
    "ja": ("できごと", "出来事"),
    "ko": ("사건",),
    "he": ("אירועים",),
    "ar": ("أحداث",),
    "fa": ("رویدادها", "رخدادها"),
    "hi": ("घटनाएँ", "घटनाएं"),
    "yi": ("היסטארישע געשעענישן",),
}
_ANY_EVENTS = tuple(w for ws in EVENT_HEADINGS.values() for w in ws)

_DAYS_IN_MONTH = (31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31)


def valid_mmdd(mmdd):
    """``(month, day)`` for a real day of the year written MMDD (``0229``
    included, as every date page has one), else None."""
    s = str(mmdd or "")
    if len(s) != 4 or not s.isdigit():
        return None
    m, d = int(s[:2]), int(s[2:])
    if not 1 <= m <= 12 or not 1 <= d <= _DAYS_IN_MONTH[m - 1]:
        return None
    return m, d


def date_page_titles(lang, mmdd):
    """The paths a Wikipedia in ``lang`` may keep its page for the day MMDD
    under, most likely first, without a namespace prefix. [] for a date that
    is not one."""
    md = valid_mmdd(mmdd)
    if not md:
        return []
    m, d = md
    lang = _lang(lang)
    names = _MONTHS.get(lang)
    month = names[m - 1] if names else ""
    out = []
    if lang == "en":
        out.append(f"{month}_{d}")
    elif lang in ("de", "cs"):
        out.append(f"{d}._{month}")
    elif lang == "fr":
        out.append(f"{'1er' if d == 1 else d}_{month}")
    elif lang == "it":
        out.append(f"{'1º' if d == 1 else d}_{month}")
    elif lang in ("es", "pt"):
        out.append(f"{d}_de_{month}")
    elif lang == "ca":
        out.append(f"{d}_d'{month}" if month[0] in "ao" else f"{d}_de_{month}")
    elif lang in ("zh", "ja"):
        out.append(f"{m}月{d}日")
    elif lang == "ko":
        out.append(f"{m}월_{d}일")
    elif lang == "vi":
        out.append(f"{d}_tháng_{m}")
    elif lang == "fa":
        out.append(f"{_native(d, 0x06F0)}_{month}")
        out.append(f"{d}_{month}")
    elif lang == "hi":
        for mon in dict.fromkeys((month, _HI_ALT[m - 1])):
            out.append(f"{d}_{mon}")
            out.append(f"{_native(d, 0x0966)}_{mon}")
    elif names:
        out.append(f"{d}_{month}")
    # A language not listed: the English name (many small Wikipedias keep
    # English-titled redirects) and the CJK numeric one.
    if lang not in _MONTHS and lang not in ("zh", "ja", "ko", "vi"):
        out.append(f"{_MONTHS['en'][m - 1]}_{d}")
        out.append(f"{m}月{d}日")
    return out


# A year at the start of a line, then a separator: "1066 –", "1066:",
# "1066年：", "44 BC –", "1066 - ". The suffixes are the era and year
# words the date pages use; the year keeps them ("44 BC").
_ERA = (
    r"(?:\s*(?:BC|BCE|B\.C\.|AD|a\.\s?C\.|d\.\s?C\.|av\.\s?J\.-C\.|v\.\s?Chr\.|n\.\s?Chr\."
    r"|до\s?н\.\s?э\.|до\s?н\.\s?е\.|п\.\s?н\.\s?е\.|г\.|р\.|年|년|ق\.م|م|לפנה\"ס|ई\.?\s?पू\.?))?"
)
_SEP = "–—‒―:：\\-"
_LINE_RE = re.compile(
    r"^\s*(\d{1,4}" + _ERA + r")\s*[" + _SEP + r"]\s*(.+)$", re.DOTALL
)
_YEAR_RE = re.compile(r"^\s*\d{1,4}" + _ERA + r"\s*(?:\(.*\))?\s*$")
TEXT_CAP = 240  # an event is a card's worth
_SCAN_CAP = 600000  # bound the regex work on the biggest date pages
_HIDDEN_RE = re.compile(
    r"<(span|sup)\b[^>]*style=[\"'][^\"']*(?:display:\s*none|visibility:\s*hidden)[^\"']*[\"'][^>]*>.*?</\1>",
    re.DOTALL | re.IGNORECASE,
)


# A link that leaves the wiki (another language's article) or that the wiki
# has not written yet (a red link, ``class="new"``): neither is in the ZIM.
_FOREIGN_LINK_RE = re.compile(
    r"class=[\"'][^\"']*\b(?:extiw|external|new)\b|rel=[\"']mw:WikiLink/Interwiki",
    re.IGNORECASE,
)


def card_year(raw):
    """A dated line's year as a card shows it: "0275", "275年" and "275년"
    are "275"; a year before Christ keeps its marker as the wiki wrote it."""
    y = re.sub(r"\s+", " ", raw).strip()
    m = re.fullmatch(r"(\d{1,4})\s*[年년]?", y)
    return str(int(m.group(1))) if m else y


def to_ascii_digits(s):
    return str(s).translate(_DIGIT_TABLE)


def _norm_link(href, lang):
    """A date page's link as a bare ZIM path, or "" for one that leaves the
    wiki (an interwiki to another language's page). An older build writes
    links to its own wiki as full addresses; those are kept. mwoffliner
    percent-encodes every link that is not ASCII (%E0%A4%95... for Hindi)."""
    href = unquote(href.split("#")[0].split("?")[0])
    own = r"^(?:https?:)?//%s\.wikipedia\.org/wiki/" % re.escape(lang)
    href = re.sub(own, "", href)
    if re.match(r"^(?:https?:)?//", href):
        return ""
    href = re.sub(r"^(?:\.\./|\./)+", "", href)
    href = re.sub(r"^(?:A/|/wiki/|/)", "", href)
    return href


def _sections(page_html):
    """``[(heading text, body html)]`` per level-2 heading, in order."""
    parts = re.split(
        r"(<h2\b[^>]*>.*?</h2>)", page_html, flags=re.DOTALL | re.IGNORECASE
    )
    out = []
    for i in range(1, len(parts) - 1, 2):
        out.append((inline_text(parts[i]), parts[i + 1]))
    return out


def _lang(lang):
    """A wiki's language as these tables key it: Simple English is English."""
    lang = (lang or "en").split("-")[0].lower()
    return "en" if lang == "simple" else lang


def _event_sections(page_html, lang):
    secs = _sections(page_html[:_SCAN_CAP])
    words = EVENT_HEADINGS.get(lang)
    for pool in ((words or ()), _ANY_EVENTS):
        chosen = [
            body for head, body in secs if any(w.lower() in head.lower() for w in pool)
        ]
        if chosen:
            return chosen
    # A page whose headings say nothing we know: the first section that
    # reads like a list of dated lines.
    for _head, body in secs:
        if len(_lines(body, lang, limit=3)) >= 3:
            return [body]
    return []


def _lines(body, lang="en", limit=None):
    """The dated lines of one section: ``[{year, text, link}]``, each with
    the most specific article it names (the longest link that is not a
    year)."""
    out = []
    # A year written once over several events (Hindi: "2011-" with a list
    # under it): the events under it carry it.
    group_year = None
    for li in re.findall(r"<li\b[^>]*>(.*?)</li>", body, re.DOTALL | re.IGNORECASE):
        li = _HIDDEN_RE.sub("", li)
        li = re.sub(r"<sup\b[^>]*>.*?</sup>", "", li, flags=re.DOTALL | re.IGNORECASE)
        plain = to_ascii_digits(inline_text(li))
        plain = re.sub(r"\[\s*\d+\s*\]", "", plain)
        plain = re.sub(r"\s+([,.;:،])", r"\1", plain).strip()
        m = _LINE_RE.match(plain)
        if m:
            year, text = m.group(1).strip(), m.group(2).strip()
            group_year = year if re.search(r"<ul\b", li, re.IGNORECASE) else None
        elif group_year:
            year, text = group_year, plain
        else:
            continue
        if len(text) < 3:
            continue
        if len(text) > TEXT_CAP:
            text = text[:TEXT_CAP].rsplit(" ", 1)[0] + "…"
        best, best_len = None, 0
        for attrs, _q, href, inner in re.findall(
            r"<a\b([^>]*?href=([\"'])(.+?)\2[^>]*)>(.*?)</a>",
            li,
            re.DOTALL | re.IGNORECASE,
        ):
            if _FOREIGN_LINK_RE.search(attrs):
                continue
            href = html.unescape(href)
            atext = to_ascii_digits(inline_text(inner))
            if not atext or _YEAR_RE.match(atext):
                continue
            link = _norm_link(href, lang)
            if not link or _YEAR_RE.match(to_ascii_digits(link.replace("_", " "))):
                continue
            if re.search(r"\.(png|jpe?g|gif|svg|ico)$", link, re.IGNORECASE):
                continue
            # A namespaced page (File:, Category:, and their translations)
            # is not an article. A colon inside an article title is rarer
            # than a namespace link on a date page.
            if ":" in link:
                continue
            if len(atext) > best_len:
                best, best_len = link, len(atext)
        if best:
            out.append({"year": card_year(year), "text": text, "link": best})
            if limit and len(out) >= limit:
                break
    return out


def extract_events(page_html, lang="en"):
    """The day's events on a date page in ``lang``: ``[{year, text, link}]``
    in the page's order, from its events section(s) only (not births or
    deaths). [] for a page with none (a mini build keeps only the lead)."""
    lang = _lang(lang)
    out = []
    for body in _event_sections(page_html or "", lang):
        out.extend(_lines(body, lang))
    return out


def read_page(archive, mmdd, lang="en"):
    """The date page for MMDD in an archive of a Wikipedia in ``lang``, as
    text, under whichever of its names the ZIM holds (redirects followed),
    or None when it holds none (a subset, or a language whose date pages
    Zimi cannot name). The whole page: the events of a big date page run
    long. Call with the libzim lock held."""
    for title in date_page_titles(lang, mmdd):
        for prefix in ("A/", ""):
            try:
                entry = archive.get_entry_by_path(prefix + title)
            except KeyError:
                continue
            if entry.is_redirect:
                entry = entry.get_redirect_entry()
            return bytes(entry.get_item().content).decode("utf-8", errors="replace")
    return None
