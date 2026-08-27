"""The alive capture engine — `--engine alive`, and the Alive option.

Three layers, and the split is the same one the rendered engine's tests use
because the reasons are the same.

  * Everything above the browser runs ALWAYS: the engine registry, the two
    refusals (a missing half, a shape this engine does not do), the web form's
    gate, the convert phase the job log derives, and the exact warc2zim command
    line — driven with a fake sidecar, no Chromium and no subprocess anywhere
    near them.

  * The RECORDING tests need a real browser and skip without one. They drive a
    local fixture site whose content only exists after JavaScript runs, and
    they assert the thing that distinguishes this engine from the rendered one:
    that the archive holds the ORIGINAL document bytes as served, the scripts,
    and the XHR responses that fired while the page settled. A recording
    missing any of those replays as a spinner.

  * The CONVERSION test needs the warc2zim sidecar too, and skips without it.
    It is the only test here that produces a real ZIM, and it is the only one
    that can answer whether the pipeline actually works end to end.

Nothing here reaches the real network.
"""

import http.server
import json
import os
import sys
import threading

import pytest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO_ROOT)

import zimi.alive as alive  # noqa: E402
import zimi.creator as creator  # noqa: E402
import zimi.importer as importer  # noqa: E402
import zimi.manage as manage  # noqa: E402
import zimi.renderer as renderer  # noqa: E402
from zimi.warc import read_records  # noqa: E402

HOST = "127.0.0.1"


@pytest.fixture(autouse=True)
def _online(monkeypatch):
    monkeypatch.delenv("ZIMI_OFFLINE", raising=False)


# ── the engine registry and its refusals ────────────────────────────────────


def test_the_engines_the_web_offers_are_the_engines_that_exist():
    assert manage.CREATE_ENGINES == creator.OFFERED_ENGINES
    assert "alive" in creator.CAPTURE_ENGINES
    assert creator.ARCHIVE_ENGINES == ("alive", "zimit")


def test_offered_and_buildable_are_different_sets_on_purpose():
    """zimit is the whole reason there are two names. It is a real choice a
    person can make and it never becomes a capture object — so anything that
    reads one tuple expecting the other's meaning is a bug, and these two
    memberships are the assertion that keeps them apart."""
    assert "zimit" in creator.OFFERED_ENGINES
    assert "zimit" not in creator.CAPTURE_ENGINES
    # Everything buildable is also offerable. The reverse is what varies.
    assert set(creator.CAPTURE_ENGINES) <= set(creator.OFFERED_ENGINES)


def test_the_engine_a_person_asked_for_is_the_engine_that_runs(monkeypatch):
    """The defect this exists for: alive and zimit both write their own ZIM,
    both were therefore tested with one ``in ARCHIVE_ENGINES`` check, and that
    check dispatched BOTH to the alive engine. Asking for zimit ran alive and
    said nothing — a capture that succeeds with the wrong tool leaves no
    evidence anywhere a user would look, because the ZIM it produces is real.

    Membership in a set is not a routing decision. One assertion per engine."""
    ran = []
    monkeypatch.setattr(
        "zimi.crawler.create_zimit_zim",
        lambda url, **kw: ran.append(("zimit", url)) or {"pages": None},
    )
    monkeypatch.setattr(
        "zimi.alive.create_alive_page_zim",
        lambda url, **kw: ran.append(("alive", url)) or {"pages": 1},
    )
    for asked in ("zimit", "alive"):
        ran.clear()
        creator.create_page_zim("https://example.com/", engine=asked)
        assert [who for who, _ in ran] == [
            asked
        ], f"asked for {asked} and {ran[0][0] if ran else 'nothing'} ran"


def test_the_alive_engine_says_which_half_is_missing(monkeypatch):
    """Two independent installs, two different commands to fix them. A
    refusal that said only "not available" would be a dead end."""
    monkeypatch.setattr(alive, "_browser_here", lambda refresh=False: False)
    monkeypatch.setattr(alive, "_sidecar_here", lambda: True)
    with pytest.raises(creator.CreateError) as caught:
        alive.require_alive()
    assert "playwright install chromium" in str(caught.value)
    assert "zimi import --setup" not in str(caught.value)

    monkeypatch.setattr(alive, "_browser_here", lambda refresh=False: True)
    monkeypatch.setattr(alive, "_sidecar_here", lambda: False)
    with pytest.raises(creator.CreateError) as caught:
        alive.require_alive()
    assert "zimi import --setup" in str(caught.value)
    assert "playwright install chromium" not in str(caught.value)


def test_both_halves_present_is_not_a_refusal(monkeypatch):
    monkeypatch.setattr(alive, "_browser_here", lambda refresh=False: True)
    monkeypatch.setattr(alive, "_sidecar_here", lambda: True)
    alive.require_alive()
    assert alive.alive_status() == (True, ())


def test_the_status_names_both_missing_halves(monkeypatch):
    monkeypatch.setattr(alive, "_browser_here", lambda refresh=False: False)
    monkeypatch.setattr(alive, "_sidecar_here", lambda: False)
    assert alive.alive_status() == (False, ("browser", "sidecar"))


def test_the_refusal_lands_before_any_capture_work(monkeypatch):
    """The rule the whole ordering exists for: an engine that crawls for twenty
    minutes and only then finds it cannot convert has wasted an afternoon and
    somebody else's bandwidth."""
    monkeypatch.setattr(alive, "_sidecar_here", lambda: False)
    monkeypatch.setattr(alive, "_browser_here", lambda refresh=False: True)

    def never(*_a, **_kw):
        raise AssertionError("a browser was started before the refusal")

    monkeypatch.setattr(alive, "AliveCapture", never)
    for entry in (alive.create_alive_page_zim, alive.create_alive_site_zim):
        with pytest.raises(creator.CreateError, match="zimi import --setup"):
            entry("https://example.com/")


