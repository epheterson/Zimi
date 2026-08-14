"""Capture-time ad and tracker blocking — the list, the matcher, the wiring.

Four layers, none of which needs a browser:

  * PARSING. Both dialects (hosts files, bare domain lists), comments, IDN,
    the junk a real hosts file carries in the column that is not a name.
  * MATCHING. Suffix on label boundaries, which is the difference between a
    domain blocklist and a substring search, plus the allow escape hatch.
  * LOADING. The shipped snapshot, and the per-machine file that extends it.
  * WIRING. That a route handler actually aborts a blocked request and lets an
    allowed one through, driven with a fake route object — the real thing is a
    Chromium, and this assertion is about which branch runs, not about a
    browser.

The engine plumbing (CLI defaults by engine, the web form's bool) is here too,
because "blocking is on" is a claim made in four places and only one of them is
the blocker itself.
"""

import gzip
import http.server
import json
import os
import sys
import threading

import pytest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO_ROOT)

import zimi.blocklist as blocklist  # noqa: E402
import zimi.creator as creator  # noqa: E402
import zimi.manage as manage  # noqa: E402
import zimi.renderer as renderer  # noqa: E402
import zimi.server as _srv  # noqa: E402
import zimi.zimwriter as zimwriter  # noqa: E402


@pytest.fixture(autouse=True)
def _clean_caches():
    """Every test starts from an unloaded module. The loader caches on purpose
    and the cache is process-wide, so one test's override file must not be the
    next test's list."""
    blocklist.reset()
    yield
    blocklist.reset()


# ── parsing ─────────────────────────────────────────────────────────────────


def test_a_hosts_file_yields_its_names_and_not_its_addresses():
    blocked, _allowed = blocklist.parse(
        "0.0.0.0 ads.example.com\n127.0.0.1 tracker.example.net\n"
    )
    assert blocked == {"ads.example.com", "tracker.example.net"}


def test_several_names_on_one_hosts_line_all_count():
    blocked, _allowed = blocklist.parse("0.0.0.0 a.example.com b.example.com\n")
    assert blocked == {"a.example.com", "b.example.com"}


def test_a_bare_domain_list_needs_no_address_column():
    blocked, _allowed = blocklist.parse("ads.example.com\ntracker.example.net\n")
    assert blocked == {"ads.example.com", "tracker.example.net"}


def test_comments_and_blank_lines_are_not_domains():
    blocked, _allowed = blocklist.parse(
        "# a whole-line comment\n\n   \nads.example.com  # trailing comment\n"
    )
    assert blocked == {"ads.example.com"}


def test_loopback_and_broadcast_entries_are_dropped():
    """The first twenty lines of every hosts file on earth, and not one of them
    is something a capture should refuse to fetch."""
    blocked, _allowed = blocklist.parse(
        "127.0.0.1 localhost\n"
        "255.255.255.255 broadcasthost\n"
        "::1 ip6-localhost\n"
        "fe80::1%lo0 localhost\n"
        "0.0.0.0 0.0.0.0\n"
    )
    assert blocked == set()


def test_an_international_domain_is_stored_as_punycode():
    """A browser asks for the A-label, so that is what the set has to hold —
    matching the U-label would be matching a string no request ever carries."""
    blocked, _allowed = blocklist.parse("münchen.example.de\n")
    assert blocked == {"xn--mnchen-3ya.example.de"}
    assert blocklist.Blocklist(blocked).blocks("xn--mnchen-3ya.example.de")


def test_a_domain_already_in_punycode_survives_unchanged():
    blocked, _allowed = blocklist.parse("xn--mnchen-3ya.example.de\n")
    assert blocked == {"xn--mnchen-3ya.example.de"}


def test_case_and_a_trailing_dot_are_normalized_away():
    blocked, _allowed = blocklist.parse("ADS.Example.COM.\n")
    assert blocked == {"ads.example.com"}


