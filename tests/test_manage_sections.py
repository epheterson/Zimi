"""The Manage view's two new server reads: the Creator section and the ZIM
auto-updater's real state.

Both exist because the facts were already true and simply unreachable. The
creation capabilities lived only inside the create page's own poll, so an admin
had to open the create form and infer them from which options were greyed; the
auto-updater reported a different subset of itself from each of two endpoints
and never reported when it would next run, nor which of the installed ZIMs it
is able to maintain at all.

The last of those is the one worth stating plainly, because it is a limitation
rather than a feature: matching an installed file to a newer edition needs a
dated filename, so an undated ZIM — which is most of what `zimi create` writes
— is invisible to the updater. There is no per-ZIM opt-out setting in Zimi;
this is the reach the mechanism actually has, and the point of surfacing it is
that a file which never updates should say why.
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi.http as zhttp  # noqa: E402
import zimi.manage as manage  # noqa: E402
import zimi.server as server  # noqa: E402
from tests.test_create_routes import _get, _post  # noqa: E402


@pytest.fixture(autouse=True)
def own_data_dir(tmp_path, monkeypatch):
    """The stored capture defaults live in ZIMI_DATA_DIR; every test here gets
    its own empty one so no test reads a real server's file or another test's
    leftovers."""
    monkeypatch.setattr(server, "ZIMI_DATA_DIR", str(tmp_path / "data"))
    (tmp_path / "data").mkdir()


# ── the creator section ─────────────────────────────────────────────────────


def test_creator_payload_answers_every_question_the_section_asks(monkeypatch):
    """One read, and the section can draw itself. A missing key here is a row
    that renders as "loading" forever."""
    monkeypatch.setattr(manage, "_create_browser_ready", lambda: True)
    monkeypatch.setattr(manage, "_create_alive_ready", lambda: False)
    monkeypatch.setattr(manage, "_create_root", lambda: "/srv/zims")

    body = _get("/manage/creator").body
    assert set(body) == {
        "browser_ready",
        "alive_ready",
        "sidecar",
        "create_root",
        "block_ads_default",
        "capture_variants_default",
        "queue",
        "offline",
        "created_counts",
        "created_list",
    }
    assert body["browser_ready"] is True
    assert body["alive_ready"] is False
    assert body["create_root"] == "/srv/zims"
    assert set(body["sidecar"]) == {"installed", "version"}
    # Every type is present in the breakdown even when the library is empty, so
    # the client never has to guess a missing bucket is zero.
    assert set(body["created_counts"]) == set(manage._CREATOR_TYPES)
    assert isinstance(body["created_list"], list)


def test_an_unconfigured_create_root_is_null_not_empty(monkeypatch):
    """The same shape the create page's probe uses. "" and None would be two
    spellings of "unset" for two readers to disagree about."""
    monkeypatch.setattr(manage, "_create_root", lambda: "")
    assert _get("/manage/creator").body["create_root"] is None


# ── the creator inventory: what Zimi has made, by type ───────────────────────
#
# The breakdown and the sortable table both come from _creator_inventory, which
# reads two seams: the library list and the per-file provenance memo. These
# patch both so the aggregation is tested on a known library without writing
# real archives — that a kind is derived correctly from real metadata is
# test_zim_info_endpoint.py's job, not this one's.


@pytest.fixture
def made_library(monkeypatch):
    """A library with one ZIM of each capture type Zimi stamps, plus one it did
    not make. ``a-channel`` carries no timestamp, standing in for a ZIM created
    before the stamp existed."""
    entries = [
        {
            "name": "one-page",
            "title": "One Page",
            "file": "one-page.zim",
            "size_bytes": 100,
        },
        {
            "name": "many-pages",
            "title": "Many Pages",
            "file": "many-pages.zim",
            "size_bytes": 250,
        },
        {"name": "a-site", "title": "A Site", "file": "a-site.zim", "size_bytes": 4000},
        {
            "name": "a-channel",
            "title": "A Channel",
            "file": "a-channel.zim",
            "size_bytes": 900000,
        },
        {
            "name": "an-archive",
            "title": "An Archive",
            "file": "an-archive.zim",
            "size_bytes": 7000,
        },
        {
            "name": "my-bookmarks",
            "title": "My Bookmarks",
            "file": "my-bookmarks.zim",
            "size_bytes": 500,
        },
        {
            "name": "downloaded",
            "title": "Somebody Else's",
            "file": "downloaded.zim",
            "size_bytes": 999,
        },
    ]
    kinds = {
        "one-page": {"mode": "page", "ts": 111},
        "many-pages": {"mode": "pages", "ts": 222},
        "a-site": {"mode": "site", "ts": 333},
        "a-channel": {"mode": "video"},
        "an-archive": {"mode": "import", "ts": 555},
        "my-bookmarks": {"mode": "bookmarks", "ts": 666},
        "downloaded": None,
    }
    monkeypatch.setattr(server, "list_zims", lambda *a, **k: list(entries))
    monkeypatch.setattr(zhttp, "_zim_kind_for", lambda e: kinds.get(e["name"]))
    # Keep the two subprocess-backed readiness probes off the unit path.
    monkeypatch.setattr(manage, "_create_browser_ready", lambda: True)
    monkeypatch.setattr(manage, "_create_alive_ready", lambda: True)
    return entries, kinds


def test_creator_counts_break_down_made_here_zims_by_type(made_library):
    """One count per type, folding the modes that share a bucket: the single-
    and multi-page engines both read as "page", a bookmark export as "export".
    The ZIM Zimi did not make is in none of them."""
    counts = _get("/manage/creator").body["created_counts"]
    assert counts == {
        "page": 2,
        "site": 1,
        "video": 1,
        "import": 1,
        "folder": 0,
        "export": 1,
        "edit": 0,
    }


def test_creator_list_carries_the_sortable_fields(made_library):
    rows = _get("/manage/creator").body["created_list"]
    # Every ZIM Zimi made appears once; the downloaded one does not.
    assert {r["name"] for r in rows} == {
        "one-page",
        "many-pages",
        "a-site",
        "a-channel",
        "an-archive",
        "my-bookmarks",
    }
    for r in rows:
        assert set(r) == {
            "name",
            "title",
            "type",
            "size_bytes",
            "created_ts",
            "path_basename",
        }
    by_name = {r["name"]: r for r in rows}
    assert by_name["many-pages"]["type"] == "page"
    assert by_name["my-bookmarks"]["type"] == "export"
    assert by_name["a-site"]["size_bytes"] == 4000
    assert by_name["a-site"]["title"] == "A Site"
    assert by_name["a-site"]["path_basename"] == "a-site.zim"
    assert by_name["one-page"]["created_ts"] == 111
    # A ZIM whose provenance carries no timestamp still lists, with None — the
    # client sorts the dated ones and leaves the rest where they fall.
    assert by_name["a-channel"]["created_ts"] is None


def test_creator_inventory_is_empty_when_nothing_was_made(monkeypatch):
    monkeypatch.setattr(server, "list_zims", lambda *a, **k: [])
    body = _get("/manage/creator").body
    assert body["created_list"] == []
    assert body["created_counts"] == {t: 0 for t in manage._CREATOR_TYPES}


def test_the_defaults_it_reports_are_the_ones_the_engines_use(monkeypatch):
    """The section states what a capture refuses and sweeps by default. If it
    drifted from the constant the validator applies, it would be describing a
    server other than this one."""
    monkeypatch.setattr(manage, "_create_browser_ready", lambda: False)
    monkeypatch.setattr(manage, "_create_alive_ready", lambda: False)
    body = _get("/manage/creator").body
    assert body["block_ads_default"] is manage.CREATE_BLOCK_ADS
    assert body["capture_variants_default"] is manage.CREATE_CAPTURE_VARIANTS


def test_a_stored_default_wins_over_the_factory_constant(monkeypatch):
    """The Manage toggles persist the instance's capture defaults. Once one is
    stored, GET reports the stored answer, not the constant."""
    monkeypatch.setattr(manage, "_create_browser_ready", lambda: False)
    monkeypatch.setattr(manage, "_create_alive_ready", lambda: False)
    h = _post("/manage/creator", {"block_ads": False})
    assert h.status == 200
    assert h.body == {
        "block_ads_default": False,
        "capture_variants_default": manage.CREATE_CAPTURE_VARIANTS,
    }
    body = _get("/manage/creator").body
    assert body["block_ads_default"] is False
    assert body["capture_variants_default"] is manage.CREATE_CAPTURE_VARIANTS


def test_setting_one_default_never_drops_the_other(monkeypatch):
    _post("/manage/creator", {"block_ads": False})
    _post("/manage/creator", {"capture_variants": False})
    body = _get("/manage/creator").body
    assert body["block_ads_default"] is False
    assert body["capture_variants_default"] is False


def test_the_stored_default_survives_the_write_path_it_rides(tmp_path):
    """Atomic file in the data dir, same discipline as every other manage-set
    preference — and a fresh read of the file agrees with the endpoint."""
    _post("/manage/creator", {"block_ads": False, "capture_variants": True})
    path = manage._create_defaults_path()
    assert os.path.dirname(path) == server.ZIMI_DATA_DIR
    import json

    with open(path, encoding="utf-8") as f:
        assert json.load(f) == {"block_ads": False, "capture_variants": True}


def test_a_non_boolean_default_is_refused_not_coerced():
    assert _post("/manage/creator", {"block_ads": "yes"}).status == 400
    assert _post("/manage/creator", {"capture_variants": 1}).status == 400
    # Nothing was stored by either refusal.
    assert not os.path.exists(manage._create_defaults_path())


def test_an_empty_defaults_write_is_a_400_not_a_silent_ok():
    assert _post("/manage/creator", {}).status == 400
    assert _post("/manage/creator", {"unrelated": True}).status == 400


def test_a_job_that_omits_the_field_gets_the_stored_default(monkeypatch):
    """_create_validate applies the stored default exactly where the factory
    constant used to sit: a request that says nothing about block_ads runs
    with the instance's answer, and one that speaks keeps its own word."""
    # The alive engine is the one that reads BOTH defaults; make the validator
    # believe it is installed so the request survives to the option step.
    monkeypatch.setattr(manage, "_create_browser_ready", lambda: True)
    monkeypatch.setattr(manage, "_create_alive_ready", lambda: True)
    manage._write_create_defaults(block_ads=False, capture_variants=False)
    _, _, _, opts = manage._create_validate(
        {"mode": "page", "source": "https://example.com/a", "engine": "alive"}
    )
    assert opts["block_ads"] is False
    assert opts["capture_variants"] is False
    # An explicit True from the client overrides the stored False.
    _, _, _, opts = manage._create_validate(
        {
            "mode": "page",
            "source": "https://example.com/a",
            "engine": "alive",
            "block_ads": True,
            "capture_variants": True,
        }
    )
    assert opts["block_ads"] is True
    assert opts["capture_variants"] is True


