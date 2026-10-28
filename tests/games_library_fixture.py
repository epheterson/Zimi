"""A small library for the games that draw on the player's own ZIMs (builtin/games: Wiki Race,
Letter by Letter, Quizzical, Jigsaw, Where in the World, Five Letters).

    python3 tests/games_library_fixture.py <dir>    # writes <dir>/zims/*.zim and <dir>/zims2/*.zim

zims/ is the library of the first six games. zims2/ is a second one for Timeline, Higher or Lower, Flags, First Lines,
Spelling Bee and Mini Crossword (build_more): a Wikipedia with date pages, the lists those games read and flag pictures, a
Wiktionary with every word of the crossword's pool, and a Gutenberg. It is kept apart so the date and list pages never turn
up among the random articles the first six games draw.

An English and a French Wikipedia whose articles link to each other and carry a lead sentence
(some a picture), an English and a French Wiktionary with five-letter words, and a map with a
place index. Pages are in mwoffliner's shape (relative ./Title links, ./I/ pictures).
"""

import json
import os
import re
import shutil
import struct
import sys
import zlib

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from libzim.writer import Creator  # noqa: E402

from wiki_fixture import MW, _Page, page  # noqa: E402

#: title -> (lead sentence, [links], picture colour or None)
EN = {
    "Paris": (
        "Paris is the capital and largest city of France.",
        ["France", "Seine", "Europe"],
        (200, 120, 90),
    ),
    "France": (
        "France is a country in Western Europe.",
        ["Paris", "Europe", "Germany"],
        (60, 90, 200),
    ),
    "Germany": (
        "Germany is a country in Central Europe.",
        ["Berlin", "Europe", "France", "Albert Einstein"],
        None,
    ),
    "Berlin": (
        "Berlin is the capital and largest city of Germany.",
        ["Germany", "Europe"],
        (90, 160, 90),
    ),
    "Europe": (
        "Europe is a continent located entirely in the Northern Hemisphere.",
        ["France", "Germany", "Asia", "Earth"],
        None,
    ),
    "Asia": (
        "Asia is the largest continent on Earth.",
        ["Europe", "Himalayas", "Earth"],
        None,
    ),
    "Himalayas": (
        "The Himalayas are a mountain range in Asia.",
        ["Asia", "Mount Everest"],
        (170, 190, 220),
    ),
    "Mount Everest": (
        "Mount Everest is the highest mountain above sea level.",
        ["Himalayas", "Earth"],
        (230, 230, 240),
    ),
    "Seine": (
        "The Seine is a river in northern France.",
        ["Paris", "France", "Water"],
        None,
    ),
    "Water": (
        "Water is an inorganic compound with the chemical formula H2O.",
        ["Energy", "Earth", "Seine"],
        (40, 120, 190),
    ),
    "Energy": (
        "Energy is the quantitative property that must be transferred to do work.",
        ["Physics", "Water", "Sun"],
        None,
    ),
    "Physics": (
        "Physics is the natural science of matter, motion and energy.",
        ["Energy", "Albert Einstein", "Moon"],
        None,
    ),
    "Albert Einstein": (
        "Albert Einstein was a German-born theoretical physicist.",
        ["Physics", "Germany", "Energy"],
        (120, 120, 120),
    ),
    "Earth": (
        "Earth is the third planet from the Sun.",
        ["Sun", "Moon", "Water", "Solar System"],
        (50, 110, 170),
    ),
    "Moon": (
        "The Moon is Earth's only natural satellite.",
        ["Earth", "Sun", "Solar System"],
        (180, 180, 170),
    ),
    "Sun": (
        "The Sun is the star at the center of the Solar System.",
        ["Earth", "Moon", "Solar System", "Energy"],
        (240, 190, 60),
    ),
    "Solar System": (
        "The Solar System is the gravitationally bound system of the Sun and the objects that orbit it.",
        ["Sun", "Earth", "Moon"],
        None,
    ),
    "Cat": (
        "The cat is a small carnivorous mammal.",
        ["Mammal", "Animal"],
        (190, 140, 80),
    ),
    "Mammal": (
        "A mammal is a vertebrate animal of the class Mammalia.",
        ["Animal", "Cat"],
        None,
    ),
    "Animal": (
        "Animals are multicellular eukaryotic organisms.",
        ["Mammal", "Cat", "Earth"],
        None,
    ),
    "Chess": (
        "Chess is a board game for two players.",
        ["Game", "Europe"],
        (110, 80, 60),
    ),
    "Game": ("A game is a structured form of play.", ["Chess", "Physics"], None),
}
FR = {
    "Paris": (
        "Paris est la capitale de la France.",
        ["France", "Seine"],
        (200, 120, 90),
    ),
    "France": (
        "La France est un pays d'Europe de l'Ouest.",
        ["Paris", "Seine", "Europe"],
        None,
    ),
    "Seine": (
        "La Seine est un fleuve du nord de la France.",
        ["Paris", "France"],
        None,
    ),
    "Europe": (
        "L'Europe est un continent de l'hémisphère nord.",
        ["France", "Paris"],
        (70, 140, 100),
    ),
    "Lyon": ("Lyon est une ville de France.", ["France", "Rhône"], (150, 100, 60)),
    "Rhône": ("Le Rhône est un fleuve de Suisse et de France.", ["Lyon", "France"], None),
    "Marseille": ("Marseille est une ville du sud de la France.", ["France", "Rhône"], (60, 150, 190)),
    "Alpes": ("Les Alpes sont une chaîne de montagnes d'Europe.", ["France", "Europe"], (200, 210, 230)),
    "Chat": (
        "Le chat est un petit mammifère carnivore.",
        ["Europe", "France"],
        (190, 140, 80),
    ),
}

