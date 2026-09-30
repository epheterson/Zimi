"""Two ZIMs of different languages never collapse into one name.

Short names come from the file name, and Kiwix names leave English out, so
gutenberg_en_all_2026-01.zim is 'gutenberg'. _zim_base_name also drops a
language code its table lacks (Aleut, 'ale', has no two-letter code), so
gutenberg_ale_all_2025-09.zim was 'gutenberg' too, and the collision rule,
built for maxi-over-mini, hid the Aleut library entirely. The NAS hid its
Fiji Hindi Wiktionary the same way.

Short names key saved items, bookmarks, history and the Q-ID caches, so the
fix renames nothing already visible: the build that held the name keeps it
and each other language is served under its language name. Same-language
flavors still collapse to the richer build.
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import zimi.server as server  # noqa: E402

EN = "gutenberg_en_all_2026-01.zim"
ALE = "gutenberg_ale_all_2025-09.zim"


def _touch(root, rel):
    path = os.path.join(root, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    open(path, "wb").close()
    return path


@pytest.fixture
def scan_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "ZIM_DIR", str(tmp_path))
    return str(tmp_path)


def _scan(root, *files):
    for rel in files:
        _touch(root, rel)
    return {n: os.path.relpath(p, root).replace(os.sep, "/") for n, p in server._scan_zim_files().items()}


# ---------------------------------------------------------------------------
# The scan
# ---------------------------------------------------------------------------


def test_aleut_beside_english_is_served_under_its_language(scan_dir):
    assert _scan(scan_dir, EN, ALE) == {"gutenberg": EN, "gutenberg_ale": ALE}


def test_a_newer_foreign_build_does_not_take_the_english_name(scan_dir):
    """With dates deciding, the next Aleut edition would move 'gutenberg'
    from the English library to the Aleut one, and every bookmark with it."""
    newer_ale = "gutenberg_ale_all_2026-09.zim"
    assert _scan(scan_dir, EN, newer_ale) == {
        "gutenberg": EN,
        "gutenberg_ale": newer_ale,
    }


def test_a_richer_foreign_flavor_keeps_the_name_it_holds_today(scan_dir):
    """Flavor still decides first, as it did: the Gwere maxi keeps
    'wiktionary', and the English nopic, hidden before, appears."""
    guw, en = (
        "wiktionary_guw_all_maxi_2026-08.zim",
        "wiktionary_en_all_nopic_2026-07.zim",
    )
    assert _scan(scan_dir, guw, en) == {"wiktionary": guw, "wiktionary_en": en}


def test_two_flavors_of_one_language_still_collapse_to_the_richer(scan_dir):
    names = _scan(
        scan_dir,
        "wikipedia_he_all_mini_2026-07.zim",
        "wikipedia_he_all_nopic_2026-07.zim",
        "wikipedia_en_all_maxi_2026-08.zim",
        "wikipedia_en_all_mini_2026-03.zim",
    )
    assert names == {
        "wikipedia": "wikipedia_en_all_maxi_2026-08.zim",
        "wikipedia_he": "wikipedia_he_all_nopic_2026-07.zim",
    }


def test_two_flavors_of_the_other_language_collapse_under_its_name(scan_dir):
    names = _scan(
        scan_dir,
        EN,
        "gutenberg_ale_all_mini_2026-06.zim",
        "gutenberg_ale_all_nopic_2025-01.zim",
    )
    assert names == {
        "gutenberg": EN,
        "gutenberg_ale": "gutenberg_ale_all_nopic_2025-01.zim",
    }


def test_a_language_name_a_file_already_has_is_never_taken(scan_dir):
    """wikipedia_ceb_top_mini is 'wikipedia_ceb' on its own; the Cebuano
    full build losing 'wikipedia' must not displace it."""
    top = "wikipedia_ceb_top_mini_2026-07.zim"
    names = _scan(
        scan_dir,
        top,
        "wikipedia_ceb_all_nopic_2026-05.zim",
        "wikipedia_en_all_maxi_2026-08.zim",
    )
    assert names == {
        "wikipedia": "wikipedia_en_all_maxi_2026-08.zim",
        "wikipedia_ceb": top,
    }


def test_a_subfolder_build_of_another_language_is_not_a_backup(scan_dir):
    """Root beats subfolder for copies of one thing; another language in a
    subfolder is a different library and is served."""
    sub_ale = "more/" + ALE  # the scan reports "/" on every OS
    assert _scan(scan_dir, EN, sub_ale) == {"gutenberg": EN, "gutenberg_ale": sub_ale}


def test_a_subfolder_copy_in_the_same_language_stays_shadowed(scan_dir):
    assert _scan(scan_dir, EN, os.path.join("old", EN)) == {"gutenberg": EN}


def test_every_collision_is_logged_with_its_outcome(scan_dir, caplog):
    caplog.set_level("INFO", logger=server.log.name)
    _scan(scan_dir, EN, ALE, "gutenberg_en_all_2025-01.zim")
    lines = [r.getMessage() for r in caplog.records if "collision" in r.getMessage()]
    assert sorted(lines) == [
        f"ZIM name collision 'gutenberg': keeping {EN}, ignoring gutenberg_en_all_2025-01.zim",
        f"ZIM name collision 'gutenberg': keeping {EN}, serving {ALE} as 'gutenberg_ale'",
    ]


def test_language_key_reads_the_language_position():
    key = server._zim_lang_key
    assert key(ALE) == "ale"
    assert key(EN) == "en"
    assert key("wikipedia_eng_all_maxi_2026-01.zim") == "en"
    assert key("wikipedia_fra_all_maxi_2026-01.zim") == "fr"
    # A subset or topic after the language is not a language.
    assert key("wikipedia_bg_top_maxi_2026-07.zim") == "bg"
    assert key("devdocs_en_css_2026-01.zim") == "en"
    assert key("stackoverflow.com_en_all_2026-07.zim") == "en"
    # No language segment: English, as the base name treats it.
    assert key("reddit_kiwix.zim") == "en"
    assert key("osm-hawaii-2026-09-08.zim") == "en"


# ---------------------------------------------------------------------------
# Today's names, from Eric's NAS (2026-09-28): root plus created/.
# ---------------------------------------------------------------------------

NAS_NAMES = {
    "100r-off-the-grid": "100r-off-the-grid_en_2022-06.zim",
    "100r.co": "100r.co_en_all_2026-08.zim",
    "Linux_Experiment_video_check": "created/Linux_Experiment_video_check.zim",
    "YouTube_check": "YouTube_check.zim",
    "apod.nasa.gov": "apod.nasa.gov_en_all_2026-08.zim",
    "appropedia": "appropedia_en_all_maxi_2026-02.zim",
    "armypubs": "armypubs_en_all_2024-12.zim",
    "artofproblemsolving": "artofproblemsolving_en_all_maxi_2021-03.zim",
    "cooking.stackexchange": "cooking.stackexchange.com_en_all_2026-07.zim",
    "devdocs_en_bash": "devdocs_en_bash_2026-04.zim",
    "devdocs_en_docker": "devdocs_en_docker_2026-07.zim",
    "devdocs_en_git": "devdocs_en_git_2026-07.zim",
    "devdocs_en_html": "devdocs_en_html_2026-07.zim",
    "devdocs_en_javascript": "devdocs_en_javascript_2026-07.zim",
    "devdocs_en_nginx": "devdocs_en_nginx_2026-04.zim",
    "devdocs_en_node": "devdocs_en_node_2026-08.zim",
    "devdocs_en_postgresql": "devdocs_en_postgresql_2026-08.zim",
    "devdocs_en_python": "devdocs_en_python_2026-08.zim",
    "devdocs_en_react": "devdocs_en_react_2026-05.zim",
    "diy.stackexchange": "diy.stackexchange.com_en_all_2026-08.zim",
    "draculatheme_com": "created/draculatheme_com.zim",
    "draculatheme_com-2": "created/draculatheme_com-2.zim",
    "electronics.stackexchange": "electronics.stackexchange.com_en_all_2026-08.zim",
    "ersatztv": "ersatztv_2026-04.zim",
    "explainxkcd": "explainxkcd_en_all_maxi_2026-07.zim",
    "gardening.stackexchange": "gardening.stackexchange.com_en_all_2026-08.zim",
    "gutenberg": "gutenberg_en_all_2025-11.zim",
    "ifixit": "ifixit_en_all_2025-12.zim",
    "judaism.stackexchange": "judaism.stackexchange.com_en_all_2026-08.zim",
    "maps": "maps_en_all_2026-06.zim",
    "medicalsciences.stackexchange": "medicalsciences.stackexchange.com_en_all_2026-02.zim",
    "openstreetmap-wiki": "openstreetmap-wiki_en_all_maxi_2026-07.zim",
    "phet": "phet_en_2023-01.zim",
    "phzh_core-english-one": "phzh_core-english-one_en_2022-01.zim",
    "project-fuel": "project-fuel_en_2025-09.zim",
    "rationalwiki": "rationalwiki_en_all_maxi_2025-05.zim",
    "reddit_kiwix": "created/reddit_kiwix.zim",
    "serverfault": "serverfault.com_en_all_2026-02.zim",
    "stackoverflow": "stackoverflow.com_en_all_2026-07.zim",
    "streetzim_hawaii": "streetzim_hawaii.zim",
    "superuser": "superuser.com_en_all_2026-08.zim",
    "ted_en_playlist-the-most-popular-talks-of-2020": "ted_en_playlist-the-most-popular-talks-of-2020_2021-12.zim",
    "ted_en_technology": "ted_en_technology_2023-09.zim",
    "theworldfactbook": "theworldfactbook_en_all_2026-02.zim",
    "unix.stackexchange": "unix.stackexchange.com_en_all_2026-08.zim",
    "wikem": "wikem_en_all_maxi_2026-07.zim",
    "wikibooks": "wikibooks_en_all_maxi_2026-04.zim",
    "wikihow": "wikihow_en_maxi_2023-03.zim",
    "wikinews_bs": "wikinews_bs_all_nopic_2026-04.zim",
    "wikipedia": "wikipedia_en_all_maxi_2026-08.zim",
    "wikipedia_ar": "wikipedia_ar_all_mini_2026-08.zim",
    "wikipedia_de": "wikipedia_de_all_nopic_2026-01.zim",
    "wikipedia_es": "wikipedia_es_all_mini_2026-08.zim",
    "wikipedia_fr": "wikipedia_fr_all_nopic_2026-05.zim",
    "wikipedia_he": "wikipedia_he_all_nopic_2026-07.zim",
    "wikipedia_hi": "wikipedia_hi_all_mini_2026-07.zim",
    "wikipedia_pt": "wikipedia_pt_all_mini_2026-05.zim",
    "wikipedia_ru": "wikipedia_ru_all_mini_2026-07.zim",
    "wikipedia_zh": "wikipedia_zh_all_mini_2026-07b.zim",
    "wikiquote": "wikiquote_en_all_maxi_2026-07.zim",
    "wikiversity": "wikiversity_en_all_maxi_2026-05.zim",
    "wikivoyage": "wikivoyage_en_all_maxi_2026-09.zim",
    "wiktionary": "wiktionary_en_all_maxi_2024-05.zim",
    "wiktionary_bs": "wiktionary_bs_all_nopic_2026-04.zim",
    "wiktionary_en_simple": "wiktionary_en_simple_all_nopic_2026-04.zim",
    "wiktionary_mt": "wiktionary_mt_all_nopic_2026-07.zim",
    "wiktionary_tn": "wiktionary_tn_all_nopic_2026-07.zim",
    "www.ready.gov": "www.ready.gov_en_2024-12.zim",
    "www_apple_com": "created/www_apple_com.zim",
    "www_apple_com_site": "created/www_apple_com_site.zim",
    "www_cnn_com": "created/www_cnn_com.zim",
    "www_cnn_com-3": "created/www_cnn_com-3.zim",
    "xkcd": "xkcd.com_en_all_2026-08.zim",
    "zimgit-food-preparation": "zimgit-food-preparation_en_2025-04.zim",
    "zimgit-knots": "zimgit-knots_en_2024-08.zim",
    "zimgit-medicine": "zimgit-medicine_en_2024-08.zim",
    "zimgit-post-disaster": "zimgit-post-disaster_en_2024-05.zim",
    "zimgit-water": "zimgit-water_en_2024-08.zim",
}

# On the NAS but hidden before: each shadowed by a build it is not a lesser
# copy of. The Fiji Hindi Wiktionary was 'wiktionary', behind the English.
NAS_SHADOWED = [
    "artofproblemsolving_en_all_nopic_2021-03.zim",
    "openstreetmap-wiki_en_all_nopic_2026-04.zim",
    "wikem_en_all_nopic_2026-04.zim",
    "wikipedia_en_all_mini_2026-03.zim",
    "wikipedia_he_all_mini_2026-07.zim",
    "wikipedia_zh_all_mini_2026-05.zim",
    "wikiversity_en_all_nopic_2026-02.zim",
    "wiktionary_en_all_nopic_2026-02.zim",
    "created/YouTube_check.zim",
]
NAS_HIF = "wiktionary_hif_all_nopic_2026-04.zim"


def test_every_name_on_the_nas_is_unchanged(scan_dir):
    names = _scan(scan_dir, *NAS_NAMES.values(), *NAS_SHADOWED, NAS_HIF)
    assert {n: f for n, f in names.items() if n in NAS_NAMES} == NAS_NAMES
    # The one addition: the language that was hidden.
    assert set(names) - set(NAS_NAMES) == {"wiktionary_hif"}
    assert names["wiktionary_hif"] == NAS_HIF


# ---------------------------------------------------------------------------
# The served name, for code that only has a file name
# ---------------------------------------------------------------------------


def test_short_name_of_a_file_is_the_name_it_is_served_under(scan_dir, monkeypatch):
    _touch(scan_dir, EN)
    _touch(scan_dir, ALE)
    monkeypatch.setattr(server, "_zim_files_cache", server._scan_zim_files())
    # Deleting or updating the Aleut file must release ITS handles, not the
    # English library's.
    assert server._zim_short_name(ALE) == "gutenberg_ale"
    assert server._zim_short_name(os.path.join(scan_dir, ALE)) == "gutenberg_ale"
    assert server._zim_short_name(EN) == "gutenberg"
    # Anything not installed gets the name derived from its file.
    assert server._zim_short_name("gutenberg_ale_all_2027-01.zim") == "gutenberg"
    assert server._zim_short_name("wikipedia_fr_all_maxi_2026-02.zim") == "wikipedia_fr"


# ---------------------------------------------------------------------------
# Registration (a download landing) agrees with the scan
# ---------------------------------------------------------------------------


def _library(tmp_path, monkeypatch, *files):
    from conftest_zim import build_fixture_zim

    pytest.importorskip("libzim.writer")
    zdir = tmp_path / "zims"
    zdir.mkdir()
    for f in files:
        build_fixture_zim(str(zdir / f))
    monkeypatch.setattr(server, "ZIM_DIR", str(zdir))
    monkeypatch.setattr(server, "ZIMI_DATA_DIR", str(tmp_path / "data"))
    os.makedirs(str(tmp_path / "data"), exist_ok=True)
    monkeypatch.setattr(server, "_zim_files_cache", None)
    monkeypatch.setattr(server, "_zim_list_cache", None)
    server.load_cache(force=True)
    return zdir


def _served():
    return {z["name"]: z["file"] for z in server._zim_list_cache}


def test_registering_another_language_serves_it_beside_the_holder(
    tmp_path, monkeypatch
):
    from conftest_zim import build_fixture_zim

    zdir = _library(tmp_path, monkeypatch, EN)
    build_fixture_zim(str(zdir / ALE))
    assert server.register_zim_file(str(zdir / ALE)) is True
    assert _served() == {"gutenberg": EN, "gutenberg_ale": ALE}
    # What the next restart would say.
    server.load_cache(force=True)
    assert _served() == {"gutenberg": EN, "gutenberg_ale": ALE}


def test_an_update_of_the_other_language_keeps_its_language_name(tmp_path, monkeypatch):
    from conftest_zim import build_fixture_zim

    zdir = _library(tmp_path, monkeypatch, EN, ALE)
    newer = "gutenberg_ale_all_2026-09.zim"
    build_fixture_zim(str(zdir / newer))
    server.release_zim_handles([server._zim_short_name(ALE)])
    os.remove(str(zdir / ALE))
    assert server.register_zim_file(str(zdir / newer), removed_files=[ALE]) is True
    assert _served() == {"gutenberg": EN, "gutenberg_ale": newer}


def test_english_arriving_where_another_language_holds_the_name_rescans(
    tmp_path, monkeypatch
):
    """The holder would move to its language name, which only a rescan does:
    register answers False and the caller's full rescan settles it."""
    from conftest_zim import build_fixture_zim

    zdir = _library(tmp_path, monkeypatch, ALE)
    assert _served() == {"gutenberg": ALE}
    build_fixture_zim(str(zdir / EN))
    assert server.register_zim_file(str(zdir / EN)) is False
    server.load_cache(force=True)
    assert _served() == {"gutenberg": EN, "gutenberg_ale": ALE}


def test_a_poorer_flavor_of_the_same_language_still_stays_shadowed(
    tmp_path, monkeypatch
):
    from conftest_zim import build_fixture_zim

    zdir = _library(tmp_path, monkeypatch, "wikipedia_he_all_nopic_2026-07.zim")
    mini = "wikipedia_he_all_mini_2026-09.zim"
    build_fixture_zim(str(zdir / mini))
    assert server.register_zim_file(str(zdir / mini)) is True
    assert _served() == {"wikipedia_he": "wikipedia_he_all_nopic_2026-07.zim"}


def test_deleting_the_other_language_leaves_the_holder(tmp_path, monkeypatch):
    zdir = _library(tmp_path, monkeypatch, EN, ALE)
    server.release_zim_handles([server._zim_short_name(ALE)])
    os.remove(str(zdir / ALE))
    assert server.unregister_zim_file(ALE) is True
    assert _served() == {"gutenberg": EN}