def test_a_single_label_is_not_a_domain_this_blocks():
    blocked, _allowed = blocklist.parse("localhost\nlocal\nbroadcasthost\n")
    assert blocked == set()


def test_junk_that_is_not_a_hostname_is_dropped_rather_than_stored():
    blocked, _allowed = blocklist.parse("not a domain!\nex ample.com/path\n")
    assert "not a domain!" not in blocked
    assert all("/" not in d and " " not in d for d in blocked)


def test_normalize_domain_refuses_addresses_and_accepts_names():
    assert blocklist.normalize_domain("192.0.2.1") is None
    assert blocklist.normalize_domain("::1") is None
    assert blocklist.normalize_domain(" Ads.Example.com ") == "ads.example.com"
    assert blocklist.normalize_domain("") is None


# ── matching ────────────────────────────────────────────────────────────────


def test_a_blocked_domain_blocks_its_subdomains():
    bl = blocklist.parse_blocklist("example.com\n")
    assert bl.blocks("example.com")
    assert bl.blocks("a.example.com")
    assert bl.blocks("a.b.c.example.com")


def test_matching_is_on_label_boundaries_not_on_substrings():
    """The assertion that makes this a domain matcher. `notexample.com` shares
    a suffix with `example.com` as TEXT and shares nothing with it as a name."""
    bl = blocklist.parse_blocklist("example.com\n")
    assert not bl.blocks("notexample.com")
    assert not bl.blocks("example.com.evil.net")
    assert not bl.blocks("example.company")


def test_a_parent_domain_is_not_blocked_by_its_child():
    bl = blocklist.parse_blocklist("ads.example.com\n")
    assert bl.blocks("ads.example.com")
    assert not bl.blocks("example.com")
    assert not bl.blocks("www.example.com")


def test_a_host_is_matched_however_it_is_spelled():
    bl = blocklist.parse_blocklist("ads.example.com\n")
    assert bl.blocks("ADS.Example.com")
    assert bl.blocks("ads.example.com.")


def test_a_url_is_judged_by_its_host_alone():
    bl = blocklist.parse_blocklist("ads.example.com\n")
    assert bl.blocks_url("https://ads.example.com:8443/pixel?x=1")
    assert bl.blocks_url("http://a.ads.example.com/")
    assert not bl.blocks_url("https://example.com/ads.example.com")


def test_a_url_with_no_host_is_never_blocked():
    """data:, blob: and about: were never fetched from anywhere, so there is
    nothing to refuse and nobody to refuse it to."""
    bl = blocklist.parse_blocklist("example.com\n")
    assert not bl.blocks_url("data:text/html,<b>hi</b>")
    assert not bl.blocks_url("blob:https://example.com/1234")
    assert not bl.blocks_url("about:blank")
    assert not bl.blocks_url("")


def test_an_empty_list_blocks_nothing():
    bl = blocklist.Blocklist()
    assert not bl.blocks("ads.example.com")
    assert not bl


def test_an_allow_entry_beats_the_block_for_it_and_everything_under_it():
    bl = blocklist.parse_blocklist("example.com\n@@keep.example.com\n")
    assert bl.blocks("ads.example.com")
    assert not bl.blocks("keep.example.com")
    assert not bl.blocks("cdn.keep.example.com")


def test_a_leading_dash_is_the_other_spelling_of_allow():
    bl = blocklist.parse_blocklist("example.com\n-keep.example.com\n")
    assert not bl.blocks("keep.example.com")


# ── the shipped snapshot ────────────────────────────────────────────────────


def test_the_snapshot_ships_in_the_package():
    assert os.path.isfile(blocklist.SNAPSHOT_PATH)


