# Capture options: every knob, per capture or as a standing default (1.13.1)

Eric, 2026-10-07: "Yes to user agent and most of these and I'm sure there's more. Maybe we should allow both per capture and setting these all permanently." Signed-in capture is wanted too, later: "we can ship the quick adds first."

## The options

One table in `crawler.py` (`CAPTURE_OPTIONS`) names each option once: its key, type, bounds, CLI flag, zimit flag, and which engines honor it. The CLI, `/manage/create`, `/manage/creator`, the Create page and the zimit argv all read it.

| Option | CLI | Engines | zimit | Default |
|---|---|---|---|---|
| time limit | `--time-limit 8h` | all site engines | `--timeLimit` (seconds) | none |
| sitemap seeds | `--sitemap [URL]` | all site engines | `--useSitemap` | off; bare flag = robots.txt `Sitemap:` lines, else `/sitemap.xml` |
| user agent | `--user-agent STR` | all | `--userAgent` | Zimi's honest UA |
| mobile | `--mobile` | rendered, alive (viewport 390, touch, mobile UA); builtin and singlefile send the mobile UA | `--mobileDevice "iPhone 13"` | off |
| page timeout | `--page-timeout 60` | rendered, alive | `--pageLoadTimeout` | the engine's own |

Already there and now also storable as defaults: scope, max pages, max depth, max bytes, delay, block ads, capture variants.

Not storable: include, exclude, extra hops (they describe one site), ignore robots (a choice made per site, with its warning each time).

zimit flags go out only when the image's help lists them (`_image_supports_flag`), else a note says the option was not passed.

## Standing defaults

- `create_defaults.json` (already holds block_ads, capture_variants) holds any `CAPTURE_OPTIONS` key marked storable, validated by the same table on write and on read (a hand-edited bad value falls back, as today).
- Precedence: the capture's own value, then the stored default, then the factory value.
- The CLI reads the same file from its data dir, so `zimi create` and the Create page agree.
- Manage, Creator section: the existing two toggles plus the storable options, each showing the factory value as its placeholder.
- Create page Advanced fields show the stored default as placeholder, so a person sees what silence means.

## Signed-in capture (later, not this release)

A remote browser view in Create: Zimi opens Chromium (rendered/alive engines), streams the screen into the page (CDP screencast), forwards clicks and keys, the person signs in, and that session's cookies drive that one capture and are thrown away after. The ZIM may hold personal pages; the card says so. Own plan when it starts.

## Private addresses (Eric, 2026-10-07)

An admin toggle in Manage, Creator: **Allow captures of private addresses**, off by default, stored as `allow_private` in `create_defaults.json`. Admin-set only; never a per-capture field.

- Off, a capture started through `/manage/create` (and its preview) refuses loopback, RFC 1918/ULA, link-local (169.254.169.254 included), CGNAT, unspecified and multicast. The RESOLVED address is judged (cached per job), so a public-looking name pointing at 10.x is refused too.
- Builtin: every redirect hop, asset, robots.txt and sitemap fetch. Rendered and alive: the browser's requests, in the request interception, and the context's own fetches. zimit and SingleFile: the seed only (their browsers run outside Zimi).
- A refused seed is a plain error saying an admin can allow it in Manage; a refused page or asset mid-crawl is skipped with a note.
- The CLI is the host operator and is never restricted. The rule lives in `zimi/netguard.py`, which `http.py` reads `CGNAT_NET` from.

## Checklist

- [x] `CAPTURE_OPTIONS` table + parse/validate helpers (durations, bounds)
- [x] time limit in `_crawl` (reason `time limit (8h)`), alive and zimit
- [x] sitemap: fetch, parse (urlset + sitemapindex, gz, bounded), seed in scope at depth 1
- [x] user agent + mobile: builtin fetch and robots, renderer context, alive, singlefile, zimit
- [x] page timeout: renderer/alive goto, zimit
- [x] CLI flags, `_crawl_flag_state`, `/manage/create` validation, job hand-off
- [x] stored defaults: widen `_create_default`, `/manage/creator` write, CLI reads them
- [x] Create page fields (Advanced), Manage Creator fields, i18n x10
- [x] tests: each option end to end on the fixture site, zimit argv, defaults precedence, bad values refused
- [x] docs/features/making-zims.md, CHANGELOG, OpenAPI
- [x] private addresses: `netguard.py`, guard in the builtin fetches, browser interception, seed checks, `allow_private` (admin only), tests
- Deferred: single-page and multi-page captures (these options are site-capture options, like scope); yt-dlp video and Reddit captures are not held to the private rule (their fetchers run outside Zimi)

