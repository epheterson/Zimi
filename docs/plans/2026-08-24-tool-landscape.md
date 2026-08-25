# Every piece of the pipeline, and what should do it

Eric: *"I'd like to integrate great existing tools instead of owning the hard part… every piece we need with quality options, no unnecessary duplication."*

One row per job. What we run today, the best thing that exists, and the call.

## The pipeline

| # | Job | Today | Best available | License | Call |
| --- | --- | --- | --- | --- | --- |
| 1 | Fetch a page + its assets, no JavaScript | **ours** (`BuiltinCapture`) | **monolith** (Rust) · wget · HTTrack · obelisk | monolith **CC0** | **Keep ours.** It writes straight into a ZIM Creator and streams progress; monolith writes one HTML file and would need the same wrapper SingleFile already gets. Revisit if it breaks again. |
| 2 | Render a JS page and serialise it | **ours** (`RenderedCapture`) + **SingleFile** (new) | **SingleFile** — the reference implementation | AGPL, sidecar | **Both, deliberately.** Ours produces a browsable tree with separate assets; SingleFile produces one self-contained file that cannot break. Different products, not duplicates — see below. |
| 3 | Record a live session and replay it | **ours** (`alive` → warc2zim) | **browsertrix-crawler** · replayweb.page | AGPL/GPL | **Keep, but stop hand-rolling the replay.** The scroll decay lives here. |
| 4 | Per-site scroll / expand / autoplay behaviour | **ours** (`_lazy_scroll`) | **browsertrix-behaviors** | AGPL, sidecar | **Adopt.** This is real domain knowledge — what makes Twitter, Instagram and infinite feeds reveal content — and it is the single biggest gap. Our version is a loop that scrolls. |
| 5 | Crawl a whole site with a browser | `--engine zimit` (CLI + `--site` only) | **zimit / browsertrix-crawler** | GPL, Docker | **Already ours to use. Promote it** — it is not in `CAPTURE_ENGINES`, so it cannot capture a single page and the web UI never offers it. |
| 6 | Crawl a site without a browser | **ours** (`crawler.py`) | HTTrack · wget --mirror | — | **Keep.** Bounded, polite, robots-aware, writes a ZIM directly. Nothing off-the-shelf produces a ZIM. |
| 7 | WARC/WACZ → ZIM | **warc2zim** | warc2zim | GPL, sidecar | **Already right.** |
| 8 | Video / playlist | **yt-dlp** | yt-dlp | Unlicense | **Already right.** |
| 9 | Ad + tracker blocking at capture | **ours** + StevenBlack list | uBlock lists · SingleFile's own | list is MIT | **Keep.** It is a list lookup, not a hard part. |
| 10 | Write the ZIM | **libzim** + ours | libzim | GPL, library | **Already right.** |
| 11 | Read ZIMs | **ours** | kiwix-js · kiwix-serve | GPL | **Keep — this is the product.** Nothing else has cross-ZIM search, the almanac, or the API. |

## Where we were duplicating

Three places, and only three:

- **Serialising a rendered page.** SingleFile is now an engine. Every serialisation bug of the last week — srcset commas, `&amp;`, root-relative URLs, resource hints — is one it fixed years ago.
- **Replay.** `alive` half-reimplements what wombat does. That is why the scroll decay is ours to debug instead of theirs to have already fixed.
- **Scroll behaviour.** `_lazy_scroll` is a loop; browsertrix-behaviors is a catalogue.

Everything else on that list is either already upstream or is the ZIM-shaped part nobody else does.

## Why SingleFile does not replace Rendered

They make different things, and the measurement says so. apple.com, iPhone width, served offline with the network sealed:

| | Entries | Size | Images on arrival | After scrolling |
| --- | --- | --- | --- | --- |
| rendered | ~80 | 7.6 MB | all | all |
| **singlefile** | **19** | **2.3 MB** | **35 / 35** | **35 / 35** |
| alive | 186 | 15.8 MB | 46 / 49 | **0 / 49** |

SingleFile wins on robustness by construction: every asset is a `data:` URI inside the document, so there is nothing to lazy-load, nothing to re-fetch, and no reference that can fail to resolve. The scroll decay that has eaten Alive all week **cannot happen** to it.

What it gives up: the archive is one entry, not a browsable tree, so assets are not shared between pages and a multi-page capture stores its images once per page. Base64 also costs about a third in size. For one page — the overwhelmingly common case — that is a good trade and it is the one to reach for.

## Order of work

1. **Ship SingleFile** — done, engine registered and gated like every other install-dependent engine.
2. **Promote zimit** to a first-class engine for `--site`, and offer it in the web UI where Docker is available.
3. **Adopt browsertrix-behaviors** as a sidecar for the rendered and alive engines. This is the fix for Alive's scroll decay and for every lazy-loading site.
4. **Send the zimscraperlib srcset patch upstream** so it stops being ours to carry.
