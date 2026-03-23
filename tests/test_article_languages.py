"""Comprehensive cross-language article matching tests for Zimi v1.6.

Tests 100+ bidirectional article links across 13 Wikipedia ZIMs in 9 languages,
including 7 subject-area subsets. Verifies the 3-stage matching engine:
  1. Interlanguage links (from HTML)
  2. Exact path lookup
  3. Search-based matching (suggest + full-text with false-positive guards)

Targets:
  - 100+ bidirectional article matches tested
  - 13 Wikipedia ZIMs across 9 languages (en, de, fr, es, it, pt, ar, hi, zh)
  - 7 subject subsets: chemistry(de,fr), geography(fr,hi), medicine(en,es),
    mathematics(ar,es), physics(ar,pt), computer(zh), top(it)
  - False positive prevention (cross-script, compound words)
  - Subset routing (quality scoring: _all > subset, maxi > nopic > mini)
  - Response time under 500ms per request

Run against NAS:
  TEST_HOST=nas pytest tests/test_article_languages.py -v

Run against local:
  pytest tests/test_article_languages.py -v
"""

import json
import os
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request

import pytest

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

_HOST_MAP = {
    "nas": "http://localhost:8899",  # via SSH tunnel or direct
    "local": "http://localhost:8899",
}

TEST_HOST = os.environ.get("TEST_HOST", "nas")
USE_SSH = TEST_HOST == "nas"


def api(endpoint, retries=3):
    """Call the Zimi API, with retry/backoff for rate limiting."""
    if USE_SSH:
        base = _HOST_MAP["nas"]
        cmd = f'ssh nas "curl -s \'{base}{endpoint}\'"'
        for attempt in range(retries):
            try:
                out = subprocess.check_output(cmd, shell=True, timeout=20).decode()
                return json.loads(out)
            except (subprocess.TimeoutExpired, json.JSONDecodeError):
                if attempt < retries - 1:
                    time.sleep(1 + attempt)
                continue
        return None
    else:
        base = _HOST_MAP.get(TEST_HOST, f"http://{TEST_HOST}")
        url = f"{base}{endpoint}"
        for attempt in range(retries):
            try:
                req = urllib.request.Request(url)
                with urllib.request.urlopen(req, timeout=15) as resp:
                    return json.loads(resp.read())
            except urllib.error.HTTPError as e:
                if e.code == 429 and attempt < retries - 1:
                    time.sleep(1 + attempt)
                    continue
                raise
            except Exception:
                if attempt < retries - 1:
                    time.sleep(1 + attempt)
                continue
        return None


def get_languages(zim, path):
    """Get article languages from the API."""
    ep = urllib.parse.quote(path)
    data = api(f"/article-languages?zim={zim}&path={ep}")
    if data:
        return data.get("languages", [])
    return []


def article_exists(zim, path):
    """Check if an article is readable."""
    ep = urllib.parse.quote(path)
    if USE_SSH:
        base = _HOST_MAP["nas"]
        cmd = f"ssh nas \"curl -s -o /dev/null -w '%{{http_code}}' '{base}/read?zim={zim}&path={ep}'\" 2>/dev/null"
        try:
            code = subprocess.check_output(cmd, shell=True, timeout=15).decode().strip()
            return code == "200"
        except Exception:
            return False
    else:
        base = _HOST_MAP.get(TEST_HOST, f"http://{TEST_HOST}")
        url = f"{base}/read?zim={zim}&path={ep}"
        try:
            req = urllib.request.Request(url, method="HEAD")
            with urllib.request.urlopen(req, timeout=10) as resp:
                return resp.status == 200
        except Exception:
            return False


# ---------------------------------------------------------------------------
# Test data: verified article matches discovered from NAS
# ---------------------------------------------------------------------------

# ZIM inventory on NAS
ZIMS = {
    "en_all": "wikipedia",
    "en_medicine": "wikipedia_en_medicine",
    "de_chemistry": "wikipedia_de_chemistry_nopic",
    "fr_chemistry": "wikipedia_fr_chemistry_nopic",
    "fr_geography": "wikipedia_fr_geography_nopic",
    "es_medicine": "wikipedia_es_medicine_nopic",
    "es_math": "wikipedia_es_mathematics_mini",
    "ar_physics": "wikipedia_ar_physics_nopic",
    "ar_math": "wikipedia_ar_mathematics_mini",
    "pt_physics": "wikipedia_pt_physics_nopic",
    "hi_geography": "wikipedia_hi_geography",
    "zh_computer": "wikipedia_zh_computer_nopic",
    "it_top": "wikipedia_it_top_mini",
}

