# P2P / Torrent ZIM Sharing — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task.

**Goal:** A real torrent engine for Zimi. BitTorrent becomes the **default** transport for ZIM downloads with HTTP as fallback. Every Zimi instance seeds what it has installed, capped at 2x ratio so we're a good citizen without being a permanent leech magnet.

**Architecture:** `aria2c` as a sidecar subprocess (already widely available, MIT, supports both BT and HTTP in one binary). JSON-RPC control plane. mDNS/Zeroconf for LAN peer discovery. Info-hashes from Kiwix's published `.torrent` companions. Download paths first try the torrent, fall back to HTTP if no peers / hash mismatch / stall.

**Tech Stack:** Python 3.10+, `zeroconf` (pure Python), `aria2c` binary, JSON-RPC over HTTP localhost.

---

## Big design choices (think carefully here before coding)

### 1. Transport hierarchy

Per-download decision tree:
1. If `.torrent` URL is in catalog or info-hash known → **try BitTorrent first**
2. After 60s with 0 peers AND <1% downloaded → **fall back to HTTP**, kill the BT job
3. On hash mismatch at completion → **discard, fall back to HTTP**, log + surface

BT-first because at swarm scale it scales better than hammering download.kiwix.org. HTTP fallback because cold ZIMs may have no swarm.

### 2. Seeding policy

Default-on, capped:
- **2x ratio cap.** After uploading 2× the file size, automatic seed-stop. ZIM stays installed; peer just goes idle.
- **Per-ZIM toggle** — user can disable seeding for any ZIM (sensitive content, slow connection)
- **Global kill switch** — `ZIMI_SEED=0` to disable entirely
- **Disk-pressure auto-pause** — when ZIM_DIR free space < 5%, pause all seeding (don't help others while you're running out)
- **Bandwidth cap** — default 2 MB/s up; configurable

The 2× rule mirrors private-tracker norms without being aggressive enough to alarm anyone.

### 3. Trust model — what `.torrent` files we accept

Three paths, three trust levels:

| Source | Action |
|---|---|
| Kiwix catalog / `download.kiwix.org/zim/.../<file>.zim.torrent` | **Trusted**. Add silently. |
| Peer-advertised info-hash | **Verify first**. Hash must match an expected hash from the Kiwix OPDS metadata. Never accept hash blindly. |
| User-pasted `.torrent` file | **Confirm before add**. Show file count, total size, info-hash. Reject if filename pattern doesn't match `*.zim`. |
| Random DHT result | **Never auto-accept**. DHT is opt-in via `ZIMI_DHT=1`; results still flow through the verification gate. |

### 4. File layout

User-visible `ZIM_DIR` stays clean — it only ever contains finished `.zim` files. In-progress downloads go to a separate **staging directory** (configurable):

```
$ZIMI_STAGING_DIR/                            # In-progress only — Docker volume
  wikipedia_en_all_maxi_2026-02.zim           # Partial file
  wikipedia_en_all_maxi_2026-02.zim.aria2     # Control file

ZIM_DIR/                                      # User-visible — only completed
  wikipedia_en_all_maxi_2026-02.zim           # Atomically renamed on success

ZIMI_DATA_DIR/bt/                             # Internal — never user-touched
  torrents/<name>.torrent                     # Cached, used for seeding
  session                                     # aria2 session state
```

Why staging matters:

- A user listing `ZIM_DIR` never sees half-downloaded files. Cleaner mental model.
- Different filesystems possible — staging on fast SSD, finals on slow large NAS array. The atomic rename only works on the same FS, but a copy-then-rename is acceptable for the cross-FS case.
- Cleanup of failed/cancelled downloads is one `rm -rf $ZIMI_STAGING_DIR/*` away without risking installed ZIMs.

Defaults:

- `ZIMI_STAGING_DIR` env var, default `$ZIMI_DATA_DIR/staging`
- Docker compose adds it as a separate mount so users can target a different volume:
  ```yaml
  volumes:
    - /volume1/docker/kiwix:/zims              # final
    - /volume1/docker/kiwix-staging:/staging   # in-progress (optional override)
    - /volume1/docker/kiwix/zimi-data:/data    # control + .torrent cache
  ```

`.torrent` files stay cached in `bt/torrents/` because seeding needs them — without it, every restart would have to re-fetch metadata from peers.

### 4a. Network — port and reachability

