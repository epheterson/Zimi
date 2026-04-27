# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

The "Reach + Pro" release. Addresses issue #15 (the warlordattack feedback set
covering UX at 1000+ ZIM scale) and issue #16 (Wikipedia maxi auto-updating to
mini). Also lays groundwork for the Reach track (P2P/torrent + accessibility,
plan docs in `docs/plans/`).

### Added

- **Pro hot-cache** — Pin selected ZIMs in memory at startup so cold ones stay
  lazy. `ZIMI_HOT_ZIMS` env var (csv) overrides `ZIMI_DATA_DIR/hot.json`. New
  `GET/POST /manage/hot` endpoints. UI in Server settings with search box,
  select-all/none, and threshold-based collapse for small libraries (#15-5b)
- **Download queue** — Concurrent-download cap (default 3, env-overridable via
  `ZIMI_MAX_CONCURRENT_DOWNLOADS`); extras queue smallest-first to maximize
  early throughput (#15-2c)
- **Multi-select downloads** — Floating action bar with selection count, total
  size, Clear, and Download Selected. Uses new `POST /manage/download-batch`
  with size hints feeding the queue order (#15-2a)
- **Pause / resume on downloads** — `/manage/pause` and `/manage/resume`
  toggle a per-download flag the read loop respects. Slot stays held so
  pausing some downloads redirects bandwidth to others (#15-2f)
- **Filter pills on Downloads tab** — All / Downloading / Queued / Completed
  with counts, persisted in localStorage (#15-2g)
- **Catalog hierarchy detection** — Heuristic detects bundle/subset
  relationships across catalog items (e.g. wikipedia_en_top is part of
  wikipedia_en_all). Surfaced as badges: green "Already covered by ..." on
  installed bundles, gray "Part of ...", amber "Includes N smaller variants",
  green "Strictly contains all parts" coverage signal, orange "N fresher
  subset(s)" freshness signal. `?include_hierarchy=1` on /manage/catalog
  (#15-3)
- **SearXNG integration** — `/search` results now include a `category` field
  (general/images/video) so SearXNG can route hits to the right tab. Engine
  template + setup guide at `docs/integrations/searxng.md` (#15-4)
- **OpenWebUI / generic-AI** — MCP integration docs at
  `docs/integrations/openwebui.md` (#15-7)
- **Updates detail panel** — Click "N available" in Library card to expand a
  list with installed-date → latest-date and full filename diff per ZIM. New
  `/manage/updates` endpoint backs the UI (#15-7b, #16-2)
- **Top-search analytics** — `/manage/usage` reports `top_searches` with
  bounded LRU counter (5000 keys cap). Grafana-scrapeable as plain JSON
  (#15-8)
- **Cache management UI** — Server-settings buttons: Clear search cache,
  Clear suggest cache, Rebuild title indexes, Rebuild Q-ID indexes. Backed
  by `POST /manage/cache-action` (v1.6.1 follow-up)
- **Languages preference** — Pill multi-select in Preferences (13 common
  languages + multi). Catalog filter respects the choice when no per-tab
  language pill is set (#15-6)
- **Default download flavor preference** — Pill radio: Full (with images),
  No images, Mini. The user's preference becomes the default in every
  flavor-selector dropdown (#15-6c)
- **Updates Available section** — Pending updates bubble to the top of the
  Installed view in their own amber-headed group instead of mixing with
  category sections
- **Plan docs** — `docs/plans/2026-04-26-p2p-torrent-sharing.md` and
  `docs/plans/2026-04-26-accessibility.md` for the Reach track
- **BitTorrent transport (opt-in)** — `ZIMI_TORRENT=1` enables the
  bundled aria2 sidecar. Downloads with a Kiwix `.torrent` companion
  use BT first; HTTP mirrors are tried on no-peers / hash mismatch.
  Completed files seed by default (capped at 2× ratio, disk-pressure
  auto-pause, `ZIMI_SEED=0` to disable). Active downloads show a small
  amber `BT · Np` pill on their card.
  - Server-settings shows live aria2 status (port, backend, ready/off
    state) and a per-torrent list with peer count, uploaded bytes,
    ratio, and a ratio progress bar
  - `GET /manage/bt-status`, `GET /manage/seeding` expose the data
  - Backend abstraction (`BTBackend`) keeps room for qBittorrent /
    Transmission / Deluge as drop-in implementations (the *arr-stack
    pattern: reuse the existing client's UI for power users)
- **LAN peer discovery (opt-in)** — `_zimi._tcp.local` advertised via
  Zeroconf with TXT records (version, zim_count, port, bt_port). New
  `GET /manage/peers` returns discovered peers. `ZIMI_PEER_DISCOVERY=0`
  disables. Note: in Docker bridge mode, mDNS multicast doesn't reach
  the LAN — use `network_mode: host` to expose discovery beyond the
  container
- **Catalog peer pills** — when a discovered LAN peer already has a
  ZIM, a small green "📡 peer-name" pill appears on its catalog card.
  Clients fetch each peer's `/list` via the cached
  `GET /manage/peers/list?peer=NAME` endpoint and match by stripped
  filename stem. Phase 1 is informational; phase 2 will route the
  download through the peer (BT preferred)
- **Accessibility track (#19)** — Reach goal: build once and benefit
  every screen-reader, keyboard, and low-vision user, forever.
  - Skip-to-main-content link, first tab-stop, hidden until focused
  - `role="dialog" aria-modal="true" aria-labelledby="pw-title"` on
    the password modal, with Esc-to-close and Tab focus-trap that
    cycles within the modal so keyboard users can't accidentally
    escape into the background page. Focus is restored to the
    previously-focused element on close
  - `role="search"` + visually-hidden `<label>` on the topbar search,
    plus `aria-autocomplete="list"` and `aria-controls="suggest-dropdown"`
    so suggestions announce correctly
  - `role="status" aria-live="polite"` toast region. `_showToast()`
    now mirrors text into the live region so non-sighted users hear
    the same feedback sighted users see
  - High-contrast amber `:focus-visible` ring across the SPA (2px,
    offset 2px). Buttons and inputs that style their own focus opt
    out via `:not(:focus-visible)`
  - `<label for>` association added to onboarding ZIM-folder field
    and password input (was placeholder-only)
  - **ZIM article HTML rewriter** (opt-in via Preferences →
    "Improve ZIM article accessibility"): when on, every `/w/*`
    article is run through `zimi.a11y.rewrite_html()`, which adds
    missing `alt=""` to images (decorative-by-default per WCAG
    1.1.1), promotes the first `<div class="title">` to `<h1>` when
    no real `<h1>` exists, and fills `<html lang>` from the ZIM's
    language metadata. 21 unit tests cover each transform plus
    idempotency and malformed-input safety. Default off so byte-
    purist users get the original HTML; toggle persists in
    localStorage. Activated per-request via `?a11y=1` query param.
    Live measurement on the Wikipedia Albert Einstein article: 25
    additional images announced (was 17/42 with alt; now 42/42)
  - **`forced-colors` (Windows High Contrast) support** — system
    colors (`Highlight`, `ButtonText`, `ButtonFace`, `ButtonBorder`)
    applied to focus rings, buttons, and pills so the user's chosen
    OS scheme is honored end-to-end
  - **Almanac sky scene now described for screen readers** — the
    canvas-based sky animation gets a sibling `<div class="sr-only">`
    populated from the same astronomical data we render visually.
    Reads like: "Almanac sky for Monday April 27, 1:45 PM. Sun 47°
    above the horizon. Moon 83% illuminated, 23° above the horizon.
    412 stars visible above the horizon." Updates once per render
    (the per-frame visuals are decorative)
  - `prefers-reduced-motion: reduce` already gated transitions
    globally; left as-is
- **Networking** — Default Docker compose flips to `network_mode: host`
  so mDNS + BT seeding work out of the box. New
  `docs/deployment-networking.md` covers tradeoffs (host / bridge /
  macvlan), Synology Avahi coexistence, Cloudflare Tunnel WAN-seeding
  limits

### Changed

- **Downloads is its own manage subtab** alongside Installed / Catalog /
  Collections / Activity instead of rendering above them. Active-count
  badge on the tab label. Subtab order optimized for frequency-of-use
  (#15-2b)
- **Catalog + Downloads use a responsive grid layout**
  (`grid-template-columns: repeat(auto-fill, minmax(320px, 1fr))`) so wide
  screens fit 2-3 cards per row, narrow screens fall back to 1. Catalog
  cards stack icon + info + actions vertically inside grid cells for a
  compact card aesthetic (#15-2d, #15-2d')
- **Installed and already-covered catalog items** are dimmed and pushed to
  the back of the sort so actionable items rise to the top (#15-3b)
- **Catalog item-installed matching** now also tries the prefix derived from
  the OPDS download_url. Recovers cases where Kiwix returns a truncated
  `name` field (`canadian_prep_*` vs `canadian_prepper_*`) (#15-8a)
- **Auto-version rewriter** now also processes inline `/static/X?v=N` refs
  inside app.js, served from memory. Prevents Cloudflare-immutable cache
  staleness on lazy-loaded sub-bundles (almanac.js)
- 25+ new i18n keys localized in all 10 supported languages

### Fixed

- **Wikipedia maxi auto-updating to mini** (#16) — `_check_updates` now
  filters catalog candidates to the SAME flavor as the installed file. A
  newer mini will never silently replace a maxi. New `_detect_flavor()`
  helper handles maxi/nopic/mini/None cases. Six new tests including the
  exact bug scenario verbatim
- **Almanac crash on render** — `_METEOR_SHOWERS` table only had `key`
  fields, but two callers passed `s.name` (undefined) to `_th()`. New
  `_showerName(s)` translator + defensive `_th()` against undefined input
- **Bitwarden / 1Password ignoring the manage password input** —
  `data-1p-ignore` was on the password modal field; removed. Form now
  uses the standard `current-password` autocomplete contract (#15-1a)
- **"Remember me" did not persist across tab close** — was using
  `sessionStorage`. Now uses `localStorage` when checked, `sessionStorage`
  when unchecked. Logout clears both (#15-1b)
- **Pre-existing TestSearchAllContract no-op patches** — surfaced when new
  test files imported zimi early; replaced with proper string-form
  `@patch("zimi.server.get_zim_files")` so the patches actually patch

### Performance

- Search now searches only the user's preferred languages by default when
  set, avoiding per-ZIM Xapian work on irrelevant ZIMs
- Search-query counter for top-N is bounded so distinct-query patterns
  can't grow it unboundedly

### Tooling

- `package.json`'s default `npm test` placeholder now runs `pytest -q`
- `pyproject.toml` excludes the data-dependent `test_article_languages.py`
  from default pytest runs (run explicitly when investigating ZIM-data
  drift)
- `deploy.sh` order is now `down → build → up` (was `build → down → up`,
  which raced the container-name cleanup) and ships the entire `zimi/`
  package via tar so new modules deploy automatically

## [1.6.3] — 2026-04-05

### Fixed
- MCP server now warms search indexes on startup (search was returning empty results)

### Changed
- Extracted `warm_indexes()` from `serve()` so MCP and HTTP servers share the same startup path

## [1.6.2] — 2026-04-04

### Fixed
- Fresh Docker installs locked behind password prompt with no password to enter (#12)
- Removed `Sec-Fetch-Site` header dependency from all auth decisions
- Token generation and password removal errors now show user-facing messages

### Changed
- Auth accepts password or API token as Bearer on all requests (no header sniffing)
- API token requires a password to be set first
- Password can't be removed while an API token is active

### Removed
- 15 unused screenshots from repository
- Stale RELEASE_NOTES_v1.6.md

## [1.6.1] — 2026-03-27

### Fixed
- Ctrl+click and middle-click now open articles in new browser tabs everywhere
- Search/catalog filter pills left-aligned when overflowing (highest count visible first)
- devdocs name collision: CSS and Git no longer parsed as language codes
- Empty password file no longer triggers false auth prompt
- Discover cards more reliable on cold start (15s timeout + auto-retry)
- Auth unchanged: browser requests use password, API requests require token

### Changed
- Removed in-app tab bar (deferred to future release)
- Browser tabs open with full Zimi UI (`?view=1`)
- Cmd+click on Today card opens Almanac in new tab
- Cache info section in Server settings (title/Q-ID index sizes)
- 15 remaining hardcoded strings localized in all 10 languages

## [1.6.0] — 2026-03-19

The Language Release.

### Added
- 10-language UI (en, fr, de, es, pt, ru, ar, hi, zh, he) with auto-detection and full RTL layout
- Cross-language article navigation via Wikidata Q-IDs and exact title matching
- Q-ID badge on source cards showing cross-language linking support
- Language filtering in search (`/search?lang=XX`), catalog, and homepage source labels
- Tab bar with Cmd/Ctrl+click to open articles in background tabs
- PWA: service worker with offline fallback, web app manifest
- Messages Across Time: 10 historical inscriptions spanning 3,700 years in up to 10 languages
- Golden Record gallery with 49 NASA Voyager images
- Real star catalog (59 stars from Yale BSC) with 10 constellations in simulated sky
- 4 new MCP tools: `article_languages`, `read_with_links`, `deep_search`, language-filtered `search`
- API token system for programmatic access (generate/revoke tokens)
- Stable 4-icon topbar layout (close button replaces gear when reader is open)

### Changed
- Split server.py into 7 focused modules (980-line core + 6 specialized modules)
- Extracted CSS and JS from index.html into separate static files
- Separated browser auth (password) from API auth (tokens)
- Catalog language filtering is now instant (cached client-side, no server round-trips)
- Search filter pills sorted by result count in compact scrollable rows
- Orrery speed slider extended to 100M× with 3-phase acceleration
- Almanac calendar systems ordered chronologically
- Real star positions replace random dots; corrected moon parallactic angle
- Kiwix catalog thumbnails proxied server-side with 24-hour caching
- Sanitized all 500 error responses

### Fixed
- Desktop app white flash on startup
- Language pills disappearing after deep search completes
- Three-letter language codes showing as raw abbreviations in catalog
- Hebrew Wikipedia not matching for cross-language interlinking
- Partial Discover cards caching all day
- Cross-language article matching false positives (character overlap guard)
- Language dropdown async/await race conditions
- Discover card flash/pop on re-render
- PDF download from viewer showing white page instead of saving file
- Catalog language filter not drilling down into full results
- PDF.js locale suffix for English

### Security
- Rate limiting on /manage/ endpoints
- Hardened thumbnail proxy: blocked redirects, rejected non-image content
- Salted password hashing
- X-Content-Type-Options and Referrer-Policy headers

### Removed
- Translation feature (Zimi is offline-first; use multilingual ZIMs instead)
- Article map (deferred to future release)
- Eclipse simulation from almanac

## [1.5.0] — 2026-03-04

Discover, bookmarks, cross-ZIM links, and the Space almanac.

### Added
- Added Discover section with 9 daily editorial cards (Picture of the Day, On This Day, Quote, Word, Book, Destination, Talk, Comic, Country)
- Added bookmarks, search history, and browse history with Library slide-out panel
- Added cross-ZIM link highlighting with dotted underline for installed sources
- Added search result thumbnails and right-click context menu (Open in New Tab, Copy Link, Copy Title)
- Added Cmd/Ctrl+click and middle-click to open articles in new browser tabs
- Added Space almanac: hero moon, simulated sky, orrery, Tonight's Sky, meteors, events, deep time
- Added interactive calendar browser with 7 calendar systems and timezone picker
- Added macOS-style tabbed settings panel, manual ZIM import, and mirror downloads
- Added persistent suggest cache across server restarts

### Changed
- Rewrote search to use parallel B-tree title index (3,000x faster suggestions, eliminated FTS5)
- Added 6-layer startup warmup for near-instant first search
- Replaced hand-drawn canvas map with Natural Earth SVG in almanac
- Separated `ZIMI_DATA_DIR` from `ZIM_DIR` for independent configuration

### Fixed
- Fixed Wikiquote attribution parsing for multi-word names
- Fixed cross-ZIM resolution for MediaWiki `?title=` permanent link URLs
- Fixed PDF viewer through Cloudflare CDN with `?raw=1` parameter
- Fixed deadlock in lock contention under concurrent requests
- Fixed download reliability and temp file cleanup

## [1.4.0] — 2026-02-21

PDF viewer, navigation history, packaging, and auto-updates.

### Added
- Added embedded PDF viewer using pdf.js for zimgit documents
- Added navigation history with back button trail and long-press menu
- Added Sparkle auto-updater for macOS desktop app
- Added Homebrew cask, Linux AppImage, and Snap distribution
- Added macOS code signing, notarization, and arch-specific builds (Apple Silicon + Intel)
- Added gzip compression for static file serving

### Changed
- Restructured codebase into Python package for PyPI and Snap distribution

### Fixed
- Fixed PDF title showing "PDF.js viewer" instead of article name
- Fixed iframe polluting browser history (back button inconsistency)
- Fixed in-ZIM navigation for sites with original-domain baseURI

## [1.3.0] — 2026-02-17

Browse Library, desktop app, and mobile polish.

### Added
- Added Browse Library category gallery view with grouped catalog items
- Added desktop app via pywebview with `zimi desktop` subcommand
- Added `serve --ui` flag for launching with native window
- Added iOS web app support

### Fixed
- Fixed mobile Manage view layout
- Fixed "Other" category display and scroll-to-top behavior

## [1.2.0] — 2026-02-16

Progressive search and collections.

### Added
- Added progressive search with SQLite title index
- Added collections for organizing and scoping searches

## [1.1.0] — 2026-02-14

Security, auto-updates, and UI polish.

### Added
- Added rate limiting, server metrics, and safe download system with integrity checks
- Added auto-update checking and flavor picker for ZIM variant selection
- Added deep link routing

### Fixed
- Fixed cache invalidation, X-Forwarded-For security validation, and thread safety issues

## [1.0.0] — 2026-02-12

Initial release — offline knowledge server for ZIM files.

### Added
- Added HTTP API with JSON endpoints for search, read, suggest, list, and random
- Added single-page web UI with dark theme and cross-source search
- Added MCP server for Claude Code and AI agent integration
- Added Docker support
- Added support for regular ZIMs, zimgit PDF collections, and OPDS catalog

[Unreleased]: https://github.com/epheterson/zimi/compare/v1.6.3...HEAD
[1.6.3]: https://github.com/epheterson/zimi/compare/v1.6.2...v1.6.3
[1.6.2]: https://github.com/epheterson/zimi/compare/v1.6.1...v1.6.2
[1.6.1]: https://github.com/epheterson/zimi/compare/v1.6.0...v1.6.1
[1.6.0]: https://github.com/epheterson/zimi/compare/v1.5.0...v1.6.0
[1.5.0]: https://github.com/epheterson/zimi/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/epheterson/zimi/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/epheterson/zimi/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/epheterson/zimi/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/epheterson/zimi/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/epheterson/zimi/releases/tag/v1.0.0
