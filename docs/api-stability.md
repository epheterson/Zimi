# Zimi API stability

Zimi's HTTP API is meant to be programmed against by agents and RAG clients.
These are the guarantees for the endpoints below. The machine-readable contract
is served at `/openapi.json` (its `info.version` mirrors the running build).

## Stable endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET /search` | Full-text search across ZIM sources |
| `GET /suggest` | Title autocomplete |
| `GET /read` | Article as stripped plain text |
| `GET /chunks` | Deterministic, embedding-free RAG chunking |
| `GET /w/{zim}/{path}` | Raw article content (original HTML/asset bytes) |
| `GET /list` | Installed ZIM sources |
| `GET /random` | Random article |
| `GET /health` | Liveness + build info |

Everything else (`/manage/*`, `/dl/*`, `/snippet`, `/resolve`, static assets,
the SPA shell) is internal plumbing for the web UI and peer sharing. It can
change or move at any time — do not build integrations against it.

## Additive-only JSON

Within a major version, response JSON only grows:

- New fields may be added to any response object. Clients must ignore unknown
  fields.
- Existing fields keep their name, type, and meaning.
- New optional query parameters may be added; existing ones keep their meaning.
- `GET /chunks` IDs are stable by construction: `content_rev =
  sha256(stripped_text)[:12]` and each chunk `id =
  sha256(zim|path|content_rev|seq|size|overlap)[:16]`. Same ZIM + same params
  yield identical IDs on every server; a ZIM update flips `content_rev` and
  therefore every derived chunk ID — that turnover is intended, not a break.

Error responses carry a generic `{"error": "..."}` string and the documented
status codes (`400` bad/missing params, `404` unknown zim/path, `429` rate
limited). Internal exception detail is never returned to clients.

## Deprecation

A stable endpoint or field is only removed or given a breaking change after it
has been announced as deprecated for at least one full minor release. Concretely:
if a change lands in `1.(N+1)`, the deprecation is announced no later than `1.N`
(CHANGELOG + this doc). Agents pinning to a minor version therefore always get
at least one release of warning before anything they depend on changes shape.