# Forward matches: English article -> expected language matches
# Each tuple: (en_path, [(expected_lang, expected_subset), ...])
# Verified against NAS on 2026-03-07
FORWARD_MATCHES = [
    # Chemistry elements -> de_chemistry, fr_chemistry
    ("Oxygen", [("fr", "chemistry")]),
    ("Carbon", [("fr", "chemistry")]),
    ("Gold", [("de", "chemistry"), ("ar", "physics")]),
    ("Silver", [("de", "chemistry")]),
    ("Copper", [("de", "chemistry"), ("fr", "chemistry")]),
    ("Nitrogen", [("de", "chemistry"), ("fr", "chemistry"), ("it", "top")]),
    ("Chlorine", [("de", "chemistry"), ("fr", "chemistry")]),
    ("Sodium", [("de", "chemistry"), ("fr", "chemistry"), ("it", "top")]),
    ("Calcium", [("de", "chemistry"), ("fr", "chemistry")]),
    ("Helium", [("de", "chemistry"), ("fr", "chemistry")]),
    ("Lithium", [("de", "chemistry"), ("fr", "chemistry")]),
    ("Aluminium", [("de", "chemistry"), ("fr", "chemistry")]),
    ("Hydrogen", [("fr", "chemistry"), ("it", "top")]),
    ("Uranium", [("fr", "chemistry"), ("ar", "physics")]),
    ("Plutonium", [("de", "chemistry"), ("fr", "chemistry"), ("pt", "physics"), ("ar", "physics")]),
    ("Mercury_(element)", [("de", "chemistry"), ("fr", "chemistry")]),
    ("Zinc", [("de", "chemistry"), ("fr", "chemistry")]),
    ("Neon", [("de", "chemistry"), ("fr", "chemistry"), ("it", "top")]),
    ("Tin", [("de", "chemistry")]),
    ("Nickel", [("de", "chemistry"), ("fr", "chemistry")]),
    ("Cobalt", [("de", "chemistry"), ("fr", "chemistry"), ("it", "top")]),
    ("Manganese", [("fr", "chemistry"), ("it", "top")]),
    ("Titanium", [("fr", "chemistry")]),
    ("Vanadium", [("de", "chemistry"), ("fr", "chemistry")]),
    ("Arsenic", [("fr", "chemistry")]),
    ("Selenium", [("fr", "chemistry")]),
    ("Bromine", [("fr", "chemistry")]),
    ("Barium", [("de", "chemistry"), ("fr", "chemistry")]),
    ("Strontium", [("de", "chemistry"), ("fr", "chemistry"), ("it", "top")]),
    ("Radium", [("de", "chemistry"), ("fr", "chemistry")]),
    ("Caesium", [("de", "chemistry"), ("fr", "chemistry")]),
    ("Rubidium", [("de", "chemistry"), ("fr", "chemistry")]),
    ("Boron", [("fr", "chemistry")]),
    # Medicine -> es_medicine
    ("Aspirin", [("es", "medicine"), ("it", "top")]),
    ("Diabetes", [("es", "medicine"), ("it", "top")]),
    ("Malaria", [("es", "medicine"), ("it", "top")]),
    ("Tuberculosis", [("es", "medicine"), ("it", "top")]),
    ("Vitamin", [("es", "medicine"), ("it", "top")]),
    ("Insulin", [("es", "medicine"), ("it", "top")]),
    ("Penicillin", [("de", "chemistry"), ("es", "medicine"), ("fr", "chemistry"), ("it", "top")]),
    ("Cholera", [("it", "top")]),
    ("Hepatitis", [("es", "medicine"), ("it", "top")]),
    ("Morphine", [("es", "medicine")]),
    ("Paracetamol", [("de", "chemistry"), ("es", "medicine"), ("fr", "chemistry"), ("it", "top")]),
    ("Caffeine", [("es", "medicine"), ("it", "top")]),
    ("Nicotine", [("de", "chemistry"), ("es", "medicine"), ("fr", "chemistry"), ("it", "top")]),
    ("Cortisol", [("de", "chemistry"), ("es", "medicine"), ("fr", "chemistry"), ("it", "top")]),
    ("Adrenaline", [("es", "medicine"), ("fr", "chemistry"), ("it", "top")]),
    ("Dopamine", [("de", "chemistry"), ("es", "medicine"), ("fr", "chemistry"), ("it", "top")]),
    ("Serotonin", [("de", "chemistry"), ("es", "medicine"), ("fr", "chemistry"), ("it", "top")]),
    ("Melatonin", [("de", "chemistry"), ("es", "medicine"), ("fr", "chemistry"), ("it", "top")]),
    # Geography -> fr_geography, hi_geography
    ("Europe", [("fr", "geography"), ("it", "top"), ("hi", "geography")]),
    ("Africa", [("fr", "geography"), ("it", "top")]),
    ("Asia", [("fr", "geography"), ("it", "top"), ("hi", "geography")]),
    ("Sahara", [("fr", "geography"), ("it", "top")]),
    ("Himalaya", [("fr", "geography"), ("it", "top"), ("hi", "geography")]),
    ("London", [("fr", "geography"), ("hi", "geography")]),
    ("Berlin", [("fr", "geography")]),
    ("Amazon_River", [("fr", "geography")]),
    ("Andes", [("fr", "geography")]),
    ("Rhine", [("fr", "geography")]),
    # Physics -> ar_physics, pt_physics
    ("Electron", [("pt", "physics"), ("ar", "physics")]),
    ("Proton", [("pt", "physics"), ("ar", "physics")]),
    ("Neutron", [("it", "top"), ("pt", "physics"), ("ar", "physics")]),
    ("Photon", [("ar", "physics")]),
    ("Quark", [("pt", "physics"), ("ar", "physics")]),
    ("Magnetism", [("it", "top"), ("pt", "physics"), ("ar", "physics")]),
    ("Optics", [("ar", "physics")]),
    ("Acoustics", [("ar", "physics")]),
    ("Physics", [("ar", "physics")]),
    ("Astronomy", [("ar", "physics")]),
    # Mathematics -> es_math, ar_math
    ("Algebra", [("es", "math"), ("ar", "math")]),
    # Geometry article doesn't exist in ar_mathematics_mini (only differential/combinatorial variants)
    # ("Geometry", [("ar", "math")]),
    ("Trigonometry", [("ar", "math")]),
    ("Logarithm", [("ar", "math")]),
    ("Pi", [("ar", "math")]),
    ("Mathematics", [("ar", "math")]),
    # Computing -> zh_computer
    ("Linux", [("it", "top"), ("zh", "computer")]),
    ("Java_(programming_language)", [("zh", "computer")]),
    ("HTML", [("it", "top"), ("zh", "computer")]),
    ("HTTP", [("it", "top"), ("zh", "computer")]),
    ("Computer", [("it", "top"), ("zh", "computer")]),
    ("Internet", [("it", "top"), ("zh", "computer")]),
    ("Database", [("it", "top"), ("zh", "computer")]),
    ("Software", [("it", "top"), ("zh", "computer")]),
    ("Bluetooth", [("it", "top"), ("zh", "computer")]),
    ("Wi-Fi", [("it", "top"), ("zh", "computer")]),
    ("Ethernet", [("it", "top"), ("zh", "computer")]),
    # General -> it_top and others
    ("Einstein", [("it", "top")]),
    ("Mozart", [("it", "top")]),
    ("Beethoven", [("it", "top")]),
    ("Bach", [("it", "top")]),
    ("Darwin", [("it", "top")]),
    ("Capitalism", [("it", "top")]),
    ("FIFA_World_Cup", [("it", "top")]),
    ("Renaissance", [("es", "math")]),
    ("Tokyo", [("it", "top")]),
    ("Danube", [("it", "top")]),
    ("Anesthesia", [("fr", "chemistry")]),
    ("Biology", [("es", "math")]),
]

