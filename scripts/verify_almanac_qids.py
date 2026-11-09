#!/usr/bin/env python3
"""Check the Almanac's curated Wikidata Q-IDs against English Wikipedia.

    python3 scripts/verify_almanac_qids.py            # audit every entry in the map
    python3 scripts/verify_almanac_qids.py --resolve "Mercury (planet)" "Sirius"

The Almanac's deep links (zimi/static/almanac-links.js) are a closed set: each
entity carries a Q-ID and the English Wikipedia title that Q-ID stands for.
Runtime is fully offline (the Q-IDs are baked in); this script is the network
step that earns them. For every `q: 'Q...', en: '...'` entry it asks the
English Wikipedia API for the page's `wikibase_item` (redirects followed) and
reports

  - a title whose Wikidata item is not the Q-ID written down,
  - a title that is a disambiguation page (never a link target),
  - a title that does not exist.

`--resolve` prints the Q-ID of each title given, for adding entries. Titles are
sent 50 at a time, as the API allows. Needs the network; nothing at runtime
does.

    python3 scripts/verify_almanac_qids.py --landmarks [--cache DIR]

audits the 3D view's landmarks (zimi/static/earth/landmarks-v1.json, one Q-ID per row) the same way, and checks that
every link key almanac-earth.js asks for is in the map. A row passes when its Q-ID is not a redirect or a missing item,
has an English Wikipedia article (not a disambiguation page) whose own Wikidata item is that Q-ID, carries the place's
name as its label or an alias, and is not an instance of something a place cannot be (a person, a family name, a
film...). Wikidata's answers are kept in --cache, so a re-run is quick and polite. Exit 1 on any failure; that is the
release gate's check.
"""

import ast
import hashlib
import json
import os
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request

LINKS_JS = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "zimi",
    "static",
    "almanac-links.js",
)
API = "https://en.wikipedia.org/w/api.php"
BATCH = 50
USER_AGENT = "zimi-almanac-qid-audit/1.0 (https://github.com/epheterson/zimi)"
WD_API = "https://www.wikidata.org/w/api.php"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LANDMARKS_JSON = os.path.join(ROOT, "zimi", "static", "earth", "landmarks-v1.json")
EARTH_JS = os.path.join(ROOT, "zimi", "static", "almanac-earth.js")
TRACKS_JSON = os.path.join(ROOT, "zimi", "static", "earth", "space-tracks-v1.json")
TRIES = 5
ENTRY = re.compile(
    r"q:\s*'(Q\d+)'\s*,\s*en:\s*('(?:[^'\\]|\\.)*'|\"(?:[^\"\\]|\\.)*\")"
)


def entries(path=LINKS_JS):
    """[(q, en title)] for every curated entry, in file order."""
    with open(path, encoding="utf-8") as f:
        src = f.read()
    return [(m.group(1), ast.literal_eval(m.group(2))) for m in ENTRY.finditer(src)]


def fetch_json(url, cache=None):
    """The JSON at url, kept in the cache folder (when given) under the url's hash; asked again after a failure with
    a growing pause, since the APIs answer 429 and 5xx when asked too fast."""
    path = cache and os.path.join(
        cache, hashlib.md5(url.encode()).hexdigest() + ".json"
    )
    if path and os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    for attempt in range(TRIES):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=60) as r:
                data = json.load(r)
            break
        except (urllib.error.URLError, TimeoutError, ValueError):
            if attempt == TRIES - 1:
                raise
            time.sleep(2**attempt)
    if path:
        os.makedirs(cache, exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f)
    return data


def lookup(titles, cache=None):
    """{title: {"q": Q-ID or None, "title": the article's own title, "disambig": bool,
    "missing": bool}}, redirects followed."""
    out = {}
    titles = list(dict.fromkeys(titles))
    for i in range(0, len(titles), BATCH):
        part = titles[i : i + BATCH]
        url = (
            API
            + "?"
            + urllib.parse.urlencode(
                {
                    "action": "query",
                    "format": "json",
                    "redirects": 1,
                    "prop": "pageprops",
                    "ppprop": "wikibase_item|disambiguation",
                    "titles": "|".join(part),
                }
            )
        )
        data = fetch_json(url, cache)["query"]
        # title as sent -> normalized -> redirect target -> page
        step = {t: t for t in part}
        for n in data.get("normalized", []):
            for t, cur in step.items():
                if cur == n["from"]:
                    step[t] = n["to"]
        for rd in data.get("redirects", []):
            for t, cur in step.items():
                if cur == rd["from"]:
                    step[t] = rd["to"]
        pages = {p["title"]: p for p in data["pages"].values()}
        for t in part:
            p = pages.get(step[t], {})
            props = p.get("pageprops", {})
            out[t] = {
                "q": props.get("wikibase_item"),
                "title": p.get("title", step[t]),
                "disambig": "disambiguation" in props,
                "missing": "missing" in p,
            }
    return out


