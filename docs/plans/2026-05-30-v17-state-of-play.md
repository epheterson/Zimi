# v1.7.0 — State of Play (2026-05-30)

Context dump for fresh session. Read this first.

## Where we are

**v1.7.0 branch is pushed**, 84 commits ahead of `main`, 12 of those are this release. Docker `:dev` rebuilt 2026-05-22 19:27 UTC at `sha256:71cd983649b34...` — has every fix below. **Not tagged yet** → release pipeline (PyPI, Sparkle, Homebrew, Snap, `:latest`) hasn't fired.

## What's in v1.7.0 (all shipped to branch)

- **Reach track:** BT/torrent w/ aria2 sidecar, mDNS LAN discovery (`_zimi._tcp`), peer pills (clickable), info-hash storage, seeding manager, become-a-mirror toggle (`ZIMI_MIRROR=1`), custom peer name
- **A11y track:** ARIA landmarks, skip-link, focus-trap modal, focus-visible amber ring, ZIM HTML rewriter, WCAG AA contrast pass, Lighthouse 100/100
- **#15 fixes (warlordattack):** Bitwarden recognition, remember-me, download queue + multi-select + pause/resume, hierarchy detection (with cheatography false-positive fix), SearXNG `category`, OpenWebUI docs, hot-cache UI, lang pref, default-flavor pref, updates detail panel, top-search analytics
- **#16 fix:** same-flavor matching (no more mini-as-update-for-maxi)
- **#20 fix:** auto-update URL allowlist now accepts `*.kiwix.org` + Wikimedia mirror, requires https
- **Efficient-startup:** UUID staleness w/ mtime fast-path, single sequential worker (was 5 parallel), lazy archive open by default, loadavg throttle, orphan `.tmp` cleanup, Docker `start_period` 10m
- **Activity bar:** thin status row below topbar showing indexing/downloads/seeding live, auto-hides idle, polls /manage/activity (5s active / 30s idle), nudge hooks on cache-action and download-start. i18n in 10 locales
- **Cache mgmt UI:** 4 buttons (clear-search, clear-suggest, rebuild-title, rebuild-qid)

**Tests:** 501 passing, 1 skipped. Pre-commit hooks all green.

## NAS state (2026-05-30, just checked)

- **Running v1.7.0 but OLD image** — `/health` returns 1.7.0, but `/search` still times out at 10s+ (same broken behavior as May 8). Container has not been re-deployed since last cycle.
- Container last started ~2026-05-08 22:05; the May 22 `:dev` build hasn't been pulled.
- **Action needed:** `./deploy.sh` from this branch will refresh the NAS image. That alone fixes /search and the auto-update URL bug.

## Open GitHub issues

- **#15 "Few suggestions" (warlordattack)** — last reply 2026-05-22, no response from warlordattack since. He's busy too. Activity bar + lbo URL fix are in `:dev` waiting for his test.
- **#16 "Wikipedia update bug" (warlordattack)** — last reply long ago. Flavor lock IS shipped on v1.7.0; he confirmed he was on `:dev` and that fix should be in the May 22 build.
- **#20 "Log errors" (warlordattack)** — last reply 2026-05-22, no response since. URL fix is in `:dev`.

None blocking ship. All replies posted. Waiting for warlordattack to test or for us to ship.

## Validation status

`docs/plans/2026-05-11-v17-nightly-validation.md` defines 7 nightly sessions:

| Night | Topic | Done? |
|---|---|---|
| 1 | UI/UX core flows | ☐ |
| 2 | Catalog + Manage | ☐ |
| 3 | Almanac / Space | ☐ |
| 4 | BitTorrent end-to-end (needs 2 LAN machines) | ☐ |
| 5 | Accessibility (VoiceOver / Tab nav) | ☐ |
| 6 | Fragile-host NAS validation | ☐ (this is the one the NAS will gate) |
| 7 | Release ratification (tag + watch pipeline) | ☐ |

**None done.** Eric explicitly chose the nightly cadence so he doesn't have to power through. But "we gotta get to this today" suggests he wants to compress some of these.

## Recommended single-day plan (if shipping today is the goal)

1. **Deploy v1.7.0 to NAS** (5 min) — `./deploy.sh` from this branch. Validates the build runs cleanly on real hardware; auto-fixes /search and URL bug for warlordattack's setup.
2. **Smoke pass on live NAS** (15 min) — Nights 1+2 condensed. Click through home/search/catalog/manage. Verify activity bar appears under real indexing load (NAS has 70 ZIMs, post-restart will trigger build sequence so the bar will actually show). Confirm cheatography no longer flags as bundle.
3. **Skip BT 2-machine test for v1.7.0** (defer to v1.7.1) — it's high-effort and the BT path has been working on Eric's box. Tag the issue for follow-up.
4. **A11y spot-check** (10 min) — Tab through topbar, verify skip-link, run Lighthouse a11y once. If 90+, ship. (We already saw 100/100 in dev.)
5. **Cut the tag** (2 min) — `git tag v1.7.0 && git push origin v1.7.0`. Triggers Docker `:1.7.0` + `:latest`, PyPI, Sparkle, Homebrew, Snap.
6. **Manual gate: publish GitHub draft release** + reply on #15/#16/#20 with "v1.7.0 shipped" link.

**Total: ~45 min if nothing's broken.** Real risk: NAS post-deploy fails to start, or activity bar misbehaves under real 70-ZIM load.

## What you still need to decide

- Ship today, or do another night or two of validation first?
- BT 2-machine test before ship, or accept v1.7.1 follow-up?
- Drain the 3 stale in-progress task IDs (#15 W3.2, #16 W3.3, #19 W3.6) — they're all shipped, just left open.

## Pointers

- Plan doc: `docs/plans/2026-04-25-reach-pro-release.md`
- Nightly validation: `docs/plans/2026-05-11-v17-nightly-validation.md`
- This file: `docs/plans/2026-05-30-v17-state-of-play.md`
- Memory: `~/.claude/projects/-Users-elp-Repos-zimi/memory/`
- Recent commits: `git log --oneline origin/main..v1.7.0`
