# Efficient Startup Implementation Plan

**Goal:** Zimi starts cleanly on resource-constrained hosts (Pi, old laptops, NAS during RAID rebuild) with bounded memory and bounded CPU, regardless of ZIM count. Search is always ready when offered — never lazy-on-first-search.

**Architecture:**
- Collapse 5 parallel startup threads into 1 serial `_StartupWorker`.
- One Archive handle per ZIM during indexing; close immediately after.
- Bounded runtime archive pool with LRU eviction.
- `/proc/loadavg` throttle between per-ZIM builds.
- `/search` blocks on indexes that aren't ready yet (with timeout); never returns wrong/empty for a building ZIM.
- Docker healthcheck `start_period` so Docker doesn't crash-loop cold starts.

**Memory contract:** peak startup memory = 1 Archive handle + 1 SQLite tmp ≈ 50-200 MB regardless of 1 or 700 ZIMs. Runtime peak = `ZIMI_MAX_OPEN_ARCHIVES` × per-archive cost.

**Tech:** Python stdlib `threading`, `os.getloadavg()`, `collections.OrderedDict` for LRU. No new deps.

---

## Task 0: Use ZIM UUID as staleness signal + additive-schema migration

**Why this matters:** the current code rebuilds an index whenever the ZIM file's `mtime` changes. mtime is not a content signal — it changes on redownload, backup restore, file copy without `-p`, etc. Worse: any schema bump (v3→v4 added FTS5) forces a full rebuild of every ZIM index, even though FTS5 is purely additive.

**Files:**
- Modify: `zimi/search.py:_index_is_current` (~line 292)
- Modify: `zimi/search.py:_build_title_index` and `_build_qid_index` to write UUID into meta
- Modify: `zimi/search.py` — add `_migrate_index_schema(conn, from_version, to_version)`
- Test: `tests/test_index_staleness.py`

Changes:
1. **Replace `mtime` with `uuid` in the staleness check.** Read `archive.uuid` (libzim exposes it as a property). Store as `meta.zim_uuid`. Compare on startup.
2. **Schema migration table.** Map `(from_version, to_version) → migration_fn`. v3→v4 = "add FTS5 table" (additive). Major changes can still demand full rebuild but additive changes never do.
3. **Backfill path.** An index missing `zim_uuid` (built before this change) is treated as "needs upgrade" — read UUID from the ZIM, write into meta, mark current. No table rebuild.

Tests:
- Same UUID + same schema → current.
- Same UUID + older additive schema → migrate, current.
- Different UUID → rebuild.
- mtime change but UUID unchanged (redownload of same content) → current.

## Task 1: Capture baseline — characterization tests

**Files:**
- Create: `tests/test_startup_resource_envelope.py`

Write tests that document the CURRENT behavior, then we change it. These tests will be inverted to check the NEW behavior.

- Test counts how many threads are launched in `start_background_warmers()` (or equivalent).
- Test counts how many `open_archive` calls happen during a synthetic 3-ZIM startup.
- Run: pytest the new file. Expect: documents pre-fix counts (5 threads, ≥3 simultaneous opens).

## Task 2: Collapse parallel threads into one ordered worker

**Files:**
- Modify: `zimi/server.py:1185-1227` — replace 5 `Thread(...).start()` with one `_StartupWorker` thread.
- Tests: characterization test from task 1, inverted.

Worker phases (in order, on one thread):
1. Restore suggest cache (already done above in current code).
2. For each ZIM (sorted small-to-large by article_count):
   - Open one Archive handle.
   - Build/check title index (skip if current).
   - Build/check Q-ID index (skip if current).
   - If size_mb < auto_fts_threshold: build FTS5.
   - Close archive.
   - `_throttle()` between ZIMs.
3. Mark `state="ready"`.

Test: observed peak Archive opens ≤ 2 across whole startup.

## Task 3: `_throttle()` based on loadavg

