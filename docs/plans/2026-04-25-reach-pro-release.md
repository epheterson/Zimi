# Reach + Pro Release — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task.

**Goal:** Combined release that (a) closes the v1.7 "Reach" track (P2P/torrent ZIM sharing + accessibility), (b) addresses every actionable suggestion from issue #15, and (c) introduces a new "Pro" track for power users with 1000+ ZIMs (hot-loaded RAM cache, language filters, queue control).

**Architecture:** Three sequential waves. Wave 1 ships fast-validating UI/UX fixes. Wave 2 ships testable backend changes (download queueing, Pro hot-cache, OPDS hierarchy detection, search engine integration docs). Wave 3 ships the larger surface-area work (Downloads as a separate page, P2P/torrent, accessibility). Each wave is independently shippable as a point release if needed.

**Tech Stack:** Python 3.10+, vanilla JS (no build step), Python `BaseHTTPServer` + `ThreadingHTTPServer`, libzim (SWIG), pytest.

---

## Source Material — What's Being Meshed

This plan unifies four sources. Every numbered item below maps to one of:

- **[REACH]** v1.7 vision (memory: `project_v17_vision.md`) — P2P/torrent + accessibility
- **[V161]** v1.6.1 leftovers not yet shipped (cache mgmt UI is partial; "build full Q-ID index" button missing)
- **[#15]** Issue #15 user feedback (warlordattack)
- **[PRO]** New Pro-user track Eric added in this session — hot RAM cache, language filtering at scale, control for 1000+-ZIM users

---

## Ground-Truth Audit (verified before planning)

Before designing the work, I verified things Eric thought already shipped. Findings:

| Eric's belief | Reality | Source |
|---------------|---------|--------|
| "Remember password" works | **Broken.** `app.js:302` uses `sessionStorage`, which clears when tab closes. Should be `localStorage`. | `zimi/static/app.js:301-303` |
| Download queuing exists | **Doesn't exist.** `_start_download` immediately spawns a thread. No concurrency cap, no queue, no smallest-first ordering. | `zimi/library.py:638-657` |
| Search across all is fast | Partially. `search_all` searches every ZIM with no skipping. Fine at ~50 ZIMs, painful at 1000+. `fast=True` is title-only. | `zimi/search.py:850-895` |
| Bitwarden ignores password input | **Confirmed bug source:** `data-1p-ignore` is on the password field itself (`index.html:53`). That attribute tells password managers to skip. Should be removed from password input (and added to search input if needed). | `zimi/templates/index.html:30,53` |

These are now Wave 1 fixes (not "we already did that").

---

## Wave 1 — Low-Hanging Fruit (UI fixes, easy human validation)

Each task is one focused change Eric can validate by clicking. Goal: ship 1.7.0 worth of polish in one session, get Eric's review per item.

### Task 1.1: Fix Bitwarden / 1Password ignoring the manage password input

**[#15-1]** User reports "input is not recognized as password by bitwarden."

**Files:**
- Modify: `zimi/templates/index.html:30` (search input — confirm/move `data-1p-ignore` here)
- Modify: `zimi/templates/index.html:53` (password input — remove `data-1p-ignore`)

**Step 1: Read current state**
Confirm the attribute is misplaced on the password input.

**Step 2: Move `data-1p-ignore` to the search input only**
- Add `data-1p-ignore` to `#q` (search) if it isn't already there.
- Remove it from `#pw-input` (password modal).

**Step 3: Manual verify**
- Reload the SPA; click manage; password modal opens.
- Bitwarden / 1Password offers to fill the password field.
- Search input is still ignored by autofill.

**Step 4: Commit.**

### Task 1.2: Make "Remember me" actually remember across tabs/sessions

**[#15-1]** User reports "when i close page and back it does not remember (when remember is checked)."

**Files:**
- Modify: `zimi/static/app.js:301-303` (the sessionStorage call)
- Modify: `zimi/static/app.js:316-319` (manageLogout — also clear localStorage)
- Modify: `zimi/static/app.js` near line 500 (initial check — read localStorage too)

**Step 1: Switch storage**
Change `sessionStorage.setItem('zimi_manage_pw', token)` to `localStorage.setItem('zimi_manage_pw', token)` when "remember me" is checked. Use sessionStorage when unchecked (current-session-only behavior).

**Step 2: Read both on page load**
The initial token check should read `localStorage` first, then `sessionStorage` as fallback.

**Step 3: Logout clears both**
`manageLogout` should `removeItem` from both stores.

**Step 4: Manual verify**
- Set password, log in with "Remember me" checked, close tab, reopen → still authenticated.
- Set password, log in with "Remember me" unchecked, close tab, reopen → prompted again.
- Logout clears both cases.

**Step 5: Commit.**

### Task 1.3: Move Downloads to its own manage subtab (structural)

**[#15-2]** User reports the "installed/catalog/collections" menu sits "one kilometer down" because the downloads block above it grows huge. Eric: "let's have it be a tab or something — not the css band-aid."

**Approach:** Add "Downloads" as a fourth subtab alongside Installed / Catalog / Collections. The downloads block stops pushing the filter menu down because it lives in its own pane. Multi-select + multi-column grid stay in W3.1; this task is just the structural move.

**Files:**
- Modify: `zimi/static/app.js` — manage view subtab list; add 'downloads' alongside 'installed'/'catalog'/'collections'
- Modify: `zimi/static/app.js` — relocate the existing downloads-rendering function into the new pane
- Modify: `zimi/static/app.js` — add badge with active-download count on the tab label
- Modify: `zimi/static/app.css` — minor styling for the badge

**Step 1: Locate the manage subtab switcher** (we already have one for Installed / Catalog / Collections).

**Step 2: Add 'downloads' as a 4th subview.** Wire `_msShowPane('downloads')` to render existing downloads markup.

**Step 3: Auto-route to Downloads when an active download exists** and the user is on Catalog (gentle hint without forcing).

**Step 4: Show badge with count** when active+queued > 0.

**Step 5: Visual verify** via Chrome MCP against `https://knowledge.zosia.io`: catalog filter menu sits at top regardless of download count.

**Step 6: Commit.**

### Task 1.4: Bigger fonts / contrast for sky-text overlays (cleanup)

Skip — not on either source list. Marker so I don't re-add it.

### Task 1.5: Document the SearXNG integration

**[#15-4]** User shipped a working `searxng/engines/zimi.py` integration. We should make this an officially supported integration point.

**Files:**
- Create: `docs/integrations/searxng.md`

**Step 1: Write the doc**
- Quote the user's working `zimi.py` (with attribution to issue #15).
- Document the `/search` JSON shape they're consuming (already stable).
- Note that result categorization (general vs. images vs. videos) requires the engine to set `'img_src'` for images and `'iframe_src'` for video; document how Zimi could expose a `category` hint per result.
- Add a "Known limitations" section: cold-start timeouts (recommend `timeout: 20.0` like the user did), no built-in rate limiting interplay.

**Step 2: Link from README.md.**

**Step 3: Commit.**

### Task 1.6: Add a `category` hint to `/search` results

**[#15-4]** Improves SearXNG categorization — currently all results land in "general."

**Files:**
- Modify: `zimi/search.py` (`search_all`, `_score_result` area — add a `category` field to result dict based on ZIM source name pattern: `wikipedia*` → general, `ted*` → videos, `gutenberg*` → general, `wikimedia_commons*` → images, `zimgit-*` → general+pdf, etc.)
- Modify: `zimi/http.py` (passthrough)

**Step 1: Write the test**
`tests/test_search_category.py`:
```python
def test_wikipedia_result_is_general():
    r = search_all("paris", limit=1, filter_zim="wikipedia_en_top")
    assert r["results"][0]["category"] == "general"

def test_ted_result_is_video():
    r = search_all("ai", limit=1, filter_zim="ted_en")
    assert r["results"][0]["category"] == "video"
```

**Step 2: Add a `_zim_category(name)` helper in `search.py`.**

**Step 3: Pass it through `search_all` results.**

**Step 4: Run tests.**

**Step 5: Update SearXNG doc to show using `category` for routing to images/video tabs.**

**Step 6: Commit.**

---

## Wave 2 — Backend, Testable

Each task has a real test. Eric reviews tests + behavior, not pixels.

### Task 2.1: Download queue with smallest-first ordering and concurrency cap

**[#15-2]** User: "it starts downloading all files, and each file at 0.2 mb/s : do few simultaneously and queue all others, sort by ascending file size."
**[Eric correction]** Eric thought we had this. We don't.

**Files:**
- Modify: `zimi/library.py` (introduce `_download_queue` and `MAX_CONCURRENT_DOWNLOADS`)
- Test: `tests/test_download_queue.py`

**Design:**
- Default `MAX_CONCURRENT_DOWNLOADS = 3` (configurable via env var `ZIMI_MAX_CONCURRENT_DOWNLOADS`).
- New downloads beyond the cap go into `_download_queue` in size-ascending order (size from OPDS metadata; fall back to HEAD request).
- Queue drain hook on download completion.

**Step 1: Test queue ordering**
```python
def test_queue_orders_smallest_first():
    # mock 5 ZIMs with sizes [10GB, 1GB, 5GB, 100MB, 500MB]
    # all queued at once
    # assert dispatch order is [100MB, 500MB, 1GB, 5GB, 10GB]
```

**Step 2: Test concurrency cap**
```python
def test_at_most_n_concurrent():
    # queue 10 downloads with cap=3
    # assert exactly 3 in `_active_downloads`, 7 in `_download_queue`
```

**Step 3: Test drain on completion**
```python
def test_completion_drains_queue():
    # cap=2, queue=4
    # mark one complete
    # assert one moved from queue to active
```

**Step 4: Implement** behind the existing `_download_lock`.

**Step 5: Add `queue` field to `/manage/downloads` response so the UI can show pending items.**

**Step 6: Run tests.**

**Step 7: Commit.**

### Task 2.2: Multi-select "Download Selected" support in the API

**[#15-2]** User wants to click many checkboxes then one button.

API + backend now (testable). UI checkboxes in Wave 3.

**Files:**
- Modify: `zimi/manage.py` (new endpoint `POST /manage/download-batch` accepting `{urls: [...]}` array)
- Test: `tests/test_download_batch.py`

**Step 1: Test**
```python
def test_batch_returns_ids_per_url():
    res = post("/manage/download-batch", {"urls": [url1, url2, url3]})
    assert len(res["ids"]) == 3
    assert all(isinstance(i, str) for i in res["ids"])

def test_batch_partial_failures_reported():
    res = post("/manage/download-batch", {"urls": [valid, "ftp://nope"]})
    assert res["ids"][0] is not None
    assert res["errors"][1] is not None
```

**Step 2: Implement.** Shares the queue from Task 2.1.

**Step 3: Commit.**

### Task 2.3: Pro hot-RAM cache (`ZIMI_HOT_ZIMS` env var + persistent search workers)

**[PRO]** + **[#15-5]** "with many files there could be performance problems… let user choose what to load in RAM/cache to speed up searches."

**Why now:** With 1000+ ZIMs, opening + searching each takes time. We can pre-warm specified ZIMs and keep persistent SearcherPool entries.

**Files:**
- Modify: `zimi/server.py` (add `HOT_ZIMS` config, parse `ZIMI_HOT_ZIMS` comma-separated env var, optional `~/.zimi/hot.json`)
- Modify: `zimi/server.py` (extend `warm_indexes()` to pre-open archives + keep them resident)
- Modify: `zimi/search.py` (skip pool churn for hot ZIMs)
- Test: `tests/test_hot_cache.py`

**Design:**
- `ZIMI_HOT_ZIMS=wikipedia_en_all,stackoverflow.com_en_all`
- On startup, those ZIMs are opened, FTS searcher created, cached in memory permanently.
- For non-hot ZIMs, keep current behavior (lazy open, pool eviction).
- Add `/manage/hot` endpoint to list/edit hot set without restart.

**Step 1: Test config parsing**
```python
def test_parses_env_var():
    os.environ["ZIMI_HOT_ZIMS"] = "wiki_en, stackoverflow_en "
    assert load_hot_zims() == ["wiki_en", "stackoverflow_en"]
```

**Step 2: Test hot ZIMs are pre-warmed at startup.**

**Step 3: Test hot ZIMs skip pool eviction.**

**Step 4: Implement.**

**Step 5: Document in README + add to CHANGELOG.**

**Step 6: Commit.**

### Task 2.4: Language filter setting for the catalog UI

**[#15-6]** "filter options in settings to only show user selected languages so all other files will be invisible."

**Backend half** (Wave 2): server-side support for `?ui_languages=en,fr` filtering on `/manage/catalog`. **UI half** in Wave 3.

**Files:**
- Modify: `zimi/manage.py` (catalog handler accepts `ui_languages` filter)
- Test: `tests/test_catalog_lang_filter.py`

**Step 1: Test**
```python
def test_catalog_filters_by_languages():
    res = get("/manage/catalog?ui_languages=en,fr")
    langs = {item["language"] for item in res["items"]}
    assert langs <= {"en", "fr"}
```

**Step 2: Implement filter.**

**Step 3: Commit.**

### Task 2.5: OPDS subset/superset hierarchy detection ("files-in-files")

**[#15-3]** Feasibility-checked — answer is **partially yes**.

**Feasibility analysis:**
- Full content overlap (article-level) is impractical without parsing every ZIM.
- **Practical signal:** Kiwix names ZIMs consistently. `wikipedia_en_all_maxi`, `wikipedia_en_all_nopic`, `wikipedia_en_top`, `wikipedia_en_medicine` share `wikipedia_en` prefix. The `_all_*` variant is a strict superset of the `_top_*`, `_medicine`, `_climate_change`, etc. for the same project + lang. Article counts confirm.
- **What we'll ship:** A heuristic `bundle_relationships(catalog)` that for each ZIM produces `{is_subset_of: ["wikipedia_en_all_maxi"], supersedes: ["wikipedia_en_top"]}` based on:
  1. Same `<project>_<lang>` prefix
  2. `_all_*` variants are bundles
  3. Article count ratio: subset count must be ≤ bundle count
- **TED corner case** the user raised (older bundle, fresher subsets) — the response includes both `freshness_advantage_subsets` (subsets newer than the bundle, by date in filename) and `coverage_advantage_bundle` (bundle has more articles). Let UI show both, user decides.

**Files:**
- Create: `zimi/catalog_hierarchy.py` (~150 lines)
- Test: `tests/test_catalog_hierarchy.py`

**Step 1: Test the heuristic on real catalog data**
```python
def test_wikipedia_subsets_recognized():
    items = sample_catalog()
    rels = bundle_relationships(items)
    assert "wikipedia_en_all_maxi" in rels["wikipedia_en_top"]["is_subset_of"]

def test_ted_freshness_advantage_flagged():
    items = mock_ted_with_old_bundle_new_subsets()
    rels = bundle_relationships(items)
    assert rels["ted_en_all"]["freshness_advantage_subsets"] != []
```

**Step 2: Implement.**

**Step 3: Expose via `/manage/catalog?include_hierarchy=1`.**

**Step 4: Commit.** (UI consumption is in Wave 3.)

### Task 2.6: "Updates: 5 remaining — see which" endpoint

**[#15-7]** User: "5 remaining: how to see detail?"

**Files:**
- Modify: `zimi/library.py` or `zimi/manage.py` — `/manage/updates` endpoint that returns the list of which ZIMs have updates available, with current vs latest version.
- Test: `tests/test_updates_listing.py`

**Step 1: Test that an update list endpoint returns names + versions.**

**Step 2: Implement.**

**Step 3: Commit.**

### Task 2.7: Stats endpoint (file count, search count, top searches)

**[#15-8]** "stats page: number of files, searches, top 10 searches, other stats."

**Files:**
- Modify: `zimi/http.py` (in-memory rolling counters of search query strings, file count from existing source)
- New endpoint: `/stats` (public read, but maybe behind manage auth)
- Test: `tests/test_stats.py`

**Step 1: Test counters increment.**

**Step 2: Test top-10 endpoint returns sorted result.**

**Step 3: Implement with a bounded LRU (don't grow unbounded).**

**Step 4: Document — Grafana scraping is just `curl /stats | jq` on a cron, no extra integration needed for the user's ask.**

**Step 5: Commit.**

### Task 2.8: OpenWebUI / generic-AI integration docs

**[#15-6]** "could this zim library be integrated with openwebui and other AI?"

**Already 80% done — we have an MCP server.** This is a docs task.

**Files:**
- Create: `docs/integrations/openwebui.md`
- Modify: `README.md` (link from "Integrations" section)

**Step 1: Document MCP installation in OpenWebUI**, including the existing tools (`search`, `read`, `list`, etc.).

**Step 2: Add 3 example prompts** showing how to ask Claude/etc. to research from offline ZIMs.

**Step 3: Commit.**

---

## Wave 3 — UI & Larger Surface Area

These need their own scoping passes — listed here for completeness so the TODO covers EVERY point. Each will get its own plan doc when we start.

### Task 3.1: Dedicated Downloads page **[#15-2]**

Move downloads (active + queued + completed history) out of the manage tab into its own top-level view. Side benefit: makes the "menu pushed off-screen" complaint structural rather than CSS-band-aided.

**Includes:**
- Multi-select checkboxes + "Download Selected" button (UI for Wave 2.2 backend)
- Multi-column download grid
- Foldable "active / partial / queued / completed" sections
- Smaller per-item rows (1 line each)
- Links to the queue from the catalog detail block

### Task 3.2: P2P / Torrent ZIM sharing **[REACH]**

Per `project_v17_vision.md`:
- mDNS LAN discovery (`_zimi._tcp.local`)
- Catalog shows nearby peers + their ZIMs
- Info-hash per ZIM (Kiwix publishes .torrents)
- Zimi as WebSeed/BitTorrent peer
- Off-grid mesh: one seeded device serves the rest

**Sub-plan needed.** Library options: `libtorrent` (C deps, heavy), `WebTorrent` (browser-side only, JS), `aria2` (already common — could subprocess). Recommend `aria2c --enable-bt-load-saved-metadata` as the simplest path; we already shell out for downloads.

### Task 3.3: Accessibility track **[REACH]**

Per vision doc:
- ARIA landmarks across all views
- Keyboard navigation (Tab, Enter, Escape) audit
- Screen-reader descriptions (especially almanac sky views — moon phase, star names, computed values)
- `prefers-reduced-motion` — disable animations
- `prefers-contrast` — high-contrast mode
- Inject heading-structure + alt-text fixes when serving ZIM HTML

### Task 3.4: Catalog UI for hierarchy display **[#15-3]**

UI half of Task 2.5. On a catalog item:
- Badge: "Included in `wikipedia_en_all_maxi` (you already have it)"
- Badge: "Replaces `wikipedia_en_medicine`" with size diff
- Tree view in the project group (e.g., all Wikipedia EN variants)
- "Compare bundle vs sum of parts" toggle

### Task 3.5: Pro hot-cache UI **[PRO]**

UI half of Task 2.3. In Server tab:
- "Hot ZIMs" section — checkboxes to mark a ZIM as hot
- Memory usage indicator
- Save → applies live (or restart hint)

### Task 3.6: Become-a-mirror toggle **[#15-0]**

User asked for "option to become a mirror." Means: serve our local ZIM directory + OPDS feed back out so other Zimi instances can catalog/download from us. This is a small server change once Task 3.2 (P2P) is in — share the same discovery infrastructure.

### Task 3.7: Cache management UI completions **[V161]**

v1.6.1 listed cache mgmt UI — partially shipped (info section in Server settings). Still missing:
- Clear / rebuild buttons for Q-ID indexes
- "Build full Q-ID index" button (heavy operation, needs progress indication)

### Task 3.8: Smart ranking by date/relevance from SearXNG context **[#15-4]**

User noted SearXNG-routed results aren't ranked optimally. Most of this is already in `_score_result`. The SearXNG-specific issue is that results come back in batches and SearXNG doesn't re-sort by score across engines. Fix: ensure `score` is set correctly on every result (Task 1.6 already adds `category`; verify `score` is float-stable across calls).

---

## Items From Issue #15 — Feasibility Verdict

For things we won't build, document why so we don't re-litigate.

| #15 ask | Verdict | Where it lands |
|---------|---------|----------------|
| Become a Kiwix mirror (#0) | **Yes**, after P2P infra | Task 3.6 |
| Bitwarden recognizes pw (#1a) | **Yes, easy** | Task 1.1 |
| Remember password (#1b) | **Yes, easy** | Task 1.2 |
| Multi-select downloads (#2a) | **Yes** | Task 2.2 + 3.1 |
| Filter menu position (#2b) | **Yes — sticky now, restructure later** | Task 1.3 + 3.1 |
| Concurrent + size-sorted queue (#2c) | **Yes** | Task 2.1 |
| Multi-column download grid (#2d) | **Yes** | Task 3.1 |
| Multi-column catalog (#2d') | Maybe — wait for downloads page | Deferred |
| Foldable sections (#2e) | **Yes** | Task 3.1 |
| Hierarchy / files-in-files (#3a) | **Yes, partial** — name-pattern heuristic only | Task 2.5 + 3.4 |
| Catalog "you already have all parts" (#3b) | **Yes** | Task 3.4 |
| TED freshness vs bundle (#3c) | **Yes, both signals shown** | Task 2.5 + 3.4 |
| Big-equals-sum check (#3d) | **Yes, computed from article counts** | Task 2.5 + 3.4 |
| SearXNG integration doc (#4) | **Yes** | Task 1.5 |
| SearXNG result categorization (#4a) | **Yes** | Task 1.6 |
| Time-out fix on cold start (#4b) | **Already addressed** by warm_indexes() in v1.6.3. Verify with user. | Verify only |
| AI re-ranking (#4c) | **No, out of scope** — Zimi stays offline-first; no LLM dependency | Won't fix |
| Redis/Postgres/MariaDB (#5a) | **No** — Pro hot-cache (Task 2.3) addresses the perf problem without adding infra | Won't fix |
| Pick what's in RAM (#5b) | **Yes** | Task 2.3 + 3.5 |
| Language filter (#6a) | **Yes** | Task 2.4 + UI in 3.x |
| Collections show "I have all in language X" (#6b) | **Yes**, falls out of hierarchy detection | Task 3.4 |
| OpenWebUI integration (#6c MCP) | **Already done — needs docs** | Task 2.8 |
| Canadian Prepper download accounting (#7a) | **Investigate** — likely a single bug. File a sub-task once reproduced. | Triage during Wave 1 |
| "5 remaining updates" detail view (#7b) | **Yes** | Task 2.6 |
| Old wiki not updated (#7c) | Same root cause as #7a likely | Same triage |
| Stats page (#8a) | **Yes** | Task 2.7 + UI later |
| Grafana integration (#8b) | **Implicit** — `/stats` endpoint scrapeable by anything | Task 2.7 |

---

## Out-of-Scope Reminders

Things we explicitly will NOT do, lest scope creep:

- AI-powered ranking (issue #15-4c) — violates offline-first principle.
- Pluggable database backends (issue #15-5a) — solved by Pro hot-cache without operational complexity.
- Browser-side WebTorrent in the SPA — Wave 3 P2P uses native client only; revisit if a clear use case emerges.

---

## Execution Order Within Wave 1

Recommended order (each commits independently):
1. Task 1.1 (Bitwarden) — 5 min
2. Task 1.2 (Remember me) — 10 min
3. Task 1.3 (Sticky menu) — 10 min
4. Task 1.5 (SearXNG doc) — 20 min
5. Task 1.6 (Category hint) — 30 min with test

Total Wave 1: ~75 min of work. Eric reviews each as it lands.

---

## Verification Strategy

- **Wave 1**: human click-test each fix in browser. No tests required.
- **Wave 2**: pytest passes for each new test. Show output before claiming done.
- **Wave 3**: scoped per task. P2P + accessibility need their own plans before execution.

---

## Memory Updates Required at Wave Boundaries

After Wave 1 ships:
- Update `MEMORY.md` v1.7 vision pointer to reflect Reach + Pro merge.

After Wave 2 ships:
- Add memory: `project_pro_release.md` documenting hot-cache architecture decisions.

After Wave 3 ships:
- Replace `project_v17_vision.md` with `project_v17_release_status.md`.
