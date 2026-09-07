"""Every site a user reports goes into tests/sites/reported.json and stays.

Eric, 2026-09-06: "I want all sites users report to look great like go into a
test suite and we do somehow compare live to captured screenshots."

Two layers. The registry's SHAPE is checked on every run, everywhere: a site
that cannot be captured, opened and checked by scripts/site_suite.py is a
site the suite silently skips, which is the failure mode this whole thing
exists to end. The sites themselves are captured and exercised only when
asked (ZIMI_SITE_SUITE=1), because that needs the network, a browser, and
the warc2zim sidecar, and takes minutes per site.
"""

import importlib.util
import json
import os
import pathlib
import sys
import urllib.parse

import pytest

ROOT = pathlib.Path(__file__).resolve().parent.parent
REGISTRY = ROOT / "tests" / "sites" / "reported.json"
RUNNER = ROOT / "scripts" / "site_suite.py"
ENGINES = {"builtin", "rendered", "alive", "singlefile", "zimit"}


def _sites():
    data = json.loads(REGISTRY.read_text(encoding="utf-8"))
    assert (
        isinstance(data.get("sites"), list) and data["sites"]
    ), "the registry is empty"
    return data["sites"]


def test_every_reported_site_is_a_site_the_suite_can_run():
    seen = set()
    for site in _sites():
        url = site.get("url", "")
        parts = urllib.parse.urlsplit(url)
        assert parts.scheme in ("http", "https") and parts.netloc, f"not a URL: {url!r}"
        assert url not in seen, f"listed twice: {url}"
        seen.add(url)
        assert site.get("engine", "rendered") in ENGINES, f"{url}: unknown engine"
        assert isinstance(site.get("issue"), int), f"{url}: which issue reported it?"
        assert site.get("why"), f"{url}: say in one line what went wrong"
        interact = site.get("interact") or {}
        assert (
            "click" in interact or "type_into" in interact
        ), f"{url}: an entry with nothing to exercise checks nothing"
        if "type_into" in interact:
            assert interact.get("text"), f"{url}: type_into needs text"
        assert interact.get("expect_text_change") or interact.get(
            "expect_visible"
        ), f"{url}: say what should happen"


def test_the_runner_still_reads_this_registry():
    src = RUNNER.read_text(encoding="utf-8")
    assert (
        '"reported.json"' in src
    ), "scripts/site_suite.py no longer reads the registry"


@pytest.mark.skipif(
    os.environ.get("ZIMI_SITE_SUITE") != "1",
    reason="captures real sites: set ZIMI_SITE_SUITE=1 (needs network, browser, sidecar)",
)
@pytest.mark.parametrize(
    "site", _sites(), ids=lambda s: urllib.parse.urlsplit(s["url"]).netloc
)
def test_reported_site_captures_and_works(site, tmp_path):
    spec = importlib.util.spec_from_file_location("site_suite", RUNNER)
    runner = importlib.util.module_from_spec(spec)
    sys.modules["site_suite"] = runner
    spec.loader.exec_module(runner)
    (records,) = [runner.run([site], tmp_path)]
    rec = records[0]
    assert rec.get("pass"), json.dumps(rec, indent=2)
