"""Loadavg-based throttle: yield to a stressed host during index builds.

The throttle exists so Zimi doesn't pile on top of an already-loaded system
(e.g., NAS during a RAID rebuild). It reads 5-min loadavg, compares to
nproc * threshold, and sleeps proportionally. No-op when load is low or
when the platform doesn't expose getloadavg."""

import os
import sys
import time
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from zimi import search as _search  # noqa: E402


class LoadavgThrottleTests(unittest.TestCase):
    def test_no_sleep_when_load_below_threshold(self):
        with (
            mock.patch.object(os, "getloadavg", return_value=(0.1, 0.1, 0.1)),
            mock.patch.object(os, "cpu_count", return_value=4),
            mock.patch.object(time, "sleep") as sleep_mock,
        ):
            _search._loadavg_throttle(threshold_ratio=0.8, max_sleep=2.0)
        sleep_mock.assert_not_called()

    def test_sleeps_when_load_exceeds_threshold(self):
        # 5-min load 4.0 / 4 cpus = 1.0 ratio. Above 0.8 threshold by 0.2.
        # Expected sleep = (1.0 - 0.8) * 2.0 = 0.4s.
        with (
            mock.patch.object(os, "getloadavg", return_value=(4.0, 4.0, 4.0)),
            mock.patch.object(os, "cpu_count", return_value=4),
            mock.patch.object(time, "sleep") as sleep_mock,
        ):
            _search._loadavg_throttle(threshold_ratio=0.8, max_sleep=2.0)
        sleep_mock.assert_called_once()
        slept = sleep_mock.call_args[0][0]
        self.assertAlmostEqual(slept, 0.4, places=2)

    def test_sleep_capped_at_max(self):
        # Massive overload: ratio = 10. Cap to max_sleep.
        with (
            mock.patch.object(os, "getloadavg", return_value=(40.0, 40.0, 40.0)),
            mock.patch.object(os, "cpu_count", return_value=4),
            mock.patch.object(time, "sleep") as sleep_mock,
        ):
            _search._loadavg_throttle(threshold_ratio=0.8, max_sleep=2.0)
        slept = sleep_mock.call_args[0][0]
        self.assertEqual(slept, 2.0)

    def test_no_op_when_getloadavg_unavailable(self):
        # Simulate Windows: AttributeError on os.getloadavg.
        with (
            mock.patch.object(os, "getloadavg", side_effect=AttributeError),
            mock.patch.object(time, "sleep") as sleep_mock,
        ):
            _search._loadavg_throttle()
        sleep_mock.assert_not_called()

    def test_disabled_via_env_var(self):
        with (
            mock.patch.dict(os.environ, {"ZIMI_INDEX_THROTTLE": "0"}, clear=False),
            mock.patch.object(os, "getloadavg", return_value=(99.0, 99.0, 99.0)),
            mock.patch.object(os, "cpu_count", return_value=1),
            mock.patch.object(time, "sleep") as sleep_mock,
        ):
            _search._loadavg_throttle()
        sleep_mock.assert_not_called()


if __name__ == "__main__":
    unittest.main()
