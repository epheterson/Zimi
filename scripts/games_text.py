#!/usr/bin/env python3
"""Writes ZimiGames' English strings into text.js from text/en.json, so the file is the one source and the
page has its strings before the first paint.

    python3 scripts/games_text.py           rewrite the block in text.js
    python3 scripts/games_text.py --check   exit 1 if text.js is not what text/en.json says, if any string id a game asks
                                            for has no English, if any English nothing asks for is left in the table, or if a
                                            text/<lang>.json lacks an id, has an extra one, or loses or renames a slot

A string id is what a game passes to T() (or TX(), or a data-t attribute). The check reads every games .js and .html file:
- an id with no entry in en.json is an error (a player would see a gap);
- an id built from a prefix (T('pet.did.' + x)) needs at least one entry under the prefix;
- an entry nothing uses is an error. "Used" means its id is written somewhere in the games' code or scripts, or it sits under
  a prefix written there (T('cards.rank.' + n)), or a plain id is written whose id plus one word it is (a helper that adds
  '.you' or 'Hand'): those are the ways ids are built at run time, so a key built another way must be written out once.
"""

import json
import os
import re
import sys

GAMES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "zimi", "builtin", "games")
JSON_PATH = os.path.join(GAMES, "text", "en.json")
JS_PATH = os.path.join(GAMES, "text.js")
ROOT_SCRIPTS = os.path.dirname(os.path.abspath(__file__))
_BLOCK = re.compile(r"/\* en:begin \*/.*?/\* en:end \*/", re.S)


def block():
    with open(JSON_PATH, encoding="utf-8") as f:
        table = json.load(f)
    body = json.dumps(table, ensure_ascii=False, indent=1, sort_keys=True)
    return "/* en:begin */" + body + "/* en:end */"


_ID = re.compile(r"^[a-z][A-Za-z0-9_]*(?:(?:\.[A-Za-z0-9_]+)+\.?|\.)$")
_STRING = re.compile(r"""(['"])((?:\\.|(?!\1)[^\\\n])*)\1""")  # an escape or one plain character: no overlap, no backtracking
_CALL = re.compile(r"(?<![A-Za-z0-9_$])(?:(?:[A-Za-z0-9_$.]*\.)?(?:T|TX|tx|t)|tr)\(")
_DATA_T = re.compile(r'data-t(?:-aria|-title)?="([^"]+)"')
_COMMENTS = re.compile(r"/\*.*?\*/|(?<![:'\"])//[^\n]*", re.S)
_SUFFIX = re.compile(r"^\.?[A-Za-z]+$")


def _first_argument(text, i):
    """The source text of a call's first argument, from just after the opening parenthesis."""
    depth, quote, j = 0, None, i
    while j < len(text):
        c = text[j]
        if quote:
            if c == "\\":
                j += 2
                continue
            if c == quote:
                quote = None
        elif c in "'\"`":
            quote = c
        elif c in "([{":
            depth += 1
        elif c in ")]}":
            if depth == 0:
                break
            depth -= 1
        elif c == "," and depth == 0:
            break
        j += 1
    return text[i:j]


def audit():
    """The problems between the string table and the code that asks for strings (an empty list when clean)."""
    with open(JSON_PATH, encoding="utf-8") as f:
        have = json.load(f)
    asked, prefixes, written = {}, set(), set()
    paths = [os.path.join(GAMES, n) for n in sorted(os.listdir(GAMES)) if n.endswith((".js", ".html", ".json")) and n != "text.js"]
    paths += [os.path.join(ROOT_SCRIPTS, n) for n in sorted(os.listdir(ROOT_SCRIPTS)) if n.endswith(".py")]
    paths.append(JS_PATH)
    paths.append(os.path.join(GAMES, "puzzles", "zimi-fit.js"))   # the puzzles' own wrapper asks for words too
    for path in paths:
        with open(path, encoding="utf-8") as f:
            text = f.read()
        if path == JS_PATH:
            text = _BLOCK.sub("", text)
        for m in _STRING.finditer(text):
            if _ID.match(m.group(2)):
                written.add(m.group(2))
        if not path.endswith((".js", ".html")):
            continue
        name = os.path.basename(path)
        text = _COMMENTS.sub("", text)   # an example in a comment asks for nothing
        for m in _CALL.finditer(text):
            for s in _STRING.finditer(_first_argument(text, m.end())):
                if _ID.match(s.group(2)):
                    if s.group(2).endswith("."):
                        prefixes.add(s.group(2))
                    else:
                        asked.setdefault(s.group(2), set()).add(name)
        for m in _DATA_T.finditer(text):
            if _ID.match(m.group(1)):
                asked.setdefault(m.group(1), set()).add(name)
    problems = []
    for key in sorted(asked):
        if key not in have:
            problems.append("no English for " + key + " (asked by " + ", ".join(sorted(asked[key])) + ")")
    for prefix in sorted(prefixes):
        if not any(k.startswith(prefix) or "." + prefix in k for k in have):   # a prefix may be the middle of an id (fleet. + cpu. + hit)
            problems.append("no English under the prefix " + prefix)
    ends = {w for w in written if w.endswith(".")} | prefixes
    plain = {w for w in written if not w.endswith(".")} | set(asked)
    for key in sorted(have):
        if key in plain or any(key.startswith(p) for p in ends):
            continue
        if any(key.startswith(w) and _SUFFIX.match(key[len(w):]) for w in plain):
            continue
        problems.append("nothing uses " + key)
    return problems


