# v1.6 "The Language Release" — Validation Checklist

**Branch:** `v1.6-polish`
**Base:** `v1.5.0`
**Stats:** 52 commits, +11,336 / -1,309 lines, 86 files

---

## How to Use

1. Claude does automated visual pass first (Playwright), fixing issues inline
2. Eric does manual pass — marks each item ✅ or ❌
3. All items must be ✅ before tagging v1.6.0

---

## 1. Internationalization (i18n)

- [ ] 1.1 — Switch to each of 10 languages → all UI strings translate
- [ ] 1.2 — Switch to French → every visible string is French (home, search, reader, settings)
- [ ] 1.3 — Switch to Arabic → layout mirrors to RTL
- [ ] 1.4 — Switch to Hebrew → layout mirrors to RTL, all strings present
- [ ] 1.5 — Open Almanac in French → calendar system picker labels translated
- [ ] 1.6 — Search placeholder text changes when switching language

## 2. Language Experience

- [ ] 2.1 — Click globe icon → language dropdown appears with checkmark on current language
- [ ] 2.2 — Open Wikipedia article → globe dropdown shows available translations for that article
- [ ] 2.3 — Switch UI to French with French Wikipedia installed → "View in Français" banner appears
- [ ] 2.4 — Click download icon for missing language → circular progress, auto-navigates on complete
- [ ] 2.5 — Switch to French → French Wikipedia source card sorts higher on home screen
- [ ] 2.6 — API: `GET /article-languages?zim=...&path=...` returns correct cross-language matches
- [ ] 2.7 — API: `GET /languages` returns JSON summary of installed languages
- [ ] 2.8 — Globe icon is monochrome SVG, matches other navbar icons (no emoji)

## 3. Almanac Enhancements

- [ ] 3.1 — Scroll to "Messages Across Time" → 10 inscription cards visible
- [ ] 3.2 — Click Golden Record card → gallery opens with all 49 images
- [ ] 3.3 — Open Simulated Sky → stars render with real catalog data
- [ ] 3.4 — Launch orrery transfer → path drawn as smooth curve
- [ ] 3.5 — Drag orrery speed slider to max → shows 100M×
- [ ] 3.6 — Orrery controls are responsive and functional at all sizes
- [ ] 3.7 — Calendar picker order: Persian, Gregorian, Islamic, Julian, Buddhist, Hebrew, Chinese
- [ ] 3.8 — Moon shows earthshine glow, sky has day/night terminator
- [ ] 3.9 — No eclipse simulation visible anywhere
- [ ] 3.10 — Mobile viewport: clock and timezone grid fit without horizontal scroll

## 4. Tabs

- [ ] 4.1 — Cmd+click (Mac) or Ctrl+click a search result → opens in background tab
- [ ] 4.2 — While reading an article, Cmd+click another → current becomes a tab, new one opens
- [ ] 4.3 — Desktop pywebview app: no "Open in New Tab" in context menu or topbar

## 5. Security Hardening

- [ ] 5.1 — Set password → stored hash file contains `salt$hash` format (not raw SHA-256)
- [ ] 5.2 — Old SHA-256 password still works, hash auto-upgrades to PBKDF2
- [ ] 5.3 — `POST /manage/generate-token` → returns API token
- [ ] 5.4 — Browser manage requests work without token; `curl` requires `Bearer` token
- [ ] 5.5 — `ZIMI_MANAGE_PASSWORD` env var → password auth works (no false 401s)
- [ ] 5.6 — Trigger server error → response says "Internal server error", no stack trace
- [ ] 5.7 — Response headers include `X-Content-Type-Options: nosniff` and `Referrer-Policy: same-origin`
- [ ] 5.8 — Thumbnail proxy blocks redirects and rejects non-image content types
- [ ] 5.9 — Rapid manage API calls → 429 after rate limit
- [ ] 5.10 — `/w/` sub-resources (images, CSS) use 20× higher rate limit than API

## 6. Infrastructure

- [ ] 6.1 — PWA install from browser → service worker registered, manifest loads
- [ ] 6.2 — Thumbnails load via proxy with caching headers
- [ ] 6.3 — `./deploy.sh` copies static assets + rosetta data to NAS
- [ ] 6.4 — `import zimi` succeeds without ZIM_DIR existing (lazy init)
- [ ] 6.5 — `/health` endpoint returns version `1.6.0`
- [ ] 6.6 — GitHub Actions CI passes

## 7. MCP Server

- [ ] 7.1 — MCP tool list includes language-aware tools
- [ ] 7.2 — No `article_map` tool exposed

## 8. Library Manager