def test_the_snapshot_records_its_own_provenance():
    """A blocklist with no source, date or licence in it is a blob somebody
    will be afraid to touch in a year."""
    with gzip.open(blocklist.SNAPSHOT_PATH, "rt", encoding="utf-8") as fh:
        head = fh.read(2000)
    assert "StevenBlack/hosts" in head
    assert "MIT" in head
    assert blocklist.SNAPSHOT_RETRIEVED in head


def test_the_snapshot_holds_the_domains_this_feature_exists_for():
    bl = blocklist.snapshot()
    assert len(bl) > 10000
    for domain in (
        "doubleclick.net",
        "google-analytics.com",
        "googletagmanager.com",
        "cdn.cookielaw.org",  # the consent manager cnn.com waits on
    ):
        assert bl.blocks(domain), domain


def test_the_snapshot_does_not_block_the_sites_people_capture():
    bl = blocklist.snapshot()
    for domain in ("www.cnn.com", "www.apple.com", "en.wikipedia.org", "github.com"):
        assert not bl.blocks(domain), domain


def test_no_public_suffix_is_on_the_list():
    """The one entry that would be catastrophic: a bare TLD blocks everything
    under it, correctly, and that is the whole internet."""
    bl = blocklist.snapshot()
    for suffix in ("com", "net", "org", "io", "co.uk"):
        assert not bl.blocks(suffix), suffix


def test_the_snapshot_is_parsed_once_per_process():
    first = blocklist.snapshot()
    assert blocklist.snapshot() is first


# ── the per-machine override ────────────────────────────────────────────────


def test_an_override_file_extends_the_shipped_list(tmp_path):
    (tmp_path / blocklist.OVERRIDE_NAME).write_text(
        "# my own\nads.example.test\n", encoding="utf-8"
    )
    bl = blocklist.load(str(tmp_path))
    assert bl.blocks("ads.example.test")
    assert bl.blocks("doubleclick.net")  # and the snapshot is still under it


def test_an_override_file_can_unblock_something_the_snapshot_blocks(tmp_path):
    (tmp_path / blocklist.OVERRIDE_NAME).write_text(
        "@@cdn.cookielaw.org\n", encoding="utf-8"
    )
    bl = blocklist.load(str(tmp_path))
    assert not bl.blocks("cdn.cookielaw.org")
    assert bl.blocks("doubleclick.net")


def test_no_override_file_means_the_shipped_list_exactly(tmp_path):
    assert blocklist.load(str(tmp_path)).blocked is blocklist.snapshot().blocked


def test_an_edited_override_is_picked_up_without_a_restart(tmp_path):
    path = tmp_path / blocklist.OVERRIDE_NAME
    path.write_text("one.example.test\n", encoding="utf-8")
    first = blocklist.load(str(tmp_path))
    assert first.blocks("one.example.test")
    assert not first.blocks("two.example.test")
    # A different size, so the stat-based staleness check has something to see
    # even on a filesystem with a coarse clock.
    path.write_text("one.example.test\ntwo.example.test\n", encoding="utf-8")
    second = blocklist.load(str(tmp_path))
    assert second.blocks("two.example.test")


def test_an_unreadable_override_leaves_the_capture_with_the_shipped_list(tmp_path):
    """Blocking is an improvement to a capture. A broken improvement must not
    become a broken capture."""
    path = tmp_path / blocklist.OVERRIDE_NAME
    path.write_text("ads.example.test\n", encoding="utf-8")
    os.chmod(path, 0)
    try:
        bl = blocklist.load(str(tmp_path))
    finally:
        os.chmod(path, 0o644)
    assert bl.blocks("doubleclick.net")


def test_the_summary_says_both_numbers_and_says_nothing_about_nothing():
    assert blocklist.blocked_summary(214, 37) == (
        "blocked 214 requests to 37 ad or tracker domains"
    )
    assert (
        blocklist.blocked_summary(1, 1) == "blocked 1 request to 1 ad or tracker domain"
    )
    assert blocklist.blocked_summary(0, 0) is None


