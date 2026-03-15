# Zimi

Offline knowledge server for ZIM files. Search and read Wikipedia, Stack Overflow, dev docs, and 50+ other sources — no internet required.

Kiwix packages the world's knowledge into ZIM files. Zimi serves them with a fast JSON API, a modern web UI, and an MCP server for AI agents.

## What's in the box

- **10 languages** — full UI in English, French, German, Spanish, Portuguese, Russian, Chinese, Arabic, Hindi, and Hebrew. RTL layout for Arabic and Hebrew.
- **Cross-language navigation** — reading about water in English Wikipedia? Open the language dropdown and switch to French — Zimi finds the same article via Wikidata Q-IDs. Don't have French Wikipedia? Download it right from the dropdown, and Zimi auto-navigates when it's done.
- **Cross-source search** — title matches first, then full-text across all sources in parallel. Ranked by relevance, with thumbnails and snippets.
- **Discover** — daily cards from your installed sources. Picture of the Day, On This Day, Quote of the Day, random articles. Rotates daily.
- **Bookmarks & history** — save articles, search your history, pick up where you left off.
- **Catalog browser** — 1,000+ Kiwix archives across 10+ categories. One-click install with flavor picker.
- **Library management** — auto-updates on a schedule, password protection, download queue with progress.
- **Collections** — group sources for scoped search and homepage sections.
- **JSON API** — every feature accessible programmatically.
- **MCP server** — plug into Claude Code or other AI agents as a knowledge tool.
- **Desktop app** — native macOS window with system tray.

## Screenshots

| Homepage | Search Results |
|----------|---------------|
| ![Homepage](screenshots/homepage.png) | ![Search](screenshots/search.png) |

| Article Reader | Catalog |
|----------------|---------|
| ![Reader](screenshots/reader.png) | ![Catalog](screenshots/browse-library.png) |

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
docker run -v ./zims:/zims -p 8899:8899 epheterson/zimi
```

Open http://localhost:8899. No ZIM files yet? Browse and download from the built-in catalog.

### Python

```bash
pip install zimi
zimi serve --port 8899
```

## API

| Endpoint | Description |
|----------|-------------|
| `GET /search?q=...&limit=5&zim=...&fast=1` | Full-text search. `fast=1` for title matches only. |
| `GET /read?zim=...&path=...&max_length=8000` | Read article as plain text |
| `GET /suggest?q=...&limit=10&zim=...` | Title autocomplete |
| `GET /list` | List all sources with metadata |
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

# Read an article
curl "http://localhost:8899/read?zim=wikipedia&path=A/Water_purification"

# Title autocomplete
curl "http://localhost:8899/suggest?q=pytho&limit=5"
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

Tools: `search`, `read`, `suggest`, `list_sources`, `random`

## Docker Compose

```yaml
services:
  zimi:
    image: epheterson/zimi
    container_name: zimi
    restart: unless-stopped
    ports:
      - "8899:8899"
    volumes:
      - ./zims:/zims
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ZIM_DIR` | `/zims` | Path to ZIM files |
| `ZIMI_MANAGE` | `1` | Library manager. `0` to disable. |
| `ZIMI_MANAGE_PASSWORD` | _(none)_ | Protect library management |
| `ZIMI_AUTO_UPDATE` | `0` | Auto-update ZIMs (`1` to enable) |
| `ZIMI_UPDATE_FREQ` | `weekly` | `daily`, `weekly`, or `monthly` |
| `ZIMI_RATE_LIMIT` | `60` | Requests/min/IP. `0` to disable. |

## Zimi vs kiwix-serve

[kiwix-serve](https://github.com/kiwix/kiwix-tools) is the official Kiwix server. Both serve ZIM files — here's how they differ:

| | Zimi | kiwix-serve |
|---|---|---|
| **Search** | JSON API, 4–6x faster parallel search, cross-source ranking | HTML responses, sequential |
| **Library** | Built-in catalog browser, downloads, auto-updates | Separate CLI tool |
| **Languages** | 10-language UI, cross-language article navigation | English only |
| **AI** | MCP server for Claude Code | None |
| **Desktop** | Native macOS app | kiwix-desktop (separate) |
| **Runtime** | Python (~4,500 lines) | C++ (libkiwix) |
| **Memory** | Higher (Python + indexes) | Lower (native C++) |

Use kiwix-serve for lightweight serving on low-memory devices. Use Zimi for APIs, multi-language, library management, AI integration, or a desktop app.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
