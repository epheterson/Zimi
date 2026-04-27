# Networking & Deployment Modes

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
fails. BT seeding still works — aria2 uses 6881 directly.

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
