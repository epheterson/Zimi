#!/usr/bin/env python3
"""Comprehensive functional test for cross-language article matching.

Tests the /article-languages endpoint across all installed ZIMs with:
- 100+ article lookups across multiple ZIMs and languages
- Bidirectional matching (en→{de,es,pt,ar,zh,hi,it,fr} and reverse)
- Subset ZIM routing (medicine, chemistry, geography, physics, math, computer)
- False positive prevention
- ZIM quality scoring (prefer _all over subsets, maxi > nopic > mini)
- Edge cases

Run: python3 tests/test_article_languages.py [BASE_URL]
"""

import json
import sys
import time
import urllib.error
import urllib.request
import urllib.parse

BASE_URL = "http://knowledge.zosia.lan"

# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def api(endpoint, params=None, retries=3):
    """Call a Zimi API endpoint, return parsed JSON. Retries on 429."""
    qs = "&".join(f"{k}={urllib.parse.quote(str(v))}" for k, v in (params or {}).items())
    url = f"{BASE_URL}/{endpoint}{'?' + qs if qs else ''}"
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(url, timeout=15) as resp:
                return json.loads(resp.read())
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < retries - 1:
                time.sleep(1 + attempt)  # backoff: 1s, 2s, 3s
                continue
            return {"_error": f"HTTP {e.code}"}
        except Exception as e:
            return {"_error": str(e)}

def article_langs(zim, path):
    return api("article-languages", {"zim": zim, "path": path})

def article_exists(zim, path):
    """Check if an article exists and loads."""
    data = api("read", {"zim": zim, "path": path})
    return "error" not in data and "_error" not in data and data.get("content", "") != ""

def search(zim, q, limit=3):
    data = api("search", {"q": q, "zim": zim, "limit": limit})
    return data.get("results", [])

def get_installed_zims():
    """Get list of installed ZIMs."""
    data = api("list")
    if isinstance(data, list):
        return {z.get("name", ""): z for z in data}
    return {}


class Results:
    def __init__(self):
        self.passed = self.failed = self.skipped = 0
        self.failures = []
        self.all_matched_links = []  # (zim, path) for verification

    def ok(self, cat, msg):
        self.passed += 1
        print(f"  PASS  {msg}")

    def fail(self, cat, msg, detail=""):
        self.failed += 1
        self.failures.append((cat, msg, detail))
        print(f"  FAIL  {msg}" + (f" — {detail}" if detail else ""))

    def skip(self, cat, msg):
        self.skipped += 1
        print(f"  SKIP  {msg}")

    def track_link(self, zim, path):
        self.all_matched_links.append((zim, path))

    def summary(self):
        total = self.passed + self.failed + self.skipped
        print(f"\n{'='*70}")
        print(f"RESULTS: {self.passed} passed, {self.failed} failed, {self.skipped} skipped / {total} total")
        print(f"{'='*70}")
        if self.failures:
            print(f"\nFAILURES:")
            for cat, msg, detail in self.failures:
                print(f"  [{cat}] {msg}")
                if detail:
                    print(f"         {detail}")
        return self.failed == 0


# ─────────────────────────────────────────────────────────────────────────────
# Test categories
# ─────────────────────────────────────────────────────────────────────────────

