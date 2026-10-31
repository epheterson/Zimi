"""Shared test isolation.

Tests never touch the network around them: a test server that starts
BitTorrent must not ask the router to open a port (one did, 2026-09-28,
and left a 24-hour UPnP mapping on the developer's router). UPnP and
NAT-PMP are off for every test except the ones about them.

Zimi keeps open archives in pools keyed by a ZIM's short name. The running
server clears them whenever the library changes (a download, an update, a
refresh); a test that points the server at a new library directly does
not, so a later test whose fixture ZIM has the same short name as an
earlier one's read the earlier file. Each passed alone and failed in the
full suite. Every test starts with empty pools.

The rate limiter's buckets are process-wide too, keyed by client IP, and
every in-process test server is 127.0.0.1. A fast run (the CI runner)
spent the minute's budget in earlier tests, and a later test's search or
catalog came back 429: "no results", a missing app. Every test starts
with a full budget.

Search answers are cached for fifteen minutes by query, and title indexes
held open by ZIM name: the same short names again. Every test starts with
neither (cleared in memory only; the server's own clear also writes the
suggest cache to whatever data dir the last test left behind).
"""

import inspect
import os
import re
import shutil
from pathlib import Path

import pytest

# The best answer card is off unless the operator turns it on; its tests are
# about the card, so the suite runs with it on (set before zimi.http reads it).
os.environ.setdefault("ZIMI_BEST_ANSWER", "1")
# Zimi's own ZIMs (ZimiGames, the Almanac) would join every test library, a single-ZIM
# library among them; tests/test_ownzims.py turns them on for its own.
os.environ.setdefault("ZIMI_BUILTIN_ZIMS", "0")
# The suite's premise is the defaults: BitTorrent on, the network reachable.
# A shell that exports ZIMI_TORRENT=0 / ZIMI_OFFLINE=1 (the release gate, a
# developer who runs a server) would flip ~60 tests, so they are dropped here,
# before any test module reads them, in every pytest-xdist worker too. A test
# that needs either one sets it itself (monkeypatch.setenv).
for _var in ("ZIMI_TORRENT", "ZIMI_OFFLINE"):
    os.environ.pop(_var, None)


def _register_shard(config):
    spec = config.getoption("--shard")
    if spec:
        try:
            index, count = (int(part) for part in spec.split("/"))
        except ValueError:
            index = count = 0
        if not 1 <= index <= count:
            raise pytest.UsageError(f"--shard {spec}: want I/N with 1 <= I <= N")
        config.pluginmanager.register(_Shard(index, count), "zimi-shard")


def pytest_configure(config):
    """Each pytest run gets a base temp directory of its own. The default,
    <tmp>/pytest-of-<user>/pytest-N, is shared by every run on the machine,
    and pytest deletes all but the newest few: a second run (another
    terminal, another agent) removed a running run's directories out from
    under it (FileNotFoundError .../popen-gwN). Workers inherit the
    controller's directory from xdist."""
    _register_shard(config)
    if getattr(config, "workerinput", None) is not None or config.option.basetemp:
        return
    import tempfile

    config.option.basetemp = Path(tempfile.mkdtemp(prefix="zimi-pytest-"))
    config._zimi_basetemp = config.option.basetemp


# A module drives a real browser when it imports Playwright or asks the
# renderer / PDF engine whether a Chromium is there. Those are the slow tests
# (most of a full run's time): `pytest -m "not browser" -n auto` is the quick
# tier, `pytest -n auto` the full one. Marked here, from the module's source,
# so a new browser test is in the slow tier without anyone remembering to tag it.
_BROWSER_SOURCE = re.compile(
    r"sync_playwright|async_playwright|^\s*(?:from|import)\s+playwright"
    r"|importorskip\(\s*[\"']playwright|\.(?:chromium|webkit|firefox)\.launch"
    r"|browser_available\(|_needs_chromium|_need_browser|apdf\.available\(",
    re.M,
)
_browser_sources = {}


def _drives_a_browser(path):
    path = str(path)
    if os.path.basename(path) == "conftest.py":
        return False  # this file names the patterns it looks for
    if path not in _browser_sources:
        try:
            text = Path(path).read_text(encoding="utf-8", errors="replace")
        except OSError:
            text = ""
        _browser_sources[path] = bool(_BROWSER_SOURCE.search(text))
    return _browser_sources[path]


@pytest.hookimpl(tryfirst=True)
def pytest_collection_modifyitems(config, items):
    """Mark a test `browser` when its module, or the module of any fixture it
    uses (a `browser` fixture imported from another test file counts), drives
    a browser."""
    for item in items:
        sources = [item.path]
        for defs in item._fixtureinfo.name2fixturedefs.values():
            for fixturedef in defs:
                try:
                    sources.append(inspect.getsourcefile(fixturedef.func))
                except (TypeError, OSError):
                    pass
        if any(src and _drives_a_browser(src) for src in sources):
            item.add_marker(pytest.mark.browser)


