# Zimi feature guide

Each guide follows the same shape — **How it works**, **Configure**, **Troubleshoot** — so you can jump straight to the part you need.

Everything here is verified against the shipping code. Commands are `python3 -m zimi <subcommand>`; run `python3 -m zimi <subcommand> --help` for the authoritative flag list. `zimi config` prints the resolved settings and where each value came from.

## Guides

| Doc | What it covers |
| --- | --- |
| [Reading](reading.md) | Search and ranking, the reader and Reader View, bookmarks and history, word lookup, cross-language articles, PDFs, offline/PWA, accessibility, the almanac, and what happens to a page captured without its JavaScript |
| [Making ZIMs](making-zims.md) | `zimi create` for a folder, a page, a `--site` crawl or a video; the four engines and what each one trades; bookmarks as a standalone ZIM; `zimi import` for a WARC/WACZ |
| [Getting & sharing](getting-and-sharing.md) | The catalog and downloads, folders as categories, same-flavor auto-update, BitTorrent seeding, Nearby (mDNS LAN), and the `/dl/` peer transport |
| [Access](access.md) | Public-access modes, named accounts, per-ZIM allowlists, the creator role, the first-run bootstrap, and Cloudflare Access SSO |
| [Operations](operations.md) | `zimi config` and the config file, backup/restore, air-gap (`ZIMI_OFFLINE`), `/metrics`, `/health`, update channels, deploy manifests |
| [API & MCP](api-and-mcp.md) | The MCP server and its tools, the stable JSON API, `/openapi.json`, `/chunks` |

## Related references

- [API stability contract](../api-stability.md) — the guarantees behind the stable endpoints.
- [Networking & deployment modes](../deployment-networking.md) — host vs bridge vs macvlan, mDNS and BT port reachability.
- [Integrations](../integrations/) — Open WebUI, SearXNG.