**Files:**
- Create: `zimi/_throttle.py` (or add to `server.py`)
- Test: `tests/test_throttle.py`

```python
def throttle_between_jobs(threshold_ratio=0.8, max_sleep=2.0):
    """Sleep up to max_sleep if 5-min loadavg > nproc * threshold_ratio.
    No-op on platforms without os.getloadavg (Windows)."""
```

Tests with mocked `os.getloadavg` and `os.cpu_count`.

## Task 4: Tighten title-index build — close Archive immediately

**Files:**
- Modify: `zimi/search.py:_build_title_index` (line ~325-385)

Currently opens a dedicated Archive handle and never explicitly closes. Wrap in try/finally and `del archive` after writing the SQLite tmp. Same for `_build_qid_index` if it does the same thing.

Test: peak file descriptors don't grow with ZIM count (count via `psutil.Process().open_files()` if available, fallback to `/proc/self/fd`).

## Task 5: Bounded archive pool with LRU eviction

**Files:**
- Modify: `zimi/server.py` — `_archive_pool` becomes an `OrderedDict` capped at `ZIMI_MAX_OPEN_ARCHIVES`.
- Test: `tests/test_archive_pool_lru.py`

Default = `min((os.cpu_count() or 2) * 2, 16)`. Override via env. Eviction on access if size > cap.

Test: open 20 archives with cap=4, assert pool size never exceeds 4 and least-recently-used is evicted first.

## Task 6: `/search` blocks on building index

**Files:**
- Modify: `zimi/search.py:_title_index_search` and/or whatever `/search` calls into.
- Test: `tests/test_search_waits_for_build.py`

If a ZIM has no current title index AND a build is in progress: wait on a per-ZIM `threading.Event` set by the worker when that ZIM's index lands. Bounded wait (default 30s); if exceeded, return empty results with status header `X-Zimi-Indexing: pending`.

Test: simulated slow build, search() called concurrently, returns within timeout once the event is set.

## Task 7: `/health` reports indexing progress

**Files:**
- Modify: wherever `/health` is served (likely `zimi/http.py`).

Add fields: `indexing.state` (one of `restoring|building|ready`), `indexing.ready` (int), `indexing.total` (int), `indexing.eta_seconds` (int|null), `indexing.current_zim` (str|null).

Test: hit /health during simulated build, assert progress fields shaped correctly.

## Task 8: Docker healthcheck start_period

**Files:**
- Modify: `docker-compose.yml`

Add `healthcheck.start_period: 10m` (or environment-overridable). Verify with `docker inspect` syntax.

## Task 9: Smoke: real Wikipedia ZIM

**Files:**
- Manual run, no new test (we already have `test_serve_smoke.py`).

Run server with one small ZIM (`100r-off-the-grid_en` or similar already in NAS dir), verify:
- Startup logs show single-threaded build sequence.
- `/health` reports indexing → ready.
- `/search?q=test` returns results.
- Peak memory below 200MB during build (visual check via `ps`).

## Task 10: Update README + CHANGELOG

**Files:**
- Modify: `README.md` (env vars table)
- Modify: `CHANGELOG.md` (Unreleased section)

Document:
- `ZIMI_MAX_OPEN_ARCHIVES` env var.
- New `/health` indexing fields.
- Note about `start_period` for Docker users running on slow disks.

---

## Out of scope (defer to v1.7.1 / v1.8)

- Pre-built index distribution.
- `ZIMI_EAGER_INDEX=1` opt-in for beefy hosts.
- Resume interrupted builds from `.tmp` artifacts.
- Skipping FTS5 build under load (doable but adds complexity to readiness contract).
- Mem_limit changes in compose.

## Definition of done

- `pytest tests/` all green.
- Manual local server start with 1+ ZIM completes cleanly.
- Visual: `ps` peak RSS during cold start < 300MB on 3-ZIM test set.
- Code review by sam-code-reviewer with no blocking issues.
- Eric validates on NAS after RAID rebuild finishes.
