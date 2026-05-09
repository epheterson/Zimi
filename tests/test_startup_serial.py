"""Startup must launch ONE worker thread for the index/warm phases, not five.

Why: the previous design fanned out 5 daemon threads (one with an internal
4-way ThreadPoolExecutor) that each opened Archive handles for every ZIM in
parallel. On a fragile host (RAID rebuild, lightweight system, many ZIMs)
that storms memory and I/O. Single-threaded ordered phases keep peak open
mmaps bounded regardless of ZIM count."""

import os
import sys
import threading
import time
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from zimi import server as _server  # noqa: E402


def _join_startup_worker(timeout=5.0):
    """Best-effort join on the named worker thread."""
    for t in threading.enumerate():
        if t.name == "zimi-startup-worker":
            t.join(timeout=timeout)
            return t
    return None


class StartupWorkerThreadCountTests(unittest.TestCase):
    def test_warm_indexes_spawns_single_named_worker(self):
        """warm_indexes() must launch ONE long-lived worker named
        'zimi-startup-worker', not 5 parallel ones. We intercept Thread()
        construction so we don't race with the worker finishing (which it
        does fast under test stubs)."""
        spawned_names = []
        real_thread = threading.Thread

        def _capturing_thread(*args, **kwargs):
            spawned_names.append(kwargs.get("name", ""))
            return real_thread(*args, **kwargs)

        with (
            mock.patch.object(_server, "get_zim_files", return_value={}),
            mock.patch.object(_server, "get_hot_zims", return_value=[]),
            mock.patch.object(_server, "_build_all_title_indexes", lambda: None),
            mock.patch.object(_server, "_build_all_qid_indexes", lambda: None),
            mock.patch.object(_server, "_suggest_cache_restore", return_value=0),
            mock.patch.object(
                _server.threading, "Thread", side_effect=_capturing_thread
            ),
        ):
            _server.warm_indexes()
            _join_startup_worker()

        worker_spawns = [n for n in spawned_names if n == "zimi-startup-worker"]
        self.assertEqual(
            len(worker_spawns),
            1,
            f"expected exactly 1 startup worker; spawned: {spawned_names}",
        )
        # And NO other threads spawned by warm_indexes itself.
        self.assertEqual(
            len(spawned_names),
            1,
            f"warm_indexes spawned extra threads: {spawned_names}",
        )


class StartupPhaseOrderingTests(unittest.TestCase):
    """The 5 phases (title-build, qid-build, suggest-warm, fts-warm, btree-warm)
    must run in order on a single thread — not concurrently."""

    def test_phases_run_serially_on_one_thread(self):
        events = []
        events_lock = threading.Lock()

        def _record(label):
            def _fn(*args, **kwargs):
                with events_lock:
                    events.append(("enter", label, threading.current_thread().name))
                time.sleep(0.01)  # widen overlap window
                with events_lock:
                    events.append(("exit", label, threading.current_thread().name))

            return _fn

        with (
            mock.patch.object(_server, "get_zim_files", return_value={}),
            mock.patch.object(_server, "get_hot_zims", return_value=[]),
            mock.patch.object(
                _server,
                "_build_all_title_indexes",
                side_effect=_record("title-build"),
            ),
            mock.patch.object(
                _server,
                "_build_all_qid_indexes",
                side_effect=_record("qid-build"),
            ),
            mock.patch.object(_server, "_suggest_cache_restore", return_value=0),
        ):
            _server.warm_indexes()
            _join_startup_worker()

        # All recorded events ran on the named worker thread, not multiple threads.
        thread_names = {t for _, _, t in events}
        self.assertEqual(
            thread_names,
            {"zimi-startup-worker"},
            f"expected only the named worker; saw threads {thread_names}",
        )

        # title-build must complete fully BEFORE qid-build starts.
        labels = [(kind, label) for kind, label, _ in events]
        self.assertIn(("enter", "title-build"), labels)
        self.assertIn(("exit", "title-build"), labels)
        self.assertIn(("enter", "qid-build"), labels)
        title_exit_idx = labels.index(("exit", "title-build"))
        qid_enter_idx = labels.index(("enter", "qid-build"))
        self.assertLess(
            title_exit_idx,
            qid_enter_idx,
            f"qid-build started before title-build finished: {labels}",
        )


if __name__ == "__main__":
    unittest.main()
