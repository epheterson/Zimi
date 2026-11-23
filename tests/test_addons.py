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
    monkeypatch.setattr(addons, "_os", lambda: "linux")
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


@pytest.mark.skipif(os.name == "nt", reason="the fake tool is a shell script; Windows finds only PATHEXT programs")
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


def test_a_jobs_ensure_shows_on_the_row_as_it_runs_and_when_it_ends(home, served, monkeypatch):
    """The row reads one install slot; ensure() used to install without taking it, so a page open beside the job saw nothing."""
    base, files = served
    files["tool.tgz"] = PAYLOAD
    _register(monkeypatch, _fake(base + "tool.tgz", PAYLOAD))
    addons.POLICY.set("auto")
    seen = []
    real = addons._install
    monkeypatch.setattr(addons, "_install", lambda key, say=None: (seen.append(addons.status()["addons"][0].get("progress")), real(key, say))[1])
    assert addons.ensure("fake") is True
    assert seen[0]["active"] is True
    done = addons.status()["addons"][0]
    assert done["ready"] and done["progress"]["active"] is False and not done["progress"]["error"]


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


@pytest.mark.parametrize("key,other", [("reddit", "warc2zim"), ("warc2zim", "reddit")])
def test_removing_a_custom_add_on_leaves_the_other_venv(home, key, other):
    tools = home / "tools"
    own = {"reddit": "arcticzim", "warc2zim": "warc2zim"}
    for name in own.values():
        (tools / name).mkdir(parents=True)
        (tools / name / "f").write_text("x", encoding="utf-8")
    assert addons.remove(key)
    assert not (tools / own[key]).exists()
    assert (tools / own[other]).is_dir()


# ── the recipes ──────────────────────────────────────────────────────────────


def test_every_archive_is_pinned_for_every_platform():
    for a in addons.ADDONS:
        for part in a.parts:
            if isinstance(part, addons.Archive):
                assert set(part.files) == set(addons.TARGETS), a.key
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


def test_a_refused_capture_mode_says_where_the_add_on_is(home, monkeypatch):
    from zimi import manage

    _register(monkeypatch, _fake("http://127.0.0.1:9/x", b"x"))
    started = []
    monkeypatch.setattr(addons, "install", lambda key, actor=None: started.append(key) or (True, None))
    addons.POLICY.set("ask")
    assert "Add-ons" in manage._addon_refusal("needs it", "fake") and not started
    addons.POLICY.set("auto")
    assert "adding it now" in manage._addon_refusal("needs it", "fake") and started == ["fake"]
    addons.POLICY.set("never")
    assert manage._addon_refusal("needs it", "fake") == "needs it"


@pytest.mark.parametrize(
    "osname, cpu_name, want",
    [("linux", "x64", "x64"), ("linux", "arm64", "arm64"), ("mac", "x64", "mac-x64"), ("mac", "arm64", "mac-arm64"),
     ("win", "x64", "win-x64"), ("win", "arm64", None), ("freebsd", "x64", None)],
)
def test_the_target_is_the_os_and_the_cpu(monkeypatch, osname, cpu_name, want):
    monkeypatch.setattr(addons, "_os", lambda: osname if osname != "freebsd" else None)
    monkeypatch.setattr(addons, "cpu", lambda: cpu_name)
    assert addons.target() == want
    assert addons.supported() is (want is not None and not getattr(sys, "frozen", False))


def test_a_single_gzipped_binary_is_written_executable(tmp_path):
    import gzip

    src = tmp_path / "ffmpeg-x.gz"
    with gzip.open(src, "wb") as f:
        f.write(b"\x7fELFfake")
    addons._unpack(str(src), str(tmp_path / "out"), 0, (), "ffmpeg")
    out = tmp_path / "out" / "ffmpeg"
    assert out.read_bytes() == b"\x7fELFfake" and os.access(out, os.X_OK)


def test_a_windows_zip_with_no_top_folder_unpacks_flat(tmp_path):
    z = tmp_path / "uv.zip"
    with zipfile.ZipFile(z, "w") as f:
        f.writestr("uv.exe", b"MZ")
        f.writestr("uvx.exe", b"MZ")
    addons._unpack(str(z), str(tmp_path / "uv"), 0)
    assert (tmp_path / "uv" / "uv.exe").exists()


