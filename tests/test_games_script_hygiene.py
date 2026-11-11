"""No function is declared twice in one scope of a games script.

A second `function name()` at the same level silently replaces the first (declarations hoist): shell.js once got a credit-line
loader named loadScript that replaced the page's own loadScript, and Watch and learn stopped starting in every game.

Run: pytest tests/test_games_script_hygiene.py -v
"""

import glob
import os
import re

import pytest

GAMES = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "zimi",
    "builtin",
    "games",
)
DECL = re.compile(r"^(\s*)function\s+([A-Za-z_$][\w$]*)\s*\(", re.M)
SCRIPTS = sorted(
    glob.glob(os.path.join(GAMES, "*.js"))
    + glob.glob(os.path.join(GAMES, "puzzles", "*.js"))
)


def _duplicates(text):
    """(indent, name) pairs declared twice with the same indent, and no `})(`-style scope close between them (same IIFE)."""
    seen, dup = {}, []
    for m in DECL.finditer(text):
        key = (len(m.group(1)), m.group(2))
        if key in seen:
            between = text[seen[key] : m.start()]
            # A line closing the scope the first one sat in (less indented than it) means a different scope.
            closes = [
                ln
                for ln in between.split("\n")
                if ln.strip() and len(ln) - len(ln.lstrip()) < key[0]
            ]
            if not closes:
                dup.append(key[1])
        seen[key] = m.start()
    return dup


@pytest.mark.parametrize("path", SCRIPTS, ids=lambda p: os.path.relpath(p, GAMES))
def test_no_function_is_declared_twice_in_one_scope(path):
    with open(path, encoding="utf-8") as f:
        assert _duplicates(f.read()) == []


def test_the_guard_sees_the_shell_bug():
    two = "  function loadScript(src, done) {}\n  var x = 1;\n  function loadScript(name, then) {}\n"
    assert _duplicates(two) == ["loadScript"]
    assert _duplicates("  function a() {\n  }\n}\n  function a() {}\n") == []
