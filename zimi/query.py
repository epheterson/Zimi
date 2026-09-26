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

import re

# Straight and typographic quotes: a phone keyboard types the latter.
_QUOTES = '"“”„'
# Scripts written without spaces between words. Inside them a word boundary
# means nothing, so an exclusion there matches anywhere in the text.
_UNSPACED = re.compile("[฀-໿က-႟ក-៿぀-ヿ㐀-䶿一-鿿豈-﫿]")
# Operators OR-ed together per group before the searches stop multiplying.
MAX_ALTERNATIVES = 4

# The filters the library search understands. A key maps to its canonical
# name; aliases share one.
LIBRARY_FILTERS = {"in": "source", "source": "source", "lang": "lang"}


def _tokens(q):
    """(text, is_phrase, negated) tuples, in order. OR comes through as
    ("OR", False, False)."""
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
                    out.append((text, True, neg))
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
        out.append((q[start:j], False, False))
        i = j
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
    for text, phrase, neg in _tokens(q or ""):
        if not phrase:
            if text == "OR":
                join_next = bool(groups)
                continue
            if text.startswith("-"):
                text, neg = text.lstrip("-"), True
                if not text:
                    join_next = False
                    continue
            key, sep, value = text.partition(":")
            if sep and value and key.lower() in filters:
                found.append(
                    {"key": filters[key.lower()], "value": value.lower(), "negate": neg}
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


def alternatives(parsed, cap=MAX_ALTERNATIVES):
    """Each way the groups can be satisfied: a list of term lists, at most
    ``cap`` of them (the first alternatives of each group win the budget)."""
    alts = [[]]
    for group in parsed["groups"]:
        alts = [a + [t] for a in alts for t in group][:cap]
    return alts if parsed["groups"] else []


def term_words(terms):
    """The words to hand an index that knows only words."""
    return " ".join(t["text"] for t in terms)


def _pattern(text):
    """A term as a regex: from the start of a word, so -ted drops "TED" and
    "TEDx" but not "United"; anywhere in a script without spaces."""
    body = r"\s+".join(re.escape(w) for w in text.split())
    if _UNSPACED.search(text[:1]):
        return re.compile(body)
    return re.compile(r"(?<!\w)" + body)


def excluded(parsed, text):
    """Whether ``text`` holds any excluded term."""
    low = (text or "").lower()
    return any(_pattern(t["text"]).search(low) for t in parsed["exclude"])


def phrases_in(terms, text):
    """Whether every phrase among ``terms`` is in ``text``."""
    low = (text or "").lower()
    return all(_pattern(t["text"]).search(low) for t in terms if t["phrase"])


def matches(parsed, text):
    """The whole query against one text, the way the catalog applies it:
    a word matches anywhere (as the old filter did, so "wiki" still finds
    Wikipedia), a phrase and an exclusion from the start of a word."""
    low = (text or "").lower()
    for group in parsed["groups"]:
        if not any(
            (_pattern(t["text"]).search(low) if t["phrase"] else t["text"] in low)
            for t in group
        ):
            return False
    return not excluded(parsed, low)
