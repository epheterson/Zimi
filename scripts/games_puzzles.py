#!/usr/bin/env python3
"""Makes each of the 41 Tatham puzzle pages a ZimiGames page.

    python3 scripts/games_puzzles.py          rewrite puzzles/*.html in place (idempotent)

The puzzle's own code (puzzles/<name>.js and .wasm) is never touched. A page keeps what the frontend looks
for by id (its menu form, the canvas, the status bar, the resize handle, the permalinks it writes to) and loses
everything else: the title block, the upstream links, the author's e-mail, the small-print credit and the
"last modified" line. The credit and the MIT licence are on the About page (about.html). zimi-fit.js and
zimi-fit.css do the rest, and ../shell.js gives the page its bar and Menu.
"""

import glob
import os
import re

GAMES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "zimi", "builtin", "games")
PUZZLES = os.path.join(GAMES, "puzzles")

PAGE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>{name} - ZimiGames</title>
<link rel="stylesheet" href="zimi-fit.css"><script defer src="zimi-fit.js"></script>
<script defer type="text/javascript" src="{script}"></script>
{style}
<!-- zimi-shell --><script src="../shell.js"></script><!-- /zimi-shell -->
{extra}</head>
<body>
<main id="puzzle" style="display: none">
{form}
  <div id="resizable">
  <canvas id="puzzlecanvas" tabindex="0"></canvas>
{statusbar}  {handle}
  </div>
</main>
<p id="apology">This puzzle needs WebAssembly, and this browser has it turned off or does not have it.</p>
{recent}
{about}
</body>
</html>
"""


def grab(pattern, text, what, page):
    m = re.search(pattern, text, re.S)
    if not m:
        raise SystemExit(f"{page}: no {what}")
    return m.group(0)


def keep(pattern, text):
    """A marked block some pages have and some do not."""
    m = re.search(pattern, text, re.S)
    return m.group(0) if m else ""


def others(text):
    """Any other marked block a stamping script put in the page (not the three below): kept, in <head>."""
    found = re.finditer(r"<!-- (zimi-[a-z-]+) -->.*?<!-- /\1 -->\n?", text, re.S)
    return "".join(m.group(0) for m in found if m.group(1) not in ("zimi-shell", "zimi-recent", "zimi-about"))


def rewrite(path):
    page = os.path.basename(path)
    with open(path, encoding="utf-8") as f:
        text = f.read()
    title = grab(r"<title>(.*?)</title>", text, "title", page)
    name = re.sub(r"<title>|</title>", "", title)
    name = re.sub(r",( an unfinished puzzle)? from Simon Tatham.*$| - ZimiGames$", "", name).strip()
    script = re.search(r'<script defer type="text/javascript" src="([^"]+)"', text).group(1)
    new = PAGE.format(
        name=name,
        script=script,
        style=grab(r"<style>.*?</style>", text, "style", page),
        form=grab(r'<form id="gamemenu">.*?</form>', text, "menu form", page),
        statusbar='  <div id="statusbar"></div>\n' if 'id="statusbar"' in text else "",
        handle=re.sub(r"\s+", " ", grab(r'<svg id="resizehandle".*?</svg>', text, "resize handle", page)),
        extra=others(text),
        recent=keep(r"<!-- zimi-recent -->.*?<!-- /zimi-recent -->", text),
        about=keep(r"<!-- zimi-about -->.*?<!-- /zimi-about -->", text),
    )
    if new != text:
        with open(path, "w", encoding="utf-8", newline="\n") as f:
            f.write(new)
    return name


def main():
    pages = sorted(glob.glob(os.path.join(PUZZLES, "*.html")))
    names = [rewrite(p) for p in pages]
    print(f"{len(names)} puzzle pages rewritten")


if __name__ == "__main__":
    main()
