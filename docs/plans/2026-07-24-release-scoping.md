# Release scoping — locked at 1.8 wrap (2026-07-24)

Rule: nothing from the community-edition list is dropped; everything below has
a release. 1.8 ships today pending Eric's pass + go.

## v1.8.0 "Community Edition" — SHIPS NOW
Everything on the branch (~230 commits): libtorrent engine, agent API, Reader
View + palette + AUTO + lightbox + print/share, TTS, word lookup, did-you-mean,
library org + pills + tiles view, almanac deep-links (419 entities, audited
Q-IDs) + time control + BTTF panel, delta updates (BT piece reuse), Windows +
WinSparkle, light multi-user (admin/user/limited + allowlists), health report,
Save-bookmarks-to-ZIM, Tailscale end-to-end, catalog SWR, #34/#36/#37/#38
fixes, security hardening, i18n/a11y audits, repo clean-AF.

## v1.8.1 "Community Follow-through" (~1 week after ship)
The four yes-items that missed the train, plus polish debt:
- Video-ZIM experience polish (playback, resume, random video discovery card)
- zimgit / PDF collections first-class pass
- Scheduled / night-window / bandwidth-capped downloads
- Backup & export hub: library-list import/export (next to Import ZIM),
  settings/bookmarks backup-restore
- Light/dark theme toggle (whole app)
- Auto-dark for raw (non-Reader-View) articles
- Post-release issue replies (drafts queued; Eric approves each)
- NOMAD (or similar) partnership outreach — draft goes to Eric right after ship
- Windows Authenticode cert decision (kills SmartScreen warning)
- Almanac time machine, skeuomorphic pass: Eric wants a more physical
  representation of both the time scrubber and the current/destination
  (BTTF) panel — the 1.8.0 version is functional but "I don't love it"
- Almanac link-map expansion: every holiday/event with a real Wikipedia
  page gets a curated entry (Flag Day, Summer Solstice, …) — same closed-set
  provenance rules, no search fallback. Audit the full entity list for
  unmatched-but-matchable items.

## v1.9 "Industry Edition"
Enterprise + the deep community items:
- Enterprise: OAuth/OIDC SSO, SCIM/CSV user import, per-group ZIM policies,
  audit logs, forced-login/private mode, fleet deployment (compose/k8s/
  air-gapped), update channels, Prometheus metrics
- Users v2: self password change, emails, kid/school modes (ethics design
  first), per-user history/bookmarks separation
- Partial/split downloads as size-variants of ONE catalog entry
- Search depth: phrase queries, snippets/highlighting, "beautiful results"
- Reading resume (history with stored position) + highlights row
- Discovery: related articles, dice-refresh discover cards
- Maps done right (docs/plans/2026-07-22-maps-vision.md)
- Citations/quote export; multi-device state sync (mesh moves state, not
  just ZIMs)
- ZIM creation v2: zimit orchestration (Zimi as personal ZIM appliance)
- Hosted pre-built Q-ID indexes for the big Wikipedias

## v2.0 "Time Machine"
- Chat with your library → the voice/video librarian
- Eric's newspaper idea (2026-07-24): a period newspaper, grounded in the
  ZIMs, that re-typesets as you scrub the almanac's time control — "to really
  feel like you've traveled there." Pairs with LLM integration.
- Sky/scene features that change by period + location
- Extended ZIM format (backwards-compatible bundle) + almanac-as-ZIM
