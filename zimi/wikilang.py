"""What a Wikimedia wiki looks like in each language.

The Discover cards read pages the wikis wrote for people, and every wiki
writes them in its own words: the Wikipedia page for a day is "September_25"
in English, "25._September" in German and "9月25日" in Chinese; a Wiktionary
entry files its word under a heading that names the wiki's own language
("English", "Deutsch", "Français"); a part of speech is "Noun", "Substantiv"
or "名詞". The facts for the ten languages the interface speaks live here, as
data, so the readers in search.py and previews.py stay one parser each.

Nothing here opens an archive except ``archive_language``, which reads one
metadata entry once per file and keeps it.
"""

import re
import threading
import unicodedata

# ── The language a ZIM is written in ──────────────────────────────────────

_lang_lock = threading.Lock()
_lang_cache = {}  # archive filename -> two-letter code, or ""


def archive_language(archive):
    """The two-letter code of the language an open archive says it is in
    ("heb" -> "he"), or "" when it does not say. Read once per file. Must be
    called with _zim_lock held (it may read a metadata entry)."""
    key = str(getattr(archive, "filename", "") or id(archive))
    with _lang_lock:
        if key in _lang_cache:
            return _lang_cache[key]
    code = ""
    try:
        raw = bytes(archive.get_metadata("Language")).decode("utf-8", "replace")
        code = raw.split(",")[0].strip().lower()
    except Exception:
        code = ""
    if len(code) == 3:
        from zimi.server import _ISO639_3_TO_1

        code = _ISO639_3_TO_1.get(code, code)
    with _lang_lock:
        _lang_cache[key] = code
    return code


# ── Date pages ("On this day") ────────────────────────────────────────────

_MONTHS = {
    "en": (
        "January",
        "February",
        "March",
        "April",
        "May",
        "June",
        "July",
        "August",
        "September",
        "October",
        "November",
        "December",
    ),
    "de": (
        "Januar",
        "Februar",
        "März",
        "April",
        "Mai",
        "Juni",
        "Juli",
        "August",
        "September",
        "Oktober",
        "November",
        "Dezember",
    ),
    "fr": (
        "janvier",
        "février",
        "mars",
        "avril",
        "mai",
        "juin",
        "juillet",
        "août",
        "septembre",
        "octobre",
        "novembre",
        "décembre",
    ),
    "es": (
        "enero",
        "febrero",
        "marzo",
        "abril",
        "mayo",
        "junio",
        "julio",
        "agosto",
        "septiembre",
        "octubre",
        "noviembre",
        "diciembre",
    ),
    "pt": (
        "janeiro",
        "fevereiro",
        "março",
        "abril",
        "maio",
        "junho",
        "julho",
        "agosto",
        "setembro",
        "outubro",
        "novembro",
        "dezembro",
    ),
    # Genitive: the page is "25 сентября", the 25th OF September.
    "ru": (
        "января",
        "февраля",
        "марта",
        "апреля",
        "мая",
        "июня",
        "июля",
        "августа",
        "сентября",
        "октября",
        "ноября",
        "декабря",
    ),
    "ar": (
        "يناير",
        "فبراير",
        "مارس",
        "أبريل",
        "مايو",
        "يونيو",
        "يوليو",
        "أغسطس",
        "سبتمبر",
        "أكتوبر",
        "نوفمبر",
        "ديسمبر",
    ),
    # With the preposition: the page is "25 בספטמבר", the 25th IN September.
    "he": (
        "בינואר",
        "בפברואר",
        "במרץ",
        "באפריל",
        "במאי",
        "ביוני",
        "ביולי",
        "באוגוסט",
        "בספטמבר",
        "באוקטובר",
        "בנובמבר",
        "בדצמבר",
    ),
    # Hindi Wikipedia spells some months two ways and files the page under
    # one of them with Devanagari digits ("२५ सितम्बर"); the other spelling
    # with ASCII digits is a redirect. Both are tried.
    "hi": (
        ("जनवरी",),
        ("फ़रवरी", "फरवरी"),
        ("मार्च",),
        ("अप्रैल",),
        ("मई",),
        ("जून",),
        ("जुलाई",),
        ("अगस्त",),
        ("सितंबर", "सितम्बर"),
        ("अक्टूबर",),
        ("नवंबर", "नवम्बर"),
        ("दिसंबर", "दिसम्बर"),
    ),
}

