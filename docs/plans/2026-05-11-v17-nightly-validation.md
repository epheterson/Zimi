# v1.7.0 Nightly Validation Checklist

**Purpose:** v1.7.0 code is shipped. Before tagging the release, every user-facing surface needs a human pass. Splitting into ~30–60 min nightly sessions so it isn't a single overwhelming push.

**How to use:** pick ONE night's task. Walk through every bullet, check the box, add a 1-line note if you found something. If a bullet finds a real bug, file it under "Bugs found" at the bottom and decide if it blocks ship.

**Status legend:** ☐ not done · ✅ passed · ⚠ found issue (see notes) · ⏭ skipped (with reason)

---

## Night 1 — UI/UX core flows (~45 min)

Open `https://knowledge.zosia.io` (after re-deploy) or local `python3 -m zimi serve` with at least 3 ZIMs. No tools other than your eyes.

- ☐ **Home page** loads, shows a populated card grid. Featured ZIMs render. Random card cycles.
- ☐ **Topbar search** focuses on `/`, suggestions dropdown appears as you type, arrow keys navigate, Enter opens the top hit.
- ☐ **Cross-ZIM search** (no `zim=` filter) returns results from multiple ZIMs sorted sensibly. Result cards show source pill and language pill.
- ☐ **Scoped search** (click a source pill in the result strip) filters to that ZIM. Clearing the pill goes back to cross-ZIM.
- ☐ **Reader** opens an article in an iframe, back button works, sharing the URL preserves the article. Title in browser tab matches article.
- ☐ **History** lists previously-opened articles. Click navigates back to them.
- ☐ **Favorites** add/remove from reader works, list view shows them.
- ☐ **Collections** create a collection, add an article, navigate to collection page.

**Notes:** _free text here_

---

## Night 2 — Catalog + Manage flows (~45 min)

Need: manage mode unlocked (password set, "Remember me" checked).

- ☐ **Bitwarden/1Password recognizes the password input** in the modal. Autofill works.
- ☐ **"Remember me" persists** — close tab, reopen, still authenticated.
- ☐ **Catalog tab** loads ~1000 OPDS items, language filter works, scrolling is smooth.
- ☐ **Hierarchy badges** appear correctly:
  - Install `wikipedia_en_top_*` (or similar subset). Catalog should show **green** "Already covered by wikipedia_en_all_*" on the subset card.
  - **Gray** "Part of wikipedia_en_all_*" on a subset whose bundle isn't installed.
  - **Amber** "Includes N smaller variants" on the bundle card.
  - **Cheatography test:** `devdocs_en_all_cheatography` must NOT claim to cover `devdocs_en_all_angular.js`. (Regression — fixed in commit `680b8dc`.)
- ☐ **Browse Library** category gallery loads, click into a category shows that subset.
- ☐ **Multi-select download** — select 2-3 ZIMs from catalog, "Download Selected" appears, click it, downloads queue with smallest-first.
- ☐ **Pause / Resume** a mid-download, verify it actually pauses and resumes.
- ☐ **Filter pills** on Downloads tab (All / Downloading / Queued / Completed) show correct counts.

**Notes:** _free text here_

---

## Night 3 — Almanac + Space mode (~30 min)

`Today` card on home → opens almanac.

- ☐ **Hero moon** renders with current phase. Date label correct.
- ☐ **Simulated sky** animates (clouds, stars, sun arc).
- ☐ **Orrery** shows planets in correct relative positions. Voyager markers visible. Click a planet — info panel.
- ☐ **Tonight's Sky** lists visible planets / ISS pass times for your location.
- ☐ **Sun & Daylight** — sunrise / sunset / twilight times look right for today.
- ☐ **Meteor shower forecast** if any are active.
- ☐ **Events** — historical-on-this-day from any Wikipedia ZIM you have.
- ☐ **Astro Data** — current values (Julian date, sidereal time, etc.).
- ☐ **Deep Time** — geological scale visualizer.
- ☐ **Location override** works (manual lat/lon prompt) if GPS denied.

**Notes:** _free text here_

---

## Night 4 — BitTorrent end-to-end (~60 min, needs 2 machines on same LAN)

Machine A: install a small ZIM via Zimi. Machine B: clean install.

