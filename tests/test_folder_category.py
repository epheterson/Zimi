"""A ZIM's folder is its category.

An admin who files ZIMs into medical/, dev-docs/ and field-guides/ under the
ZIM dir has already organized the library; Zimi reads that organization instead
of asking for it to be re-entered in the UI. The contract under test:

- the immediate subfolder (and only that — the scan is one level deep) becomes
  the ZIM's category, prettified for display, with the raw name carried
  alongside it;
- folder beats the filename heuristic, because it is a deliberate act by the
  operator rather than a guess; a hand-set per-ZIM override still beats both;
- a root-level ZIM behaves exactly as it did before this feature existed;
- the category is derived from the path, so it costs no stat, no archive open,
  and no rescan — an existing library re-files on the next boot, and a ZIM
  moved between folders re-files even though a move changes neither mtime nor
  size;
- the disk cache record is unchanged, so an older Zimi reading a cache written
  by this one sees exactly the fields it already knows.

Live boots in this file use port 8895 and nothing else.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import urllib.request

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi.server as server  # noqa: E402

from tests.conftest_zim import build_fixture_zim  # noqa: E402
from tests.test_serve_smoke import REPO_ROOT, _wait_for_ready  # noqa: E402

LIVE_PORT = "8895"  # the only port live boots in this file may bind


@pytest.fixture
def zim_dir(tmp_path, monkeypatch):
    """A ZIM_DIR + data dir wired into the live server globals."""
    zdir = tmp_path / "zims"
    zdir.mkdir()
    data = tmp_path / "data"
    data.mkdir()
    monkeypatch.setattr(server, "ZIM_DIR", str(zdir))
    monkeypatch.setattr(server, "ZIMI_DATA_DIR", str(data))
    server._zim_files_cache = None
    server._zim_list_cache = None
    yield zdir
    server._zim_files_cache = None
    server._zim_list_cache = None


def _entry(name):
    return next(z for z in server._zim_list_cache if z["name"] == name)


# ---------------------------------------------------------------------------
# _zim_folder: which folder a path sits in
# ---------------------------------------------------------------------------


def test_root_file_has_no_folder(zim_dir):
    assert server._zim_folder(str(zim_dir / "wikipedia_en_all.zim")) == ""


def test_subfolder_file_reports_its_folder(zim_dir):
    assert server._zim_folder(str(zim_dir / "medical" / "wikem_en.zim")) == "medical"


def test_deeper_nesting_reports_no_folder(zim_dir):
    """The scan never yields these, and guessing a folder name from a path the
    library does not serve would be worse than declining."""
    assert server._zim_folder(str(zim_dir / "a" / "b" / "deep_en.zim")) == ""


def test_path_outside_the_zim_dir_reports_no_folder(zim_dir):
    assert server._zim_folder("/somewhere/else/medical/wikem_en.zim") == ""


def test_folder_survives_redundant_path_separators(zim_dir):
    """Paths assembled by hand ('dir//sub/./file') must resolve like the clean
    ones the scan produces."""
    messy = os.path.join(str(zim_dir), "", "medical", ".", "wikem_en.zim")
    assert server._zim_folder(messy) == "medical"


# ---------------------------------------------------------------------------
# _folder_category: folder name → display name
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "folder,expected",
    [
        ("medical", "Medical"),
        ("dev-docs", "Dev Docs"),
        ("stack_exchange", "Stack Exchange"),
        ("field guides", "Field Guides"),
        ("survival.manuals", "Survival Manuals"),
        ("DIY", "DIY"),  # already-cased words are left alone, not flattened
        ("McGraw", "McGraw"),
        ("  spaced  out  ", "Spaced Out"),
        ("", ""),
        ("---", ""),  # nothing but separators is not a category
    ],
)
def test_folder_category_display_names(folder, expected):
    assert server._folder_category(folder) == expected


def test_folder_category_is_length_capped():
    """A category rides into the layout file and the UI; cap it where a
    hand-set override is capped rather than letting a pathological folder name
    through."""
    assert len(server._folder_category("x" * 500)) == server._FOLDER_CATEGORY_MAX


# ---------------------------------------------------------------------------
# _effective_category: folder beats the filename heuristic
# ---------------------------------------------------------------------------


def test_root_zim_keeps_the_filename_heuristic(zim_dir):
    path = str(zim_dir / "wikipedia_en_all.zim")
    assert server._effective_category("wikipedia", path) == "Wikimedia"


def test_folder_overrides_the_filename_heuristic(zim_dir):
    """wikipedia_en_medicine would be 'Medical' by heuristic; filed under
    reference/ it is 'Reference', because the operator said so."""
    path = str(zim_dir / "reference" / "wikipedia_en_medicine.zim")
    assert server._effective_category("wikipedia_en_medicine", path) == "Reference"


def test_folder_categorizes_a_zim_the_heuristic_cannot(zim_dir):
    path = str(zim_dir / "field-guides" / "mushrooms_en.zim")
    assert server._categorize_zim("mushrooms_en") is None
    assert server._effective_category("mushrooms_en", path) == "Field Guides"


# ---------------------------------------------------------------------------
# The full metadata flow: scan → list entry → disk cache → next boot
# ---------------------------------------------------------------------------


def test_listing_carries_folder_category_and_raw_name(zim_dir):
    os.makedirs(str(zim_dir / "field-guides"))
    build_fixture_zim(str(zim_dir / "field-guides" / "mushrooms_en_2026-01.zim"))
    build_fixture_zim(str(zim_dir / "wikipedia_en_all_2026-01.zim"))
    server.load_cache(force=True)

    sub = _entry("mushrooms")
    assert sub["category"] == "Field Guides"
    assert sub["folder"] == "field-guides"

    root = _entry("wikipedia")
    assert root["category"] == "Wikimedia"
    assert "folder" not in root  # root files are untouched by this feature


def test_cached_boot_keeps_the_folder_category_without_reopening_archives(zim_dir):
    """The Pi contract: a second boot re-files from the cache alone. Opening an
    archive here is a hard failure, not a slow path."""
    os.makedirs(str(zim_dir / "medical"))
    build_fixture_zim(str(zim_dir / "medical" / "wikem_en_2026-01.zim"))
    server.load_cache(force=True)

    def explode(path):
        raise AssertionError(f"cached boot re-opened an archive: {path}")

    server._zim_files_cache = None
    server._zim_list_cache = None
    server._archive_pool.clear()
    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(server, "open_archive", explode)
        server.load_cache()

    entry = _entry("wikem")
    assert entry["category"] == "Medical"
    assert entry["folder"] == "medical"


def test_moving_a_zim_into_a_folder_refiles_it_on_the_next_boot(zim_dir):
    """A move changes neither mtime nor size, so a cached category would be
    stale forever. Deriving from the path is what makes the move land."""
    build_fixture_zim(str(zim_dir / "wikem_en_2026-01.zim"))
    server.load_cache(force=True)
    assert _entry("wikem")["category"] == "Medical"  # heuristic, no folder yet

    os.makedirs(str(zim_dir / "emergency-prep"))
    shutil.move(
        str(zim_dir / "wikem_en_2026-01.zim"),
        str(zim_dir / "emergency-prep" / "wikem_en_2026-01.zim"),
    )
    server._zim_files_cache = None
    server._zim_list_cache = None
    server.load_cache()

    entry = _entry("wikem")
    assert entry["category"] == "Emergency Prep"
    assert entry["folder"] == "emergency-prep"


def test_disk_cache_record_gains_no_new_keys(zim_dir):
    """Downgrade safety: a cache written by this version must read identically
    on a version that has never heard of folders."""
    os.makedirs(str(zim_dir / "medical"))
    build_fixture_zim(str(zim_dir / "medical" / "wikem_en_2026-01.zim"))
    server.load_cache(force=True)
    with open(os.path.join(str(server.ZIMI_DATA_DIR), "cache.json")) as f:
        written = json.load(f)["files"]["wikem_en_2026-01.zim"]
    known = {
        "name",
        "mtime",
        "size",
        "size_gb",
        "entries",
        "title",
        "description",
        "date",
        "language",
        "has_icon",
        "main_path",
        "article_count",
        "zimi_export",
        "first_seen",
        "updated_at",
        "has_qids",
    }
    assert set(written) <= known


def test_legacy_cache_entry_still_loads_and_gains_a_folder_category(zim_dir):
    """An older cache carries none of the newer fields. It must load without
    complaint, and the folder category arrives for free — no rescan needed."""
    os.makedirs(str(zim_dir / "medical"))
    path = build_fixture_zim(str(zim_dir / "medical" / "wikem_en_2026-01.zim"))
    st = os.stat(path)
    legacy = {
        "version": server._CACHE_VERSION,
        "files": {
            "wikem_en_2026-01.zim": {
                "name": "wikem",
                "mtime": st.st_mtime,
                "size": st.st_size,
                "size_gb": 0.0,
                "entries": 3,
                "title": "WikEM",
                "description": "",
                "has_icon": False,
                "main_path": "",
            }
        },
    }
    with open(os.path.join(str(server.ZIMI_DATA_DIR), "cache.json"), "w") as f:
        json.dump(legacy, f)
    server.load_cache()

    entry = _entry("wikem")
    assert entry["title"] == "WikEM"  # came from the legacy record
    assert entry["category"] == "Medical"
    assert entry["folder"] == "medical"


def test_shadowed_subfolder_copy_never_supplies_a_folder_category(zim_dir):
    """The collision rule stands: the root copy serves, so the category is the
    root file's — a quarantined or backup copy in a folder cannot re-file the
    ZIM that is actually being read."""
    os.makedirs(str(zim_dir / "old-editions"))
    build_fixture_zim(str(zim_dir / "wikipedia_en_all_2026-01.zim"))
    build_fixture_zim(str(zim_dir / "old-editions" / "wikipedia_en_all_2026-01.zim"))
    server.load_cache(force=True)

    entries = [z for z in server._zim_list_cache if z["name"] == "wikipedia"]
    assert len(entries) == 1
    assert entries[0]["category"] == "Wikimedia"
    assert "folder" not in entries[0]


def test_registering_a_downloaded_zim_keeps_root_behavior(zim_dir):
    """Downloads land in the root; incremental registration must categorize
    them exactly as a full scan would."""
    build_fixture_zim(str(zim_dir / "existing_en_2026-01.zim"))
    server.load_cache(force=True)
    new_path = str(zim_dir / "wikem_en_2026-07.zim")
    build_fixture_zim(new_path)
    assert server.register_zim_file(new_path) is True

    entry = _entry("wikem")
    assert entry["category"] == "Medical"
    assert "folder" not in entry


# ---------------------------------------------------------------------------
# Live boot (port 8895 only): /list precedence
# ---------------------------------------------------------------------------


def _boot_and_list(zdir, data_dir):
    env = os.environ.copy()
    for k in ("ZIM_DIR", "ZIMI_DATA_DIR", "ZIMI_HOST", "ZIMI_PORT", "ZIMI_CONFIG"):
        env.pop(k, None)
    env.update(
        {
            "ZIM_DIR": zdir,
            "ZIMI_DATA_DIR": data_dir,
            "ZIMI_AUTO_UPDATE": "0",
            "ZIMI_TORRENT": "0",
            "ZIMI_PEER_DISCOVERY": "0",
            "PYTHONUNBUFFERED": "1",
            "PYTHONPATH": REPO_ROOT + os.pathsep + os.environ.get("PYTHONPATH", ""),
        }
    )
    log_fd, log_path = tempfile.mkstemp(prefix="zimi-folder-cat-log-")
    os.close(log_fd)
    with open(log_path, "w") as log_f:
        proc = subprocess.Popen(
            [sys.executable, "-m", "zimi", "serve", "--port", LIVE_PORT],
            cwd=REPO_ROOT,
            env=env,
            stdout=log_f,
            stderr=subprocess.STDOUT,
        )
    try:
        port = _wait_for_ready(proc, log_path)
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/list", timeout=5) as resp:
            return json.loads(resp.read().decode())
    finally:
        try:
            proc.terminate()
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=2)
        try:
            os.remove(log_path)
        except OSError:
            pass


def test_serve_lists_a_subfolder_zim_under_its_folder_category(tmp_path):
    zdir = tmp_path / "zims"
    (zdir / "field-guides").mkdir(parents=True)
    build_fixture_zim(str(zdir / "field-guides" / "mushrooms_en_2026-01.zim"))
    data = tmp_path / "data"
    data.mkdir()

    listing = _boot_and_list(str(zdir), str(data))
    entry = next(z for z in listing if z["name"] == "mushrooms")
    assert entry["category"] == "Field Guides"
    assert entry["folder"] == "field-guides"


def test_hand_set_override_still_beats_the_folder_category(tmp_path):
    """Precedence, end to end: override > folder > heuristic. Someone who moves
    a ZIM in the UI has overruled the filing, and that must stick."""
    zdir = tmp_path / "zims"
    (zdir / "field-guides").mkdir(parents=True)
    build_fixture_zim(str(zdir / "field-guides" / "mushrooms_en_2026-01.zim"))
    data = tmp_path / "data"
    data.mkdir()
    with open(str(data / "library_layout.json"), "w") as f:
        json.dump(
            {"overrides": {"mushrooms": "Books"}, "section_order": [], "sections": []},
            f,
        )

    listing = _boot_and_list(str(zdir), str(data))
    entry = next(z for z in listing if z["name"] == "mushrooms")
    assert entry["category"] == "Books"
    assert entry["folder"] == "field-guides"  # raw folder still reported
