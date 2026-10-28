"""The Almanac as a ZIM (zimi/almanacstage.py, built by zimi/ownzims.py).

The pages are the ones Zimi serves, so the stage must make them whole outside
Zimi: every app.js piece they call comes along (or the host page stands in),
no absolute /static/ URL is left, and a name that went missing fails the build
instead of shipping a page that breaks.

Run: pytest tests/test_almanac_zim.py -v
"""

import os
import re
import shutil
import subprocess

import pytest
from libzim.reader import Archive

from zimi import almanacstage as stage
from zimi import ownzims

ALMANAC = next(o for o in ownzims.OWN if o.name == "zimi_almanac")
APP_JS = os.path.join(stage.STATIC, "app.js")
HOST_HTML = os.path.join(stage.HOST, "index.html")


def _read(path):
    with open(path, encoding="utf-8") as f:
        return f.read().replace("\r\n", "\n")


@pytest.fixture(scope="module")
def staged(tmp_path_factory):
    dest = tmp_path_factory.mktemp("almanac-stage")
    stage.stage(str(dest))
    return dest


def _text_files(root):
    for dirpath, _, names in os.walk(root):
        for n in names:
            if n.endswith((".html", ".js", ".css")):
                yield os.path.join(dirpath, n)


def test_the_stage_is_a_whole_folder(staged):
    for name in (
        "index.html",
        "shell.js",
        "shell.css",
        "zimi.txt",
        "icon.png",
        "almanac.js",
        "almanac.css",
    ):
        assert (staged / name).is_file(), name
    shell = (staged / "shell.js").read_text(encoding="utf-8")
    for name in stage.SHELL_SEEDS:
        assert re.search(
            r"(?m)^(?:function|var|let|const) %s\b" % re.escape(name), shell
        ), name
    assert (staged / "i18n" / "en.json").is_file()
    assert (staged / "earth" / "stars-v1.bin").is_file()


def test_no_absolute_static_url_is_left(staged):
    bad = []
    for path in _text_files(staged):
        for m in re.finditer(
            r"""['"(=]/static/[^'")\s]*""", open(path, encoding="utf-8").read()
        ):
            bad.append((os.path.relpath(path, staged), m.group(0)))
    assert bad == []
    assert "earth/moon-v1.webp" in (staged / "shell.js").read_text(encoding="utf-8")


def test_shell_js_is_valid_javascript(staged):
    node = shutil.which("node")
    if not node:
        pytest.skip("node is not installed")
    r = subprocess.run(
        [node, "--check", str(staged / "shell.js")], capture_output=True, text=True
    )
    assert r.returncode == 0, r.stderr


def test_nothing_the_almanac_calls_is_missing():
    """The drift guard: a function or variable of app.js that the Almanac's
    files start to use must be pulled by name or stood in for by the host page,
    or the ZIM would throw a ReferenceError."""
    app, host = _read(APP_JS), _read(HOST_HTML)
    scripts = [_read(os.path.join(stage.STATIC, f)) for f in stage.SCRIPTS + stage.LAZY]
    assert (
        stage.missing_dependencies(app, scripts, host, stage.shell_source(app, host))
        == []
    )


def test_the_host_loads_what_zimi_loads_in_the_same_order():
    host = _read(HOST_HTML)
    app = _read(APP_JS)
    zimi = re.findall(
        r"'/static/([\w.-]+\.js)\?v=\d+'",
        re.search(r"var _ALMANAC_MODULES = \[(.*?)\];", app, re.S).group(1),
    )
    listed = re.search(r"var ALMANAC_SCRIPTS = \[(.*?)\];", host, re.S).group(1)
    assert re.findall(r"'([\w.-]+\.js)'", listed) == zimi
    for name in zimi:
        assert name in stage.SCRIPTS


def test_a_dynamic_import_survives_the_stage(tmp_path):
    """import("earth/three.js") is read as a module NAME and refused, so the 3D Earth said it was not downloaded
    when it was opened from the Almanac's ZIM (where the stage makes /static/ paths relative). Every import()
    in the staged pages must be given a URL, not a bare path."""
    dest = tmp_path / "stage"
    dest.mkdir()
    stage.stage(str(dest))
    calls = []
    for name in sorted(os.listdir(dest)):
        if name.endswith(".js"):
            text = _read(str(dest / name))
            calls += [(name, m.group(1)) for m in re.finditer(r"\bimport\(\s*([^)\s][^)]{0,40})", text)]
    assert any(n == "almanac-earth.js" for n, _ in calls), "the Earth loads three.js with import()"
    for name, arg in calls:
        assert arg.startswith(("new URL(", "'./", '"./', "'/", '"/', "`./", "`/")), (name, arg)


def test_a_name_app_js_lost_fails_loudly():
    app = _read(APP_JS).replace("function _smoothstep(", "function _smoothstepGone(")
    with pytest.raises(stage.StageError, match="_smoothstep"):
        stage.shell_source(app, _read(HOST_HTML))


def test_extraction_reads_one_liners_and_multiline_variables():
    src = "function a(x) { return x; }\nfunction b() {\n  return 1;\n}\nvar C = {\n  k: ';',\n  j: [1, 2],\n};\nvar D = 4;\n"
    assert stage.extract(src, "a") == "function a(x) { return x; }"
    assert stage.extract(src, "b") == "function b() {\n  return 1;\n}"
    assert stage.extract(src, "C") == "var C = {\n  k: ';',\n  j: [1, 2],\n};"
    assert stage.extract(src, "D") == "var D = 4;"


def test_a_failed_stage_builds_nothing(tmp_path, monkeypatch):
    monkeypatch.setattr(ownzims, "OUT_DIR", str(tmp_path))
    monkeypatch.setattr(stage, "SHELL_SEEDS", stage.SHELL_SEEDS + ("_noSuchThing",))
    with pytest.raises(stage.StageError):
        ownzims.build(ALMANAC)
    assert not os.listdir(tmp_path), "no ZIM, no stamp, no stage folder left"


def test_it_builds_into_a_real_zim_and_rebuilds_when_a_source_changes(
    tmp_path, monkeypatch
):
    monkeypatch.setattr(ownzims, "OUT_DIR", str(tmp_path / "data"))
    host = tmp_path / "host"
    shutil.copytree(stage.HOST, host)
    monkeypatch.setattr(stage, "HOST", str(host))
    path = ownzims.build(ALMANAC)
    a = Archive(path)
    assert a.main_entry.get_item().path == "index.html"
    assert a.get_metadata("Title").decode() == "Zimi Almanac"
    assert a.get_metadata("Creator").decode() == "Zimi"
    tags = a.get_metadata("Tags").decode().split(";")
    assert (
        "_category:other" not in tags
        and tags[0].startswith("_category:")
        and "zimi" in tags
        and ownzims.OWN_TAG in tags
    )
    assert a.has_illustration(48)
    for p in (
        "shell.js",
        "almanac.js",
        "almanac.css",
        "earth/moon-v1.webp",
        "i18n/en.json",
        "tz-borders.json",
    ):
        assert a.has_entry_by_path(p), p
    assert ownzims.build(ALMANAC) is None, "unchanged: nothing is built"
    (host / "index.html").write_text(_read(HOST_HTML) + "\n<!-- changed -->\n", encoding="utf-8")
    assert ownzims.build(ALMANAC) == path, "a changed source builds it again"
