"""UUID-based staleness checks for SQLite indexes (title + Q-ID).

Why UUID over mtime: mtime changes on file redownload, backup restore, or
metadata-touching filesystem operations even when content is identical.
ZIM's stable UUID is content-addressed — same content = same UUID."""

import os
import shutil
import sqlite3
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from zimi import search as _search  # noqa: E402


class _FakeArchive:
    """Stand-in for libzim Archive with just a uuid attribute."""

    def __init__(self, uuid):
        self.uuid = uuid


class IndexStalenessUUIDTests(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.mkdtemp(prefix="zimi-stale-")
        self.zim_path = os.path.join(self.tmpdir, "fake.zim")
        with open(self.zim_path, "wb") as f:
            f.write(b"\0" * 1024)
        self.db_path = os.path.join(self.tmpdir, "fake.db")
        self.schema_version = "4"

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def _build_db(self, *, schema_version, zim_uuid=None, zim_mtime=None):
        conn = sqlite3.connect(self.db_path)
        conn.execute("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)")
        conn.execute("INSERT INTO meta VALUES ('schema_version', ?)", (schema_version,))
        if zim_uuid is not None:
            conn.execute("INSERT INTO meta VALUES ('zim_uuid', ?)", (zim_uuid,))
        if zim_mtime is not None:
            conn.execute("INSERT INTO meta VALUES ('zim_mtime', ?)", (zim_mtime,))
        conn.commit()
        conn.close()

    def _patch_archive(self, uuid):
        """Patch _srv.open_archive used in search.py to return our fake."""
        return mock.patch.object(
            _search._srv, "open_archive", lambda path: _FakeArchive(uuid)
        )

    def test_uuid_match_is_current(self):
        self._build_db(schema_version=self.schema_version, zim_uuid="abc-123")
        with self._patch_archive("abc-123"):
            self.assertTrue(
                _search._index_is_current(
                    self.db_path, self.zim_path, self.schema_version
                )
            )

    def test_uuid_mismatch_not_current(self):
        self._build_db(schema_version=self.schema_version, zim_uuid="old-uuid")
        with self._patch_archive("new-uuid"):
            self.assertFalse(
                _search._index_is_current(
                    self.db_path, self.zim_path, self.schema_version
                )
            )

    def test_schema_mismatch_not_current_even_if_uuid_matches(self):
        self._build_db(schema_version="3", zim_uuid="abc")
        with self._patch_archive("abc"):
            self.assertFalse(
                _search._index_is_current(
                    self.db_path, self.zim_path, self.schema_version
                )
            )

    def test_legacy_index_with_matching_mtime_is_current_and_backfills_uuid(self):
        """An index built before UUID tracking should be honored if mtime
        still matches, AND the UUID should be backfilled into meta so we
        only pay the libzim open once."""
        zim_mtime = str(os.path.getmtime(self.zim_path))
        self._build_db(schema_version=self.schema_version, zim_mtime=zim_mtime)
        with self._patch_archive("backfilled-uuid"):
            self.assertTrue(
                _search._index_is_current(
                    self.db_path, self.zim_path, self.schema_version
                )
            )
        # Verify backfill landed in meta
        conn = sqlite3.connect(self.db_path)
        try:
            row = conn.execute("SELECT value FROM meta WHERE key='zim_uuid'").fetchone()
            self.assertEqual(row[0], "backfilled-uuid")
        finally:
            conn.close()

    def test_legacy_index_with_mtime_mismatch_not_current(self):
        self._build_db(schema_version=self.schema_version, zim_mtime="9999999999")
        with self._patch_archive("any-uuid"):
            self.assertFalse(
                _search._index_is_current(
                    self.db_path, self.zim_path, self.schema_version
                )
            )

    def test_redownload_same_content_same_uuid_no_rebuild(self):
        """The whole point of UUID-based staleness: redownloading the same
        ZIM bumps mtime but content (and thus UUID) is unchanged. No rebuild."""
        self._build_db(schema_version=self.schema_version, zim_uuid="stable-uuid")
        # Simulate redownload: mtime changes, content identical
        os.utime(self.zim_path, (1234567890, 1234567890))
        with self._patch_archive("stable-uuid"):
            self.assertTrue(
                _search._index_is_current(
                    self.db_path, self.zim_path, self.schema_version
                )
            )

    def test_uuid_read_failure_falls_back_safely(self):
        """If libzim can't open the file at staleness-check time, we should
        return False (treat as needing rebuild) rather than crash."""
        self._build_db(schema_version=self.schema_version, zim_uuid="abc")

        def _broken_open(path):
            raise RuntimeError("simulated libzim failure")

        with mock.patch.object(_search._srv, "open_archive", _broken_open):
            self.assertFalse(
                _search._index_is_current(
                    self.db_path, self.zim_path, self.schema_version
                )
            )


if __name__ == "__main__":
    unittest.main()