# ── Landmarks ──────────────────────────────────────────────────────────────

# What a place on a planet is never an instance of (Wikidata's English labels): a Q-ID that lands here is another thing
# with the place's name.
NOT_A_PLACE = (
    "human",
    "given name",
    "family name",
    "male given name",
    "female given name",
    "wikimedia disambiguation page",
    "film",
    "album",
    "single",
    "song",
    "book",
    "novel",
    "television series",
    "video game",
    "business",
    "company",
    "species",
    "taxon",
    "genus",
    "mythical character",
    "fictional character",
    "deity",
    "wikimedia list article",
)
# The words a kind's P31 labels are expected to carry; no match is a warning to look at, not a failure.
KIND_WORDS = {
    "crater": ("crater", "impact", "astronomical object", "geological"),
    "mare": ("mare", "sea", "lunar", "geological"),
    "mons": (
        "mountain",
        "mons",
        "volcano",
        "peak",
        "hill",
        "massif",
        "geological",
        "range",
        "summit",
    ),
    "volcano": ("volcano", "mountain", "mons", "patera", "geological", "caldera"),
    "landing": (
        "landing",
        "lander",
        "rover",
        "spacecraft",
        "mission",
        "probe",
        "site",
        "space",
        "flight",
        "program",
    ),
}
# The Gazetteer's feature words, plural to singular: Wikidata and the Gazetteer disagree about "Catena" and "Catenae".
LATIN = {
    "catenae": "catena",
    "fossae": "fossa",
    "montes": "mons",
    "valles": "vallis",
    "terrae": "terra",
    "planitiae": "planitia",
    "plana": "planum",
    "planum": "planitia",
    "regiones": "regio",
    "dorsa": "dorsum",
    "lineae": "linea",
    "paterae": "patera",
    "labyrinthi": "labyrinthus",
    "flumina": "flumen",
    "sulci": "sulcus",
}
# Q-IDs whose label is rightly not the row's name: the row names a place, the item is the thing there.
ACCEPTED = {
    "Q308987": "Kourou: the Guiana Space Centre",
    "Q640273": "Sriharikota: the Satish Dhawan Space Centre",
    "Q3504474": "Atalanta Planitia: Wikidata spells it Atalante",
}
PAREN = re.compile(r"\s*\([^)]*\)")


def norm(s):
    """Lower case, accents and punctuation gone, one space between words."""
    s = unicodedata.normalize("NFKD", s)
    s = "".join(
        c
        for c in s
        if not unicodedata.combining(c) and unicodedata.category(c) not in ("Lm", "Sk")
    )
    return " ".join(
        LATIN.get(w, w) for w in re.sub(r"[^a-z0-9]+", " ", s.lower()).split()
    )


def name_match(name, labels):
    """'exact' when name is one of the labels (or a label with its parenthesis dropped), 'loose' when every word of the
    shorter is in the longer, else None."""
    want = {norm(name), norm(PAREN.sub("", name))} - {""}
    have = {norm(x) for x in labels} | {norm(PAREN.sub("", x)) for x in labels}
    if want & have:
        return "exact"
    for w in want:
        for h in have:
            a, b = set(w.split()), set(h.split())
            if h and (a <= b or b <= a):
                return "loose"
    return None