def test_the_node_files_follow_the_os_layout(monkeypatch):
    part = addons.Npm("pkg", "dest", "node", 1)
    monkeypatch.setattr(addons, "_os", lambda: "win")
    node, npm, bin_dir = addons._node_files("W", part)
    assert node.endswith("node.exe") and "lib" not in npm and bin_dir == os.path.join("W", "node")
    monkeypatch.setattr(addons, "_os", lambda: "mac")
    node, npm, bin_dir = addons._node_files("W", part)
    assert node.endswith(os.path.join("bin", "node")) and os.path.join("lib", "node_modules") in npm


def test_a_mac_or_windows_target_installs_from_its_own_pin(home, served, monkeypatch):
    """The recipe's files are looked up by the machine's target (mac-x64, win-x64...), not the bare CPU."""
    base, files = served
    files["tool.tgz"] = PAYLOAD
    monkeypatch.setattr(addons, "_os", lambda: "mac")
    monkeypatch.setattr(addons, "cpu", lambda: "x64")
    arc = addons.Archive(
        "tool", 1, {"mac-x64": (base + "tool.tgz", hashlib.sha256(PAYLOAD).hexdigest(), len(PAYLOAD))}
    )
    fake = addons.Addon("fake", "1", (arc,), ("tool/bin",), (), {}, (), lambda: False, None, None)
    _register(monkeypatch, fake)
    addons.POLICY.set("ask")
    assert addons.target() == "mac-x64" and addons.supported()
    assert addons.install("fake") == (True, None)
    _wait()
    assert addons._state["error"] is None and addons.installed("fake")


def _wheel(path, files):
    with zipfile.ZipFile(path, "w") as z:
        for name, data in files.items():
            z.writestr(name, data)


def test_a_frozen_app_unpacks_pinned_wheels_in_place_of_pip(home, served, monkeypatch):
    """No pip in a frozen app: the Pip part becomes the pinned wheels, each checked, unpacked into the same folder."""
    from zimi import addon_wheels

    base, files = served
    wheel = io.BytesIO()
    with zipfile.ZipFile(wheel, "w") as z:
        z.writestr("fakepkg/__init__.py", "VALUE = 7\n")
        z.writestr("fakepkg-1.dist-info/METADATA", "Name: fakepkg\n")
    files["fakepkg.whl"] = wheel.getvalue()
    pin = (base + "fakepkg.whl", hashlib.sha256(wheel.getvalue()).hexdigest(), len(wheel.getvalue()))
    monkeypatch.setattr(addons, "_frozen", lambda: True)
    monkeypatch.setattr(addons, "_abi", lambda: "cp312")
    monkeypatch.setattr(addon_wheels, "UNIVERSAL_WHEELS", {"fakepkg": pin})
    part = addons.Pip(("fakepkg>=1",), "site", 1)
    addon = addons.Addon("fake", "1", (part,), (), ("site",), {}, (), lambda: False, None, None)
    _register(monkeypatch, addon)
    addons.POLICY.set("ask")
    assert addons.install("fake") == (True, None)
    _wait()
    assert addons._state["error"] is None
    assert (home / "addons" / "fake" / "site" / "fakepkg" / "__init__.py").read_text(encoding="utf-8") == "VALUE = 7\n"
    site = str(home / "addons" / "fake" / "site")
    assert site in sys.path, "the add-on's folder is on sys.path"
    sys.path.remove(site)


def test_a_frozen_wheel_with_a_bad_checksum_installs_nothing(home, served, monkeypatch):
    from zimi import addon_wheels

    base, files = served
    files["w.whl"] = b"PK not a real wheel"
    monkeypatch.setattr(addons, "_frozen", lambda: True)
    monkeypatch.setattr(addons, "_abi", lambda: "cp312")
    monkeypatch.setattr(addon_wheels, "UNIVERSAL_WHEELS", {"fakepkg": (base + "w.whl", "0" * 64, 19)})
    addon = addons.Addon("fake", "1", (addons.Pip(("fakepkg",), "site", 1),), (), ("site",), {}, (), lambda: False, None, None)
    _register(monkeypatch, addon)
    addons.POLICY.set("ask")
    assert addons.install("fake") == (True, None)
    _wait()
    assert "checksum" in (addons._state["error"] or "") and not addons.installed("fake")