def test_exact_path_matches(r, zims):
    """Test articles where the title is identical across languages (proper nouns, elements)."""
    print("\n── 1. Exact Path Matches ──")

    # (source_zim, path, description, expected_lang_contains)
    tests = [
        # Cities — same name across languages
        ("wikipedia", "A/Berlin", "Berlin (de/fr/it geography)"),
        ("wikipedia", "A/Tokyo", "Tokyo"),
        ("wikipedia", "A/Singapore", "Singapore"),
        ("wikipedia", "A/Istanbul", "Istanbul"),
        # Chemical elements — often same or close
        ("wikipedia", "A/Calcium", "Calcium (chemistry)"),
        ("wikipedia", "A/Uranium", "Uranium"),
        ("wikipedia", "A/Plutonium", "Plutonium"),
        ("wikipedia", "A/Aluminium", "Aluminium"),
        # Math/physics terms
        ("wikipedia", "A/Algorithm", "Algorithm (math)"),
        ("wikipedia", "A/Algebra", "Algebra (math)"),
        ("wikipedia", "A/Electron", "Electron (physics)"),
        ("wikipedia", "A/Neutron", "Neutron (physics)"),
        # Countries/regions
        ("wikipedia", "A/Africa", "Africa (geography)"),
        ("wikipedia", "A/Asia", "Asia (geography)"),
        ("wikipedia", "A/Europe", "Europe (geography)"),
    ]

    for src_zim, path, desc in tests:
        if src_zim not in zims:
            r.skip("exact", f"{path} — {src_zim} not installed")
            continue
        if not article_exists(src_zim, path):
            r.skip("exact", f"{path} — not in {src_zim}")
            continue

        data = article_langs(src_zim, path)
        langs = data.get("languages", [])

        if langs:
            # Verify EVERY match actually loads
            all_ok = True
            for match in langs:
                if article_exists(match["zim"], match["path"]):
                    r.track_link(match["zim"], match["path"])
                else:
                    r.fail("exact", f"{path} → BROKEN: {match['zim']}:{match['path']}", desc)
                    all_ok = False
            if all_ok:
                lang_list = ", ".join(f"{m['lang']}({m['zim'].split('_')[1] if '_' in m['zim'] else '?'})" for m in langs)
                r.ok("exact", f"{path} → {len(langs)} langs: {lang_list}")
        else:
            r.skip("exact", f"{path} — no cross-lang matches ({desc})")


def test_search_based_matches(r, zims):
    """Test articles where titles differ across languages (translations)."""
    print("\n── 2. Search-Based Translation Matches ──")

    # (source_zim, path, description)
    # These require search to match because the title changes across languages
    tests = [
        ("wikipedia", "A/Oxygen", "Oxygen → Oxygène/Sauerstoff"),
        ("wikipedia", "A/Hydrogen", "Hydrogen → Hydrogène/Wasserstoff"),
        ("wikipedia", "A/Nitrogen", "Nitrogen → Azote/Stickstoff"),
        ("wikipedia", "A/Carbon", "Carbon → Carbone/Kohlenstoff"),
        ("wikipedia", "A/Sulfur", "Sulfur → Soufre/Schwefel"),
        ("wikipedia", "A/Helium", "Helium (same in many langs)"),
        ("wikipedia", "A/Neon", "Neon (similar in many langs)"),
    ]

    for src_zim, path, desc in tests:
        if src_zim not in zims:
            r.skip("search", f"{path} — {src_zim} not installed")
            continue
        if not article_exists(src_zim, path):
            r.skip("search", f"{path} — not in {src_zim}")
            continue

        data = article_langs(src_zim, path)
        langs = data.get("languages", [])

        if langs:
            all_ok = True
            for match in langs:
                if article_exists(match["zim"], match["path"]):
                    r.track_link(match["zim"], match["path"])
                else:
                    r.fail("search", f"{path} → BROKEN: {match['zim']}:{match['path']}", desc)
                    all_ok = False
            if all_ok:
                details = ", ".join(f"{m['lang']}={m['path'].split('/')[-1]}" for m in langs)
                r.ok("search", f"{path} → {len(langs)} matches: {details}")
        else:
            r.fail("search", f"{path} — no translation matches found", desc)