WORDS_EN = {
    "table": "A piece of furniture with a flat top and legs.",
    "chair": "A seat for one person, with a back.",
    "water": "A clear liquid that falls as rain and fills rivers.",
    "house": "A building where people live.",
    "plant": "A living thing that grows in soil and makes its food from light.",
    "bread": "A food made by baking flour and water.",
    "stone": "A hard piece of rock.",
    "cloud": "A mass of tiny drops of water floating in the sky.",
    "river": "A large natural stream of water.",
    "light": "What lets us see; the opposite of dark.",
    "music": "Sounds arranged to be pleasant to hear.",
    "green": "The colour of grass.",
    "horse": "A large animal people ride.",
    "night": "The dark part of the day.",
    "ocean": "A very large body of salt water.",
    "paper": "A thin material for writing on.",
    "queen": "A woman who rules a country.",
    "sheep": "A woolly farm animal.",
    "smile": "A happy look on the face.",
    "train": "Railway carriages pulled by an engine.",
    "wheel": "A round thing that turns to move a cart.",
    "world": "The earth and everything on it.",
    "bridge": "A structure that carries a road over a river.",
    "garden": "A piece of ground where flowers and vegetables grow.",
}
WORDS_FR = {
    "arbre": "Grande plante ligneuse à tronc.",
    "livre": "Ensemble de pages reliées que l'on lit.",
    "nuage": "Amas de gouttelettes en suspension dans l'air.",
    "pomme": "Fruit rond du pommier.",
    "terre": "Planète où vivent les humains.",
    "monde": "L'ensemble de la Terre et de ses habitants.",
    "fleur": "Partie colorée d'une plante.",
    "ciel": "Espace au-dessus de nous.",
    "route": "Voie faite pour les voitures.",
    "lune": "Satellite naturel de la Terre.",
    "neige": "Eau congelée qui tombe en flocons.",
    "vache": "Femelle du taureau.",
    "forêt": "Grande étendue couverte d'arbres.",
}


