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
