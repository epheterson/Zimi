#!/usr/bin/env python3
"""What a ZIM is made of, for a ZIM nobody here made.

The composition bar was born on the create page, where the ZIM had just been
written and its shape was already in hand. Eric wanted it on every ZIM in the
library: "I want the file breakdown bar chart in about this zim for all zims."

An installed ZIM carries no such record, so the shape has to be read off the
file — and the file may be English Wikipedia. Walking six million entries means
six million item lookups, each a seek somewhere in ninety gigabytes, on the
spinning disks these libraries actually live on. Nobody holds a panel open for
that.

The bar asks about PROPORTION, though, and proportion is what a sample answers.
So: exact below a threshold, sampled above it, and the sample is read in RUNS
of consecutive ids rather than scattered — entries near each other in id order
are near each other on disk, so sixty runs of a hundred cost about sixty seeks
where six thousand scattered reads would cost six thousand.

Four things are pinned here, and the third is the one that matters most:

  * the sampler covers the whole id space, in order, without repeats;
  * a small ZIM is still measured exactly, because sampling one is pointless;
  * a sampled answer SAYS it is sampled. An estimate printed in the same voice
    as a measurement is the exact failure this release spent a day removing;
  * and the answer is memoized PER ZIM, against the file's own identity, so a
    library is measured once — but a ZIM replaced under the same name is a
    different file and gets measured again. (Eric asked whether the bar is
    cached per ZIM. It is, and the half of that worth testing is not the hit,
    it is the miss: a cache that never invalidates is how the icon ETag two
    directories over came to serve a week-old picture.)
"""

import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from zimi.zimwriter import (  # noqa: E402
    SHAPE_SAMPLE_ENTRIES,
    SHAPE_SAMPLE_RUNS,
    _sample_ids,
)


class TestSampleIds(unittest.TestCase):
    def ids(self, entry_count, sample=SHAPE_SAMPLE_ENTRIES, runs=SHAPE_SAMPLE_RUNS):
        return list(_sample_ids(entry_count, sample, runs))

    def test_every_id_is_in_range(self):
        got = self.ids(6_400_000)
        self.assertTrue(got)
        self.assertGreaterEqual(min(got), 0)
        self.assertLess(max(got), 6_400_000)

    def test_ids_are_unique(self):
        """A repeated entry is counted twice and skews its bucket."""
        got = self.ids(6_400_000)
        self.assertEqual(len(got), len(set(got)))

    def test_ids_go_forwards(self):
        """The reason the sample is cheap: the read walks forward through the
        file instead of jumping back and forth across it."""
        got = self.ids(6_400_000)
        self.assertEqual(got, sorted(got))

    def test_the_sample_is_about_the_size_asked_for(self):
        got = self.ids(6_400_000)
        self.assertLessEqual(len(got), SHAPE_SAMPLE_ENTRIES)
        self.assertGreater(len(got), SHAPE_SAMPLE_ENTRIES * 0.8)

    def test_the_sample_is_read_in_runs(self):
        """Sixty seeks, not six thousand. Counting the breaks in the sequence
        is what actually distinguishes this from random sampling — and random
        sampling is what makes it unusable on a spinning disk."""
        got = self.ids(6_400_000)
        breaks = sum(1 for a, b in zip(got, got[1:]) if b != a + 1)
        self.assertLessEqual(breaks, SHAPE_SAMPLE_RUNS)

    def test_the_whole_file_is_covered(self):
        """A sample drawn from the first tenth would describe the first tenth.
        ZIMs are not homogeneous — articles and images cluster."""
        n = 6_400_000
        got = self.ids(n)
        self.assertLess(min(got), n * 0.02, "the sample never reaches the start")
        self.assertGreater(max(got), n * 0.95, "the sample never reaches the end")

    def test_a_small_count_is_covered_without_repeats(self):
        """The runs must not overlap when the file has fewer entries than the
        sample wants — the naive stride does exactly that."""
        for n in (1, 2, 7, 59, 61, 1000, 5999, 6001):
            got = self.ids(n)
            self.assertEqual(len(got), len(set(got)), f"repeats at entry_count={n}")
            self.assertTrue(all(0 <= i < n for i in got), f"out of range at {n}")
            self.assertEqual(got, sorted(got), f"out of order at {n}")

    def test_a_tiny_file_is_covered_entirely(self):
        self.assertEqual(self.ids(5), [0, 1, 2, 3, 4])

    def test_one_run_is_legal(self):
        got = self.ids(1000, sample=10, runs=1)
        self.assertEqual(got, list(range(10)))


class _FakeItem:
    def __init__(self, mimetype, size):
        self.mimetype = mimetype
        self.size = size


class _FakeEntry:
    def __init__(self, mimetype, size, redirect=False):
        self._item = _FakeItem(mimetype, size)
        self.is_redirect = redirect

    def get_item(self):
        return self._item


