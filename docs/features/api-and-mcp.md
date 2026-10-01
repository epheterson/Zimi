# MCP & API

Two ways for machines to use a Zimi library: the MCP server (for AI agents) and the stable HTTP JSON API (for RAG clients and scripts).

## How it works

**MCP server.** `zimi mcp [ZIM_DIR]` runs a FastMCP server over **stdio** and nothing else: no web server, no port, no BitTorrent, mDNS, catalog or index builds. The ZIM directory is the argument, or `ZIM_DIR`, or the config file, or found the way `zimi serve` finds it. Point any MCP client at it (locally, or `ssh ... docker exec -i zimi python3 -m zimi mcp` for a remote Docker instance).

By default it serves three tools, about 360 tokens of schema, sized for small local models:

- `search`: one source, several (comma-separated) or all; a source can be named by part (`wikipedia`). Each hit is a title, its source, its path and a short snippet. Supports `"exact phrase"`, `-word`, `a OR b`. When a searched source's title index is still building, or a source has no full-text index (it matches titles only), the answer opens with one line naming them (`Incomplete: wikipedia_en: title index building 40%`); nothing when every index is ready. `wait` (seconds, up to 60) holds the answer until the building indexes finish, and says so if they did not.
- `read`: the page as Markdown with its headings, lists, pipe tables, the infobox as `key: value` lines and math as TeX; no navigation, footnote marks or images, references only with `references: true`. A page over about 10,000 characters comes back as its intro and a numbered outline with each section's size. A Stack Exchange question reads as the question with one section per answer, accepted first.
- `read_section`: one section by number, heading or anchor, with its subsections.

