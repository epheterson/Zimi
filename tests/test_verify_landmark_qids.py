"""The landmark Q-ID audit's matching logic, on Wikidata answers recorded once (no network here).

scripts/verify_almanac_qids.py --landmarks asks Wikidata and English Wikipedia about every Q-ID in landmarks-v1.json;
what it does with the answers is decided by name_match, classify and link_keys_wanted, and that is what is tested.

Run: pytest tests/test_verify_landmark_qids.py -v
"""

import importlib.util
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_spec = importlib.util.spec_from_file_location(
    "verify_almanac_qids", os.path.join(ROOT, "scripts", "verify_almanac_qids.py")
)
v = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(v)


def ent(qid, en=None, aliases=(), enwiki=None, p31=(), others=None):
    """A recorded wbgetentities answer, trimmed to what the audit reads."""
    labels = dict(others or {})
    if en:
        labels["en"] = {"language": "en", "value": en}
    out = {"id": qid, "labels": labels, "p31": list(p31)}
    if aliases:
        out["aliases"] = {"en": [{"language": "en", "value": a} for a in aliases]}
    if enwiki:
        out["sitelinks"] = {"enwiki": {"site": "enwiki", "title": enwiki}}
    return out


KINDS = {
    "Q1": "impact crater",
    "Q2": "human",
    "Q3": "Wikimedia disambiguation page",
    "Q4": "lunar mare",
}


def verdict(row, e):
    return v.classify(row, e, KINDS)


def test_name_match_tiers():
    assert v.name_match("Tycho", ["Tycho"]) == "exact"
    assert v.name_match("Tycho", ["Tycho (crater)"]) == "exact"
    assert (
        v.name_match("Belkovich", ["Belʹkovich"]) == "exact"
    )  # a modifier letter is not part of the name
    assert (
        v.name_match("Samhain Catenae", ["Samhain Catena"]) == "exact"
    )  # Latin plurals
    assert v.name_match("Mare Frigoris", ["Sea of Frost", "Mare Frigoris"]) == "exact"
    assert v.name_match("Heron", ["Heron (crater) hero"]) == "loose"
    assert (
        v.name_match("Copernicus", ["Nicolaus Copernicus"]) == "loose"
    )  # why a person is also checked by type
    assert v.name_match("Yamor Mons", ["Ysolo Mons"]) is None
    assert v.name_match("Vega 1", ["Vega program"]) is None


def test_ok_row():
    r = verdict(
        ["Tycho", -43.3, -11.4, "crater", "Q73", 85, 0, 1],
        ent("Q73", "Tycho", enwiki="Tycho (crater)", p31=["Q1"]),
    )
    assert (
        r["status"] == "ok"
        and r["name"] == "exact"
        and not r["kind_warn"]
        and r["enwiki"] == "Tycho (crater)"
    )


def test_other_things_with_the_name_fail():
    person = verdict(
        ["Copernicus", 9.6, -20, "crater", "Q5", 93, 0, 1],
        ent("Q5", "Nicolaus Copernicus", enwiki="Nicolaus Copernicus", p31=["Q2"]),
    )
    assert person["status"] == "wrong_entity" and "human" in person["why"]
    disamb = verdict(
        ["Starbase", 26, -97, "launch", "Q6", 0, 5, 1],
        ent("Q6", "Starbase", enwiki="Starbase", p31=["Q3"]),
    )
    assert disamb["status"] == "wrong_entity"
    program = verdict(
        ["Vega 1", 7.2, 177.8, "landing", "Q7", 0, 3, 1],
        ent("Q7", "Vega program", enwiki="Vega program"),
    )
    assert program["status"] == "wrong_entity" and "Vega program" in program["why"]


def test_missing_merged_and_unlinked():
    row = ["Tycho", 0, 0, "crater", "Q8", 0, 0, 1]
    assert verdict(row, None)["status"] == "missing"
    assert verdict(row, {"id": "Q8", "missing": ""})["status"] == "missing"
    assert verdict(row, ent("Q99", "Tycho"))["status"] == "redirect"
    nolink = verdict(row, ent("Q8", "Tycho", p31=["Q1"]))
    assert nolink["status"] == "no_enwiki" and nolink["name"] == "exact"


def test_label_only_in_another_language_counts_for_an_unlabeled_item():
    e = ent("Q9", None, others={"it": {"language": "it", "value": "Cerealia Facula"}})
    r = verdict(["Cerealia Facula", 0, 0, "region", "Q9", 0, 0, 1], e)
    assert r["unlabeled"] and r["name"] == "exact"
    # an item with an English label is judged by it alone: another language's label cannot excuse it
    e = ent(
        "Q10", "Ysolo Mons", others={"it": {"language": "it", "value": "Yamor Mons"}}
    )
    assert (
        verdict(["Yamor Mons", 0, 0, "mons", "Q10", 0, 0, 1], e)["status"]
        == "wrong_entity"
    )


def test_accepted_names_pass():
    r = verdict(
        ["Kourou", 5.2, -52.8, "launch", "Q308987", 0, 5, 1],
        ent("Q308987", "Guiana Space Centre", enwiki="Guiana Space Centre"),
    )
    assert r["status"] == "ok"


def test_kind_warning_is_a_warning():
    r = verdict(
        ["Mare Frigoris", 56, 1, "mare", "Q4", 0, 0, 1],
        ent("Q4", "Mare Frigoris", enwiki="Mare Frigoris", p31=["Q1"]),
    )
    assert (
        r["status"] == "ok" and r["kind_warn"]
    )  # a crater is not a mare; look, but the name and article are right


def test_link_keys_wanted_builds_planet_probe_and_literal_keys():
    earth = (
        "{ key: 'mars', eph: 'Mars' },\n{ key: 'io', parent: 'jupiter' },\n"
        "var AE_TARGETS = {\n  earth: { min: 1 },\n  sun: { min: 2 }\n};\n"
        "x = _aeLink('term:iss', y); k = 'lm:'; z = 'ev:goldenrecord'; w = 'nope:thing';\n"
    )
    links = "    'planet:mars': { q: 'Q111' },\n    'term:iss': { q: 'Q1' },\n    'ev:goldenrecord': { q: 'Q2' },\n"
    keys = v.link_keys_wanted(earth, links, {"voyager1": {}, "ceres": {}})
    assert keys == [
        "ev:goldenrecord",
        "planet:earth",
        "planet:io",
        "planet:mars",
        "planet:sun",
        "probe:voyager1",
        "term:iss",
    ]


def test_the_shipped_map_carries_every_key_the_3d_view_uses():
    wanted, missing = v.link_keys_missing()
    assert len(wanted) > 20 and missing == []
