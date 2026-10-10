"""Web captures stay off private addresses, unless an admin says otherwise.

A job started through /manage/create (and its preview) may not reach loopback,
RFC 1918/ULA, link-local, CGNAT, unspecified or multicast addresses, judged by
what a name resolves to, on every redirect hop, asset, robots.txt and sitemap
fetch. The command line is the host operator and is never held to it, which is
also what lets every other crawl test use the fixture server on 127.0.0.1.
"""

import ipaddress
import os
import sys

import pytest

pytest.importorskip("libzim.writer")

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi.crawler as crawler  # noqa: E402
import zimi.creator as creator  # noqa: E402
import zimi.manage as manage  # noqa: E402
import zimi.netguard as netguard  # noqa: E402
from tests.test_create_routes import _post, clean_job  # noqa: E402,F401
from tests.test_creator_site import (  # noqa: E402,F401
    BASE,
    HOSTED,
    OTHER,
    REQUESTS,
    _clean,
    _fetched,
    _site,
    fixture_server,
)

SITE = {"mode": "site", "source": BASE + "/lonely/"}
PUBLIC = "93.184.216.34"


@pytest.mark.parametrize(
    "address",
    [
        "127.0.0.1",
        "::1",
        "10.1.2.3",
        "172.16.0.1",
        "192.168.1.1",
        "fd00::1",
        "169.254.169.254",
        "fe80::1",
        "100.64.0.1",
        "100.127.255.255",
        "0.0.0.0",
        "::",
        "224.0.0.1",
        "ff02::1",
        "::ffff:10.9.8.1",
        "::ffff:127.0.0.1",
    ],
)
def test_private_addresses_are_private(address):
    assert netguard.is_private_address(ipaddress.ip_address(address))


@pytest.mark.parametrize(
    "address", [PUBLIC, "8.8.8.8", "100.128.0.1", "2606:4700::1111", "172.32.0.1"]
)
def test_public_addresses_are_public(address):
    assert not netguard.is_private_address(ipaddress.ip_address(address))


def _resolving_to(address):
    return lambda host, port: [(2, 1, 6, "", (address, 0))]


def test_a_name_is_judged_by_what_it_resolves_to():
    assert netguard.PrivateGuard(_resolving_to("10.9.8.5")).refuses(
        "looks-public.example"
    )
    assert netguard.PrivateGuard(_resolving_to("127.0.0.1")).refuses(
        "looks-public.example"
    )
    assert not netguard.PrivateGuard(_resolving_to(PUBLIC)).refuses("example.org")
    # One private answer among public ones is enough.
    mixed = lambda host, port: [
        (2, 1, 6, "", (PUBLIC, 0)),
        (2, 1, 6, "", ("10.9.8.5", 0)),
    ]  # noqa: E731
    assert netguard.PrivateGuard(mixed).refuses("both.example")

    # A name that does not resolve is not vouched for: a guarded capture
    # refuses it rather than call it public.
    def gone(host, port):
        raise OSError("no such host")

    assert netguard.PrivateGuard(gone).refuses("nowhere.example")


def test_a_verdict_is_asked_of_the_resolver_once_per_job():
    calls = []

    def resolve(host, port):
        calls.append(host)
        return [(2, 1, 6, "", (PUBLIC, 0))]

    guard = netguard.PrivateGuard(resolve)
    for _ in range(5):
        guard.refuses("cdn.example.org")
    assert calls == ["cdn.example.org"]


def test_a_public_looking_name_pointing_at_loopback_is_refused_before_any_request(
    fixture_server, tmp_path
):
    guard = netguard.PrivateGuard(_resolving_to("127.0.0.1"))
    with creator.private_addresses_refused(guard):
        with pytest.raises(creator.PrivateAddressRefused, match="private address"):
            crawler.create_site_zim(
                "http://looks-public.example:8894/", out_dir=str(tmp_path), delay=0
            )
    assert not REQUESTS


class _Guard:
    """Refuses one host name; the fixture server answers to both."""

    def __init__(self, refused):
        self.refused = refused

    def refuses(self, host):
        return host == self.refused


