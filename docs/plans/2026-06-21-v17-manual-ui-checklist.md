# v1.7.0 — Manual UI Check List

For when you sit down to click through the UI yourself. Automated tests + my smoke
pass cover endpoints, status codes, and data shape — this list is the stuff that
**only a human eye catches**: layout, interaction feel, visual polish, edge cases.

Weighted toward v1.7.0's new surface (built without eyes) and the live QA findings.
Test against **http://knowledge.zosia.lan** (LAN) and, where noted, a phone for PWA/responsive.

Legend: 🆕 = new in v1.7.0 · ⚠️ = known finding to confirm · 📱 = check on mobile too

---

## 1. Home / Search
- [ ] Search box focuses on load; typing feels responsive (no lag per keystroke)
- [ ] ⚠️ First search after a while is slow (~5s uncached) — does the UI show a clear *loading* state, or does it look frozen? (This is the one users will notice.)
- [ ] Repeat search is fast (<1s) — confirm the snappiness lands
- [ ] Results: title, source pill, snippet readable; ranking looks sane (relevant hits on top, not buried)
- [ ] Cross-source results grouped/labeled clearly; source names humanized (not raw `wikipedia_en_top`)
- [ ] Home cards sorted by article count (per your preference); Today card present
- [ ] Empty query / no-results state shows something graceful, not a blank pane
- [ ] 📱 Search usable one-handed; results don't overflow horizontally

## 2. Reader
- [ ] Click a result → opens in-reader; article renders, images load
- [ ] Browser/UI title updates to the article title; resets to "Zimi" on close
- [ ] Back/forward (history) behaves; closing reader returns to prior search intact
- [ ] Internal article links stay inside the reader (don't break out / 404)
- [ ] zimgit PDF collections show the document list, not a broken reader; PDF opens inline
- [ ] Broken ZIM (e.g. `devdocs_en_react`) shows "no content," not a crash

## 3. Catalog (Browse Library)
- [ ] 🆕 Grid layout: cards align, 2-col fits the manage pane, no ragged spacing
- [ ] Category gallery groups correctly; 0-item categories hidden
- [ ] Installed-first then alphabetical sort (per your preference)
- [ ] 🆕 Hierarchy hints on cards look right; ⚠️ confirm `cheatography` is NOT flagged as a bundle
- [ ] 🆕 **Green peer pill** appears on ZIMs available on a LAN peer
- [ ] 🆕 Click a peer pill → it becomes a Download button and actually pulls from the peer
- [ ] Filtering / category browse is instant (client-side); no full reload

## 4. Manage / Downloads
- [ ] 🆕 Multi-select downloads: checkboxes + floating action bar appear/disappear correctly
- [ ] 🆕 Pause / resume / cancel a download — state updates without a manual refresh
- [ ] 🆕 Download queue: queued vs active shown clearly
- [ ] ⚠️ The 4 mid-update ZIMs (apod, crashcourse, freecodecamp, xkcd) — do they show as "updating"? Confirm they don't appear broken/served-empty to a user mid-download
- [ ] Manage view sorted alphabetically (per your preference)
- [ ] Entering Manage closes the history panel (recent fix) — confirm no stray panel

## 5. Server Settings
- [ ] 🆕 BT / Seeding status panel renders; no race/flicker on open
- [ ] 🆕 Seeding panel shows only active torrents (finished/errored purged — recent fix)
- [ ] 🆕 Become-a-mirror toggle present; custom peer name field works
- [ ] 🆕 Cache mgmt: 4 buttons (clear-search, clear-suggest, rebuild-title, rebuild-qid) — each gives feedback when clicked
- [ ] 🆕 Pro hot-cache UI shows ZIM **names**, not indices (this was a bug once)
- [ ] Docker mode: no Server Settings overlay clutter, just top-level Refresh Cache (per your preference)

## 6. Activity Bar 🆕 (highest-risk new feature)
- [ ] Thin status row appears below topbar **under real load** (it will, post-restart, while 70 ZIMs index)
- [ ] Shows indexing / downloads / seeding accurately; counts match reality
- [ ] Polls live (faster when active, slower when idle); **auto-hides when idle**
- [ ] ⚠️ Doesn't flash/poll noisily before login (recent "quiet pre-login polls" fix)
- [ ] Doesn't shove the layout / cause content jump when it appears or hides
- [ ] 📱 Doesn't eat too much vertical space on a phone

## 7. Languages 🆕
- [ ] Multi-select language pills work; grouped under the chooser toggle
- [ ] Language preference actually filters the catalog (this was broken once)

## 8. Almanac / Space mini-apps
- [ ] Today card → Space mini-app loads (lazy-loaded); moon renders, sky animates
- [ ] Almanac opens; sections render without console errors
- [ ] GPS prompt / manual lat-lon fallback works (desktop has no GPS)
- [ ] No layout breakage on the animated scenes; scrolling smooth

## 9. Accessibility ⚠️ (claimed Lighthouse 100 — verify it holds in v1.7.0)
- [ ] **Tab** through the whole topbar: focus ring visible (amber), logical order
- [ ] **Skip-link** appears on first Tab and jumps to main content
- [ ] Modal/dialog (settings, reader) traps focus; Esc closes; focus returns sensibly
- [ ] Every icon button has a discernible label (screen-reader / VoiceOver spot-check)
- [ ] Forced-colors / high-contrast mode doesn't make anything invisible
- [ ] Re-run Lighthouse a11y once on Home — confirm still ≥90 (was 100 in dev)

## 10. PWA / Offline
- [ ] Installs as a PWA; icon + name correct
- [ ] Service worker caches the shell; reload while "offline" still loads the app frame
- [ ] No stale-asset weirdness (app.js is auto-versioned — confirm latest loads). ⚠️ Note: WAN cache may be stale until the Cloudflare token is rotated.

## 11. i18n
- [ ] Switch locale → UI strings translate; no missing-key fallbacks showing raw keys
- [ ] Spot-check 1–2 non-English locales for layout overflow (German/long strings)

## 12. Cross-cutting polish
- [ ] Dark theme consistent; no white flashes on navigation
- [ ] 📱 Responsive: topbar, search, catalog grid, reader all usable at phone width
- [ ] Open devtools console during a full click-through — **zero uncaught JS errors**
- [ ] No layout shift / content jump on async loads (activity bar, catalog, peer pills)

---

## Live QA findings to eyeball (from 2026-06-21 smoke pass)
1. **Uncached search ~5s** — does the UI communicate the wait, or feel broken?
2. **`fast=1` no faster than full** — if any UI path advertises a "fast" search, it isn't; decide if that matters for UX.
3. **Activity bar under real 70-ZIM index load** — the one feature with the most unknowns; watch it closely.
4. **4 ZIMs mid-update** — make sure a user never sees a corrupt/empty ZIM while it downloads.

## Out of scope for this pass (tracked separately)
- BT 2-machine LAN transfer (needs a second box) → deferred to v1.7.1
- Backend perf profiling of the fast path → task #6