def _picture(w, h, rgb):
    """A PNG with something to look at: a gradient from the colour to white with a ring and a diagonal band,
    so jigsaw pieces are told apart."""
    rows = []
    cx, cy = w * 0.5, h * 0.5
    for y in range(h):
        row = bytearray(b"\x00")
        for x in range(w):
            t = (x / w + y / h) / 2
            r, g, b = (int(c + (255 - c) * t * 0.7) for c in rgb)
            d = ((x - cx) ** 2 + (y - cy) ** 2) ** 0.5
            if abs(d - h * 0.3) < 6:
                r, g, b = 255 - r, 255 - g, 255 - b
            if (x - y) % 90 < 10:
                r, g, b = r // 2, g // 2, b // 2
            row += bytes((r, g, b))
        rows.append(bytes(row))

    def chunk(kind, data):
        return (
            struct.pack(">I", len(data))
            + kind
            + data
            + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
        )

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(b"".join(rows)))
        + chunk(b"IEND", b"")
    )


def _slug(t):
    return t.replace(" ", "_")


def _article(lang, title, lead, links, rgb, titles=()):
    pic = ""
    if rgb:
        pic = (
            '<figure typeof="mw:File/Thumb"><a href="./File:%s.png"><img src="./I/%s.png" width="400" height="300" alt="%s"></a>'
            "<figcaption>%s</figcaption></figure>"
            % (_slug(title), _slug(title), title, title)
        )
    titles = list(titles)
    at = titles.index(title) if title in titles else 0
    # A real article links to a good many others: the named ones, then the next few of the library.
    more = [titles[(at + k) % len(titles)] for k in range(1, 7) if titles]
    shown = list(dict.fromkeys(list(links) + [m for m in more if m != title]))
    nav = " ".join(
        '<a rel="mw:WikiLink" href="./%s" title="%s">%s</a>.'
        % (_slug(link), link, link)
        for link in shown
    )
    body = (
        '<section data-mw-section-id="0">%s<p>%s</p><p>See also %s</p>'
        '<p>An <a rel="mw:WikiLink/Interwiki" href="https://www.wikidata.org/wiki/Q1" class="extiw">outside link</a>, '
        '<a href="./Category:Things" rel="mw:WikiLink">a category</a> and <a href="#cite_note-1">a note</a>.</p></section>'
        % (
            pic,
            lead,
            nav,
        )
    )
    return page(title, body, lang=lang)


def _wiki(path, name, title, lang, lang3, articles, main="Main_Page", extra=()):
    with Creator(path).config_indexing(True, lang3) as c:
        c.set_mainpath(main)
        front = " ".join(
            '<a rel="mw:WikiLink" href="./%s">%s</a>' % (_slug(t), t) for t in articles
        )
        c.add_item(
            _Page(
                main,
                "Main Page",
                page("Main Page", "<p>Welcome. %s</p>" % front, lang=lang),
            )
        )
        for t, (lead, links, rgb) in articles.items():
            c.add_item(
                _Page(_slug(t), t, _article(lang, t, lead, links, rgb, list(articles)))
            )
            if rgb:
                c.add_item(
                    _Page(
                        "I/%s.png" % _slug(t),
                        t + ".png",
                        _picture(400, 300, rgb),
                        "image/png",
                    )
                )
        for e_path, e_title, e_blob, e_mime in extra:
            c.add_item(_Page(e_path, e_title, e_blob, e_mime))
        for k, v in {
            "Scraper": MW,
            "Name": name,
            "Language": lang3,
            "Title": title,
            "Description": title,
        }.items():
            c.add_metadata(k, v)


def _word_page(lang, word, gloss, pos, heading):
    body = (
        '<section><div class="mw-heading mw-heading2"><h2 id="%s">%s</h2></div>'
        '<section><div class="mw-heading mw-heading3"><h3 id="%s">%s</h3></div>'
        '<p><strong class="Latn headword" lang="%s">%s</strong></p><ol><li>%s</li></ol></section></section>'
        % (heading, heading, pos, pos, lang, word, gloss)
    )
    return page(word, body, lang=lang)


def _wikt(path, name, title, lang, lang3, words, heading, pos, extra=()):
    with Creator(path).config_indexing(True, lang3) as c:
        c.set_mainpath("Main_Page")
        c.add_item(
            _Page(
                "Main_Page",
                "Main Page",
                page("Main Page", "<p>Welcome.</p>", lang=lang),
            )
        )
        for w, gloss in words.items():
            c.add_item(_Page(w, w, _word_page(lang, w, gloss, pos, heading)))
        for e_path, e_title, e_blob in extra:
            c.add_item(_Page(e_path, e_title, e_blob))
        for k, v in {
            "Scraper": MW,
            "Name": name,
            "Language": lang3,
            "Title": title,
            "Description": title,
        }.items():
            c.add_metadata(k, v)