class _FakeArchive:
    """A ZIM whose composition is known exactly, so an estimate can be checked
    against the truth it is estimating."""

    def __init__(self, entries):
        self._entries = entries
        self.entry_count = len(entries)

    def _get_entry_by_id(self, i):
        return self._entries[i]


class TestBreakdown(unittest.TestCase):
    """Drive zim_content_breakdown against a fake archive, so the sampling
    arithmetic is checked without needing a 90 GB file to hand."""

    def _breakdown(self, entries, exact_max, path="/fake/x.zim"):
        import zimi.zimwriter as zw

        archive = _FakeArchive(entries)

        class _FakeReader:
            Archive = staticmethod(lambda p: archive)

        real_import = (
            __builtins__["__import__"] if isinstance(__builtins__, dict) else __import__
        )

        def fake_import(name, *a, **kw):
            if name == "libzim.reader":
                return _FakeReader
            return real_import(name, *a, **kw)

        import builtins

        saved_import, saved_getsize = builtins.__import__, os.path.getsize
        builtins.__import__ = fake_import
        os.path.getsize = lambda p: 1_000_000
        try:
            return zw.zim_content_breakdown(path, exact_max=exact_max)
        finally:
            builtins.__import__ = saved_import
            os.path.getsize = saved_getsize

    def test_a_small_zim_is_measured_exactly(self):
        entries = [_FakeEntry("image/png", 100) for _ in range(50)]
        entries += [_FakeEntry("text/html", 10) for _ in range(50)]
        shape = self._breakdown(entries, exact_max=1000)
        self.assertNotIn("sampled", shape)
        self.assertEqual(shape["entries"], 100)
        by = {b["key"]: b for b in shape["breakdown"]}
        self.assertEqual(by["images"]["size_bytes"], 5000)
        self.assertEqual(by["images"]["count"], 50)

    def test_redirects_are_not_counted_as_content(self):
        entries = [_FakeEntry("text/html", 10) for _ in range(10)]
        entries += [_FakeEntry("text/html", 10, redirect=True) for _ in range(90)]
        shape = self._breakdown(entries, exact_max=1000)
        self.assertEqual(shape["entries"], 10)

    def test_a_large_zim_says_it_was_sampled(self):
        """The honesty requirement, and it is not decoration: the panel prints
        this, so a reader can tell an estimate from a measurement."""
        entries = [_FakeEntry("image/png", 100) for _ in range(50_000)]
        shape = self._breakdown(entries, exact_max=1000)
        self.assertTrue(shape["sampled"])
        self.assertEqual(shape["total_entries"], 50_000)
        self.assertLess(shape["sampled_entries"], 50_000)
        self.assertGreater(shape["sampled_entries"], 0)

    def test_a_sampled_total_is_scaled_to_the_whole_file(self):
        """Reading a sixtieth of the entries and reporting a sixtieth of the
        bytes would draw a correct-looking bar under a wrong total."""
        entries = [_FakeEntry("image/png", 100) for _ in range(50_000)]
        shape = self._breakdown(entries, exact_max=1000)
        by = {b["key"]: b for b in shape["breakdown"]}
        # Truth is 50,000 × 100 = 5,000,000 bytes across 50,000 entries.
        self.assertAlmostEqual(by["images"]["size_bytes"] / 5_000_000, 1.0, delta=0.05)
        self.assertAlmostEqual(by["images"]["count"] / 50_000, 1.0, delta=0.05)
        self.assertAlmostEqual(shape["entries"] / 50_000, 1.0, delta=0.05)

    def test_proportions_survive_sampling(self):
        """What the bar actually draws. A file that is three-quarters images by
        weight must still read three-quarters images after sampling — spread
        the kinds through the id space so a lazy sampler cannot get it right by
        accident."""
        entries = []
        for i in range(80_000):
            if i % 4 == 0:
                entries.append(_FakeEntry("text/html", 100))
            else:
                entries.append(_FakeEntry("image/jpeg", 100))
        shape = self._breakdown(entries, exact_max=1000)
        by = {b["key"]: b["size_bytes"] for b in shape["breakdown"]}
        total = sum(by.values())
        self.assertAlmostEqual(by["images"] / total, 0.75, delta=0.03)
        self.assertAlmostEqual(by["pages"] / total, 0.25, delta=0.03)

    def test_clustered_content_is_still_seen(self):
        """The case that kills a first-N sampler: all the images at the end."""
        entries = [_FakeEntry("text/html", 10) for _ in range(40_000)]
        entries += [_FakeEntry("video/mp4", 10) for _ in range(40_000)]
        shape = self._breakdown(entries, exact_max=1000)
        by = {b["key"]: b["size_bytes"] for b in shape["breakdown"]}
        self.assertIn(
            "video", by, "a sample that never reaches the end misses half the file"
        )
        total = sum(by.values())
        self.assertAlmostEqual(by["video"] / total, 0.5, delta=0.05)

    def test_an_unopenable_zim_reports_nothing_rather_than_failing(self):
        import zimi.zimwriter as zw

        self.assertIsNone(zw.zim_content_breakdown("/definitely/not/a.zim"))