- ☐ Both machines run with `ZIMI_TORRENT=1`, `ZIMI_PEER_DISCOVERY=1` (defaults), `network_mode: host` if Docker.
- ☐ **mDNS discovery** — `/manage/peers` on B shows A within ~30s.
- ☐ **Peer pill on catalog** — on B, that same ZIM in the catalog shows a small green `📡 peer-name` pill.
- ☐ **Click peer pill** — triggers download, toast appears. `/manage/downloads` on B shows a queued/active item.
- ☐ **BT swarm engages** — `/manage/bt-status` on B shows peers > 0. Most upload bytes come from A on the same LAN (check `/manage/seeding` on A).
- ☐ **Hash verifies** on completion. Article from the downloaded ZIM opens cleanly on B.
- ☐ **Seeding cap** — on B (now seeding), `/manage/seeding` shows ratio counting toward 2× cap (or whatever `ZIMI_RATIO_CAP` is set to).
- ☐ **Mirror toggle** — set `ZIMI_MIRROR=1` on A, restart. Status panel shows "📡 Mirror active". `/manage/mirror` returns `{enabled: true, ratio_cap: 1000, upload_kb: 10000}` (or whatever overrides are set).
- ☐ **Custom peer name** — set `ZIMI_PEER_NAME="My Test Mirror"` on A, restart. B's peer pill / `/manage/peers` shows the friendly name.

**Notes:** _free text here_

---

## Night 5 — Accessibility (~45 min)

VoiceOver (macOS: ⌘F5) or NVDA (Windows). Tab-only navigation throughout.

- ☐ **Skip-to-content link** — first Tab on home reveals it, Enter jumps past topbar.
- ☐ **Password modal** — Tab cycles within modal, Esc closes, focus returns to previously-focused element.
- ☐ **Search input** announces "search, autocomplete list" via aria-autocomplete + aria-controls.
- ☐ **Suggestion dropdown** — arrow keys announce each option, Enter activates.
- ☐ **Toast** — every toast also announces via `role=status aria-live=polite`.
- ☐ **Focus ring** — visible 2px amber ring on every focusable element. Tab through topbar, side panels, modal — none skip the ring.
- ☐ **Reader iframe** — `<base>`-injected ZIM HTML has heading structure preserved. Headings navigate (H key in VoiceOver).
- ☐ **Peer pill** — keyboard focusable, green focus ring, 24×24 touch target.
- ☐ **prefers-reduced-motion** — set macOS Reduce Motion ON. Animations (suggestion fade, simulated sky, button hovers) should be disabled or replaced with crossfades.
- ☐ **Lighthouse a11y** — run on `/` and on a search results page. Score 100/100 or note degradations.

**Notes:** _free text here_

---

## Night 6 — Fragile-host validation (~30 min, on NAS post-deploy)

After `./deploy.sh` of v1.7.0 to NAS.

- ☐ Container starts cleanly. `docker logs zim-reader` shows the new "zimi-startup-worker" thread, not 5 fan-out warmers.
- ☐ `/health` reports 200 within ~5s of container start.
- ☐ `/list` returns full catalog in < 1s.
- ☐ `/search?q=test` returns results within 2s (regression from 30s+ timeout pre-fix).
- ☐ Peak container memory bounded (`docker stats` during startup) — should be hundreds of MB, not 1.6 GB.
- ☐ `ZIMI_HOT_ZIMS` opt-in still works: set to 2-3 ZIM names, restart, verify those are pre-warmed but cold ones still searchable via on-demand archive open.
- ☐ Auto-update flavor lock (#16): trigger `/manage/check-updates`. Confirm a `mini` ZIM is NOT proposed as the update for an installed `maxi`.
- ☐ Cheatography fix live: open catalog, expand devdocs, confirm no false "already covered by" on angular.js / react.

**Notes:** _free text here_

---

## Night 7 — Release ratification (~30 min)

After all 6 nights green.

- ☐ All tests pass on CI for v1.7.0.
- ☐ CHANGELOG accurate, no leftover "Unreleased" content under v1.7.0.
- ☐ README badges + features list up to date.
- ☐ Docker Hub README synced if changed.
- ☐ Cut `v1.7.0` git tag → triggers auto-release pipeline.
- ☐ Watch Docker, PyPI, Sparkle, Homebrew, Snap publish actions.
- ☐ Publish the draft GitHub release (manual gate).
- ☐ Reply on #15 with shipped notes.
- ☐ Reply on #16 with shipped notes (flavor lock + updates panel).
- ☐ Take `:dev` Docker tag offline (or leave for v1.8 in-progress).

---

## Bugs found during nightly passes

_Add here as you go. Decide ship-blocking vs follow-up per bug._

| Bug | Severity | Found in night | Decision |
|---|---|---|---|
| | | | |

---

## Skipped / deferred from this release

- **"Build full Q-ID index" button** — heavy operation (hours on Wikipedia EN). Roadmap, not v1.7.
- **Smart SearXNG re-ranking across engines (Task 3.8)** — score function verified deterministic (lock-in test added). Engine-level cross-batch sort is SearXNG's concern, not ours.
- **Sky-text overlay font/contrast (Task 1.4)** — canvas Voyager labels intentionally small for planet spacing. Screen-reader sky descriptions ship separately (Night 5 covers).