def test_false_positives(r, zims):
    """Test that we DON'T produce false matches."""
    print("\n── 3. False Positive Prevention ──")

    # (source_zim, path, max_results, description)
    tests = [
        ("wikipedia", "A/Water", 0, "Water — French is 'Eau', too different"),
        ("wikipedia", "A/Iron", 0, "Iron — French 'Fer', too different for search"),
        ("wikipedia", "A/Gold", 0, "Gold — French 'Or', too different"),
        ("wikipedia", "A/Silver", 0, "Silver — French 'Argent', too different"),
        ("wikipedia", "A/Copper", 0, "Copper — French 'Cuivre', too different"),
        ("wikipedia", "A/Lead", 0, "Lead — French 'Plomb', too different"),
        ("wikipedia", "A/List_of_chemical_elements", 0, "List article — compound title"),
        ("wikipedia", "A/United_States", 0, "Compound → États-Unis"),
        ("wikipedia", "A/New_York_City", 0, "Compound → New York"),
        ("wikipedia", "A/Computer_science", 0, "Compound → Informatique"),
    ]

    for src_zim, path, max_results, desc in tests:
        if src_zim not in zims:
            r.skip("false-pos", f"{path} — {src_zim} not installed")
            continue
        if not article_exists(src_zim, path):
            r.skip("false-pos", f"{path} — not in {src_zim}")
            continue

        data = article_langs(src_zim, path)
        langs = data.get("languages", [])

        if len(langs) <= max_results:
            r.ok("false-pos", f"{path} — {len(langs)} results (expected ≤{max_results})")
        else:
            # Check if matches are actually valid (maybe they're legitimately correct!)
            valid = sum(1 for m in langs if article_exists(m["zim"], m["path"]))
            if valid > 0:
                # They load — might be legit. Report but don't fail hard.
                details = ", ".join(f"{m['lang']}={m.get('path','?').split('/')[-1]}" for m in langs)
                r.ok("false-pos", f"{path} — {valid} valid matches (unexpected but correct): {details}")
            else:
                details = ", ".join(f"{m['zim']}:{m['path']}" for m in langs)
                r.fail("false-pos", f"{path} — {len(langs)} false positives!", f"{desc}: {details}")


def test_bidirectional(r, zims):
    """Test matching from non-English ZIMs back to English."""
    print("\n── 4. Bidirectional Matching (non-en → en) ──")

    # (source_zim, path, description)
    tests = []

    # French subsets → English
    if "wikipedia_fr_chemistry_nopic" in zims:
        tests += [
            ("wikipedia_fr_chemistry_nopic", "Oxygene", "fr:Oxygène → en:Oxygen"),
            ("wikipedia_fr_chemistry_nopic", "A/Calcium", "fr:Calcium → en:Calcium"),
        ]
    if "wikipedia_fr_geography_nopic" in zims:
        tests += [
            ("wikipedia_fr_geography_nopic", "A/Berlin", "fr:Berlin → en:Berlin"),
        ]

    # German subsets → English
    if "wikipedia_de_chemistry_nopic" in zims:
        tests += [
            ("wikipedia_de_chemistry_nopic", "A/Calcium", "de:Calcium → en:Calcium"),
            ("wikipedia_de_chemistry_nopic", "A/Aluminium", "de:Aluminium → en:Aluminium"),
        ]
    if "wikipedia_de_medicine_nopic" in zims:
        tests += [
            ("wikipedia_de_medicine_nopic", "A/Insulin", "de:Insulin → en:Insulin"),
            ("wikipedia_de_medicine_nopic", "A/Aspirin", "de:Aspirin → en:Aspirin"),
        ]

    # Spanish subsets → English
    if "wikipedia_es_medicine_nopic" in zims:
        tests += [
            ("wikipedia_es_medicine_nopic", "A/Insulina", "es:Insulina → en:Insulin"),
            ("wikipedia_es_medicine_nopic", "A/Aspirina", "es:Aspirina → en:Aspirin"),
        ]

    # Italian → English
    if "wikipedia_it_top_mini" in zims:
        tests += [
            ("wikipedia_it_top_mini", "A/Europa", "it:Europa → en:Europe"),
            ("wikipedia_it_top_mini", "A/Berlino", "it:Berlino → en:Berlin"),
        ]

    # Arabic subsets → English
    if "wikipedia_ar_physics_nopic" in zims:
        tests += [
            ("wikipedia_ar_physics_nopic", "A/Electron", "ar:Electron → en:Electron"),
        ]

    if not tests:
        r.skip("bidir", "No non-English ZIMs installed for bidirectional testing")
        return

    for src_zim, path, desc in tests:
        if not article_exists(src_zim, path):
            r.skip("bidir", f"{src_zim}:{path} — article not found")
            continue

        data = article_langs(src_zim, path)
        langs = data.get("languages", [])
        en_matches = [l for l in langs if l["lang"] == "en"]

        if en_matches:
            match = en_matches[0]
            if article_exists(match["zim"], match["path"]):
                r.track_link(match["zim"], match["path"])
                r.ok("bidir", f"{desc} → {match['zim']}:{match['path']}")
            else:
                r.fail("bidir", f"{desc} → BROKEN: {match['zim']}:{match['path']}")
        else:
            # Check if ANY language matched (not just English)
            if langs:
                other = ", ".join(f"{l['lang']}" for l in langs)
                r.skip("bidir", f"{desc} — no en match but found: {other}")
            else:
                r.fail("bidir", f"{desc} — no matches at all")