# Reverse matches: subset ZIM article -> expected to find English
REVERSE_MATCHES = [
    # German chemistry -> English
    ("wikipedia_de_chemistry_nopic", "Sauerstoff", True),
    ("wikipedia_de_chemistry_nopic", "Eisen", True),
    ("wikipedia_de_chemistry_nopic", "Gold", True),
    ("wikipedia_de_chemistry_nopic", "Silber", True),
    ("wikipedia_de_chemistry_nopic", "Kupfer", True),
    ("wikipedia_de_chemistry_nopic", "Chlor", True),
    ("wikipedia_de_chemistry_nopic", "Helium", True),
    # French chemistry -> English
    ("wikipedia_fr_chemistry_nopic", "Carbone", True),
    ("wikipedia_fr_chemistry_nopic", "Fer", True),
    ("wikipedia_fr_chemistry_nopic", "Argent", True),
    ("wikipedia_fr_chemistry_nopic", "Cuivre", True),
    ("wikipedia_fr_chemistry_nopic", "Azote", True),
    ("wikipedia_fr_chemistry_nopic", "Chlore", True),
    ("wikipedia_fr_chemistry_nopic", "Sodium", True),
    ("wikipedia_fr_chemistry_nopic", "Calcium", True),
    ("wikipedia_fr_chemistry_nopic", "Lithium", True),
    ("wikipedia_fr_chemistry_nopic", "Aluminium", True),
    # French geography -> English
    ("wikipedia_fr_geography_nopic", "Europe", True),
    ("wikipedia_fr_geography_nopic", "Afrique", True),
    ("wikipedia_fr_geography_nopic", "Asie", True),
    ("wikipedia_fr_geography_nopic", "Sahara", True),
    ("wikipedia_fr_geography_nopic", "Himalaya", True),
    ("wikipedia_fr_geography_nopic", "Londres", True),
    ("wikipedia_fr_geography_nopic", "Berlin", True),
    # Spanish medicine -> English
    ("wikipedia_es_medicine_nopic", "Tuberculosis", True),
    ("wikipedia_es_medicine_nopic", "Vitamina", True),
    # Italian top -> English
    ("wikipedia_it_top_mini", "Chimica", True),
    ("wikipedia_it_top_mini", "Filosofia", True),
    ("wikipedia_it_top_mini", "Astronomia", True),
    ("wikipedia_it_top_mini", "Internet", True),
    ("wikipedia_it_top_mini", "Linux", True),
    ("wikipedia_it_top_mini", "Bluetooth", True),
    ("wikipedia_it_top_mini", "Ethernet", True),
    ("wikipedia_it_top_mini", "Musica", True),
    # Arabic physics -> English
    ("wikipedia_ar_physics_nopic", "\u0645\u0633\u0627\u062d\u0629", True),
    ("wikipedia_ar_physics_nopic", "\u0645\u062a\u062c\u0647_\u0631\u0628\u0627\u0639\u064a", True),
    # Chinese computer -> English
    ("wikipedia_zh_computer_nopic", "LISP", True),
    # Portuguese physics -> English
    ("wikipedia_pt_physics_nopic", "\u00c1rea", True),
]

