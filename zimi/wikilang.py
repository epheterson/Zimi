"""What a Wikimedia wiki looks like in each language.

The Discover cards read pages the wikis wrote for people, and every wiki
writes them in its own words: a Wiktionary entry files its word under a
heading that names the wiki's own language ("English", "Deutsch",
"Français"); a part of speech is "Noun", "Substantiv" or "名詞"; a Wikiquote
reader reads the wiki's own script. The facts for the ten languages the
interface speaks live here, as data, so the reader in previews.py stays one
parser. Date pages (On this day) are zimi/datepages.py.

Nothing here opens an archive except ``archive_language``, which reads one
metadata entry once per file and keeps it.
"""

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
