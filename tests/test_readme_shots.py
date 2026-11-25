"""scripts/readme_shots.py stays in step with the Home it photographs.

The script waits on what the Home draws; when the Home changes shape and the script still waits on a class that no
longer exists, it fails only on release day. This pins the wait to markup the app still builds, and the scratch
server to a setup that is already done and never reaches the network.
"""

import importlib.util
import os
import re

import pytest

# The shot taker drives a browser; a job without Playwright (the quick tier, the desktop builds) skips these.
pytest.importorskip("playwright")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _load():
    spec = importlib.util.spec_from_file_location("readme_shots", os.path.join(ROOT, "scripts", "readme_shots.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_home_ready_selector_is_markup_the_app_still_draws():
    shots = _load()
    classes = re.findall(r"\.([A-Za-z][\w-]*)", shots.HOME_READY)
    assert classes
    with open(os.path.join(ROOT, "zimi", "static", "app.js"), encoding="utf-8") as f:
        js = f.read()
    for c in classes:
        assert c in js, "the Home no longer draws .%s: update HOME_READY" % c


def test_every_shot_has_a_taker():
    shots = _load()
    with open(os.path.join(ROOT, "scripts", "readme_shots.py"), encoding="utf-8") as f:
        src = f.read()
    for name in shots.SHOTS:
        assert 'name == "%s"' % name in src, name
    for name in ("homepage", "search", "solar-system", "games"):
        assert name in shots.SHOTS


def test_scratch_server_is_set_up_and_offline(tmp_path):
    env = _load()._scratch_env(tmp_path / "z", tmp_path / "d")
    assert env["ZIMI_MANAGE_OPEN"] == "1" and env["ZIMI_OFFLINE"] == "1" and env["ZIMI_TORRENT"] == "0"
    assert env["ZIM_DIR"] != env["ZIMI_DATA_DIR"]