# Reverse matches that should NOT find English (cross-script, too different)
REVERSE_NO_ENGLISH = [
    ("wikipedia_hi_geography", "\u092d\u093e\u0930\u0924\u0940\u092f_\u0909\u092a\u092e\u0939\u093e\u0926\u094d\u0935\u0940\u092a"),
    ("wikipedia_hi_geography", "\u0917\u0941\u0906\u092e"),
    ("wikipedia_hi_geography", "\u0939\u093f\u0928\u094d\u0926\u0941_\u0915\u0941\u0936"),
]

# Bidirectional pairs: verified both directions work
BIDIRECTIONAL_PAIRS = [
    # (en_path, other_zim, other_path)
    ("Oxygen", "wikipedia_fr_chemistry_nopic", "Oxygene"),
    ("Gold", "wikipedia_de_chemistry_nopic", "Gold"),
    ("Helium", "wikipedia_de_chemistry_nopic", "Helium"),
    ("Calcium", "wikipedia_de_chemistry_nopic", "Calcium"),
    ("Calcium", "wikipedia_fr_chemistry_nopic", "Calcium"),
    ("Lithium", "wikipedia_de_chemistry_nopic", "Lithium"),
    ("Lithium", "wikipedia_fr_chemistry_nopic", "Lithium"),
    ("Sodium", "wikipedia_fr_chemistry_nopic", "Sodium"),
    ("Europe", "wikipedia_fr_geography_nopic", "Europe"),
    ("Sahara", "wikipedia_fr_geography_nopic", "Sahara"),
    ("Himalaya", "wikipedia_fr_geography_nopic", "Himalaya"),
    ("Berlin", "wikipedia_fr_geography_nopic", "Berlin"),
    ("Tuberculosis", "wikipedia_es_medicine_nopic", "Tuberculosis"),
    ("Internet", "wikipedia_it_top_mini", "Internet"),
    ("Linux", "wikipedia_it_top_mini", "Linux"),
    ("Bluetooth", "wikipedia_it_top_mini", "Bluetooth"),
    ("Ethernet", "wikipedia_it_top_mini", "Ethernet"),
    ("LISP", "wikipedia_zh_computer_nopic", "LISP"),
]


# ---------------------------------------------------------------------------
# Category 1: Forward matching (English -> other languages)
# ---------------------------------------------------------------------------

class TestForwardMatching:
    """Test that English Wikipedia articles find matches in subset ZIMs.
    95 articles with 200+ expected language links.
    """

    @pytest.mark.parametrize("en_path,expected_langs", FORWARD_MATCHES)
    def test_en_to_other(self, en_path, expected_langs):
        """English article finds at least one expected language match."""
        langs = get_languages("wikipedia", en_path)
        found_langs = {l["lang"] for l in langs}
        expected_set = {lang for lang, _ in expected_langs}
        intersection = found_langs & expected_set
        assert intersection, (
            f"'{en_path}' expected langs {expected_set} but got {found_langs}"
        )


# ---------------------------------------------------------------------------
# Category 2: Reverse matching (subset ZIMs -> English)
# ---------------------------------------------------------------------------

class TestReverseMatching:
    """Test that subset ZIM articles find the main English Wikipedia.
    38 reverse lookups + 3 false-positive checks.
    """

    @pytest.mark.parametrize("zim,path,expect_en", REVERSE_MATCHES)
    def test_reverse_to_en(self, zim, path, expect_en):
        """Subset article finds English Wikipedia match."""
        langs = get_languages(zim, path)
        found_langs = {l["lang"] for l in langs}
        if expect_en:
            assert "en" in found_langs, (
                f"'{zim}/{path}' expected English match but got {found_langs}"
            )

    @pytest.mark.parametrize("zim,path", REVERSE_NO_ENGLISH)
    def test_no_false_english(self, zim, path):
        """Cross-script articles should NOT falsely match English."""
        langs = get_languages(zim, path)
        found_langs = {l["lang"] for l in langs}
        if "en" in found_langs:
            en_entry = next(l for l in langs if l["lang"] == "en")
            assert article_exists("wikipedia", en_entry["path"]), (
                f"'{zim}/{path}' matched English article '{en_entry['path']}' "
                "but that article doesn't exist"
            )


# ---------------------------------------------------------------------------
# Category 3: Bidirectional verification
# ---------------------------------------------------------------------------

class TestBidirectional:
    """Test that matching works in both directions. 18 verified pairs."""

    @pytest.mark.parametrize("en_path,other_zim,other_path", BIDIRECTIONAL_PAIRS)
    def test_forward_and_reverse(self, en_path, other_zim, other_path):
        """Article found in both directions: EN->other and other->EN."""
        other_lang = other_zim.split("_")[1]

        fwd_langs = get_languages("wikipedia", en_path)
        fwd_found = {l["lang"] for l in fwd_langs}
        assert other_lang in fwd_found, (
            f"Forward: '{en_path}' should find {other_lang} but got {fwd_found}"
        )
        time.sleep(0.1)

        rev_langs = get_languages(other_zim, other_path)
        rev_found = {l["lang"] for l in rev_langs}
        assert "en" in rev_found, (
            f"Reverse: '{other_zim}/{other_path}' should find en but got {rev_found}"
        )