@pytest.mark.parametrize("abi, ok", [("cp312", True), ("cp313", True), ("cp311", False), ("cp314", False)])
def test_a_frozen_app_is_supported_for_the_pythons_it_has_wheels_for(monkeypatch, abi, ok):
    monkeypatch.setattr(addons, "_os", lambda: "mac")
    monkeypatch.setattr(addons, "cpu", lambda: "arm64")
    monkeypatch.setattr(addons, "_frozen", lambda: True)
    monkeypatch.setattr(addons, "_abi", lambda: abi)
    assert addons.supported() is ok


def test_every_wheel_the_frozen_path_needs_is_pinned_for_every_target():
    from zimi import addon_wheels as w

    for t in addons.TARGETS:
        assert t in w.PLAYWRIGHT_WHEELS
        for abi in w.ABIS:
            assert (abi, t) in w.GREENLET_WHEELS
    assert {"pyee", "typing_extensions", "yt-dlp"} <= set(w.UNIVERSAL_WHEELS)
    for pin in [*w.PLAYWRIGHT_WHEELS.values(), *w.GREENLET_WHEELS.values(), *w.UNIVERSAL_WHEELS.values()]:
        url, sha, size = pin
        assert url.startswith("https://files.pythonhosted.org/") and len(sha) == 64 and size > 0
    # Every package the recipes install by pip resolves to wheels, on every target and Python.
    for a in addons.ADDONS:
        for part in a.parts:
            if isinstance(part, addons.Pip):
                for t in addons.TARGETS:
                    for abi in w.ABIS:
                        orig = (addons.target, addons._abi)
                        try:
                            addons.target, addons._abi = (lambda t=t: t), (lambda abi=abi: abi)
                            assert addons._wheels(part.requirements), (a.key, t, abi)
                        finally:
                            addons.target, addons._abi = orig


def test_the_reddit_maker_is_an_add_on_that_reuses_uv():
    a = addons.BY_KEY["reddit"]
    assert a.custom and any(isinstance(p, addons.Archive) and p.dest == "uv" for p in a.parts)
    assert addons.size_of(a) > addons.size_of(addons.BY_KEY["warc2zim"]) - addons.WARC2ZIM_EXTRA


def test_a_frozen_app_without_the_reddit_maker_is_told_where_to_add_it(home, monkeypatch):
    """No Python of its own to build with: under Ask first the job is refused with the add-on's address, not a pip error."""
    from zimi import reddot
    from zimi.creator import CreateError

    monkeypatch.setattr(reddot, "_has_python", lambda: False)
    monkeypatch.setattr(reddot, "sidecar_status", lambda: {"installed": False, "current": False, "dir": str(home)})
    monkeypatch.setattr(reddot, "_is_offline", lambda: False)
    addons.POLICY.set("ask")
    with pytest.raises(CreateError, match=r"Settings > Server > Add-ons \(reddit\)"):
        reddot.ensure_sidecar()


def test_the_frozen_apps_keep_the_stdlib_modules_the_add_ons_import():
    """yt-dlp died in the frozen app on `optparse`: the specs add this list as hidden imports."""
    from zimi import addon_wheels as w

    assert "optparse" in w.FROZEN_STDLIB
    # annotationlib is new in Python 3.14 (the frozen apps' Python); an older test Python does not list it.
    newer = {"annotationlib"}
    assert all(m.split(".")[0] in sys.stdlib_module_names or m in newer for m in w.FROZEN_STDLIB)
    for spec in ("zimi_desktop.spec", "zimi_portable.spec"):
        text = open(os.path.join(REPO, "desktop", spec), encoding="utf-8").read()
        assert "FROZEN_STDLIB" in text, spec


