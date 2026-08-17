# Sharing

Two independent ways to move ZIMs between machines: BitTorrent (an accelerator for internet/Kiwix-swarm downloads) and Nearby (direct LAN peer-to-peer over HTTP). They are not the same transport — don't conflate them.

## How it works

**Transport model.** HTTP is the universal transport. LAN/offline peer→peer sharing is **direct HTTP range**: a peer serves its raw `.zim` at `/dl/<name>` (private-IP gated) and the puller reuses the normal download machinery. BitTorrent is an **optional accelerator for internet downloads only** — soft-imported libtorrent, bundled in Docker and the desktop builds, absent = HTTP-only. Never route LAN sharing through BitTorrent; pulling one LAN seeder over a swarm buys nothing.

**BitTorrent seeding.** When enabled, Zimi runs an in-process libtorrent backend (default port 6881 TCP+UDP) that both accelerates catalog downloads and can seed the ZIMs you host back to the Kiwix swarm. Seeding is on by default when BT is enabled; a seed ratio, up/down rate caps, active-torrent and connection limits, DHT, and UPnP port mapping are all tunable. `mirror` mode makes the node an indefinite mirror.

**Nearby (mDNS LAN discovery).** Zimi advertises itself on `_zimi._tcp.local` (multicast UDP 5353) and discovers other Zimi instances on the same LAN. Discovery is on by default and works on a fully air-gapped LAN — "offline" means no *internet*, not no *network*. Discovery feeds host:port + filename into an HTTP pull (`_start_peer_download`); it never uses BitTorrent. Actually *serving* your files to peers is a separate opt-in (`share`), and serving to public (non-private) clients is a further opt-in on top of that.

**Raw `.zim` download / `/dl/` endpoint.** The raw file is available at `/dl/<name>`, gated to private-tier clients (RFC1918/ULA, loopback, link-local, and — unless `ZIMI_TRUST_CGNAT=0` — CGNAT/overlay ranges like Tailscale/ZeroTier). A browser navigation to `/dl/` carries none of Zimi's auth headers, so on a passworded instance right-click → Download (and the Manage `⋯` menu's download) first calls `/manage/dl-ticket` to mint a **one-time ticket** the `/dl/` URL spends within 120 seconds. Admin-gated: minting a ticket requires the manage credential.

## Configure

The documented surface is two compact env blobs. Any field you set in a blob is env-locked in the UI; fields you leave out stay UI-controlled.

**`ZIMI_BT`** — e.g. `ZIMI_BT="on,port=6881,ratio=2,up=2048,mirror=off,active=4,conns=200"`

| Field | Meaning |
| --- | --- |
| bare `on`/`off` | Master BitTorrent switch |
| `port=` | Inbound BT port (default 6881) |
| `seed=` | Seed after download (default on when BT is on) |
| `ratio=` | Seed ratio target |
| `up=` / `down=` | Rate caps in KB/s |
| `active=` | Max active torrents |
| `conns=` | Max connections (shared across torrents) |
| `dht=` | DHT on/off |
| `upnp=` | UPnP port mapping on/off |
| `mirror=` | Indefinite-mirror mode |

**`ZIMI_NEARBY`** — e.g. `ZIMI_NEARBY="on,name=my-zimi,public=off"`

| Field | Meaning |
| --- | --- |
| bare `on`/`off` | Master Nearby switch |
| `name=` | Friendly name advertised on mDNS |
| `discovery=` | LAN discovery on/off (on by default) |
| `share=` | Serve your files to LAN peers |
| `public=` | Also serve to public (non-private) clients |
| `ip=` | Address peers are told to connect to |

Legacy per-feature vars (`ZIMI_TORRENT`, `ZIMI_SEED`, `ZIMI_SEED_RATIO`, `ZIMI_BT_PORT`, `ZIMI_BT_UP_KB`, `ZIMI_BT_DOWN_KB`, `ZIMI_DHT`, `ZIMI_MIRROR`, `ZIMI_PEER_DISCOVERY`, `ZIMI_PEER_SHARE`, `ZIMI_PEER_SHARE_PUBLIC`, `ZIMI_PEER_NAME`) still work as undocumented fallbacks. `ZIMI_TRUST_CGNAT=0` narrows the private-tier trust set (drops CGNAT/overlay). `ZIMI_OFFLINE=1` disables BitTorrent entirely but **leaves mDNS on** — LAN sharing is the point of offline.

## Troubleshoot

- **BitTorrent unavailable** — libtorrent is soft-imported. Absent (a plain `pip install`) means HTTP-only downloads; that's expected. Docker and the desktop builds bundle it.
- **Nearby peers don't appear** — mDNS multicast doesn't cross Docker bridge boundaries. Use `network_mode: host` (or macvlan). See [Networking & deployment modes](../deployment-networking.md).
- **A peer is discovered but the pull fails** — the advertised `ip=` may be wrong (a bridge address the puller can't reach). Set `ZIMI_NEARBY`'s `ip=` field to the reachable LAN address.
- **BT port unreachable from the WAN** — open/forward 6881 TCP+UDP, or rely on UPnP (`upnp=`). Behind CGNAT, inbound may never work; downloads still function.
- **Right-click Download saved a `.zim.html` file** — that was the pre-ticket failure mode on passworded instances; the one-time ticket flow fixes it. If it recurs, you're likely unauthenticated — log in to Manage first.
- **`/dl/` returns 403/404 from a remote client** — it's private-IP gated. Reach it from the LAN/overlay, or via an authorized client that mints a ticket.
- **A UI toggle is greyed out** — the corresponding `ZIMI_BT`/`ZIMI_NEARBY` field is set and env-locks it. Remove that field from the blob to return control to the UI.
