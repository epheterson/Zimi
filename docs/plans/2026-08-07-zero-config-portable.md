# Zero-config portable mode (1.9)

Status: planned, not started. Branch `v1.9`.

Eric's framing, which this plan serves the bottom half of: "a USB drive standalone in a bunker inside a folder of ZIMs that automatically just works. Up to a deployed maintained secure system used by millions. And the dude with a NAS. Ready, for anyone."

The enterprise half is `roadmap-2026-07.md`, Addendum 2026-07-23. This doc is the other end: someone drops Zimi into a folder of `.zim` files on a stick, on a machine with no internet, and it works.

## The finding that shapes the plan

There is no large work here. The architecture already made most of the right calls, years before anyone framed this as a goal:

- Every piece of state already lives in `<ZIM_DIR>/.zimi` — roughly twenty files, all of them travelling with the ZIMs rather than scattering into the host's home directory.
- The frontend is genuinely offline. No CDN, no remote fonts, no map tiles, no ephemeris service, no telemetry. The world map, the timezone polygons and the star catalogue are all local assets.
- First run needs no setup. Access defaults to open, no password, no scan wait, no login gate. Launch to reading an article is one click.
- Read-only media already degrades rather than fails: read, search and suggest all work, and state writes fail soft.
- `ZIM_DIR` read-only plus a writable `ZIMI_DATA_DIR` runs today with zero errors. The mechanism exists; nothing selects it automatically.
- The frozen desktop binary already ships one-dir with libzim, certifi, i18n, pdfjs and every almanac asset, and already accepts `--serve --zim-dir`.

So this is a discovery problem plus a handful of default flips, not a re-architecture. What follows is ordered by leverage, not by size.

## Two bugs found on the way, fix these regardless

**A boot-time call to kiwix.org that bypasses the politeness gate.** `start_background_services` calls `ensure_magnets_for_installed` (server.py:187), which fetches the Kiwix OPDS catalog (library.py:812) gated only on `is_torrent_enabled()` — which defaults True — and on some installed ZIM lacking a recorded infohash, which is always the case for a preloaded stick or any library not downloaded through Zimi. It never consults `_catalog_refresh_wanted`. Verified: a fresh instance with one ZIM wrote `catalog_cache.json` within twelve seconds of boot; the same run with `ZIMI_TORRENT=0` wrote nothing. It runs once per process, not on a timer, so this is one request per start rather than a standing poll — but the 1.8.2 release notes say an idle instance makes zero catalog requests, and that is not currently true for the first few seconds of one. Gate it, or make it opportunistic on first real catalog use.

**A split-brain data directory.** Five data-dir paths are frozen at import time: `search.py:243` (title indexes), `search.py:1218` (did-you-mean vocab), `interlang.py:141` (Q-ID indexes), `library.py:147` (auto-update config), `library.py:350` (download schedule). The desktop launcher patches the module attribute after import and then hand-repairs exactly one of them (`desktop/zimi_desktop.py:179`). A user who sets a custom data dir in Settings therefore gets title indexes in the new location and Q-ID indexes, vocab and auto-update config in the old one. Make them functions and delete the hand-patching.

## Plan

### Phase 1, discovery. The whole feature in four changes.

1. **Binary-adjacent and cwd ZIM discovery.** Before falling back to `~/Zimi` or `/zims`, probe the directory containing the executable (and the `.app` container, already computed at `desktop/zimi_desktop.py:403-405`) and the working directory, for `*.zim` or a `zims/` subdirectory. Single highest-leverage change in this document; two call sites.
2. **`--zim-dir`, `--data-dir` and `--host` on `serve`.** server.py:1630 has only `--port` and `--ui`. Env-only configuration is hostile to anyone not writing a compose file, and `0.0.0.0` is the wrong default for a stick plugged into an untrusted network.
3. **One-level-deep ZIM scan.** server.py:984 is a flat glob and server.py:1586 already prints a hint when it finds ZIMs in subdirectories, so the user need is proven by our own warning text.
4. **Suppress the onboarding overlay when ZIMs were auto-discovered.** app.js:15650 keys on `zimsCache.length === 0`, so change 1 should suppress it for free. Verify rather than assume, and confirm no restart is triggered — choosing a folder currently restarts the app via `os._exit(42)`.

### Phase 2, honesty about the network.

5. **A real portable/offline switch.** Today silencing outbound traffic takes `ZIMI_TORRENT=0` (which covers DHT, the transmissionbt portcheck and the Kiwix magnet fetch) and there is no switch at all for the Sparkle appcast, which dials `raw.githubusercontent.com` on every desktop launch with no opt-out. One flag, honored by p2p.py:186, p2p_nat.py:239, library.py:793 and desktop/zimi_desktop.py:626.
6. **Flip `is_torrent_enabled()` to False in portable mode.** It is the root of most air-gapped noise: DHT churn, the portcheck probe and the boot-time catalog fetch all hang off it.

The Sparkle point is not only a portability concern. A bunker deployment and a maintained secure fleet both need an auditable "this build makes no outbound connections" claim, and the desktop build cannot currently make it.

### Phase 3, media that fights back.

7. **Automatic data-dir fallback when the ZIM dir is unwritable.** Probe at `_init()` (server.py:260); on failure fall back to a platform cache dir and log once. Turns today's four-error degraded boot into a clean one, and restores the title index, did-you-mean and Q-ID links that a read-only stick currently loses.
8. **Fail soft in the last two write paths.** `_set_manage_password` (manage.py:130) and `_generate_api_token` (manage.py:170) use bare `open()` and raise on read-only media instead of returning a clean error.
9. **Replace the Docker-flavored empty state.** server.py:1593 says "check your volume mount", which is wrong for every non-Docker user and actively confusing for the audience this feature exists for.

## The one real product decision

Portable desktop config. The desktop app stores its pointer to the ZIM directory in the host's home (`~/Library/Application Support/Zimi/config.json`, desktop/zimi_desktop.py:68). So a stick carries its state but not its pointer: move it to another machine and the app starts over at `~/Zimi` with the stick's `.zimi` orphaned beside its ZIMs.

Preferring a config beside the binary fixes the stick case and breaks a legitimate one: someone who keeps ZIMs on an external drive but wants bookmarks on their laptop. Candidate rules, in order of preference:

1. Prefer binary-adjacent config when a config file already exists there. Explicit, no magic, and makes a portable install something you opt into by shipping a config with it.
2. Prefer binary-adjacent when the bundle sits on removable media. Correct more often, but "removable" is a platform-specific guess.
3. Always prefer binary-adjacent. Simplest, and wrong for the external-drive case.

Recommendation: rule 1, with a documented way to create that file. Decide before coding; this is the only part of the feature with real ambiguity.

## Out of scope

Recursive scanning deeper than one level, a bundled ZIM downloader UI for offline sticks, and any change to how ZIMs themselves are stored or indexed.
