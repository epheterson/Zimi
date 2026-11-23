"""The capture tools Zimi ships: browsertrix-behaviors in zimi/assets, and the
warc2zim sidecar the Docker image carries outside the data volume."""

import hashlib
import json
import os
import sys

import pytest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO_ROOT)

import zimi.behaviors as behaviors  # noqa: E402
import zimi.importer as importer  # noqa: E402
import zimi.server as _srv  # noqa: E402

# The pin docs/THIRD_PARTY_NOTICES.md states for the shipped, unmodified release.
BEHAVIORS_SHA256 = "82c60aae18588aa6c1a6e54d75887a72c970d840c54cb8b36eb9c9ccf946d7da"
ASSET_DIR = os.path.join(REPO_ROOT, "zimi", "assets", "browsertrix-behaviors")


@pytest.fixture(autouse=True)
def _fresh(monkeypatch):
    monkeypatch.delenv(behaviors._ENV_VAR, raising=False)
    monkeypatch.setattr(behaviors, "_NODE_ROOTS", ())
    monkeypatch.setattr(behaviors.shutil, "which", lambda _n: None)
    behaviors.reset()
    yield
    behaviors.reset()


def test_bundled_behaviors_are_the_pinned_unmodified_release():
    path = os.path.join(ASSET_DIR, "dist", "behaviors.js")
    with open(path, "rb") as f:
        assert hashlib.sha256(f.read()).hexdigest() == BEHAVIORS_SHA256
    with open(os.path.join(ASSET_DIR, "package.json"), encoding="utf-8") as f:
        pkg = json.load(f)
    assert pkg["version"] == "0.15.0"
    assert pkg["license"] == "AGPL-3.0-or-later"
    with open(os.path.join(ASSET_DIR, "LICENSE.md"), encoding="utf-8") as f:
        assert "GNU AFFERO GENERAL PUBLIC LICENSE" in f.read()
    with open(os.path.join(REPO_ROOT, "docs", "THIRD_PARTY_NOTICES.md"), encoding="utf-8") as f:
        notices = f.read()
    assert BEHAVIORS_SHA256 in notices and "browsertrix-behaviors" in notices


def test_bundled_copy_is_the_default():
    assert behaviors.behaviors_path() == behaviors._BUNDLED
    assert behaviors.behaviors_available()
    assert behaviors.behaviors_version() == "0.15.0"


def test_operator_env_overrides_the_bundled_copy(tmp_path, monkeypatch):
    mine = tmp_path / "behaviors.js"
    mine.write_text("/* mine */", encoding="utf-8")
    monkeypatch.setenv(behaviors._ENV_VAR, str(mine))
    assert behaviors.behaviors_path() == str(mine)
    assert behaviors.behaviors_source() == "/* mine */"


def test_operator_npm_install_beats_the_bundled_copy(tmp_path, monkeypatch):
    root = tmp_path / "node_modules"
    installed = root / behaviors._REL_PATH
    installed.parent.mkdir(parents=True)
    installed.write_text("/* npm */", encoding="utf-8")
    monkeypatch.setattr(behaviors, "_NODE_ROOTS", (str(root),))
    assert behaviors.behaviors_path() == str(installed)


def test_a_bad_env_path_does_not_fall_back_silently(monkeypatch):
    monkeypatch.setenv(behaviors._ENV_VAR, "/nonexistent/behaviors.js")
    assert behaviors.behaviors_path() == ""


@pytest.fixture
def sidecars(tmp_path, monkeypatch):
    data = tmp_path / "data"
    data.mkdir()
    monkeypatch.setattr(_srv, "ZIMI_DATA_DIR", str(data))
    bundled = tmp_path / "opt"
    monkeypatch.setattr(importer, "BUNDLED_SIDECARS_DIR", str(bundled))
    return data, bundled


def _install(venv):
    exe = importer._venv_bin(str(venv), "warc2zim")
    os.makedirs(os.path.dirname(exe))
    open(exe, "w").close()
    with open(os.path.join(str(venv), ".zimi-sidecar.json"), "w") as f:
        json.dump({"warc2zim": "2.3.1", "python": "3.14"}, f)


def test_bundled_sidecar_is_used_when_the_data_folder_has_none(sidecars):
    data, bundled = sidecars
    _install(bundled / "warc2zim")
    assert importer.sidecar_dir() == str(bundled / "warc2zim")
    assert importer.sidecar_status()["installed"] is True


def test_a_data_folder_sidecar_wins_over_the_bundled_one(sidecars):
    data, bundled = sidecars
    _install(bundled / "warc2zim")
    _install(data / "tools" / "warc2zim")
    assert importer.sidecar_dir() == str(data / "tools" / "warc2zim")


def test_without_either_a_sidecar_builds_in_the_data_folder(sidecars):
    data, _bundled = sidecars
    assert importer.sidecar_dir() == str(data / "tools" / "warc2zim")