def test_a_list_of_pages_is_refused_rather_than_quietly_wrong(monkeypatch):
    """This shape's product is a Zimi-authored cover page linking captured
    articles. An alive capture has no articles to link — warc2zim writes the
    ZIM and its entries are URLs."""
    with pytest.raises(creator.CreateError, match="one page or one site"):
        creator.create_pages_zim(["https://e.com/a", "https://e.com/b"], engine="alive")


def test_offline_refuses_before_the_engine_is_asked_for(monkeypatch):
    monkeypatch.setenv("ZIMI_OFFLINE", "1")
    for entry in (alive.create_alive_page_zim, alive.create_alive_site_zim):
        with pytest.raises(creator.CreateError, match="ZIMI_OFFLINE"):
            entry("https://example.com/")


def test_a_url_that_is_not_http_is_refused(monkeypatch):
    monkeypatch.setattr(alive, "_browser_here", lambda refresh=False: True)
    monkeypatch.setattr(alive, "_sidecar_here", lambda: True)
    with pytest.raises(creator.CreateError, match="not an http"):
        alive.create_alive_page_zim("file:///etc/passwd")


# ── the web form's gate ─────────────────────────────────────────────────────


def test_the_form_accepts_alive_only_when_both_halves_are_here(monkeypatch):
    monkeypatch.setattr(manage, "_create_alive_ready", lambda: False)
    with pytest.raises(ValueError, match="browser and the warc2zim sidecar"):
        manage._create_validate(
            {"mode": "site", "source": "https://e.com/", "engine": "alive"}
        )
    monkeypatch.setattr(manage, "_create_alive_ready", lambda: True)
    _mode, _source, _title, opts = manage._create_validate(
        {"mode": "site", "source": "https://e.com/", "engine": "alive"}
    )
    assert opts["engine"] == "alive"


def test_the_probe_reports_the_alive_engine_on_its_own(monkeypatch):
    """Its own answer, not one the client computes from the other two: what the
    alive engine needs is the server's business, and a client that inferred it
    would need updating the day that changes."""
    monkeypatch.setattr(manage, "_create_alive_ready", lambda: True)
    monkeypatch.setattr(manage, "_create_browser_ready", lambda: False)
    payload = manage._create_status(0, probe=True)
    assert payload["alive_ready"] is True
    assert payload["browser_ready"] is False
    assert "alive_ready" not in manage._create_status(0)


def test_an_application_shell_is_what_the_alive_engine_is_for(monkeypatch):
    shell = b"<html><head><title>App</title></head><body><div id=root></div>"
    shell += b"<script src='/b.js'></script></body></html>"
    monkeypatch.setattr(
        "zimi.creator._fetch_page",
        lambda url, **kw: (url, shell, "text/html", ""),
    )
    probe = manage._probe_url("https://e.com/app", engine="alive")
    assert probe["ok"] is True
    assert probe["warning_key"] is None
    assert probe["note_key"] == "create_note_spa_alive"


def test_the_convert_phase_is_derived_from_the_line_the_sidecar_prints():
    """Both doors into warc2zim say the same thing, so one rule reads both."""
    job = manage._CreateJob("import", "x.warc.gz", None)
    events, phase = manage._create_derive(job, "converting x.warc.gz with warc2zim…")
    assert phase == "convert"
    assert events[0] == {"t": "phase", "phase": "convert", "detail": "import"}


def test_the_convert_phase_is_one_the_client_knows():
    assert "convert" in manage.CREATE_PHASES
    with open(os.path.join(REPO_ROOT, "zimi", "static", "create.js")) as fh:
        assert "convert: 2" in fh.read()


# ── the sidecar contract ────────────────────────────────────────────────────


class _FakeSidecar:
    """warc2zim, without warc2zim: records the command line and writes a file
    where the real one would."""

    def __init__(self, tmp_path, *, fail=False, produce=True):
        self.exe = str(tmp_path / "warc2zim")
        self.cmds = []
        self.fail = fail
        self.produce = produce

    def install(self, monkeypatch):
        monkeypatch.setattr(importer, "ensure_sidecar", lambda sink=None: self.exe)
        monkeypatch.setattr(importer, "_supports_flag", lambda exe, flag: True)
        monkeypatch.setattr(importer, "_run_stream", self._run)
        # And it counts as installed, so the alive engine's up-front refusal
        # sees what this fake is standing in for. Without this the tests below
        # would only pass on a machine that already had the real sidecar, which
        # is the opposite of what a fake is for.
        monkeypatch.setattr(alive, "_sidecar_here", lambda: True)
        return self

    def _run(self, cmd, sink):
        self.cmds.append(list(cmd))
        sink("warc2zim: working")
        if self.fail:
            return 3
        if self.produce:
            out = os.path.join(self.flag(cmd, "--output"), self.flag(cmd, "--zim-file"))
            with open(out, "wb") as fh:
                fh.write(b"not really a zim")
        return 0

    @staticmethod
    def flag(cmd, name):
        return cmd[cmd.index(name) + 1]


def test_the_conversion_sends_warc2zim_what_it_needs(tmp_path, monkeypatch):
    sidecar = _FakeSidecar(tmp_path).install(monkeypatch)
    out = str(tmp_path / "site.zim")
    importer.convert_archive(
        str(tmp_path / "rec.warc.gz"),
        out,
        zim_name="example.com_en",
        title="Example",
        description="A site",
        main_url="https://example.com/",
        language="eng",
        tags="zimi:alive",
        creator_name="Zimi",
        source="https://example.com/",
    )
    cmd = sidecar.cmds[0]
    assert cmd[0] == sidecar.exe
    assert sidecar.flag(cmd, "--name") == "example.com_en"
    assert sidecar.flag(cmd, "--zim-file") == "site.zim"
    # The main page, told rather than guessed: without it warc2zim takes the
    # first text/html record it meets, which for a crawl is the seed by luck.
    assert sidecar.flag(cmd, "--url") == "https://example.com/"
    assert sidecar.flag(cmd, "--lang") == "eng"
    assert sidecar.flag(cmd, "--title") == "Example"
    assert sidecar.flag(cmd, "--tags") == "zimi:alive"
    assert "Zimi" in sidecar.flag(cmd, importer.SCRAPER_SUFFIX_FLAG)
    assert os.path.exists(out)


