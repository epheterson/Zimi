"""The import picker and the browser probe on the Create page.

A user, 2026-09-19: "When trying to install a browser engine ... I
successfully download what it requires but the app says the browser
engine wasn't installed." And: "I'd like a way to convert warc files
within the app's gui."

Run: pytest tests/test_create_import_picker.py -v
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

import zimi.manage as manage  # noqa: E402
import zimi.server as srv  # noqa: E402


# ── the archives the picker lists ──────────────────────────────────────────


def test_the_listing_is_the_library_folder_and_its_imports_subfolder(tmp_path, monkeypatch):
    lib = tmp_path / "zims"
    (lib / "imports").mkdir(parents=True)
    (lib / "deep" / "er").mkdir(parents=True)
    (lib / "a.wacz").write_bytes(b"x" * 10)
    (lib / "b.WARC").write_bytes(b"x" * 20)
    (lib / "c.warc.gz").write_bytes(b"x" * 30)
    (lib / "wikipedia.zim").write_bytes(b"x")
    (lib / "notes.txt").write_bytes(b"x")
    (lib / "imports" / "d.warc").write_bytes(b"x" * 40)
    (lib / "deep" / "er" / "e.warc").write_bytes(b"x")  # not recursive
    (lib / "dir.warc").mkdir()  # a folder with the extension is not a file
    monkeypatch.setattr(srv, "ZIM_DIR", str(lib))
    got = manage._create_archives()
    assert sorted(a["name"] for a in got) == ["a.wacz", "b.WARC", "c.warc.gz", "imports/d.warc"]
    assert {a["name"]: a["size_bytes"] for a in got}["imports/d.warc"] == 40
    assert set(got[0]) == {"name", "size_bytes"}


def test_a_missing_library_folder_lists_nothing(tmp_path, monkeypatch):
    monkeypatch.setattr(srv, "ZIM_DIR", str(tmp_path / "nope"))
    assert manage._create_archives() == []


@pytest.mark.parametrize(
    "name",
    ["../x.warc", "/etc/passwd", "imports/../a.wacz", "a.wacz/", "", "  ", "nope.warc", "deep/er/e.warc"],
)
def test_only_a_listed_name_resolves(tmp_path, monkeypatch, name):
    lib = tmp_path / "zims"
    (lib / "imports").mkdir(parents=True)
    (lib / "a.wacz").write_bytes(b"x")
    monkeypatch.setattr(srv, "ZIM_DIR", str(lib))
    with pytest.raises(ValueError):
        manage._create_archive_path(name)
    assert manage._create_archive_path("a.wacz") == os.path.join(str(lib), "a.wacz")


def test_the_probe_carries_the_listing_and_where_it_looked(tmp_path, monkeypatch):
    lib = tmp_path / "zims"
    lib.mkdir()
    (lib / "a.wacz").write_bytes(b"x")
    monkeypatch.setattr(srv, "ZIM_DIR", str(lib))
    monkeypatch.setattr(manage, "_create_import_ready", lambda: True)
    monkeypatch.setattr(manage, "_create_sidecar_dir", lambda: None)
    monkeypatch.setattr(manage, "_create_browser_ready", lambda: False)
    monkeypatch.setattr(manage, "_create_alive_ready", lambda: False)
    monkeypatch.setattr(manage, "_create_video_ready", lambda: False)
    payload = manage._create_status(0, probe=True)
    assert [a["name"] for a in payload["archives"]] == ["a.wacz"]
    assert payload["archives_dir"] == str(lib)
    assert "browser_install" in payload


# ── the browser probe asks again after a no ────────────────────────────────


def test_a_no_is_asked_again_and_a_yes_is_kept(monkeypatch):
    from zimi import renderer

    calls = []

    def fake_available(refresh=False):
        calls.append(refresh)
        return False

    monkeypatch.setattr(renderer, "browser_status_known", lambda: None)
    monkeypatch.setattr(renderer, "browser_available", fake_available)
    assert manage._create_browser_ready() is False
    assert calls == [False], "the first ask does not force a launch on top of the renderer's own"
    monkeypatch.setattr(renderer, "browser_status_known", lambda: (False, "no-chromium"))
    manage._create_browser_ready()
    assert calls[-1] is True, "a remembered no is asked again, so an install made while running shows up"
    monkeypatch.setattr(renderer, "browser_status_known", lambda: (True, "ok"))
    n = len(calls)
    assert manage._create_browser_ready() is True
    assert len(calls) == n, "a yes is a fact about the install; no launch"


# ── the install command targets this server's Python ───────────────────────


def test_the_install_command_names_this_interpreter(monkeypatch):
    monkeypatch.setattr(sys, "executable", "/opt/zimi/venv/bin/python3")
    monkeypatch.delattr(sys, "frozen", raising=False)
    monkeypatch.setattr(sys, "_MEIPASS", None, raising=False)
    cmd = manage._create_browser_install()
    assert cmd == "/opt/zimi/venv/bin/python3 -m pip install 'zimi[browser]' && /opt/zimi/venv/bin/python3 -m playwright install chromium"


def test_a_path_with_a_space_is_quoted(monkeypatch):
    monkeypatch.setattr(sys, "executable", "/Users/e p/venv/bin/python")
    monkeypatch.delattr(sys, "frozen", raising=False)
    monkeypatch.setattr(sys, "_MEIPASS", None, raising=False)
    assert manage._create_browser_install().startswith("'/Users/e p/venv/bin/python' -m pip")


def test_uv_tool_installs_get_the_uv_command(monkeypatch):
    monkeypatch.setattr(sys, "executable", "/home/h/.local/share/uv/tools/zimi/bin/python")
    monkeypatch.delattr(sys, "frozen", raising=False)
    monkeypatch.setattr(sys, "_MEIPASS", None, raising=False)
    assert manage._create_browser_install().startswith("uv tool install --force 'zimi[browser]'")


def test_a_frozen_build_has_no_command(monkeypatch):
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    assert manage._create_browser_install() is None


# ── the preview ────────────────────────────────────────────────────────────


def test_the_preview_of_an_archive_is_its_size_not_a_fetch(tmp_path, monkeypatch):
    lib = tmp_path / "zims"
    lib.mkdir()
    (lib / "a.wacz").write_bytes(b"x" * 1234)
    monkeypatch.setattr(srv, "ZIM_DIR", str(lib))
    monkeypatch.setattr(manage, "_create_import_ready", lambda: False)
    monkeypatch.setattr(manage, "_create_job", None)
    payload, status = manage._create_probe({"mode": "import", "source": "a.wacz"})
    assert status == 200, payload
    assert payload["ok"] is True and payload["bytes"] == 1234 and payload["title"] == "a.wacz"
    assert payload["import_ready"] is False
    payload, status = manage._create_probe({"mode": "import", "source": "https://example.org/a.wacz"})
    assert status == 400 and "choose an archive" in payload["error"]
