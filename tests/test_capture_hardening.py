"""Hardening found in review: the sitemap and pattern scanners stay linear, a
web-started video capture is held to public addresses, the private-address
guard fails closed (renderer errors, unresolvable names, addresses carried
inside IPv6, a slow resolver, a name that resolves differently on connect).
"""

import ipaddress
import os
import socket
import sys
import threading
import time

import pytest

pytest.importorskip("libzim.writer")

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi.crawler as crawler  # noqa: E402
import zimi.creator as creator  # noqa: E402
import zimi.manage as manage  # noqa: E402
import zimi.netguard as netguard  # noqa: E402
import zimi.video as video  # noqa: E402
from tests.test_creator_site import (  # noqa: E402,F401
    BASE,
    HOST,
    PORT,
    _clean,
    fixture_server,
)

PUBLIC = "93.184.216.34"
TIME_BOUND = 2.0  # seconds; the quadratic versions took many times that


# ── the sitemap scan ────────────────────────────────────────────────────────


def _timed(fn, *args):
    started = time.monotonic()
    result = fn(*args)
    return result, time.monotonic() - started


def test_a_sitemap_is_read_in_every_form_it_comes_in():
    text = (
        '<urlset><url><loc>http://a/1</loc></url><x:loc attr="1">http://a/2</x:loc>'
        "<LOC><![CDATA[http://a/3?a=1&amp;b=2]]></LOC><loc>\n http://a/4 \n</loc>"
        "<loc></loc><location>no</location></urlset>"
    )
    is_index, locs = crawler.sitemap_locs(text)
    assert not is_index
    assert locs == ["http://a/1", "http://a/2", "http://a/3?a=1&b=2", "http://a/4"]
    assert crawler.sitemap_locs("<sitemapindex><sitemap><loc>http://a/m.xml</loc></sitemap></sitemapindex>")[0]


@pytest.mark.parametrize(
    "hostile",
    [
        "<loc>" * 8000,
        "<loc>" * 200_000,
        "<loc <loc " * 100_000,
        "<loc>x</a>" * 100_000,
        "<loc>" + "</" * 300_000,
        "<a:loc>" * 150_000,
    ],
    # Short ids: pytest puts the id in an environment variable, which Windows
    # caps at 32,767 characters.
    ids=["loc-8k", "loc-200k", "open-tags", "wrong-close", "close-run", "prefixed"],
)
def test_a_hostile_sitemap_is_read_in_linear_time(hostile):
    (_index, locs), took = _timed(crawler.sitemap_locs, hostile)
    assert took < TIME_BOUND and locs == []


def test_a_sitemap_takes_no_more_addresses_than_the_cap():
    text = "<loc>http://a/x</loc>" * (crawler.MAX_SITEMAP_URLS + 500)
    _is_index, locs = crawler.sitemap_locs(text)
    assert len(locs) == crawler.MAX_SITEMAP_URLS


# ── patterns ────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "pattern",
    [r"(a|aa)+$", r"(x|x)*y", r"((a|aa))+", r"(?:ab|abc){2,}", r"((ab|abc)e)+", r"(.|a)*b"],
)
def test_a_repeated_choice_whose_options_overlap_is_refused(pattern):
    with pytest.raises(creator.CreateError, match="repeats a choice whose options can overlap"):
        crawler._patterns([pattern], "--exclude")


@pytest.mark.parametrize(
    "pattern",
    [
        r"\.(png|jpg)$",
        r"(?:/en|/fr)?/wiki/",
        r"(ab|cd){1,3}",
        r"/(news|blog)/\d+",
        r"^/(?:docs|guide)(?:/(?:v1|v2))*/",
        r"(?:foo|bar)+",
        r"(/en|/fr)*",
        r"(?:ab|cd){2,}",
    ],
)
def test_ordinary_patterns_still_work(pattern):
    assert crawler._patterns([pattern], "--exclude")


def test_overlapping_classes_are_refused_by_one_rule_or_the_other():
    with pytest.raises(creator.CreateError, match="can hang the crawl"):
        crawler._patterns([r"(\w+|\d+)*"], "--exclude")


def test_a_nested_repeat_keeps_its_own_sentence():
    with pytest.raises(creator.CreateError, match="repeats a group that itself repeats"):
        crawler._patterns([r"(a+)+$"], "--exclude")


