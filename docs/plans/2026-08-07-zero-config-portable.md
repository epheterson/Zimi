# Zero-config portable mode (1.9)

Status: Phases 1 and 3 shipped (Phase 1 all four items; Phase 3 items 7–9, item 9's empty-state rewrite having been pulled forward into Phase 1). Both pre-flight bugs fixed. Phase 2 remains opportunistic. Branch `v1.9`.

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

## Two bugs found on the way, fix these regardless — ✅ both fixed earlier in 1.9 (tests/test_magnet_boot_politeness.py, tests/test_cli_paths.py)

**A boot-time call to kiwix.org that bypasses the politeness gate.** `start_background_services` calls `ensure_magnets_for_installed` (server.py:187), which fetches the Kiwix OPDS catalog (library.py:812) gated only on `is_torrent_enabled()` — which defaults True — and on some installed ZIM lacking a recorded infohash, which is always the case for a preloaded stick or any library not downloaded through Zimi. It never consults `_catalog_refresh_wanted`. Verified: a fresh instance with one ZIM wrote `catalog_cache.json` within twelve seconds of boot; the same run with `ZIMI_TORRENT=0` wrote nothing. It runs once per process, not on a timer, so this is one request per start rather than a standing poll — but the 1.8.2 release notes say an idle instance makes zero catalog requests, and that is not currently true for the first few seconds of one. Gate it, or make it opportunistic on first real catalog use.

**A split-brain data directory.** Five data-dir paths are frozen at import time: `search.py:243` (title indexes), `search.py:1218` (did-you-mean vocab), `interlang.py:141` (Q-ID indexes), `library.py:147` (auto-update config), `library.py:350` (download schedule). The desktop launcher patches the module attribute after import and then hand-repairs exactly one of them (`desktop/zimi_desktop.py:179`). A user who sets a custom data dir in Settings therefore gets title indexes in the new location and Q-ID indexes, vocab and auto-update config in the old one. Make them functions and delete the hand-patching.

## Scope discipline

Eric, 2026-08-07: "This isn't the most important piece but would be nice to get right, don't harp on it or get too distracted and ensure our existing flow(s) continue to work well, i.e. defining a separate folder and installing normally."

So this workstream is bounded to Phase 1 plus the two bugs. Phases 2 and 3 are opportunistic. If any item here starts growing, cut it rather than pursue it: the greater 1.9 plan is `2026-08-07-v19-plan.md` and this serves one end of its range.

The compatibility contract in that document governs every change below. Restated for the part that matters most here: auto-discovery only ever fills in a value that was previously a hardcoded fallback (`/zims`, `~/Zimi`). An explicit `ZIM_DIR`, `ZIMI_DATA_DIR`, Docker mount, or a folder the user chose in the desktop app always wins, and an existing `<ZIM_DIR>/.zimi` is never moved or migrated. Each discovery change ships with a test asserting the explicit path still beats the discovered one.

Also unresolved and deliberately not assumed here: whether `<ZIM_DIR>/.zimi` should stay the default state location at all. Eric: "not all folks want a .zimi dir in their zim dir so we need to know what we're doing and make smart defaults." That default is what makes a stick work and what makes a shared ZIM folder untidy, and the two pull opposite ways. Decide it in the greater plan, not here, and change nothing for existing installs either way.

## Plan

### Phase 1, discovery. The whole feature in four changes.

1. ✅ **Binary-adjacent and cwd ZIM discovery.** SHIPPED. `discover_zim_dir()` / `discovery_candidates()` in server.py probe the frozen executable's directory, the macOS `.app` container, and the cwd for `*.zim` or a `zims/` child. Wired as the fifth, lowest resolution layer in `resolve_settings` (flag > env > config file > discovered > default) with provenance shown by `zimi config` as `(discovered: /path)`. Desktop gate is `_discover_portable_zim_dir()` in zimi_desktop.py: first run only (no config.json), no `ZIM_DIR` env, never persisted to config.json. The implicit config-file lookup follows discovery too, so a stick carrying `<stick>/.zimi/zimi.json` is self-describing. Precedence pinned by tests/test_zim_discovery.py — one explicit-beats-discovered test per layer and per discovery path.
2. ✅ **`--zim-dir`, `--data-dir` and `--host` on `serve`.** SHIPPED earlier in 1.9 (see tests/test_cli_paths.py); `serve`/`config`/`backup`/`restore` all share the boot flags.
3. ✅ **One-level-deep ZIM scan.** SHIPPED. `_scan_zim_files()` scans `ZIM_DIR` plus exactly one level of subdirectories (dotted dirs like `.zimi` excluded by glob). Collision rule, documented in the docstring and pinned by tests: root files scan first, the larger file wins per short name, a size tie keeps the root copy, every collision logged. Known accepted degradations for subdir ZIMs (all root-glob consumers in library.py, untouched by this change): no magnet/seeding enrolment, catalog installed-detection misses them, delta-update predecessor lookup won't find them, `/manage/delete` can't remove them, and the disk-usage `zim_size_gb` stat excludes them. Serving, search, title/Q-ID indexes, health checks and peer `/dl/` all work — they resolve name→path through `get_zim_files()`.
4. ✅ **Suppress the onboarding overlay when ZIMs were auto-discovered.** SHIPPED via change 1, verified rather than assumed: app.js keys the overlay on `zimsCache.length === 0`, and a discovery boot serves a non-empty `/list`, so the overlay never opens; no app.js change needed. Verified end to end through `zimi_desktop.py --serve` with a fresh HOME: ZIMs discovered from the launch folder, no config.json written, no restart (`os._exit(42)`) triggered, `is_first_run` preserved.

### Phase 2, honesty about the network.

5. **A real portable/offline switch.** Today silencing outbound traffic takes `ZIMI_TORRENT=0` (which covers DHT, the transmissionbt portcheck and the Kiwix magnet fetch) and there is no switch at all for the Sparkle appcast, which dials `raw.githubusercontent.com` on every desktop launch with no opt-out. One flag, honored by p2p.py:186, p2p_nat.py:239, library.py:793 and desktop/zimi_desktop.py:626.
6. **Flip `is_torrent_enabled()` to False in portable mode.** It is the root of most air-gapped noise: DHT churn, the portcheck probe and the boot-time catalog fetch all hang off it.

The Sparkle point is not only a portability concern. A bunker deployment and a maintained secure fleet both need an auditable "this build makes no outbound connections" claim, and the desktop build cannot currently make it.

### Phase 3, media that fights back.

7. ✅ **Automatic data-dir fallback when the ZIM dir is unwritable.** SHIPPED. `_ensure_writable_data_dir()` in server.py probes by actually writing (mkdir + tempfile + unlink — never `os.access`, network mounts lie about modes), runs early in `main()` for the CLI exit-code contract and again in `_init()` for library/desktop entry points, and logs exactly one line saying where state went and why. The fallback path is stable per library — `fallback_data_dir()` derives `<sanitized folder name>-<sha256(realpath)[:10]>` under the platform user-cache root (macOS `~/Library/Caches/Zimi`, Linux `$XDG_CACHE_HOME/zimi` or `~/.cache/zimi`, Windows `%LOCALAPPDATA%\Zimi\Cache`, stdlib only) — so indexes built on the first boot of a read-only stick are found again on the next one. Only the DERIVED default (`<zim_dir>/.zimi`) ever falls back; an EXPLICITLY configured data dir (flag/env/config file) that is unwritable is a one-line error, exit 2 — the user asked for that path, and dying beats silently going elsewhere. A missing ZIM dir keeps the shipped fail-soft boot: no library, no manufactured cache dir. `zimi config` shows the reroute as provenance: `data_dir <cache path> (fallback: <stick>/.zimi not writable)`. **The simple rule for a stick that already carries a read-only `.zimi`: no two-layer overlay.** The cache dir is used wholesale; the pre-existing cross-directory migration seeds it once from the stick copy (a read-only-safe one-shot copy of cache.json, titles/ and friends into a fresh fallback dir), and after that the cache dir is the sole data dir — the stick state is never read live. Pinned by tests/test_readonly_data_dir.py; verified live on a read-only dir: zero permission errors, title index + did-you-mean vocab + metadata cache land in the cache dir and are reused on the second boot.
8. ✅ **Fail soft in the last two write paths.** SHIPPED. `_set_manage_password` and `_generate_api_token` route through `_atomic_write_text()` (same never-raise discipline as server.py's `_atomic_write_json`): the write returns False/None on read-only media, the real OSError goes to the server log, and the HTTP callers answer 500 with a fixed generic message — no `str(e)`, no paths. The legacy-hash upgrade also degrades gracefully (keeps verifying via the v1.5 path, retries migration next login), and a token that cannot be persisted is refused rather than handed out to die at the next restart.
9. ✅ **Replace the Docker-flavored empty state.** SHIPPED with Phase 1 (it was one print statement away). The empty-library boot message now names every location actually searched — `ZIM_DIR` plus the discovery candidates — says when the directory itself is missing, and hints only about ZIMs nested deeper than the one level the scan now covers.

## The one real product decision

Portable desktop config. The desktop app stores its pointer to the ZIM directory in the host's home (`~/Library/Application Support/Zimi/config.json`, desktop/zimi_desktop.py:68). So a stick carries its state but not its pointer: move it to another machine and the app starts over at `~/Zimi` with the stick's `.zimi` orphaned beside its ZIMs.

Preferring a config beside the binary fixes the stick case and breaks a legitimate one: someone who keeps ZIMs on an external drive but wants bookmarks on their laptop. Candidate rules, in order of preference:

1. Prefer binary-adjacent config when a config file already exists there. Explicit, no magic, and makes a portable install something you opt into by shipping a config with it.
2. Prefer binary-adjacent when the bundle sits on removable media. Correct more often, but "removable" is a platform-specific guess.
3. Always prefer binary-adjacent. Simplest, and wrong for the external-drive case.

Recommendation: rule 1, with a documented way to create that file. Decide before coding; this is the only part of the feature with real ambiguity.

## Out of scope

Recursive scanning deeper than one level, a bundled ZIM downloader UI for offline sticks, and any change to how ZIMs themselves are stored or indexed.
