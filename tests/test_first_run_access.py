"""First run: who may change settings (#107), held to GHSA-5mw2-53vv-9pw6.

The setup page answers two things: may settings be changed from outside the
network, and is a password required (always, when the outside may). It is an
admin decision, so it is made through the same two doors as the first
password: the machine running Zimi, or a device that brings the one-time
setup key the server logged. An adjacent device on its own cannot make it, so
the advisory's race stays closed.

A fresh self-hosted install answers nothing else until it is made. An install
that ran before never waits.
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tests import test_bootstrap_takeover as takeover  # noqa: E402
from zimi import manage  # noqa: E402

INTERNET = "8.8.8.8"
LAN_ONLY = {"external": False, "require_password": False}
INSIDE_PW = {
    "external": False,
    "require_password": True,
    "username": "",
    "password": "hunter22",
}
ANYWHERE_PW = {
    "external": True,
    "require_password": True,
    "username": "eric",
    "password": "hunter22",
}
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
        status, body = self._post("/manage/access", LAN_ONLY)
        self.assertEqual(status, 403, body)
        self.assertTrue(body.get("needs_setup_key"), body)
        self.assertEqual(self._state()["access"], "unset")

    def test_the_host_chooses_no_password_and_the_lan_is_the_admin(self):
        status, body = self._post("/manage/access", LAN_ONLY)
        self.assertEqual((status, body.get("access")), (200, "lan"), body)
        self._as_peer(takeover.ADJACENT)
        self.assertEqual(self._get("/manage/status")[0], 200)
        self._as_peer(INTERNET)
        self.assertEqual(self._get("/manage/status")[0], 403)

    def test_the_key_holder_sets_it_up_from_another_device(self):
        key = manage.ensure_setup_key()
        self._as_peer(takeover.ADJACENT)
        status, body = self._post(
            "/manage/access", ANYWHERE_PW, {"X-Zimi-Setup-Key": key}
        )
        self.assertEqual(status, 200, body)
        self.assertEqual(body["access"], "password")
        self.assertTrue(body.get("token"), "the browser that set it is signed in")
        self.assertFalse(manage._read_setup_key(), "the key is spent")
        self.assertEqual(manage._get_manage_user(), "eric")

    def test_a_wrong_key_answers_nothing(self):
        manage.ensure_setup_key()
        self._as_peer(takeover.ADJACENT)
        status, _ = self._post(
            "/manage/access", LAN_ONLY, {"X-Zimi-Setup-Key": "AAAA-BBBB-CCCC"}
        )
        self.assertEqual(status, 403)
        self.assertEqual(self._state()["access"], "unset")

    def test_through_a_proxy_no_password_is_refused_rather_than_locking_you_out(self):
        key = manage.ensure_setup_key()
        hdr = {"X-Zimi-Setup-Key": key, "X-Forwarded-For": "192.0.2.7"}
        self.assertFalse(self._state(hdr)["direct"])
        status, body = self._post("/manage/access", LAN_ONLY, hdr)
        self.assertEqual((status, body.get("error")), (409, "behind_proxy"), body)
        status, body = self._post("/manage/access", INSIDE_PW, hdr)
        self.assertEqual(status, 200, body)

    def test_the_outside_needs_a_password(self):
        status, body = self._post(
            "/manage/access", {"external": True, "require_password": False}
        )
        self.assertEqual((status, body.get("error")), (400, "needs_password"), body)
        self.assertEqual(self._state()["access"], "unset")

    def test_inside_only_walls_off_the_internet_even_with_the_password(self):
        token = self._post("/manage/access", INSIDE_PW)[1]["token"]
        self._as_peer(takeover.ADJACENT)
        self.assertEqual(self._get("/manage/status", self._bearer(token))[0], 200)
        self._as_peer(INTERNET)
        status, body = self._get("/manage/status", self._bearer(token))
        self.assertEqual((status, body.get("error")), (403, "outside_network"), body)
        status, body = self._post("/login", {"username": "admin", "password": "hunter22"})
        self.assertEqual((status, body.get("error")), (403, "outside_network"), body)

    def test_inside_only_walls_off_manage_but_not_create(self):
        """Eric, 2026-10-09: "Create has nothing to do with manage." The
        Creator section's defaults are settings and stay inside; Create's own
        routes are using the app and answer from anywhere."""
        token = self._post("/manage/access", INSIDE_PW)[1]["token"]
        self._as_peer(INTERNET)
        status, body = self._get("/manage/creator", self._bearer(token))
        self.assertEqual((status, body.get("error")), (403, "outside_network"), body)
        status, body = self._post("/manage/creator", {"delay": 1}, self._bearer(token))
        self.assertEqual((status, body.get("error")), (403, "outside_network"), body)
        status, body = self._get("/manage/create/log", self._bearer(token))
        self.assertNotEqual(body.get("error"), "outside_network", body)

    def test_anywhere_lets_the_password_in_from_outside(self):
        token = self._post("/manage/access", ANYWHERE_PW)[1]["token"]
        self._as_peer(INTERNET)
        self.assertEqual(self._get("/manage/status", self._bearer(token))[0], 200)
        self.assertEqual(self._get("/manage/status")[0], 401)

    def test_a_password_from_before_the_setup_page_still_works_from_outside(self):
        manage._set_manage_password("hunter22")
        self.assertTrue(manage.manage_external())
        self._as_peer(INTERNET)
        status, body = self._post("/login", {"username": "admin", "password": "hunter22"})
        self.assertEqual(status, 200, body)

    def test_a_password_ends_anyone_on_my_network(self):
        self._post("/manage/access", LAN_ONLY)
        status, _ = self._post("/manage/set-password", {"password": "hunter22"})
        self.assertEqual(status, 200)
        self.assertEqual(self._state()["access"], "password")
        self._as_peer(takeover.ADJACENT)
        self.assertEqual(self._get("/manage/status")[0], 401)

    def test_after_setup_only_the_admin_changes_it(self):
        token = self._post("/manage/access", INSIDE_PW)[1]["token"]
        self._as_peer(takeover.ADJACENT)
        self.assertEqual(self._post("/manage/access", ANYWHERE_PW)[0], 401)
        moved = dict(ANYWHERE_PW, password="")
        status, body = self._post("/manage/access", moved, self._bearer(token))
        self.assertEqual(status, 200, body)
        self.assertTrue(self._state(self._bearer(token))["external"])
        self.assertEqual(
            manage._get_manage_user(), "eric", "the username is edited in place"
        )

    def test_only_the_admin_sees_the_username(self):
        token = self._post("/manage/access", ANYWHERE_PW)[1]["token"]
        self.assertEqual(self._state()["username"], "")
        self.assertEqual(self._state(self._bearer(token))["username"], "eric")

    def test_the_environment_has_the_last_word(self):
        os.environ["ZIMI_LAN_ADMIN"] = "0"
        self.assertEqual(self._post("/manage/access", LAN_ONLY)[0], 403)
        self.assertTrue(self._state()["access_env"])
        os.environ.pop("ZIMI_LAN_ADMIN")
        os.environ["ZIMI_MANAGE_EXTERNAL"] = "1"
        status, body = self._post("/manage/access", INSIDE_PW)
        self.assertEqual((status, body.get("var")), (403, "ZIMI_MANAGE_EXTERNAL"), body)
        self.assertEqual(self._post("/manage/access", ANYWHERE_PW)[0], 200)


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
        self.assertEqual(self._post("/manage/access", INSIDE_PW)[0], 200)
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
