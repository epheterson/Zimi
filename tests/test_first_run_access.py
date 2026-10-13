"""Who may manage Zimi (#107, #112), held to GHSA-5mw2-53vv-9pw6.

One switch: a password to manage. On, whoever has it manages Zimi from
anywhere; off, anyone who can reach Zimi does, chosen with a named press.
Where a request came from is not asked: that guess, behind a reverse proxy,
kept an owner from turning their own password off at home (Eric,
2026-10-12: "just have one toggle to require a password to manage").

The first answer is still made through the same two doors as the first
password: the machine running Zimi, or a device that brings the one-time
setup key the server logged. An adjacent device on its own cannot make it,
so the advisory's race stays closed. A fresh self-hosted install answers
nothing else until it is made. An install that ran before never waits.
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tests import test_bootstrap_takeover as takeover  # noqa: E402
from zimi import manage  # noqa: E402

INTERNET = "8.8.8.8"
PW = {"require_password": True, "username": "eric", "password": "hunter22"}
NO_PW = {"require_password": False, "open_confirm": True}
_ENV = (
    "ZIMI_LAN_ADMIN",
    "ZIMI_MANAGE_OPEN",
    "ZIMI_MANAGE_EXTERNAL",
    "ZIMI_MANAGE_USER",
)


class _Harness(unittest.TestCase):
    # The takeover tests' server and helpers, without their tests.
    _as_peer = takeover.BootstrapTakeoverTests._as_peer
    _post = takeover.BootstrapTakeoverTests._post
    _get = takeover.BootstrapTakeoverTests._get

    def setUp(self):
        for k in _ENV:
            os.environ.pop(k, None)
        manage._setup_gate = False
        takeover.BootstrapTakeoverTests.setUp(self)

    def tearDown(self):
        for k in _ENV:
            os.environ.pop(k, None)
        manage._setup_gate = False
        takeover.BootstrapTakeoverTests.tearDown(self)

    def _state(self, headers=None):
        return self._get("/manage/has-password", headers)[1]

    @staticmethod
    def _bearer(token):
        return {"Authorization": "Bearer " + token}


class FirstRunAccessTests(_Harness):
    def test_a_neighbour_cannot_answer_the_setup_page(self):
        manage.ensure_setup_key()
        self._as_peer(takeover.ADJACENT)
        for answer in (PW, NO_PW):
            status, body = self._post("/manage/access", answer)
            self.assertEqual(status, 403, body)
            self.assertTrue(body.get("needs_setup_key"), body)
        self.assertEqual(self._state()["access"], "unset")

    def test_the_key_holder_sets_it_up_from_another_device(self):
        key = manage.ensure_setup_key()
        self._as_peer(takeover.ADJACENT)
        status, body = self._post("/manage/access", PW, {"X-Zimi-Setup-Key": key})
        self.assertEqual(status, 200, body)
        self.assertEqual(body["access"], "password")
        self.assertTrue(body.get("token"), "the browser that set it is signed in")
        self.assertFalse(manage._read_setup_key(), "the key is spent")
        self.assertEqual(manage._get_manage_user(), "eric")

    def test_a_wrong_key_answers_nothing(self):
        manage.ensure_setup_key()
        self._as_peer(takeover.ADJACENT)
        status, _ = self._post("/manage/access", NO_PW, {"X-Zimi-Setup-Key": "AAAA-BBBB-CCCC"})
        self.assertEqual(status, 403)
        self.assertEqual(self._state()["access"], "unset")

    def test_through_a_proxy_the_owner_chooses_either_answer(self):
        """Eric, 2026-10-12, at home through his NAS's proxy: the password
        could not be turned off because Zimi could not tell his network from
        the internet. It no longer asks."""
        key = manage.ensure_setup_key()
        hdr = {"X-Zimi-Setup-Key": key, "X-Forwarded-For": "192.0.2.7"}
        status, body = self._post("/manage/access", NO_PW, hdr)
        self.assertEqual((status, body.get("access")), (200, "open"), body)

    def test_no_password_on_a_first_run_takes_the_named_press(self):
        status, body = self._post("/manage/access", {"require_password": False})
        self.assertEqual((status, body.get("error")), (400, "open_unconfirmed"), body)
        self.assertEqual(self._state()["access"], "unset")
        status, body = self._post("/manage/access", NO_PW)
        self.assertEqual((status, body.get("access")), (200, "open"), body)
        self._as_peer(INTERNET)
        self.assertEqual(self._get("/manage/status")[0], 200)

    def test_a_password_is_asked_for_from_anywhere(self):
        token = self._post("/manage/access", PW)[1]["token"]
        for peer in (takeover.ADJACENT, INTERNET):
            self._as_peer(peer)
            self.assertEqual(self._get("/manage/status", self._bearer(token))[0], 200)
            self.assertEqual(self._get("/manage/status")[0], 401)
            status, body = self._post("/login", {"username": "eric", "password": "hunter22"})
            self.assertEqual(status, 200, body)

    def test_a_wall_saved_by_the_old_outside_switch_is_not_read(self):
        """The owner who turned "outside" off from outside was locked out of
        their own settings from the internet; the password is the wall."""
        self._post("/manage/access", PW)
        manage._write_app_update_prefs(manage_external=False)
        self._as_peer(INTERNET)
        status, body = self._post("/login", {"username": "eric", "password": "hunter22"})
        self.assertEqual(status, 200, body)

    def test_the_environment_can_still_wall_manage_inside(self):
        token = self._post("/manage/access", PW)[1]["token"]
        os.environ["ZIMI_MANAGE_EXTERNAL"] = "0"
        self._as_peer(INTERNET)
        status, body = self._get("/manage/creator", self._bearer(token))
        self.assertEqual((status, body.get("error")), (403, "outside_network"), body)
        status, body = self._get("/manage/create/log", self._bearer(token))
        self.assertNotEqual(body.get("error"), "outside_network", body)

    def test_a_password_from_before_the_setup_page_still_works_from_outside(self):
        manage._set_manage_password("hunter22")
        self._as_peer(INTERNET)
        status, body = self._post("/login", {"username": "admin", "password": "hunter22"})
        self.assertEqual(status, 200, body)

    def test_a_network_only_answer_saved_before_keeps_working(self):
        """Nobody's install widens on upgrade: the old "anyone on my network"
        stays as saved until its owner turns the password on."""
        manage._write_app_update_prefs(lan_admin=True)
        self.assertEqual(self._state()["access"], "lan")
        self._as_peer(takeover.ADJACENT)
        self.assertEqual(self._get("/manage/status")[0], 200)
        self._as_peer(INTERNET)
        self.assertEqual(self._get("/manage/status")[0], 403)
        self._as_peer(takeover.ADJACENT)
        status, body = self._post("/manage/access", PW)
        self.assertEqual((status, body.get("access")), (200, "password"), body)
        self.assertEqual(self._get("/manage/status")[0], 401)

    def test_after_setup_only_the_admin_changes_it(self):
        token = self._post("/manage/access", PW)[1]["token"]
        self._as_peer(takeover.ADJACENT)
        self.assertEqual(self._post("/manage/access", NO_PW)[0], 401)
        status, body = self._post(
            "/manage/access", {"require_password": True, "username": "erica"}, self._bearer(token)
        )
        self.assertEqual(status, 200, body)
        self.assertEqual(manage._get_manage_user(), "erica", "the username is edited in place")

    def test_a_save_without_a_username_keeps_the_name(self):
        token = self._post("/manage/access", PW)[1]["token"]
        status, body = self._post("/manage/access", {"require_password": True}, self._bearer(token))
        self.assertEqual(status, 200, body)
        self.assertEqual(manage._get_manage_user(), "eric")

    def test_only_the_admin_sees_the_username(self):
        token = self._post("/manage/access", PW)[1]["token"]
        self.assertEqual(self._state()["username"], "")
        self.assertEqual(self._state(self._bearer(token))["username"], "eric")

    def test_the_environment_has_the_last_word(self):
        os.environ["ZIMI_LAN_ADMIN"] = "0"
        status, body = self._post("/manage/access", NO_PW)
        self.assertEqual((status, body.get("var")), (403, "ZIMI_LAN_ADMIN"), body)
        os.environ.pop("ZIMI_LAN_ADMIN")
        os.environ["ZIMI_MANAGE_PASSWORD"] = "from-env"
        manage._env_pw_hash_cache = None
        status, body = self._post("/manage/access", PW, self._bearer("from-env"))
        self.assertEqual((status, body.get("var")), (403, "ZIMI_MANAGE_PASSWORD"), body)
        os.environ.pop("ZIMI_MANAGE_PASSWORD")
        manage._env_pw_hash_cache = None
        self.assertEqual(self._post("/manage/access", PW)[0], 200)


class PasswordOffTests(_Harness):
    """The switch off (#112): anyone who can reach Zimi manages it. It costs
    the named press and the current password, purges nothing, and gives way
    to ZIMI_MANAGE_OPEN when that is set."""

    def _admin(self):
        return self._bearer(self._post("/manage/access", PW)[1]["token"])

    def test_it_takes_the_press_and_the_current_password(self):
        admin = self._admin()
        status, body = self._post("/manage/access", dict(NO_PW, open_confirm=False), admin)
        self.assertEqual((status, body.get("error")), (400, "open_unconfirmed"), body)
        status, body = self._post("/manage/access", NO_PW, admin)
        self.assertEqual((status, body.get("error")), (403, "wrong_password"), body)
        status, body = self._post("/manage/access", dict(NO_PW, current_password="nope"), admin)
        self.assertEqual((status, body.get("error")), (403, "wrong_password"), body)
        self.assertEqual(self._state()["access"], "password")
        status, body = self._post("/manage/access", dict(NO_PW, current_password="hunter22"), admin)
        self.assertEqual((status, body.get("access")), (200, "open"), body)

    def test_then_anyone_is_the_admin_and_the_password_waits(self):
        admin = self._admin()
        self._post("/manage/access", dict(NO_PW, current_password="hunter22"), admin)
        self._as_peer(INTERNET)
        self.assertEqual(self._get("/manage/status")[0], 200)
        state = self._state()
        self.assertEqual(state["access"], "open")
        self.assertTrue(state["kept_password"])
        self.assertFalse(state["open_env"])
        self.assertEqual(state["username"], "", "the account name is not handed out")
        # Turning it back on from anywhere returns to the same password.
        self.assertEqual(self._post("/manage/access", {"require_password": True})[0], 200)
        self.assertEqual(self._state()["access"], "password")
        self.assertEqual(self._get("/manage/status")[0], 401)
        status, body = self._post("/login", {"username": "eric", "password": "hunter22"})
        self.assertEqual(status, 200, body)

    def test_with_a_kept_password_no_new_one_can_be_set(self):
        # A visitor must not replace the owner's kept password with their own.
        admin = self._admin()
        self._post("/manage/access", dict(NO_PW, current_password="hunter22"), admin)
        self._as_peer(INTERNET)
        status, body = self._post("/manage/access", dict(PW, password="mine"))
        self.assertEqual((status, body.get("error")), (403, "open_locked"), body)
        self.assertEqual(self._state()["access"], "open")
        # Refused before anything was written: the owner's password is the one back.
        self._post("/manage/access", {"require_password": True})
        self.assertEqual(self._post("/login", {"username": "eric", "password": "mine"})[0], 401)
        self.assertEqual(self._post("/login", {"username": "eric", "password": "hunter22"})[0], 200)

    def test_with_a_kept_password_the_account_cannot_be_renamed(self):
        # A new name would leave the kept password logging in to nothing.
        admin = self._admin()
        self._post("/manage/access", dict(NO_PW, current_password="hunter22"), admin)
        self._as_peer(INTERNET)
        status, body = self._post("/manage/access", {"require_password": True, "username": "x"})
        self.assertEqual((status, body.get("error")), (403, "open_locked"), body)
        self.assertEqual(self._state()["access"], "open")
        self._post("/manage/access", {"require_password": True})
        self.assertEqual(self._post("/login", {"username": "eric", "password": "hunter22"})[0], 200)

    def test_with_none_kept_one_can_be_set(self):
        self._post("/manage/access", NO_PW)
        status, body = self._post("/manage/access", PW)
        self.assertEqual((status, body.get("access")), (200, "password"), body)

    def test_an_api_token_does_not_hold_the_password_on(self):
        """The API token is for programs, not the way into Manage: it neither
        blocks turning the password off nor goes when it does. Eric,
        2026-10-12: "other sites don't use the same consumer API to run their
        site backend so the token overlap doesn't happen"."""
        admin = self._admin()
        token = manage._generate_api_token()
        status, body = self._post("/manage/access", dict(NO_PW, current_password="hunter22"), admin)
        self.assertEqual(status, 200, body)
        self.assertEqual(manage._get_api_token(), token)
        self._post("/manage/access", {"require_password": True})
        self._as_peer(INTERNET)
        self.assertEqual(self._get("/manage/status", self._bearer(token))[0], 200)

    def test_the_environment_wins_and_locks_it(self):
        admin = self._admin()
        os.environ["ZIMI_MANAGE_OPEN"] = "0"
        status, body = self._post("/manage/access", dict(NO_PW, current_password="hunter22"), admin)
        self.assertEqual((status, body.get("var")), (403, "ZIMI_MANAGE_OPEN"), body)
        self.assertTrue(self._state(admin)["open_env"])
        os.environ.pop("ZIMI_MANAGE_OPEN")
        os.environ["ZIMI_MANAGE_EXTERNAL"] = "0"
        status, body = self._post("/manage/access", dict(NO_PW, current_password="hunter22"), admin)
        self.assertEqual((status, body.get("var")), (403, "ZIMI_MANAGE_EXTERNAL"), body)

    def test_nothing_made_while_it_is_off_outlives_it(self):
        """While anyone can manage Zimi, anyone could otherwise mint an API
        token, add an admin account or set a password that still works once
        the password is back on."""
        admin = self._admin()
        self._post("/manage/access", dict(NO_PW, current_password="hunter22"), admin)
        self._as_peer(INTERNET)
        for path, body in (
            ("/manage/generate-token", {}),
            ("/manage/users", {"action": "create", "name": "mallory", "password": "x" * 12, "role": "admin"}),
            ("/manage/set-password", {"password": "mallory-was-here", "current": ""}),
        ):
            status, got = self._post(path, body)
            self.assertEqual((status, got.get("error")), (403, "open_locked"), (path, got))

    def test_an_environment_that_forbids_it_closes_a_saved_one(self):
        admin = self._admin()
        self._post("/manage/access", dict(NO_PW, current_password="hunter22"), admin)
        self.assertTrue(manage.manage_open())
        os.environ["ZIMI_MANAGE_EXTERNAL"] = "0"
        self.assertFalse(manage.manage_open())
        os.environ.pop("ZIMI_MANAGE_EXTERNAL")
        self.assertFalse(manage.manage_open(), "and stays closed after")

    def test_zimi_manage_open_0_forbids_only_this_answer(self):
        admin = self._admin()
        os.environ["ZIMI_MANAGE_OPEN"] = "0"
        status, body = self._post("/manage/access", {"require_password": True}, admin)
        self.assertEqual(status, 200, body)

    def test_imports_of_private_addresses_stay_off_while_it_is_off(self):
        from zimi import library

        admin = self._admin()
        self._post("/manage/access", dict(NO_PW, current_password="hunter22"), admin)
        dl_id, err = library._start_import("https://10.0.0.1/wiki.zim")
        self.assertIsNone(dl_id)
        self.assertIn("private", err)

    def test_captures_of_private_addresses_stay_off_while_it_is_off(self):
        admin = self._admin()
        self.assertEqual(self._post("/manage/creator", {"allow_private": True}, admin)[0], 200)
        self.assertTrue(manage._create_allows_private())
        self._post("/manage/access", dict(NO_PW, current_password="hunter22"), admin)
        self.assertFalse(manage._create_allows_private())
        self.assertTrue(manage._creator_payload()["private_locked"])
        # The operator's own ZIMI_MANAGE_OPEN keeps their choice.
        os.environ["ZIMI_MANAGE_OPEN"] = "1"
        self.assertTrue(manage._create_allows_private())


class FreshInstallGateTests(_Harness):
    def test_a_fresh_reachable_install_waits_for_its_setup(self):
        self.assertTrue(manage.init_setup_gate("0.0.0.0"))
        self._as_peer(takeover.ADJACENT)
        self.assertEqual(self._get("/list"), (503, {"error": "setup_pending"}))
        self.assertTrue(self._state()["setup"])
        self._as_peer(INTERNET)
        self.assertEqual(self._get("/search?q=water")[0], 503)

    def test_the_host_and_the_key_holder_are_not_kept_waiting(self):
        manage.init_setup_gate("0.0.0.0")
        key = manage.ensure_setup_key()
        self.assertEqual(self._get("/list")[0], 200)
        self._as_peer(takeover.ADJACENT)
        self.assertEqual(self._get("/list", {"X-Zimi-Setup-Key": key})[0], 200)

    def test_finishing_setup_opens_it_and_a_restart_does_not_close_it(self):
        manage.init_setup_gate("0.0.0.0")
        self.assertEqual(self._post("/manage/access", PW)[0], 200)
        self._as_peer(takeover.ADJACENT)
        self.assertEqual(self._get("/list")[0], 200)
        manage._setup_gate = False
        self.assertFalse(manage.init_setup_gate("0.0.0.0"))

    def test_a_restart_before_setup_keeps_waiting(self):
        manage.init_setup_gate("0.0.0.0")
        manage.ensure_setup_key()
        manage._setup_gate = False
        self.assertTrue(manage.init_setup_gate("0.0.0.0"))

    def test_an_install_that_ran_before_never_waits(self):
        manage.ensure_setup_key()  # every passwordless start since 1.9 left one
        self.assertFalse(manage.init_setup_gate("0.0.0.0"))
        self._as_peer(takeover.ADJACENT)
        self.assertEqual(self._get("/list")[0], 200)

    def test_an_untouched_install_from_before_the_setup_key_never_waits(self):
        """Its metadata cache is all an old passwordless install that never
        opened settings leaves behind, in the data dir or the ZIM folder."""
        self.assertFalse(manage.init_setup_gate("0.0.0.0", ran_before=True))
        self.assertTrue(manage.init_setup_gate("0.0.0.0", ran_before=False))

    def test_this_machine_only_or_an_answer_in_the_environment_never_waits(self):
        self.assertFalse(manage.init_setup_gate("127.0.0.1"))
        os.environ["ZIMI_LAN_ADMIN"] = "1"
        self.assertFalse(manage.init_setup_gate("0.0.0.0"))


if __name__ == "__main__":
    unittest.main()