LANGS = ("ar", "de", "es", "fr", "he", "hi", "pt", "ru", "zh")
# Intl.PluralRules categories each language may carry (every plural entry needs "other").
PLURAL_FORMS = {"ar": {"zero", "one", "two", "few", "many", "other"}, "de": {"one", "other"}, "es": {"one", "many", "other"},
                "fr": {"one", "many", "other"}, "he": {"one", "two", "other"}, "hi": {"one", "other"}, "pt": {"one", "many", "other"},
                "ru": {"one", "few", "many", "other"}, "zh": {"other"}}
_SLOT = re.compile(r"\{(\w+)\}")


def _slots(value):
    return set(_SLOT.findall(value))


def translation_problems(lang, have, table):
    """What is wrong with one language file next to English: a missing id, an extra id, a slot that is lost or renamed,
    a plural entry that is not one (or the other way round), or a plural category the language does not have."""
    out = []
    for key in sorted(set(have) - set(table)):
        out.append(lang + ": missing " + key)
    for key in sorted(set(table) - set(have)):
        out.append(lang + ": extra " + key)
    for key in sorted(set(have) & set(table)):
        en, tr = have[key], table[key]
        if isinstance(en, dict) != isinstance(tr, dict):
            out.append(lang + ": " + key + " must be " + ("a plural entry" if isinstance(en, dict) else "a plain string"))
            continue
        forms_en = en if isinstance(en, dict) else {"": en}
        forms_tr = tr if isinstance(tr, dict) else {"": tr}
        if "other" not in forms_tr and isinstance(tr, dict):
            out.append(lang + ": " + key + " has no 'other' form")
        for form, v in forms_tr.items():
            if not isinstance(v, str) or not v.strip():
                out.append(lang + ": " + key + " has an empty form " + form)
            elif isinstance(tr, dict) and form not in PLURAL_FORMS.get(lang, {"one", "other"}):
                out.append(lang + ": " + key + " has a plural form " + form + " that " + lang + " does not use")
        want = set().union(*[_slots(v) for v in forms_en.values()])
        got = set().union(*[_slots(v) for v in forms_tr.values() if isinstance(v, str)])
        if want != got:
            out.append(lang + ": " + key + " slots " + str(sorted(got)) + " but English has " + str(sorted(want)))
        elif isinstance(tr, dict):
            for form, v in forms_tr.items():
                if isinstance(v, str) and not _slots(v) <= want:
                    out.append(lang + ": " + key + "." + form + " has a slot English does not")
    return out


def translations_audit():
    """The problems in every text/<lang>.json that exists, for the languages Zimi ships."""
    with open(JSON_PATH, encoding="utf-8") as f:
        have = json.load(f)
    out = []
    for lang in LANGS:
        path = os.path.join(GAMES, "text", lang + ".json")
        if not os.path.exists(path):
            out.append(lang + ": text/" + lang + ".json is missing")
            continue
        with open(path, encoding="utf-8") as f:
            out += translation_problems(lang, have, json.load(f))
    return out


def main():
    with open(JS_PATH, encoding="utf-8") as f:
        text = f.read()
    new = _BLOCK.sub(lambda m: block(), text, count=1)
    if "--check" in sys.argv:
        if new != text:
            print("text.js is out of date: run scripts/games_text.py")
            raise SystemExit(1)
        problems = audit() + translations_audit()
        if problems:
            print("\n".join(problems))
            raise SystemExit(1)
        print("text.js is current and every string id has its English and its nine translations")
        return
    if new != text:
        with open(JS_PATH, "w", encoding="utf-8", newline="\n") as f:
            f.write(new)
    print("text.js written")


if __name__ == "__main__":
    main()