def test_the_pattern_rule_runs_on_python_3_10():
    """The parser moved under ``re`` in 3.11 and two opcodes arrived with it.
    Whatever this Python is, the checker reads its own parser."""
    assert crawler._sre.MAXREPEAT and crawler._sre_parse.parse("(a|aa)+")
    assert crawler._sre_atomic is None or crawler._sre_atomic == crawler._sre.ATOMIC_GROUP


# ── video ───────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("url", ["http://169.254.169.254/latest/", "http://192.168.1.1/", "http://127.0.0.1:8080/"])
def test_a_web_video_capture_may_not_reach_a_private_address(url):
    with creator.private_addresses_refused():
        with pytest.raises(creator.PrivateAddressRefused, match="private address"):
            video._flat_entries(object(), url, 5)


def test_probe_video_is_held_to_it(monkeypatch):
    monkeypatch.setattr(video, "_yt_dlp", lambda: object())
    monkeypatch.delenv("ZIMI_OFFLINE", raising=False)
    with creator.private_addresses_refused():
        with pytest.raises(creator.PrivateAddressRefused):
            video.probe_video("http://192.168.1.1/list")


def test_the_video_preview_is_held_to_it_too(monkeypatch):
    monkeypatch.setattr(video, "_yt_dlp", lambda: object())
    monkeypatch.setattr(manage, "_create_allows_private", lambda: False)
    result, status = manage._create_probe({"mode": "video", "source": "http://192.168.1.1/list"})
    assert status == 200 and not result["ok"]
    assert "private address" in result["detail"]


def test_the_video_job_is_held_to_it_and_the_cli_is_not(monkeypatch, tmp_path):
    monkeypatch.setattr(video, "_yt_dlp", lambda: object())
    monkeypatch.delenv("ZIMI_OFFLINE", raising=False)
    with creator.private_addresses_refused():
        with pytest.raises(creator.PrivateAddressRefused):
            video.create_video_zim("http://169.254.169.254/", out_dir=str(tmp_path))
    # No rule in force (the command line): the address is not judged.
    video._flat_entries.__globals__["check_public"]("http://169.254.169.254/")


def test_an_entry_at_a_private_address_is_skipped_and_never_downloaded(monkeypatch, tmp_path):
    monkeypatch.setattr(video, "_yt_dlp", lambda: object())
    monkeypatch.delenv("ZIMI_OFFLINE", raising=False)
    entries = [{"title": "inside", "url": "http://10.9.8.5/v.mp4"}]
    monkeypatch.setattr(video, "_flat_entries", lambda mod, url, limit: ({"title": "L"}, entries))
    downloaded = []
    monkeypatch.setattr(video, "_download_entry", lambda *a, **k: downloaded.append(a))
    notes = []
    with creator.private_addresses_refused(netguard.PrivateGuard()):
        with pytest.raises(creator.CreateError):
            video.create_video_zim(
                "https://example.org/list", out_dir=str(tmp_path), progress=notes.append
            )
    assert not downloaded and any("private address" in n for n in notes)


# ── the guard fails closed ──────────────────────────────────────────────────


@pytest.mark.parametrize(
    "address, private",
    [
        ("64:ff9b::a09:801", True),  # NAT64 of 10.9.8.1
        ("64:ff9b::7f00:1", True),  # NAT64 of 127.0.0.1
        ("64:ff9b::a9fe:a9fe", True),  # NAT64 of 169.254.169.254
        ("64:ff9b::5db8:d822", False),  # NAT64 of a public address
        ("2002:a09:801::", True),  # 6to4 of 10.9.8.1
        ("2002:c0a8:101::1", True),  # 6to4 of 192.168.1.1
        # Python lists the 6to4 and Teredo ranges as not global, so they are
        # refused whatever they carry: no public host needs either.
        ("2002:5db8:d822::1", True),
        ("2001:0:4136:e378:8000:63bf:3fff:fdd2", True),
        ("2001:0:a09:801:8000:63bf:f5f6:f7fe", True),  # Teredo server 10.9.8.1
        ("::10.9.8.1", True),
        ("::ffff:10.9.8.1", True),
        ("2606:4700:4700::1111", False),
    ],
)
def test_an_ipv4_address_inside_an_ipv6_one_is_judged_as_what_it_is(address, private):
    assert netguard.is_private_address(ipaddress.ip_address(address)) is private


def test_a_teredo_client_is_judged_too():
    # Client 10.9.8.1 is obfuscated (XOR 0xffffffff) in the last 32 bits.
    assert netguard.is_private_address(ipaddress.ip_address("2001:0:4136:e378:8000:63bf:f5f6:f7fe"))