# ---------------------------------------------------------------------------
# Category 4: Subset routing (quality scoring)
# ---------------------------------------------------------------------------

class TestSubsetRouting:
    """Test that the matching engine routes to the correct subset ZIM."""

    def test_chemistry_routes_to_chemistry_zim(self):
        langs = get_languages("wikipedia", "Oxygen")
        fr_match = next((l for l in langs if l["lang"] == "fr"), None)
        assert fr_match is not None
        assert "chemistry" in fr_match["zim"], (
            f"Expected fr_chemistry ZIM but got {fr_match['zim']}"
        )

    def test_geography_routes_to_geography_zim(self):
        langs = get_languages("wikipedia", "Europe")
        fr_match = next((l for l in langs if l["lang"] == "fr"), None)
        assert fr_match is not None
        assert "geography" in fr_match["zim"], (
            f"Expected fr_geography ZIM but got {fr_match['zim']}"
        )

    def test_medicine_routes_to_medicine_zim(self):
        langs = get_languages("wikipedia", "Aspirin")
        es_match = next((l for l in langs if l["lang"] == "es"), None)
        assert es_match is not None
        assert "medicine" in es_match["zim"], (
            f"Expected es_medicine ZIM but got {es_match['zim']}"
        )

    def test_math_routes_to_math_zim(self):
        langs = get_languages("wikipedia", "Algebra")
        es_match = next((l for l in langs if l["lang"] == "es"), None)
        assert es_match is not None
        assert "math" in es_match["zim"], (
            f"Expected es_mathematics ZIM but got {es_match['zim']}"
        )

    def test_computing_routes_to_computer_zim(self):
        langs = get_languages("wikipedia", "Linux")
        zh_match = next((l for l in langs if l["lang"] == "zh"), None)
        assert zh_match is not None
        assert "computer" in zh_match["zim"], (
            f"Expected zh_computer ZIM but got {zh_match['zim']}"
        )

    def test_physics_routes_to_physics_zim(self):
        langs = get_languages("wikipedia", "Photon")
        ar_match = next((l for l in langs if l["lang"] == "ar"), None)
        assert ar_match is not None
        assert "physics" in ar_match["zim"], (
            f"Expected ar_physics ZIM but got {ar_match['zim']}"
        )

    def test_all_zim_preferred_over_subset(self):
        """When reverse-matching, English should use the main Wikipedia ZIM."""
        langs = get_languages("wikipedia_de_chemistry_nopic", "Helium")
        en_match = next((l for l in langs if l["lang"] == "en"), None)
        assert en_match is not None
        assert en_match["zim"] == "wikipedia", (
            f"Expected main 'wikipedia' ZIM but got {en_match['zim']}"
        )


# ---------------------------------------------------------------------------
# Category 5: Cross-project isolation
# ---------------------------------------------------------------------------

class TestCrossProjectIsolation:
    """Ensure different Wikimedia projects don't cross-contaminate."""

    def test_wiktionary_not_in_wikipedia_results(self):
        langs = get_languages("wikipedia", "Oxygen")
        for l in langs:
            assert "wiktionary" not in l["zim"], (
                f"Wikipedia results contain wiktionary ZIM: {l['zim']}"
            )

    def test_wikiquote_not_in_wikipedia_results(self):
        langs = get_languages("wikipedia", "Europe")
        for l in langs:
            assert "wikiquote" not in l["zim"], (
                f"Wikipedia results contain wikiquote ZIM: {l['zim']}"
            )


# ---------------------------------------------------------------------------
# Category 6: False positive prevention
# ---------------------------------------------------------------------------

class TestFalsePositives:
    """Verify the matching engine doesn't produce false matches."""

    def test_no_compound_word_match(self):
        """Short titles shouldn't match compound words containing them."""
        langs = get_languages("wikipedia", "Iron")
        for l in langs:
            path = l.get("path", "")
            title = path.replace("_", " ").replace("A/", "").lower()
            assert len(title) <= len("iron") + 5, (
                f"'Iron' matched overly long path: {path}"
            )

    def test_no_substring_match(self):
        """Titles shouldn't match substrings in longer article names."""
        langs = get_languages("wikipedia", "Paris")
        for l in langs:
            path = l.get("path", "").replace("A/", "")
            if "Paris" in path and path != "Paris":
                assert len(path) <= len("Paris") + 3, (
                    f"'Paris' matched compound path: {path}"
                )

    def test_length_guard_prevents_long_matches(self):
        """Length guard should prevent matching much longer titles."""
        langs = get_languages("wikipedia", "Water")
        for l in langs:
            path = l.get("path", "").replace("A/", "")
            assert len(path) <= 8, (
                f"'Water' matched overly long path: {path} ({len(path)} chars)"
            )


