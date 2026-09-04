# Zimi

[![CI](https://github.com/epheterson/Zimi/actions/workflows/ci.yml/badge.svg)](https://github.com/epheterson/Zimi/actions/workflows/ci.yml)
[![Tests](https://img.shields.io/badge/tests-2643-brightgreen)](#)
[![Lighthouse Accessibility](https://img.shields.io/badge/Lighthouse%20a11y-100%2F100-success?logo=lighthouse&logoColor=white)](docs/plans/2026-04-26-accessibility.md)
[![WCAG 2.1 AA](https://img.shields.io/badge/WCAG%202.1-AA-blue)](docs/plans/2026-04-26-accessibility.md)
[![i18n](https://img.shields.io/badge/i18n-10%20languages-blueviolet)](#languages)
[![Docker Pulls](https://img.shields.io/docker/pulls/epheterson/zimi)](https://hub.docker.com/r/epheterson/zimi)
[![PyPI](https://img.shields.io/pypi/v/zimi)](https://pypi.org/project/zimi/)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A modern experience for your ZIM files.

[Kiwix](https://kiwix.org) packages the world's knowledge into ZIM files. Zimi makes them feel like the real internet with a rich web UI, fast JSON API, and an MCP server for AI agents. Everything works offline, in your language.

## What is Zimi?

- **The offline internet.** Entire websites, cross-ZIM linking, search engine and native browser experience.
- **Make your own (beta).** A web page, a whole site, a video playlist, your bookmarks, or a folder on the server becomes a ZIM in your library. Three engines, from a plain fetch to a recorded browser session that keeps a site's JavaScript working offline; the page picks one for you.
- **Search that hits everything.** One query, every source, 100M+ articles, the right answer on top. Fast.
- **Multilingual.** Switch any article into any language it has. Ten UI languages built in.
- **A real library.** 1,000+ archives one click away, auto-updates, collections, batch downloads, bookmarks and history.
- **Yours or everyone's.** Serve the whole library openly, limit anonymous visitors to a chosen set of ZIMs, or require sign-in — with named accounts and per-ZIM access lists on top.
- **Your own network.** Your machines find each other and pass ZIMs around at LAN speed, no internet needed.
- **A good citizen.** Downloads arrive over BitTorrent and seed back to the Kiwix network. One switch makes you a full mirror.
- **Fresh daily.** Picture of the Day, On This Day, a word, a quote, a comic, a live almanac sky. All computed locally, forever.
- **Accessible.** If you browse by keyboard, listen by screen reader, or need high contrast, accessibility is built-in.
- **Anywhere.** Docker, pip, a native macOS app, or your phone as a PWA.
- **Improving.** Regular updates with ideas from the community, GitHub and creator keep Zimi fresh. Just ask!
- **For humans and machines.** Web UI, JSON API, MCP server for AI agents.

## Screenshots

| Homepage | Search Results |
|----------|---------------|
| ![Homepage](screenshots/homepage.png) | ![Search](screenshots/search.png) |

| Language Switching | Catalog |
|-------------------|---------|
| ![Languages](screenshots/language-dropdown.png) | ![Catalog](screenshots/browse-library.png) |

| Sharing |
|---------|
| ![Sharing](screenshots/sharing.png) |

## Languages

Not an afterthought. Language is deeply integrated into every aspect of Zimi so you can focus on your content and feel at home. Enjoy filtered lists, labeled sources, RTL support and no rock left unturned.
- **10 languages.** English, French, German, Spanish, Portuguese, Russian, Chinese, Arabic, Hindi, Hebrew.

Something not right? [Open an issue.](https://github.com/epheterson/Zimi/issues) Found a security problem? See [SECURITY.md](SECURITY.md) — report it privately.

## Sharing

Three switches in Server Settings control all of it:

- **BitTorrent** (on by default). Downloads arrive via the Kiwix swarm and seed back, capped at a ratio you choose. `0` means never seed. The engine is in-process libtorrent: the desktop apps and Docker image bundle it, and `pip install zimi` pulls it automatically wherever a prebuilt wheel exists (CPython 3.9–3.13 on Linux, macOS, and Windows). If there's no wheel for your interpreter — Python 3.14+ has none yet — Zimi quietly falls back to plain HTTP and prints the one-line fix; `pip install zimi[bt]` forces the attempt. UPnP asks your router to open the port, and the settings panel shows whether it worked. Concurrent downloads and the peer-connection limit are tunable in the same panel.
- **Nearby** (off by default). Flip it on and Zimi devices on your network find each other; a green pill on a catalog card means a neighbor already has that ZIM. Transfers stay on your LAN, never the internet.
- **Mirror** (off). Lifts the seeding cap, for people who want to run a long-term Kiwix mirror.

Seeding needs no router setup: Zimi opens the BitTorrent port automatically (UPnP) and the settings show whether peers can reach you, with a retry when they can't. DHT is on too, so magnet links and trackerless swarms just work.

## Make your own ZIMs

The library isn't only what you download. Zimi packages new ZIMs from the **+** button in the web app or `zimi create` on the command line. Every mode previews what you'll get before anything runs, streams a live log while it works, and the result joins your library the moment it finishes.

- **A folder** — HTML, Markdown (rendered by a built-in converter), and PDFs become a browsable ZIM, cross-file links intact. Command line only (`zimi create ./folder`) — the web app deliberately doesn't read the server's filesystem.
- **A web page** — one URL, or a list of up to twenty, captured with its images, styles, and fonts.
- **A whole site** — a bounded, polite, same-origin crawl: page, depth, and byte budgets, robots.txt honored, and Ctrl-C still writes a valid ZIM of everything captured so far.
- **Videos** — a playlist or channel becomes an offline video ZIM with subtitles, powered by yt-dlp.
- **A web archive** — `zimi import` converts WARC and WACZ files from ArchiveBox, Webrecorder, browsertrix, or HTTrack. Powered by a managed warc2zim sidecar (needs Python 3.14 and libmagic on the machine — the Docker image ships both).

Three capture engines trade speed for fidelity: **Fast** (no browser required), **Rendered** (a real headless Chromium draws pages that build themselves in JavaScript), and **Alive** (records the browser session so the page's own JavaScript still runs offline — menus, galleries, videos). Rendered and Alive can block ads and trackers at capture time from a published blocklist.

Every created ZIM carries honest provenance — which Zimi, which tools, how many pages and bytes, what was blocked — as openZIM-spec metadata validated with zimcheck. Right-click any library card → **About this ZIM** to see it.

## Install

### macOS

```bash
brew tap epheterson/zimi && brew install --cask zimi
```

Or download from [GitHub Releases](https://github.com/epheterson/Zimi/releases).

### Linux

```bash
sudo snap install zimi
```

Or grab the [AppImage](https://github.com/epheterson/Zimi/releases).

### Docker

```bash
docker run --network host -v ./zims:/zims -v ./zimi-config:/config epheterson/zimi
```

`/zims` is where ZIM files live. `/config` persists cache, indexes, and settings. Open http://localhost:8899.

`--network host` is recommended so LAN peer discovery (mDNS) and BitTorrent seeding work out of the box. If you can't use host networking, see "Bridge mode" below.

<details>
<summary>Docker Compose (recommended — host networking)</summary>

```yaml
services:
  zimi:
    image: epheterson/zimi
    container_name: zimi
    restart: unless-stopped
    network_mode: host           # mDNS + BT seeding work without port plumbing
    volumes:
      - ./zims:/zims             # ZIM files go here
      - ./zimi-config:/config    # cache, indexes, settings
```
</details>

<details>
<summary>Docker Compose (bridge mode — no LAN discovery)</summary>

```yaml
services:
  zimi:
    image: epheterson/zimi
    container_name: zimi
    restart: unless-stopped
    ports:
      - "8899:8899"
      - "6881:6881/tcp"          # BitTorrent (TCP)
      - "6881:6881/udp"          # BitTorrent (UDP / DHT)
    volumes:
      - ./zims:/zims
      - ./zimi-config:/config
```

LAN peer discovery (`_zimi._tcp`) won't reach the LAN in bridge mode — multicast doesn't cross the docker bridge, and Zimi warns in the Nearby settings when it detects this. Use host networking, or set `ip=<your host's LAN address>` in `ZIMI_NEARBY`. BT seeding still works because libtorrent binds the mapped port. See [docs/deployment-networking.md](docs/deployment-networking.md) for the full discussion.
</details>

### Python

```bash
pip install zimi
ZIM_DIR=./zims zimi serve --port 8899
```

### Environment Variables

Most people set nothing: every setting below has a sensible default or lives in the UI.

| Variable | Default | Description |
|----------|---------|-------------|
| `ZIM_DIR` | `/zims` | Path to ZIM files (scanned for `*.zim` on startup) |
| `ZIMI_DATA_DIR` | `/config` (Docker) or `$ZIM_DIR/.zimi` | Cache, indexes, and settings. Mount separately in Docker. |
| `ZIMI_MANAGE_PASSWORD` | _(none)_ | Protect library management |
| `ZIMI_PUBLIC_ACCESS` | `open` | What an anonymous visitor sees: `open` (whole library), `limited` (an admin-chosen allowlist), or `private` (sign-in required). Also a UI setting; the env var wins when set. |
| `ZIMI_BT` | `on` | BitTorrent: `off`, or `on,port=6881,ratio=2,up=2048,seed=on,mirror=off,upnp=on,dht=on,active=4,conns=200`. `seed`, `upnp`, and `dht` default on. `active` caps concurrent downloads (the rest queue; governs HTTP too — legacy `ZIMI_MAX_CONCURRENT_DOWNLOADS` still works), `conns` is the global peer-connection limit. Fields you set are locked in the UI; fields you leave out stay UI-controlled. `ratio=0` means never seed. |
| `ZIMI_NEARBY` | `off` | LAN sharing: `off`, or `on,name=my-zimi,public=off,ip=192.168.1.20`. Controls serving *and* fetching between your Zimi devices. Set `ip=` to your host's LAN address when running Docker in bridge mode. |

<details>
<summary>Advanced</summary>

| Variable | Default | Description |
|----------|---------|-------------|
| `ZIMI_MANAGE` | `1` | Library manager. `0` to disable entirely. |
| `ZIMI_AUTO_UPDATE` | `0` | Auto-update ZIMs (`1` to enable; also a UI setting) |
| `ZIMI_UPDATE_FREQ` | `weekly` | `daily`, `weekly`, or `monthly` |
| `ZIMI_RATE_LIMIT` | `60` | Requests/min/IP for anonymous clients. `0` to disable. |
| `ZIMI_RATE_LIMIT_TRUSTED` | `600` | Budget for logged-in clients (and private-network clients on passwordless instances). |
| `ZIMI_API_TOKEN` | _(none)_ | Pin the API token instead of generating in the UI |
| `ZIMI_HOT_ZIMS` | _(none)_ | Comma-separated ZIM names to pre-warm at startup |
| `ZIMI_OFFLINE` | `0` | `1` guarantees zero outbound traffic: no update checks, no catalog fetches, no torrent stack. For air-gapped machines. |
| `ZIMI_CREATE_ROOT` | _(none)_ | The one directory tree the web UI may package a server path from (the import mode's server-path field). Unset, server-path packaging from the web stays off entirely. The CLI is unaffected. |
| `ZIMI_UPDATE_CHANNEL` | `latest` | App release channel: `latest` (finished releases) or `beta` (prereleases too). Locks the UI choice when set. |
| `ZIMI_UPDATE_DELAY_DAYS` | `0` | Hold a release back until it has been public this many days (0–365). |

</details>

## Self-hosting & operations

Zimi runs seriously with zero ceremony: `zimi serve` in or beside a folder of ZIMs discovers it and keeps its state in a `.zimi` folder next to the content — a USB stick is a valid deployment. When you want more control:

- **One config file.** `zimi.json` holds paths, auth, sharing, and serving settings; `zimi config` prints every effective value and exactly where it came from — flag, environment, file, discovery, or default.
- **Backup and restore.** `zimi backup` writes settings, bookmarks, collections, and user data to one file; `zimi restore` brings a fresh install back from it.
- **Provable offline.** `ZIMI_OFFLINE=1` is a real air-gap switch, verified by a test that records every outbound socket.
- **Monitoring.** `GET /health` for liveness, `GET /metrics` in Prometheus exposition format for the rest.
- **Reference manifests.** `deploy/` carries docker-compose and Kubernetes examples, and `scripts/make-airgap-bundle.sh` builds a wheels-only installer for machines that will never see the internet.
- **Update awareness.** Manage shows the current version and checks for releases on demand — Latest or Beta channel, with an optional hold-back delay.

- **Secure first-run.** Until an admin password is set, the machine running Zimi can set one directly; any other device needs a one-time setup key Zimi prints to its log on first start. So a LAN, container, or tailnet neighbor can never claim the admin account before you do. Set `ZIMI_MANAGE_PASSWORD` to skip the bootstrap entirely.

Single sign-on through Cloudflare Access is available for tunnel deployments (experimental) — see [docs/deployment-networking.md](docs/deployment-networking.md).

## Documentation

Each guide is structured as How it works / Configure / Troubleshoot. Start at the [feature guide index](docs/features/README.md).

- [Reading](docs/features/reading.md) — search and ranking, the reader and Reader View, bookmarks and history, word lookup, cross-language articles, PDFs, offline/PWA, accessibility, the almanac.
- [Making ZIMs](docs/features/making-zims.md) — `zimi create` for a folder, page, `--site` crawl or video; the four engines and what each trades; bookmarks as a standalone ZIM; `zimi import` for WARC/WACZ.
- [Getting & sharing](docs/features/getting-and-sharing.md) — catalog and downloads, folders as categories, same-flavor auto-update, BitTorrent seeding, Nearby (mDNS LAN), the `/dl/` peer transport.
- [Access](docs/features/access.md) — public-access modes, named accounts, per-ZIM allowlists, the creator role, the first-run bootstrap, Cloudflare Access SSO.
- [Operations](docs/features/operations.md) — `zimi config` + config file, backup/restore, air-gap, `/metrics`, `/health`, update channels, deploy manifests.
- [API & MCP](docs/features/api-and-mcp.md) — the MCP server and tools, the stable JSON API, `/openapi.json`, `/chunks`.

## API

| Endpoint | Description |
|----------|-------------|
| `GET /search?q=...&limit=5&zim=...&fast=1&lang=...` | Full-text search. `fast=1` for title matches only. `lang` filters by language. |
| `GET /read?zim=...&path=...&max_length=8000` | Read article as plain text |
| `GET /chunks?zim=...&path=...&size=1200&overlap=120` | Deterministic, embedding-free article chunking for RAG clients |
| `GET /suggest?q=...&limit=10&zim=...` | Title autocomplete |
| `GET /list` | List all sources with metadata |
| `GET /article-languages?zim=...&path=...` | All languages an article is available in |
| `GET /catalog?zim=...` | PDF catalog for zimgit ZIMs |
| `GET /snippet?zim=...&path=...` | Short text snippet |
| `GET /random?zim=...` | Random article |
| `GET /collections` | List collections |
| `POST /collections` | Create/update a collection |
| `DELETE /collections?name=...` | Delete a collection |
| `GET /resolve?url=...` | Resolve external URL to ZIM path |
| `POST /resolve` | Batch resolve: `{"urls": [...]}` |
| `GET /health` | Health check with version |
| `GET /w/<zim>/<path>` | Serve raw ZIM content |
| `GET /openapi.json` | OpenAPI 3.1 description of the stable read API |

### Examples

```bash
# Search across all sources
curl "http://localhost:8899/search?q=python+asyncio&limit=5"

# Search in French only
curl "http://localhost:8899/search?q=eau&lang=fr&limit=5"

# Find all languages for an article
curl "http://localhost:8899/article-languages?zim=wikipedia&path=A/Water"

# Read an article
curl "http://localhost:8899/read?zim=wikipedia&path=A/Water_purification"
```

## MCP Server

Zimi includes an MCP server for AI agents.

```json
{
  "mcpServers": {
    "zimi": {
      "command": "python3",
      "args": ["-m", "zimi.mcp_server"],
      "env": { "ZIM_DIR": "/path/to/zims" }
    }
  }
}
```

For Docker on a remote host:

```json
{
  "mcpServers": {
    "zimi": {
      "command": "ssh",
      "args": ["your-server", "docker", "exec", "-i", "zimi", "python3", "-m", "zimi.mcp_server"]
    }
  }
}
```

Tools: `search` (with `lang` filter), `read`, `get_chunks`, `suggest`, `list_sources`, `random`, `article_languages`, `read_with_links`, `deep_search`, `list_collections`, `manage_collection`, `manage_favorites`

## Integrations

- **[SearXNG](docs/integrations/searxng.md)** — route queries through Zimi from a self-hosted SearXNG metasearch instance.
- **[OpenWebUI / generic AI](docs/integrations/openwebui.md)** — wire the MCP server into any AI client for offline research.

## Long-requested, shipped here

Every issue filed against Zimi has been answered — #33 country holiday colors, #34 new-ZIM badges and recency filters, #36 Tailscale-friendly management, #37 library organization, #38 fragment links, #44–46 access modes and per-user data, #48–51 almanac, anchor, flavor, and Raspberry Pi fixes, #65 in-article bookmarks, #76 update awareness. And features the wider ZIM ecosystem has been asking for, available today:

- **Spelling suggestions** — "did you mean?" on weak searches, fully offline ([libzim #731](https://github.com/openzim/libzim/issues/731))
- **Read-aloud** — text-to-speech in the reader via the offline Web Speech API ([kiwix-js #166](https://github.com/kiwix/kiwix-js/issues/166))
- **Reader View** — a clean, adjustable reading mode (themes, fonts, text size) for any article
- **Word lookup** — tap a word in any article, get the dictionary entry from your own library
- **Resumable downloads** — an interrupted ZIM download picks up where it left off, and updates reuse the unchanged pieces of the old file instead of re-downloading everything
- **User accounts** — named logins with per-ZIM access lists, so one server can serve the whole house (or classroom)
- **A native Windows app** — with the same auto-update channel as macOS
- **Give back** — seed your downloads to the Kiwix swarm at a ratio you choose, or flip one switch and be a full mirror
- **Grab the file** — a download button for any ZIM you're sharing on your network
- **Real article counts** — articles, not raw entry counts, on library cards

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE). Desktop and Docker builds bundle [libtorrent-rasterbar](https://libtorrent.org/) (BSD-3-Clause) for BitTorrent transfers — see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

---

Built with ❤️ in California by [@epheterson](https://github.com/epheterson) and [Claude Code](https://claude.ai/code).
