# Zimi feature guide

One document per major feature. Each follows the same shape — **How it works**, **Configure**, **Troubleshoot** — so you can jump straight to the part you need.

Everything here is verified against the shipping code. Commands are `python3 -m zimi <subcommand>`; run `python3 -m zimi <subcommand> --help` for the authoritative flag list. `zimi config` prints the resolved settings and where each value came from.

## Features

| Doc | What it covers |
| --- | --- |
| [Reading](reading.md) | Search ranking, the reader and Reader View, bookmarks and history, word lookup, PDFs, offline/PWA, accessibility, and how a page captured without its JavaScript is settled |
| [Creating ZIMs](creation.md) | `zimi create` — folder, single page, `--site` crawl, video; the builtin / rendered / alive / zimit engines; capture defaults, size budgets, provenance |
| [Importing web archives](import.md) | `zimi import` — WARC/WACZ into a library ZIM via the warc2zim sidecar (CLI-only) |
| [Library & catalog](library-and-catalog.md) | Installed library, catalog downloads, folders-as-categories, same-flavor auto-update matching |
| [Sharing](sharing.md) | BitTorrent seeding, Nearby (mDNS LAN discovery), the raw-`.zim` download and `/dl/` peer transport |
| [Users & access](users-and-access.md) | Public-access modes, named accounts, per-ZIM allowlists, the creator role, and the secure first-run bootstrap |
| [SSO](sso.md) | Cloudflare Access trusted-header SSO (experimental, off by default) |
| [Operations](operations.md) | `zimi config` + config file, backup/restore, air-gap (`ZIMI_OFFLINE`), `/metrics`, `/health`, update channels, deploy manifests |
| [Almanac & space](almanac.md) | The offline-computed almanac / space views |
| [MCP & API](mcp-and-api.md) | The MCP server and its tools, the stable JSON API, `/openapi.json`, `/chunks` |

## Related references

- [API stability contract](../api-stability.md) — the guarantees behind the stable endpoints.
- [Networking & deployment modes](../deployment-networking.md) — host vs bridge vs macvlan, mDNS and BT port reachability.
- [Integrations](../integrations/) — Open WebUI, SearXNG.
