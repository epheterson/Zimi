"""Two tiny encyclopedias for the games' two-way links (tests/test_games_links.spec.mjs):
an English and a French Wikipedia whose pages carry their Wikidata Q-ID the way
mwoffliner pages do (``wikidata.org/wiki/Q718#identifiers``), one of them a game
ZimiGames has (Chess) and one that is not (Cat).

    python3 tests/make_wiki_games_fixture.py <dir>    # makes <dir>/zims/wikipedia_{en,fr}_test.zim

Real Zimi needs nothing else: the games' own ZIM is built in.
"""

import os
import shutil
import sys

from zimi import creator

PAGE = """<!doctype html><html lang="{lang}"><head><meta charset="utf-8"><title>{title}</title></head>
<body><h1>{title}</h1><p>{body}</p><p>{pad}</p>
<a href="https://www.wikidata.org/wiki/{qid}#identifiers">Wikidata item</a></body></html>"""

#: lang -> [(file, title, Q-ID)]; Q718 is Chess, Q146 is Cat, Q405 is the Moon (the Almanac's)
ARTICLES = {
    "en": [("Chess.html", "Chess", "Q718"), ("Cat.html", "Cat", "Q146"), ("Moon.html", "Moon", "Q405")],
    "fr": [("Echecs.html", "Echecs", "Q718"), ("Chat.html", "Chat", "Q146"), ("Lune.html", "Lune", "Q405")],
}


def build(base):
    out = os.path.join(os.path.abspath(base), "zims")
    shutil.rmtree(out, ignore_errors=True)
    os.makedirs(out)
    for lang, pages in ARTICLES.items():
        src = os.path.join(os.path.abspath(base), "src_" + lang)
        shutil.rmtree(src, ignore_errors=True)
        os.makedirs(src)
        for fn, title, qid in pages:
            with open(os.path.join(src, fn), "w", encoding="utf-8") as f:
                f.write(
                    PAGE.format(
                        lang=lang,
                        title=title,
                        qid=qid,
                        body="An article about %s." % title,
                        pad="Plain filler so the page is longer than the 2000 bytes a Q-ID read needs. "
                        * 30,
                    )
                )
        with open(os.path.join(src, "zimi.txt"), "w", encoding="utf-8") as f:
            f.write(
                "Title: Wikipedia (%s test)\nDescription: test\nLanguage: %s\nCreator: test\nPublisher: test\n"
                % (lang, "eng" if lang == "en" else "fra")
            )
        creator.create_folder_zim(
            src,
            out_path=os.path.join(out, "wikipedia_%s_test.zim" % lang),
            register=False,
        )
        shutil.rmtree(src)
    return out


if __name__ == "__main__":
    print(build(sys.argv[1]))