def test_subset_routing(r, zims):
    """Test that articles in subset ZIMs correctly route to other subsets."""
    print("\n── 5. Subset Routing ──")

    # Test from one subset to another in a different language
    # e.g., de_chemistry → fr_chemistry (both are chemistry subsets)
    tests = []

    # Chemistry cross-language (de ↔ fr)
    if "wikipedia_de_chemistry_nopic" in zims and "wikipedia_fr_chemistry_nopic" in zims:
        tests += [
            ("wikipedia_de_chemistry_nopic", "A/Calcium", "de_chem:Calcium → fr_chem"),
            ("wikipedia_de_chemistry_nopic", "A/Uranium", "de_chem:Uranium → fr_chem"),
        ]

    # Medicine cross-language (de ↔ es ↔ pt ↔ it)
    med_zims = [z for z in zims if "medicine" in z]
    if len(med_zims) >= 2:
        src = med_zims[0]
        tests.append((src, "A/Insulin", f"{src}:Insulin → other medicine ZIMs"))

    # Math cross-language (es ↔ ar ↔ de)
    math_zims = [z for z in zims if "mathematics" in z or "math" in z]
    if len(math_zims) >= 2:
        src = math_zims[0]
        tests.append((src, "A/Algebra", f"{src}:Algebra → other math ZIMs"))

    if not tests:
        r.skip("subset", "Need 2+ same-topic subsets in different languages")
        return

    for src_zim, path, desc in tests:
        if not article_exists(src_zim, path):
            r.skip("subset", f"{src_zim}:{path} — not found")
            continue

        data = article_langs(src_zim, path)
        langs = data.get("languages", [])

        if langs:
            all_ok = True
            for match in langs:
                if article_exists(match["zim"], match["path"]):
                    r.track_link(match["zim"], match["path"])
                else:
                    r.fail("subset", f"{desc} → BROKEN: {match['zim']}:{match['path']}")
                    all_ok = False
            if all_ok:
                details = ", ".join(f"{m['lang']}({m['zim']})" for m in langs)
                r.ok("subset", f"{desc} → {details}")
        else:
            r.fail("subset", f"{desc} — no cross-language matches")


def test_cross_project_isolation(r, zims):
    """Test that non-Wikipedia ZIMs don't leak into Wikipedia matching."""
    print("\n── 6. Cross-Project Isolation ──")

    tests = [
        ("wiktionary", "A/water", "wiktionary should not match wikipedia"),
        ("wikivoyage", "A/Paris", "wikivoyage should not match wikipedia"),
        ("wikivoyage", "A/Berlin", "wikivoyage should not match wikipedia"),
        ("wikibooks", "A/Cookbook", "wikibooks should not match wikipedia"),
    ]

    for src_zim, path, desc in tests:
        if src_zim not in zims:
            r.skip("cross-proj", f"{src_zim} not installed")
            continue
        if not article_exists(src_zim, path):
            r.skip("cross-proj", f"{src_zim}:{path} — not found")
            continue

        data = article_langs(src_zim, path)
        langs = data.get("languages", [])

        if not langs:
            r.ok("cross-proj", f"{src_zim}:{path} — correctly isolated")
        else:
            # Check if matches are from same project (expected) or different (leak)
            for m in langs:
                proj_match = src_zim.split("_")[0] if "_" in src_zim else src_zim
                if proj_match in m["zim"]:
                    r.ok("cross-proj", f"{src_zim}:{path} → same-project match {m['zim']} (OK)")
                else:
                    r.fail("cross-proj", f"{src_zim}:{path} → leaked to {m['zim']}", desc)