class TestShapeCache(unittest.TestCase):
    """Measured once per ZIM, and again when the ZIM changes.

    Reading the shape is the expensive part — a sample is sixty seeks, an exact
    walk is one per entry — so it is memoized against the file's identity, in
    memory and on disk, and the memo outlives a restart.

    The interesting case is the MISS. A ZIM replaced under the same name (an
    auto-update, a re-run capture) is a different file at the same address, and
    a cache keyed on the name alone would serve the old answer for ever. That
    is precisely the bug this release fixed in the icon ETag; it must not be
    reintroduced one directory over."""

    def setUp(self):
        import zimi.http as http
        import zimi.server as server

        self.http = http
        self.server = server
        self.tmp = tempfile.mkdtemp(prefix="zimi-shape-cache-")
        self.zim = os.path.join(self.tmp, "x.zim")
        with open(self.zim, "wb") as f:
            f.write(b"not really a zim")
        self.calls = []

        self._saved = {
            "list_zims": server.list_zims,
            "get_zim_files": server.get_zim_files,
            "ZIMI_DATA_DIR": server.ZIMI_DATA_DIR,
        }
        server.list_zims = lambda: [{"name": "x", "file": "x.zim"}]
        server.get_zim_files = lambda: {"x": self.zim}
        server.ZIMI_DATA_DIR = self.tmp

        import zimi.zimwriter as zw

        self._saved_breakdown = zw.zim_content_breakdown

        def counting_breakdown(path, **kw):
            self.calls.append(path)
            return {
                "file_bytes": 1,
                "entries": 1,
                "breakdown": [{"key": "pages", "size_bytes": 1, "count": 1}],
            }

        zw.zim_content_breakdown = counting_breakdown
        http._shape_cache = None  # a fresh process, as far as the cache knows

    def tearDown(self):
        import zimi.zimwriter as zw

        for name, orig in self._saved.items():
            setattr(self.server, name, orig)
        zw.zim_content_breakdown = self._saved_breakdown
        self.http._shape_cache = None
        import shutil

        shutil.rmtree(self.tmp, ignore_errors=True)

    def _cache_keys(self):
        with open(os.path.join(self.tmp, "zim_shapes.json"), encoding="utf-8") as f:
            return list(json.load(f))

    def test_the_file_is_read_once_per_zim(self):
        self.assertIsNotNone(self.http._zim_shape("x"))
        self.assertIsNotNone(self.http._zim_shape("x"))
        self.assertIsNotNone(self.http._zim_shape("x"))
        self.assertEqual(len(self.calls), 1, "the ZIM was re-read on a cache hit")

    def test_the_memo_outlives_the_process(self):
        self.http._zim_shape("x")
        self.http._shape_cache = None  # restart: memory gone, the file remains
        self.assertIsNotNone(self.http._zim_shape("x"))
        self.assertEqual(len(self.calls), 1, "a restart re-measured the library")

    def test_a_replaced_zim_is_measured_again(self):
        """The miss that matters. Same name, same path, different bytes."""
        self.http._zim_shape("x")
        before = self._cache_keys()
        os.utime(self.zim, (2_000_000_000, 2_000_000_000))
        self.http._shape_cache = None
        self.http._zim_shape("x")
        self.assertEqual(len(self.calls), 2, "a replaced ZIM served a stale shape")
        self.assertNotEqual(
            before, self._cache_keys(), "the key did not follow the file"
        )

    def test_a_grown_zim_is_measured_again(self):
        """Size is in the key too, so a file that changed within the same
        second — plausible on a fast disk — is still a different file."""
        self.http._zim_shape("x")
        with open(self.zim, "ab") as f:
            f.write(b"more")
        self.http._shape_cache = None
        self.http._zim_shape("x")
        self.assertEqual(len(self.calls), 2)

    def test_the_stale_record_is_dropped(self):
        """A library churned through a hundred captures must not accumulate a
        hundred dead records."""
        self.http._zim_shape("x")
        os.utime(self.zim, (2_000_000_000, 2_000_000_000))
        self.http._shape_cache = None
        self.http._zim_shape("x")
        self.assertEqual(len(self._cache_keys()), 1, "the old record was kept")

    def test_a_zim_that_is_not_installed_has_no_shape(self):
        self.assertIsNone(self.http._zim_shape("nope"))
        self.assertEqual(self.calls, [], "an unknown ZIM still hit the disk")

    def test_a_zim_the_requester_may_not_see_has_no_shape(self):
        """Gated by list_zims, which is where the per-request allowlist lives —
        a ZIM somebody may not list does not get to have its shape read."""
        self.server.list_zims = lambda: []
        self.assertIsNone(self.http._zim_shape("x"))
        self.assertEqual(self.calls, [])


if __name__ == "__main__":
    unittest.main()