def _map(path):
    from conftest_zim import build_fixture_zim

    def place(n, la, lo, s="city"):
        return {"n": n, "t": "place", "a": la, "o": lo, "s": s}

    files = {
        "search-data/manifest.json": json.dumps(
            {"chunks": {"pa": 2, "to": 2}, "sub_chunks": {}}
        ).encode(),
        "search-data/pa.json": json.dumps(
            [place("Paris", 48.8567, 2.3508), place("Pau", 43.3, -0.37, "town")]
        ).encode(),
        "search-data/to.json": json.dumps(
            [place("Tokyo", 35.68, 139.69), place("Toronto", 43.65, -79.38)]
        ).encode(),
    }
    build_fixture_zim(
        path,
        {
            "Scraper": "streetzim",
            "Name": "osm_test",
            "Title": "Test map",
            "Language": "eng",
        },
        files=files,
        main_path="search-data/manifest.json",
    )


# ── the second library: Timeline, Higher or Lower, Flags, First Lines, Spelling Bee, Mini Crossword ──
MONTHS = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
]
#: year, the line (no year in it), the article it links
EVENTS = [
    (1066, "The Normans defeat the English at the Battle of Hastings.", "France"),
    (1215, "King John of England seals Magna Carta.", "Europe"),
    (1347, "The Black Death reaches Europe by ship from the Black Sea.", "Europe"),
    (1453, "Constantinople falls to the Ottoman Turks.", "Europe"),
    (1492, "Columbus reaches the Caribbean on his first voyage.", "Earth"),
    (1543, "Copernicus publishes his Sun-centered model of the heavens.", "Sun"),
    (1609, "Galileo points a telescope at the sky for the first time.", "Moon"),
    (1666, "A great fire destroys much of the city of London.", "Europe"),
    (1687, "Isaac Newton publishes his laws of motion and gravity.", "Physics"),
    (1769, "James Watt patents his improved steam engine.", "Energy"),
    (1789, "A crowd storms the Bastille in the middle of Paris.", "Paris"),
    (1815, "Napoleon is defeated at the Battle of Waterloo.", "France"),
    (1859, "Charles Darwin publishes his book on natural selection.", "Animal"),
    (1876, "Alexander Graham Bell is granted a patent for the telephone.", "Energy"),
    (1889, "The Eiffel Tower opens to the public at the World's Fair.", "Paris"),
    (1903, "The Wright brothers make the first powered airplane flight.", "Earth"),
    (
        1912,
        "A great ocean liner sinks on her first voyage across the Atlantic.",
        "Water",
    ),
    (1927, "Charles Lindbergh flies alone across the Atlantic Ocean.", "Water"),
    (1945, "The Second World War ends in Europe.", "Germany"),
    (1953, "Two climbers reach the summit of the highest mountain.", "Mount Everest"),
    (1969, "Two astronauts walk on the surface of the Moon.", "Moon"),
    (1989, "The wall that divided Berlin is opened.", "Berlin"),
    (1991, "The Soviet Union is dissolved.", "Europe"),
    (2001, "A free online encyclopedia goes live.", "Earth"),
]
COUNTRIES = [  # name, people, square kilometres
    ("Russia", 144000000, 17098246),
    ("Canada", 40000000, 9984670),
    ("China", 1411000000, 9596960),
    ("India", 1429000000, 3287263),
    ("Brazil", 216000000, 8515767),
    ("Australia", 26000000, 7692024),
    ("France", 68000000, 551695),
    ("Germany", 84000000, 357114),
    ("Japan", 124000000, 377975),
    ("Italy", 59000000, 301340),
    ("Egypt", 112000000, 1002450),
    ("Peru", 34000000, 1285216),
    ("Spain", 48000000, 505990),
    ("Norway", 5500000, 385207),
    ("Iceland", 380000, 103000),
]
MOUNTAINS = [
    ("Mount Everest", 8849),
    ("K2", 8611),
    ("Kangchenjunga", 8586),
    ("Lhotse", 8516),
    ("Makalu", 8485),
    ("Cho Oyu", 8188),
    ("Dhaulagiri", 8167),
    ("Manaslu", 8163),
    ("Nanga Parbat", 8126),
    ("Annapurna", 8091),
    ("Mont Blanc", 4806),
    ("Ben Nevis", 1345),
]
RIVERS = [
    ("Nile", 6650),
    ("Amazon", 6400),
    ("Yangtze", 6300),
    ("Congo", 4700),
    ("Mekong", 4350),
    ("Danube", 2850),
    ("Volga", 3530),
    ("Ganges", 2525),
    ("Rhine", 1230),
    ("Seine", 777),
    ("Thames", 346),
    ("Loire", 1006),
]
FLAGS = [
    ("France", (0, 85, 164)),
    ("Germany", (0, 0, 0)),
    ("Italy", (0, 146, 70)),
    ("Japan", (188, 0, 45)),
    ("Ireland", (22, 155, 98)),
    ("Poland", (220, 20, 60)),
    ("Spain", (170, 21, 27)),
    ("Sweden", (0, 106, 167)),
    ("Norway", (186, 12, 47)),
    ("Peru", (217, 16, 35)),
]
BOOKS = [  # title, author, id, the first line
    (
        "Pride and Prejudice",
        "Austen, Jane",
        1342,
        "It is a truth universally acknowledged, that a single man in possession of a good fortune must be in want of a wife.",
    ),
    (
        "Moby Dick; Or, The Whale",
        "Melville, Herman",
        2701,
        "Call me Ishmael. Some years ago, never mind how long precisely, I thought I would sail about a little.",
    ),
    (
        "A Tale of Two Cities",
        "Dickens, Charles",
        98,
        "It was the best of times, it was the worst of times, it was the age of wisdom.",
    ),
    (
        "Frankenstein; Or, The Modern Prometheus",
        "Shelley, Mary Wollstonecraft",
        84,
        "You will rejoice to hear that no disaster has accompanied the commencement of an enterprise which you have regarded with such evil forebodings.",
    ),
    (
        "Alice's Adventures in Wonderland",
        "Carroll, Lewis",
        11,
        "Alice was beginning to get very tired of sitting by her sister on the bank, and of having nothing to do.",
    ),
    (
        "The Adventures of Sherlock Holmes",
        "Doyle, Arthur Conan",
        1661,
        "To Sherlock Holmes she is always the woman. I have seldom heard him mention her under any other name.",
    ),
    (
        "Jane Eyre: An Autobiography",
        "Bronte, Charlotte",
        1260,
        "There was no possibility of taking a walk that day, we had been wandering in the leafless shrubbery an hour in the morning.",
    ),
    (
        "The Time Machine",
        "Wells, H. G.",
        35,
        "The Time Traveller (for so it will be convenient to speak of him) was expounding a recondite matter to us.",
    ),
    (
        "Emma",
        "Austen, Jane",
        158,
        "Emma Woodhouse, handsome, clever, and rich, with a comfortable home and happy disposition, seemed to unite some of the best blessings of existence.",
    ),
    (
        "Great Expectations",
        "Dickens, Charles",
        1400,
        "My father's family name being Pirrip, and my Christian name Philip, my infant tongue could make of both names nothing longer or more explicit than Pip.",
    ),
]


