# P2P Feasibility Findings — 2026-04-27

Pre-work for the Reach P2P track. Verified before Task 1.

## .torrent companions on Kiwix

Spot-check of 5 random ZIMs across categories:

| Status | URL |
|---|---|
| 200 | `wikipedia/wikipedia_en_all_maxi_2026-02.zim.torrent` |
| 404 | `ted/ted_en_technology_2026-02.zim.torrent` |
| 200 | `other/openstreetmap-wiki_en_all_nopic_2026-04.zim.torrent` |
| 200 | `freecodecamp/freecodecamp_en_all_2026-02.zim.torrent` |
| 200 | `zimit/php.net_en_all_2024-08.zim.torrent` |

**4 of 5 (~80%) had a `.torrent` companion.** TED was the lone miss.

**Implication:** the BT-first → HTTP-fallback path in the plan is exactly right.
We try `.torrent`, on 404 we use HTTP. No need to generate torrents
server-side — Kiwix maintains them for us.

## .torrent shape (sample: FreeCodeCamp)

- Single-file torrent (one `.zim` per torrent)
- 1,039 bytes of metadata for an 8MB ZIM (good ratio)
- Tracker: `tracker.openzim.org`
- Announce-list with multiple trackers — resilient if primary down
- Standard bencode

That confirms our hash-verify-on-completion logic just compares the
returned info-hash against a hash we compute from the same `.torrent`
metadata Kiwix served us. No extra trust gymnastics needed.

## aria2c availability

| Host | aria2c installed? |
|---|---|
| Local (macOS) | ❌ no |
| NAS (Synology DSM) | ❌ no |

**Implication:** must ship as part of the Docker image. Adds ~5 MB.
Synology users running outside Docker would need their own install.
For the Mac desktop app, we'd bundle for that distribution path
separately (not blocking the Docker / Linux release).

## Cloudflare Tunnel reality check

Existing Zimi at `knowledge.zosia.io` is fronted by CF Tunnel.
CF only proxies HTTP/HTTPS. **Inbound BT connections (TCP/UDP on
port 6881) cannot reach Zimi through CF Tunnel.**

WAN seeding from a CF-fronted instance requires a direct port-forward.
LAN seeding works regardless. This is documented as a known
constraint, not a bug to fix.

## Decisions locked in

1. **Trusted source path = Kiwix `.torrent` URL.** Verify info-hash on
   completion; HTTP fallback on 404, mismatch, or stall.
2. **Bundled aria2c is the default backend.** Docker image gets a
   `RUN apt-get install -y aria2`.
3. **Port 6881 default**, env-overridable via `ZIMI_BT_PORT`. Surface
   reachability in `/manage/bt-status`.
4. **Staging dir**: `$ZIMI_STAGING_DIR` (default `$ZIMI_DATA_DIR/staging`).
5. **Trackers**: rely on the announce-list inside each `.torrent`.
   Don't hardcode; respect what Kiwix publishes.

## What this enables for Task 1+

- aria2 sidecar can use `aria2.addUri([torrent_url])` directly — no
  pre-fetch needed
- Hash-verify becomes a metadata-cache compare, not a re-download
- Seeding mode just adds `--seed-time=` and tracks ratio
- Single-file-per-torrent means we skip per-file priority UI entirely
