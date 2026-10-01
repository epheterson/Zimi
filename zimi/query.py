"""The search query grammar: one parser for every search box.

    word            the word (every word must match)
    "two words"     the words together, in that order
    -word           no result containing the word; -"two words" likewise
    a OR b          either one (OR in capitals, between two terms)
    key:value       a filter, when the key is one the caller knows
    -key:value      the filter, negated

The web client has the same parser (parseSearchQuery in static/app.js) for the
catalog, and tests/fixtures/search_query_cases.json holds the cases both must
agree on.

What is deliberately NOT an operator: a hyphen inside a word ("e-mail"), a
lone "-", "or" in lower case, a colon in a term whose key nobody knows
("c++:", "http://x"). Unbalanced quotes are dropped and their words kept, so a
phrase half typed still searches.

Filters are a table, not code: a new one ("size:", "date:") is a new key in
the caller's table, and the parser needs no change. The parser only reports
them; each caller decides what a filter means for what it searches.
"""

import itertools
import re
import unicodedata

# Straight and typographic quotes: a phone keyboard types the latter.
_QUOTES = '"“”„'
# Scripts written without spaces between words. Inside them a word boundary
# means nothing, so an exclusion there matches anywhere in the text.
_UNSPACED = re.compile("[฀-໿က-႟ក-៿぀-ヿ㐀-䶿一-鿿豈-﫿]")
# The most searches one query makes (see alternatives). Past it an OR's
# later alternatives are not searched, and the search says which.
MAX_SEARCHES = 8

# The filters the library search understands. A key maps to its canonical
# name; aliases share one.
LIBRARY_FILTERS = {"in": "source", "source": "source", "lang": "lang"}


def _tokens(q):
    """(text, is_phrase, negated, start, end) tuples, in order, where
    q[start:end] is the token as typed. OR comes through as ("OR", False,
    False, ...)."""
    out = []
    i, n = 0, len(q)
    while i < n:
        ch = q[i]
        if ch.isspace():
            i += 1
            continue
        neg = False
        start = i
        if ch == "-" and i + 1 < n and q[i + 1] in _QUOTES:
            neg, i, ch = True, i + 1, q[i + 1]
        if ch in _QUOTES:
            end = next((j for j in range(i + 1, n) if q[j] in _QUOTES), -1)
            if end >= 0:
                text = " ".join(q[i + 1 : end].split())
                if text:
                    out.append((text, True, neg, start, end + 1))
                i = end + 1
                continue
            # Unbalanced: the quote goes, its words stay.
            i += 1
            if neg:
                continue
            start = i
            if start >= n:
                break
        j = start
        while j < n and not q[j].isspace():
            j += 1
        out.append((q[start:j], False, False, start, j))
        i = j
    return out


def _filter_key(text, filters):
    """The filter a term names (key:value, the key one the caller knows), or None."""
    key, sep, value = text.partition(":")
    return filters[key.lower()] if sep and value and key.lower() in filters else None


def word_spans(q, filters=LIBRARY_FILTERS):
    """Where in ``q`` the words to search are, as (start, end): each word and
    phrase, not OR, an exclusion or a filter. What a spelling suggestion may
    correct, leaving every operator as it was typed."""
    out = []
    for text, phrase, neg, start, end in _tokens(q or ""):
        if neg or (
            not phrase
            and (text == "OR" or text.startswith("-") or _filter_key(text, filters))
        ):
            continue
        out.append((start, end))
    return out