def test_a_name_that_does_not_resolve_is_refused():
    def gone(host, port):
        raise OSError("no such host")

    assert netguard.PrivateGuard(gone).refuses("nowhere.example")
    assert netguard.PrivateGuard(lambda h, p: []).refuses("empty.example")


def test_a_slow_lookup_does_not_hold_up_another():
    release = threading.Event()

    def resolve(host, port):
        if host == "slow.example":
            release.wait(10)
        return [(2, 1, 6, "", (PUBLIC, 0))]

    guard = netguard.PrivateGuard(resolve, timeout=5)
    slow = threading.Thread(target=guard.refuses, args=("slow.example",), daemon=True)
    slow.start()
    time.sleep(0.2)
    verdict, took = _timed(guard.refuses, "fast.example")
    release.set()
    slow.join(5)
    assert verdict is False and took < 2


def test_a_lookup_that_takes_too_long_is_refused():
    release = threading.Event()

    def resolve(host, port):
        release.wait(10)
        return [(2, 1, 6, "", (PUBLIC, 0))]

    guard = netguard.PrivateGuard(resolve, timeout=0.3)
    verdict, took = _timed(guard.refuses, "stuck.example")
    release.set()
    assert verdict is True and took < 2
    assert guard.could_not_resolve("stuck.example")


class _Route:
    def __init__(self, url, boom=False):
        self.aborted = self.continued = False
        outer = self

        class _Request:
            @property
            def url(self):
                if boom:
                    raise RuntimeError("cannot read the request")
                return url

        self.request = _Request()
        self._outer = outer

    def abort(self, code=None):
        self.aborted = True

    def continue_(self):
        self.continued = True


def _session(guard):
    import zimi.renderer as renderer

    session = renderer.RenderedSession.__new__(renderer.RenderedSession)
    session._private_guard = guard
    session._blocklist = None
    session.blocked = 0
    session.blocked_hosts = set()
    return session


def test_a_guarded_browser_aborts_what_it_cannot_judge():
    class Broken:
        def refuses(self, host):
            raise RuntimeError("resolver blew up")

    for route in (_Route("https://example.org/"), _Route("https://example.org/", boom=True)):
        _session(Broken())._route(route)
        assert route.aborted and not route.continued


def test_an_unguarded_browser_still_lets_a_request_through():
    route = _Route("https://example.org/", boom=True)
    _session(None)._route(route)
    assert route.continued and not route.aborted
    route = _Route("https://example.org/")
    _session(netguard.PrivateGuard(lambda h, p: [(2, 1, 6, "", (PUBLIC, 0))]))._route(route)
    assert route.continued


# ── the connected peer ──────────────────────────────────────────────────────


def _rebind(monkeypatch):
    """Every connection goes to the fixture server, whatever name was asked
    for: a name that resolved to a public address and then connects to a
    private one."""
    real = socket.create_connection
    monkeypatch.setattr(
        socket, "create_connection", lambda address, *a, **k: real((HOST, PORT), *a, **k)
    )


def test_a_name_that_resolves_differently_on_connect_is_refused(fixture_server, monkeypatch):
    _rebind(monkeypatch)
    guard = netguard.PrivateGuard(lambda h, p: [(2, 1, 6, "", (PUBLIC, 0))])
    url = f"http://rebind.example:{PORT}/"
    with creator.private_addresses_refused(guard):
        with pytest.raises(creator.CreateError, match="private address"):
            creator._fetch_page(url, timeout=5, max_redirects=0)
        with pytest.raises(creator.urllib.error.URLError) as caught:
            creator.urlopen_guarded(creator.urllib.request.Request(url), 5)
        assert isinstance(caught.value.reason, creator.PrivateAddressRefused)


def test_the_same_connection_is_fine_when_nothing_holds_it(fixture_server, monkeypatch):
    _rebind(monkeypatch)
    page = creator._fetch_page(f"http://rebind.example:{PORT}/", timeout=5, max_redirects=0)
    assert b"Home" in page[1]
    with creator.urlopen_guarded(
        creator.urllib.request.Request(f"http://rebind.example:{PORT}/"), 5
    ) as resp:
        assert resp.status == 200


# ── final review ────────────────────────────────────────────────────────────


def test_a_timeout_is_not_remembered_as_a_refusal():
    calls = []

    def flaky(host, port):
        calls.append(host)
        if len(calls) == 1:
            raise OSError("temporary failure in name resolution")
        return [(2, 1, 6, "", (PUBLIC, 0))]

    guard = netguard.PrivateGuard(flaky)
    assert guard.refuses("blip.example") is True and guard.could_not_resolve("blip.example")
    assert guard.refuses("blip.example") is False  # asked again, and answered
    assert not guard.could_not_resolve("blip.example")
    guard.refuses("blip.example")
    assert len(calls) == 2  # now it is remembered


