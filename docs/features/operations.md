# Operations

Running Zimi as a service: resolving configuration, backing it up, air-gapping it, monitoring it, updating it, and deploying it.

## How it works

**Configuration & the config file.** Precedence is **CLI flag > environment > config file > built-in default**. The file sits *below* the environment on purpose — adding one can never change how a running deployment behaves. `zimi config` prints every resolved value and its provenance (secrets masked), which is the report to paste into a bug thread. The config file is JSON, located via `--config`, then `ZIMI_CONFIG`, then `<data-dir>/zimi.json` if present. It can carry settings that have no CLI flag (`manage`, `manage_user`, `manage_password`, `api_token`, `offline`, `hot_zims`, `index_throttle`, `create_root`, the `sso_*` keys); a file-sourced value is published into the matching environment variable at startup, so one file can describe a whole instance with no click-through setup.

**Backup & restore.** `zimi backup [file]` writes a full-server backup bundle (users, access policy, settings, collections) to JSON (default `./zimi-backup-<date>.json`). `zimi restore <file>` applies a bundle, merging by default; `--overwrite` replaces matching state wholesale. This backs up *state*, not ZIM content — the `.zim` files are your other backup.

**Air-gap (`ZIMI_OFFLINE`).** `ZIMI_OFFLINE=1` is the single air-gap switch: no BitTorrent engine, no DHT, no NAT probe, no catalog fetch, no download from the internet (a download from a Nearby peer on the LAN still works), no capture, no update check of any kind, no satellite data for the Almanac's 3D Earth. That last one is off by default even online: **Satellite data from the internet** is Ask first, so Zimi contacts CelesTrak only when an admin presses Get fresh data (Automatically and Never are the other choices; see [Almanac & space](reading.md#almanac--space)). Nearby's link-local mDNS discovery, when Nearby is on, deliberately stays on (sharing between two Zimis on an isolated LAN is the point; `ZIMI_NEARBY=off` turns it off too). Every destination, and its own switch, is in [What Zimi fetches from the internet](#what-zimi-fetches-from-the-internet). `ZIMI_OFFLINE=1` outranks everything, including an explicit `ZIMI_BT=on` and any update channel/delay. `scripts/make-airgap-bundle.sh` builds a self-contained bundle (Zimi + every dependency as wheels, the deploy manifests, optionally a `docker save`d image and the ZIM files, `install.sh`, `SHA256SUMS`); carry it over and `install.sh` there — the install is `pip install --no-index` and touches no network. Name the target with `--target` (`linux-x86_64` / `linux-arm64` / `macos-arm64` / `macos-x86_64` / `windows-x86_64`) and `--python-version`, because wheels are platform-specific.

**Monitoring.** `GET /health` is liveness + build info (allow-filtered, reachable even in `private` mode). `GET /metrics` is Prometheus text exposition (version 0.0.4: HELP/TYPE once per family, counters `_total`, latency as a summary's `_sum`/`_count`) — **admin-gated**, so a scrape target needs the manage credential. The same snapshot is also a field of the admin-only `/manage/stats` JSON the SPA reads.

**Self-update channels.** **Check for updates** in Server settings decides whether Zimi looks at all: **Automatically** (the default) asks GitHub when an admin opens Server settings, at most once a day, and lets the desktop app's own updater run; **Ask first** looks only when an admin presses Check now, and the desktop updater does not start; **Never** looks for nothing. `ZIMI_UPDATE_CHECK` (`ask`, `auto`, `never`) wins over the saved choice. Two channels: **latest** (default — only finished releases, the day they ship) and **beta** (whatever is newest, pre-release or final). An optional **delay** defers adopting a release by N days (choices 0/1/3/7/14/30, max 365) so you can let a release soak. `ZIMI_OFFLINE=1` performs no update check on any channel regardless. This is Zimi-build updating; ZIM *content* updates are in [Library & catalog](getting-and-sharing.md).

**Deploy manifests.** `deploy/` ships `docker-compose.yml`, `kubernetes.yaml`, and a `README.md` covering host/bridge networking and air-gap. See also [Networking & deployment modes](../deployment-networking.md).

**Native desktop window.** `zimi desktop` starts the server and opens it in a native window instead of a browser tab (`zimi serve --ui` does the same thing). It needs pywebview: `pip install 'zimi[desktop]'`; the packaged macOS, Windows and Linux desktop builds bundle it. On Linux the window is WebKitGTK, taken from the distro (`libwebkit2gtk-4.1-0` or 4.0, and `python3-gi` for a pip install); a machine without it gets the same app in the system browser, which `zimi desktop --browser` or `ZIMI_DESKTOP_BROWSER=1` asks for outright. Zimi sets `WEBKIT_DISABLE_DMABUF_RENDERER=1` and `WEBKIT_DISABLE_COMPOSITING_MODE=1` unless you set them, because WebKitGTK's GPU path draws a black window on some drivers. Everything else about the instance is identical: same library, same config, same port.

## What Zimi fetches from the internet

Everything Zimi can reach beyond this machine, one row per destination. Server settings lists the same rows under **What Zimi fetches from the internet**, each with its state right now (on its own, when asked, off) and a link to its switch. `ZIMI_OFFLINE=1` turns every row off but Nearby, which never leaves the local network.

| Destination | What | When | What it sends | Switch |
| --- | --- | --- | --- | --- |
| `library.kiwix.org` | The Kiwix catalog (OPDS) and its icons | An admin opens the catalog, the Library, Settings (the ZIM updates line) or a map's "map of here" list: a conditional request, at most once a day. The 12-hour upkeep refreshes it while Auto-update or Mirror is on, or for a week after someone browsed it. Icons come from the shipped snapshot, else through `/manage/thumb`, cached. | Zimi's user agent (its version) | `ZIMI_OFFLINE`; the shipped snapshot answers |
| `download.kiwix.org` and the mirrors its metalink names (`dumps.wikimedia.org` among them) | ZIM files; `.torrent` files for BitTorrent | A download or update someone starts; downloads in flight resume after a restart; Auto-update on its schedule (off by default). With BitTorrent on, the upkeep fetches one `.torrent` per installed ZIM that has none recorded, once. | Range requests for the file | Auto-update (Library settings); `ZIMI_OFFLINE` refuses them |
| BitTorrent peers, trackers and the DHT | Pieces of a ZIM, both ways | While a ZIM downloads over BitTorrent or seeds. The engine starts at boot only when it has work: seeds someone kept, torrents it was running, or Mirror mode. An idle Zimi joins no swarm. UPnP/NAT-PMP talk to the router, on this network. | This machine's address and BitTorrent port, the info-hashes it wants or has | Sharing: BitTorrent, Seeding, UPnP; `ZIMI_BT=off`; `ZIMI_OFFLINE` |
| `portcheck.transmissionbt.com` | Whether peers can reach the BitTorrent port | While BitTorrent is on, when an admin opens the sharing settings (Server settings) or presses recheck beside the port. Never at startup or in the background. | The port number (and so the address) | Don't open the sharing settings; BitTorrent off; `ZIMI_OFFLINE` |
| `api.github.com` | Whether a newer Zimi is out | **Check for updates**: Automatically (default), when an admin opens Server settings, at most daily; Ask first, only on Check now; Never. | Zimi's version in the user agent | Server settings: Check for updates; `ZIMI_UPDATE_CHECK`; `ZIMI_OFFLINE` |
| `raw.githubusercontent.com` | The desktop app's updater feed (Sparkle on macOS, WinSparkle on Windows) | At launch and on the updater's schedule, only under Automatically. macOS asks the person first on the second launch. | The app's version | The same setting; `auto_update_check: false` in the desktop config; `ZIMI_OFFLINE` |
| `celestrak.org` | ISS and GPS orbits for the Almanac's 3D Earth | **Satellite data from the internet**: Ask first (default), only on Get fresh data; Automatically, while the Earth view is open with data over six hours old; Never. | Zimi's user agent | The Earth view's gear (the Almanac); `ZIMI_SATELLITE_UPDATES`; `ZIMI_OFFLINE` |
| `archive.org` | StreetZim's regions (one search, one request per region, cached a day) and StreetZim downloads | An admin shows StreetZim in the catalog's Maps, or opens a map's "map of here" list; a download someone starts. | Zimi's user agent | `ZIMI_OFFLINE`; the shipped snapshot answers |
| `<team>.cloudflareaccess.com` | Cloudflare Access signing keys | Only with single sign-on set up (`ZIMI_SSO_TEAM`, `ZIMI_SSO_AUD`): when a sign-in carries a key not cached. | Nothing about the person | Don't set up SSO; `ZIMI_OFFLINE` (cached keys only) |
| The page, site, video or subreddit named on Create; `pypi.org`, `github.com`, Docker Hub for the helpers | A capture | Someone with create rights starts one. A helper (warc2zim, ArcticZim, the zimit image) installs on first use. | What a browser would send that site | Don't capture; `ZIMI_OFFLINE` refuses |
| Local network only: mDNS, other Zimis' `/list` and `/dl/` | Nearby | While Nearby is on (off by default). | This Zimi's name, address, version and ZIM count, to the LAN | Sharing: Nearby; `ZIMI_NEARBY=off` |

What reaches nothing:
- **Pages.** A ZIM's articles and the apps' pages (ZimiTube, ZimiExchange, Reddot, Zimipedia, Bookshelf) carry a Content-Security-Policy that refuses anything not served by Zimi, so what a ZIM holds cannot make the browser fetch from the internet. A link out opens only when someone clicks it.
- **The web UI.** Fonts, scripts, icons, the Almanac's textures and the PDF viewer are served by Zimi. No CDN, no analytics. The service worker caches Zimi's own pages and nothing else.
- **Startup.** An idle Zimi makes no request at boot: no catalog, no update check, no BitTorrent engine, no port check.

## Configure

| Setting | Where | Default | Effect |
| --- | --- | --- | --- |
| `ZIM_DIR` | env / `--zim-dir` | `/zims` | ZIM directory |
| `ZIMI_DATA_DIR` | env / `--data-dir` | `<ZIM_DIR>/.zimi` | Zimi's own state |
| `ZIMI_HOST` | env / `--host` | `0.0.0.0` | Bind address |
| `ZIMI_PORT` | env / `--port` | `8899` | Bind port |
| `ZIMI_CONFIG` | env / `--config` | `<data-dir>/zimi.json` | Config file path |
| `ZIMI_OFFLINE` | env / config `offline` | `0` | `1` = full air-gap (all internet features off; mDNS stays) |
| `ZIMI_UPDATE_CHANNEL` | env | `latest` | `latest` or `beta` (aliases like `stable`→latest, `edge`→beta accepted) |
| `ZIMI_UPDATE_DELAY_DAYS` | env | `0` | Defer adopting a release by N days |
| `ZIMI_UPDATE_CHECK` | env / Server settings | `auto` | Whether Zimi looks for its own updates: `auto` (when Server settings opens, at most daily, and the desktop updater), `ask` (only on Check now) or `never` |
| `ZIMI_SATELLITE_UPDATES` | env / Server settings / the Earth view's gear | `ask` | Satellite data for the Almanac's 3D Earth from CelesTrak: `ask` (only when an admin asks), `auto` (in the background, at most every six hours) or `never` |
| `ZIMI_MANAGE` | env / config `manage` | `1` | `0` disables `/manage/*` (and thus the `/metrics` gate's home) |
| `ZIMI_RATE_LIMIT` / `_TRUSTED` / `_LOGIN` | env | — | Request rate limits (frozen at startup) |
| `ZIMI_TRUSTED_PROXIES` | env | — | CIDR allowlist for forwarded-client-IP trust |
| `ZIMI_INDEX_THROTTLE` | env / config | `1` | Throttle background index building |

## Troubleshoot

- **A setting isn't taking effect** — run `zimi config` and read the provenance column. Remember a config-file value loses to the same environment variable and to a CLI flag.
- **Config file ignored** — check the resolution order: `--config`, then `ZIMI_CONFIG`, then `<data-dir>/zimi.json`. An unknown key warns but never fails the boot; a typo silently does nothing.
- **Data dir not writable** — for the default location (under the ZIM directory) Zimi logs the reason and falls back to a per-library cache dir. A data dir you set yourself (`--data-dir`/`ZIMI_DATA_DIR`) that is not writable stops Zimi at startup (exit 2), since quietly keeping state elsewhere would lose it. Fix the permissions or point it somewhere writable.
- **`/metrics` returns 401** — it's admin-gated. Give the Prometheus scrape the manage credential (Bearer/basic).
- **Instance keeps reaching the network on an air-gapped host** — set `ZIMI_OFFLINE=1` (and `ZIMI_NEARBY=off` if you want mDNS silent too). Server settings, What Zimi fetches from the internet, shows what is still on.
- **Requests to api.github.com or raw.githubusercontent.com.** Check for updates is Automatically. Ask first or Never in Server settings (or `ZIMI_UPDATE_CHECK`) stops them.
- **Requests to celestrak.org.** The Almanac's satellite data, under Automatically or after an admin's Get fresh data. `ZIMI_SATELLITE_UPDATES=never` (or Never in Server settings) stops them.
- **Air-gap bundle won't install on the target** — you built for the wrong platform. Wheels are OS/arch/Python-version specific; rebuild with the correct `--target` and `--python-version`. The script refuses to emit a bundle whose deps didn't all resolve to wheels.
- **Restore didn't replace old state** — restore merges by default. Use `--overwrite` to replace matching state wholesale.
- **An update landed sooner/later than expected** — check `ZIMI_UPDATE_CHANNEL` and `ZIMI_UPDATE_DELAY_DAYS`. Offline instances never update.
