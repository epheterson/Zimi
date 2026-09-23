"""The one-time download ticket (1.9.0) does what it promises.

A browser navigation to /dl/ carries no auth headers, so right-click ->
Download on a passworded server saved an HTML refusal as name.zim.html. The
authorized client mints a ticket at POST /manage/dl-ticket and the /dl/ URL
spends it. The ledger found no test at all; a regression would bring the
.zim.html back, or worse, open /dl/ to anyone holding an old link.
"""

import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from zimi import manage  # noqa: E402


def _mint(fname, ttl=None):
    import secrets

    token = secrets.token_urlsafe(24)
    exp = time.time() + (manage.DL_TICKET_TTL_SEC if ttl is None else ttl)
    with manage._dl_ticket_lock:
        manage._dl_tickets[token] = (fname, exp)
    return token


def test_a_ticket_opens_its_own_file_once():
    t = _mint("wikipedia_en_all.zim")
    assert manage.spend_dl_ticket(t, "wikipedia_en_all.zim") is True
    assert manage.spend_dl_ticket(t, "wikipedia_en_all.zim") is False


def test_a_ticket_does_not_open_another_file():
    t = _mint("wikipedia_en_all.zim")
    assert manage.spend_dl_ticket(t, "private.zim") is False
    # and it is spent by the attempt, not left for a second try
    assert manage.spend_dl_ticket(t, "wikipedia_en_all.zim") is False


def test_an_expired_ticket_opens_nothing():
    t = _mint("wikipedia_en_all.zim", ttl=-1)
    assert manage.spend_dl_ticket(t, "wikipedia_en_all.zim") is False


def test_no_ticket_and_a_made_up_one_open_nothing():
    assert manage.spend_dl_ticket("", "wikipedia_en_all.zim") is False
    assert manage.spend_dl_ticket("not-a-ticket", "wikipedia_en_all.zim") is False


def test_minting_needs_the_admin(monkeypatch):
    from types import SimpleNamespace

    captured = {}

    class H:
        def _json(self, status, payload):
            captured.update(status=status, payload=payload)

    monkeypatch.setattr(manage, "_manage_auth_challenge", lambda h: (401, {"error": "auth required"}))
    manage.handle_manage_post(H(), SimpleNamespace(path="/manage/dl-ticket"), {"file": "x.zim"})
    assert captured["status"] == 401 and "ticket" not in captured["payload"]


def test_a_ticket_is_only_for_a_plain_filename(monkeypatch):
    from types import SimpleNamespace

    captured = {}

    class H:
        def _json(self, status, payload):
            captured.update(status=status, payload=payload)

    monkeypatch.setattr(manage, "_manage_auth_challenge", lambda h: None)
    for bad in ("../etc/passwd", "a/b.zim", "a\\b.zim", ""):
        manage.handle_manage_post(H(), SimpleNamespace(path="/manage/dl-ticket"), {"file": bad})
        assert captured["status"] == 400, bad