def test_a_name_that_could_not_be_resolved_is_said_so_not_called_private():
    def gone(host, port):
        raise OSError("no such host")

    with creator.private_addresses_refused(netguard.PrivateGuard(gone)):
        with pytest.raises(creator.PrivateAddressRefused) as caught:
            creator.check_public("http://nowhere.example/")
    assert "could not resolve nowhere.example" in str(caught.value)
    assert "private address" not in str(caught.value)
    with creator.private_addresses_refused(netguard.PrivateGuard(lambda h, p: [(2, 1, 6, "", ("10.9.8.5", 0))])):
        with pytest.raises(creator.PrivateAddressRefused, match="nowhere.example is a private address"):
            creator.check_public("http://nowhere.example/")


def test_a_proxy_hop_is_not_judged_by_the_proxys_own_address(fixture_server, monkeypatch):
    # The "proxy" is the loopback fixture server: private, and the way out.
    monkeypatch.setenv("http_proxy", f"http://{HOST}:{PORT}")
    monkeypatch.delenv("no_proxy", raising=False)
    monkeypatch.delenv("NO_PROXY", raising=False)
    guard = netguard.PrivateGuard(lambda h, p: [(2, 1, 6, "", (PUBLIC, 0))])
    with creator.private_addresses_refused(guard):
        with pytest.raises(creator.urllib.error.HTTPError) as caught:
            creator.urlopen_guarded(creator.urllib.request.Request("http://target.example/x"), 5)
    assert caught.value.code == 404  # it reached the proxy, which has no such page
    # The name is still judged first.
    private_name = netguard.PrivateGuard(lambda h, p: [(2, 1, 6, "", ("10.9.8.5", 0))])
    with creator.private_addresses_refused(private_name):
        with pytest.raises(creator.PrivateAddressRefused):
            creator.urlopen_guarded(creator.urllib.request.Request("http://inside.example/"), 5)


def test_a_refusal_after_connect_names_the_target_host(fixture_server, monkeypatch):
    _rebind(monkeypatch)
    guard = netguard.PrivateGuard(lambda h, p: [(2, 1, 6, "", (PUBLIC, 0))])
    with creator.private_addresses_refused(guard):
        with pytest.raises(creator.CreateError, match="rebind.example is a private address"):
            creator._fetch_page(f"http://rebind.example:{PORT}/", timeout=5, max_redirects=0)


def test_an_empty_loc_does_not_swallow_the_next_address():
    assert crawler.sitemap_locs("<loc/><loc>https://a/</loc>")[1] == ["https://a/"]
    assert crawler.sitemap_locs("<loc />\n<x:loc/><loc>https://b/</loc>")[1] == ["https://b/"]
    assert crawler.sitemap_locs("<loc></loc><loc>https://c/</loc>")[1] == ["https://c/"]


def test_the_local_use_nat64_prefix_is_judged_by_what_it_carries():
    assert netguard.is_private_address(ipaddress.ip_address("64:ff9b:1::a09:801"))
    assert netguard.is_private_address(ipaddress.ip_address("64:ff9b:1::7f00:1"))
    assert [str(a) for a in netguard._embedded_addresses(ipaddress.ip_address("64:ff9b:1::a09:801"))] == ["10.9.8.1"]


def test_a_playlist_whose_entries_are_all_private_ends_with_the_private_refusal(monkeypatch, tmp_path):
    monkeypatch.setattr(video, "_yt_dlp", lambda: object())
    monkeypatch.delenv("ZIMI_OFFLINE", raising=False)
    entries = [{"title": "a", "url": "http://10.9.8.5/a"}, {"title": "b", "webpage_url": "http://192.168.1.1/b"}]
    monkeypatch.setattr(video, "_flat_entries", lambda mod, url, limit: ({"title": "L"}, entries))
    monkeypatch.setattr(video, "_download_entry", lambda *a, **k: pytest.fail("downloaded"))
    notes = []
    with creator.private_addresses_refused(netguard.PrivateGuard()):
        with pytest.raises(creator.CreateError, match="every video in the list is at a private address"):
            video.create_video_zim("https://example.org/list", out_dir=str(tmp_path), progress=notes.append)
    assert any("left out 2 videos at private addresses" in n for n in notes)