_DEVANAGARI_DIGITS = str.maketrans("0123456789", "०१२३४५६७८९")

# Every language date_page_titles can name a day in.
DATE_PAGE_LANGUAGES = tuple(_MONTHS) + ("zh",)


def date_page_titles(lang, month, day):
    """The ZIM paths (titles with underscores) a ``lang`` Wikipedia may file
    its page for ``month``/``day`` under, most likely first; [] for a
    language whose date pages are not known here. ``date_page_titles("de",
    9, 25)`` is ``["25._September"]``."""
    if not (1 <= month <= 12 and 1 <= day <= 31):
        return []
    if lang == "zh":
        return [f"{month}月{day}日"]
    months = _MONTHS.get(lang)
    if not months:
        return []
    name = months[month - 1]
    if lang == "en":
        return [f"{name}_{day}"]
    if lang == "de":
        return [f"{day}._{name}"]
    if lang == "fr":
        return [f"{'1er' if day == 1 else day}_{name}"]
    if lang in ("es", "pt"):
        return [f"{day}_de_{name}"]
    if lang == "hi":
        out = []
        for digits in (str(day), str(day).translate(_DEVANAGARI_DIGITS)):
            out += [f"{digits}_{n}" for n in name]
        return out
    return [f"{day}_{name}"]


# The section of a date page that holds the dated lines, in any of the
# languages: it starts at the Events heading and ends at the first of the
# headings that follow the Births and Deaths lists. Matched on the start of
# the heading's text ("Eventos históricos", "प्रमुख घटनाएँ").
OTD_START_HEADINGS = (
    "Events",
    "Ereignisse",
    "Événements",
    "Acontecimientos",
    "Eventos",
    "События",
    "大事记",
    "大事記",
    "أحداث",
    "אירועים",
    "प्रमुख घटनाएँ",
    "घटनाएँ",
    "घटनाएं",
)
OTD_END_HEADINGS = (
    "Holidays",
    "References",
    "See also",
    "External links",
    "Feier- und Gedenktage",
    "Einzelnachweise",
    "Weblinks",
    "Siehe auch",
    "Célébrations",
    "Traditions",
    "Notes et références",
    "Références",
    "Voir aussi",
    "Articles connexes",
    "Liens externes",
    "Celebraciones",
    "Véase también",
    "Referencias",
    "Enlaces externos",
    "Feriados",
    "Outros calendários",
    "Referências",
    "Ver também",
    "Ligações externas",
    "Приметы",
    "См. также",
    "Примечания",
    "Ссылки",
    "节假日",
    "節假日",
    "参考资料",
    "參考資料",
    "参考文献",
    "外部链接",
    "外部連結",
    "أعياد",
    "مراجع",
    "وصلات خارجية",
    "انظر أيضا",
    "انظر أيضًا",
    "חגים",
    "קישורים חיצוניים",
    "הערות שוליים",
    "ראו גם",
    "बाहरी कड़ियाँ",
    "बहारी कडियाँ",
    "सन्दर्भ",
    "संदर्भ",
)

# A dated line: a year, a separator, the sentence. The year may carry the
# language's before-Christ marker ("356 BC", "356 v. Chr.", "前356年"); the
# separator is a dash in most wikis, a colon in German, French and Spanish,
# and a full-width colon in Chinese.
_BC = (
    r"(?:BCE?|v\.\s?Chr\.|av\.\s?J\.-C\.|a\.\s?C\.|a\.\s?e\.\s?c\.|"
    r"до\s?н\.\s?э\.|ق\.\s?م\.?|לפנה[\"״]ס|ई\.\s?पू\.)"
)
OTD_LINE_RE = re.compile(
    r"^\s*((?:公元)?前?\d{1,4}\s*年?(?:\s*" + _BC + r")?)\s*[–—\-:：]\s*(.+)$",
    re.DOTALL,
)
OTD_YEAR_RE = re.compile(r"^(?:公元)?前?\d{1,4}\s*年?(?:\s*" + _BC + r")?$")


