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
- Real night sky: the horizon scene's background stars are procedural
  filler — replace with the actual bright-star catalogue positions
  (correct layout for time/location, moving with the sky) so the scene
  matches what's really overhead. Eric: "I want REAL stars / layout in
  the sky moving."
- README demo GIF, done right: one GIF replacing ALL static screenshots —
  a full walkthrough (search, reader, interlang live usage, almanac).
  Eric likes the idea, not the 1.8.0 execution; removed for launch.
- Right-click coherence + Define discoverability: never intercept
  right-click inside article content (system menu is load-bearing);
  custom menu only on Zimi chrome (tiles/cards/rows). Fix the wart where
  right-clicking a link shows the Define chip (contextmenu leaks into the
  selection handler — suppress). Teach the Define gesture: one-time hint
  on first article-open with a Wiktionary installed + a "Look up a word"
  entry in the reader ⋯ menu that enters tap-a-word mode.
- Users allowlist discoverability: "Edit allowlist" only appears once a
  role is Limited — surface it for all roles (disabled w/ hint, or show
  the picker in Add User), so the feature Eric couldn't find is findable.
- Almanac location v2: wider typeable city set; click ANYWHERE on the map
  (not just cities) to set location; map shows every world-clock city.
  (1.8.0 ships clock-city→location sync + clock/map city parity.)
- Almanac link-map expansion round 2: more holidays and glossary terms
  Q-ID matched (Eric, ship night: "lots more holidays and terms that
  could be Q-ID matched").
- Almanac identity: its own icon in the header/tab when open, like
  entering a ZIM does.
- Holidays "Worldwide" option: a region choice that layers ALL 18 national
  packs with per-entry country tags ("Bastille Day · FR"). Default stays
  region-scoped (all packs at once ≈ 80+ national days = too noisy as a
  default, Eric agrees the option is worth having). Also: make the
  "showing X holidays" caption clickable → jumps to the location control.
- Did-you-mean vocab coverage tuning: 1.8.0 ships working corrections
  (einstien→einstein, watre→water, phlosophy, pyhton) but the 200k word
  cap saturates on ~3/66 index files, so spread-out science words
  (mitochondria, photosynthesis) get evicted before their counts build.
  Next levers: bigger cap, count-min-sketch or two-pass counting, or
  per-file word quotas. All groundwork (stride sampling, lossy eviction,
  disk-persisted versioned cache) shipped in 1.8.0.
- Snippet extraction skips boilerplate: iFixit device pages return an
  embedded "featured guides" widget's text as the snippet (e.g. a Lenovo
  SSD guide summary on the AmeriWater purifier page). previews.py should
  prefer the main content region / skip repeated-across-pages blocks.
  Found 2026-07-24 during screenshot QA; cosmetic but visible in search.
- Repo-root slimming: move zimi_desktop.py / zimi_desktop.spec /
  zimi_winsparkle.py / requirements-desktop.txt / playwright.config.mjs
  into subdirs and update CI paths (needs a full CI re-validation, which
  is why it didn't happen on ship day). The appcast*.xml files CANNOT
  move — they are live Sparkle/WinSparkle feed URLs.

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
