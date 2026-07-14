# Zimi

[![CI](https://github.com/epheterson/Zimi/actions/workflows/ci.yml/badge.svg)](https://github.com/epheterson/Zimi/actions/workflows/ci.yml)
[![Tests](https://img.shields.io/badge/tests-535%20passing-brightgreen)](#)
[![Lighthouse Accessibility](https://img.shields.io/badge/Lighthouse%20a11y-100%2F100-success?logo=lighthouse&logoColor=white)](docs/plans/2026-04-26-accessibility.md)
[![WCAG 2.1 AA](https://img.shields.io/badge/WCAG%202.1-AA-blue)](docs/plans/2026-04-26-accessibility.md)
[![i18n](https://img.shields.io/badge/i18n-10%20languages-blueviolet)](#languages)
[![Docker Pulls](https://img.shields.io/docker/pulls/epheterson/zimi)](https://hub.docker.com/r/epheterson/zimi)
[![PyPI](https://img.shields.io/pypi/v/zimi)](https://pypi.org/project/zimi/)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A modern experience for your ZIM files.

[Kiwix](https://kiwix.org) packages the world's knowledge into ZIM files. Zimi makes them feel like the real internet with a rich web UI, fast JSON API, and an MCP server for AI agents. Everything works offline, in your language.

## What's in the box

- **Cross-source search.** Parallel full-text search across all sources with snippets and thumbnails.
- **Cross-language navigation.** Switch articles between languages and download missing ones.
- **Discover.** Fresh cards daily: Picture of the Day, On This Day, Quote, Word, Book, Destination, Talk, Comic, Country.
- **Bookmarks and history.** Feel like you're in a real browser, save your place.
- **Kiwix Catalog.** Download 1,000+ Kiwix archives across 10 categories with instant language filtering.
- **Library management.** Auto-updates, password protection, download queue.
- **Collections and Favorites.** Group sources for easier access and scoped search.
- **JSON API.** Every feature accessible programmatically with token auth.
- **Desktop and mobile.** Native macOS and Python apps. Deploy anywhere.

## Screenshots

| Homepage | Search Results |
|----------|---------------|
| ![Homepage](screenshots/homepage.png) | ![Search](screenshots/search.png) |

| Language Switching | Catalog |
|-------------------|---------|
| ![Languages](screenshots/language-dropdown.png) | ![Catalog](screenshots/browse-library.png) |

| Article Reader | Sharing |
|----------------|---------|
| ![Reader](screenshots/reader.png) | ![Sharing](screenshots/sharing.png) |

## Languages

Not an afterthought. Language is deeply integrated into every aspect of Zimi so you can focus on your content and feel at home. Enjoy filtered lists, labeled sources, RTL support and no rock left unturned.
- **10 languages.** English, French, German, Spanish, Portuguese, Russian, Chinese, Arabic, Hindi, Hebrew.

Something not right? [Open an issue.](https://github.com/epheterson/Zimi/issues)

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

LAN peer discovery (`_zimi._tcp`) won't reach the LAN in bridge mode — multicast doesn't cross the docker bridge. BT seeding still works because aria2 binds the mapped port. See [docs/deployment-networking.md](docs/deployment-networking.md) for the full discussion.
</details>

### Python

```bash
pip install zimi
ZIM_DIR=./zims zimi serve --port 8899
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ZIM_DIR` | `/zims` | Path to ZIM files (scanned for `*.zim` on startup) |
| `ZIMI_DATA_DIR` | `/config` (Docker) or `$ZIM_DIR/.zimi` | Cache, indexes, and settings. Mount separately in Docker. |
| `ZIMI_MANAGE` | `1` | Library manager. `0` to disable. |
| `ZIMI_MANAGE_PASSWORD` | _(none)_ | Protect library management |
| `ZIMI_AUTO_UPDATE` | `0` | Auto-update ZIMs (`1` to enable) |
| `ZIMI_UPDATE_FREQ` | `weekly` | `daily`, `weekly`, or `monthly` |
| `ZIMI_RATE_LIMIT` | `60` | Requests/min/IP. `0` to disable. |
| `ZIMI_TORRENT` | `1` | BT-first downloads + seeding via the aria2 sidecar (falls back to HTTP when aria2 is missing). `0` to opt out. |
| `ZIMI_BT_PORT` | `6881` | BitTorrent listen port (TCP+UDP). |
| `ZIMI_SEED` | `1` | Seed completed ZIMs back to the swarm. `0` disables seeding. |
| `ZIMI_PEER_SHARE` | `1` | Serve your `.zim` files to LAN peers at `/dl/<name>` (private IPs only). `0` disables. |
| `ZIMI_PEER_SHARE_PUBLIC` | `0` | Also serve `/dl/` to public-internet clients. Leave off unless you mean it. |
| `ZIMI_SEED_RATIO` | `2.0` | Stop seeding once ratio (uploaded ÷ downloaded) reaches this. |
| `ZIMI_PEER_DISCOVERY` | `1` | Advertise + browse `_zimi._tcp.local` over mDNS. `0` disables. |
| `ZIMI_PEER_NAME` | _(hostname)_ | Friendly name advertised to LAN peers. Defaults to `zimi-<hostname>`. |
| `ZIMI_MIRROR` | `0` | Enable public-mirror mode: uncapped ratio + raised upload bandwidth. `1` to enable. |
| `ZIMI_MIRROR_RATIO` | `1000` | Mirror-mode ratio cap (effectively uncapped). |
| `ZIMI_MIRROR_UPLOAD_KB` | `10240` | Mirror-mode upload bandwidth in KB/s. |

## API

| Endpoint | Description |
|----------|-------------|
| `GET /search?q=...&limit=5&zim=...&fast=1&lang=...` | Full-text search. `fast=1` for title matches only. `lang` filters by language. |
| `GET /read?zim=...&path=...&max_length=8000` | Read article as plain text |
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

Tools: `search` (with `lang` filter), `read`, `suggest`, `list_sources`, `random`, `article_languages`, `read_with_links`, `deep_search`, `list_collections`, `manage_collection`, `manage_favorites`

## Integrations

- **[SearXNG](docs/integrations/searxng.md)** — route queries through Zimi from a self-hosted SearXNG metasearch instance.
- **[OpenWebUI / generic AI](docs/integrations/openwebui.md)** — wire the MCP server into any AI client for offline research.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)

---

Built with ❤️ in California by [@epheterson](https://github.com/epheterson) and [Claude Code](https://claude.ai/code).
