# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.6.4] — 2026-04-28

A "hold-you-over" patch release with the most impactful bug fixes
from the in-progress v1.7.0 Reach release. Cherry-picked individually,
each one validated. Larger Reach work (P2P, mDNS, mirror toggle,
accessibility, BT seeding, peer pills) ships separately when v1.7.0
finishes its full validation pass.

### Fixed

- **`/docs/docs/` doubling on zimit-scraped ZIMs** (#17, ma-javaqueen)
  — ZIMs scraped by `zimit` ship with wombat.js, which rewrites
  `<a href>` ATTRIBUTES to look like the original archived URL
  (e.g. `https://ersatztv.org/docs/`) AND installs its own click
  handler that re-resolves them — doubling the path on every nested
  navigation. The iframe click chaperon now uses Kiwix's
  `_no_rewrite=true` trick to ask wombat for the actual in-archive
  URL, and registers with `capture: true` so it runs before wombat's
  interceptor. Verified end-to-end on the reporter's
  `ersatztv_2026-04.zim`. Regression test in
  `tests/test_iframe_link_chaperon.py` asserts the JS source keeps
  the four invariants (`_no_rewrite=true`, prev-flag restore,
  `capture:true`, the explanatory comment).

- **Wikipedia maxi auto-updating to mini** (#16) — `_check_updates`
  now filters catalog candidates to the SAME flavor as the installed
  file. A newer mini will never silently replace a maxi. New
  `_detect_flavor()` helper handles maxi/nopic/mini/None cases. Six
  new tests including the exact bug scenario verbatim.

- **Bitwarden / 1Password ignoring the manage password input**
  (#15-1a) — `data-1p-ignore` was on the password modal field;
  removed. Form now uses the standard `current-password` autocomplete
  contract.

- **"Remember me" did not persist across tab close** (#15-1b) — was
  using `sessionStorage`. Now uses `localStorage` when checked,
  `sessionStorage` when unchecked. Logout clears both.

- **Catalog item-installed matching** (#15-8a) — now also tries the
  prefix derived from the OPDS `download_url`. Recovers cases where
  Kiwix returns a truncated `name` field (`canadian_prep_*` vs
  `canadian_prepper_*`).

- **Missing `_updateDownloadsTabBadge` function definition** —
  internal call existed but the function body was missing on certain
  code paths.

### Added

- **Search results carry a `category` field** (#15-4) — each result
  is tagged general/images/video so SearXNG (and any future router)
  can route hits to the right tab.

- **Top-search analytics** (#15-9) — `/manage/usage` reports
  `top_searches` with a bounded LRU counter (5000-key cap).

### Changed

- **Auto-version rewriter** now also processes inline `/static/X?v=N`
  refs inside `app.js`. Prevents Cloudflare-immutable cache staleness
  on lazy-loaded sub-bundles (e.g. `almanac.js`).

- **`pyproject.toml`** excludes `tests/test_article_languages.py`
  from default `pytest` runs (data-dependent suite; run explicitly
  when investigating ZIM-data drift).

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
