#!/usr/bin/env python3
"""Gives every ZimiGames game page the one script that notes it as played.

    python3 scripts/games_recent.py          rewrite the pages in place

Each game page (every page of the games' folder and of puzzles/ except the
shelf, the About page and the puzzles list) gets ``recent.js`` between two
markers, rewritten and never doubled. The shelf loads it by hand (index.html):
there it draws Continue and Game of the day instead of noting a game.
"""

import glob
import os
import re

GAMES = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "zimi", "builtin", "games"
)
OPEN, CLOSE = "<!-- zimi-recent -->", "<!-- /zimi-recent -->"
_BLOCK = re.compile(re.escape(OPEN) + r".*?" + re.escape(CLOSE) + r"\n?", re.S)
NOT_GAMES = {"index.html", "about.html", "puzzles.html"}


def pages():
    """Paths from the games' folder: "chess.html", "puzzles/fifteen.html"."""
    found = glob.glob(os.path.join(GAMES, "*.html")) + glob.glob(
        os.path.join(GAMES, "puzzles", "*.html")
    )
    rel = (os.path.relpath(p, GAMES).replace(os.sep, "/") for p in found)
    return sorted(p for p in rel if p not in NOT_GAMES)


def tag(path):
    up = "../" * path.count("/")
    return f'{OPEN}<script defer src="{up}recent.js"></script>{CLOSE}\n'


def stamp(path):
    full = os.path.join(GAMES, path)
    with open(full, encoding="utf-8") as f:
        text = _BLOCK.sub("", f.read())
    if "</body>" not in text:
        raise SystemExit(f"{path}: no </body>")
    text = text.replace("</body>", tag(path) + "</body>", 1)
    with open(full, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)


def main():
    found = pages()
    for p in found:
        stamp(p)
    print(f"{len(found)} pages stamped")


if __name__ == "__main__":
    main()
