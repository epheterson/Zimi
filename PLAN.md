# Zimi — Development Plan

## v1.0 — Shipped 2026-02-14
- [x] JSON API, MCP server, Web UI, CLI
- [x] Cross-ZIM search with relevance ranking and deduplication
- [x] Library manager (browse catalog, download, update, delete)
- [x] Password-protected management
- [x] Pre-warmed archive handles for fast first search
- [x] Posted to r/Kiwix, r/selfhosted, r/DataHoarder, r/ClaudeAI
- [x] Branch protection enabled on main

## v1.1 — Shipped 2026-02-14
- [x] Safe downloads, download resume, stale .tmp cleanup
- [x] Rate limiting, 429 Retry-After, request metrics
- [x] Search result caching (LRU, 100 entries, 5min TTL)
- [x] Auto-update scheduler + UI toggle
- [x] Deployed to NAS

## v1.2 — Shipped 2026-02-15
Progressive search, SQLite title index, collections. See git tag v1.2.0.

## v1.3 — Desktop App (current)
**Goal:** Native desktop wrapper via pywebview + PyInstaller .app bundle.

### Desktop wrapper (zimi_desktop.py)
- [x] pywebview window with embedded Zimi server
- [x] ConfigManager (cross-platform persistent config.json)
- [x] Native folder picker for ZIM directory
- [x] Loading splash while server starts
- [x] Window geometry save/restore
- [x] Restart-on-config-change (exit code 42 loop)
- [x] macOS Dock icon + process name via pyobjc
- [x] Settings menu item (Cmd+,) via native macOS menu
- [x] open_external() API for PDFs/EPUBs in system viewer

### Web UI improvements
- [x] Article title syncs to window/tab title bar (frame.onload extraction)
- [x] "Browse Library" renamed to "Catalog"
- [x] Icon padding: white inside grey border (not grey margin)
- [x] Favicon: actual app icon (base64 PNG)
- [x] Catalog: pure alphabetical sort (installed threaded in, not bundled on top)
- [x] Manage: alphabetical sort within categories
- [x] Plurality helper: pl() — "1 read" not "1 reads"
- [x] Search Index card: shows Title index + Full-text index counts separately
- [x] FTS build UI: shows estimated time/storage per source
- [x] Refresh Cache: loading state + 2s debounce
- [x] Update buttons: just say "Update", tooltip shows "From X → Y"
- [x] Download state: "Downloading..." not "Queued..." when only 1 download
- [x] PDF new-tab: ?raw=1 param bypasses SPA shell (fixes infinite loop)
- [x] EPUB handling: opens in system viewer (like PDFs)
- [x] History tab: persistent event log (downloads, deletions) grouped by day
- [x] Right-click context menu on homepage ZIM cards (Open, New Tab, Favorite, Delete)
- [x] Right-click: collections submenu (add to/remove from collection, new collection)
- [x] Right-click: prevents text selection on stat-cards
- [x] Other category: autoCategorize reclassifies OPDS "other" items by name patterns
- [x] Wikimedia categorization: wikimedia/wikidata now classified under wikipedia
- [x] Category shown first in stat-card meta text (before entries/size)
- [x] Download vs Update: "Downloading..." vs "Updating..." state distinction
- [x] History: caches ZIM metadata at event time (survives deletion)
- [x] History: distinguishes Downloaded vs Updated vs Deleted events
- [x] Delete: optimistic UI (card hidden immediately, restored on error)
- [x] EPUB: click interceptor inside reader iframe opens externally
- [x] EPUB: correct mimetype (application/epub+zip) on server
- [x] PDF title leak: opening PDF externally no longer overwrites window title
- [x] deploy.sh: one command deploys NAS + syncs vault + builds .app

### PyInstaller .app bundle
- [x] zimi_desktop.spec with macOS BUNDLE
- [x] GitHub Actions workflow (macOS/Windows/Linux)
- [x] Build and test .app locally
- [x] RELEASING.md updated with desktop build docs

### Release checklist
- [x] v1.3.0 tagged and released (2026-02-18)
- [x] Docker image deployed to NAS, verified
- [x] Fresh screenshots from NAS
- [x] Desktop UI works via `python3 zimi_desktop.py`
- [x] macOS DMGs: signed, notarized, tested (Apple Silicon + Intel)
- [x] SSL fix: certifi CA bundle for PyInstaller HTTPS
- [x] README polished, release notes updated
- [x] Merged to main, v1.3 branch deleted

## v1.4 — PDF Viewer, Navigation, Distribution

### Phase 1: Embedded PDF Viewer — DONE
- [x] `/static/<path>` route with path traversal protection, MIME detection, in-memory cache
- [x] pdf.js v5.4.624 vendor files (stripped to 8MB, English locale only)
- [x] PDFs render in reader iframe via pdf.js (back button, breadcrumbs, title sync all work)
- [x] EPUBs still download (Gutenberg has HTML equivalents)
- [x] Dockerfile: COPY static/, PyInstaller spec: static/ in datas
- [x] .gitignore: anchor /build/ and /dist/ to repo root

### Phase 2: Navigation History — DONE
- [x] articleHistory array (max 50 entries) tracks {zim, path, title, timestamp}
- [x] Iframe click interceptor catches all /w/ links for history tracking
- [x] Long-press (500ms) or right-click back button shows history trail dropdown
- [x] Step-back through articles within a ZIM before closing reader
- [x] Title quality: uses document.title from previous onload
- [x] Fixed header elastic scrolling (overscroll-behavior: none)

### Phase 3: Distribution
- [x] Homebrew cask (separate repo epheterson/homebrew-zimi)
- [x] Linux AppImage (replace tar.gz in CI)
- [x] Sparkle auto-updater for macOS (EdDSA signing, appcast.xml)

### Phase 4: Release Quality Gates — DONE
- [x] `--serve` headless flag for CI testing (zimi_desktop.py)
- [x] 54 integration tests in `tests/test_server.py` (all endpoints, collections CRUD, password lifecycle, path traversal, static files)
- [x] CI runs pytest before build, smoke tests built binary after build
- [x] Two-phase release workflow (build → draft → manual QA → publish)
- [x] Pre-release QA checklist in RELEASING.md

### Comparison section in README — DONE
- [x] Compare/contrast with kiwix-serve (GitHub issue #1)

### Backlog
- [ ] Windows: proper NSIS/WiX installer (bundles .NET runtime correctly)
- [ ] Windows: code signing certificate (suppresses SmartScreen)
- [ ] System tray / minimize to tray instead of quitting
- [ ] Create ZIM from website (integrate zim-tools/zimwriterfs)
- [ ] bcrypt password hashing (replace SHA-256)
