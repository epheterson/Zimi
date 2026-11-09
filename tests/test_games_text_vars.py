"""Every {placeholder} in a games string gets a value at the call site.

Found by playing Go Fish to its end: the loser's sheet read "Zimi wins with {books}", because the call passed n and the string wants books.
The check reads each TX('key', { ... }) call in the games' scripts and holds its object to the English string's placeholders.

Run: pytest tests/test_games_text_vars.py -v
"""

import glob
import json
import os
import re

GAMES = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "zimi",
    "builtin",
    "games",
)
CALL = re.compile(r"\bT[XT]?\(\s*'([A-Za-z0-9_.]+)'\s*,\s*\{")
# A call that blanks a placeholder on purpose, to cut the word before it out of the sentence.
ON_PURPOSE = {("blackjack.js", "bj.line.you", "word")}


def _top_level(body):
    depth, out = 0, []
    for ch in body:
        if ch in "{[(":
            depth += 1
        elif ch in "}])":
            depth -= 1
        elif depth == 0:
            out.append(ch)
    return "".join(out)


def _object_at(src, brace):
    depth = 0
    for j in range(brace, len(src)):
        if src[j] == "{":
            depth += 1
        elif src[j] == "}":
            depth -= 1
            if depth == 0:
                return src[brace + 1 : j]
    return ""


def test_every_placeholder_of_a_games_string_is_given_a_value():
    with open(os.path.join(GAMES, "text", "en.json"), encoding="utf-8") as f:
        en = json.load(f)
    missing = []
    scripts = glob.glob(os.path.join(GAMES, "*.js")) + glob.glob(
        os.path.join(GAMES, "puzzles", "*.js")
    )
    for path in sorted(scripts):
        if path.endswith("text.js"):
            continue
        with open(path, encoding="utf-8") as f:
            src = f.read()
        for m in CALL.finditer(src):
            key = m.group(1)
            if key not in en:
                continue
            given = set(
                re.findall(
                    r"(?:^|,)\s*([A-Za-z_]\w*)\s*(?::|,|$)",
                    _top_level(_object_at(src, m.end() - 1)),
                )
            )
            values = en[key].values() if isinstance(en[key], dict) else [en[key]]
            wanted = {p for v in values for p in re.findall(r"\{(\w+)\}", v)}
            for name in sorted(wanted - given):
                if (os.path.basename(path), key, name) not in ON_PURPOSE:
                    missing.append(
                        "%s: %s needs {%s}" % (os.path.basename(path), key, name)
                    )
    assert not missing, "\n".join(missing)
