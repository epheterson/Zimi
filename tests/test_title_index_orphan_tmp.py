"""A build killed halfway does not break the next one.

Found on the NAS copy: the `maps` title index failed with "table titles
already exists" on every start. A build stopped by SIGKILL (a container
restart) leaves `<name>.db.tmp` behind; the next start connects to that file,
finds the table, and fails. The orphan sweep ran only after the build loop,
so it never got the chance.
"""

import os
import shutil
import sqlite3
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from test_nonlatin_redirect import _build  # noqa: E402
from zimi import search as _search  # noqa: E402
from zimi import server as _server  # noqa: E402


class OrphanTmpTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="zimi-orphan-")
        self.zim = os.path.join(self.tmp, "fixture.zim")
        _build(self.zim)
        self.patch = mock.patch.object(_server, "ZIMI_DATA_DIR", self.tmp)
        self.patch.start()
        os.makedirs(_search._title_index_dir(), exist_ok=True)
        self.db = _search._title_index_path("fixture")

    def tearDown(self):
        _search._close_title_db("fixture")
        self.patch.stop()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_build_succeeds_over_a_killed_builds_tmp(self):
        # What a killed build leaves: the table made, no rows, no meta.
        conn = sqlite3.connect(self.db + ".tmp")
        conn.execute(
            "CREATE TABLE titles (path TEXT PRIMARY KEY, title TEXT, title_lower TEXT)"
        )
        conn.commit()
        conn.close()

        _search._build_title_index("fixture", self.zim)

        self.assertTrue(os.path.exists(self.db))
        self.assertFalse(os.path.exists(self.db + ".tmp"))
        conn = sqlite3.connect(self.db)
        try:
            self.assertGreater(
                conn.execute("SELECT COUNT(*) FROM titles").fetchone()[0], 0
            )
        finally:
            conn.close()


if __name__ == "__main__":
    unittest.main()


class RedirectTitleTests(unittest.TestCase):
    """An article is found under its other names (#86, reopened on 1.10.2).

    "العائلة اللغوية" redirects to "أسرة لغات" in wikipedia_ar_top_maxi, and
    Kiwix's search finds it. The title index skipped every redirect, and once
    1.10.2 stopped sending a quick search with no title match to libzim's
    suggestions (the slow path that did include redirects), the other names
    found nothing."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="zimi-redirect-")
        self.zim = os.path.join(self.tmp, "fixture.zim")
        _build(self.zim)
        self.patch = mock.patch.object(_server, "ZIMI_DATA_DIR", self.tmp)
        self.patch.start()
        _search._close_title_db("fixture")
        _search._build_title_index("fixture", self.zim)

    def tearDown(self):
        _search._close_title_db("fixture")
        self.patch.stop()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_a_redirect_title_is_found(self):
        from test_nonlatin_redirect import TARGET

        found = _search._title_index_search("fixture", "العائلة اللغوية")
        self.assertEqual([r["path"] for r in found], [TARGET])

    def test_a_cyrillic_redirect_title_is_found(self):
        from test_nonlatin_redirect import CYRILLIC_TARGET

        found = _search._title_index_search("fixture", "Семья языков")
        self.assertEqual([r["path"] for r in found], [CYRILLIC_TARGET])
