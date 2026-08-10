# The ZIM creation landscape — survey, gap analysis, and a proposed roadmap

Research date: 2026-08-10. All figures fetched or verified on that date. This supersedes the scope section of [2026-08-10-zim-creation-scope.md](2026-08-10-zim-creation-scope.md), whose "never build a scraper" line Eric rejected as too narrow.

## The one-paragraph verdict

The rejected scope doc was right that Zimi should not write a browser crawler, and wrong that this means Zimi can't offer "punch in a site, get a ZIM." Every serious archiving tool in this space converged on the same two-stage architecture — a capture engine produces raw material, a second tool packages it — and openZIM's own zimit is exactly that (browsertrix-crawler → WARC → warc2zim → ZIM). The leverage is not in the capture engine, which is commodity and already exists in permissively-licensed or subprocess-safe form; it is in being **the packager with a pluggable front end**, which is a role nobody currently occupies. Zimi already has the packager half written, tested, and shipping.

The second thing the survey found is that the hole is larger and more embarrassing than expected. There is no maintained, supported path from "a folder of my own files" to a ZIM. `zimwriterfs` was archived in 2020, `nautilus` has had no code release since May 2024 and demands a ZIP plus a hand-authored `collection.json`, `nautilus-webui` is dead, and when a user asked openZIM directly how to make a ZIM of their own book collection, both maintainers replied with a link to a wiki page.

## 1. Ecosystem map

### 1.1 openZIM's creation tooling