def parse_query(q, filters=LIBRARY_FILTERS):
    """The query's parts:

    groups   [[{"text", "phrase"}, ...], ...]: every group must match, and a
             group matches when any one of its alternatives does
    exclude  [{"text", "phrase"}]: none may match
    filters  [{"key", "value", "negate"}]: key is the canonical name
    plain    True when nothing in the query was syntax, so the caller can
             take its old path untouched
    """
    groups, exclude, found = [], [], []
    join_next = False
    for text, phrase, neg, _start, _end in _tokens(q or ""):
        if not phrase:
            if text == "OR":
                join_next = bool(groups)
                continue
            if text.startswith("-"):
                text, neg = text.lstrip("-"), True
                if not text:
                    join_next = False
                    continue
            key = _filter_key(text, filters)
            if key:
                found.append(
                    {"key": key, "value": text.partition(":")[2].lower(), "negate": neg}
                )
                join_next = False
                continue
            if any(c in _QUOTES for c in text):
                text = "".join(c for c in text if c not in _QUOTES)
                if not text:
                    continue
        term = {"text": text.lower(), "phrase": phrase}
        if neg:
            exclude.append(term)
            join_next = False
            continue
        if join_next:
            groups[-1].append(term)
        else:
            groups.append([term])
        join_next = False
    # Plain: the words an index would be given are the words typed, and
    # nothing else was asked. Anything dropped (a lone "-", a stray quote, a
    # dangling OR) makes it not plain, so the raw string never reaches an index.
    plain = (
        not exclude
        and not found
        and all(len(g) == 1 and not g[0]["phrase"] for g in groups)
        and [g[0]["text"] for g in groups] == (q or "").lower().split()
    )
    return {"groups": groups, "exclude": exclude, "filters": found, "plain": plain}


def alternatives(parsed, cap=MAX_SEARCHES):
    """The searches a query makes, each a list of terms, at most ``cap``.
    First each alternative of each OR, the other groups at their first: the
    searches add up group by group rather than multiply, so every word typed
    is searched ("a OR b OR c OR d OR e" is five). Then the other
    combinations ("dogs toys" of "cats OR dogs food OR toys"), while the
    budget lasts."""
    groups = parsed["groups"]
    if not groups:
        return []
    first = [g[0] for g in groups]
    alts = [first]
    for i, group in enumerate(groups):
        alts += [first[:i] + [t] + first[i + 1 :] for t in group[1:]]
    for combo in itertools.product(*groups):
        if len(alts) >= cap:
            break
        if list(combo) not in alts:
            alts.append(list(combo))
    return alts[:cap]


def unsearched(parsed, alts):
    """The OR alternatives none of ``alts`` searches: what the cap left out."""
    return [t for g in parsed["groups"] for t in g if not any(t in a for a in alts)]


def term_words(terms):
    """The words to hand an index that knows only words."""
    return " ".join(t["text"] for t in terms)


# Latin, Greek and Cyrillic accents (the Combining Diacritical Marks block):
# what folding drops, so "-wikipedia" also drops "Wikipédia". Only this block:
# a Devanagari vowel sign or an Arabic haraka is part of the word, not an
# accent on it.
_ACCENTS = re.compile("[\u0300-\u036f]")
# Where a word part starts inside a word: "MediaWiki" is Media + Wiki, and
# "devdocs_en_react" is devdocs + en + react.
_PARTS = re.compile(r"(?<=[a-z])(?=[A-Z])|_")


def _unaccent(text):
    nfd = unicodedata.normalize("NFD", text or "")
    return unicodedata.normalize("NFC", _ACCENTS.sub("", nfd))


def fold(text):
    """``text`` lower-cased with its accents dropped, for matching."""
    return _unaccent(text).lower()


def _pattern(text):
    """A term as a regex: from the start of a word, so -ted drops "TED" and
    "TEDx" but not "United"; anywhere in a script without spaces."""
    body = r"\s+".join(re.escape(w) for w in text.split())
    if _UNSPACED.search(text[:1]):
        return re.compile(body)
    return re.compile(r"(?<!\w)" + body)


def excluded(parsed, text):
    """Whether ``text`` holds any excluded term (#94).

    An exclusion matches from the start of a word or of a word part, case and
    accents aside: -wiki drops "Wikipedia", "MediaWiki" (Media + Wiki) and
    "en_wiki", and keeps "Wiktionary", which does not contain "wiki". It does
    not match from just anywhere, or -ted would drop "United States"."""
    if not parsed["exclude"]:
        return False
    bare = _unaccent(text)
    texts = (bare.lower(), _PARTS.sub(" ", bare).lower())
    terms = [_pattern(fold(t["text"])) for t in parsed["exclude"]]
    return any(p.search(low) for p in terms for low in texts)


def phrases_in(terms, text):
    """Whether every phrase among ``terms`` is in ``text``."""
    low = fold(text)
    return all(_pattern(fold(t["text"])).search(low) for t in terms if t["phrase"])