## Round 2: the long tail (Eric, 2026-10-07)

"Zim details? Cookies? Skip things makes sense. Parallel too. I thought we already had details but yeah grow this up." Manage keeps its name; Settings is a tab inside it.

Every new option is a `CAPTURE_OPTIONS` row (parse, flag, zimit flag, engines, storable), so the CLI, `/manage/create`, `/manage/creator`, Create and the zimit argv read one table.

| Option | Key | CLI | Engines | zimit | Storable |
|---|---|---|---|---|---|
| ZIM description | `description` | `--description` (exists) | all modes that write a ZIM | `--description` | no |
| Author | `creator` | `--creator` (exists) | same | `--creator` | yes |
| Publisher | `publisher` | `--publisher` | same | `--publisher` | yes |
| Tags | `tags` | `--tags a;b` | same | `--tags` | no |
| Cookies | `cookies` | `--cookies "a=1; b=2"` | builtin, rendered, alive, singlefile when it can | not passed (note) | never |
| Leave out | `skip_types` | `--skip video,audio,pdf,archives,images` | builtin, rendered, alive | not passed unless zimit can | yes |
| Largest file | `max_file_bytes` | `--max-file-size 50M` | builtin, rendered, alive | not passed unless zimit can | yes |
| At once | `workers` | `--workers 4` (1 to 16) | builtin, zimit (`--workers`), rendered if cheap | `--workers` | yes |
| Engine | `engine` | `--engine` (exists) | - | - | yes (default for Create's picker) |
| Language | `language` | `--language` (exists) | - | `--lang` | yes |

Rules:
- Details: a capture's value, then a folder's `zimi.txt`, then the stored default, then the factory (Creator "Zimi", Publisher "Zimi"). Lengths follow the ZIM metadata conventions (description at most 80 characters).
- Cookies are a credential. Sent only to the seed's host and its subdomains, never to another origin a wider scope reaches. Never written to the job record, history, log, provenance, ZIM metadata or `create_defaults.json`; the job's echo of its options shows `cookies: set`. Per capture only.
- Leave out: a fixed set of kinds matched by content type, and by extension before a fetch. A skipped asset's link stays as it was; the log counts what was left out.
- Workers keep the politeness rules: robots.txt, the delay per host, the private-address guard and the time limit hold with any number.

Create: Title gains a "Details" fold beside it (description, author, publisher, tags). Advanced gains workers and the two leave-out rows (How much) and cookies (How it's fetched). Manage, Creator is rebuilt on Create's layout: same groups, one label column, grey is the real default (Time limit says None, not 8h), plus engine and language defaults.

Deferred: icon upload, long description and license (CLI and `zimi.txt` only).

### Checklist (round 2)

- [x] rows + parse/validate for each option, CLI flags, `/manage/create` and `/manage/creator` hand-off
- [x] details reach the ZIM metadata for page, site (every engine), video, folder, import
- [x] cookies: builtin + browser engines, host-bound, redacted everywhere; tests prove no leak to another origin or to disk
- [x] leave out + largest file: builtin + browser engines, tests on the fixture site
- [x] workers: zimit only. The builtin crawl has one frontier, one politeness clock, one byte budget and one time limit; a pool that kept max_pages and max_bytes exact is its own piece of work. Not on the web form, since Create cannot pick zimit.
- [x] engine + language stored defaults
- [x] Create fields (Advanced rows, details in The ZIM), Manage Creator drawn from Create's field table (switches for on/off, the house rule in Settings), i18n x10
- [x] docs/features/making-zims.md, CHANGELOG
- Narrower: cookies, leave-out and workers are site captures only, like the round 1 options. OpenAPI documents no /manage routes, so nothing to add.