def otd_year(raw):
    """A dated line's year as the card shows it: "0275" and "275年" are
    "275"; a year before Christ keeps its marker as the wiki wrote it."""
    y = re.sub(r"\s+", " ", raw).strip()
    m = re.fullmatch(r"(\d{1,4})\s*年?", y)
    if m:
        return str(int(m.group(1)))
    return y.replace("年", "").strip()


# ── Wiktionary ────────────────────────────────────────────────────────────
#
# Each edition files a word under a heading naming the language it is in, in
# the edition's own language: a German word on de.wiktionary is under
# "Haus (Deutsch)", a French one on fr.wiktionary under "Français". The Word
# of the Day is a word of the wiki's own language, so that section is the one
# read, and a page with no such section (an English word on de.wiktionary) is
# passed over. Hebrew Wiktionary writes only Hebrew and has no language
# headings, so the whole page is its section.
#
# ``pos``: the heading (or, in Russian, the sentence) naming the part of
# speech. ``forms``: the headings of an inflected form ("Deklinierte Form",
# "Forme de nom commun"), which make a dull word of the day and are passed
# over like the English "plural of". ``form_defs``: the same thing said in
# the definition instead.

WIKTIONARY = {
    "en": {
        "names": ("English",),
        "pos": (
            "Proper noun",
            "Noun",
            "Verb",
            "Adjective",
            "Adverb",
            "Pronoun",
            "Preposition",
            "Conjunction",
            "Interjection",
            "Determiner",
            "Particle",
            "Prefix",
            "Suffix",
            "Numeral",
            "Article",
            "Phrase",
        ),
        "forms": (),
        "form_defs": (
            r"^(?:the )?(?:plural (?:form )?of |third-person |simple past |past "
            r"(?:tense|participle)|present participle |alternative |archaic "
            r"|obsolete |misspelling |eye dialect |nonstandard )"
        ),
    },
    "de": {
        "names": ("Deutsch",),
        "pos": (
            "Substantiv",
            "Verb",
            "Adjektiv",
            "Adverb",
            "Pronomen",
            "Personalpronomen",
            "Präposition",
            "Konjunktion",
            "Interjektion",
            "Artikel",
            "Numerale",
            "Partikel",
            "Eigenname",
            "Vorname",
            "Nachname",
            "Toponym",
            "Redewendung",
            "Sprichwort",
        ),
        "forms": (
            "Deklinierte Form",
            "Konjugierte Form",
            "Komparativ",
            "Superlativ",
            "Partizip",
            "Erweiterter Infinitiv",
        ),
        "form_defs": r"^(?:Nominativ|Genitiv|Dativ|Akkusativ|Plural) ",
    },
    "fr": {
        "names": ("Français",),
        "pos": (
            "Nom commun",
            "Nom propre",
            "Verbe",
            "Adjectif",
            "Adverbe",
            "Pronom",
            "Préposition",
            "Conjonction",
            "Interjection",
            "Article",
            "Locution",
            "Prénom",
            "Nom de famille",
            "Onomatopée",
        ),
        "forms": ("Forme de", "Forme d’", "Forme d'"),
        "form_defs": r"^(?:Pluriel|Féminin|Masculin) (?:de|d’|d')",
    },
    "es": {
        "names": ("Español",),
        "pos": (
            "Sustantivo",
            "Verbo",
            "Adjetivo",
            "Adverbio",
            "Pronombre",
            "Preposición",
            "Conjunción",
            "Interjección",
            "Artículo",
            "Locución",
            "Sigla",
            "Nombre propio",
        ),
        "forms": (
            "Forma flexiva",
            "Forma verbal",
            "Forma sustantiva",
            "Forma adjetiva",
            "Forma pronominal",
            "Forma participio",
        ),
        "form_defs": r"^(?:Plural|Forma|Femenino) de ",
    },
    "pt": {
        "names": ("Português",),
        "pos": (
            "Substantivo",
            "Verbo",
            "Adjetivo",
            "Advérbio",
            "Pronome",
            "Preposição",
            "Conjunção",
            "Interjeição",
            "Artigo",
            "Numeral",
            "Locução",
            "Expressão",
        ),
        "forms": ("Forma de", "Forma verbal"),
        "form_defs": r"^(?:plural|feminino|forma) d[eoa] ",
    },
    "ru": {
        "names": ("Русский",),
        "senses": ("Значение",),
        "pos": (
            "Существительное",
            "Глагол",
            "Прилагательное",
            "Наречие",
            "Местоимение",
            "Предлог",
            "Союз",
            "Междометие",
            "Частица",
            "Числительное",
            "Деепричастие",
            "Причастие",
        ),
        "forms": (),
        "form_defs": r"^(?:форма|мн\. ч\.|множественное число) ",
    },
    "zh": {
        "names": ("漢語", "汉语", "中文"),
        "senses": ("釋義", "释义"),
        "pos": (
            "名詞",
            "名词",
            "動詞",
            "动词",
            "形容詞",
            "形容词",
            "副詞",
            "副词",
            "代詞",
            "代词",
            "介詞",
            "介词",
            "連詞",
            "连词",
            "感嘆詞",
            "感叹词",
            "量詞",
            "量词",
            "助詞",
            "助词",
            "數詞",
            "数词",
            "成語",
            "成语",
        ),
        "forms": (),
        "form_defs": "",
    },
    "ar": {
        "names": ("عربية", "العربية"),
        "pos": ("اسم", "فعل", "صفة", "ظرف", "حرف", "ضمير"),
        "forms": (),
        # "صيغة جمع مفردها ..." (the plural of), read without its vowel marks
        "form_defs": r"^(?:صيغة|جمع) ",
    },
    "he": {
        "names": (),
        "monolingual": True,
        "pos_label": "חלק דיבר",
        "pos": (
            "שם עצם",
            "שם־עצם",
            "פועל",
            "שם תואר",
            "תואר הפועל",
            "מילת יחס",
            "מילת חיבור",
            "מילת קריאה",
            "כינוי גוף",
        ),
        "forms": (),
        "form_defs": "",
    },
    "hi": {
        "names": ("हिन्दी", "हिंदी"),
        "pos": ("संज्ञा", "क्रिया", "विशेषण", "क्रियाविशेषण", "सर्वनाम", "अव्यय"),
        "forms": (),
        "form_defs": "",
    },
}