@pytest.mark.skipif(os.name == "nt", reason="the fake tool is a shell script; Windows finds only PATHEXT programs")
def test_an_add_ons_tools_come_before_the_machines_own_on_the_path(home, served, monkeypatch, tmp_path):
    """A machine's older Node would have run single-file-cli (CloseEvent is not defined, found on a Mac): the pinned
    one the add-on brought goes first."""
    base, files = served
    files["tool.tgz"] = PAYLOAD
    older = tmp_path / "older"
    older.mkdir()
    (older / "zimi-fake-tool").write_text("#!/bin/sh\\necho older\\n", encoding="utf-8")
    (older / "zimi-fake-tool").chmod(0o755)
    monkeypatch.setenv("PATH", str(older) + os.pathsep + os.environ.get("PATH", ""))
    _register(monkeypatch, _fake(base + "tool.tgz", PAYLOAD))
    addons.POLICY.set("ask")
    assert addons.install("fake") == (True, None)
    _wait()
    import shutil

    assert shutil.which("zimi-fake-tool") == str(home / "addons" / "fake" / "tool" / "bin" / "zimi-fake-tool")


def test_an_add_on_reads_ready_only_once_its_install_has_finished(home, served, monkeypatch):
    """Ready while its check still ran made "Get everything" start the next one into a Busy refusal (found in the
    frozen app on Apple silicon, where the browser's launch check takes seconds)."""
    base, files = served
    files["tool.tgz"] = PAYLOAD
    gate = threading.Event()
    seen = []
    arc = addons.Archive("tool", 1, {"x64": (base + "tool.tgz", hashlib.sha256(PAYLOAD).hexdigest(), len(PAYLOAD))})
    fake = addons.Addon("fake", "1", (arc,), ("tool/bin",), (), {}, (), lambda: False, lambda root: (seen.append(addons.status()["addons"][0]["ready"]), gate.wait(2)), None)
    _register(monkeypatch, fake)
    addons.POLICY.set("ask")
    assert addons.install("fake") == (True, None)
    for _ in range(300):
        if seen:
            break
        threading.Event().wait(0.02)
    assert seen == [False], "the add-on is on disk and answers, yet not ready while its check runs"
    gate.set()
    _wait()
    assert addons.status()["addons"][0]["ready"] is True


def test_an_add_on_being_installed_for_another_is_not_removed_and_installs_do_not_overlap(home, served, monkeypatch):
    """Remove on a dependency mid-install deleted the files the dependent's install was about to build on; and two
    installs of one add-on (a job's ensure() beside the Add button) shared one .partial folder."""
    base, files = served
    files["tool.tgz"] = PAYLOAD
    sha = hashlib.sha256(PAYLOAD).hexdigest()
    arc = addons.Archive("tool", 1, {"x64": (base + "tool.tgz", sha, len(PAYLOAD))})
    dep = addons.Addon("dep", "1", (arc,), ("tool/bin",), (), {}, (), lambda: False, None, None)
    gate = threading.Event()
    inside = []
    top = addons.Addon("top", "1", (arc,), ("tool/bin",), (), {}, ("dep",), lambda: False, lambda root: (inside.append(1), gate.wait(2)), None)
    monkeypatch.setattr(addons, "ADDONS", (dep, top))
    monkeypatch.setattr(addons, "BY_KEY", {"dep": dep, "top": top})
    addons.POLICY.set("ask")
    assert addons.install("top") == (True, None)
    for _ in range(300):
        if inside:
            break
        threading.Event().wait(0.02)
    assert os.path.isdir(addons.folder("dep"))
    assert addons.remove("dep") is False and os.path.isdir(addons.folder("dep"))
    assert addons._install_serial.locked()
    gate.set()
    _wait()
    assert addons.remove("dep") is True


@pytest.mark.skipif(os.name == "nt", reason="POSIX modes")
def test_unpacked_files_are_never_open_to_others(tmp_path):
    p = tmp_path / "a.zip"
    with zipfile.ZipFile(p, "w") as z:
        for name, mode in (("top/tool", 0o777), ("top/data", 0o644), ("top/odd", 0)):
            info = zipfile.ZipInfo(name)
            info.external_attr = mode << 16
            z.writestr(info, b"x")
    addons._unpack(str(p), str(tmp_path / "out"), 1)
    for name in ("tool", "data", "odd"):
        assert os.stat(tmp_path / "out" / name).st_mode & 0o007 == 0
    assert os.access(tmp_path / "out" / "tool", os.X_OK)
    assert os.access(tmp_path / "out" / "data", os.R_OK)


def test_an_add_on_folder_cannot_leave_the_add_ons_folder(home):
    with pytest.raises(ValueError):
        addons.folder("../outside")
    assert addons.folder("piper").startswith(addons.root())