def bluff_fixture(games):
    """The built-in Dictionary Bluff words as Wiktionary entries (seven letters or more, a definition that does not name the word),
    so that the library path has a few dozen among the five-letter words the other games use."""
    import ast

    with open(os.path.join(games, "bluff-data.js"), encoding="utf-8") as f:
        text = f.read()
    rows = ast.literal_eval("[" + text.split("root.BLUFF_WORDS = [", 1)[1].rsplit("];", 1)[0] + "]")
    return {w: m[0].upper() + m[1:] + " (a fixture sense)." for w, m in rows if len(w) >= 7}


_LANGUAGE_NAMES = {"fr": "French", "es": "Spanish", "de": "German", "it": "Italian", "pt": "Portuguese", "ru": "Russian", "ja": "Japanese", "zh": "Chinese",
                   "ar": "Arabic", "hi": "Hindi", "tr": "Turkish", "sv": "Swedish", "el": "Greek", "ko": "Korean"}


def _translation_pages(games):
    """Babel's library path reads <word>/translations in the English Wiktionary: one page for each built-in word, laid out as
    Wiktionary lays a translation table out (a list of "Language: <span lang=xx><a>word</a></span>")."""
    import ast

    with open(os.path.join(games, "babel-data.js"), encoding="utf-8") as f:
        text = f.read()
    rows = ast.literal_eval("[" + text.split("root.BABEL_WORDS = [", 1)[1].rsplit("];", 1)[0] + "]")
    out = []
    for en, entries in rows:
        items = "".join(
            '<li>%s: <span class="Latn" lang="%s"><a rel="mw:WikiLink" href="./%s" title="%s">%s</a></span></li>\n' % (_LANGUAGE_NAMES[e[0]], e[0], e[1], e[1], e[1])
            for e in entries
        )
        body = '<section><h5 id="Translations">Translations</h5><table class="translations" role="presentation"><tbody><tr><td class="translations-cell"><ul>%s</ul></td></tr></tbody></table></section>' % items
        out.append(("%s/translations" % en, "%s/translations" % en, page(en + "/translations", body)))
    return out


