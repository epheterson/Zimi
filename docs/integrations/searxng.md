# SearXNG Integration

[SearXNG](https://github.com/searxng/searxng) is a self-hosted metasearch engine. You can route queries through your Zimi instance so SearXNG returns offline ZIM results alongside its other engines — useful for routing AI tools (OpenWebUI, Open Claw, etc.) at a single SearXNG endpoint that includes your local knowledge.

This integration was contributed by [@warlordattack](https://github.com/epheterson/Zimi/issues/15) (issue #15).

## How it works

Zimi already exposes a JSON `/search` endpoint that SearXNG consumes directly. You add a Python engine file to SearXNG that translates queries to Zimi and parses the response.

## `/search` JSON shape

```bash
curl -s "https://your-zimi.example.com/search?q=paris&limit=10"
```

```json
{
  "results": [
    {
      "zim": "wikipedia_en_top",
      "path": "A/Paris",
      "title": "Paris",
      "snippet": "",
      "score": 122.5
    }
  ],
  "by_source": {"wikipedia_en_top": 1},
  "total": 1,
  "elapsed": 0.04,
  "partial": false
}
```

Stable fields per result: `zim`, `path`, `title`, `snippet`, `score`.

The `score` field is a float — higher is better. `total` is the sum across all ZIMs searched. `partial: true` is set when the response is from the fast title-only path (`?fast=1`); SearXNG should generally let you set `timeout: 20.0` and use the full FTS path.

## SearXNG engine

Save as `searx/engines/zimi.py` inside your SearXNG container or volume:

```python
from searx.utils import urlencode

# Replace with your Zimi instance URL
search_url = 'https://your-zimi.example.com/search?'

def request(query, params):
    if not query or not query.strip():
        return params
    params['url'] = search_url + urlencode({'q': query})
    return params

def response(resp):
    results = []
    try:
        data = resp.json()
    except Exception:
        return []

    for result in data.get('results', []):
        zim_id = result.get('zim', '')
        path = result.get('path', '')

        # Build the Zimi reader URL
        res_url = f"https://your-zimi.example.com/w/{zim_id}/{path}"
        source_name = zim_id.replace('_', ' ').title()

        results.append({
            'url': res_url,
            'title': f"[{source_name}] {result.get('title', 'No Title')}",
            'content': result.get('snippet', ''),
            'template': 'default.html',
            'engine': 'zimi',
            'score': float(result.get('score', 1.0)),
        })
    return results
```

## SearXNG `settings.yml`

```yaml
- name: my-zimi
  shortcut: zm
  engine: zimi
  categories: general
  timeout: 20.0   # Zimi can be slow on first cold-start search
```

Use the shortcut to scope queries: `!zm relativity` only hits Zimi.

## Routing results to images / videos categories

By default every Zimi hit lands in the `general` category. Starting in Zimi 1.7, `/search` results include a `category` hint that maps the ZIM source to one of `general`, `images`, or `video`. To route hits to the appropriate SearXNG tab, use the `category` field in your engine's `response()`:

```python
result_category = result.get('category', 'general')
results.append({
    # ...
    'category': result_category,   # SearXNG groups by this
})
```

Examples of the mapping:
- `wikipedia_*`, `stackexchange_*`, `gutenberg_*`, `devdocs_*` → `general`
- `ted_*`, any video-archive ZIM → `video`
- `wikimedia_commons_*` → `images`
- `zimgit-*` (PDF collections) → `general`

The mapping is heuristic and can be overridden in `zimi/search.py:_zim_category()`.

## Performance tips

- **Cold-start timeouts.** First search after restart can take several seconds while libzim builds in-memory caches. Zimi 1.6.3+ pre-warms search indexes on startup, but a generous SearXNG `timeout` (≥ 15s) absorbs the first-hit cost cleanly.
- **Pin frequently-searched ZIMs in RAM.** Set `ZIMI_HOT_ZIMS=wikipedia_en_top,stackoverflow_en_all` (Zimi 1.7+) and those ZIMs stay open and pre-searched in memory permanently. Useful if SearXNG hits Zimi frequently.
- **Use the catalog filter** to limit a SearXNG engine to a single ZIM:
  ```python
  params['url'] = search_url + urlencode({'q': query, 'zim': 'wikipedia_en_top'})
  ```

## Behind a reverse proxy

If both SearXNG and Zimi sit behind Traefik / Caddy / nginx, use the internal hostname in `search_url` so SearXNG bypasses the public TLS path. This eliminates a round-trip and removes any rate-limit interactions.

## Known limitations

- Relevance ranking across SearXNG engines: Zimi sets `score` per result, but SearXNG itself decides how to merge scores across engines. If Zimi results don't appear high enough, lower the priority of the noisier engines or use `!zm` to scope the query.
- The `snippet` field is empty in the current Zimi release. Open an issue if you need previews surfaced via SearXNG.
- AI-assisted re-ranking is intentionally out of scope for Zimi (offline-first principle). Re-rank in SearXNG or downstream of it if needed.

## Reference deployment

The contributor of this integration shared a Docker Compose setup using Traefik and a shared `proxy` network in [issue #15](https://github.com/epheterson/Zimi/issues/15). It's a known-good template if you're starting from scratch.
