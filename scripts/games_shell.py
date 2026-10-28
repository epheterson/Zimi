#!/usr/bin/env python3
"""Gives every ZimiGames game page the shell: one bar, one Menu, the shared settings.

    python3 scripts/games_shell.py          rewrite the pages in place

Each game page (every page of the games' folder except the shelf, the About
page and the puzzles list, and the Tatham puzzles in puzzles/, whose pages are
made by scripts/games_puzzles.py and take the scripts from ../) gets
``shell.js`` between two markers at the end of <head>,
rewritten and never doubled. The scripts are synchronous on purpose: the
settings must be on <html> before the first paint.
"""

import glob
import os
import re

GAMES = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "zimi", "builtin", "games"
)
OPEN, CLOSE = "<!-- zimi-shell -->", "<!-- /zimi-shell -->"
_BLOCK = re.compile(
    r"[ \t]*" + re.escape(OPEN) + r".*?" + re.escape(CLOSE) + r"\n?", re.S
)
NOT_GAMES = {"index.html", "about.html", "puzzles.html"}
TAG = f'{OPEN}<script src="shell.js"></script>{CLOSE}\n'
PUZZLE_TAG = f'{OPEN}<script src="../shell.js"></script>{CLOSE}\n'


def pages():
    """Game pages of the games' folder: "chess.html"."""
    found = (os.path.basename(p) for p in glob.glob(os.path.join(GAMES, "*.html")))
    return sorted(p for p in found if p not in NOT_GAMES)


def puzzle_pages():
    """The Tatham puzzles: "puzzles/fifteen.html"."""
    found = (os.path.basename(p) for p in glob.glob(os.path.join(GAMES, "puzzles", "*.html")))
    return sorted("puzzles/" + p for p in found)


def stamp(page):
    full = os.path.join(GAMES, page)
    tag = PUZZLE_TAG if page.startswith("puzzles/") else TAG
    with open(full, encoding="utf-8") as f:
        text = _BLOCK.sub("", f.read())
    if "</head>" not in text:
        raise SystemExit(f"{page}: no </head>")
    text = text.replace("</head>", tag + "</head>", 1)
    with open(full, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)


def main():
    found = pages() + puzzle_pages()
    for p in found:
        stamp(p)
    print(f"{len(found)} pages stamped")


if __name__ == "__main__":
    main()