def classify(row, ent, p31_labels):
    """The verdict for one landmark row [name, lat, lon, kind, qid, ...] against its Wikidata entity (None when the
    item is gone): {"status": ok | missing | redirect | no_enwiki | wrong_entity, "why": text, "name": exact | loose
    | None, "kind_warn": bool, "enwiki": title or None}."""
    name, kind, qid = row[0], row[3], row[4]
    out = {
        "status": "ok",
        "why": "",
        "name": None,
        "kind_warn": False,
        "enwiki": None,
        "unlabeled": False,
    }
    if not ent or "missing" in ent:
        return dict(out, status="missing", why="no such item")
    if ent.get("id") != qid:
        return dict(out, status="redirect", why="merged into %s" % ent.get("id"))
    out["enwiki"] = (ent.get("sitelinks") or {}).get("enwiki", {}).get("title")
    # English (and "mul", the all-languages name) first; another language's label only for an item with none of those
    labels = [out["enwiki"]] if out["enwiki"] else []
    for code in ("en", "mul"):
        labels += [v["value"] for v in [(ent.get("labels") or {}).get(code)] if v]
        labels += [a["value"] for a in (ent.get("aliases") or {}).get(code, [])]
    unlabeled = not labels
    if unlabeled:
        labels = [v["value"] for v in (ent.get("labels") or {}).values()]
        for al in (ent.get("aliases") or {}).values():
            labels += [a["value"] for a in al]
    out["name"] = "exact" if qid in ACCEPTED else name_match(name, labels)
    out["unlabeled"] = unlabeled
    types = [p31_labels.get(i, i) for i in ent.get("p31", [])]
    bad = [t for t in types if t.lower() in NOT_A_PLACE]
    if bad:
        return dict(
            out,
            status="wrong_entity",
            why="is a %s (label %r)" % (", ".join(bad), labels[:1]),
        )
    if out["name"] is None:
        return dict(
            out, status="wrong_entity", why="label %r is not %r" % (labels[:1], name)
        )
    words = KIND_WORDS.get(kind)
    out["kind_warn"] = bool(
        words and not any(w in t.lower() for t in types for w in words)
    )
    if not out["enwiki"]:
        return dict(out, status="no_enwiki", why="no English Wikipedia article")
    return out


def fetch_entities(ids, cache, props):
    """{Q-ID asked: entity} for ids, 50 at a time; a merged item comes back under its new id, which its "id" says."""
    out = {}
    ids = sorted(set(ids))
    for i in range(0, len(ids), BATCH):
        part = ids[i : i + BATCH]
        url = (
            WD_API
            + "?"
            + urllib.parse.urlencode(
                {
                    "action": "wbgetentities",
                    "format": "json",
                    "ids": "|".join(part),
                    "props": props,
                    "sitefilter": "enwiki",
                }
            )
        )
        ents = fetch_json(url, cache).get("entities", {})
        for q in part:
            ent = ents.get(q)
            if ent is None:  # merged: the answer sits under the item it was merged into
                ent = next(
                    (
                        e
                        for e in ents.values()
                        if (e.get("redirects") or {}).get("from") == q
                    ),
                    None,
                )
            out[q] = ent
    return out


def p31_of(ent):
    return [
        c["mainsnak"]["datavalue"]["value"]["id"]
        for c in (ent.get("claims") or {}).get("P31", [])
        if c.get("mainsnak", {}).get("datavalue")
    ]


def landmark_rows(path=LANDMARKS_JSON):
    """[(body, row)] for every row in the landmarks file."""
    with open(path, encoding="utf-8") as f:
        doc = json.load(f)
    return [
        (b, r)
        for b, rows in doc.items()
        if isinstance(rows, list) and b != "sources"
        for r in rows
        if isinstance(r, list)
    ]


def audit_landmarks(rows, cache=None):
    """[(body, row, verdict)] for every row with a Q-ID, asking Wikidata and English Wikipedia (cached)."""
    rows = [(b, r) for b, r in rows if r[4]]
    ents = fetch_entities(
        [r[4] for _, r in rows], cache, "labels|aliases|sitelinks|claims"
    )
    for e in ents.values():
        if e:
            e["p31"] = p31_of(e)
    kinds = {i for e in ents.values() if e for i in e["p31"]}
    kind_names = fetch_entities(kinds, cache, "labels")
    p31_labels = {
        i: e["labels"]["en"]["value"]
        for i, e in kind_names.items()
        if e and "en" in e.get("labels", {})
    }
    out = [(b, r, classify(r, ents[r[4]], p31_labels)) for b, r in rows]
    pages = lookup([v["enwiki"] for _, _, v in out if v["enwiki"]], cache)
    for _, r, v in out:
        if v["status"] == "ok" and v["enwiki"]:
            page = pages[v["enwiki"]]
            if page["missing"] or page["disambig"]:
                v.update(
                    status="wrong_entity",
                    why="its article %r is %s"
                    % (
                        v["enwiki"],
                        "gone" if page["missing"] else "a disambiguation page",
                    ),
                )
            elif page["q"] != r[4] and page["title"] != v["enwiki"]:
                # the sitelink is a redirect into another item's article (a list of craters, the planet): no page of its own
                v.update(
                    status="no_enwiki",
                    why="its article %r redirects to %r (%s)"
                    % (v["enwiki"], page["title"], page["q"]),
                )
            elif page["q"] != r[4]:
                v.update(
                    status="wrong_entity",
                    why="its article %r is %s" % (v["enwiki"], page["q"]),
                )
    return out