BitTorrent needs an inbound port to accept connections. Without it, you can still leech but you're free-riding (and many peers throttle you).

- `ZIMI_BT_PORT` env var, default 6881
- Docker compose exposes it: `- "6881:6881"` (TCP + UDP)
- aria2 sidecar uses that single port for all torrents
- On startup: attempt uPnP via `aria2.changeOption {"bt-tracker-connect-timeout":"30","enable-peer-exchange":"true","listen-port":"6881"}`. If uPnP succeeds, log `BT port forwarded`. If not, log `BT inbound unavailable; leech-only mode`.
- Surface state in `/manage/seeding` UI: green dot if port is reachable, amber if unreachable, with a one-line explanation
- Optional: `/manage/bt-port-test` endpoint that pings a known reflector (e.g. `https://canyouseeme.org/check?port=6881` style) to confirm
- For users behind CGNAT or strict firewalls: seeding to LAN peers still works regardless. WAN seeding is nice-to-have, not required.

### 4b. Backend choice — bundle aria2, but support external clients

We're becoming a torrent client, but we shouldn't ignore the *arr-stack reality: many users already run qBittorrent / Transmission / Deluge with port-forwarding + ratio policies + tracker preferences they've tuned. Make integration optional.

**Tier 1 (default) — bundled aria2.** Zero config. Works out of the box. Container ships with `aria2c` and a known-good config.

**Tier 2 (optional) — external BT client via API.** Same API surface inside Zimi, different transport behind the scenes. Configured via env:

```
ZIMI_BT_BACKEND=aria2          # default
ZIMI_BT_BACKEND=qbittorrent    # use existing qBT
  ZIMI_QBT_URL=http://nas:8080
  ZIMI_QBT_USERNAME=admin
  ZIMI_QBT_PASSWORD=...
  ZIMI_QBT_CATEGORY=zimi       # so qBT shows our torrents grouped

ZIMI_BT_BACKEND=transmission
  ZIMI_TR_URL=http://nas:9091/transmission/rpc
  ZIMI_TR_USERNAME=...
  ZIMI_TR_PASSWORD=...

ZIMI_BT_BACKEND=deluge
  ZIMI_DELUGE_URL=...
  ZIMI_DELUGE_PASSWORD=...
```

Abstract via a `BTBackend` Python interface (`add_torrent`, `pause`, `resume`, `remove`, `status`). Our seeding policy still applies — we tell the backend "seed to 2× ratio, then pause" via per-client config. qBT supports per-torrent ratio limits; Transmission too; Deluge has it via plugin.

Trade-offs:

| | aria2 (bundled) | External (qBT etc.) |
|---|---|---|
| Setup | Zero | Existing client must be configured |
| Network tuning | Default | Inherits user's existing setup (port forward, NAT-PMP, etc.) |
| UI | All in Zimi | Zimi shows status; qBT WebUI shows detail |
| Maintenance | We own it | User's existing client gets the patches |
| Disk locations | Constrained to ZIMI_STAGING_DIR | Whatever the external client does (we tell it) |

Power users with NAS setups will pick external. Casual users get the bundled path.

**Recommended order:** Ship aria2 backend first (Tasks 1-7). Add qBittorrent backend later as a follow-up — same `BTBackend` interface, different impl. The interface is the important part.

### 4c. UI/UX patterns to borrow from established BT clients

We're entering a category with strong UX conventions. Steal selectively, skip what doesn't apply to single-file ZIM torrents.

**Worth borrowing:**

- **Per-torrent stats**: ratio bar, ETA, peers (seeders/leechers), active time, downloaded/uploaded totals
- **Speed graph**: small sparkline next to each active item (last 60s)
- **Force re-check**: verify pieces against hash. Useful when something feels off
- **Sequential download**: download in piece order (we don't really need this for ZIMs since they're not streamable, but cheap to expose)
- **Per-torrent labels/categories**: not really needed for us — we already categorize by ZIM topic
- **Trackers tab**: show tracker URLs + last announce status. Helps debug "no peers" issues
- **Peer list**: client name, country flag (from IP geolocation), up/down rates per peer
- **"Move to" on completion**: handled by our staging-then-rename pattern already

**Skip:**

- **RSS auto-download**: ZIMs don't have a feed convention
- **File priorities within a torrent**: ZIMs are single-file
- **Magnet link paste UI as primary entry point**: we mostly add via catalog
- **DHT bootstrap UI**: opt-in env var is enough

