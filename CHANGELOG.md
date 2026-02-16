# Changelog

## v1.2.0 — Progressive Search + SQLite Title Index

### Search
- **Two-phase progressive search** — Phase 1 returns instant title matches, Phase 2 fills in full-text results. Live timer shows progress.
- **SQLite title indexes** — persistent per-ZIM indexes built automatically on first startup. Single-word queries resolve in <1ms via B-tree prefix scan. Multi-word queries use FTS5 inverted index.
- **Parallel title search** — separate per-ZIM locks allow concurrent title lookups across all ZIMs.
- **FTS5 threshold** — ZIMs with >2M entries skip FTS5 at build time to keep startup fast. FTS5 can be enabled on-demand from the manage UI.
- **Connection pooling** — pre-warmed SQLite connections eliminate cold-start latency.

### Collections
- **Named collections** — group ZIMs into sets (e.g. "Dev", "Medical") for scoped search via API or MCP.
- **Category-grouped picker** — ZIMs organized by category (Wikimedia, Stack Exchange, Dev Docs, etc.) when editing collections.

### Library Manager
- **Server stats** — request counts, latency, cache hit rates, title index status, and disk usage.
- **Compact title index card** — single-row summary with on-demand "Enable deep search" for large ZIMs.
- **Safe delete** — two-click confirmation prevents accidental collection deletion.

### Data
- **`ZIMI_DATA_DIR`** — dedicated data directory for indexes, cache, password, and collections. Defaults to `.zimi/` inside the ZIM directory. Legacy files auto-migrate on upgrade.
- **Storage** — title indexes use ~2–3% of total ZIM size on disk.

### Other
- Per-ZIM suggestion cache (15min TTL, 500 entries)
- MCP collection support in search and suggest tools
- iOS Safari zoom fix (16px font-size on search input)
- 63 unit tests

### Performance (55 ZIMs, spinning disk)

| Scenario | Before | After |
|----------|--------|-------|
| Title search (single word, cold) | 40s | <1ms |
| Title search (multi-word, cold) | 40s+ | <2s |
| Title search (cached) | 0.2s | 0.2s |
| Full-text search | 12–55s | 12–55s (unchanged) |
| Title index build (all 54 ZIMs) | N/A | ~18 min (one-time) |

## v1.1.0 — Safe Downloads + Rate Limiting

- Safe downloads with resume support and stale `.tmp` cleanup
- Rate limiting (60 req/min per IP) with 429 Retry-After headers
- Request metrics and server stats
- Search result caching (LRU, 100 entries, 5min TTL)
- Auto-update scheduler with UI toggle
- UI polish: flavor picker, deep link routing

## v1.0.0 — Initial Release

- JSON API (search, read, suggest, list, random, catalog)
- MCP server for AI agent integration
- Web UI with dark theme, cross-source search, in-browser reader
- Library manager (browse Kiwix catalog, download, update, delete)
- Password-protected management
- Cross-ZIM search with relevance ranking and deduplication
- Pre-warmed archive handles for fast first search