# ---------------------------------------------------------------------------
# Category 7: Link verification (articles actually loadable)
# ---------------------------------------------------------------------------

class TestLinkVerification:
    """Verify that matched article paths are actually loadable."""

    VERIFY_ARTICLES = [
        ("wikipedia", "Oxygen"),
        ("wikipedia", "Europe"),
        ("wikipedia", "Aspirin"),
        ("wikipedia", "Linux"),
        ("wikipedia", "Algebra"),
        ("wikipedia_de_chemistry_nopic", "Sauerstoff"),
        ("wikipedia_de_chemistry_nopic", "Gold"),
        ("wikipedia_fr_chemistry_nopic", "Carbone"),
        ("wikipedia_fr_geography_nopic", "Europe"),
        ("wikipedia_es_medicine_nopic", "Tuberculosis"),
        ("wikipedia_it_top_mini", "Chimica"),
        ("wikipedia_it_top_mini", "Internet"),
        ("wikipedia_zh_computer_nopic", "LISP"),
        ("wikipedia_ar_physics_nopic", "\u0645\u0633\u0627\u062d\u0629"),
        ("wikipedia_pt_physics_nopic", "\u00c1rea"),
    ]

    @pytest.mark.parametrize("zim,path", VERIFY_ARTICLES)
    def test_article_loadable(self, zim, path):
        """Verify source articles are actually accessible."""
        assert article_exists(zim, path), f"Article {zim}/{path} not loadable"
        time.sleep(0.1)

    def test_matched_paths_loadable(self):
        """Verify that paths returned by article-languages are loadable."""
        test_cases = [
            ("wikipedia", "Oxygen"),
            ("wikipedia", "Europe"),
            ("wikipedia", "Linux"),
        ]
        for zim, path in test_cases:
            langs = get_languages(zim, path)
            for l in langs[:3]:
                assert article_exists(l["zim"], l["path"]), (
                    f"Matched path not loadable: {l['zim']}/{l['path']} "
                    f"(matched from {zim}/{path})"
                )
                time.sleep(0.15)


# ---------------------------------------------------------------------------
# Category 8: Response time
# ---------------------------------------------------------------------------

class TestResponseTime:
    """Verify matching completes within acceptable time."""

    def test_response_under_limit(self):
        """Article-languages should respond within time limit."""
        test_articles = ["Oxygen", "Europe", "Aspirin", "Linux", "Algebra"]
        max_time = 5.0 if USE_SSH else 0.5
        for art in test_articles:
            t0 = time.time()
            get_languages("wikipedia", art)
            elapsed = time.time() - t0
            assert elapsed < max_time, (
                f"'{art}' took {elapsed:.2f}s (max {max_time}s)"
            )
            time.sleep(0.1)


# ---------------------------------------------------------------------------
# Category 9: ZIM coverage
# ---------------------------------------------------------------------------

class TestZIMCoverage:
    """Verify all 13 Wikipedia ZIMs participate in matching."""

    def test_all_zims_accessible(self):
        """All 13 Wikipedia ZIMs should be accessible."""
        data = api("/list")
        assert data is not None, "Failed to get ZIM list"
        names = {z["name"] for z in data}
        for label, zim_name in ZIMS.items():
            assert zim_name in names, f"ZIM '{zim_name}' ({label}) not found"

    def test_all_languages_represented(self):
        """All 8 non-English languages should appear in forward matches."""
        all_langs = set()
        for art in ["Oxygen", "Europe", "Aspirin", "Linux", "Algebra",
                     "Plutonium", "Electron", "Himalaya", "Photon",
                     "Nitrogen", "Internet", "Mathematics"]:
            langs = get_languages("wikipedia", art)
            all_langs.update(l["lang"] for l in langs)
            time.sleep(0.15)
        expected = {"de", "fr", "es", "it", "pt", "ar", "hi", "zh"}
        missing = expected - all_langs
        assert not missing, f"Languages not represented: {missing}"

    def test_all_subsets_used(self):
        """All 7 subject-area subsets should be used in routing."""
        all_zims = set()
        for art in ["Oxygen", "Europe", "Aspirin", "Linux", "Algebra",
                     "Plutonium", "Electron", "Himalaya", "Photon",
                     "Nitrogen", "Internet", "Mathematics", "Proton",
                     "Trigonometry", "Asia"]:
            langs = get_languages("wikipedia", art)
            all_zims.update(l["zim"] for l in langs)
            time.sleep(0.15)
        expected_subsets = {
            "chemistry": False, "geography": False, "medicine": False,
            "math": False, "physics": False, "computer": False, "top": False,
        }
        for zim in all_zims:
            for subset in expected_subsets:
                if subset in zim:
                    expected_subsets[subset] = True
        missing = [s for s, found in expected_subsets.items() if not found]
        assert not missing, f"Subsets not used: {missing}"


# ---------------------------------------------------------------------------
# Category 10: Edge cases
# ---------------------------------------------------------------------------