# Simple English Wiktionary: English only, no language headings, the part of
# speech on an <h2>.
WIKTIONARY_SIMPLE = dict(WIKTIONARY["en"], names=(), monolingual=True)


def wiktionary_facts(lang, zim_name=""):
    """The facts for a Wiktionary in ``lang``, or None for an edition not
    described here (read best-effort: the page's first definition)."""
    if "simple" in (zim_name or "").lower() and lang in ("en", ""):
        return WIKTIONARY_SIMPLE
    return WIKTIONARY.get(lang)


# ── Scripts ───────────────────────────────────────────────────────────────
#
# A Wikiquote page often gives a quote in its original language and then in
# the wiki's own. The card shows the one a reader of that wiki can read: for
# a language with a script of its own, most of the letters must be in it.
SCRIPTS = {
    "zh": "CJK",
    "ja": "CJK",
    "ar": "ARABIC",
    "fa": "ARABIC",
    "he": "HEBREW",
    "hi": "DEVANAGARI",
    "ru": "CYRILLIC",
    "uk": "CYRILLIC",
}


def in_own_script(text, lang):
    """Whether most of the letters of ``text`` are in ``lang``'s own script.
    True for a language written in the Latin alphabet, where the script
    cannot tell one language from another."""
    script = SCRIPTS.get(lang)
    letters = [c for c in text if c.isalpha()]
    if not letters:
        return False
    if not script:
        return True
    own = 0
    for c in letters:
        name = unicodedata.name(c, "")
        if name.startswith(script) or (script == "CJK" and "IDEOGRAPH" in name):
            own += 1
    return own * 2 >= len(letters)
