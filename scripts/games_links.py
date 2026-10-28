#!/usr/bin/env python3
"""Writes ZimiGames' "About" links from zimi/builtin/games/games.json, so no
page is edited by hand and none can drift from the Q-ID list.

    python3 scripts/games_links.py          rewrite the pages in place

Each game page gets one footer link, ``about.html?qid=Q718``, between two
markers (rewritten, never doubled). ``about.html`` is a plain page that says
what the game is and links to play it, so the link is never dead in Kiwix;
Zimi's reader catches the same link and opens the encyclopedia article in the
reader's language instead (app.js, _gamesAbout).
"""

import html
import json
import os
import re

GAMES = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "zimi", "builtin", "games"
)
OPEN, CLOSE = "<!-- zimi-about -->", "<!-- /zimi-about -->"
_BLOCK = re.compile(re.escape(OPEN) + r".*?" + re.escape(CLOSE) + r"\n?", re.S)


def load():
    with open(os.path.join(GAMES, "games.json"), encoding="utf-8") as f:
        return json.load(f)


def primary_by_path(rows):
    """The first entry of each page: the article its About link stands for."""
    out = {}
    for r in rows:
        out.setdefault(r["path"], r)
    return out


def about_key(row):
    """What about.html looks a game up by: its Q-ID, or (a puzzle with no encyclopedia article) its page."""
    return row.get("qid") or row["path"]


def footer(row):
    up = "../" * row["path"].count("/")
    link = f'about.html?qid={row["qid"]}' if row.get("qid") else f'about.html#game={row["path"]}'
    return (
        f'{OPEN}<footer class="gm-about"><a href="{up}{link}">'
        f'About {html.escape(row["title"])}</a></footer>{CLOSE}\n'
    )


def stamp(path, row):
    with open(path, encoding="utf-8") as f:
        text = f.read()
    text = _BLOCK.sub("", text)
    if "</body>" not in text:
        raise SystemExit(f"{path}: no </body>")
    text = text.replace("</body>", footer(row) + "</body>", 1)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)


ABOUT = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="zimi-app">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>About - ZimiGames</title>
<link rel="stylesheet" href="games.css">
<meta name="zimi-games-host"><script src="shell.js"></script>
</head>
<body>
<header class="ar-bar">
  <a class="ar-back" href="index.html" aria-label="Back to ZimiGames">&lsaquo;</a>
  <h1 id="ab-title">About</h1>
</header>
<main class="gm-about-page">
  <p id="ab-blurb"></p>
  <p><a class="ar-btn gm-play" id="ab-play" href="index.html">Play</a></p>
  <section id="ab-credit" hidden>
    <h2>Credit</h2>
    <p>This puzzle is part of Simon Tatham’s Portable Puzzle Collection, copyright 2004–2024 Simon Tatham and many contributors, under the MIT licence. ZimiGames adds the page around it and runs it unchanged.</p>
    <p><a id="ab-licence" href="puzzles/LICENCE">The licence</a> · <a id="ab-manual" href="puzzles/doc/">The manual page</a></p>
  </section>
  <section id="ab-art" hidden>
    <h2>Credit</h2>
    <p id="ab-art-f" hidden>The French deck’s jacks, queens and kings are from Adrian Kennard’s SVG playing cards (<a href="https://www.me.uk/cards/">me.uk/cards</a>), released into the public domain under CC0 1.0, recoloured to the deck’s palette. The court designs follow the 19th-century Goodall &amp; Son pattern.</p>
    <p id="ab-art-s" hidden>The Spanish deck’s sota, caballo and rey are from the Spanish-suited pack printed by B. P. Grimaud in 1860, as scanned by the Bibliothèque nationale de France (<a href="https://gallica.bnf.fr/ark:/12148/btv1b10513825g">Gallica</a>) and published on Wikimedia Commons. A 19th-century print, in the public domain; cropped, with the printed corner numbers painted out in the paper’s own colour.</p>
    <p id="ab-art-h" hidden>The Hanafuda cards are Louie Mantia’s SVG Hanafuda from <a href="https://commons.wikimedia.org/wiki/Category:SVG_Hanafuda_with_traditional_colors_(red_border)">Wikimedia Commons</a>, licensed <a href="https://creativecommons.org/licenses/by-sa/4.0/">CC BY-SA 4.0</a>. Changes: the paper backing and clip removed, the paths rounded, the whites, blacks, reds and ambers set to the deck’s palette. The adapted art is shared under the same licence.</p>
    <p id="ab-art-i" hidden>The card indexes (A, 2 to 10, J, Q, K) are the outlines of Barlow Semi Condensed ExtraBold, Copyright 2017 The Barlow Project Authors (<a href="https://github.com/jpt/barlow">github.com/jpt/barlow</a>), licensed under the <a href="OFL-Barlow.txt">SIL Open Font License, Version 1.1</a>. The outlines are cut from the font and set as drawings; no font file is shipped, and two-digit ranks are narrowed to fit.</p>
  </section>
</main>
<script>
(function () {
  var games = %s;
  // Zimi's reader opens this page as about.html#qid=Q718 (a ZIM path takes no query).
  var q = new URLSearchParams(location.search).get('qid') || (location.hash.match(/Q\\d+/) || [])[0];
  var g = games[q] || games[(location.hash.match(/game=([^&]+)/) || [])[1]];
  if (!g) return;
  ZimiShell.setTitle('About ' + g.title);
  document.getElementById('ab-title').textContent = g.title;
  document.getElementById('ab-blurb').textContent = g.blurb;
  var play = document.getElementById('ab-play');
  play.href = g.path;
  play.textContent = 'Play ' + g.title;
  var m = /^puzzles\\/([a-z]+)\\.html$/.exec(g.path);
  if (m) {
    document.getElementById('ab-manual').href = 'puzzles/doc/' + m[1] + '.html';
    document.getElementById('ab-credit').hidden = false;
  }
  (g.art || '').split('').forEach(function (c) {
    document.getElementById('ab-art-' + c).hidden = false;
    document.getElementById('ab-art').hidden = false;
  });
})();
</script>
</body>
</html>
"""


# The art files a page loads, and the credit letter each one earns on its About page.
ART_FILES = {"courts.js": "f", "courts-es.js": "s", "hanafuda-art.js": "h", "cards.js": "i"}


def art_credits(path):
    """The credit letters for the art files a game page loads ("" for most pages)."""
    with open(os.path.join(GAMES, path), encoding="utf-8") as f:
        text = f.read()
    return "".join(c for name, c in ART_FILES.items() if f'src="{name}"' in text)


def write_about(rows):
    table = {
        about_key(r): {
            "path": r["path"],
            "title": r["title"],
            "blurb": r["blurb"],
            **({"art": art_credits(r["path"])} if art_credits(r["path"]) else {}),
        }
        for r in rows
    }
    body = json.dumps(table, ensure_ascii=False, separators=(",", ":")).replace(
        "</", "<\\/"
    )
    with open(
        os.path.join(GAMES, "about.html"), "w", encoding="utf-8", newline="\n"
    ) as f:
        f.write(ABOUT % body)


def main():
    rows = load()
    for path, row in primary_by_path(rows).items():
        stamp(os.path.join(GAMES, path), row)
    write_about(rows)
    print(f"{len(primary_by_path(rows))} pages stamped, about.html written")


if __name__ == "__main__":
    main()