def test_a_link_to_a_private_host_mid_crawl_is_skipped_with_a_note(
    fixture_server, tmp_path
):
    notes = []
    with creator.private_addresses_refused(_Guard("localhost")):
        info = _site(
            tmp_path,
            "/deep/start.html",
            scope="any",
            max_depth=2,
            progress=notes.append,
        )
    assert not [h for h, _p in HOSTED if h == "localhost"]  # nothing was asked of it
    assert any(n.startswith("skipped") and "private address" in n for n in notes)
    assert "/deep/b.html" in _fetched()  # the rest of the crawl went on
    assert info["pages"] >= 2


def test_a_redirect_to_a_private_address_is_refused(fixture_server):
    with creator.private_addresses_refused(_Guard("localhost")):
        with pytest.raises(creator.PrivateAddressRefused):
            creator._fetch_html(BASE + "/to-localhost", timeout=5, max_redirects=5)
    assert "/to-localhost" in REQUESTS and not [
        h for h, _p in HOSTED if h == "localhost"
    ]
    # Unheld, the same redirect is followed.
    final, _text, _n, _lang = creator._fetch_html(
        BASE + "/to-localhost", timeout=5, max_redirects=5
    )
    assert final == f"{OTHER}/far.html"


def test_an_asset_on_a_private_host_is_not_carried(fixture_server):
    with creator.private_addresses_refused(_Guard("127.0.0.1")):
        read = creator._http_asset_reader(BASE, [BASE], 5)
        assert read("logo", "img/logo.png") is None


def test_robots_and_the_sitemap_are_held_to_the_rule_too(fixture_server):
    with creator.private_addresses_refused(_Guard("127.0.0.1")):
        notes = []
        assert crawler.load_robots(BASE, note=notes.append) is None
        assert any("private address" in n for n in notes)
        urls = crawler.sitemap_urls(
            True, BASE + "/", None, ignore_robots=False, timeout=5, note=notes.append
        )
    assert (
        urls == [] and "/sitemap.xml" not in REQUESTS and "/robots.txt" not in REQUESTS
    )


def test_a_redirect_in_robots_to_a_private_host_is_refused(fixture_server):
    with creator.private_addresses_refused(_Guard("localhost")):
        req = creator.urllib.request.Request(BASE + "/to-localhost")
        with pytest.raises(creator.PrivateAddressRefused):
            creator.urlopen_guarded(req, 5)


# ── the web ─────────────────────────────────────────────────────────────────


@pytest.fixture
def web_job(monkeypatch, tmp_path):
    monkeypatch.setattr(manage, "_create_out_dir", lambda: str(tmp_path))
    monkeypatch.setattr(crawler, "_try_register", lambda _p: False)

    def run(**fields):
        _mode, source, _title, opts = manage._create_validate(dict(SITE, **fields))
        job = manage._CreateJob("site", source, None)
        opts.setdefault("delay", 0)
        return manage._create_run(job, opts)

    return run


def test_a_web_job_to_a_private_seed_is_refused_with_the_way_out(
    fixture_server, web_job
):
    with pytest.raises(creator.CreateError) as refused:
        web_job()
    said = str(refused.value)
    assert "127.0.0.1 is a private address" in said
    assert "An admin can allow private captures in Manage" in said
    assert not [
        p for p in REQUESTS if p != "/robots.txt"
    ]  # the page was never asked for


def test_a_web_job_may_reach_a_private_address_once_an_admin_allows_it(
    fixture_server, web_job
):
    assert _post("/manage/creator", {"allow_private": True}).status == 200
    assert web_job()["pages"] == 1
    assert _post("/manage/creator", {"allow_private": False}).status == 200
    with pytest.raises(creator.PrivateAddressRefused):
        web_job()


def test_a_capture_cannot_carry_the_permission(fixture_server, web_job):
    with pytest.raises(creator.PrivateAddressRefused):
        web_job(allow_private=True)
    assert (
        "allow_private"
        not in manage._create_validate(dict(SITE, allow_private=True))[3]
    )