# ── the route handler ───────────────────────────────────────────────────────
#
# The real one is fed by Chromium. What matters here is which branch runs for
# which host, so the route is a stand-in that records what was asked of it.


class _FakeRequest:
    def __init__(self, url):
        self.url = url


class _FakeRoute:
    def __init__(self, url):
        self.request = _FakeRequest(url)
        self.aborted = None
        self.continued = False

    def abort(self, code=None):
        self.aborted = code

    def continue_(self):
        self.continued = True


def _session(block_ads=True, domains=("ads.example.com",)):
    session = renderer.RenderedSession(work_dir=None, block_ads=block_ads)
    session._blocklist = blocklist.Blocklist(domains)
    return session


def _route(session, url):
    route = _FakeRoute(url)
    session._route(route)
    return route


def test_a_blocked_host_is_aborted_and_never_continued(tmp_path):
    session = _session()
    try:
        route = _route(session, "https://ads.example.com/pixel.gif")
        assert route.aborted == renderer.BLOCK_ABORT_CODE
        assert not route.continued
    finally:
        session.close()


def test_an_allowed_host_is_continued_and_never_aborted(tmp_path):
    session = _session()
    try:
        route = _route(session, "https://www.example.com/style.css")
        assert route.continued
        assert route.aborted is None
    finally:
        session.close()


def test_the_handler_counts_requests_and_the_domains_behind_them(tmp_path):
    session = _session(domains=("ads.example.com", "trk.example.net"))
    try:
        for url in (
            "https://ads.example.com/1.gif",
            "https://ads.example.com/2.gif",
            "https://a.trk.example.net/beacon",
            "https://www.example.com/ok.css",
        ):
            _route(session, url)
        assert session.blocked == 3
        assert session.blocked_hosts == {"ads.example.com", "a.trk.example.net"}
    finally:
        session.close()


def test_with_blocking_off_nothing_is_judged_at_all(tmp_path):
    """The handler is not installed in that case; this pins the OTHER half —
    that a session which somehow reaches it still refuses nothing."""
    session = renderer.RenderedSession(work_dir=None, block_ads=False)
    try:
        route = _route(session, "https://ads.example.com/pixel.gif")
        assert route.continued
        assert session.blocked == 0
    finally:
        session.close()


def test_a_route_that_cannot_be_read_is_still_decided(tmp_path):
    """Every arm must end with the request answered. A route left hanging is a
    page that waits for it until the navigation times out."""
    session = _session()

    class _Broken(_FakeRoute):
        @property
        def request(self):
            raise RuntimeError("gone")

        @request.setter
        def request(self, _value):
            pass

    try:
        route = _Broken("https://ads.example.com/x")
        session._route(route)
        assert route.continued
    finally:
        session.close()


def test_blocking_is_on_by_default_for_a_session(tmp_path):
    session = renderer.RenderedSession(work_dir=None)
    try:
        assert session._block_ads is renderer.BLOCK_ADS_DEFAULT is True
    finally:
        session.close()


def test_a_session_that_never_starts_never_reads_the_list(tmp_path):
    session = renderer.RenderedSession(work_dir=None)
    try:
        assert session._blocklist is None
    finally:
        session.close()


# ── option plumbing ─────────────────────────────────────────────────────────


def test_only_the_browser_engines_can_block():
    assert creator.engine_blocks_ads("rendered")
    assert creator.engine_blocks_ads("alive")
    assert not creator.engine_blocks_ads("builtin")
    assert not creator.engine_blocks_ads(None)
    assert not creator.engine_blocks_ads("zimit")


def test_the_engine_takes_the_option_it_was_given(monkeypatch):
    seen = {}

    class _Fake:
        def __init__(self, **kwargs):
            seen.update(kwargs)

    monkeypatch.setattr("zimi.renderer.RenderedCapture", _Fake)
    creator.capture_engine("rendered", block_ads=False)
    assert seen["block_ads"] is False


