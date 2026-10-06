"""First run: who may change settings (#107), held to GHSA-5mw2-53vv-9pw6.

"Anyone on my network" is an admin decision, so it is made through the same
two doors as the first password: the machine running Zimi, or a device that
brings the one-time setup key the server logged. An adjacent device on its
own cannot make it, so the advisory's race stays closed. Once made, a direct
LAN client is the admin with nothing to type, the internet and anything
through a proxy stay locked out, and setting a password ends it.
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tests import test_bootstrap_takeover as takeover  # noqa: E402
from zimi import manage  # noqa: E402

INTERNET = "8.8.8.8"


class FirstRunAccessTests(unittest.TestCase):
    # The takeover tests' server and helpers, without their tests.
    _as_peer = takeover.BootstrapTakeoverTests._as_peer
    _post = takeover.BootstrapTakeoverTests._post
    _get = takeover.BootstrapTakeoverTests._get

    def setUp(self):
        os.environ.pop("ZIMI_LAN_ADMIN", None)
        os.environ.pop("ZIMI_MANAGE_OPEN", None)
        takeover.BootstrapTakeoverTests.setUp(self)

    def tearDown(self):
        os.environ.pop("ZIMI_LAN_ADMIN", None)
        takeover.BootstrapTakeoverTests.tearDown(self)

    def _access(self):
        return self._get("/manage/has-password")[1]["access"]

    def test_a_neighbour_cannot_choose_anyone_on_my_network(self):
        manage.ensure_setup_key()
        self._as_peer(takeover.ADJACENT)
        status, body = self._post("/manage/access", {"mode": "lan"})
        self.assertEqual(status, 403, body)
        self.assertTrue(body.get("needs_setup_key"), body)
        self.assertEqual(self._access(), "unset")

    def test_the_host_chooses_and_the_lan_is_the_admin(self):
        self.assertEqual(self._access(), "unset")
        status, body = self._post("/manage/access", {"mode": "lan"})
        self.assertEqual(status, 200, body)
        self.assertEqual(body["access"], "lan")
        self._as_peer(takeover.ADJACENT)
        self.assertEqual(self._get("/manage/status")[0], 200)
        self._as_peer(INTERNET)
        self.assertEqual(self._get("/manage/status")[0], 403)

    def test_the_key_holder_chooses_from_another_device(self):
        key = manage.ensure_setup_key()
        self._as_peer(takeover.ADJACENT)
        status, body = self._post("/manage/access", {"mode": "lan"}, {"X-Zimi-Setup-Key": key})
        self.assertEqual(status, 200, body)
        self.assertFalse(manage._read_setup_key(), "the key is spent")

    def test_a_wrong_key_chooses_nothing(self):
        manage.ensure_setup_key()
        self._as_peer(takeover.ADJACENT)
        status, _ = self._post("/manage/access", {"mode": "lan"}, {"X-Zimi-Setup-Key": "AAAA-BBBB-CCCC"})
        self.assertEqual(status, 403)
        self.assertEqual(self._access(), "unset")

    def test_through_a_proxy_it_is_refused_rather_than_locking_you_out(self):
        key = manage.ensure_setup_key()
        status, body = self._post(
            "/manage/access", {"mode": "lan"}, {"X-Zimi-Setup-Key": key, "X-Forwarded-For": "10.0.0.7"}
        )
        self.assertEqual((status, body.get("error")), (409, "behind_proxy"), body)
        self.assertEqual(self._access(), "unset")

    def test_a_password_ends_it(self):
        self._post("/manage/access", {"mode": "lan"})
        status, _ = self._post("/manage/set-password", {"password": "hunter22"})
        self.assertEqual(status, 200)
        self.assertEqual(self._access(), "password")
        self._as_peer(takeover.ADJACENT)
        self.assertEqual(self._get("/manage/status")[0], 401)

    def test_the_env_var_has_the_last_word(self):
        os.environ["ZIMI_LAN_ADMIN"] = "0"
        status, _ = self._post("/manage/access", {"mode": "lan"})
        self.assertEqual(status, 403)
        self.assertTrue(self._get("/manage/has-password")[1]["access_env"])


if __name__ == "__main__":
    unittest.main()