def test_the_preview_is_held_to_the_rule_too(fixture_server):
    result, status = manage._create_probe(dict(SITE))
    assert status == 200 and result["ok"] is False
    assert "private address" in result["detail"]
    _post("/manage/creator", {"allow_private": True})
    result, _ = manage._create_probe(dict(SITE))
    assert result["ok"] is True


def test_the_rule_is_per_job_and_leaves_nothing_behind(fixture_server):
    assert creator.current_private_guard() is None
    with creator.private_addresses_refused():
        assert creator.current_private_guard() is not None
    assert creator.current_private_guard() is None


def test_only_an_admin_can_set_the_toggle(monkeypatch, tmp_path):
    # Passwordless and not on this host's network: locked out of Manage entirely.
    assert (
        _post("/manage/creator", {"allow_private": True}, private=False).status == 403
    )
    # A password set and nothing presented: asked for it.
    monkeypatch.setattr(manage, "_get_manage_password_hash", lambda: "set")
    assert _post("/manage/creator", {"allow_private": True}).status in (401, 403)
    assert not manage._create_allows_private()


def test_the_toggle_is_a_boolean_and_nothing_else():
    assert _post("/manage/creator", {"allow_private": "yes"}).status == 400
    assert not manage._create_allows_private()


def test_the_command_line_is_never_held_to_it(fixture_server, tmp_path):
    # No rule in force: the fixture server on 127.0.0.1 is captured, as every
    # other crawl test relies on.
    assert creator.current_private_guard() is None
    assert _site(tmp_path, "/lonely/")["pages"] == 1


def test_the_browser_engines_are_told_the_rule():
    """The renderer asks the guard of every request its browser makes."""
    from zimi.renderer import RenderedSession

    assert RenderedSession()._private_guard is None
    with creator.private_addresses_refused(_Guard("10.9.8.1")):
        session = RenderedSession()
    assert session._private_guard is not None and session._private_guard.refuses(
        "10.9.8.1"
    )
    with pytest.raises(creator.PrivateAddressRefused):
        creator.check_public("http://10.9.8.1/", session._private_guard)
    seen = []

    class Route:
        class request:  # noqa: N801
            url = "http://10.9.8.1/admin"

        def abort(self, code):
            seen.append(("abort", code))

        def continue_(self):
            seen.append(("continue",))

    session._route(Route())
    assert seen and seen[0][0] == "abort"
    session._private_guard = _Guard("somewhere-else")
    seen.clear()
    session._route(Route())
    assert seen == [("continue",)]


def test_zimit_does_not_run_under_the_rule(monkeypatch, tmp_path):
    """Its browser is in Docker, out of the capture proxy's reach: a public
    seed is refused as well as a private one."""
    monkeypatch.setattr(crawler, "_docker_cli", lambda: "/usr/local/bin/docker")
    with creator.private_addresses_refused():
        for seed in ("http://192.168.1.10/", "https://example.org/"):
            with pytest.raises(creator.CreateError, match="runs in Docker"):
                crawler.create_zimit_zim(seed, site=True, out_dir=str(tmp_path))


def test_singlefile_refuses_a_private_seed(tmp_path):
    import zimi.singlefile as singlefile

    with creator.private_addresses_refused():
        with pytest.raises(creator.PrivateAddressRefused, match="private address"):
            singlefile.capture_page("http://192.168.1.10/", work_dir=str(tmp_path))


def test_the_web_refuses_zimit_under_the_rule_and_offers_it_once_allowed(monkeypatch):
    """Refused when the form is sent, not when the job starts: its browser is in
    Docker, where the capture proxy cannot reach it."""
    monkeypatch.setattr(manage, "_create_zimit_ready", lambda: True)
    with pytest.raises(ValueError, match="runs in Docker"):
        manage._create_validate(dict(SITE, engine="zimit"))
    assert _post("/manage/creator", {"allow_private": True}).status == 200
    try:
        assert manage._create_validate(dict(SITE, engine="zimit"))[3]["engine"] == "zimit"
    finally:
        assert _post("/manage/creator", {"allow_private": False}).status == 200