def test_the_import_command_line_did_not_change(tmp_path, monkeypatch):
    """`zimi import` gained a lower-level function underneath it and must not
    have gained a flag: the fields the alive engine sends are the ones it asks
    for, and an import asks for none of them."""
    sidecar = _FakeSidecar(tmp_path).install(monkeypatch)
    archive = tmp_path / "a.warc.gz"
    archive.write_bytes(b"x")
    importer.import_archive(str(archive), out_dir=str(tmp_path))
    cmd = sidecar.cmds[0]
    for absent in ("--url", "--lang", "--tags", "--creator", "--source"):
        assert absent not in cmd
    assert sidecar.flag(cmd, "--name") == "a"


def test_a_failed_conversion_leaves_nothing_under_the_final_name(tmp_path, monkeypatch):
    _FakeSidecar(tmp_path, fail=True).install(monkeypatch)
    out = str(tmp_path / "site.zim")
    with pytest.raises(creator.CreateError, match="exit 3"):
        importer.convert_archive(str(tmp_path / "rec.warc.gz"), out, zim_name="x")
    assert not os.path.exists(out)


def test_a_conversion_that_produced_nothing_is_a_failure(tmp_path, monkeypatch):
    _FakeSidecar(tmp_path, produce=False).install(monkeypatch)
    with pytest.raises(creator.CreateError, match="produced no ZIM"):
        importer.convert_archive(
            str(tmp_path / "rec.warc.gz"), str(tmp_path / "s.zim"), zim_name="x"
        )


# ── recording, with a real browser ──────────────────────────────────────────

browser = pytest.mark.skipif(
    not renderer.browser_available(),
    reason="playwright + chromium are not installed here",
)

# A page that is EMPTY until JavaScript runs, and that fetches its own text
# with XHR after load. Both are things the fast engine cannot see and the
# rendered engine keeps only the finished picture of.
INDEX = """<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<title>Alive fixture</title><link rel="stylesheet" href="/s.css"></head>
<body><div id="app">LOADING</div><a href="/second.html">second</a>
<script src="/app.js"></script></body></html>"""

APP_JS = """
fetch('/data.json').then(function(r) { return r.json(); }).then(function(d) {
  document.getElementById('app').innerHTML =
    '<h1>' + d.heading + '</h1><p>' + d.body + '</p>';
});
"""

SECOND = """<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<title>Second</title></head><body><h1>Second page</h1></body></html>"""

# A page shaped like every modern one: the same picture at several sizes, and
# the browser asking for exactly ONE of them. At the capture viewport (1280
# wide, 1x) it takes hero.png and nothing else — the 2x candidates are for a
# denser screen, the <picture> source is behind a media query no desktop
# viewport matches, and the CSS background's 2x form is chosen by pixel ratio.
# Every one of those is a request a replay WILL make on somebody else's screen.
VARIANTS = """<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<title>Variants</title><link rel="stylesheet" href="/v.css"></head>
<body><h1>Variants</h1>
<img src="/img/hero.png" srcset="/img/hero.png 1x, /img/hero_2x.png 2x" alt="hero">
<picture>
  <source media="(min-width: 3000px)"
          srcset="/img/wide.png 1x, /img/wide_2x.png 2x">
  <img src="/img/hero.png" alt="wide">
</picture>
<div class="tile"></div>
</body></html>"""

VARIANTS_CSS = b""".tile { width: 40px; height: 40px;
  background-image: image-set(url(/img/bg.png) 1x, url(/img/bg_2x.png) 2x); }"""

PNG = (
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
    b"\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\nIDATx\x9cc\x00\x01"
    b"\x00\x00\x05\x00\x01\r\n-\xb4\x00\x00\x00\x00IEND\xaeB`\x82"
)
# Each variant is its OWN bytes, because a WARC stores identical payloads once
# and a test that shipped six copies of the same PNG would pass on a revisit
# record instead of on the file it claims to be checking.
VARIANT_IMAGES = (
    "hero.png",
    "hero_2x.png",
    "wide.png",
    "wide_2x.png",
    "bg.png",
    "bg_2x.png",
)

ROUTES = {
    "/": ("text/html; charset=utf-8", INDEX.encode()),
    "/second.html": ("text/html; charset=utf-8", SECOND.encode()),
    "/app.js": ("application/javascript", APP_JS.encode()),
    "/data.json": (
        "application/json",
        json.dumps(
            {"heading": "Arrived by fetch", "body": "Only JS knows this"}
        ).encode(),
    ),
    "/s.css": ("text/css", b"body{background:#fff}"),
    "/robots.txt": ("text/plain", b"User-agent: *\nAllow: /\n"),
    "/variants.html": ("text/html; charset=utf-8", VARIANTS.encode()),
    "/v.css": ("text/css", VARIANTS_CSS),
}
ROUTES.update(
    {
        f"/img/{name}": ("image/png", PNG + b"\x00" * (n + 1))
        for n, name in enumerate(VARIANT_IMAGES)
    }
)