Everything below is GPL-3.0-or-later unless noted, and everything is Docker-first even where a pip path nominally exists. Sources: the [openzim GitHub org](https://api.github.com/orgs/openzim/repos) (55 repos, 11 archived) and each project's own repo.

| Tool | Purpose | Runtime weight | Latest | State / pain |
|---|---|---|---|---|
| [zimit](https://github.com/openzim/zimit) | Any website → ZIM | **Docker only**; base image is `webrecorder/browsertrix-crawler:1.14.1` (full Chrome + Node + Python venv) | 3.1.3, 2026-07-31 | 829 stars, **81 open issues**. Cannot resume, cannot log in, breaks on anti-bot walls |
| [warc2zim](https://github.com/openzim/warc2zim) | WARC → ZIM | **Pure Python, no browser** | 2.3.1, 2026-07-31 | The genuinely reusable piece. But `requires-python = ">=3.14,<3.15"` — see §5 |
| [zim-tools](https://github.com/openzim/zim-tools) | `zimwriterfs`, `zimdump`, `zimcheck`, `zimsplit`, `zimrecreate` | C++ binary | 3.7.0, 2026-05-11 | Healthy, but distro/source/container install only |
| [zimwriterfs](https://github.com/openzim/zimwriterfs) (standalone) | directory → ZIM | — | **ARCHIVED 2020-06-07** | Folded into zim-tools; the discoverable entry point is dead and third-party wrappers still target the archived name |
| [nautilus](https://github.com/openzim/nautilus) | file collections → ZIM | pip (`nautiluszim`), needs libmagic | 1.2.1, **2024-05-25** | Input is a **ZIP, not a directory**; needs a hand-written `collection.json`; pinned to `zimscraperlib==3.3.2` while the ecosystem is on 5.4.1; open bug "created zim files stuck on loading" |
| [nautilus-webui](https://github.com/openzim/nautilus-webui) | GUI for the above | — | dead since 2024-10-09 | — |
| [mwoffliner](https://github.com/openzim/mwoffliner) | MediaWiki → ZIM | **Node 24 + mandatory Redis**, 48 npm deps incl. sharp | 1.17.5, 2026-02-19 | Powers 1,182 of the farm's recipes. Resource requirements documented nowhere |
| [sotoki](https://github.com/openzim/sotoki) | StackExchange → ZIM | Python 3.14 only + Redis | 3.1.1, 2026-07-02 | README's own advice is "download the pre-built ZIMs instead" |
| [youtube](https://github.com/openzim/youtube) | YouTube → ZIM | ffmpeg + Deno + Node | 3.5.0, 2025-11-17 | **Requires a YouTube Data API v3 key** with a 10k req/day quota |
| [gutenberg](https://github.com/openzim/gutenberg) | Project Gutenberg → ZIM | pure Python | 3.0.1, 2025-11-24 | 3.0.0 was a hard break (dropped S3 cache, per-language ZIMs) |
| [ted](https://github.com/openzim/ted) | TED talks → ZIM | ffmpeg | 3.1.0, 2025-07-22 | — |
| [kolibri](https://github.com/openzim/kolibri) | Kolibri channels → ZIM | Node 20 + ffmpeg | **1.2.1, 2024-02-29** | 2+ years stale, `main` is mid-rewrite |
| [devdocs](https://github.com/openzim/devdocs) | devdocs.io → ZIM | pure Python | 0.2.1, 2026-02-26 | README still says "**not ready for use yet**" |
| [ifixit](https://github.com/openzim/ifixit) | iFixit → ZIM | pure Python | 0.3.1, 2024-03-02 | **macOS broken** — full-text index doesn't work |
| [wikihow](https://github.com/openzim/wikihow) | wikiHow → ZIM | pure Python | 1.2.3, 2024-02-19 | Most dormant of the set |
| [python-libzim](https://github.com/openzim/python-libzim) | the Creator API | **pip wheels, Xapian bundled** | 3.12.0, 2026-07-20 | Zimi's existing dependency. See §5 |
| [zimwright](https://github.com/openzim/zimwright) | — | — | created 2026-08-03 | Despite the name, it **downloads an existing ZIM**. Farm plumbing, not a creation tool |

Also in the org and active: `mediawiki` (an mwoffliner rewrite in progress), `mindtouch`, `openedx`, `phet` (the only Apache-2.0 scraper), `maps`, `freecodecamp`, `lilote`.

The shape is clear: **one generic web crawler that requires Docker, plus fifteen bespoke per-source scrapers, and nothing at all for your own files.**

### 1.2 How Kiwix actually produces ZIMs — zimfarm

[Zimfarm](https://github.com/openzim/zimfarm) is a dispatcher plus a fleet of volunteer workers: FastAPI + PostgreSQL backend, a Vue frontend at farm.openzim.org, HTTP polling rather than a message queue, and finished ZIMs pushed by SFTP into a jailed receiver at `warehouse.farm.openzim.org:1522`.

Scheduling is deliberately coarse — the periodicity enum is `manually | monthly | quarterly | biannualy | annually`, mapped to 31/90/180/365 days in [constants.py](https://raw.githubusercontent.com/openzim/zimfarm/main/backend/src/zimfarm_backend/common/constants.py). There is no cron expression anywhere. A sweep finds recipes whose last run predates the window, freezes the recipe config into a `requested_task`, and workers claim tasks matched on declared offliners and free CPU/RAM/disk.

The offliner contract is genuinely small and worth stealing: **one Docker image per offliner, write to `/output`, emit progress on stdout plus a `task_progress.json`, and ship a declarative [`offliner-definition.json`](https://raw.githubusercontent.com/openzim/zimit/main/offliner-definition.json)** describing every flag (type, title, description, required, min/max, regex, choices, secret). Zimit's definition has ~100 flags.

Scale, fetched 2026-08-10: **17 registered offliners**, **3,011 recipes** (1,182 mwoffliner, 278 zimit) via [the v2 API](https://api.farm.openzim.org/v2/recipes?limit=1), **26 registered workers** with 9 online at fetch time, and **3,610 published ZIMs** in [the library OPDS feed](https://opds.library.kiwix.org/catalog/v2/entries?count=0). Worker specs range from `homelet` at 3 CPU / 4 GB to `pixelmemory` at 20 CPU / 160 GB / 3 TB.

Self-hosting is documented and supported both as [joining the public farm as a worker](https://raw.githubusercontent.com/openzim/zimfarm/main/worker/README.md) (≥2 GB RAM, 3+ cores, fixed public IP, and a commitment to stay online ~6 months) and as [running your own instance](https://raw.githubusercontent.com/openzim/zimfarm/main/INTEGRATORS_GUIDE.md). Kiwix already runs a second private farm for Zimit at `api.farm.zimit.kiwix.org/v2`, which is the existence proof that a separate instance is a supported deployment shape.

**The conclusion that matters: the farm is the easy part, the fleet is the moat.** A Postgres + FastAPI + Vue + SSHD stack is a day's work. Twenty-six volunteer machines with up to 128 GB of RAM grinding three thousand recipes is not. Cloning zimfarm buys Zimi nothing.

### 1.3 The hosted zimit.kiwix.org limits

Current, from [zimit-frontend constants.py](https://raw.githubusercontent.com/openzim/zimit-frontend/main/api/src/zimitfrontend/constants.py): **4 GiB output cap, 2-hour wall-clock cap**, 3 CPU, and the API clamps any user-supplied limit to those ceilings. The frequently-cited "1,000 items" cap comes from the [2020 launch post](https://hub.kiwix.org/weblog/2020/12/zim-it-up/) and **no longer exists in code** — the 2-hour cap survives, the page cap does not. Exceeding the caps means self-hosting or [paying Kiwix](https://github.com/openzim/zimit-frontend/issues/93). One task at a time per user is [enforced for fair use](https://github.com/openzim/zimit-frontend/issues/56).

## 2. What users actually ask for

Evidence gathered from GitHub (openzim/kiwix orgs) and Hacker News. **Coverage gap, stated honestly:** Reddit is unreachable from this toolchain (hard 400 at the domain), the kiwix-users Google Group requires auth, and wiki.openzim.org sits behind an anti-bot wall. Reddit is the most likely home of unmet GUI demand, and its absence below is a hole in the evidence, not evidence of absence.

### 2.1 The demand board

[openzim/zim-requests](https://github.com/openzim/zim-requests) is where people go to ask for a ZIM they cannot make themselves. It has **~1,800 issues**. Keyword composition measured 2026-08-10:

| Category | Issues mentioning | Representative |
|---|---|---|
| Wikis | **570 (~32%)** | Wookieepedia #1880, Dolphin Emulator Wiki #1876, OSRS Wiki #1869, Rosetta Code #1865 — all opened in the last month |
| Generic sites via zimit | **246** | [paulgraham.com #1143](https://github.com/openzim/zim-requests/issues/1143) (15 comments, with the author's permission), [cloudflare.com/learning #530](https://github.com/openzim/zim-requests/issues/530) |
| YouTube / video | **149** | [FreeCodeCamp YT channel #1857](https://github.com/openzim/zim-requests/issues/1857), [TED by topic #789](https://github.com/openzim/zim-requests/issues/789) (355+ collections) |
| PDF / book collections | **50** | [shamela.ws Arabic Islamic library #1172](https://github.com/openzim/zim-requests/issues/1172) — **111 comments, still open** |
| Forums | 22 | forums.gentoo.org #1057 |
| Update / refresh requests | 44 in title | [Persian Wikipedia refresh #1862](https://github.com/openzim/zim-requests/issues/1862) — build 2.5 months old |

Documentation sites are a distinct and currently-broken category: [#1230](https://github.com/openzim/zim-requests/issues/1230) debated generating **716 individual devdocs ZIMs**, and [#1853 "Many devdocs recipes failing"](https://github.com/openzim/zim-requests/issues/1853) (2026-07-07) is open with read-timeouts that restarts don't fix.

Wait times are visible and long: [#9 cyclowiki.org](https://github.com/openzim/zim-requests/issues/9) was opened **2018-09-18** and is still open. [#402 scp-wiki.wikidot.com](https://github.com/openzim/zim-requests/issues/402) has been open since 2021 with 58 comments.

### 2.2 The three quotes that define the gap

> **"This is indeed a feature we've been asked for multiple time"** — benoit74 (Kiwix maintainer), 2024-11-04, responding to [zimit#425](https://github.com/openzim/zimit/issues/425), a request to run zimit locally on a desktop with a UI. He calls it technically complex, unlikely soon, and invites upvotes and funding. **Caveat worth stating: the issue has 0 reactions despite that invitation.** Don't overclaim from GitHub alone.

> **"I am interested in the opportunity to create my own ZIM file, which, for example, will contain selected books, and there is no website where you can read this particular collection for free."** — [libkiwix#1232](https://github.com/kiwix/libkiwix/issues/1232), 2025-10-10. Both maintainer replies were links to a wiki page. This is the cleanest single artifact of the hole: a user with local files, answered with documentation.

> **"Service workers are not supported and will most probably never be"** … **"A bad WARC can only produce a bad ZIM."** — the current [warc2zim README](https://github.com/openzim/warc2zim), stating its own permanent limits.

### 2.3 What breaks, specifically

Zimit's recurring failure classes, all still open or recently closed:

- **No resume.** [#490](https://github.com/openzim/zimit/issues/490) (2025-03-29, 13 comments): crawl ends `Exiting, Crawl status: interrupted` after thousands of pages, leaving 14 `.warc.gz` files and "please clean them up manually". [#436](https://github.com/openzim/zimit/issues/436) asks for automatic restart. [#499](https://github.com/openzim/zimit/issues/499) (20 comments): the `--config` flag meant to help "still creates a new .tm folder for all data, which means at best it is going to have to re-download all data again."
- **Browser crashes kill long runs.** [#376](https://github.com/openzim/zimit/issues/376) (27 comments): `Protocol error (Runtime.evaluate): Target closed` while archiving the SCP-CN Wikidot site.
- **Anti-bot walls, diagnosed by reading logs.** [#577](https://github.com/openzim/zimit/issues/577), opened **2026-08-10**: "we're left to guess by reading logs, which is cumbersome and tedious to investigate."
- **No authentication.** [#561](https://github.com/openzim/zimit/issues/561) (2026-06-06): "I'm trying to archive a forum from a university which is behind a login for which I have credentials. Is there a way to login into the website or supply cookies to the crawler?"
- **Wildly variable duration.** [#214](https://github.com/openzim/zimit/issues/214): identical recipe, image, and fleet produced runs from **1h30m to 10h50m**.
- **Video is chronically broken.** [#323](https://github.com/openzim/zimit/issues/323) (19 comments) — note the title's "*Again*, Youtube videos are not working anymore." [#247](https://github.com/openzim/zimit/issues/247): the video on kiwix.org's own homepage isn't captured.

Scale limits worth knowing before promising anything:

- [sotoki#243](https://github.com/openzim/sotoki/issues/243) (open, **72 comments**): a full Stack Overflow run consumed **~96 GiB RAM** where 36–38 GiB was expected, with a suspected leak in libzim's writer path. Corroborated at library level by [python-libzim#117](https://github.com/openzim/python-libzim/issues/117).
- [libzim#1045](https://github.com/openzim/libzim/issues/1045) (2026-03-05): 220M redirects over 45M real entries causes extreme memory consumption during creation. [libzim#1086](https://github.com/openzim/libzim/issues/1086): **40+ minutes** to resolve simple redirects at that scale.
- [sotoki#111](https://github.com/openzim/sotoki/issues/111): `[Errno 28] No space left on device` silently produced a 26 MB file where 198 MB was expected.
- [libzim#1106](https://github.com/openzim/libzim/issues/1106) (closed 2026-07): partially-written `.zim` files were being picked up as valid. **Zimi's own creation flow must not register an output until it is fully written and renamed.**

### 2.4 What people do instead

They hand-roll. The entire third-party ZIM-creation field:

- [ballerburg9005/wget-2-zim](https://github.com/ballerburg9005/wget-2-zim) — **116 stars**, a bash script (wget + ImageMagick + zim-tools), still pushed 2026-05-26, explicitly positioned against zimit on the grounds that Zimit ZIMs needed Service Workers. Self-admitted limit: "wget has very very limited ability to deal with Javascript."
- [MaxHuiskes/Create-Zim-Files](https://github.com/MaxHuiskes/Create-Zim-Files) (2025-12) — wraps the **archived** zimwriterfs. "Ideal for personal, educational, or portable offline libraries."
- [ztimson/kiwixm](https://github.com/ztimson/kiwixm) (2025-09) — web tool to create and upload ZIMs.
- [acrossi/nomad-pdf-packager](https://github.com/acrossi/nomad-pdf-packager) (2026-04) — PDFs → searchable Kiwix archives.

Four hobby projects, one of which targets a tool archived six years ago. That is the competition.

Or they file a request and wait years. Or they leave the format entirely — [Show HN: Kage](https://news.ycombinator.com/item?id=48530624) (2026-06-14) tried "well-known formats first, such as WARC and ZIM from Kiwix" before writing a custom one. Someone even filed [an RFC to replace ZIM outright](https://github.com/openzim/zim-requests/issues/1842) over the lack of incremental updates forcing 100 GB+ full redownloads.

## 3. The adjacent ecosystem — and why people pick it

| Tool | Stars | License | What it is | JS? |
|---|---|---|---|---|
| [yt-dlp](https://github.com/yt-dlp/yt-dlp) | **184,000** | **Unlicense** | The video path. Everything else in video is a wrapper around it | n/a |
| [ArchiveBox](https://github.com/ArchiveBox/ArchiveBox) | **28,095** | **MIT** | Orchestrator: shells out to headless Chrome, wget, SingleFile, yt-dlp, readability, git. Output is a directory tree per snapshot | yes (Chrome) |
| [SingleFile](https://github.com/gildas-lormeau/SingleFile) | **22,122** | AGPL-3.0 | One keystroke, one self-contained `.html`. SingleFileZ is now merged in as a ZIP output option | captures post-JS |
| [monolith](https://github.com/Y2Z/monolith) | **15,393** | **CC0-1.0** | Rust single binary, page → one HTML file. Packaged in cargo/brew/snap/nix/apk/pacman | **no JS engine at all** |
| [HTTrack](https://github.com/xroche/httrack) | 4,673 | GPL-3.0 | See below — not dead | no |
| [pywb](https://github.com/webrecorder/pywb) | 1,686 | GPL-3.0 | WARC record + replay server | — |
| [browsertrix-crawler](https://github.com/webrecorder/browsertrix-crawler) | 1,100 | **AGPL-3.0** | Puppeteer + Brave via CDP → WARC/WACZ. **Initial development funded by Kiwix** | yes |
| [replayweb.page](https://replayweb.page/docs/) | 969 | AGPL-3.0 | Serverless in-browser WACZ replay | — |
| [warcio](https://github.com/webrecorder/warcio) | 466 | **Apache-2.0** | Streaming WARC IO. The only permissively-licensed WARC library | — |
| [openzim-mcp](https://github.com/cameronrye/openzim-mcp) | 104 | — | Python MCP server exposing ZIM to AI models. **The closest thing to a direct Zimi competitor** | — |

Three findings from this table deserve calling out.

**HTTrack is not dead, and everyone believes it is.** The repo was pushed 2026-08-10 with **six releases in the last two weeks** (3.49.14 through 3.49.19). Per [history.txt](https://www.httrack.com/history.txt), 3.49-14 added **native WARC/1.1 output with sorted CDXJ index and WACZ packaging**, and 3.49-15 added a **single-file mode with inlined assets**. The reason nobody knows is that [the website still offers 3.49-2 from 2017](https://www.httrack.com/page/2/en/index.html) as stable. It still cannot execute JavaScript — that limit is architectural — but it is now the only lightweight tool moving *toward* the modern archive formats.

**ArchiveBox has 28,095 stars and a GitHub issue search for `ZIM OR kiwix` returns `total_count: 0`.** Twenty-eight thousand stars' worth of "archive the web to my NAS" demand has never once been pointed at ZIM. Read that either as a huge unserved gap or as evidence nobody wants ZIM for personal capture; the honest answer is that it is both, split by use case (see §4).

**The browser tax is much smaller than the folklore says.** browsertrix-crawler's image is **999 MB and genuinely multi-arch (amd64 + arm64)**, defaults to `--workers 1`, and [SUCHO published a Raspberry Pi deployment guide](https://www.sucho.org/raspberry-pi) confirming it runs on Pi 3 and Pi 4. The "8 cores / 32 GB RAM" figure people quote is for [Browsertrix the Kubernetes platform](https://docs.browsertrix.com/deploy/), not the crawler. Budget ~1 GB RAM per worker and a raised `--shm-size`; a 4 GB Pi is fine at one worker.

### 3.1 ZIM versus WACZ, honestly

| | ZIM | WACZ |
|---|---|---|
| Container | custom clustered zstd | ZIP wrapping WARC |
| Full-text search | **Xapian index embedded in the file** | **no FTS index in the spec** — ReplayWeb.page searches extracted text excerpts in `pages.jsonl` |
| Replay | a dumb reader renders rewritten HTML | needs a replay engine (wabac.js/wombat) |
| Fidelity | lossy — rewritten, **response headers discarded** | byte-exact HTTP exchange including headers |
| Ingest existing archives | no | yes, that's the point |

For "500 GB of knowledge on a NAS in a bunker, searchable offline, one file per source, readable on any platform with no server" ZIM has no competitor. For "I want to keep this blog post I just read" it is absurd overkill, and SingleFile wins on the fact that it captures the page *as you saw it* — post-JS, post-login, post-paywall-scroll — which no server-side crawler can match.

## 4. Where the gap actually is

Three structural observations, in order of how much they should change the plan.

**Nobody serves "my own stuff → ZIM."** This is the strongest, least contested finding. zimwriterfs archived, nautilus dormant and ZIP-only, nautilus-webui dead, and the official answer to a user with a book collection is a wiki link. Meanwhile 50 zim-requests issues mention PDFs and a 111-comment thread about an Arabic Islamic library has been open since 2024.

**Everyone converged on capture-engine plus packager, and the packager slot is open.** ArchiveBox = Chrome → directory. zimit = browsertrix → warc2zim → ZIM. HTTrack now = fetch → WACZ. If Zimi does creation, the win is being the packager with pluggable front ends, not writing crawler number five.

**JS rendering and crawling are separable, and conflating them is what made this look impossible.** Rendering *one page* with JavaScript is cheap — a headless browser, a serialized DOM, done. Crawling an entire JS-heavy site correctly is expensive, because the hard parts are URL rewriting, dedupe, and runtime interception (which is what wombat and warc2zim exist to solve). Zimi can have the first without the second, and hand off to zimit for the second.

The wedge, stated plainly: **Zimi is the only project positioned to be an offline knowledge server that also makes the knowledge.** Kiwix produces ZIMs on a fleet you cannot replicate and reads them; ArchiveBox captures the web but has never heard of ZIM; the MCP-for-ZIM niche has one 104-star entrant. Nobody else has both the reader, the library, the search, the sharing, and the Creator plumbing in one process.

## 5. Hard constraints that shape the design

These are the facts that decide the architecture, and two of them were surprises.

**`warc2zim` can never be a Zimi dependency.** It is a pure-Python `py3-none-any` wheel — but `requires-python = ">=3.14,<3.15"`, and it pins `zimscraperlib==5.4.1`, `lxml==6.1.1`, `brotlipy`, and eight other exact versions. Zimi is `requires-python = ">=3.9"` with exactly one dependency, `libzim>=3.1.0`. Importing warc2zim would drag Zimi's floor to a single Python minor version and import a GPL-3 library into the process. **It must be a sidecar — its own venv or its own container, invoked as a subprocess.** Conveniently, the dependency boundary and the license boundary are the same boundary.

**Do not take `zimscraperlib` either.** Same 3.14-only pin, plus libmagic, ffmpeg, gifsicle, and cairo. That combination is fatal on Synology and Pi. Zimi's existing direct-to-libzim approach in `zimwriter.py` is correct and should stay.

**`pip install libzim` really is the whole creation dependency.** [python-libzim 3.12.0](https://pypi.org/project/libzim/) (2026-07-20, bundling C++ libzim 9.8.1) ships wheels with Xapian compiled in for macOS x86_64 + arm64, manylinux x86_64 + aarch64, musllinux x86_64 + aarch64, and win_amd64, across CPython 3.10–3.14. **There is no armv7/armhf wheel** — 32-bit Raspberry Pi OS is out, which is a constraint Zimi's reading path already lives with. The Creator builds the full-text Xapian index *and* a separate title index in-process via `config_indexing(True, "eng")`; there is no post-processing step and no external tool. Zimi already does exactly this at `zimwriter.py:491`.

**The Creator is not thread-safe.** python-libzim's README states searching and creating are not thread-safe and callers must serialize access. `zimwriter.py` already documents and handles this — the writer is independent of the read-side `Archive` pool, and source reads go through `_srv._zim_lock`. Any new creation path inherits that discipline.

**Never publish a partially-written ZIM.** [libzim#1106](https://github.com/openzim/libzim/issues/1106) is exactly this bug upstream. `zimwriter.py` already writes to a tmp path and renames; every new creation path must do the same before registering.

**Format headroom is not a concern.** No 4 GB file limit — offsets are `uint64_t`, and extended clusters (the 5→6 major bump) removed the old in-cluster 4 GB blob ceiling. 90–100 GB single-file ZIMs are routine. `zimsplit` exists for FAT32 media, defaulting to 2 GiB parts, and libzim transparently reassembles `foo.zimaa`, `foo.zimab`. Compression is effectively zstd-only for writing, default since libzim 7.0.0, with 2 MiB clusters.

**ZIM has no video concept.** It is a MIME-tagged blob store; video works because the ZIM contains ordinary HTML plus a media blob a browser renders. Kiwix's own video ZIMs use **WebM/VP9 + Vorbis** via a Video.js player bundled inside the ZIM. Zimi can be simpler — a plain `<video>` tag needs no JS player for single-file playback.

### 5.1 Licensing — the rule

Anything that touches Zimi's source tree must be MIT / Apache / CC0 / Unlicense. In this space that means exactly four things: **monolith (CC0), yt-dlp (Unlicense), warcio (Apache-2.0), and ArchiveBox's own code (MIT)**. Everything else is a subprocess or a sibling container.

- **python-libzim is GPL-3.0-or-later** and is already Zimi's dependency, across pip, Docker, DMG, and snap. Adding *write* via the same binding introduces **no new obligation** — this is pre-existing exposure, which is good news for `zimi create`.
- **browsertrix-crawler, SingleFile, and replayweb.page are AGPL-3.0.** `docker run` or subprocess them; **never vendor or port their code**. AGPL §13 would force source disclosure for anyone running Zimi as a network service, which is Zimi's entire deployment model.
- **warc2zim, zimit, zim-tools, pywb, HTTrack, wget are GPL-3.0.** Subprocess only. Never import.

### 5.2 Packaging reality — this is what forces the tiering

| Channel | Folder→ZIM | Page→ZIM | Static site→ZIM | JS page→ZIM | JS site→ZIM | Video→ZIM |
|---|---|---|---|---|---|---|
| pip (any 64-bit platform) | yes | yes | yes | optional extra | no | if yt-dlp present |
| Raspberry Pi 64-bit | yes | yes | yes | optional extra | via Docker, slow | yes |
| Raspberry Pi 32-bit | **no libzim wheel** | — | — | — | — | — |
| Docker / Synology | yes | yes | yes | yes | **needs docker-in-docker or socket mount — awkward** | yes |
| Desktop DMG / AppImage | yes | yes | yes | if browser bundled | only if Docker Desktop present | bundle yt-dlp |
| Snap | yes | yes | yes | confinement-dependent | **effectively no** — strict confinement blocks calling out to Docker | yes |

The right-hand columns are why this has to be soft-imported capability tiers rather than one feature. It is the same pattern as libtorrent: present and it works, absent and the UI says so and offers the lighter path.

## 6. Proposed roadmap

Effort estimates assume the existing `zimwriter.py` foundation and include tests plus field-guide entries.

### Tier 1 — Folder / files → ZIM · **BUILD** · ~2–3 days

Point `zimi create ./folder` at HTML, Markdown, PDFs, images; folder hierarchy becomes ZIM paths; generated index when there's no `index.html`/`README.md`; lands in the library via the existing incremental-registration path.

Verdict is unambiguous. The only alternatives are an archived C++ binary and a dormant tool that wants a ZIP plus hand-authored JSON, and this is the single loudest unserved ask in the evidence. Zimi already has the Creator lifecycle, metadata, main-page and `FRONT_ARTICLE` hints, atomic tmp-then-rename, and index-page generation — this is a new front door on a built house.

### Tier 2 — Single page → ZIM · **BUILD** · ~1–2 days on top of Tier 1

`zimi create --url https://example.com/article`. Fetch, carry assets, rewrite references, package.

The under-appreciated fact: **`zimwriter.py` already contains the asset carrier.** `_AssetCarrier`, `rewrite_media`, `collect_styles`, `_rewrite_css`, and `_resolve_ref` were written to pull images and one level of CSS `url()` assets out of source ZIMs, with per-asset and per-ZIM byte caps. Pointing that machinery at HTTP instead of an `Archive` is most of the work. Optional fidelity upgrade: if `monolith` (CC0) is on PATH, use it for the fetch.

The story here is "SingleFile, except it lands in your searchable library" — which nobody has.

### Tier 3 — Static site → ZIM · **BUILD, bounded and honest** · ~4–6 days

A same-origin bounded BFS fetcher over static HTML: depth and page caps, byte budget, robots-aware, resumable, no JavaScript.

This is where "we'd ship a worse one" has teeth, so be precise about what it is. It is deliberately *not* a competitor to browsertrix; it is the 70% case — documentation sites, wikis, blogs, forums — which per §2.1 is the overwhelming majority of what people actually request (wikis alone are 32% of zim-requests). Most doc generators (Sphinx, MkDocs, Docusaurus, Hugo) emit server-rendered HTML. A bounded pure-Python fetcher is a few hundred lines, has zero install cost, and behaves identically on Pi, Synology, Mac, and Windows — whereas shelling to HTTrack means bundling or requiring a C binary on five packaging channels.

**Ship it with an SPA detector.** If the fetched HTML has near-empty body text and a script bundle, say so plainly and point at Tier 4 rather than producing a ZIM full of loading spinners. Half of zimit's bad-output issues ([#215](https://github.com/openzim/zimit/issues/215), [#337](https://github.com/openzim/zimit/issues/337)) are silent partial failures; not repeating that is a feature.

### Tier 4 — JS-heavy content → ZIM · **SPLIT: build the page case, integrate the site case** · ~2 days + ~3–5 days

**JS single page — build, as an optional extra.** `pip install zimi[browser]` pulls Playwright (Apache-2.0, importable). Render, serialize the DOM, hand it to the Tier 2 asset carrier. This covers "punch in a JS-heavy page" with no crawler and no AGPL.

**JS whole site — integrate zimit, never rebuild it.** Orchestrate `ghcr.io/openzim/zimit` as an optional engine exactly the way libtorrent is soft-imported: detect Docker, run the container with the right `--shm-size` and capabilities, stream progress, register the output. Available on Docker/Synology and desktop-with-Docker; honestly unavailable on snap and on bare pip. This is the ceiling, and pretending otherwise would be dishonest — a real browser crawler is *why zimit exists*.

**Also integrate: WARC/WACZ → ZIM import.** A warc2zim sidecar venv (§5) turns every ArchiveBox, browsertrix, HTTrack 3.49.14+, and Webrecorder output into a Zimi library entry. This is high leverage for very little code and it is the cleanest possible answer to "we don't write crawlers": bring whatever crawler you like, Zimi packages it.

### Tier 5 — Video / channel → ZIM · **BUILD thin over yt-dlp** · ~3–4 days

yt-dlp is Unlicense — it can be bundled, vendored, or subprocessed without any obligation, and it is the single most-starred tool in this entire space by an order of magnitude.

The concrete advantage over `openzim/youtube`: **that scraper requires a YouTube Data API v3 key with a 10k request/day quota.** yt-dlp needs no key. A channel or playlist becomes a ZIM of media blobs plus generated HTML with plain `<video>` tags, titles, descriptions, and subtitles — and the subtitles are what make it *searchable*, which is the thing ZIM offers that a folder of mp4s does not. Transcoding stays optional: if ffmpeg is present, offer WebM/VP9 to match Kiwix convention; if absent, store the original container.

Demand is real (149 zim-requests issues) and there is no lightweight path today. Note without moralizing that video ZIMs are large and this is the tier where content-licensing questions land on the user.

### Tier 6 — Recipes and re-runs · **BUILD thin, LAST** · ~2–3 days

A recipe is the saved JSON of a create job plus a periodicity. Zimi already runs a scheduler for auto-updating downloads in `library.py`; reusing it to re-run a capture is small.

But be honest about the evidence: demand for *fresher* ZIMs is heavy and well-documented (44 refresh-titled issues, someone [diffing successive builds by hand](https://github.com/openzim/zim-requests/issues/1872) after a 12% article-count drop), while demand for *self-hosted scheduling* is **inferred, not stated** — a search across openzim/zimfarm for self-hosting requests turned up only Kiwix's own infra issues. Ship "re-run this capture on a schedule," not a farm.

Steal zimfarm's flag-definition idea, though: a declarative per-engine flag schema is how the UI stays generic as engines are added.

### Skip list, with reasons

- **A zimfarm clone.** The farm is a day of work and the fleet is the moat. §1.2.
- **Rewriting mwoffliner, sotoki, gutenberg2zim, ted2zim.** Deep per-source domain knowledge, actively maintained, and their output is already free to download. Import their ZIMs.
- **A WARC replay engine.** warc2zim exists, is pure Python, and works. Sidecar it.
- **Hosting a public creation service.** Kiwix already eats the abuse-and-cost problem here and caps at 2h/4GiB for good reason.
- **WYSIWYG editing inside existing ZIMs.** Unchanged from the original scope doc: fights the format and breaks the mirror/torrent story where a ZIM's identity is its hash. Annotations layered Zimi-side and exported as a companion ZIM remain the better answer.
- **The Browsertrix platform.** Kubernetes.

## 7. What to decide

1. **Does creation become the 1.9 hero, or does 1.9 ship Tier 1+2 and 2.0 take the rest?** Tiers 1–3 plus WARC import is roughly two weeks and would be a coherent, honest "Zimi makes ZIMs" release. Tiers 4–6 are another two to three.
2. **Optional-extra policy.** Is `pip install zimi[browser]` acceptable, or must every creation path work with the base install? This decides whether JS single-page rendering exists at all.
3. **Docker orchestration from inside a container.** Tier 4's site case on Synology needs a mounted docker socket. That is a real security posture change and Eric should make that call, not me.
4. **Naming.** `zimi create` with subcommands, or separate verbs (`zimi create`, `zimi capture`, `zimi grab`)? The tiering will be visible to users either way; better to name it deliberately.

## 8. Evidence gaps

Stated so nobody treats this survey as complete:

- **Reddit is entirely absent** — r/Kiwix, r/DataHoarder, r/selfhosted, r/homelab all unreachable (hard 400 at the domain). This is the most likely home of GUI demand and of "what people do instead" behaviour. Worth a manual browser sweep before committing to the Tier 4+ scope.
- **kiwix-users Google Group** requires auth; **wiki.openzim.org** is behind an anti-bot wall, including the canonical "Build your ZIM file" page that maintainers link people to.
- **Hacker News is genuinely thin** on ZIM creation — two relevant comments total. It is not a demand signal here.
- **No resource benchmarks exist for most offliners.** mwoffliner's RAM and CPU requirements are documented nowhere; sotoki's are folklore. Any promise Zimi makes about creation on constrained hardware should come from a measured run, not from these docs.
