# Offline catalog

**Goal.** A Zimi that has never touched the internet shows you the whole Kiwix library and lets you pull any of it from someone on your network. A Zimi that touches the internet once keeps that ability forever.

## Why

Start a fresh Zimi with no network and open Catalog. You get one line:

> **Failed to load library**
> Error: Kiwix catalog fetch failed: Catalog fetch failed

Nothing else. Not the categories, not a hint of what exists, and worst of all not the ZIMs a peer on the same LAN is offering right now. `_loadDiscover`'s sibling in the catalog view replaces the entire pane inside a `.catch()`, and `_peerOnlyEntries()` renders inside the success path, so a failed fetch hides a working feature.

Measured on a fresh instance with the network cut, 2026-09-15.

That is the opposite of the product. "Offline" is the whole pitch, and the catalog is where a person finds out what offline can contain.

## What ships in the package

Two files under `zimi/assets/`, which `pyproject.toml` already includes via `zimi = ["assets/**"]`. No packaging change.

| file | size | contents |
|---|---|---|
| `catalog-snapshot.json.gz` | 166 KB | 2,652 entries |
| `catalog-icons.tar` | 1.8 MB | 48px WebP, deduplicated by content |

Per entry: `name`, `title`, `summary`, `language`, `category`, `author`, `date`, `article_count`, `media_count`, `size_bytes`, `download_url`, `magnet`, `icon` (a content hash, or absent).

### Sizes, measured

Icons as Kiwix serves them are 9.45 MB across 2,652 entries. Re-encoded to 48px WebP they are 2.81 MB, and 36% of those are byte-identical once decoded (every Wikipedia language edition carries the same puzzle globe), so content-addressing lands at **1.79 MB**.

Against a 10.12 MB wheel that is +19%, for the difference between a catalog and a spreadsheet. The blocklist already shipping in the same directory is 646 KB, so this is the same order of thing.

A tar rather than a directory: one file, random access by offset, no gzip so seeking works. Its members are already compressed.

### Magnets cost nothing at runtime

The BitTorrent infohash is derivable from the metalink Kiwix already publishes. Kiwix's `.torrent` `info` dict carries `md5sum`, `sha1` and `sha256` alongside the usual `length`/`name`/`piece length`/`pieces`, and every one of those values is in the `.meta4`. Rebuild the dict, bencode it, SHA-1 it.

Verified against Kiwix's own `.torrent` on five files spanning 0.2 MB to 16 GB: exact match, five for five. `md5sum` is hex text in the dict while `sha1` and `sha256` are raw bytes, which is the one detail that makes a first attempt fail.

So magnets are computed once at build time and shipped as 40 hex characters each. **Never derive them on a user's machine.** That is one `.meta4` fetch per entry, which is precisely the standing-traffic pattern the 1.8.2 network discipline exists to prevent.

## The three states, and how they hand over

A person is always in exactly one of these, and moving between them is seamless and silent.

```
never online          shipped snapshot        "Library as of 16 Sep 2026"
online once, now not  cached catalog          "Library as of <fetch date>"
online                live fetch              no note
```

**Handover rule:** a successful live fetch replaces the cache wholesale, and the cache outranks the snapshot forever after. The snapshot is never written to, never merged into, and never consulted again once a cache exists. Eric, 2026-09-16: *"we update on first load or when first getting internet seamlessly and store the new cache instead."*

This is what answers the ageing problem. A shipped snapshot goes stale: six months on, its filenames have rolled over, so its download URLs 404 and its magnets point at empty swarms. It stays correct about *what exists*, which is what an offline person needs, and the moment there is any connectivity it is replaced rather than patched.

### Full cache, not page cache

Today `catalog_cache.json` stores **per-query pages**, keyed `|eng|500|0`, capped at `_OPDS_DISK_KEYS_MAX = 40`. It is a cache of requests, not of the catalog, so what survives offline depends on which pages someone happened to browse.

The change: on a successful browse, fetch all pages once and write **one catalog**: every entry, not a selection of pages. That is "a full solid cache on first start that would survive life offline after".

The existing page cache stays as it is for search keys and short-term freshness; the full catalog is a separate file, `catalog_full.json`, with its own fetch timestamp.

## Components

