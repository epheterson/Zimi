# Agent-API benchmark — Zimi vs kiwix-serve (2026-07)

What a RAG/agent client actually does is a **search → read cycle**: search a
term, take the top hit, fetch that article's text. `scripts/bench_agent.py`
times that cycle (search call, fetch call, and end-to-end) over N repetitions
and reports latency percentiles.

## Setup

- **Host:** iMac18,3, Intel Core i5-7500 @ 3.40 GHz, macOS 15.7.3, Docker
  20.10.14 (Docker Desktop for Mac — note the Linux-VM + vpnkit network hop).
- **ZIM:** `wiktionary_iu_all_nopic_2026-07.zim` — 316 KB, 368 entries
  (deliberately tiny so index build and disk are never the bottleneck; this
  measures request-path overhead, not corpus scale).
- **Zimi:** this repo's Docker image (`zimi-bench:latest`, VERSION 1.7.4),
  `/search?...&limit=5` → `/read?zim=&path=`.
- **kiwix-serve:** `ghcr.io/kiwix/kiwix-serve:latest`, same ZIM,
  `/search?books.name=&pattern=&pageLength=5` → `/content/<book>/<path>`
  (path discovered via `/suggest`, which is *not* counted in the fetch metric).
- **Load:** N = 50 cycles, 3 warmup cycles, 30 query terms harvested from the
  ZIM's own titles so both servers get the same 45/50 hit rate (5 terms have no
  article; those cycles count as search-only misses). Single-threaded client,
  no concurrency.

Reproduce:

```bash
# Zimi
docker run -d --name zimi-bench -p 8899:8899 -v $PWD/zims:/zims:ro zimi-bench:latest
# kiwix-serve (its entrypoint injects --port=8080)
docker run -d --name kiwix-bench -p 8901:8080 -v $PWD/zims:/data:ro \
  ghcr.io/kiwix/kiwix-serve:latest /data/wiktionary_iu_all_nopic_2026-07.zim

python3 scripts/bench_agent.py --url http://localhost:8899 --zim wiktionary_iu \
  --n 50 --queries "<terms>" \
  --compare http://localhost:8901 --compare-book wiktionary_iu_all_nopic_2026-07
```

## Results (latency, ms; 45 read/cycle samples, 50 search samples)

| Metric | | Zimi | kiwix-serve |
| --- | --- | ---: | ---: |
| **search** | median | 4.35 | 4.14 |
| | p95 | 8.49 | 8.56 |
| | mean | 5.01 | 5.08 |
| **read / content fetch** | median | 4.68 | 3.23 |
| | p95 | 8.67 | 13.44 |
| | mean | 5.17 | 6.94 |
| | max | 16.9 | 118.2 |
| **full cycle** | median | 9.84 | 11.98 |
| | p95 | 14.57 | 25.43 |
| | mean | 10.23 | 17.04 |

## Reading the numbers

- **Search latency is a wash** — ~4 ms median on both. Neither server is
  I/O-bound at this size; you're mostly measuring the HTTP + Docker-network
  round trip.
- **Fetch:** kiwix's `/content` is a hair faster at the median (3.23 vs
  4.68 ms) because it returns the article's **raw HTML** untouched, whereas
  Zimi's `/read` strips HTML to plain text server-side. Zimi's tail is far
  tighter, though (p95 8.7 vs 13.4 ms; max 17 vs 118 ms).
- **End-to-end cycle:** Zimi comes out ahead at the median (9.84 vs 11.98 ms)
  and much steadier in the tail (mean 10.2 vs 17.0 ms, p95 14.6 vs 25.4 ms).

The honest framing: **these servers are within noise of each other on raw
latency**, and at this corpus size that's the expected result. The real
difference is *payload shape*, which the timings understate — Zimi's `/read`
hands back agent-ready plain text (and `/chunks` hands back deterministic,
ID-stable RAG chunks), while kiwix's `/content` hands back HTML the agent still
has to fetch, parse, and strip itself. Equivalent latency, less client-side work
downstream.

## Caveats (read these before quoting a number)

- **Both ran on a dev Mac in Docker**, not production hardware. Docker Desktop
  for Mac routes through a Linux VM and a userspace network proxy, which adds a
  few ms of fixed overhead to *every* request for *both* servers. Absolute
  numbers will differ on Linux/bare metal; treat only the Zimi-vs-kiwix *delta*
  as meaningful, and even that loosely.
- **Tiny ZIM (316 KB).** This isolates request-path overhead on purpose. It says
  nothing about search quality, ranking, or how either server scales to a
  100 GB Wikipedia — different benchmark, not run here.
- **Not identical payloads.** Zimi `/read` = stripped JSON text; kiwix
  `/content` = raw HTML. Comparing their fetch latency is apples-to-oranges by
  construction; the cycle comparison is the fairer of the two.
- **Single-threaded, warm caches, 50 samples.** No concurrency, no cold-start,
  no percentile beyond p95. Small-sample tails (kiwix's 118 ms max) are one-off
  jitter, not a distribution.
- Numbers are from one representative run; re-running moves medians by ~1 ms.
