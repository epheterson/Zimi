# Crawl scope: the whole of browsertrix's scope, in Zimi's crawler (1.13.1)

Eric, 2026-10-07, after a Kiwix user went back to zimit for `--scopeType host` + `--depth 2`: "I want to expose the tools", Zimi should not be the compromise.

Today a site capture keeps to one origin and to the folder the seed sits in (`crawl_scope`). The "whole site" retry gets the host by restarting at `/`, so "this page, and every page on the site it leads to, two links deep" cannot be said.

## The tools

| CLI | API field | Meaning |
|---|---|---|
| `--scope prefix` (default) | `scope` | today's rule: the seed's section, decided from the seed |
| `--scope host` | | every page on the seed's host |
| `--scope domain` | | the host and its subdomains (`www.` dropped first, as browsertrix does) |
| `--scope any` | | any site; depth (and pages/bytes) bound it |
| `--include REGEX` (repeatable) | `include` (string or list) | pages whose URL matches are in scope as well |
| `--exclude REGEX` (repeatable) | `exclude` | pages whose URL matches are never fetched; wins over everything |
| `--extra-hops N` | `extra_hops` | follow links out of scope N more pages (browsertrix `--extraHops`) |

The names are browsertrix's, so a zimit command translates one to one. `--max-depth` already exists.

robots.txt is honored per origin once a crawl can leave one. Exclude is checked before include, include before the scope type, and extra hops count consecutive out-of-scope pages (an in-scope link from an extra-hop page resets the count).

## Every engine

- builtin, rendered and alive walk `crawler._crawl`, which takes a `CrawlScope`.
- zimit: the same flags become `--scopeType`, `--scopeIncludeRx`, `--scopeExcludeRx`, `--extraHops` and `--depth`; `--max-depth` is no longer refused for zimit.

## Surfaces

- CLI flags above; `_crawl_flag_state` rows; refused without `--site`.
- `/manage/create` validates them (`ValueError` on an unknown scope or a regex that does not compile, at most 20 patterns of 500 characters).
- Create page: "Pages to capture" select in the site flags (This section / This site / This site and its subdomains / Anywhere links lead), include/exclude/extra hops under More options.
- The "Capture the whole site" retry keeps the seed and sends `scope: host`.
- OpenAPI, docs/features/create.md, CHANGELOG, i18n x10.

## Checklist

- [ ] crawler: `CrawlScope`, per-origin robots, `_crawl` and the redirect check through it; zimit flags
- [ ] alive: pass scope through
- [ ] creator CLI + server argparse
- [ ] manage: validate, pass to the job
- [ ] create.js fields, retry, i18n x10, css if needed
- [ ] tests: scope unit rules, host / any / include / exclude / extra hops end to end on the fixture site (127.0.0.1 and localhost are two hosts), robots per origin, zimit argv, API validation, CLI refusal
- [ ] docs, CHANGELOG, openapi