def test_a_probe_that_explodes_costs_a_row_not_the_section(monkeypatch):
    """The sidecar probe shells out. A broken install must leave the rest of
    the section readable rather than 500 the whole endpoint."""

    def boom():
        raise OSError("no venv here")

    monkeypatch.setattr(manage, "_create_browser_ready", lambda: True)
    monkeypatch.setattr(manage, "_create_alive_ready", lambda: False)
    monkeypatch.setitem(sys.modules, "zimi.importer", None)
    h = _get("/manage/creator")
    assert h.status == 200
    assert h.body["sidecar"] == {"installed": False, "version": None}
    assert h.body["browser_ready"] is True


# ── the auto-updater ────────────────────────────────────────────────────────


@pytest.fixture
def au(monkeypatch):
    """A running auto-updater with a known last pass."""
    monkeypatch.setattr(server, "_auto_update_enabled", True)
    monkeypatch.setattr(server, "_auto_update_freq", "weekly")
    monkeypatch.setattr(server, "_auto_update_env_locked", False)
    monkeypatch.setattr(server, "_auto_update_last_check", 1_700_000_000.0)
    return server


def test_the_next_run_is_derived_from_the_last_one(au):
    body = _get("/manage/auto-update").body
    assert body["last_check"] == 1_700_000_000.0
    assert body["next_check"] == 1_700_000_000.0 + server._FREQ_SECONDS["weekly"]
    assert body["enabled"] is True
    assert body["frequency"] == "weekly"
    assert body["locked"] is False


