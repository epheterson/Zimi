# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.6.0] — 2026-03-14

The Language Release — multilingual UI, cross-language navigation, and security hardening.

### Added
- Internationalized the entire UI into 10 languages (en, fr, de, es, pt, ru, ar, hi, zh, he) with auto-detection and RTL support
- Added cross-language article navigation with language dropdown and inline ZIM download
- Added tab bar with Cmd/Ctrl+click to open articles in background tabs (max 10)
- Added PWA support: service worker with offline fallback, web app manifest for Add to Home Screen
- Added "Messages Across Time" almanac section with 10 historical inscriptions spanning 3,700 years
- Added Golden Record gallery with 49 NASA images and swipeable lightbox
- Added real star catalog (59 bright stars from Yale BSC) to simulated sky with 10 constellations
- Added 4 new MCP tools: `article_languages`, `read_with_links`, `deep_search`, and language-filtered `search`
- Added API token system for programmatic access (generate/revoke tokens)

### Changed
- Separated browser auth (password) from API auth (token) into independent mechanisms
- Extended orrery speed slider to 100M× (was 1M×) with adaptive 3-phase speed profile for smooth rocket launches
- Ordered almanac calendar systems chronologically
- Replaced random star dots with astronomically accurate positions; corrected moon parallactic angle
- Proxied Kiwix catalog thumbnails server-side with 24-hour caching and tiered rate limits
- Sanitized all 500 error responses to prevent leaking internal details

### Fixed
- Fixed desktop app white flash on startup
- Fixed tab promotion so current article becomes first tab on Cmd+click
- Fixed Almanac clock mobile layout and responsive styles
- Fixed cross-language article matching false positives with character overlap guard
- Fixed language dropdown async/await race conditions and download button persistence
- Fixed Discover card flash/pop on re-render by preserving DOM content
- Fixed PDF download from viewer showing white page instead of saving file
- Fixed catalog language filter not drilling down into full catalog results

### Security
- Added rate limiting on /manage/ endpoints to prevent brute-force and CPU DoS
- Hardened thumbnail proxy: blocked redirects, rejected non-image content
- Salted password hashing for ZIMI_MANAGE_PASSWORD
- Added X-Content-Type-Options and Referrer-Policy headers

### Removed
- Removed translation feature (Zimi is offline-first; use multilingual ZIMs instead)
- Removed article map (force-directed graph) — deferred to future release
- Removed eclipse simulation from almanac

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