def test_the_cli_default_is_nobody_said(monkeypatch):
    """No flag means None, which every engine reads as its own default. That is
    what keeps the default in one place instead of four."""

    class _Args:
        block_ads = None

    assert creator._block_ads_from_args(_Args(), "rendered") is None


def test_the_cli_flag_reaches_a_browser_engine():
    class _On:
        block_ads = True

    class _Off:
        block_ads = False

    assert creator._block_ads_from_args(_On(), "alive") is True
    assert creator._block_ads_from_args(_Off(), "rendered") is False


def test_the_cli_refuses_the_flag_against_the_fast_engine():
    """Accepted-and-ignored is how somebody ends up believing their capture
    blocked the advertising when it carried every byte of it."""

    class _Args:
        block_ads = True

    with pytest.raises(creator.CreateError) as e:
        creator._block_ads_from_args(_Args(), "builtin")
    assert "rendered" in str(e.value) and "alive" in str(e.value)


def test_the_flag_is_one_of_the_capture_shaping_flags_the_cli_tracks():
    class _Args:
        block_ads = False

    state = creator._crawl_flag_state(_Args())
    assert state["--block-ads"] is True  # "the user said something about it"


def test_the_web_and_the_engines_agree_on_which_engines_block():
    assert manage.CREATE_BLOCKING_ENGINES == creator.BLOCKING_ENGINES


def test_the_web_default_matches_the_engines_default():
    assert manage.CREATE_BLOCK_ADS is renderer.BLOCK_ADS_DEFAULT


def _validated(**data):
    data.setdefault("mode", "page")
    data.setdefault("source", "https://example.com/")
    _mode, _source, _title, opts = manage._create_validate(data)
    return opts


def test_the_form_sends_a_real_bool_both_ways(monkeypatch):
    monkeypatch.setattr(manage, "_create_browser_ready", lambda: True)
    assert _validated(engine="rendered", block_ads=True)["block_ads"] is True
    assert _validated(engine="rendered", block_ads=False)["block_ads"] is False


def test_a_form_that_says_nothing_gets_the_default(monkeypatch):
    monkeypatch.setattr(manage, "_create_browser_ready", lambda: True)
    assert _validated(engine="rendered")["block_ads"] is manage.CREATE_BLOCK_ADS


def test_a_form_encoded_false_is_a_false_and_not_a_non_empty_string(monkeypatch):
    monkeypatch.setattr(manage, "_create_browser_ready", lambda: True)
    assert _validated(engine="rendered", block_ads="false")["block_ads"] is False
    assert _validated(engine="rendered", block_ads="true")["block_ads"] is True


def test_the_field_is_dropped_under_the_fast_engine():
    """Dropped rather than refused: a stale checkbox in a form somebody left
    open is not worth failing a capture over, where a typed CLI flag is."""
    assert "block_ads" not in _validated(engine="")
    assert "block_ads" not in _validated(source="https://example.com/", mode="site")


def test_the_option_reaches_the_engine_the_job_runs(monkeypatch):
    seen = {}

    def _fake_pages(urls, **kwargs):
        seen.update(kwargs)
        return {"path": "x.zim", "registered": False}

    monkeypatch.setattr("zimi.creator.create_pages_zim", _fake_pages)
    job = manage._CreateJob("page", "https://example.com/", "")
    manage._create_run(job, {"engine": "rendered", "block_ads": False})
    assert seen["block_ads"] is False


def test_the_provenance_object_names_the_list_as_well_as_the_counts():
    """Counts alone are a number nobody can reproduce. The list identity and
    the snapshot date are what make the record checkable in five years."""

    class _Capture:
        blocked = 214
        blocked_hosts = {"a.example.com", "b.example.com"}
        blocklist = None

    said = []
    got = creator.report_blocked(_Capture(), said.append)
    assert got == {
        "blocked": {
            "requests": 214,
            "domains": 2,
            "list": blocklist.SNAPSHOT_ID,
            "snapshot": blocklist.SNAPSHOT_RETRIEVED,
        }
    }
    assert said == ["blocked 214 requests to 2 ad or tracker domains"]