def test_a_never_run_updater_promises_no_next_run(au, monkeypatch):
    """`last_check` is process memory, so it is None after every restart. A
    next run computed from nothing would be a time invented out of thin air."""
    monkeypatch.setattr(server, "_auto_update_last_check", None)
    assert _get("/manage/auto-update").body["next_check"] is None


def test_a_disabled_updater_promises_no_next_run(au, monkeypatch):
    monkeypatch.setattr(server, "_auto_update_enabled", False)
    body = _get("/manage/auto-update").body
    assert body["enabled"] is False
    assert body["next_check"] is None
    # The last pass still happened, and saying so is the difference between
    # "off" and "off, and it had never run anyway".
    assert body["last_check"] == 1_700_000_000.0


def test_status_and_stats_report_the_same_auto_update(au):
    """They used to each hand-build a different subset: /manage/status omitted
    `last_check`, /manage/stats omitted `locked`. Which facts a caller got
    depended on which endpoint it happened to poll."""
    from_status = _get("/manage/status").body["auto_update"]
    from_stats = _get("/manage/stats").body["auto_update"]
    assert from_status == from_stats
    assert set(from_status) == {
        "enabled",
        "frequency",
        "locked",
        "last_check",
        "next_check",
    }


# ── which ZIMs it can actually maintain ─────────────────────────────────────


