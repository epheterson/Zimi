"""Who gets in: password mode, and an SSO header that must count for nothing.

A trusted-header identity scheme is only safe while the header is trusted. If
Zimi honours Cf-Access-Jwt-Assertion when no Cloudflare team is configured,
anyone who can reach the port can name themselves an admin by typing a header.
"""

import pytest

from conftest import boot, clean_env

pytestmark = pytest.mark.gate("authentication")

PASSWORD = "gate-release-check-password"
ADMIN_ROUTES = ("/manage/status", "/manage/stats", "/manage/history")


@pytest.fixture(scope="module")
def locked_server(gate_library, tmp_path_factory):
    """An instance with a password, reached from loopback — so the only thing
    that can let a request in is the credential itself."""
    root = tmp_path_factory.mktemp("gate-auth")
    with boot(
        zim_dir=gate_library,
        data_dir=str(root / "data"),
        env=clean_env(ZIMI_MANAGE_PASSWORD=PASSWORD),
    ) as server:
        yield server


def test_the_instance_reports_that_it_is_locked(locked_server):
    status, body = locked_server.get_json("/manage/has-password")
    assert status == 200
    assert body["has_password"] is True
    assert body["env_controlled"] is True


@pytest.mark.parametrize("route", ADMIN_ROUTES)
def test_an_admin_route_refuses_an_anonymous_request(locked_server, route):
    status, body = locked_server.get_json(route)
    assert status == 401, f"{route} answered {status} with no credentials at all"
    assert body.get("error") == "unauthorized"
    assert body.get("needs_password") is True


def test_a_wrong_password_is_refused(locked_server):
    status, body = locked_server.get_json(
        "/manage/status", headers={"Authorization": "Bearer not-the-password"}
    )
    assert status == 401
    assert body.get("error") == "unauthorized"


def test_the_right_password_gets_in(locked_server):
    status, body = locked_server.get_json(
        "/manage/status", headers={"Authorization": f"Bearer {PASSWORD}"}
    )
    assert status == 200, f"the configured password was rejected: {body}"
    assert body["manage_enabled"] is True
    assert body["zim_count"] > 0


def test_an_sso_header_counts_for_nothing_when_sso_is_unconfigured(locked_server):
    """No ZIMI_SSO_TEAM / ZIMI_SSO_AUD is set, so the header is just a string a
    stranger typed. It must not shortcut the password."""
    forged = {
        "Cf-Access-Jwt-Assertion": "forged.jwt.value",
        "Cf-Access-Authenticated-User-Email": "attacker@example.invalid",
        "X-Zimi-User": "admin",
    }
    for route in ADMIN_ROUTES:
        status, body = locked_server.get_json(route, headers=forged)
        assert status == 401, (
            f"{route} let a forged SSO header in on an instance with no SSO "
            f"configured (status {status})"
        )
        assert body.get("error") == "unauthorized"


def test_an_sso_header_does_not_mint_an_identity(locked_server):
    status, body = locked_server.get_json(
        "/whoami",
        headers={"Cf-Access-Jwt-Assertion": "forged.jwt.value"},
    )
    assert status == 200
    assert not body.get(
        "user"
    ), f"a forged SSO header named a user on an unconfigured instance: {body}"


def test_reading_stays_open_while_managing_is_locked(locked_server):
    """A password protects the library's management, not its content."""
    for route in ("/health", "/list", "/search?q=water&limit=3"):
        status, _headers, _raw = locked_server.get(route)
        assert status == 200, f"{route} broke under password mode ({status})"
