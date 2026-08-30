"""One size, one string — in both languages.

Zimi used to divide bytes by 1024 and print "GB". At the sizes it deals in
that is not a rounding quibble: wikipedia_en_all_maxi is 123,980,647,016
bytes, which the UI called 115 GB while the NAS, Finder, df and the Kiwix
library page it was downloaded from all called it 124 GB. Nine gigabytes of
disagreement on the row whose job is answering "will this fit" — and the app
held FIVE hand-rolled formatters that did not agree with each other either.

There is now one rule, written once per language, and this holds the two to a
shared table. A change to either that is not a change to both fails here.
"""

import json
import os
import re
import subprocess
import unittest

import zimi.server as server

HERE = os.path.dirname(os.path.abspath(__file__))
TABLE = os.path.join(HERE, "size_table.json")
APP_JS = os.path.join(HERE, "..", "zimi", "static", "app.js")


def _cases():
    with open(TABLE, encoding="utf-8") as f:
        return [(int(n), s) for n, s in json.load(f)["cases"]]


class TestPythonFormatsSizes(unittest.TestCase):
    def test_every_case_in_the_table(self):
        for n, want in _cases():
            with self.subTest(bytes=n):
                self.assertEqual(server.format_bytes(n), want)

    def test_the_units_are_decimal(self):
        """The whole point. A kB is 1000 bytes, not 1024."""
        self.assertEqual(server._BYTES_PER_KB, 1000)
        self.assertEqual(server._BYTES_PER_MB, 1000**2)
        self.assertEqual(server._BYTES_PER_GB, 1000**3)

    def test_nothing_negative_or_absent_crashes(self):
        for bad in (None, -1, "", 0.4):
            self.assertTrue(server.format_bytes(bad).endswith("B"))


class TestTheBrowserAgrees(unittest.TestCase):
    """The same table, run through app.js's fmtBytes in node.

    Skipped rather than failed when node is absent, so a machine without it can
    still run the suite — CI has node and runs the .cjs tests beside this one.
    """

    def test_fmtBytes_matches_python_exactly(self):
        if not _have_node():
            self.skipTest("node not available")
        with open(APP_JS, encoding="utf-8") as f:
            src = f.read()
        # The formatter and its constants, lifted out on their own: app.js as a
        # whole needs a browser, and this needs no more than the arithmetic.
        start = src.index("var BYTES_PER_KB")
        end = src.index("function fmtSize(")
        block = src[start:end]
        self.assertIn("function fmtBytes", block, "fmtBytes moved — update this test")

        cases = _cases()
        script = (
            block
            + "\nconst cases = " + json.dumps([[n, s] for n, s in cases]) + ";\n"
            + "const bad = cases.filter(([n, want]) => fmtBytes(n) !== want)"
            + ".map(([n, want]) => n + ': got ' + fmtBytes(n) + ', want ' + want);\n"
            + "console.log(JSON.stringify(bad));\n"
        )
        out = subprocess.run(
            ["node", "-e", script], capture_output=True, text=True, timeout=60
        )
        self.assertEqual(out.returncode, 0, out.stderr)
        mismatches = json.loads(out.stdout.strip())
        self.assertEqual(mismatches, [], "browser and server disagree: " + str(mismatches))


class TestNobodyDividesByHand(unittest.TestCase):
    """A sixth formatter is how the first five happened.

    Guards the shipped client: any reappearance of 1048576, 1073741824 or
    `1024 ** 2/3` in app.js or create.js means somebody has started computing
    a size beside the one function that is allowed to.
    """

    BINARY = re.compile(r"1048576|1073741824|1024\s*\*\*\s*[23]|/\s*\(1024\s*\*\s*1024")

    def test_the_client_has_one_size_formatter(self):
        for name in ("app.js", "create.js"):
            path = os.path.join(HERE, "..", "zimi", "static", name)
            with open(path, encoding="utf-8") as f:
                lines = f.read().splitlines()
            offenders = [
                f"{name}:{i}: {ln.strip()[:70]}"
                for i, ln in enumerate(lines, 1)
                if self.BINARY.search(ln) and "MAX_" not in ln and "port" not in ln
            ]
            self.assertEqual(offenders, [], "hand-rolled size math: " + str(offenders))


def _have_node():
    try:
        subprocess.run(["node", "--version"], capture_output=True, timeout=10)
        return True
    except (OSError, subprocess.SubprocessError):
        return False


if __name__ == "__main__":
    unittest.main()


class TestADerivedSizeIsNeverCached(unittest.TestCase):
    """size_gb is a view of size_bytes, and views do not go in caches.

    When the unit changed, 43 of 67 ZIMs on the live server went on serving the
    old binary size_gb straight from .zimi_cache.json while freshly scanned
    ones served decimal — the library quoting two different numbers for the
    same kind of thing, which is the exact complaint the change set out to fix.
    Deleting the cache would have papered over it; not storing a derived value
    means it cannot happen again.
    """

    def test_the_cache_hit_path_recomputes_rather_than_reads(self):
        src = open(os.path.join(HERE, "..", "zimi", "server.py"), encoding="utf-8").read()
        self.assertNotIn(
            'cached.get("size_gb"',
            src,
            "size_gb is being read from the metadata cache again — derive it "
            "from size_bytes, which is the fact and is free from stat()",
        )

    def test_a_stale_unit_in_the_cache_is_ignored(self):
        """The regression, exactly: an entry cached under the old binary rule."""
        size = 123980647016
        stale = {"size_gb": round(size / 1024**3, 3), "entries": 7}  # 115.466
        self.assertNotAlmostEqual(stale["size_gb"], round(size / 1000**3, 3), places=1)
        # What the scan must produce for that same file, whatever the cache says.
        self.assertAlmostEqual(round(size / server._BYTES_PER_GB, 3), 123.981, places=3)
        self.assertEqual(server.format_bytes(size), "124 GB")
