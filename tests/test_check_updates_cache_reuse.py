"""_check_updates reuses the browse UI's warm catalog cache — no extra Kiwix
round trips on the common path.

Field report: "why does the updates check take so long?" Root cause: the browse
UI warms the SWR catalog under an EMPTY lang (`||500|start`), but _check_updates
fetched under lang="eng" (`|eng|500|start`) — a different cache key. So every
manual check missed the warm cache and re-fetched the whole (paginated) catalog
from Kiwix, even right after the user had just browsed it. Aligning the key to
the browse UI's (empty lang) makes the common path do ZERO network requests, and
also fixes a correctness gap: an eng-filtered catalog can't match non-English
installs (wikipedia_de, ...), so they were never offered updates.

These tests mock the network at urlopen and count real round trips.
"""

import os
import sys
import time
import urllib.request

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi.library as lib  # noqa: E402
import zimi.server as server  # noqa: E402

# A realistic catalog: ~1072 entries → 3 pages at count=500. 66 of them are
# newer versions of installed ZIMs (so 66 updates are expected); the rest are
# unrelated noise that only exists to make the catalog span multiple pages.
_N_INSTALLED = 66
_N_CATALOG = 1072
_PER_CALL_LATENCY = 0.05  # simulated NAS→Kiwix round-trip cost, seconds


def _installed_base(i):
    # Mix in a non-English ZIM to prove eng-filtering isn't required to match.
    langs = ["en", "de", "he", "fr"]
    return f"proj{i}_{langs[i % len(langs)]}"


def _entry_xml(name, fname):
    return (
        "<entry>"
        f"<name>{name}</name>"
        f"<title>{name}</title>"
        "<dc:issued>2026-02-15</dc:issued>"
        '<link rel="http://opds-spec.org/acquisition/open-access"'
        ' type="application/x-zim"'
        f' href="https://download.kiwix.org/zim/x/{fname}.zim.meta4" length="1000"/>'
        "</entry>"
    )


def _build_entries():
    entries = []
    # 66 that update installed ZIMs (newer 2026-02 vs installed 2026-01).
    for i in range(_N_INSTALLED):
        base = _installed_base(i)
        entries.append((base, f"{base}_2026-02"))
    # Filler to reach a realistic multi-page catalog.
    for j in range(_N_INSTALLED, _N_CATALOG):
        entries.append((f"filler{j}_en", f"filler{j}_en_2026-02"))
    return entries


_ENTRIES = _build_entries()


def _page_xml(start, count):
    page = _ENTRIES[start : start + count]
    body = "".join(_entry_xml(n, f) for n, f in page)
    return (
        '<feed xmlns="http://www.w3.org/2005/Atom"'
        ' xmlns:dc="http://purl.org/dc/terms/">'
        f"<totalResults>{len(_ENTRIES)}</totalResults>"
        f"{body}</feed>"
    ).encode()


class _FakeResp:
    def __init__(self, data):
        self._data = data

    def read(self):
        return self._data

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


@pytest.fixture
def _env(tmp_path, monkeypatch):
    zim_dir = tmp_path / "zims"
    zim_dir.mkdir()
    monkeypatch.setattr(server, "ZIM_DIR", str(zim_dir))
    (tmp_path / "data").mkdir()
    monkeypatch.setattr(server, "ZIMI_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setattr(lib, "_opds_disk_loaded", True)  # isolate from disk
    monkeypatch.setattr(lib, "_thumb_prefetch_started", True)
    monkeypatch.setattr(lib, "_OPDS_BG_REFRESH", False)  # no background threads
    lib._opds_cache.clear()
    lib._opds_refreshing.clear()
    lib._catalog_stale_ts = None

    # 66 installed ZIMs, one month behind their catalog entry. Stub
    # get_zim_files (rather than rely on the real scan) so a cross-test file-list
    # cache can't leak in and empty our install set.
    installed = {}
    for i in range(_N_INSTALLED):
        base = _installed_base(i)
        fn = f"{base}_2026-01.zim"
        (zim_dir / fn).write_bytes(b"")
        installed[base] = str(zim_dir / fn)
    monkeypatch.setattr(server, "get_zim_files", lambda: dict(installed))

    calls = {"n": 0}

    def fake_urlopen(req, *a, **k):
        calls["n"] += 1
        time.sleep(_PER_CALL_LATENCY)
        from urllib.parse import parse_qs, urlparse

        q = parse_qs(urlparse(req.full_url).query)
        start = int(q.get("start", ["0"])[0])
        count = int(q.get("count", ["500"])[0])
        return _FakeResp(_page_xml(start, count))

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    yield calls
    lib._opds_cache.clear()
    lib._opds_refreshing.clear()
    lib._catalog_stale_ts = None


def _browse_warm():
    """Mimic the browse UI loading the whole catalog under an empty lang."""
    return lib._full_catalog("")


def test_warm_browse_cache_means_zero_network_on_update_check(_env, capsys):
    calls = _env

    # User opens the catalog: the browse UI warms the SWR cache (3 pages).
    t0 = time.perf_counter()
    _browse_warm()
    warm_calls = calls["n"]
    browse_secs = time.perf_counter() - t0
    assert warm_calls == 3  # 1072 / 500 → 3 pages

    # Now the manual update check: must hit the warm cache, ZERO new requests.
    calls["n"] = 0
    t1 = time.perf_counter()
    updates = lib._check_updates()
    check_secs = time.perf_counter() - t1

    assert calls["n"] == 0, "update check should reuse the warm browse cache"
    assert len(updates) == _N_INSTALLED  # every install (incl. de/he/fr) matched

    # Before/after timing for the report.
    print(
        f"\n[update-check timing] browse warm ({warm_calls} net calls) "
        f"= {browse_secs*1000:.0f} ms; "
        f"subsequent update check = {check_secs*1000:.1f} ms, "
        f"{calls['n']} net calls"
    )


def test_cold_check_pays_the_network_once_then_is_cached(_env):
    calls = _env
    # Cold cache (user never browsed): the check fetches all pages once.
    updates = lib._check_updates()
    assert calls["n"] == 3
    assert len(updates) == _N_INSTALLED
    # A second check rides the now-warm cache — no further round trips.
    calls["n"] = 0
    updates2 = lib._check_updates()
    assert calls["n"] == 0
    assert len(updates2) == _N_INSTALLED


def test_non_english_installs_are_matched(_env):
    """Regression: eng-filtering would drop de/he/fr installs from the check."""
    _env
    updates = lib._check_updates()
    names = {u["installed_file"] for u in updates}
    # At least one German and one Hebrew install must be offered an update.
    assert any("_de_" in n for n in names)
    assert any("_he_" in n for n in names)