def link_keys_wanted(earth_src, links_src, tracks):
    """Every link key almanac-earth.js can ask the map for: planet:<body> for each body it draws, probe:<craft> for
    each track (Ceres is a body), and the literal keys written in the file. [] of keys, sorted.
    """
    bodies = set(re.findall(r"\{ key: '(\w+)', (?:eph|parent):", earth_src))
    targets = re.search(r"var AE_TARGETS = \{(.*?)\n\};", earth_src, re.S)
    bodies |= (
        set(re.findall(r"^\s+(\w+): \{ min:", targets.group(1), re.M))
        if targets
        else set()
    )
    spaces = set(re.findall(r"^\s+'([a-z]+):", links_src, re.M))
    keys = {"planet:" + b for b in bodies}
    keys |= {"probe:" + t for t in tracks if t != "ceres"}
    keys |= {
        k
        for k in re.findall(r"'([a-z]+:[a-z0-9_]+)'", earth_src)
        if k.split(":")[0] in spaces
    }
    return sorted(keys)


def link_keys_missing():
    """The keys almanac-earth.js uses that almanac-links.js does not carry."""
    with open(EARTH_JS, encoding="utf-8") as f:
        earth = f.read()
    with open(LINKS_JS, encoding="utf-8") as f:
        links = f.read()
    with open(TRACKS_JSON, encoding="utf-8") as f:
        tracks = json.load(f).get("tracks", {})
    have = set(re.findall(r"'([a-z]+:[a-z0-9_]+)'\s*:", links))
    wanted = link_keys_wanted(earth, links, tracks)
    return wanted, [k for k in wanted if k not in have]


def run_landmarks(argv):
    cache = argv[argv.index("--cache") + 1] if "--cache" in argv else None
    allrows = landmark_rows()
    results = audit_landmarks(allrows, cache)
    counts = {
        "no Q-ID": len(allrows) - len(results),
        "name loose": 0,
        "no en label (matched in another language)": 0,
        "kind to look at": 0,
    }
    bad = 0
    for body, row, v in results:
        counts[v["status"]] = counts.get(v["status"], 0) + 1
        counts["name loose"] += v["name"] == "loose"
        counts["no en label (matched in another language)"] += v["unlabeled"]
        counts["kind to look at"] += v["kind_warn"]
        if v["status"] == "no_enwiki":
            # not a defect: the place has no English article (or only a redirect), so it is plain text in English installs
            if "--verbose" in argv:
                print("note  %-9s %-10s %-34s %s" % (body, row[4], row[0], v["why"]))
        elif v["status"] != "ok":
            bad += 1
            print(
                "BAD   %-9s %-10s %-11s %-34s %s"
                % (body, row[4], v["status"], row[0], v["why"])
            )
        elif "--verbose" in argv and (v["name"] == "loose" or v["kind_warn"]):
            print(
                "look  %-9s %-10s %-34s %s"
                % (
                    body,
                    row[4],
                    row[0],
                    "loose name" if v["name"] == "loose" else "kind",
                )
            )
    wanted, missing = link_keys_missing()
    for k in missing:
        print(
            "BAD   link key %s is used by almanac-earth.js and not in almanac-links.js"
            % k
        )
    print(
        "%d rows, %s"
        % (len(allrows), ", ".join("%d %s" % (n, k) for k, n in sorted(counts.items())))
    )
    print(
        "%d link keys used by almanac-earth.js, %d missing from almanac-links.js"
        % (len(wanted), len(missing))
    )
    return 1 if bad or missing else 0


def main(argv):
    if len(argv) > 1 and argv[1] == "--landmarks":
        return run_landmarks(argv)
    if len(argv) > 1 and argv[1] == "--resolve":
        for title, r in lookup(argv[2:]).items():
            flag = (
                " (DISAMBIGUATION)"
                if r["disambig"]
                else " (MISSING)" if r["missing"] else ""
            )
            print("%s\t%s%s" % (title, r["q"], flag))
        return 0
    found = entries()
    res = lookup([en for _, en in found])
    bad = 0
    for q, en in found:
        r = res[en]
        if r["missing"] or r["disambig"] or r["q"] != q:
            bad += 1
            why = (
                "missing"
                if r["missing"]
                else "disambiguation page" if r["disambig"] else "is %s" % r["q"]
            )
            print("BAD  %-10s %-50s %s" % (q, en, why))
    print("%d entries, %d distinct titles, %d bad" % (len(found), len(res), bad))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