def test_the_list_identity_is_the_stable_name_not_a_url():
    assert blocklist.SNAPSHOT_ID == "stevenblack-hosts"
    assert blocklist.SNAPSHOT_RETRIEVED == "2026-08-14"


def test_a_locally_overridden_list_says_so_in_the_record():
    """Naming the shipped snapshot while a machine's own file was adding
    domains would be provenance that overstates its own reproducibility."""
    plain = blocklist.Blocklist({"ads.example.test"})
    local = plain.extend({"more.example.test"})
    assert "override" not in blocklist.blocked_record(3, 1, plain)
    assert blocklist.blocked_record(3, 1, local)["override"] is True
    assert blocklist.blocked_record(3, 1, None).get("override") is None


def test_an_override_file_marks_the_list_it_produces(tmp_path):
    (tmp_path / blocklist.OVERRIDE_NAME).write_text(
        "ads.example.test\n", encoding="utf-8"
    )
    assert blocklist.load(str(tmp_path)).overridden is True
    assert blocklist.snapshot().overridden is False


def test_nothing_blocked_is_no_record_rather_than_a_zero():
    """Absence is the encoding: a record with no blocked field is a capture
    where blocking did not run, and a zero would be indistinguishable."""
    assert blocklist.blocked_record(0, 0) is None
    assert blocklist.blocked_record(None, None) is None


def test_the_detail_sentence_says_what_the_object_counts():
    record = blocklist.blocked_record(214, 37)
    assert blocklist.blocked_phrase(record) == (" with 214 ad/tracker requests blocked")
    assert blocklist.blocked_phrase(blocklist.blocked_record(1, 1)) == (
        " with 1 ad/tracker request blocked"
    )
    assert blocklist.blocked_phrase(None) == ""
    assert blocklist.blocked_phrase({}) == ""


def test_the_history_record_carries_the_object_and_omits_it_when_absent():
    record = zimwriter.history_record(
        "created",
        "page",
        "captured one page",
        counts={"pages": 1},
        blocked=blocklist.blocked_record(214, 37),
    )
    assert record["blocked"]["requests"] == 214
    assert record["blocked"]["list"] == blocklist.SNAPSHOT_ID
    # The counts map stays a flat map of integers; the object lives beside it.
    assert record["counts"] == {"pages": 1}
    plain = zimwriter.history_record("created", "page", "x", counts={"pages": 1})
    assert "blocked" not in plain
    assert "blocked" not in zimwriter.history_record(
        "created", "page", "x", blocked=None
    )


def test_the_record_survives_a_json_round_trip():
    """It is written into ZIM metadata as JSON and read back by parse_history,
    which is the only form anybody will ever see it in."""
    record = zimwriter.history_record(
        "created", "page", "x", blocked=blocklist.blocked_record(5, 4)
    )
    back = zimwriter.parse_history(json.dumps([record]))
    assert back[0]["blocked"] == record["blocked"]


def test_a_capture_that_blocked_nothing_claims_nothing():
    class _Capture:
        blocked = 0
        blocked_hosts = set()

    said = []
    assert creator.report_blocked(_Capture(), said.append) == {}
    assert said == []


def test_an_engine_that_cannot_block_is_asked_the_question_safely():
    """The fast engine has no such attributes at all, and the reporting helper
    runs after every capture."""
    said = []
    assert creator.report_blocked(creator.BuiltinCapture(), said.append) == {}
    assert said == []


# ── the whole way through: capture → ZIM → metadata ─────────────────────────
#
# Everything above proves the record is BUILT right. This proves it is STORED
# right, which is a different claim and the one that matters: the provenance
# lives in a ZIM someone opens later, not in a dict a test made.
#
# It needs a real browser, so it skips where there is none — same contract as
# the browser tests in test_renderer.py.

