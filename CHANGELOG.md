# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/epheterson/zimi/compare/v1.6.0...HEAD
[1.6.0]: https://github.com/epheterson/zimi/compare/v1.5.0...v1.6.0
[1.5.0]: https://github.com/epheterson/zimi/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/epheterson/zimi/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/epheterson/zimi/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/epheterson/zimi/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/epheterson/zimi/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/epheterson/zimi/releases/tag/v1.0.0