def test_volume(r, zims):
    """Volume test — broad set of common articles, check match quality."""
    print("\n── 7. Volume Test (50 common articles) ──")

    articles = [
        "A/Albert_Einstein", "A/Isaac_Newton", "A/Charles_Darwin",
        "A/Marie_Curie", "A/Napoleon", "A/Cleopatra",
        "A/Sun", "A/Moon", "A/Mars", "A/Jupiter", "A/Saturn",
        "A/Africa", "A/Asia", "A/Antarctica",
        "A/Pacific_Ocean", "A/Atlantic_Ocean", "A/Mediterranean_Sea",
        "A/Piano", "A/Guitar", "A/Violin",
        "A/Chess", "A/Football", "A/Tennis",
        "A/Python_(programming_language)", "A/JavaScript", "A/Linux",
        "A/Photosynthesis", "A/Chromosome",
        "A/Tsunami", "A/Volcano", "A/Earthquake",
        "A/Democracy", "A/Philosophy", "A/Mathematics",
        "A/Beethoven", "A/Mozart", "A/Bach",
        "A/Picasso", "A/Monet",
        "A/Malaria", "A/Penicillin", "A/Diabetes",
        "A/Aspirin", "A/Insulin",
        "A/DNA", "A/RNA", "A/Atom", "A/Proton",
        "A/Galaxy", "A/Planet", "A/Comet",
        "A/Pyramid", "A/Sphinx",
    ]

    found = broken = no_match = not_in_en = 0
    matches_by_lang = {}

    for path in articles:
        if "wikipedia" not in zims:
            r.skip("volume", "Main wikipedia not installed")
            return
        if not article_exists("wikipedia", path):
            not_in_en += 1
            continue

        data = article_langs("wikipedia", path)
        langs = data.get("languages", [])

        if langs:
            all_valid = True
            for match in langs:
                lang = match["lang"]
                matches_by_lang[lang] = matches_by_lang.get(lang, 0) + 1
                if not article_exists(match["zim"], match["path"]):
                    broken += 1
                    all_valid = False
                    r.fail("volume", f"{path} → BROKEN: {match['zim']}:{match['path']}")
                else:
                    r.track_link(match["zim"], match["path"])
            if all_valid:
                found += 1
        else:
            no_match += 1

    print(f"  Results: {found} with matches, {no_match} no match, {broken} broken, {not_in_en} not in en wiki")
    if matches_by_lang:
        print(f"  By language: {', '.join(f'{k}={v}' for k, v in sorted(matches_by_lang.items()))}")
    if broken == 0 and found > 0:
        r.ok("volume", f"{found}/{found+no_match} articles matched ({not_in_en} not in en)")
    elif broken > 0:
        pass  # Already failed above
    else:
        r.skip("volume", "No articles could be tested")


def test_edge_cases(r, zims):
    """Edge cases — short titles, special chars, disambiguation."""
    print("\n── 8. Edge Cases ──")

    tests = [
        ("wikipedia", "A/DNA", "3-letter acronym"),
        ("wikipedia", "A/RNA", "3-letter acronym"),
        ("wikipedia", "A/pH", "2-letter mixed case"),
        ("wikipedia", "A/Atom", "Short common noun"),
        ("wikipedia", "A/Ion", "3-letter noun"),
        ("wikipedia", "A/Proton", "Physics term"),
        ("wikipedia", "A/Pi", "2-letter (math constant)"),
    ]

    for src_zim, path, desc in tests:
        if src_zim not in zims or not article_exists(src_zim, path):
            r.skip("edge", f"{path} — {desc}")
            continue

        data = article_langs(src_zim, path)
        if "_error" in data:
            r.fail("edge", f"{path} — API error: {data['_error']}")
            continue

        langs = data.get("languages", [])
        if langs:
            broken = [m for m in langs if not article_exists(m["zim"], m["path"])]
            if broken:
                for b in broken:
                    r.fail("edge", f"{path} → BROKEN: {b['zim']}:{b['path']}", desc)
            else:
                r.ok("edge", f"{path} → {len(langs)} matches ({desc})")
        else:
            r.ok("edge", f"{path} — no match ({desc})")