browser = pytest.mark.skipif(
    not renderer.browser_available(),
    reason="playwright + chromium are not installed here",
)

# A domain nobody can resolve, which does not matter: the route handler aborts
# the request before it is made, so what is being tested is the refusal and not
# the network. .test is reserved by RFC 2606 for exactly this.
BLOCKED_HOST = "ads.example.test"
FIXTURE_PAGE = """<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<title>Blocking fixture</title></head><body>
<h1>A page with an advertisement on it</h1>
<p>The picture below is the only third-party thing here.</p>
<img src="http://%s/tracker.gif" alt="tracker">
<img src="http://%s/pixel.gif" alt="pixel">
</body></html>""" % (BLOCKED_HOST, BLOCKED_HOST)


class _FixtureHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = FIXTURE_PAGE.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        pass


@pytest.fixture
def fixture_site():
    """One page, on an ephemeral port, torn down with the test."""
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _FixtureHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}/"
    finally:
        server.shutdown()
        server.server_close()


@browser
def test_a_captured_zim_carries_what_the_capture_refused(
    fixture_site, tmp_path, monkeypatch
):
    """Capture a page with blocking on, open the ZIM, read the history back.

    The blocklist arrives the way an operator's own would — a blocklist.txt in
    the data dir — so this drives the real loader rather than a patched one,
    and the record it produces says `override` for the same honest reason."""
    from libzim.reader import Archive

    data_dir = tmp_path / "data"
    data_dir.mkdir()
    (data_dir / blocklist.OVERRIDE_NAME).write_text(
        f"{BLOCKED_HOST}\n", encoding="utf-8"
    )
    monkeypatch.setattr(_srv, "ZIMI_DATA_DIR", str(data_dir))
    blocklist.reset()

    out = tmp_path / "fixture.zim"
    info = creator.create_page_zim(
        fixture_site,
        out_dir=str(tmp_path),
        out_path=str(out),
        engine="rendered",
        block_ads=True,
    )
    assert info["blocked"]["requests"] >= 1
    assert info["blocked"]["domains"] == 1

    records = zimwriter.parse_history(
        bytes(Archive(str(out)).get_metadata("X-Zimi-History"))
    )
    assert len(records) == 1
    stored = records[0]["blocked"]
    assert stored["requests"] >= 1
    assert stored["domains"] == 1
    assert stored["list"] == blocklist.SNAPSHOT_ID
    assert stored["snapshot"] == blocklist.SNAPSHOT_RETRIEVED
    assert stored["override"] is True
    # And the human sentence beside it says the same thing in words.
    assert f"{stored['requests']} ad/tracker request" in records[0]["detail"]


@browser
def test_a_capture_with_blocking_off_records_no_blocked_field(
    fixture_site, tmp_path, monkeypatch
):
    """The absence IS the encoding — there must be no field to misread, and in
    particular no zero that would look like "blocking ran and found nothing"."""
    from libzim.reader import Archive

    data_dir = tmp_path / "data"
    data_dir.mkdir()
    (data_dir / blocklist.OVERRIDE_NAME).write_text(
        f"{BLOCKED_HOST}\n", encoding="utf-8"
    )
    monkeypatch.setattr(_srv, "ZIMI_DATA_DIR", str(data_dir))
    blocklist.reset()

    out = tmp_path / "plain.zim"
    info = creator.create_page_zim(
        fixture_site,
        out_dir=str(tmp_path),
        out_path=str(out),
        engine="rendered",
        block_ads=False,
    )
    assert "blocked" not in info

    records = zimwriter.parse_history(
        bytes(Archive(str(out)).get_metadata("X-Zimi-History"))
    )
    assert "blocked" not in records[0]
    assert "ad/tracker" not in records[0]["detail"]