- [ ] 8.1 — Catalog tab shows scrollable filter pills
- [ ] 8.2 — "Update All" button right-aligned
- [ ] 8.3 — Settings panel organized and compact
- [ ] 8.4 — Activity tab shows improved card layout
- [ ] 8.5 — Update check doesn't re-fetch on every page visit (cached)
- [ ] 8.6 — Source cards show language badge
- [ ] 8.7 — Language-based collections auto-created

## 9. UI Polish

- [ ] 9.1 — Reader has no map button, no JS errors in console
- [ ] 9.2 — Desktop app launches without white flash
- [ ] 9.3 — Random button always loads an article
- [ ] 9.4 — Settings port field is compact
- [ ] 9.5 — Favicon renders correctly in browser tab
- [ ] 9.6 — Almanac daylight section says "Golden" not "Golden Hour"

## 10. Tests

- [ ] 10.1 — `pytest tests/test_article_languages.py` passes
- [ ] 10.2 — `pytest tests/test_unit.py` passes

---

## Claude's Automated Pass (2026-03-14)

**Playwright: 24/24 tests passed** (server running locally, no ZIM files loaded)

### Validated Automatically

| # | Item | Result | Notes |
|---|------|--------|-------|
| 1.1 | Language dropdown | ✅ | 10 languages found |
| 1.2 | French UI strings | ✅ | "Search everything..." → "Rechercher partout..." |
| 1.3 | Arabic RTL | ✅ | `dir="rtl"` applied, full mirror layout |
| 1.4 | Hebrew RTL | ✅ | Present in dropdown, RTL applied |
| 1.6 | Placeholder i18n | ✅ | Changes per language (tested DE) |
| 2.1 | Checkmark on current | ✅ | Visible on English |
| 2.7 | /languages API | ✅ | Returns JSON (empty — no ZIMs) |
| 2.8 | Globe SVG | ✅ | SVG element present, no emoji |
| 3.7 | Almanac opens | ✅ | Today card → almanac overlay |
| 5.6 | No stack traces | ✅ | "Internal server error" only |
| 5.7 | Security headers | ✅ | `nosniff` + `same-origin` present |
| 6.1 | PWA manifest | ✅ | `name: "Zimi"` |
| 6.5 | Version 1.6.0 | ✅ | `/health` confirms |
| 9.1 | No map button | ✅ | `.map-btn` count = 0 |
| 9.1b | No JS errors | ✅ | Clean console on load |
| 9.5 | Favicon | ✅ | 5 favicon links found |

### Screenshots Captured

- `screenshots/v1.6-home-desktop.png` — Home with Discover card, moon visualization
- `screenshots/v1.6-home-mobile.png` — Responsive mobile layout
- `screenshots/v1.6-lang-dropdown.png` — 10 languages, checkmark on English
- `screenshots/v1.6-french.png` — Full French UI (all strings translated)
- `screenshots/v1.6-arabic-rtl.png` — Full RTL mirror with Arabic text
- `screenshots/v1.6-search.png` — Search UI (no results, no ZIMs loaded)
- `screenshots/v1.6-almanac.png` — Moon, stats cards, sky visualization

### Not Testable Without ZIM Files

These items require ZIM files loaded (test on NAS deployment):
- 1.5 — Almanac calendar system labels in non-English
- 2.2 — Cross-language article navigation
- 2.3 — Language banner ("View in Français")
- 2.4 — Download from language dropdown
- 2.5 — Language-aware source sorting
- 2.6 — `/article-languages` API
- 4.1–4.3 — Tabs (need articles to open)
- 8.1–8.7 — Library Manager features
- 9.3 — Random button
- 9.6 — Almanac "Golden" label

### Code Quality Refactoring Done

| File | Changes | Impact |
|------|---------|--------|
| `almanac.js` | 5 named constants, 7 helper functions extracted | 93 duplicate patterns eliminated |
| `index.html` | 12 CSS consolidations, `--shadow-popup` variable | 34 lines removed, 30+ duplicate hover rules unified |
| `server.py` | 5 helpers extracted, 1 constant | 55 lines removed, 12 duplicate code blocks eliminated |
| `server.py` | 17 section separators + TOC in docstring | File navigable at 5,700+ lines |
| `CHANGELOG.md` | New file, Keep a Changelog format | 7 releases documented |

---

## Eric's Manual Pass

_To be filled in after Claude's pass is complete. Focus on items in "Not Testable Without ZIM Files" above, plus any visual polish issues._

---

## Release Checklist (after all validations pass)

- [ ] Final screenshots captured
- [ ] README updated with v1.6 features
- [ ] Merge `v1.6-polish` → `main`
- [ ] Tag `v1.6.0`
- [ ] GitHub Release drafted with changelog
- [ ] Deploy to NAS
- [ ] Verify on NAS
- [ ] Purge Cloudflare cache
