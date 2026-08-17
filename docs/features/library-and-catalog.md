# Library & catalog

Your installed ZIM sources, the catalog you download more from, and how updates are matched.

## How it works

**Installed library.** Zimi serves every `.zim` in `ZIM_DIR`. On first load it builds a metadata cache (`.zimi_cache.json` — entry counts, sizes, main paths, real article counts) so subsequent boots are fast. `zimi list` (or `GET /list`) shows what's installed.

**Catalog & downloads.** The Catalog view proxies Kiwix's OPDS feed (`/manage/catalog`, count capped server-side). The client fetches the full item list once (~1,000+ items) for instant client-side category browsing and filtering, then downloads are driven through Zimi's own download machinery (with optional BitTorrent acceleration — see [Sharing](sharing.md)). Sort order: Manage view alphabetical, Home by article count, Catalog installed-first then alphabetical.

**Folders as categories.** Subfolders under `ZIM_DIR` are scanned and surface as categories. Root always wins over a subfolder copy, and the subfolder scan respects quarantines.

**Same-flavor update matching.** Kiwix publishes ZIMs in flavors — `maxi`, `nopic`, `mini` (and unflavored). The auto-updater detects each installed ZIM's flavor (`_detect_flavor`) and only ever matches a catalog entry of the **same** flavor, then the longest date-prefixed name. Crossing flavors would silently replace a full ZIM with a stripped one, so it's forbidden by construction. The updater only maintains ZIMs you already have; brand-new ones must be seeded once.

## Configure

| Setting | Where | Default | Effect |
| --- | --- | --- | --- |
| `ZIM_DIR` | env / `--zim-dir` | `/zims` | Directory of `.zim` files served as the library |
| `ZIMI_AUTO_UPDATE` | env | `0` | `1` enables automatic updates (admin override; locks the UI toggle) |
| `ZIMI_UPDATE_FREQ` | env | `weekly` | How often the updater checks the catalog |
| `ZIMI_HOT_ZIMS` | env / config `hot_zims` | `hot.json` | ZIMs to keep warm (preloaded) |
| `ZIMI_MAX_CONCURRENT_DOWNLOADS` | env | — | Cap on simultaneous downloads |

Update *channel* and *delay* (which Zimi build to self-update to) are covered in [Operations](operations.md); this doc is about ZIM content updates.

## Troubleshoot

- **Metadata / counts look wrong after a change** — delete `.zimi_cache.json` and restart so it rebuilds. On the NAS, delete the cache **after** stopping the old container, never before, or the old container rebuilds it with old values.
- **A ZIM shows "no content"** — it may be empty or broken (e.g. a 0-entry file). Check `zimi list` entry counts.
- **A new ZIM isn't auto-updating** — the updater only maintains ZIMs it already knows. Seed the file once into `ZIM_DIR`; thereafter same-flavor updates are tracked.
- **An update didn't offer itself** — Zimi only suggests same-flavor updates. A `nopic` install won't be replaced by a `maxi` catalog entry; that's intentional.
- **A subfolder copy shadows the one you want** — root always wins. Move the intended file to the top of `ZIM_DIR`, or remove the duplicate.
- **Catalog won't load offline** — the OPDS feed needs internet. With `ZIMI_OFFLINE=1` the catalog is unavailable by design; the installed library still works.