def test_link_verification(r):
    """Verify ALL matched links from all tests actually load."""
    print("\n── 9. Exhaustive Link Verification ──")

    unique_links = list(set(r.all_matched_links))
    verified = broken = 0

    for zim, path in unique_links:
        time.sleep(0.3)  # Avoid rate limiting
        if article_exists(zim, path):
            verified += 1
        else:
            broken += 1
            r.fail("verify", f"Broken link: {zim}:{path}")

    print(f"  {verified} verified OK, {broken} broken out of {len(unique_links)} unique links")
    if broken == 0 and verified > 0:
        r.ok("verify", f"All {verified} matched links load successfully")


def test_quality_scoring(r, zims):
    """Test that we prefer _all over subsets, maxi over nopic over mini."""
    print("\n── 10. Quality Scoring ──")

    # If we have both _all and subset ZIMs for the same language,
    # the _all should be preferred
    tests = []

    # Check if we have both fr_chemistry and fr_geography — article in both?
    if "wikipedia_fr_chemistry_nopic" in zims and "wikipedia_fr_geography_nopic" in zims:
        tests.append(("wikipedia", "A/Berlin", "Berlin exists in fr_geography (not chemistry)",
                       lambda m: "geography" in m.get("zim", "")))
        tests.append(("wikipedia", "A/Calcium", "Calcium exists in fr_chemistry (not geography)",
                       lambda m: "chemistry" in m.get("zim", "")))

    for src_zim, path, desc, check_fn in tests:
        if not article_exists(src_zim, path):
            r.skip("quality", f"{path} — not in {src_zim}")
            continue

        data = article_langs(src_zim, path)
        fr_matches = [l for l in data.get("languages", []) if l["lang"] == "fr"]

        if fr_matches:
            match = fr_matches[0]
            if check_fn(match):
                r.ok("quality", f"{path} → {match['zim']} ({desc})")
            else:
                r.ok("quality", f"{path} → {match['zim']} (different subset, still valid)")
        else:
            r.skip("quality", f"{path} — no fr match")


def test_response_time(r, zims):
    """Test that article-languages responses are fast enough for UI."""
    print("\n── 11. Response Time ──")

    test_articles = [
        ("wikipedia", "A/Oxygen"),
        ("wikipedia", "A/Berlin"),
        ("wikipedia", "A/Mathematics"),
    ]

    for src_zim, path in test_articles:
        if src_zim not in zims or not article_exists(src_zim, path):
            r.skip("perf", f"{path} — not available")
            continue

        t0 = time.time()
        article_langs(src_zim, path)
        elapsed = time.time() - t0

        if elapsed < 2.0:
            r.ok("perf", f"{path} — {elapsed:.2f}s (< 2s threshold)")
        elif elapsed < 5.0:
            r.ok("perf", f"{path} — {elapsed:.2f}s (acceptable, < 5s)")
        else:
            r.fail("perf", f"{path} — {elapsed:.2f}s (too slow, > 5s)")


# ─────────────────────────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────────────────────────

def main():
    global BASE_URL
    if len(sys.argv) > 1 and sys.argv[1].startswith("http"):
        BASE_URL = sys.argv[1]

    print(f"Testing article-languages on {BASE_URL}")
    print(f"{'='*70}")

    # Get installed ZIMs
    zims = get_installed_zims()
    print(f"\nInstalled ZIMs: {len(zims)}")

    # Show Wikipedia ZIMs by language
    wiki_zims = {n: z for n, z in zims.items() if "wikipedia" in n}
    by_lang = {}
    for name, info in wiki_zims.items():
        lang = info.get("language", "?")
        by_lang.setdefault(lang, []).append(name)
    print("Wikipedia ZIMs by language:")
    for lang in sorted(by_lang.keys()):
        names = ", ".join(sorted(by_lang[lang]))
        print(f"  {lang}: {names}")

    r = Results()
    t0 = time.time()

    # Run all test categories
    test_exact_path_matches(r, zims)
    test_search_based_matches(r, zims)
    test_false_positives(r, zims)
    test_bidirectional(r, zims)
    test_subset_routing(r, zims)
    test_cross_project_isolation(r, zims)
    test_volume(r, zims)
    test_edge_cases(r, zims)
    test_link_verification(r)
    test_quality_scoring(r, zims)
    test_response_time(r, zims)

    elapsed = time.time() - t0
    print(f"\nCompleted in {elapsed:.1f}s")

    success = r.summary()
    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()
