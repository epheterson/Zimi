# MCP & API

Two ways for machines to use a Zimi library: the MCP server (for AI agents) and the stable HTTP JSON API (for RAG clients and scripts).

## How it works

**MCP server.** `python3 -m zimi.mcp_server` runs a FastMCP server over **stdio** that wraps Zimi's core functions. It warms search indexes in the background so the transport starts immediately. Point any MCP client at it (locally, or `ssh … docker exec -i zimi python3 -m zimi.mcp_server` for a remote Docker instance), passing `ZIM_DIR` in its env.

Tools exposed: `search` (with a `lang` filter), `read`, `get_chunks`, `suggest`, `list_sources`, `random`, `article_languages`, `read_with_links`, `deep_search`, `list_collections`, `manage_collection`, `manage_favorites`.

**HTTP JSON API.** The stable, integrate-against-it surface (contract in [API stability](../api-stability.md)):

| Endpoint | Purpose |
| --- | --- |
| `GET /search` | Full-text search across ZIM sources (cross-ZIM or scoped with `zim=`) |
| `GET /suggest` | Title autocomplete |
| `GET /read` | Article as stripped plain text |
| `GET /chunks` | Deterministic, embedding-free RAG chunking |
| `GET /w/{zim}/{path}` | Raw article bytes (original HTML/assets) |
| `GET /list` | Installed ZIM sources |
| `GET /random` | Random article |
| `GET /health` | Liveness + build info |

The machine-readable contract is served at `GET /openapi.json` (OpenAPI 3.1, hand-authored; its `info.version` mirrors the running build). Everything else (`/manage/*`, `/dl/*`, `/snippet`, `/resolve`, static assets, the SPA shell) is internal plumbing and may change at any time — don't build against it.

**`/chunks` (RAG).** Deterministic chunking with no embedding step: `size` (default 1200) and `overlap` (default 120) as tunables. IDs are stable by construction — `content_rev = sha256(stripped_text)[:12]`, each chunk `id = sha256(zim|path|content_rev|seq|size|overlap)[:16]` — so the same ZIM and params yield identical IDs on every server. A ZIM update flips `content_rev` and therefore every derived chunk ID; that turnover is intended, not a break. The MCP `get_chunks` tool is the same function.

**Additive-only JSON.** Within a major version, responses only grow: new fields may appear (clients must ignore unknown fields), existing fields keep name/type/meaning, new query params are optional. Errors carry a generic `{"error": "..."}` and documented status codes (`400` bad params, `404` unknown zim/path, `429` rate limited); internal exception detail is never returned.

## Configure

| Setting | Where | Effect |
| --- | --- | --- |
| `ZIM_DIR` | env | Library the MCP/API serves |
| `ZIMI_API_TOKEN` | env / config / token file | Bearer token for programmatic HTTP access |
| `size` / `overlap` | `/chunks` + `get_chunks` params | Chunk size and overlap (default 1200 / 120) |
| `zim=` | `/search`, `/suggest`, `/random` | Scope to one ZIM instead of cross-source |
| `ZIMI_RATE_LIMIT*` | env | Request rate limits (frozen at startup) |

## Troubleshoot

- **MCP client sees no tools / won't connect** — the server speaks stdio only; the client must launch it as a subprocess, not connect to a socket. Verify `ZIM_DIR` is passed in the MCP server's `env`.
- **Remote Docker MCP hangs** — use `docker exec -i` (interactive) so stdio is wired through; a missing `-i` leaves the transport dead.
- **HTTP calls 401** — a `private`-mode instance needs auth. Send the API token as a Bearer credential (`ZIMI_API_TOKEN` or the generated token file; generate one from Manage after setting a password).
- **HTTP calls 429** — you hit a rate limit. Back off; limits are set at startup via `ZIMI_RATE_LIMIT*`.
- **Chunk IDs changed unexpectedly** — the ZIM's content changed (its `content_rev` flipped) or you changed `size`/`overlap`. That's by design; both feed the ID hash.
- **Building against a `/manage/*` or `/dl/*` path** — don't. Those are internal and unversioned; only the table above is stable.