`--tools full` (or `ZIMI_MCP_TOOLS=full`) serves every tool instead, about 3,500 tokens: `search` (with collection and `language` filters), `read` (plain text), `get_chunks`, `suggest`, `list_sources`, `random`, `article_languages`, `read_with_links`, `deep_search`, `list_collections`, `manage_collection`, `manage_favorites`, and for the apps `list_videos`, `list_questions`, `read_question`, `list_posts`, `read_post`, and `index_status` (each source's title index: ready, building with its progress, stale or missing; and whether it has a full-text index) with `build_index` (starts the title index builds for sources missing one, in the background): the same readers ZimiTube, ZimiExchange and Reddot draw from, as text (a question's answers with the accepted one first, a post's replies indented under their parents). `python3 -m zimi.mcp_server` serves the full set unless told `--tools lean`, so a config written for it before keeps working; it warms search indexes in the background as it always has.

**HTTP JSON API.** The stable, integrate-against-it surface (contract in [API stability](../api-stability.md)):

| Endpoint | Purpose |
| --- | --- |
| `GET /search` | Full-text search across ZIM sources (cross-ZIM or scoped with `zim=`); `incomplete` lists searched sources whose title index is building or that have no full-text index |
| `GET /suggest` | Title autocomplete |
| `GET /read` | Article as stripped plain text |
| `GET /chunks` | Deterministic, embedding-free RAG chunking |
| `GET /w/{zim}/{path}` | Raw article bytes (original HTML/assets) |
| `GET /list` | Installed ZIM sources |
| `GET /random` | Random article |
| `GET /health` | Liveness + build info |
| `GET /tube` | Videos across every video ZIM, sources interleaved, one card per talk; `q=`, `limit=`, `offset=` |
| `GET /tube/play` | The media behind a video's page: sources, subtitles, poster, the ZIM's own decoder |
| `GET /exchange/home`, `/exchange/site`, `/exchange/q` | Stack Exchange sites; a site's or a tag's questions most voted first; a question with its answers, accepted first |
| `GET /reddot/home`, `/reddot/sub`, `/reddot/post` | Subreddit ZIMs; a subreddit's posts top or new; a post with its comment tree |

The machine-readable contract is served at `GET /openapi.json` (OpenAPI 3.1, hand-authored; its `info.version` mirrors the running build). Everything else (`/manage/*`, `/dl/*`, `/snippet`, `/resolve`, static assets, the SPA shell) is internal plumbing and may change at any time — don't build against it.

**`/chunks` (RAG).** Deterministic chunking with no embedding step: `size` (default 1200) and `overlap` (default 120) as tunables. IDs are stable by construction — `content_rev = sha256(stripped_text)[:12]`, each chunk `id = sha256(zim|path|content_rev|seq|size|overlap)[:16]` — so the same ZIM and params yield identical IDs on every server. A ZIM update flips `content_rev` and therefore every derived chunk ID; that turnover is intended, not a break. The MCP `get_chunks` tool is the same function.

**Additive-only JSON.** Within a major version, responses only grow: new fields may appear (clients must ignore unknown fields), existing fields keep name/type/meaning, new query params are optional. Errors carry a generic `{"error": "..."}` and documented status codes (`400` bad params, `404` unknown zim/path, `429` rate limited); internal exception detail is never returned.

## Just the basics

You do not have to run all of Zimi to search and read your ZIMs. Three ways in, smallest first. The numbers were measured on an Intel Mac (Core i5-7500, Python 3.13) under heavy load from other work (load average 50 to 100), with a 318 MB Wikipedia (`wikipedia_en_100`, the top 100 articles, full pictures), a Stack Exchange site and a small wiki; the full English Wikipedia was not measured. On a quiet machine expect them lower.

**1. MCP only, for an AI agent.**

```bash
pip install "zimi[mcp]"
zimi mcp ~/zims
```

| | |
| --- | --- |
| Installed size | 82 MB of Python packages (77 MB on Python 3.14). Of that, BitTorrent (20 MB) and mDNS (3 MB) are installed by default and never used by `zimi mcp`. |
| Start to first search answer | about 2 s, most of it importing the MCP library |
| Memory (RSS) | about 100 MB after a search and a read |
| Ports opened | none |
| Tool schemas | 361 tokens for the three default tools; 3,540 with `--tools full` |
| A read | Wikipedia's "Ant" (700 KB of HTML) in about 0.3 s, 4.5k chars back: the intro, the infobox and an outline of 30 sections |

Client config: `{"command": "zimi", "args": ["mcp", "/path/to/zims"]}`. See the [OpenWebUI guide](../integrations/openwebui.md) for Open WebUI and remote Docker.

**2. Search and read in a browser.**

```bash
pip install zimi
ZIMI_APPS=0 ZIMI_TORRENT=0 zimi serve --zim-dir ~/zims
```

The web app and the JSON API with the apps off and no BitTorrent; add `ZIMI_OFFLINE=1` and it makes no internet requests at all. First `/search` answer about 1 s after start; 70 to 150 MB of memory while it builds title indexes in the background (for fast title search), about 75 MB after. Downloads, Manage and the rest of the app are still there.

**3. Everything.** Docker (`docker run --network host -v ./zims:/zims -v ./zimi-config:/config epheterson/zimi`, about 790 MB to pull, with Chromium for making ZIMs), the desktop app, or Homebrew: every app, ZIM creation, downloads, BitTorrent, and the MCP server inside it (`docker exec -i zimi python3 -m zimi mcp`).

## Configure

| Setting | Where | Effect |
| --- | --- | --- |
| `ZIM_DIR` | env | Library the MCP/API serves |
| `ZIMI_MCP_TOOLS` | env / config | `lean` (three tools, the default for `zimi mcp`) or `full` (every tool, the default for `python -m zimi.mcp_server`); `--tools` overrides |
| `ZIMI_API_TOKEN` | env / config / token file | Bearer token for programmatic HTTP access |
| `size` / `overlap` | `/chunks` + `get_chunks` params | Chunk size and overlap (default 1200 / 120) |
| `zim=` | `/search`, `/suggest`, `/random` | Scope to one ZIM instead of cross-source |
| `ZIMI_RATE_LIMIT*` | env | Request rate limits (frozen at startup) |

## Troubleshoot

- **MCP client sees no tools / won't connect** — the server speaks stdio only; the client must launch it as a subprocess, not connect to a socket. Verify the ZIM directory is in its `args` (`zimi mcp /path`) or `ZIM_DIR` in its `env`.
- **Search results look thin**: the answer's `Incomplete:` line names sources still building a title index or with no full-text index. Pass `wait` to search, or (full set) check `index_status`. `zimi mcp` builds no indexes itself; `zimi serve` or the full set builds them, and a ZIM without a full-text index never gets one (the ZIM ships it).
- **The agent wants a tool it does not see** — `zimi mcp` serves three tools unless started with `--tools full` (or `ZIMI_MCP_TOOLS=full`).
- **Remote Docker MCP hangs** — use `docker exec -i` (interactive) so stdio is wired through; a missing `-i` leaves the transport dead.
- **HTTP calls 401** — a `private`-mode instance needs auth. Send the API token as a Bearer credential (`ZIMI_API_TOKEN` or the generated token file; generate one from Manage after setting a password).
- **HTTP calls 429** — you hit a rate limit. Back off; limits are set at startup via `ZIMI_RATE_LIMIT*`. Calls from this machine or a private network, made directly, are not limited unless `ZIMI_RATE_LIMIT` is set.
- **Chunk IDs changed unexpectedly** — the ZIM's content changed (its `content_rev` flipped) or you changed `size`/`overlap`. That's by design; both feed the ID hash.
- **Building against a `/manage/*` or `/dl/*` path** — don't. Those are internal and unversioned; only the table above is stable.
