#!/usr/bin/env python3
"""Finding the browser SingleFile should drive.

This reported "Chromium executable not found" on a NAS that had two Chromium
builds sitting in /ms-playwright. The lookup called `sync_playwright()` purely
to read `executable_path`, which starts a driver subprocess; that context threw
on teardown, the surrounding except swallowed it, and SingleFile was handed
nothing. Naming a file should not require launching anything, so it reads the
directory instead.
"""

import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi.singlefile as sf  # noqa: E402


class TestChromiumPath(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="zimi-pw-")
        self._saved = os.environ.get("PLAYWRIGHT_BROWSERS_PATH")
        os.environ["PLAYWRIGHT_BROWSERS_PATH"] = self.root

    def tearDown(self):
        import shutil

        if self._saved is None:
            os.environ.pop("PLAYWRIGHT_BROWSERS_PATH", None)
        else:
            os.environ["PLAYWRIGHT_BROWSERS_PATH"] = self._saved
        shutil.rmtree(self.root, ignore_errors=True)

    def _install(self, build, suffix):
        path = os.path.join(self.root, build, suffix)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as f:
            f.write(b"#!/bin/sh\n")
        return path

    def test_a_full_chromium_is_found(self):
        want = self._install("chromium-1234", "chrome-linux64/chrome")
        self.assertEqual(sf.chromium_path(), want)

    def test_the_newest_build_wins(self):
        """An upgrade leaves the old revision behind; the renderer uses the new
        one, and handing SingleFile the old one would mean two browsers."""
        self._install("chromium-1100", "chrome-linux64/chrome")
        newest = self._install("chromium-1234", "chrome-linux64/chrome")
        self.assertEqual(sf.chromium_path(), newest)

    def test_a_full_chromium_beats_the_headless_shell(self):
        self._install(
            "chromium_headless_shell-1234",
            "chrome-headless-shell-linux64/chrome-headless-shell",
        )
        full = self._install("chromium-1234", "chrome-linux64/chrome")
        self.assertEqual(sf.chromium_path(), full)

    def test_the_headless_shell_is_used_when_it_is_all_there_is(self):
        """Modern `playwright install` can leave only the stripped build. It is
        still a browser SingleFile can drive, and refusing it would fail on a
        machine that can plainly do the job."""
        shell = self._install(
            "chromium_headless_shell-1208",
            "chrome-headless-shell-mac-x64/chrome-headless-shell",
        )
        self.assertEqual(sf.chromium_path(), shell)

    def test_an_empty_install_falls_through_to_the_path(self):
        self.assertIn(sf.chromium_path(), ("", sf.shutil.which("chromium") or ""))

    def test_a_missing_directory_is_not_an_error(self):
        os.environ["PLAYWRIGHT_BROWSERS_PATH"] = os.path.join(self.root, "nope")
        sf.chromium_path()  # must not raise

    def test_nothing_is_launched_to_answer(self):
        """The regression: this used to start a Playwright driver to read a
        path, and the driver's teardown is what failed."""
        import inspect

        source = inspect.getsource(sf.chromium_path)
        self.assertNotIn("sync_playwright", source)


if __name__ == "__main__":
    unittest.main()