def bee_first():
    """The first built-in Spelling Bee set as (its seven letters, its common words): the one the browser test deals."""
    with open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "zimi", "builtin", "games", "spellingbee-data.js"), encoding="utf-8") as f:
        m = re.search(r"\['([a-z]{7})', '([a-z ]+)'", f.read())
    return m.group(1), m.group(2).split()


def bee_only_word():
    """A word for the Wiktionary only: the seven letters of the first set in order, which no word list has and which any middle letter fits."""
    return bee_first()[0]


def _date_events(offset):
    """Eighteen of the events, a different eighteen for each day (offset), as the lines of an Events list."""
    chosen = [EVENTS[(offset + k) % len(EVENTS)] for k in range(18)]
    return "".join(
        '<li>%d – <a rel="mw:WikiLink" href="./%s" title="%s">%s</a></li>'
        % (y, _slug(link), link, text)
        for y, text, link in chosen
    )


def _date_page(title, offset):
    body = (
        '<section data-mw-section-id="0"><p>%s is a day of the year, with many events in history.</p></section>'
        '<section data-mw-section-id="1"><div class="mw-heading mw-heading2"><h2 id="Events">Events</h2></div><ul>%s</ul></section>'
        '<section data-mw-section-id="2"><div class="mw-heading mw-heading2"><h2 id="Births">Births</h2></div><ul>'
        '<li>1900 – <a rel="mw:WikiLink" href="./Paris">Someone</a> is born.</li></ul></section>'
        % (title.replace("_", " "), _date_events(offset))
    )
    return page(title.replace("_", " "), body)


def _list_page(title, headers, rows):
    head = "<tr>%s</tr>" % "".join("<th>%s</th>" % h for h in headers)
    body = "".join("<tr>%s</tr>" % "".join(cells) for cells in rows)
    return page(
        title,
        '<section><table class="wikitable sortable"><tbody>%s%s</tbody></table></section>'
        % (head, body),
    )