Concrete UI in Zimi terms:

- Per-download card grows a small inline detail expansion: ratio bar, peers, trackers, speed graph
- Server-settings "Seeding" panel: aggregate stats + per-ZIM rows
- New optional `/manage/bt-debug` page (only with `ZIMI_DEBUG=1`) showing raw aria2 status — escape hatch for power users

### 5. Cleanup paths

| Event | Action |
|---|---|
| Download success | Atomic rename to final `.zim`; keep `.torrent` for seeding; delete `.aria2` |
| Cancellation | Tell aria2 to remove (with files); delete `.aria2`, `.zim` partial, `.torrent` |
| Pause | aria2-native pause — files stay; resume = `aria2.unpause` |
| ZIM deletion | Stop seeding, delete `.torrent`, clear from aria2 session, then delete `.zim` |
| Aria2 crash | Sidecar manager restarts; aria2 resumes from session file |
| Hash mismatch on completion | Quarantine partial to `bt/quarantine/`; alert; HTTP-fallback |
| Disk full | Pause all torrents (uploads + downloads); surface error toast |

### 6. UI implications

Per-download card additions:
- **Source pill**: `BT 23 peers` / `HTTP mirror.kiwix.org` / `Peer @home-nas`
- **Up/down speeds split**: `5.2 MB/s ↓ · 1.1 MB/s ↑`
- **Seeders/leechers** when known
- **Pause/Resume** already covered by W2.1; aria2-native

New Server-settings panel "Seeding":
- Per-ZIM rows: name, ratio progress, bandwidth used, [Pause] [Stop seeding]
- Aggregate: total uploaded, avg ratio, total peers reached
- Global toggle, bandwidth cap input

Catalog item card additions:
- When peer has it: green "📡 LAN peer @home-nas" pill above download button
- Hover shows expected source comparison: "BT swarm: 23 peers / HTTP: kiwix.org"

---

## Pre-work — Task 0 (~30 min)

Decision-gating before writing code:

1. **Are `.torrent` companions next to every Kiwix `.zim`?**
   ```bash
   for u in $(curl -s "https://library.kiwix.org/catalog/v2/entries?count=10" | grep -oE 'https://download.kiwix.org/zim/[^"]+\.zim'); do
     echo "=== $u ==="
     curl -sI "${u}.torrent" | head -1
   done
   ```
   - **All 200**: trusted-path is easy
   - **Mixed**: gracefully fall back to magnet derived from .meta4 checksums
   - **None**: bigger lift — generate `.torrent` server-side from local file

2. **Is `aria2c` on Synology DSM 7?** Try `ssh nas which aria2c`. If no, package as static binary in the Docker image (~5 MB).

3. **Cloudflare Tunnel constraint**: confirm CF Tunnel proxies HTTP only. WAN BT seeding requires direct port forward (not CF). Document the constraint; don't fight it.

Findings go in `docs/plans/p2p-feasibility.md` so Task 1 has solid ground.

---

## Tasks

### Task 1 — aria2c sidecar lifecycle (`zimi/p2p.py`, ~250 lines)

Subprocess management: spawn `aria2c --enable-rpc --rpc-listen-all=false --rpc-listen-port=6800 --bt-tracker= --dir=$ZIM_DIR --rpc-secret=$RANDOM --save-session=$ZIMI_DATA_DIR/bt/session --input-file=$ZIMI_DATA_DIR/bt/session`. Health-check via `aria2.getVersion`. Restart on death. Stop on Zimi shutdown.

JSON-RPC client wrapper with retries. Tests mock subprocess.

### Task 2 — Replace `_download_thread` with the BT-first path

`_start_download` flow becomes:

1. Resolve `.torrent` URL or info-hash from catalog item
2. Add to aria2 (`addTorrent` or `addUri`)
3. Poll `tellStatus` every 2s, emit progress to existing UI
4. **At t=60s**, if `numPeers == 0` and `completedLength < 1% * totalLength`: kill, fall back to HTTP path
5. **At completion**: verify hash matches expected (Kiwix metadata). On mismatch: quarantine + HTTP fallback
6. **After success**: feed file into seeding mode (Task 6 hands this off)

Existing W2.1 queue, W2.1 pause/resume, W3.1 multi-select, W2.2 batch — all reuse via the new `_download_thread` body.