def test_coverage_splits_the_library_by_what_the_updater_can_match(monkeypatch):
    """A dated filename is what makes a ZIM updatable — the updater matches an
    installed file to a newer edition by that suffix. Undated files are not
    opted out; they are unreachable, and the list says which are which."""
    monkeypatch.setattr(
        server,
        "get_zim_files",
        lambda: {
            "wikipedia_en_all": "/z/wikipedia_en_all_maxi_2026-05.zim",
            "field_notes": "/z/field_notes.zim",
            "gutenberg_en": "/z/gutenberg_en_all_2026-01.zim",
        },
    )
    coverage = _get("/manage/auto-update").body["coverage"]
    assert coverage["tracked"] == ["gutenberg_en", "wikipedia_en_all"]
    assert coverage["skipped"] == [{"name": "field_notes", "reason": "undated"}]


def test_an_empty_library_covers_nothing_without_erroring(monkeypatch):
    monkeypatch.setattr(server, "get_zim_files", lambda: {})
    coverage = _get("/manage/auto-update").body["coverage"]
    assert coverage == {"tracked": [], "skipped": []}


def test_the_get_does_not_write_anything(au, monkeypatch):
    """The path is shared with a POST that reconfigures the updater. Reading it
    must not be a way to change it."""
    saved = []
    monkeypatch.setattr(server, "_save_auto_update_config", lambda *a: saved.append(a))
    monkeypatch.setattr(server, "get_zim_files", lambda: {})
    _get("/manage/auto-update")
    assert saved == []
    assert server._auto_update_freq == "weekly"
    assert server._auto_update_enabled is True