def pytest_addoption(parser):
    parser.addoption(
        "--shard", metavar="I/N", default=None,
        help="run only shard I of N (1-based) of the selected tests: every test "
             "module lands in exactly one shard, balanced by file size (CI splits "
             "the browser tests over parallel jobs with this)",
    )


def shard_of(modules, count):
    """module name -> shard number (1..count). Largest files first, each to the
    lightest shard so far: a stable split that every machine computes alike."""
    load = {n: 0 for n in range(1, count + 1)}
    out = {}
    for name, weight in sorted(modules.items(), key=lambda kv: (-kv[1], kv[0])):
        lightest = min(load, key=lambda n: (load[n], n))
        out[name] = lightest
        load[lightest] += weight
    return out


class _Shard:
    """--shard I/N, applied after -m has chosen the tests."""

    def __init__(self, index, count):
        self.index, self.count = index, count

    @pytest.hookimpl(trylast=True)
    def pytest_collection_modifyitems(self, config, items):
        sizes = {item.path.name: item.path.stat().st_size for item in items}
        mine = {n for n, k in shard_of(sizes, self.count).items() if k == self.index}
        dropped = [item for item in items if item.path.name not in mine]
        config.hook.pytest_deselected(items=dropped)
        items[:] = [item for item in items if item.path.name in mine]


def pytest_unconfigure(config):
    own = getattr(config, "_zimi_basetemp", None)
    if own is not None:
        shutil.rmtree(own, ignore_errors=True)


@pytest.fixture
def free_port():
    """A port the OS says is free (tests bind this, never a fixed number, so
    workers running in parallel cannot collide)."""
    from tests.ports import free_port as _free_port

    return _free_port


@pytest.fixture(autouse=True, scope="session")
def _cheap_password_hashing():
    """Every password set or checked costs 600,000 PBKDF2 rounds, a fraction
    of a second by design, and the access tests do it hundreds of times. In
    this process a hash is made and checked with the same count, so the
    tests lose nothing at 1,000. Servers a test starts as `zimi serve` keep
    the real count; none of them reads a password this process wrote."""
    try:
        from zimi import manage
    except Exception:
        yield
        return
    real = manage._PW_ITERATIONS
    manage._PW_ITERATIONS = 1_000
    yield
    manage._PW_ITERATIONS = real


@pytest.fixture(autouse=True)
def _fresh_archive_pools():
    try:
        from zimi import server as _srv
    except Exception:
        yield
        return
    for pool_name, lock_name, locks_name in (
        ("_archive_pool", "_archive_lock", None),
        ("_fts_pool", "_fts_pool_lock", "_fts_zim_locks"),
        ("_suggest_pool", "_suggest_pool_lock", "_suggest_zim_locks"),
    ):
        pool = getattr(_srv, pool_name, None)
        lock = getattr(_srv, lock_name, None)
        if pool is None or lock is None:
            continue
        with lock:
            pool.clear()
            if locks_name and getattr(_srv, locks_name, None) is not None:
                getattr(_srv, locks_name).clear()
    yield


@pytest.fixture(autouse=True)
def _fresh_rate_budget():
    try:
        from zimi import http as _http
    except Exception:
        yield
        return
    with _http._rate_lock:
        for buckets in (
            _http._rate_buckets,
            _http._rate_buckets_content,
            _http._rate_buckets_keep,
            _http._rate_buckets_login,
            _http._authed_cache,
        ):
            buckets.clear()
    yield


@pytest.fixture(autouse=True)
def _fresh_search_state():
    try:
        from zimi import search as _search
    except Exception:
        yield
        return
    with _search._search_cache_lock:
        _search._search_cache.clear()
    with _search._suggest_cache_lock:
        _search._suggest_cache.clear()
    for name in list(_search._title_db_pool):
        _search._close_title_db(name)
    yield


@pytest.fixture(autouse=True)
def _fieldguide_switch(request, monkeypatch):
    """The Field Guide is off by default (ZIMI_FIELDGUIDE); a test whose
    premise is the guide opts in with @pytest.mark.fieldguide_on (or a
    module-level pytestmark). Every other test runs with it off."""
    if request.node.get_closest_marker("fieldguide_on"):
        monkeypatch.setenv("ZIMI_FIELDGUIDE", "1")
    else:
        monkeypatch.delenv("ZIMI_FIELDGUIDE", raising=False)
    yield


_UPNP_TEST_MODULES = ("test_p2p_nat", "test_offline_switch")


@pytest.fixture(autouse=True)
def _no_router_changes(request, monkeypatch):
    if request.module.__name__.rsplit(".", 1)[-1] in _UPNP_TEST_MODULES:
        yield
        return
    try:
        from zimi import p2p, p2p_nat
    except Exception:
        yield
        return
    monkeypatch.setattr(p2p, "is_upnp_enabled", lambda: False)
    monkeypatch.setattr(p2p_nat, "add_port_mapping", lambda port: False)
    yield
