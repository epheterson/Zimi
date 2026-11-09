"""Add-ons (zimi/addons.py): fetched once into the data folder, checked, and switched on without a restart.

No test reaches the network: the fake add-on is a tiny tarball served from a local port. Pinned here:
  - an archive is checked against its sha256, unpacked without leaving its folder, and a bad one leaves nothing;
  - an install is a rename of a .partial folder, with a marker, and activate() puts it on PATH;
  - Ask first / Automatically / Never: ensure() installs only under Automatically; Never and ZIMI_OFFLINE refuse;
  - the recipes are pinned (https, a sha256 for each CPU, a size) and the Dockerfile carries none of the big parts.

Run: pytest tests/test_addons.py -v
"""

import hashlib
import http.server
import io
import os
import sys
import tarfile
import threading
import zipfile

import pytest

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO)

from zimi import addons, outbound, p2p  # noqa: E402
from zimi import server  # noqa: E402


def _tar(members):
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as t:
        for name, data, mode in members:
            info = tarfile.TarInfo(name)
            info.size = len(data)
            info.mode = mode
            t.addfile(info, io.BytesIO(data))
    return buf.getvalue()


@pytest.fixture
def served():
    """{name: bytes} served on a local port; yields (base url, files)."""
    files = {}

    class H(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            body = files.get(self.path.lstrip("/"))
            if body is None:
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *a):
            pass

    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d/" % srv.server_address[1], files
    srv.shutdown()
    srv.server_close()


@pytest.fixture
def home(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "ZIMI_DATA_DIR", str(tmp_path))
    for name in ("ZIMI_OFFLINE", addons.ENV):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(addons, "supported", lambda: True)
    monkeypatch.setattr(addons, "cpu", lambda: "x64")
    monkeypatch.setattr(p2p, "is_offline", lambda: False)
    monkeypatch.setenv(
        "PATH", os.environ.get("PATH", "")
    )  # restored after activate() edits it
    return tmp_path


def _fake(url, payload, sha=None):
    """A one-archive add-on whose tool is a script in bin/."""
    arc = addons.Archive(
        "tool",
        1,
        {"x64": (url, sha or hashlib.sha256(payload).hexdigest(), len(payload))},
    )
    return addons.Addon(
        "fake", "1", (arc,), ("tool/bin",), (), {}, (), lambda: False, None, None
    )


def _register(monkeypatch, addon):
    monkeypatch.setattr(addons, "ADDONS", (addon,))
    monkeypatch.setattr(addons, "BY_KEY", {addon.key: addon})


def _wait():
    for _ in range(300):
        if addons._state.get("finished"):
            return
        threading.Event().wait(0.02)
    raise AssertionError("install did not finish")


PAYLOAD = _tar(
    [
        ("pkg/bin/zimi-fake-tool", b"#!/bin/sh\necho hi\n", 0o755),
        ("pkg/README", b"x", 0o644),
    ]
)


def test_an_install_unpacks_checks_and_goes_on_the_path(home, served, monkeypatch):
    base, files = served
    files["tool.tgz"] = PAYLOAD
    _register(monkeypatch, _fake(base + "tool.tgz", PAYLOAD))
    addons.POLICY.set("ask")
    ok, err = addons.install("fake")
    assert (ok, err) == (True, None)
    _wait()
    assert addons._state["error"] is None
    exe = home / "addons" / "fake" / "tool" / "bin" / "zimi-fake-tool"
    assert exe.exists() and os.access(exe, os.X_OK)
    assert (
        addons.installed("fake")
        and not (home / "addons" / ("fake" + addons.PARTIAL)).exists()
    )
    import shutil

    assert shutil.which("zimi-fake-tool") == str(exe)
    assert addons.status()["addons"][0]["ready"] is True


def test_a_wrong_checksum_installs_nothing(home, served, monkeypatch):
    base, files = served
    files["tool.tgz"] = PAYLOAD
    _register(monkeypatch, _fake(base + "tool.tgz", PAYLOAD, sha="0" * 64))
    addons.install("fake")
    _wait()
    assert "checksum" in addons._state["error"]
    assert not addons.installed("fake")
    assert os.listdir(home / "addons") == []


def test_a_download_larger_than_its_pin_is_refused(home, served, monkeypatch):
    base, files = served
    files["tool.tgz"] = PAYLOAD * 40
    arc = addons.Archive(
        "tool", 1, {"x64": (base + "tool.tgz", "0" * 64, len(PAYLOAD))}
    )
    _register(
        monkeypatch,
        addons.Addon("fake", "1", (arc,), (), (), {}, (), lambda: False, None, None),
    )
    addons.install("fake")
    _wait()
    assert "larger" in addons._state["error"]


def test_a_failing_check_removes_the_install(home, served, monkeypatch):
    base, files = served
    files["tool.tgz"] = PAYLOAD
    a = _fake(base + "tool.tgz", PAYLOAD)._replace(check=lambda root: 1 / 0)
    _register(monkeypatch, a)
    addons.install("fake")
    _wait()
    assert addons._state["error"] and not addons.installed("fake")


@pytest.mark.parametrize("name", ["../evil", "pkg/../../evil"])
def test_an_archive_cannot_leave_its_folder(tmp_path, name):
    data = _tar([(name, b"x", 0o644)])
    (tmp_path / "a.tgz").write_bytes(data)
    with pytest.raises(ValueError):
        addons._unpack(str(tmp_path / "a.tgz"), str(tmp_path / "out"), 0)
    assert not (tmp_path / "evil").exists()