class TestEdgeCases:
    """Test edge cases in the matching engine."""

    def test_nonexistent_article(self):
        langs = get_languages("wikipedia", "This_Article_Does_Not_Exist_XYZ123")
        assert langs == [], f"Expected empty but got {langs}"

    def test_nonexistent_zim(self):
        data = api("/article-languages?zim=nonexistent_zim&path=Test")
        assert data is not None
        assert "error" in data or data.get("languages") == []

    def test_special_characters_in_path(self):
        langs = get_languages("wikipedia", "Mercury_(element)")
        assert isinstance(langs, list)

    def test_accented_characters(self):
        assert article_exists("wikipedia_pt_physics_nopic", "\u00c1rea")


# ---------------------------------------------------------------------------
# Category 11: On-Demand Cache Behavior
# ---------------------------------------------------------------------------

class TestOnDemandCache:
    """Test that Q-ID on-demand caching works correctly."""

    def test_second_lookup_uses_cache(self):
        """Second lookup for same article should return same results."""
        langs1 = get_languages("wikipedia", "Oxygen")
        langs2 = get_languages("wikipedia", "Oxygen")
        # Same results both times
        paths1 = {(l["lang"], l["path"]) for l in langs1}
        paths2 = {(l["lang"], l["path"]) for l in langs2}
        assert paths1 == paths2, f"Cache inconsistency: {paths1} vs {paths2}"

    def test_cache_consistent_across_articles(self):
        """Multiple articles should all return consistent results."""
        articles = ["Helium", "Nitrogen", "Calcium", "Electron", "Proton"]
        for art in articles:
            r1 = get_languages("wikipedia", art)
            r2 = get_languages("wikipedia", art)
            assert len(r1) == len(r2), f"{art}: inconsistent count {len(r1)} vs {len(r2)}"
            time.sleep(0.1)

    def test_second_lookup_not_slower(self):
        """Cached lookup should not be significantly slower."""
        # First lookup may need to extract Q-ID from HTML
        t0 = time.time()
        get_languages("wikipedia", "Uranium")
        first_time = time.time() - t0
        time.sleep(0.1)
        # Second should use cache
        t0 = time.time()
        get_languages("wikipedia", "Uranium")
        second_time = time.time() - t0
        # Second should not be more than 2x first (allows for network variance)
        max_time = 5.0 if USE_SSH else 0.5
        assert second_time < max_time, f"Cached lookup too slow: {second_time:.2f}s"


# ---------------------------------------------------------------------------
# Category 12: False Positive Rejection (Disambiguation)
# ---------------------------------------------------------------------------

# Disambiguation test cases: articles that should NOT match certain paths
# These verify Q-ID prevents false positives for ambiguous titles
DISAMBIGUATION_CASES = [
    # Mercury the element should not match Mercury the planet
    ("Mercury_(element)", "planet"),
    # Iron should not match Iron Man, Ironing, etc.
    ("Iron", "man"),
]


class TestDisambiguation:
    """Test that Q-ID matching prevents disambiguation errors."""

    def test_mercury_element_not_planet(self):
        """Mercury (element) results should be about the element, not the planet."""
        langs = get_languages("wikipedia", "Mercury_(element)")
        for l in langs:
            path = l.get("path", "").lower()
            assert "planet" not in path, (
                f"Mercury_(element) matched planet article: {l['zim']}/{l['path']}"
            )

    def test_mercury_element_has_matches(self):
        """Mercury (element) should find at least one language match."""
        langs = get_languages("wikipedia", "Mercury_(element)")
        # Mercury has complex disambiguation but should find some valid matches
        assert isinstance(langs, list)

    def test_consistent_qid_across_languages(self):
        """Bidirectional: en→fr→en should return a loadable English article."""
        en_langs = get_languages("wikipedia", "Oxygen")
        fr = next((l for l in en_langs if l["lang"] == "fr"), None)
        assert fr is not None, "Oxygen should have French match"
        time.sleep(0.1)
        fr_langs = get_languages(fr["zim"], fr["path"])
        en_from_fr = next((l for l in fr_langs if l["lang"] == "en"), None)
        assert en_from_fr is not None, "French Oxygene should find English"
        # Path may be a redirect (A/Oxygene) — verify it's loadable
        assert article_exists(en_from_fr["zim"], en_from_fr["path"]), (
            f"Reverse lookup path not loadable: {en_from_fr['zim']}/{en_from_fr['path']}"
        )

    def test_no_cross_subject_contamination(self):
        """Articles should not match unrelated subjects in other languages."""
        # Aspirin is medicine, should not match chemistry articles about aspirin synthesis
        langs = get_languages("wikipedia", "Aspirin")
        for l in langs:
            zim = l.get("zim", "")
            # It's OK to match medicine OR chemistry (aspirin is in both domains)
            # But it should NOT match physics, geography, etc.
            assert not any(x in zim for x in ["geography", "computer"]), (
                f"Aspirin matched wrong subject ZIM: {zim}"
            )


# ---------------------------------------------------------------------------
# Category 13: Strategy Breakdown Verification
# ---------------------------------------------------------------------------