def _more_pages():
    """The pages of the second Wikipedia beyond its articles: a date page for every day of the year, the four lists of Higher
    or Lower, the flags list and the flags' pictures."""
    out = []
    # Every day of the year (the kiwix mode asks a random one), each with its own eighteen events: neighboring days eight apart,
    # so the three days a server accepts hold at least eighteen different ones (Zimi keeps eight a day).
    names = {"%s_%d" % (MONTHS[m], d): (m * 31 + d) * 8 for m, n in enumerate((31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31)) for d in range(1, n + 1)}
    for t, off in names.items():
        out.append((t, t.replace("_", " "), _date_page(t, off), "text/html"))

    def link(t):
        return '<a rel="mw:WikiLink" href="./%s" title="%s">%s</a>' % (_slug(t), t, t)

    out.append(
        (
            "List_of_countries_and_dependencies_by_population",
            "List of countries by population",
            _list_page(
                "List of countries by population",
                ["Location", "Population", "% of world"],
                [
                    ["<td>%s</td>" % link(n), "<td>{:,}</td>".format(p), "<td>1%</td>"]
                    for n, p, a in COUNTRIES
                ],
            ),
            "text/html",
        )
    )
    out.append(
        (
            "List_of_countries_and_dependencies_by_area",
            "List of countries by area",
            _list_page(
                "List of countries by area",
                [
                    "Rank",
                    "Country / dependency",
                    "Total in km<sup>2</sup> (mi<sup>2</sup>)",
                ],
                [
                    [
                        "<td>%d</td>" % (i + 1),
                        "<td>%s</td>" % link(n),
                        "<td>{:,} (1,000)</td>".format(a),
                    ]
                    for i, (n, p, a) in enumerate(COUNTRIES)
                ],
            ),
            "text/html",
        )
    )
    out.append(
        (
            "List_of_highest_mountains_on_Earth",
            "List of highest mountains",
            _list_page(
                "List of highest mountains",
                ["Rank", "Mountain name(s)", "Height (rounded)"],
                [
                    [
                        "<td>%d</td>" % (i + 1),
                        "<td>%s</td>" % link(n),
                        "<td>{:,} metres (1 ft)</td>".format(h),
                    ]
                    for i, (n, h) in enumerate(MOUNTAINS)
                ],
            ),
            "text/html",
        )
    )
    out.append(
        (
            "List_of_longest_rivers",
            "List of longest rivers",
            _list_page(
                "List of longest rivers",
                ["Rank", "River", "Length (km)", "Length (miles)"],
                [
                    [
                        "<td>%d.</td>" % (i + 1),
                        "<td>%s</td>" % link(n),
                        "<td>{:,}(1,000)</td>".format(k),
                        "<td>1</td>",
                    ]
                    for i, (n, k) in enumerate(RIVERS)
                ],
            ),
            "text/html",
        )
    )
    flag_rows = []
    for n, rgb in FLAGS:
        pic = (
            '<figure typeof="mw:File/Frameless"><a href="./File:Flag_of_%s.png"><img src="./I/Flag_of_%s.png" width="250"></a></figure>'
            % (n, n)
        )
        flag_rows.append(
            ["<td>%s</td>" % pic, '<th scope="row">%s</th>' % link(n), "<td>2:3</td>"]
        )
        out.append(
            (
                "I/Flag_of_%s.png" % n,
                "Flag of %s.png" % n,
                _picture(60, 40, rgb),
                "image/png",
            )
        )
    out.append(
        (
            "List_of_national_flags_of_sovereign_states",
            "List of national flags",
            _list_page("List of national flags", ["Flag", "State", "Ratio"], flag_rows),
            "text/html",
        )
    )
    return out


def _gutenberg(path):
    rows = ",".join('["%s","%s","111",%d,"PR"]' % (t, a, i) for t, a, i, _ in BOOKS)
    with Creator(path).config_indexing(True, "eng") as c:
        c.set_mainpath("Main_Page")
        c.add_item(
            _Page(
                "Main_Page", "Main Page", page("Main Page", "<p>Project Gutenberg.</p>")
            )
        )
        c.add_item(
            _Page(
                "full_by_popularity.js",
                "full_by_popularity.js",
                ("var json_data = [%s];" % rows).encode(),
                "application/javascript",
            )
        )
        c.add_item(
            _Page(
                "languages.js",
                "languages.js",
                ('var json_data = [["English","en",%d]];' % len(BOOKS)).encode(),
                "application/javascript",
            )
        )
        for title, author, bid, line in BOOKS:
            name = title.replace("/", "-")
            body = (
                '<html><head><title>%s</title></head><body><header><section class="pg-boilerplate pgheader"><p>The Project Gutenberg eBook of %s, by %s</p>'
                '<div id="pg-start-separator"><span>*** START OF THE PROJECT GUTENBERG EBOOK %s ***</span></div></section></header>'
                '<h1>%s</h1><h2>by %s</h2><h2>Contents</h2><table><tr><td><a href="#c1">CHAPTER I.</a></td><td>The Beginning</td></tr></table>'
                '<div class="chapter"><h2><a id="c1"></a>CHAPTER I.<br>The Beginning</h2><p>\n%s\nAnd so on, for a long while after that, as books do.</p></div></body></html>'
                % (title, title, author, title.upper(), title, author, line)
            )
            c.add_item(_Page("%s.%d" % (name, bid), title, body.encode("utf-8")))
        for k, v in {
            "Scraper": "gutenberg2zim 3.0",
            "Name": "gutenberg_en_all",
            "Language": "eng",
            "Title": "Project Gutenberg",
            "Description": "Books",
        }.items():
            c.add_metadata(k, v)