@pytest.fixture(scope="module")
def fixture_site():
    """An ephemeral port, so two suites running at once never collide."""

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            route = ROUTES.get(self.path.split("?", 1)[0])
            if route is None:
                self.send_error(404)
                return
            ctype, body = route
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_a):
            pass

    srv = http.server.ThreadingHTTPServer((HOST, 0), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        yield f"http://{HOST}:{srv.server_address[1]}"
    finally:
        srv.shutdown()
        srv.server_close()


def _recorded(path):
    """``{url: record}`` for the response records in an archive."""
    return {r.url: r for r in read_records(path) if r.type == "response"}


@browser
def test_the_recording_holds_the_document_as_the_server_sent_it(fixture_site, tmp_path):
    """THE distinguishing property. The rendered engine stores the serialized
    DOM; replay needs the real document, because the scripts are going to run
    again and rebuild it themselves."""
    capture = alive.AliveCapture(work_dir=str(tmp_path), extra_wait=0.5)
    try:
        capture.fetch(fixture_site + "/")
    finally:
        capture.close()
    stored = _recorded(capture.warc_path)[fixture_site + "/"].payload()
    assert stored == INDEX.encode()
    # And that is NOT what the rendered engine would have kept: the served
    # bytes still say LOADING, because at the moment they were sent they did.
    assert b"LOADING" in stored
    assert b"Arrived by fetch" not in stored


@browser
def test_the_scripts_and_what_they_fetched_are_all_in_the_archive(
    fixture_site, tmp_path
):
    """Strip the JavaScript and the XHR it fired and what is left replays as a
    spinner. The snapshot engine drops both on purpose; this one must not."""
    capture = alive.AliveCapture(work_dir=str(tmp_path), extra_wait=0.5)
    try:
        capture.fetch(fixture_site + "/")
    finally:
        capture.close()
    stored = _recorded(capture.warc_path)
    for path in ("/", "/app.js", "/data.json", "/s.css"):
        assert fixture_site + path in stored, f"{path} is not in the archive"
    assert b"Arrived by fetch" in stored[fixture_site + "/data.json"].payload()
    assert b"fetch('/data.json')" in stored[fixture_site + "/app.js"].payload()


@browser
def test_the_recorded_headers_survive_the_round_trip(fixture_site, tmp_path):
    capture = alive.AliveCapture(work_dir=str(tmp_path), extra_wait=0.2)
    try:
        capture.fetch(fixture_site + "/")
    finally:
        capture.close()
    stored = _recorded(capture.warc_path)
    assert stored[fixture_site + "/"].http_status() == 200
    types = stored[fixture_site + "/s.css"].http_headers()["content-type"]
    assert "text/css" in types


@browser
def test_the_fetch_returns_the_rendered_dom_for_the_crawl_to_read(
    fixture_site, tmp_path
):
    """The HTML this hands back is not what gets stored — it is what links and
    a title are read out of, and for that the rendered DOM is strictly better:
    a nav a script built is invisible in the served bytes."""
    capture = alive.AliveCapture(work_dir=str(tmp_path), extra_wait=0.5)
    try:
        _final, html, _n, _lang = capture.fetch(fixture_site + "/")
    finally:
        capture.close()
    assert "Arrived by fetch" in html


@browser
def test_the_image_sizes_the_page_did_not_choose_are_archived_too(
    fixture_site, tmp_path
):
    """The defect this exists for: a recording holds ONE candidate per srcset —
    the one this viewport and this pixel ratio picked — and every other screen
    then asks the replay for a file it never saw. Measured on apple.com, which
    came up with holes in it on a 2x display."""
    capture = alive.AliveCapture(work_dir=str(tmp_path), extra_wait=0.3)
    try:
        capture.fetch(fixture_site + "/variants.html")
    finally:
        capture.close()
    stored = _recorded(capture.warc_path)
    for name in VARIANT_IMAGES:
        assert fixture_site + "/img/" + name in stored, f"{name} is not in the archive"
    # And each one is its own file, not a stand-in for the one before it.
    assert (
        stored[fixture_site + "/img/hero_2x.png"].payload()
        == ROUTES["/img/hero_2x.png"][1]
    )


@browser
def test_the_variant_sweep_has_a_ceiling(fixture_site, tmp_path, monkeypatch):
    """Bounded, and bounded where a person can see it. Zero is the honest
    extreme of the same setting: the traffic is still recorded, and nothing
    beyond it is."""
    monkeypatch.setattr(renderer, "ALIVE_MAX_VARIANTS", 0)
    capture = alive.AliveCapture(work_dir=str(tmp_path), extra_wait=0.3)
    try:
        capture.fetch(fixture_site + "/variants.html")
    finally:
        capture.close()
    stored = _recorded(capture.warc_path)
    assert fixture_site + "/img/hero.png" in stored  # the browser asked for it
    assert fixture_site + "/img/hero_2x.png" not in stored  # the sweep did not


@browser
def test_the_variant_sweep_spends_the_crawls_byte_budget(fixture_site, tmp_path):
    """A site crawl's ceiling is one number for the whole job, and an image
    fetched deliberately costs the same as one that arrived on its own."""
    from zimi.crawler import ByteBudget

    budget = ByteBudget(1024 * 1024)
    capture = alive.AliveCapture(work_dir=str(tmp_path), budget=budget, extra_wait=0.3)
    try:
        capture.fetch(fixture_site + "/variants.html")
    finally:
        capture.close()
    stored = _recorded(capture.warc_path)
    swept = sum(
        len(stored[fixture_site + "/img/" + n].payload())
        for n in VARIANT_IMAGES
        if fixture_site + "/img/" + n in stored
    )
    assert swept > 0
    assert budget.used >= swept


@browser
def test_a_page_recording_writes_a_readable_archive(fixture_site, tmp_path):
    """The strict reader over a real recording: whatever a live browser threw
    at the writer, the result is still the format."""
    capture = alive.AliveCapture(work_dir=str(tmp_path), extra_wait=0.2)
    try:
        capture.fetch(fixture_site + "/")
    finally:
        capture.close()
    records = read_records(capture.warc_path)  # raises WarcFormatError if not
    assert records[0].type == "warcinfo"
    assert sum(1 for r in records if r.type == "request") == sum(
        1 for r in records if r.type in ("response", "revisit")
    )


@browser
def test_a_crawl_records_every_page_into_one_archive(
    fixture_site, tmp_path, monkeypatch
):
    """Site mode: one archive, the existing frontier, and the conversion
    replaced with a fake so this test needs no sidecar."""
    sidecar = _FakeSidecar(tmp_path).install(monkeypatch)
    seen = {}

    def watch(archive, out, **kw):
        seen["archive"] = archive
        seen["urls"] = {r.url for r in read_records(archive) if r.type == "response"}
        return real_convert(archive, out, **kw)

    real_convert = importer.convert_archive
    monkeypatch.setattr(importer, "convert_archive", watch)
    info = alive.create_alive_site_zim(
        fixture_site + "/",
        out_dir=str(tmp_path),
        max_pages=5,
        delay=0,
        extra_wait=0.2,
    )
    assert info["engine"] == "alive"
    assert info["pages"] == 2
    # Both pages AND the subresources of both, in the one archive.
    assert fixture_site + "/" in seen["urls"]
    assert fixture_site + "/second.html" in seen["urls"]
    assert fixture_site + "/app.js" in seen["urls"]
    assert sidecar.flag(sidecar.cmds[0], "--url") == fixture_site + "/"


@browser
def test_the_archive_is_gone_when_the_capture_is_over(
    fixture_site, tmp_path, monkeypatch
):
    """A recording is scaffolding. Leaving a multi-hundred-megabyte WARC beside
    every ZIM would be a capture that quietly doubles its own cost."""
    _FakeSidecar(tmp_path).install(monkeypatch)
    info = alive.create_alive_page_zim(
        fixture_site + "/", out_dir=str(tmp_path), extra_wait=0.2
    )
    assert os.path.exists(info["path"])
    leftovers = [n for n in os.listdir(tmp_path) if n.endswith(".warc.gz")]
    assert leftovers == []


@browser
def test_a_refused_capture_leaves_no_archive_either(
    fixture_site, tmp_path, monkeypatch
):
    _FakeSidecar(tmp_path, fail=True).install(monkeypatch)
    with pytest.raises(creator.CreateError):
        alive.create_alive_page_zim(
            fixture_site + "/", out_dir=str(tmp_path), extra_wait=0.2
        )
    assert [n for n in os.listdir(tmp_path) if n.endswith(".warc.gz")] == []


@browser
def test_the_cli_engine_reaches_the_alive_path(fixture_site, tmp_path, monkeypatch):
    """`--engine alive` on a single URL must not fall through to the Creator
    path — the dispatch is what keeps the two shapes apart."""
    _FakeSidecar(tmp_path).install(monkeypatch)
    info = creator.create_page_zim(
        fixture_site + "/", out_dir=str(tmp_path), engine="alive"
    )
    assert info["engine"] == "alive"
    assert info["main"] is None  # warc2zim decides that, not Zimi


# ── the whole pipeline, with the real sidecar ───────────────────────────────

sidecar_here = pytest.mark.skipif(
    not importer.sidecar_status().get("installed"),
    reason="the warc2zim sidecar is not installed here",
)


@browser
@sidecar_here
def test_a_real_alive_capture_becomes_a_real_zim(fixture_site, tmp_path):
    """The only test that answers the actual question. Record a page whose
    content exists only after a fetch resolves, convert it with the real
    warc2zim, and confirm the ZIM holds the script and the data — the two
    things replay needs and the two things every other engine drops."""
    from libzim.reader import Archive

    info = alive.create_alive_page_zim(
        fixture_site + "/", out_dir=str(tmp_path), extra_wait=1.0
    )
    archive = Archive(info["path"])
    paths = {archive._get_entry_by_id(i).path for i in range(archive.all_entry_count)}
    # warc2zim's ZIM paths are the URLs with the port dropped, which is its
    # normalisation and not something Zimi chooses.
    host = fixture_site.split("//", 1)[1].split(":")[0]
    assert f"{host}/app.js" in paths
    assert f"{host}/data.json" in paths
    # The document that ships is the one the server sent, not a serialized DOM.
    served = bytes(archive.get_entry_by_path(f"{host}/").get_item().content).decode(
        "utf-8", "replace"
    )
    assert "app.js" in served


# ── what capturing apple.com taught the recorder ────────────────────────────
#
# Both of these are regressions in waiting rather than hypotheticals: each one
# was found by capturing https://www.apple.com and watching the result fail in
# Zimi's own reader, and each cost the capture its videos.


def test_a_response_with_no_content_type_gets_one_from_its_url():
    """apple.com's CDN serves the homepage hero videos with NO Content-Type at
    all — a live browser sniffs the container and does not need to be told. A
    ZIM entry cannot sniff: without this the file lands as
    application/octet-stream and no <video> element will touch it."""
    filled = renderer._typed({"Server": "Apple"}, "https://e.com/a/hero.webm")
    assert filled["Content-Type"] == "video/webm"


def test_a_content_type_the_server_did_send_is_never_overwritten():
    """The line this must not cross. Recorded headers are evidence; an archive
    that improves on what a site said replays something the site never sent."""
    said = {"content-type": "text/plain"}
    assert renderer._typed(said, "https://e.com/a/thing.webm") is said


def test_a_url_with_nothing_to_guess_from_is_left_alone():
    headers = {"Server": "x"}
    assert renderer._typed(headers, "https://e.com/api/v2/query?x=1") is headers


@browser
def test_a_video_is_archived_whole_rather_than_as_the_ranges_it_arrived_in(
    tmp_path,
):
    """THE apple.com bug, pinned.

    A browser never fetches a video in one piece: it opens a range, and the
    first of those ranges is a probe it usually abandons with an EMPTY body.
    Archiving the ranges put that empty probe in the ZIM as the entry for the
    URL — warc2zim skipped it as zero-length, discarded every real slice after
    it as a duplicate, and the video 404'd on replay while the archive swore it
    held it. So no range is ever archived; the file is re-fetched whole."""
    body = os.urandom(48_000)

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path == "/":
                page = (
                    b"<!DOCTYPE html><html lang=en><head><meta charset=utf-8>"
                    b"<title>V</title></head><body>"
                    b"<script>fetch('/clip.webm', "
                    b"{headers:{Range:'bytes=0-999'}});</script>"
                    b"</body></html>"
                )
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(page)))
                self.end_headers()
                self.wfile.write(page)
                return
            rng = self.headers.get("Range")
            if rng:
                # The partial, exactly as a CDN answers one.
                chunk = body[:1000]
                self.send_response(206)
                self.send_header("Content-Type", "video/webm")
                self.send_header("Content-Range", f"bytes 0-999/{len(body)}")
                self.send_header("Content-Length", str(len(chunk)))
                self.end_headers()
                self.wfile.write(chunk)
                return
            self.send_response(200)
            self.send_header("Content-Type", "video/webm")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_a):
            pass

    srv = http.server.ThreadingHTTPServer((HOST, 0), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f"http://{HOST}:{srv.server_address[1]}"
    capture = alive.AliveCapture(work_dir=str(tmp_path), extra_wait=0.5)
    try:
        capture.fetch(base + "/")
    finally:
        capture.close()
        srv.shutdown()
        srv.server_close()
    stored = _recorded(capture.warc_path)
    clip = stored.get(base + "/clip.webm")
    assert clip is not None, "the video is not in the archive at all"
    # Whole, and recorded as the 200 it is — the only form a replay can serve
    # any range out of.
    assert clip.http_status() == 200
    assert clip.payload() == body
    # And no range survived to shadow it.
    assert all(r.http_status() != 206 for r in stored.values())


def test_a_long_title_is_cut_rather_than_left_to_fail_the_conversion():
    """Measured against the real warc2zim, not read off its --help: Title over
    30 characters and Description over 80 are REFUSALS, not warnings. A title
    of 31 characters does not make a worse ZIM, it makes no ZIM — and it makes
    it after the crawl rather than before. "The Rust Programming Language —
    Official Documentation" is 53 characters, so this is the common case."""
    assert alive.MAX_ZIM_TITLE == 30
    assert alive.MAX_ZIM_DESCRIPTION == 80
    long = "The Rust Programming Language - Official Documentation"
    assert len(alive._capped(long, alive.MAX_ZIM_TITLE)) <= 30
    assert alive._capped(long, alive.MAX_ZIM_TITLE).startswith("The Rust")


def test_a_field_with_nothing_in_it_is_omitted_rather_than_sent_empty():
    assert alive._capped("", alive.MAX_ZIM_TITLE) is None
    assert alive._capped(None, alive.MAX_ZIM_DESCRIPTION, "e.com") == "e.com"


@browser
@sidecar_here
def test_a_page_whose_title_is_too_long_still_converts(fixture_site, tmp_path):
    """The end-to-end proof that the cap is in the right place: the real
    sidecar, a title no ZIM will accept, and a ZIM at the end of it."""
    info = alive.create_alive_page_zim(
        fixture_site + "/",
        out_dir=str(tmp_path),
        title="A title far longer than any ZIM metadata field will accept",
        extra_wait=0.3,
    )
    assert os.path.exists(info["path"])


@browser
@sidecar_here
def test_a_real_alive_crawl_becomes_a_real_multi_page_zim(fixture_site, tmp_path):
    """Site mode, all the way through, with nothing faked.

    The seed's links are written by a SCRIPT, so a crawl that finds the second
    page at all is a crawl reading the rendered DOM rather than the served
    bytes — and one archive holds every page plus the stylesheet they share,
    stored once because the writer dedupes on URL and digest."""
    from libzim.reader import Archive

    info = alive.create_alive_site_zim(
        fixture_site + "/",
        out_dir=str(tmp_path),
        max_pages=10,
        delay=0,
        extra_wait=0.3,
    )
    assert info["pages"] == 2  # the seed and the page its script linked to
    assert info["stopped"] is None
    archive = Archive(info["path"])
    paths = {archive._get_entry_by_id(i).path for i in range(archive.all_entry_count)}
    host = fixture_site.split("//", 1)[1].split(":")[0]
    for want in (f"{host}/", f"{host}/second.html", f"{host}/s.css", f"{host}/app.js"):
        assert want in paths, f"{want} is missing from the ZIM"
    # The seed is the main page because --url said so, not because warc2zim
    # happened to meet it first.
    assert archive.has_main_entry
    assert archive.main_entry.get_item().path == f"{host}/"


def test_every_engine_the_registry_advertises_can_actually_be_built(tmp_path):
    """``capture_engine`` is the one place a name becomes an object, and
    ``CAPTURE_ENGINES`` is what it promises to build. A registry that lists a
    name it cannot construct is a trap for whoever adds the next engine — so
    every advertised name is built here, for real.

    It caught exactly that when zimit was added to the wrong tuple, so the
    second half now checks the other direction too: every name a person may ASK
    for either builds here or has somewhere else to go."""
    for name in creator.CAPTURE_ENGINES:
        engine = creator.capture_engine(name, work_dir=str(tmp_path))
        try:
            assert engine.name == name
            # The two-call interface every caller relies on, and the flag the
            # dispatching callers read.
            assert callable(engine.fetch) and callable(engine.render)
            assert getattr(engine, "writes_archive", False) == (
                name in creator.ARCHIVE_ENGINES
            )
        finally:
            engine.close()
    # An offered name that builds nothing must be dispatched before packaging,
    # which is what ARCHIVE_ENGINES membership means. A name in neither set is
    # one the web form accepts and nothing downstream handles.
    for name in creator.OFFERED_ENGINES:
        if name in creator.CAPTURE_ENGINES:
            continue
        assert (
            name in creator.ARCHIVE_ENGINES
        ), f"{name} is offered, builds no engine, and is not dispatched away"
        # And it says so out loud rather than reporting an unknown name.
        with pytest.raises(creator.CreateError, match="does not build a capture"):
            creator.capture_engine(name, work_dir=str(tmp_path))


@browser
def test_a_303_hop_is_archived_as_a_302_the_converter_keeps(tmp_path):
    """warc2zim keeps every redirect status except 303, which it silently
    drops (verified against 2.3.1: 301/302/307/308 become redirect entries,
    303 vanishes). apple.com's shop links answer 303, so every one of them
    replayed as a missing page while the crawl swore it followed them. In a
    replay archive every request is a GET — the one distinction 303 exists to
    force — so the recorder files the hop as a 302, which carries the same
    instruction and survives conversion."""

    final = b"<html><head><title>F</title></head><body>arrived</body></html>"

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path == "/goto":
                self.send_response(303)
                self.send_header("Location", "/final")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.send_header("Content-Length", str(len(final)))
            self.end_headers()
            self.wfile.write(final)

        def log_message(self, *_a):
            pass

    srv = http.server.ThreadingHTTPServer((HOST, 0), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f"http://{HOST}:{srv.server_address[1]}"
    capture = alive.AliveCapture(work_dir=str(tmp_path), extra_wait=0.5)
    try:
        capture.fetch(base + "/goto")
    finally:
        capture.close()
        srv.shutdown()
        srv.server_close()
    records = _recorded(capture.warc_path)
    hop = records.get(base + "/goto")
    assert hop is not None, "the redirect hop never reached the archive"
    assert (
        hop.http_status() == 302
    ), f"the hop must survive warc2zim, got {hop.http_status()}"
    assert records[base + "/final"].payload() == final


def test_the_variant_sweep_says_when_it_stopped_early(tmp_path, monkeypatch):
    """A cap that is silent reads as completion.

    The sweep archives the image sizes this viewport did NOT choose, so the
    replay can answer a differently shaped screen. When it stops at its
    ceiling, the sizes it did not reach are 404s for exactly the person whose
    phone picks that width — and the run said "archived 240 image variants"
    with nothing after it, which reads as "done". CNN's front page offers close
    to four hundred candidates and hit the ceiling on every single run."""
    import zimi.renderer as renderer

    notes = []
    session = renderer.RenderedSession(work_dir=str(tmp_path))
    session._note = notes.append
    session._capture_variants = True
    session._recorder = object()  # recording, so the sweep is live
    session._context = object()  # non-None; nothing else is touched
    # Two candidates, and a ceiling of one, so the second trips the cap.
    monkeypatch.setattr(renderer, "ALIVE_MAX_VARIANTS", 1)
    monkeypatch.setattr(
        session, "_fetch_into_archive", lambda url, timeout: 10, raising=False
    )

    class _Page:
        url = "https://e.com/"

        def evaluate(self, _script, _arg=None):
            return ["https://e.com/a.jpg", "https://e.com/b.jpg"]

    try:
        session._record_variants(_Page())
    finally:
        session._recorder = None
        session._context = None
        session.close()

    assert any("stopped sweeping" in n for n in notes), notes
    assert any("not in this archive" in n for n in notes), notes
    # And it still reports what it DID archive — the cap note replaces nothing.
    assert any("archived" in n for n in notes), notes


# ── the apple.com wedge ─────────────────────────────────────────────────────
#
# A capture of apple.com sat perfectly still for the full ten-minute watchdog
# window, on a real NAS, with the WARC frozen at 4,313,574 bytes and the job
# still claiming to work. It was not the variant sweep (bounded that morning,
# and its heartbeat was verified present in the running container and silent).
# It was one call in the recording pass:
#
#     def _body(response):
#         return response.body()      # no timeout, no bound, nothing
#
# Playwright blocks there until the browser HAS that body. For a response the
# page started and never finished — a media stream, a long-poll, a range the
# player abandoned — that is not slow, it is permanent. Every other stage of a
# recording is bounded; this one was not, and it is the one it sat in.
#
# It cannot be bounded with a thread: Playwright's sync API is greenlet-bound
# to the thread that opened the connection and answers a second one with
# "cannot switch to a different thread". So the fix asks instead of waits —
# `responseEnd` is -1 until a request completes, and reading it is a dict
# lookup on an object already in hand.


def test_an_unfinished_response_is_never_waited_on():
    """The wedge, in one assertion. A body that is not there must raise rather
    than block, because blocking here costs the entire capture."""
    from zimi.renderer import _BodyStalled, _body

    class _Timing(dict):
        pass

    class _Request:
        timing = {"responseEnd": -1}  # still in flight

    class _Never:
        url = "https://example.test/stream.mp4"
        request = _Request()

        def body(self):  # pragma: no cover - reaching this IS the bug
            raise AssertionError("body() was called on an unfinished response")

    try:
        _body(_Never())
    except _BodyStalled:
        return
    raise AssertionError("an unfinished response did not raise _BodyStalled")


def test_a_finished_response_is_read_normally():
    """And the ordinary case still works — a bound that refuses everything
    would 'fix' the wedge by capturing nothing."""
    from zimi.renderer import _body

    class _Request:
        timing = {"responseEnd": 12.5}

    class _Done:
        url = "https://example.test/a.css"
        request = _Request()

        def body(self):
            return b"body{}"

    assert _body(_Done()) == b"body{}"


def test_a_response_that_cannot_say_is_read_rather_than_skipped():
    """Unknown counts as finished. Anything this cannot see keeps the old
    behaviour, so the bound never silently drops resources it could have had."""
    from zimi.renderer import _body

    class _Request:
        timing = {}

    class _Odd:
        url = "https://example.test/b.js"
        request = _Request()

        def body(self):
            return b"ok"

    assert _body(_Odd()) == b"ok"


def test_the_recording_pass_is_bounded_and_says_so():
    """The other half: the pass itself gets a clock and a voice, for the same
    reason the variant sweep did — several hundred bodies fetched one at a time
    with nothing said about it is indistinguishable from wedged, to a person
    and to the stall watchdog, whose only signal is a progress line."""
    import zimi.renderer as renderer

    assert renderer.ALIVE_RECORD_BUDGET > 0
    assert renderer.ALIVE_RECORD_HEARTBEAT < renderer.ALIVE_RECORD_BUDGET
    # The watchdog gives up at 600s of silence; a heartbeat far under that is
    # the whole point of having one.
    assert renderer.ALIVE_RECORD_HEARTBEAT <= 60


def test_a_zim_with_no_front_door_is_refused(tmp_path):
    """warc2zim picks its main page by matching ``--url`` against a URL it
    recorded. When nothing matches it does not fail: it writes a complete ZIM
    with no main entry and exits 0. Opening one shows nothing, and the job that
    made it reported success — a capture of cnn.com landed in the library that
    way while apple.com, whose URL did match, was fine.

    Checked before the staged file is moved into place, so a ZIM nobody can
    open is never registered as a successful capture."""
    from unittest import mock

    from zimi.creator import CreateError
    from zimi.importer import _require_front_door

    def archive(has_main):
        return mock.Mock(return_value=mock.Mock(has_main_entry=has_main))

    with mock.patch("libzim.reader.Archive", archive(True)):
        _require_front_door(str(tmp_path / "fine.zim"))  # passes silently

    with mock.patch("libzim.reader.Archive", archive(False)):
        with pytest.raises(CreateError) as caught:
            _require_front_door(str(tmp_path / "empty.zim"))
    assert "no main page" in str(caught.value)
    assert "open on nothing" in str(caught.value)


# The other half of the same wedge, found by converting a real cnn.com
# recording by hand: the ZIM held 341 entries — every image on the page — and
# no page. warc2zim had been handed a 200 for https://www.cnn.com/ with a body
# of zero bytes, and it discards an empty HTML record without a word, so the
# archive came out with no main entry and the job still reported success.
#
# The empty record was ours. Chromium drops large response bodies once a page
# settles; `response.body()` then raises, and `_body` answered None, which
# `_record` turned into `body = b""` and archived. apple.com's homepage is
# small enough to survive in the cache, which is the entire reason one site
# worked and the other did not.


def test_an_evicted_body_is_refetched_rather_than_archived_empty():
    """A body the browser has thrown away must not become a 200 with no bytes.

    An empty record is worse than no record: it is indistinguishable from a
    page that really is empty, and it takes the front door down with it."""
    from zimi.renderer import _BodyEvicted, _BodyStalled, _body

    class _Request:
        timing = {"responseEnd": 41.0}  # finished — asking cost nothing

    class _Evicted:
        url = "https://www.cnn.com/"
        request = _Request()

        def body(self):
            raise RuntimeError("Response body is unavailable")

    with pytest.raises(_BodyEvicted):
        _body(_Evicted())
    # And it is a stall to everyone who only cares that there are no bytes, so
    # every existing re-fetch path picks it up unchanged.
    assert issubclass(_BodyEvicted, _BodyStalled)


def test_an_eviction_does_not_count_toward_stopping_early():
    """The recording pass gives up after a run of stalls, because a run of
    stalls means a far end still streaming. An eviction answered instantly and
    says nothing about the far end, so a page whose bodies were merely dropped
    for being large must still be recorded to the end."""
    from zimi.renderer import ALIVE_MAX_BODY_STALLS, RenderedSession

    class _Request:
        timing = {"responseEnd": 3.0}
        resource_type = "image"
        method = "GET"
        all_headers = staticmethod(dict)

    class _Evicted:
        status = 200
        request = _Request()

        def __init__(self, n):
            self.url = f"https://example.test/{n}.webp"

        def body(self):
            raise RuntimeError("Response body is unavailable")

        def all_headers(self):
            return {"content-type": "image/webp"}

    written = []

    class _Recorder:
        def write_exchange(self, url, **kw):
            written.append((url, kw.get("body")))
            return "response"

    capture = RenderedSession.__new__(RenderedSession)
    capture._recorder = _Recorder()
    capture._context = None  # so the whole-file re-fetch is a no-op here
    capture._budget = None
    capture.recorded = 0
    capture._archived = set()
    capture._landed = None
    capture._note = lambda _m: None

    count = ALIVE_MAX_BODY_STALLS * 3
    capture._record([_Evicted(n) for n in range(count)])

    # Not one empty record, and the pass never stopped early: every response
    # was looked at, and every one was sent to be fetched whole instead.
    assert written == []
    assert capture.recorded == 0


def test_the_pages_own_body_survives_an_eviction():
    """Everything else can be asked for again; the document cannot — cnn.com
    answers a plain re-fetch of its homepage with something that is not the
    homepage. So the copy taken at navigation is what gets archived, and the
    ZIM has a front door."""
    from zimi.renderer import RenderedSession

    class _Request:
        timing = {"responseEnd": 1.0}
        resource_type = "document"
        method = "GET"

    class _Gone:
        url = "https://www.cnn.com/"
        status = 200
        request = _Request()

        def body(self):
            raise RuntimeError("Response body is unavailable")

        def all_headers(self):
            return {"content-type": "text/html; charset=utf-8"}

    written = []

    class _Recorder:
        def write_exchange(self, url, **kw):
            written.append((url, kw["body"]))
            return "response"

    capture = RenderedSession.__new__(RenderedSession)
    capture._recorder = _Recorder()
    capture._context = None
    capture._budget = None
    capture.recorded = 0
    capture._archived = set()
    capture._landed = ("https://www.cnn.com/", b"<html>the real page</html>")
    capture._note = lambda _m: None

    doc_bytes = capture._record([_Gone()])

    assert written == [("https://www.cnn.com/", b"<html>the real page</html>")]
    assert doc_bytes == len(b"<html>the real page</html>")
