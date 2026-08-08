# Networking & Deployment Modes

To describe an instance in one file instead of a series of flags and environment variables, see [Configuration file](#configuration-file) at the end of this document.

Zimi has two LAN-aware features that depend on how the container is networked:

1. **mDNS / LAN peer discovery** (`_zimi._tcp.local`) — needs link-local
   multicast on UDP 5353
2. **BitTorrent seeding** (default port 6881 TCP+UDP) — needs an inbound
   port that LAN peers (and ideally WAN peers) can reach

## TL;DR — pick a mode

| Mode                                    | mDNS works? | BT seeding works? | Notes                                |
| ----                                    | ----        | ----              | ----                                 |
| `network_mode: host` (recommended)      | yes         | yes               | Simplest. Container = host on LAN.   |
| Bridge + `ports: 6881 + 5353/udp`       | partial     | yes               | mDNS only on the bridge subnet       |
| Bridge + ports only (default compose)   | no          | partial           | BT works inbound, no LAN discovery   |
| `network_mode: macvlan`                 | yes         | yes               | Best isolation; complex DHCP setup   |

## Host mode (recommended)

```yaml
services:
  zim-reader:
    network_mode: host
    # no ports: section needed
    # 8899 (HTTP), 6881 (BT), 5353/udp (mDNS) all bind on the host directly
```

On Synology DSM the host's `avahi-daemon` already binds 5353. That's
fine — Linux multicast lets multiple processes share the port via
`SO_REUSEADDR` (which Python's `zeroconf` library uses by default).
Both Avahi and our zeroconf will receive multicast queries and
respond independently.

**Reverse proxies** (Traefik, Caddy, nginx) keep working — they
already point at `<host-ip>:8899`. Host mode just makes that the
real bind address instead of a docker-bridge address.

## Bridge mode with explicit mappings

If you can't use host mode (e.g., port conflicts on the host):

```yaml
services:
  zim-reader:
    ports:
      - "8899:8899"
      - "6881:6881/tcp"
      - "6881:6881/udp"
      - "5353:5353/udp"  # mDNS — only useful if no other host process binds it
```

mDNS in this config is fragile. If anything else on the host (a
Synology service, another container) already owns 5353, the bind
fails. BT seeding still works — libtorrent uses 6881 directly.

## Why mDNS is hard in containers

mDNS uses link-local multicast (224.0.0.251). Multicast packets don't
cross network bridge boundaries by default — they're scoped to the
sending interface. A container in a Docker bridge network multicasts
*on the bridge*, which the host doesn't forward to the LAN.

Three fixes:
1. **Host mode** — container shares the host network namespace, so
   multicast goes straight onto the LAN. (This is what we recommend.)
2. **macvlan** — container gets its own MAC and IP on the LAN.
   Multicast works because the container *is* on the LAN. Trickier
   because macvlan can't talk to the host by default and needs DHCP
   reservations or static IPs.
3. **Avahi reflector** — run Avahi on the host with reflector mode
   to bridge multicast across interfaces. Heavy; usually unnecessary.

## Verifying

```bash
# From any LAN device:
dns-sd -B _zimi._tcp local.        # macOS / iOS
avahi-browse -a                    # Linux (look for _zimi entries)

# Should show:
#   Add        ... _zimi._tcp.    zimi-<hostname>

# From inside Zimi:
curl -s http://<host>:8899/manage/peers | jq
```

## Cloudflare Tunnel + WAN seeding

Cloudflare Tunnel only proxies HTTP/HTTPS. BitTorrent's TCP/UDP
traffic on 6881 cannot tunnel — that's a Cloudflare design choice,
not a Zimi limitation. WAN BT seeding requires direct port forwarding
on your router. LAN seeding works regardless.

If WAN seeding isn't reachable, Zimi auto-detects via
`/manage/bt-status` (status: `unavailable`) and the UI surfaces
"leech-only mode". Downloads still work; you just can't help others.

## Configuration file

Zimi reads a single JSON file that says where the ZIMs are, where its own state goes, and what it binds. Drop it next to a deployment and the instance is fully described — no environment plumbing, no click-through setup. It is JSON because Zimi supports Python 3.9 (no `tomllib`) and ships with no third-party dependencies (no PyYAML), and because every other file Zimi writes is already JSON.

### Keys

Only settings that must be known before the server boots are in the file. Anything that already has its own state file and an admin UI — access mode, auto-update, download schedule, seeding — is configured there and is deliberately not duplicated here.

| Key        | Type   | Default                | Environment variable | Flag         |
| ---------- | ------ | ---------------------- | -------------------- | ------------ |
| `zim_dir`  | string | `/zims`                | `ZIM_DIR`            | `--zim-dir`  |
| `data_dir` | string | `<zim_dir>/.zimi`      | `ZIMI_DATA_DIR`      | `--data-dir` |
| `host`     | string | `0.0.0.0`              | `ZIMI_HOST`          | `--host`     |
| `port`     | number | `8899`                 | `ZIMI_PORT`          | `--port`     |

`data_dir` defaults to `.zimi` inside whichever `zim_dir` won, which is what makes a USB stick or a single mounted folder self-contained. Set `data_dir` explicitly to keep Zimi's state out of a shared ZIM folder.

Unknown keys are ignored with a warning naming them, so a forward-compatible file written for a later version still boots — but a typo (`zimdir`) is reported rather than silently doing nothing. A file that does not parse is fatal, and the error names the file.

### Precedence

Strictly, highest first:

1. **CLI flag** — `--zim-dir`, `--data-dir`, `--host`, `--port`
2. **Environment variable** — `ZIM_DIR`, `ZIMI_DATA_DIR`, `ZIMI_HOST`, `ZIMI_PORT`
3. **Config file**
4. **Built-in default**

The file sits *below* the environment on purpose. An existing Docker, compose or NAS deployment that sets `ZIM_DIR` keeps winning, so adding a config file to a running instance can never change how it behaves — the file only fills in what nothing else specified.

### Where Zimi looks

In order, first hit wins:

1. `--config PATH`
2. the `ZIMI_CONFIG` environment variable
3. `<data dir>/zimi.json`, if it exists

A path you name explicitly (`--config` or `ZIMI_CONFIG`) must exist; Zimi refuses to start rather than boot with silently different settings from a typo'd path. The implicit `<data dir>/zimi.json` is the opposite: no file is the normal case and Zimi says nothing about it.

Note that the implicit location depends on the data dir, which is itself resolved from flags, environment and defaults *before* the file is read. In practice that means a file left at `<zim_dir>/.zimi/zimi.json` is found on a plain `zimi serve`, and it may still point `data_dir` elsewhere for everything except itself.

### Example

A complete file — every key is optional, and this one sets all four:

```json
{
  "zim_dir": "/srv/zims",
  "data_dir": "/var/lib/zimi",
  "host": "0.0.0.0",
  "port": 8899
}
```

Boot with it:

```bash
zimi serve --config /etc/zimi.json
# or
ZIMI_CONFIG=/etc/zimi.json zimi serve
```

In Docker, mount the file into the data dir and it is picked up with no flag at all — `/config` is already `ZIMI_DATA_DIR` in the shipped image:

```yaml
services:
  zimi:
    image: epheterson/zimi
    network_mode: host
    volumes:
      - /srv/zims:/zims
      - /srv/zimi-config:/config
      - ./zimi.json:/config/zimi.json:ro
```

One caveat specific to the official image, and it follows directly from the precedence rules. The image sets `ZIM_DIR=/zims` and `ZIMI_DATA_DIR=/config` as environment variables and starts with `serve --port 8899`, so those three values are already spoken for by a higher layer: a mounted config file cannot move a running container's ZIMs, its state, or its port. That is the compatibility rule doing its job rather than a limitation to work around, and inside a container the volume mounts are the natural place to say where things live anyway.

If you do want the file to own them, override the layer that is winning. A Dockerfile `ENV` cannot be unset from compose, so set it to the value you want instead; and drop the `--port` flag by overriding `command`:

```yaml
services:
  zimi:
    image: epheterson/zimi
    network_mode: host
    command: ["python3", "-m", "zimi", "serve"]
    volumes:
      - /srv/zims:/zims
      - /srv/zimi-config:/config
      - ./zimi.json:/config/zimi.json:ro
```

The image's `HEALTHCHECK` polls `http://localhost:8899/health`, so if the file moves the port off 8899 also override `healthcheck:` to match, or the container will report unhealthy while serving perfectly.

### Checking what an instance resolved to

`zimi config` prints the effective configuration and where each value came from. This is the first thing to run when a deployment is not using the settings you thought it was:

```
$ zimi config --config /etc/zimi.json --port 8899
zim_dir   /srv/zims      (config file: /etc/zimi.json)
data_dir  /var/lib/zimi  (env: ZIMI_DATA_DIR)
host      0.0.0.0        (default)
port      8899           (flag: --port)
```

With no file in use it says so, and names the path it looked in:

```
$ zimi config
zim_dir   /zims        (default)
data_dir  /zims/.zimi  (default: <zim_dir>/.zimi)
host      0.0.0.0      (default)
port      8899         (default)

no config file in use (looked for /zims/.zimi/zimi.json)
```

## Healthcheck — `GET /health`

Unauthenticated, cheap, and safe to hammer. It reads in-memory state only — no ZIM archive is opened and no disk is walked — so a one-second interval costs nothing. This is the endpoint for a Docker `HEALTHCHECK`, a Kubernetes liveness/readiness probe, a Traefik/Caddy backend check, or an uptime monitor.

```bash
curl -s http://<host>:8899/health
```

```json
{
  "status": "ok",
  "version": "1.8.2",
  "asset_version": "zimi-v1.8.2-0c8b51a5",
  "zim_count": 53,
  "pdf_support": true
}
```

| Field           | Meaning                                                              |
| ----            | ----                                                                 |
| `status`        | Always `"ok"` when the server answers. Liveness is the 200, not this string. |
| `version`       | Zimi release version.                                                |
| `asset_version` | Content token for the web assets; changes on every deploy. The service worker uses it to drop a stale cache. |
| `zim_count`     | ZIM files visible to the caller. `0` is a valid healthy state (an empty library still serves the UI). |
| `pdf_support`   | Whether PyMuPDF is available for PDF rendering.                      |

**What a failure looks like.** There is no unhealthy JSON body — the endpoint either answers `200` with the payload above or it does not answer at all. Probe on the HTTP status and the connection, not on the body:

- **Connection refused / timeout** — process is down or still binding. On a cold start with a large library, metadata caching can hold the first request; give the probe a start period of 30–60s.
- **`503`, `502`, `504`** — these come from a reverse proxy in front of Zimi, never from Zimi itself.
- **`401`** — the instance runs in `private` public-access mode *and* something ahead of Zimi is rewriting the path. `/health` is on the private-mode login surface and stays reachable anonymously by design; a 401 here means the proxy is not sending `/health`.

`HEAD /health` also returns `200` for probes that prefer it.

Compose:

```yaml
services:
  zim-reader:
    healthcheck:
      test: ["CMD", "curl", "-fsS", "http://localhost:8899/health"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 60s
```

Kubernetes:

```yaml
livenessProbe:
  httpGet: { path: /health, port: 8899 }
  initialDelaySeconds: 30
  periodSeconds: 30
readinessProbe:
  httpGet: { path: /health, port: 8899 }
  periodSeconds: 10
```

## Metrics — `GET /metrics` (Prometheus)

Zimi speaks the Prometheus text exposition format (version `0.0.4`) at the conventional path, so a scrape config needs a target and nothing else — no exporter sidecar, no `metrics_path` override, no query parameters.

### Authentication

**`/metrics` is admin-gated. It is not public.** Request volumes and endpoint mix are operational intelligence about a private library, so the endpoint sits behind exactly the same challenge as `/manage/stats`, where these counters have always been readable:

| Instance posture                     | Anonymous scrape | With `Authorization: Bearer <api-token>` |
| ----                                 | ----             | ----                                     |
| No manage password, client on LAN/loopback | `200` (legacy open-admin rule) | `200`                        |
| No manage password, client is public | `403 public_locked` | `403` — set a password first          |
| Manage password set                  | `401`            | `200`                                    |

A scraper cannot carry a session cookie, so the **API token is the supported credential**. Generate one in Manage → API token (or set `ZIMI_API_TOKEN` in the environment; it requires a manage password to be set as well). Prometheus sends it with the `authorization` block below, which produces the same `Authorization: Bearer …` header the API already accepts. Prefer `authorization.credentials_file` over an inline token so the secret is not in the config.

### Scrape config

```yaml
scrape_configs:
  - job_name: zimi
    # metrics_path defaults to /metrics — nothing to override.
    scrape_interval: 15s
    static_configs:
      - targets: ["knowledge.example.lan:8899"]
        labels:
          instance: "nas"
    authorization:
      type: Bearer
      # Contents of the file: the API token on one line, nothing else.
      credentials_file: /etc/prometheus/zimi_api_token
```

Over HTTPS behind a reverse proxy, add `scheme: https`. If the proxy terminates TLS with an internal CA, add `tls_config: { ca_file: /etc/prometheus/internal-ca.pem }`.

Verify before wiring Grafana:

```bash
curl -s -H "Authorization: Bearer $ZIMI_API_TOKEN" http://<host>:8899/metrics
```

### What is exposed

```
# HELP zimi_build_info Zimi build information; always 1, the version lives in the label.
# TYPE zimi_build_info gauge
zimi_build_info{version="1.8.2"} 1
# HELP zimi_uptime_seconds Seconds since this Zimi process started.
# TYPE zimi_uptime_seconds gauge
zimi_uptime_seconds 13
# HELP zimi_zim_files ZIM files currently visible to this instance.
# TYPE zimi_zim_files gauge
zimi_zim_files 53
# HELP zimi_http_requests_total Instrumented HTTP requests handled, by endpoint.
# TYPE zimi_http_requests_total counter
zimi_http_requests_total{endpoint="/search"} 2
zimi_http_requests_total{endpoint="/suggest"} 1
# HELP zimi_http_request_duration_seconds Instrumented HTTP request latency, by endpoint.
# TYPE zimi_http_request_duration_seconds summary
zimi_http_request_duration_seconds_sum{endpoint="/search"} 0.000306
zimi_http_request_duration_seconds_count{endpoint="/search"} 2
zimi_http_request_duration_seconds_sum{endpoint="/suggest"} 0.000043
zimi_http_request_duration_seconds_count{endpoint="/suggest"} 1
# HELP zimi_http_errors_total Instrumented requests that ended in a handler error.
# TYPE zimi_http_errors_total counter
zimi_http_errors_total 0
# HELP zimi_http_rate_limited_total Requests rejected with 429 by the rate limiter.
# TYPE zimi_http_rate_limited_total counter
zimi_http_rate_limited_total 0
```

| Metric                                  | Type    | Notes                                                     |
| ----                                    | ----    | ----                                                      |
| `zimi_build_info`                       | gauge   | Always `1`; join on the `version` label to annotate upgrades. |
| `zimi_uptime_seconds`                   | gauge   | Seconds since this process started. A reset means a restart. |
| `zimi_zim_files`                        | gauge   | ZIM files visible to the (admin) scraper.                 |
| `zimi_http_requests_total`              | counter | Labelled by `endpoint`. Counts the instrumented endpoints only — `/search`, `/read`, `/suggest`, `/random`, `/chunks`, `/snippet` — not static assets or article bytes. |
| `zimi_http_request_duration_seconds`    | summary | `_sum` and `_count` per endpoint.                         |
| `zimi_http_errors_total`                | counter | Instrumented requests that ended in a handler error.      |
| `zimi_http_rate_limited_total`          | counter | Requests rejected with `429` by the rate limiter.         |

All counters reset to zero when the process restarts; that is normal, and `rate()` / `increase()` handle it via `zimi_uptime_seconds` dropping.

**Latency is published as a sum and a count, never as an average.** An average cannot be aggregated across instances or re-aggregated over a different time window, which is the whole reason the format asks for the two raw numbers. Compute the mean at query time:

```promql
# mean request latency per endpoint over 5m
  rate(zimi_http_request_duration_seconds_sum[5m])
/ rate(zimi_http_request_duration_seconds_count[5m])

# request rate per endpoint
rate(zimi_http_requests_total[5m])

# error ratio
rate(zimi_http_errors_total[5m]) / sum(rate(zimi_http_requests_total[5m]))
```

Quantiles (p95, p99) are **not** available: that needs a histogram, which means choosing bucket boundaries and recording a per-bucket counter at request time. It is a deliberate future change to what Zimi records, not something the exposition layer can invent from a sum.

### Cardinality

The `endpoint` label is bounded. It is never derived from the request path — every call site passes one of six hardcoded strings — so a crawler walking `/w/<zim>/<anything>` cannot mint new time series. A hard cap (64 distinct endpoints) backs the invariant up: past it, new keys stop being created rather than growing without limit.

Alerting on the healthcheck plus these counters covers the usual questions: is it up (`up{job="zimi"}`), is it serving (`rate(zimi_http_requests_total[5m])`), is it failing (`zimi_http_errors_total`), is it being throttled (`zimi_http_rate_limited_total`).

### The JSON is still there

The admin UI reads the same counters as JSON inside `GET /manage/stats` (field `metrics`). That payload is unchanged — `/metrics` adds a second rendering of the same numbers, it does not replace the first. Scripts already parsing `/manage/stats` keep working.

## Offline / air-gapped operation — `ZIMI_OFFLINE`

At default settings a running Zimi generates this network activity:

| Activity | Direction | When |
|---|---|---|
| BitTorrent engine (libtorrent): tracker announces, DHT, peer traffic | internet | BT is on by default; session starts at boot and when seeding/downloading |
| Boot-time magnet/torrent metadata fetch for seedable ZIMs | internet | rides the BT path — only when BT is enabled |
| NAT probe: SSDP multicast + UPnP SOAP to the gateway, then `https://portcheck.transmissionbt.com/<port>` | LAN + internet | at BT engine start, on the 12h maintenance loop, and on the explicit "recheck" button — all of it torrent-gated, so it never runs with BT off |
| Kiwix catalog refresh (`library.kiwix.org`) | internet | user-initiated browsing, Mirror mode, or auto-update — idle instances make zero standing requests |
| Desktop appcast check (Sparkle on macOS, WinSparkle on Windows) | internet | once per launch of the desktop app |
| mDNS LAN peer discovery (`_zimi._tcp`) | LAN multicast only | always, when Nearby sharing is on |

**`ZIMI_OFFLINE=1` is the single switch that turns off everything internet-bound**, regardless of any other setting (it outranks even an explicit `ZIMI_BT=on`):

- **BitTorrent entirely** — `is_torrent_enabled()` is forced false, so no libtorrent session, no DHT, no trackers, no boot-time magnet fetch, and downloads fall back to the plain HTTP path (which only runs when you explicitly ask for a download).
- **The whole NAT probe** — no SSDP multicast, no UPnP port mapping, no external-IP SOAP call, no `portcheck.transmissionbt.com` request. The probe is doubly covered: every caller is torrent-gated, and `p2p_nat.probe()` itself refuses under the flag so the guarantee doesn't depend on caller discipline.
- **The desktop auto-updater** — Sparkle/WinSparkle is never initialized (no framework load, no appcast fetch), not merely told to skip a check.

**What stays on, deliberately: mDNS LAN discovery** (`p2p_discovery.py`). It is link-local multicast that never leaves your network segment, it works on a fully air-gapped LAN, and offline peer-to-peer ZIM sharing (direct HTTP pulls between Zimis at `/dl/<name>`) is a headline feature exactly in that setting. "Offline" means no internet, not no network. Turn it off separately with `ZIMI_NEARBY=off` if you want radio silence on the LAN too.

Catalog browsing and update checks remain user-initiated actions; on an air-gapped network they fail cleanly with no retry loop.

The desktop app additionally honors a persisted config key, `auto_update_check` (in the desktop `config.json`, default `true`), for turning off just the appcast check without going fully offline. There is no UI toggle for either switch yet — that needs i18n across the 10 locale files and a settings-design pass, and is tracked as a follow-up.

## Backup and restore — `zimi backup` / `zimi restore` {#backup-and-restore}

One command each way, and neither needs the server running — back up *before* an upgrade, restore onto a fresh box.

```bash
# Dump everything that makes this instance THIS instance to one JSON file
zimi backup                        # writes ./zimi-backup-<date>.json
zimi backup /mnt/nas/zimi.json     # or name the destination

# Bring a (new or wiped) instance back
zimi restore /mnt/nas/zimi.json                # merges into existing state
zimi restore /mnt/nas/zimi.json --overwrite    # replaces matching state wholesale
```

The bundle is the same server-scope payload the admin UI's backup hub produces (`GET /manage/backup?scope=server`): user accounts **including password hashes**, the anonymous-access policy, collections and favorites, home layout, download schedule, auto-update setting, sharing/BitTorrent prefs, seed intents, hot-ZIM list, event history, and each user's server-stored data. It does **not** contain ZIM files — those are re-downloadable, and the bundle carries a library manifest so a restored instance knows what to fetch again.

Because password hashes ride along, the file is written with mode `0600`; treat it like a credentials file.

Both commands take the same `--zim-dir` / `--data-dir` / `--config` flags as `serve`, with the same precedence (flag > environment > config file > default), so they operate on exactly the instance a `serve` with the same arguments would boot. `restore` merges by default — same-named users and collections from the bundle win, everything else is unioned — and prints what it applied and what it skipped (for example a setting pinned by an environment variable like `ZIMI_HOT_ZIMS`, which always wins over restored state). A file that is missing, not JSON, or not a Zimi bundle is refused with a one-line error and exit code 2 before anything is touched.