### Task 3 — mDNS LAN discovery (`zimi/p2p_discovery.py`, ~150 lines)

Advertise `_zimi._tcp.local` with TXT records: `version=`, `zim_count=`, `port=`, `bt_port=`. Browse for peers on a 30s cycle. Cache. Expose at `/manage/peers`.

### Task 4 — Catalog UI peer rows

Cross-reference catalog items against discovered peers' published ZIM lists (each peer's `/list` endpoint). Items where a peer has it get a green `📡 LAN peer @home-nas` pill that, when clicked, fetches via that peer's address (BT preferred since both are running aria2).

### Task 5 — Info-hash storage on installed ZIMs

Compute SHA1 of bencoded info dict on download success. Store in metadata cache alongside `name`, `size`, etc. Lets peers answer "do you have this exact ZIM?" deterministically.

`/manage/peers` extends to `/manage/peers/{name}/has?info_hash=...` for verification.

### Task 6 — Seeding manager

Loops every installed ZIM that has a `.torrent` cached:
- Add to aria2 in seeding mode (`pause=false`, `seed-ratio=2.0`, `seed-time=0`)
- Track ratio progress in metadata cache
- Auto-pause on 2x ratio cap
- Auto-pause on disk-pressure threshold
- Per-ZIM `paused_seed=true` flag respected

New `/manage/seeding` endpoints: list, toggle per-ZIM, set global cap.

### Task 7 — Become-a-mirror (W3.6)

Mirror = Seeding + advertise catalog publicly. Once Task 6 works:
- New `?mirror=1` query param on `/catalog` (gates with rate-limit)
- HTTP basic auth optional
- Bandwidth cap: aria2's `--max-overall-upload-limit`
- Connection cap: aria2's `--max-overall-connection`

Ship as opt-in `ZIMI_MIRROR=1`.

---

## Verification

- **Two-machine LAN test**: install Zimi on a second host (RPi or another laptop). Both advertise. ZIM downloaded on host A appears as available from host A on host B's catalog. Pull from peer at LAN speed (≥ HTTP).
- **Hash-mismatch test**: serve a wrong file via mock peer; verify quarantine + HTTP fallback fires.
- **Seed-cap test**: download a small ZIM, seed until 2× ratio, verify auto-pause.
- **Cross-restart durability**: kill aria2 mid-download; verify session resume.
- **Full integration**: pytest covers the JSON-RPC wrapper, info-hash math, peer-list parsing.

---

## Out of scope (explicit)

- **Public DHT** — opt-in via `ZIMI_DHT=1`. Privacy + legal complications; LAN mode covers the main use case.
- **Cross-subnet mesh** — would need a tracker. Separate project.
- **WebTorrent** — fragments swarm vs native BT. Skip.
- **P2P search across peers** — fundamentally different protocol. Skip.
- **Forced seeding** — always opt-in / opt-out, never required. Even mirror mode is `ZIMI_MIRROR=1`.

---

## Risks worth naming

1. **aria2 binary on DSM 7**: may need a Docker image change. Verified in Task 0.
2. **Cloudflare Tunnel**: WAN BT seeding requires direct port forward. CF Tunnel is HTTP only. **Document, don't fight.**
3. **NAT / port-forwarding for BT**: many home users behind CGNAT have no inbound BT. uPnP attempt + LAN-only fallback. Don't promise seeding works on every network.
4. **Trust gap on peer-advertised hashes**: solved by always verifying against Kiwix catalog metadata first. Never trust a peer hash blindly.
5. **Disk-write amplification when seeding**: aria2's piece reads add I/O. Probably fine at 1-10 peers; at 100+, monitor SSD wear. Bandwidth cap implicitly throttles I/O too.
6. **Seeding wrong content** — if a `.torrent` was added that doesn't match what we promised the catalog, we'd be advertising bad data. Verification at completion catches this; we never seed unverified files.

---

## Effort estimate

5 working sessions:
1. Task 0 (feasibility) + Task 1 (sidecar lifecycle)
2. Task 2 (BT-first download path) + hash-verify
3. Task 3 + 4 (mDNS + catalog peer pills)
4. Task 5 + 6 (info-hash + seeding manager + 2× cap)
5. Task 7 + 2-machine LAN test + docs

Could compress to 3 sessions if Task 0 confirms easy path on `.torrent` companions; expand to 6-7 if we have to generate torrents server-side.