def test_a_link_cannot_point_outside(tmp_path):
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as t:
        info = tarfile.TarInfo("pkg/link")
        info.type = tarfile.SYMTYPE
        info.linkname = "../../etc/passwd"
        t.addfile(info)
    (tmp_path / "a.tgz").write_bytes(buf.getvalue())
    with pytest.raises(ValueError):
        addons._unpack(str(tmp_path / "a.tgz"), str(tmp_path / "out"), 1)


def test_a_zip_keeps_the_executable_bit(tmp_path):
    p = tmp_path / "a.zip"
    with zipfile.ZipFile(p, "w") as z:
        info = zipfile.ZipInfo("top/chrome")
        info.external_attr = 0o755 << 16
        z.writestr(info, b"x")
    addons._unpack(str(p), str(tmp_path / "out"), 1)
    assert os.access(tmp_path / "out" / "chrome", os.X_OK)


def test_never_and_offline_refuse(home, monkeypatch):
    _register(monkeypatch, _fake("http://127.0.0.1:9/x", b"x"))
    addons.POLICY.set("never")
    assert addons.install("fake") == (False, "never")
    assert addons.ensure("fake") is False
    addons.POLICY.set("ask")
    monkeypatch.setattr(p2p, "is_offline", lambda: True)
    assert addons.install("fake") == (False, "never")
    assert addons.status()["locked"] == "offline"


def test_ensure_installs_only_under_automatically(home, served, monkeypatch):
    base, files = served
    files["tool.tgz"] = PAYLOAD
    _register(monkeypatch, _fake(base + "tool.tgz", PAYLOAD))
    addons.POLICY.set("ask")
    assert addons.ensure("fake") is False and not addons.installed("fake")
    addons.POLICY.set("auto")
    said = []
    assert addons.ensure("fake", said.append) is True
    assert addons.installed("fake") and said


def test_the_env_variable_locks_the_setting(home, monkeypatch):
    monkeypatch.setenv(addons.ENV, "never")
    assert addons.POLICY.mode() == (outbound.NEVER, outbound.LOCKED_ENV)
    assert addons.POLICY.set("auto")[1] == outbound.LOCKED_ENV


def test_unsupported_machines_are_offered_nothing(home, monkeypatch):
    monkeypatch.setattr(addons, "supported", lambda: False)
    st = addons.status()
    assert st["supported"] is False and all(r["size"] == 0 for r in st["addons"])
    assert addons.install("browser") == (False, "unsupported")


def test_the_host_having_the_tool_counts_as_ready(home, monkeypatch):
    a = _fake("http://x/", b"x")._replace(host=lambda: True)
    _register(monkeypatch, a)
    assert addons.available("fake") and not addons.installed("fake")
    assert addons.install("fake") == (False, "installed")


def test_removing_takes_the_files(home, served, monkeypatch):
    base, files = served
    files["tool.tgz"] = PAYLOAD
    _register(monkeypatch, _fake(base + "tool.tgz", PAYLOAD))
    addons.install("fake")
    _wait()
    assert addons.remove("fake") and not addons.installed("fake")


# ── the recipes ──────────────────────────────────────────────────────────────


def test_every_archive_is_pinned_for_both_cpus():
    for a in addons.ADDONS:
        for part in a.parts:
            if isinstance(part, addons.Archive):
                assert set(part.files) == {"x64", "arm64"}, a.key
                for url, sha, size in part.files.values():
                    assert (
                        url.startswith("https://")
                        and len(sha) == 64
                        and int(sha, 16) >= 0
                        and size > 0
                    )


def test_the_sizes_are_known_offline():
    for a in addons.ADDONS:
        assert addons.size_of(a) > 10 * addons.MB, a.key


def test_the_browser_revision_matches_the_playwright_pin():
    assert "chromium_headless_shell-" + addons.CHROME_REVISION in addons._BROWSER_DIR
    pins = [
        r
        for a in addons.ADDONS
        if a.key == "browser"
        for p in a.parts
        if isinstance(p, addons.Pip)
        for r in p.requirements
    ]
    assert pins == ["playwright==" + addons.PLAYWRIGHT]


def test_the_image_carries_none_of_the_big_parts():
    text = open(os.path.join(REPO, "Dockerfile"), encoding="utf-8").read()
    code = "\n".join(l for l in text.splitlines() if not l.lstrip().startswith("#"))
    for banned in (
        "playwright",
        "nodejs.org",
        "npm ",
        "ffmpeg",
        "yt-dlp",
        "piper-tts",
        "kokoro",
        "py314",
        "warc2zim",
    ):
        assert banned not in code, banned


def test_the_outbound_list_has_the_row(home):
    rows = {r["id"]: r for r in outbound.inventory()["rows"]}
    assert (
        rows["addons"]["control"] == "addons"
        and "storage.googleapis.com" in rows["addons"]["hosts"]
    )


def test_an_absolute_member_lands_inside(tmp_path):
    (tmp_path / "a.tgz").write_bytes(_tar([("/abs/evil", b"x", 0o644)]))
    addons._unpack(str(tmp_path / "a.tgz"), str(tmp_path / "out"), 0)
    assert (tmp_path / "out" / "abs" / "evil").exists()


def test_skipped_prefixes_are_not_unpacked(tmp_path):
    (tmp_path / "a.tgz").write_bytes(_tar([("p/bin/tool", b"x", 0o755), ("p/manpages/m.txt", b"x", 0o644), ("p/manpagesX", b"x", 0o644)]))
    addons._unpack(str(tmp_path / "a.tgz"), str(tmp_path / "out"), 1, ("manpages",))
    assert (tmp_path / "out" / "bin" / "tool").exists() and (tmp_path / "out" / "manpagesX").exists()
    assert not (tmp_path / "out" / "manpages").exists()