### `zimi/catalog_snapshot.py` (new)

Reads the two assets. Never touches the network.

- `entries()` returns the snapshot's entries, parsed once and memoised
- `built_at()` returns the date stamped at build time
- `icon(content_hash)` returns bytes from the tar, by offset, or None
- `available()` says whether the assets are present. A source checkout before the build step has run will not have them, and that must degrade quietly rather than crash.

The tar index is built once at first use: ~1,700 members, cheap.

### `zimi/library.py`

- `full_catalog()` does the resolution above: cache if present, else snapshot, else empty. Returns `(entries, source, as_of)` where `source` is `live|cache|snapshot|none`.
- `_persist_full_catalog(entries)` is an atomic write of `catalog_full.json`, called after a successful full fetch.

### `zimi/http.py`

- `GET /catalog-icon/<hash>` serves a snapshot icon, long cache, 404 when absent. Content-addressed, so it is immutable and needs no validator.

### `zimi/static/app.js`

- `_fetchCatalogItems()` falls back instead of throwing: live, then cache, then snapshot.
- The `.catch()` that replaces the pane is removed. A failure renders what is available with a dated note; peer-only entries render in every case, because a peer offering a ZIM is a fact about the local network and has nothing to do with whether Kiwix answered.
- `_catalogStaleNote()` gains the snapshot case: "Library as of 16 Sep 2026" rather than an error.

### `scripts/build_catalog_snapshot.py` (new)

Run in a release workflow, not on every CI run. Fetches the OPDS catalog, fetches each `.meta4`, derives infohashes, fetches and re-encodes icons, writes both assets, commits them.

**Incremental, keyed on the filename.** A Kiwix ZIM's filename carries its build date (`wikipedia_en_all_2026-07.zim`), so an unchanged filename is the same bytes and therefore the same infohash. The build loads the previous snapshot and reuses the magnet and icon of every entry whose filename is unchanged, fetching only the rest.

Measured churn: 477 of 2,652 entries (18%) were rebuilt in a two-month window. So a cold build is **4.2 minutes and 73 MB**, and every build after it is about **48 seconds**. One machine, once per release, with a `User-Agent` that says what it is.

**A canary, not a re-proof.** The derivation is settled: verified against Kiwix's own `.torrent` on 50 entries from 0.3 MB to 22.8 GB, zero mismatches. The remaining risk is not ours, it is Kiwix changing how they generate torrents, which would silently ship 2,652 wrong magnets. So each build fetches ten real `.torrent` files at random and asserts the derived infohash matches. Ten extra requests, and a loud failure instead of a quiet one.

Failure policy: a single entry that cannot be resolved loses its magnet or its icon and keeps its metadata. The build fails if the catalog fetch fails, if fewer than 90% of entries resolved, or if any canary mismatches.

## Testing

| what | how |
|---|---|
| infohash derivation | fixture `.meta4` + its real `.torrent`, assert the hashes match; includes the hex-vs-raw trap |
| incremental reuse | an unchanged filename reuses its magnet without a fetch; a changed one refetches |
| snapshot reading | a tiny generated snapshot + tar, assert entries and icon lookup |
| missing assets | `available()` false, every caller degrades, nothing raises |
| the handover | cache present beats snapshot; a live fetch replaces the cache; snapshot is never written |
| the air-gap view | catalog fetch throws, assert peer entries still render and no error line replaces the pane |
| icon endpoint | known hash 200s, unknown 404s, path traversal in the hash is rejected |
| snapshot freshness | a test that fails if the shipped snapshot is older than 180 days, so a stale asset is caught at release rather than by a user |

## Deliberately not doing

- **No magnet derivation at runtime.** See above.
- **No merging snapshot into cache.** One wins, wholly. A merge would leave a library that is partly six months old with no way to tell which half.
- **No icons for created ZIMs** in the snapshot; those are local and already handled.
- **No shipping `icon_url`.** It is a URL to a server an offline box cannot reach. The content hash replaces it.

## Open question for review

The snapshot is rebuilt per release. If a release ships from a machine that cannot reach Kiwix, the build step fails and the release stops. The alternative is reusing the previous snapshot with a warning. I lean towards failing: a release that silently ships a year-old catalog is worse than a release that waits.
