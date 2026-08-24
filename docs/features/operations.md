# Operations

Running Zimi as a service: resolving configuration, backing it up, air-gapping it, monitoring it, updating it, and deploying it.

## How it works

**Configuration & the config file.** Precedence is **CLI flag > environment > config file > built-in default**. The file sits *below* the environment on purpose — adding one can never change how a running deployment behaves. `zimi config` prints every resolved value and its provenance (secrets masked), which is the report to paste into a bug thread. The config file is JSON, located via `--config`, then `ZIMI_CONFIG`, then `<data-dir>/zimi.json` if present. It can carry settings that have no CLI flag (`manage`, `manage_user`, `manage_password`, `api_token`, `offline`, `hot_zims`, `index_throttle`, `create_root`, the `sso_*` keys); a file-sourced value is published into the matching environment variable at startup, so one file can describe a whole instance with no click-through setup.

**Backup & restore.** `zimi backup [file]` writes a full-server backup bundle (users, access policy, settings, collections) to JSON (default `./zimi-backup-<date>.json`). `zimi restore <file>` applies a bundle, merging by default; `--overwrite` replaces matching state wholesale. This backs up *state*, not ZIM content — the `.zim` files are your other backup.

**Air-gap (`ZIMI_OFFLINE`).** `ZIMI_OFFLINE=1` is the single air-gap switch: no BitTorrent engine, no DHT, no NAT probe, no catalog fetch, no update check of any kind. Link-local mDNS peer discovery deliberately stays on (sharing between two Zimis on an isolated LAN is the point — turn it off too with `ZIMI_NEARBY=off`). `ZIMI_OFFLINE=1` outranks everything, including an explicit `ZIMI_BT=on` and any update channel/delay. `scripts/make-airgap-bundle.sh` builds a self-contained bundle (Zimi + every dependency as wheels, the deploy manifests, optionally a `docker save`d image and the ZIM files, `install.sh`, `SHA256SUMS`); carry it over and `install.sh` there — the install is `pip install --no-index` and touches no network. Name the target with `--target` (`linux-x86_64` / `linux-arm64` / `macos-arm64` / `macos-x86_64` / `windows-x86_64`) and `--python-version`, because wheels are platform-specific.

**Monitoring.** `GET /health` is liveness + build info (allow-filtered, reachable even in `private` mode). `GET /metrics` is Prometheus text exposition (version 0.0.4: HELP/TYPE once per family, counters `_total`, latency as a summary's `_sum`/`_count`) — **admin-gated**, so a scrape target needs the manage credential. The same snapshot is also a field of the admin-only `/manage/stats` JSON the SPA reads.

**Self-update channels.** Two channels: **latest** (default — only finished releases, the day they ship) and **beta** (whatever is newest, pre-release or final). An optional **delay** defers adopting a release by N days (choices 0/1/3/7/14/30, max 365) so you can let a release soak. `ZIMI_OFFLINE=1` performs no update check on any channel regardless. This is Zimi-build updating; ZIM *content* updates are in [Library & catalog](getting-and-sharing.md).

**Deploy manifests.** `deploy/` ships `docker-compose.yml`, `kubernetes.yaml`, and a `README.md` covering host/bridge networking and air-gap. See also [Networking & deployment modes](../deployment-networking.md).

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
| `ZIMI_MANAGE` | env / config `manage` | `1` | `0` disables `/manage/*` (and thus the `/metrics` gate's home) |
| `ZIMI_RATE_LIMIT` / `_TRUSTED` / `_LOGIN` | env | — | Request rate limits (frozen at startup) |
| `ZIMI_TRUSTED_PROXIES` | env | — | CIDR allowlist for forwarded-client-IP trust |
| `ZIMI_INDEX_THROTTLE` | env / config | `1` | Throttle background index building |

## Troubleshoot

- **A setting isn't taking effect** — run `zimi config` and read the provenance column. Remember a config-file value loses to the same environment variable and to a CLI flag.
- **Config file ignored** — check the resolution order: `--config`, then `ZIMI_CONFIG`, then `<data-dir>/zimi.json`. An unknown key warns but never fails the boot; a typo silently does nothing.
- **Data dir not writable** — Zimi logs the reason and falls back to a per-library cache dir. Fix permissions or point `--data-dir`/`ZIMI_DATA_DIR` somewhere writable to keep state where you want it.
- **`/metrics` returns 401** — it's admin-gated. Give the Prometheus scrape the manage credential (Bearer/basic).
- **Instance keeps reaching the network on an air-gapped host** — set `ZIMI_OFFLINE=1` (and `ZIMI_NEARBY=off` if you want mDNS silent too).
- **Air-gap bundle won't install on the target** — you built for the wrong platform. Wheels are OS/arch/Python-version specific; rebuild with the correct `--target` and `--python-version`. The script refuses to emit a bundle whose deps didn't all resolve to wheels.
- **Restore didn't replace old state** — restore merges by default. Use `--overwrite` to replace matching state wholesale.
- **An update landed sooner/later than expected** — check `ZIMI_UPDATE_CHANNEL` and `ZIMI_UPDATE_DELAY_DAYS`. Offline instances never update.