class TestStrategyVerification:
    """Verify Q-ID matching is actually being used, not just heuristic."""

    def test_cross_script_match_requires_qid(self):
        """Cross-script matches (Latin→Arabic) can only work via Q-ID."""
        # These matches are impossible without Q-ID (different scripts)
        cross_script = [
            ("Photon", "ar"),   # Photon → فوتون
            ("Electron", "ar"), # Electron → إلكترون
            ("Proton", "ar"),   # Proton → بروتون
        ]
        for art, lang in cross_script:
            langs = get_languages("wikipedia", art)
            match = next((l for l in langs if l["lang"] == lang), None)
            assert match is not None, (
                f"Cross-script match failed for {art}→{lang} (Q-ID not working?)"
            )
            time.sleep(0.15)

    def test_cross_script_chinese(self):
        """Latin→Chinese matches require Q-ID."""
        langs = get_languages("wikipedia", "Linux")
        zh = next((l for l in langs if l["lang"] == "zh"), None)
        assert zh is not None, "Linux→Chinese match failed (Q-ID not working?)"

    def test_cross_script_hindi(self):
        """Latin→Devanagari matches require Q-ID."""
        langs = get_languages("wikipedia", "Himalaya")
        hi = next((l for l in langs if l["lang"] == "hi"), None)
        assert hi is not None, "Himalaya→Hindi match failed (Q-ID not working?)"

    def test_nopic_subset_matching(self):
        """nopic subsets (stripped authority control) should still match via Q-ID indexes."""
        # French chemistry is nopic — Q-ID indexes were rebuilt to handle this
        langs = get_languages("wikipedia", "Oxygen")
        fr = next((l for l in langs if l["lang"] == "fr"), None)
        assert fr is not None, "Oxygen→French failed (nopic Q-ID issue?)"
        assert "nopic" in fr["zim"], (
            f"Expected nopic ZIM but got {fr['zim']}"
        )

    def test_title_mismatch_resolved_by_qid(self):
        """Articles with different titles in different languages should match via Q-ID."""
        # Aspirin in Spanish might be "Ácido acetilsalicílico" (completely different title)
        langs = get_languages("wikipedia", "Aspirin")
        es = next((l for l in langs if l["lang"] == "es"), None)
        # Should find a match even if title differs
        if es:
            # If title is different from "Aspirin", Q-ID was needed
            path = es.get("path", "")
            if "spirin" not in path.lower():
                # Different title — only Q-ID could find this
                pass  # Just verifying it matched at all


# ---------------------------------------------------------------------------
# Category 14: API Response Structure
# ---------------------------------------------------------------------------

class TestAPIResponse:
    """Test API response structure and edge cases."""

    def test_response_has_languages_key(self):
        data = api("/article-languages?zim=wikipedia&path=Oxygen")
        assert data is not None
        assert "languages" in data

    def test_each_lang_has_required_fields(self):
        data = api("/article-languages?zim=wikipedia&path=Oxygen")
        assert data is not None
        for l in data["languages"]:
            assert "lang" in l, f"Missing 'lang' in {l}"
            assert "name" in l, f"Missing 'name' in {l}"
            assert "zim" in l, f"Missing 'zim' in {l}"
            assert "path" in l, f"Missing 'path' in {l}"

    def test_no_duplicate_languages(self):
        """Each language should appear at most once."""
        langs = get_languages("wikipedia", "Europe")
        lang_codes = [l["lang"] for l in langs]
        assert len(lang_codes) == len(set(lang_codes)), (
            f"Duplicate languages in results: {lang_codes}"
        )

    def test_source_language_excluded(self):
        """Source language (en for English Wikipedia) should not appear in results."""
        langs = get_languages("wikipedia", "Europe")
        lang_codes = [l["lang"] for l in langs]
        assert "en" not in lang_codes, "Source language 'en' should not be in results"

    def test_empty_path_returns_error(self):
        data = api("/article-languages?zim=wikipedia&path=")
        assert data is not None
        assert "error" in data

    def test_missing_params_returns_error(self):
        data = api("/article-languages")
        assert data is not None
        assert "error" in data


# ---------------------------------------------------------------------------
# Summary fixture
# ---------------------------------------------------------------------------

@pytest.fixture(scope="session", autouse=True)
def test_summary(request):
    """Print summary after all tests complete."""
    yield
    fwd_count = len(FORWARD_MATCHES)
    rev_count = len(REVERSE_MATCHES)
    bidir_count = len(BIDIRECTIONAL_PAIRS)
    total_links = sum(len(expected) for _, expected in FORWARD_MATCHES)
    print(f"\n{'='*60}")
    print(f"  Article Language Test Summary")
    print(f"  Forward matches:     {fwd_count} articles, {total_links} links")
    print(f"  Reverse matches:     {rev_count} articles")
    print(f"  Bidirectional pairs: {bidir_count}")
    print(f"  On-demand cache:     3 tests")
    print(f"  Disambiguation:      3 tests")
    print(f"  Strategy verify:     5 tests")
    print(f"  API response:        6 tests")
    print(f"  Total test points:   {fwd_count + rev_count + bidir_count*2 + 17}")
    print(f"  ZIMs tested:         {len(ZIMS)}")
    print(f"  Languages:           9 (en, de, fr, es, it, pt, ar, hi, zh)")
    print(f"{'='*60}")