def build_more(base):
    out = os.path.join(os.path.abspath(base), "zims2")
    shutil.rmtree(out, ignore_errors=True)
    os.makedirs(out)
    little = {
        k: EN[k]
        for k in (
            "Paris",
            "France",
            "Germany",
            "Europe",
            "Earth",
            "Sun",
            "Moon",
            "Physics",
            "Energy",
            "Water",
            "Animal",
            "Berlin",
            "Mount Everest",
        )
    }
    _wiki(
        os.path.join(out, "wikipedia_en_all_nopic_2026-01.zim"),
        "wikipedia_en_all",
        "Wikipedia",
        "en",
        "eng",
        little,
        extra=_more_pages(),
    )
    games = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        "zimi",
        "builtin",
        "games",
    )
    with open(os.path.join(games, "minicrossword-data.js"), encoding="utf-8") as f:
        pool = re.findall(r"^\s+([a-z]{5}): '", f.read(), re.M)
    words = {w: "Fixture sense number %d" % i for i, w in enumerate(pool)}
    words[bee_only_word()] = "A fixture word for the bee"
    words.update(bluff_fixture(games))
    _wikt(
        os.path.join(out, "wiktionary_en_all_nopic_2026-02.zim"),
        "wiktionary_en_all",
        "Wiktionary",
        "en",
        "eng",
        words,
        "English",
        "Noun",
        extra=_translation_pages(games),
    )
    _gutenberg(os.path.join(out, "gutenberg_en_all_2026-01.zim"))
    try:
        _map(os.path.join(out, "osm_test_2026-01.zim"))
    except Exception as e:  # the map is only for Drop Pin's test
        print("no map fixture:", e)
    return out

def build(base):
    out = os.path.join(os.path.abspath(base), "zims")
    shutil.rmtree(out, ignore_errors=True)
    os.makedirs(out)
    _wiki(
        os.path.join(out, "wikipedia_en_all_nopic_2026-01.zim"),
        "wikipedia_en_all",
        "Wikipedia",
        "en",
        "eng",
        EN,
    )
    _wiki(
        os.path.join(out, "wikipedia_fr_all_nopic_2026-01.zim"),
        "wikipedia_fr_all",
        "Wikipédia",
        "fr",
        "fra",
        FR,
    )
    _wikt(
        os.path.join(out, "wiktionary_en_all_nopic_2026-02.zim"),
        "wiktionary_en_all",
        "Wiktionary",
        "en",
        "eng",
        WORDS_EN,
        "English",
        "Noun",
    )
    _wikt(
        os.path.join(out, "wiktionary_fr_all_nopic_2026-01.zim"),
        "wiktionary_fr_all",
        "Wiktionnaire",
        "fr",
        "fra",
        WORDS_FR,
        "Français",
        "Nom commun",
    )
    try:
        _map(os.path.join(out, "osm_test_2026-01.zim"))
    except Exception as e:  # the map is only for the Where in the World test
        print("no map fixture:", e)
    build_more(base)
    return out


if __name__ == "__main__":
    print(build(sys.argv[1] if len(sys.argv) > 1 else "."))
