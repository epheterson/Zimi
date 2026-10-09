# Creating ZIMs

Turn a folder, a web page, a whole small site, a video source, or a subreddit into a ZIM that lives in your library and works forever offline.

## How it works

`zimi create` is one command with several input shapes. The positional `source` is either a folder path or one or more `http(s)://` URLs (several URLs land in a single ZIM behind a generated index page). Add `--site` to crawl one origin instead of capturing a single page (an address with a path, like `https://example.org/docs/`, keeps the crawl under that path; the images, styles and scripts its pages use are fetched from anywhere on the site. A last part with no slash and no extension, like `/wiki/Main_Page`, is a section when the page links to pages under it and otherwise a page among its neighbours, which are captured with it; a section the site redirects elsewhere is followed there); pass a video URL to package a playlist or channel via yt-dlp.

Web captures run through one of five **engines**, chosen with `--engine`:

- **builtin** (default) — no JavaScript, no install. Fetches HTML and assets directly. Fastest, smallest, and the only engine with zero dependencies.
- **rendered** — runs a headless Chromium in-process so client-rendered pages produce real content. Needs `pip install 'zimi[browser]'` and `playwright install chromium`.
- **alive** — records the live browser session to a WARC and converts it with warc2zim, so the saved site's JavaScript still runs inside the reader. Needs the browser extra above plus the warc2zim sidecar (`zimi import --setup`).
- **singlefile** — hands the page to [SingleFile](https://github.com/gildas-lormeau/SingleFile), the reference implementation of "save this page as one file". It drives a browser, waits for the page to finish, and inlines every image, stylesheet and font as a data URI. The result is a single self-contained entry that **cannot** break: there is nothing to lazy-load and no reference that can fail to resolve, so it is the only engine whose images survive a scroll on every site tested. Costs about a third in size (base64) and stores one entry rather than a browsable tree. Needs Node and `npm install -g single-file-cli`, plus a Chromium.
- **zimit** — openZIM's browser-based crawler (browsertrix), run via Docker. Now available for a single page as well as a `--site` crawl, and offered in the web UI wherever Zimi can reach a Docker daemon. Extra crawler arguments pass through with `--engine-arg` (write it attached, e.g. `--engine-arg=--workers=2`).

**What each engine trades.** They are not better and worse, they are different bargains; the three that run in-process compare like this. Measured on one CNN front page, iPhone width, served offline with the network sealed:

| Engine | Assets kept | Images that render | What it is for |
| --- | --- | --- | --- |
| builtin (fast) | ~380 | all, arriving as you scroll | Biggest archive, correct at any screen width, keeps lazy-loading |
| rendered | ~95 | all | Smallest archive and exact: each `srcset` collapses to the one image the browser chose, so nothing can re-pick a size the archive lacks |
| alive | ~315 | fewer on image-heavy sites | The page's own JavaScript still runs — faithful to behaviour, at the cost of image coverage on sites that lazy-load aggressively |

A capture is also **refused rather than packaged** when the site does not return a web page at all. Some sites answer an automated browser with HTTP 200 and a few bytes of error text; the rendered and alive engines check what the browser actually received and fail with the reason instead of writing an archive of an error message.

**Resource hints are dropped.** `<link rel="preload">` and friends are advice to a live browser about what to fetch early. In an archive they are requests for addresses that do not exist, so all of them — `preload`, `modulepreload`, `prefetch`, `preconnect`, `dns-prefetch` — are removed. The files themselves are still carried through the stylesheets and markup that actually use them.

**Making a page reveal itself.** The browser engines (rendered, alive, zimit) drive the page before serialising it, because a modern site holds most of its content back until something asks. Zimi's own pass is a scroll. When [browsertrix-behaviors](https://github.com/webrecorder/browsertrix-behaviors) is installed (`npm install -g browsertrix-behaviors`, or point `ZIMI_BEHAVIORS` at a `behaviors.js`), Zimi runs Webrecorder's catalogue first — per-site scripts for the sites people archive most, plus a better generic autoscroll — and then still runs its own scroll, because adopting somebody else's coverage should never subtract from your own. Zimi does not ship the bundle: it is AGPL, so it is used when present and never distributed. Without it every engine works exactly as before.

**Capture defaults.** Ad, tracker, and consent-manager requests are blocked during capture by default (`--block-ads`, on for the rendered and alive engines) — smaller ZIMs, and pages that gate on those endpoints render their real content. `--no-block-ads` captures everything. The blocklist snapshot ships in `zimi/assets/blocklist-snapshot.txt.gz` (StevenBlack/hosts, MIT) and is not auto-refreshed. Image-variant capture is a Manage/Creator toggle (`capture_variants`) and a `create` internal option.

**Size budget.** `--max-bytes` caps output (e.g. `512MiB`, `4G`; 0 for no limit, and any size under Custom in the Create page). For `--site` it counts pages plus assets (default 4G); for video sources it caps total media (default 16G). Crawls are also bounded by `--max-pages` (site default 10,000; any number, 0 for no limit, and the same in the Create page's Max pages box), `--max-depth` (site default 10), and `--delay` between requests (site default 0.5s; robots.txt `Crawl-delay` wins when larger). `--ignore-robots` (site only) crawls disallowed pages and prints a warning.

**Which pages a site capture visits.** By default a `--site` capture keeps to the start page's section: `/docs/intro.html` stays under `/docs/`. `--scope` widens it with browsertrix's scope types, so a zimit command line carries over unchanged: `host` is every page on the start page's site, `domain` adds its subdomains (a leading `www.` is dropped first), and `any` follows links to any site, bounded by `--max-depth` and the limits. `--include REGEX` adds pages whose address matches, `--exclude REGEX` keeps pages out whatever else says (both repeatable), and `--extra-hops N` follows links that leave the scope N more pages. To capture a page and everything on its site two links from it: `zimi create https://example.org/python/tutorial/ --site --scope host --max-depth 2`. Once a capture can leave the site, each site's robots.txt is read and honored. The same options are under Advanced on the Create page (one pattern per box there), and the zimit engine receives them as its own `--scopeType`, `--scopeIncludeRx`, `--scopeExcludeRx`, `--extraHops` and `--depth`.

**When a capture stops, where it looks, and who it says it is.** `--time-limit 8h` (also `90m`, `45s`, or plain seconds) ends a `--site` crawl at the next page once the time is spent and packages what was captured; the card says it stopped at the time limit. `--sitemap` also visits the pages a sitemap lists, including pages no link reaches: bare, it reads the `Sitemap:` lines in robots.txt and falls back to `/sitemap.xml`, or give the sitemap's address; indexes and `.gz` files are followed, with hard limits on files, pages, size and nesting. Sitemap pages are visited only when the scope admits them, and `--no-sitemap` overrides a stored default. `--user-agent STRING` replaces Zimi's own name on every request (robots.txt rules are still matched against Zimi). `--mobile` presents a phone: its user agent everywhere, and with the rendered and alive engines a 390 pixel touch screen. `--page-timeout SECONDS` is how long the rendered, alive and zimit engines wait on one page. The zimit engine is handed `--timeLimit`, `--useSitemap`, `--userAgent`, `--mobileDevice` and `--pageLoadTimeout`, each only when the image's help lists it; otherwise the log says that option was not passed. All of these are under Advanced on the Create page.

**The ZIM's details.** `--description` (at most 80 characters, the openZIM convention; a longer one is refused with its length, not cut), `--creator` (the author), `--publisher` and `--tags a;b` reach the metadata of every mode that writes a ZIM: a page, several pages, a site on any engine, a folder, a video source and an imported archive. zimit and warc2zim are handed the same words, each flag only when the image or sidecar lists it. Tags are added to the ones Zimi writes itself. The order is the capture's own value, then a folder's `zimi.txt`, then the stored default for author and publisher, then `Zimi` for both. Description and tags describe one ZIM and are never stored. On the Create page they are under Details, beside the title.

**Cookies.** `--cookies "a=1; b=2"` takes a Cookie header as copied from your browser's developer tools, for a page that needs you signed in (a page, several pages or a `--site` capture, with the fast, rendered or alive engine; each page's cookies go to that page's own host). They are sent only to the start page's host and its subdomains: never to another site a wider scope or an extra hop reaches, never to a redirect's other host, never to a CDN that serves the images. They are a credential, so they are never stored as a default and never written down: not in the job record or history, the log, the ZIM's metadata or capture record, or any error message; wherever a capture's options are shown, cookies read `set`. A capture that needs the same cookies again needs them typed again. zimit and SingleFile cannot take them safely (their browsers run outside Zimi), so both refuse the option rather than run signed out. A secure (https) start page's cookies are never sent over plain http, and cookies with the `__Host-` and `__Secure-` prefixes are given to the browser in the form it demands. A ZIM made while signed in may hold pages that are only yours.

**Leaving things out.** `--skip video,audio,pdf,archives,images` (any of them) and `--max-file-size 50M` keep those kinds of file, and any file larger than that, out of a page, several pages or a `--site` capture on the fast, rendered and alive engines. The page itself is never left out. A file is matched by its extension before it is fetched, and by its content type and declared length once the headers are in; a page that points at a file left out keeps its link as it was, and the log counts what was left out. zimit has no flag for either, so its log says they were not passed. Both can be stored as defaults.

**Workers.** `--workers 4` (1 to 16) is how many pages zimit fetches at once. Zimi's own crawler stays one polite walk by design: one frontier, one delay per host, one robots.txt policy, one byte budget and one time limit, and a pool of fetchers would have to share all of them to keep their guarantees exact. It can be stored as a default for zimit captures.

**Standing defaults.** Manage, Creator holds the values a capture starts with: block ads, image variants, sitemap, mobile, time limit, user agent, page timeout, scope, max pages, max depth, size budget, delay, author, publisher, what to leave out, the largest file, workers, the engine and the language. A capture's own value wins, then the stored default, then the built-in one; the Create page shows the stored default in each field, and `zimi create` reads the same file (`create_defaults.json` in the data directory). A value that cannot be read (a hand-edited file) is ignored. Include and exclude patterns, extra hops and ignore-robots describe one site, and description, tags and cookies one capture; none of them is stored. The stored engine and language are what the Create page's pickers start on and what `zimi create` uses when it is not given `--engine` or `--language`; a typed `--engine` still beats a video address's own extractor, and a stored one does not.

**Private addresses.** A capture started from the web (the Create page, `/manage/create` and its preview) refuses addresses that are loopback, on a private network, link-local (including `169.254.169.254`), carrier-grade NAT, unspecified or multicast. A name is judged by the address it resolves to, and every redirect, image, stylesheet, robots.txt and sitemap fetch is held to it; the rendered and alive engines refuse the browser's own requests the same way, and zimit and SingleFile are checked on the address they are given, since their browsers run outside Zimi. The fast engine also checks the address each connection actually reached, so a name that answers differently the second time (DNS rebinding) is refused; the browser engines resolve names themselves and that second resolution is not re-checked. A name that will not resolve, or takes more than five seconds to, is refused for a web capture, and an IPv4 address carried inside an IPv6 one (mapped, NAT64, 6to4, Teredo) is judged as the IPv4 address it is. Web video captures are held to the same rule on the address they are given and on each entry's own address; yt-dlp then fetches the media itself. A refused start says an admin can allow private captures; a refused page or file in the middle of a crawl is skipped with a note. **Allow captures of private addresses** in Manage, Creator turns it off for a home server that captures its own network; it is an admin setting and cannot be sent with a capture. `zimi create` on the command line is never restricted.

**Language** is read off the source (a page's `lang`, a folder's HTML, video metadata) and falls back to `eng`; override with `--language` (ISO 639-3). **Output** defaults to the ZIM directory with library registration; `--out` writes an explicit `.zim` path instead. Title and details are set with `--title`, `--description`, `--creator`, `--publisher` and `--tags` (see above).

**Bookmarks as a ZIM.** The Create page's **Bookmarks** tile packages your saved articles into one standalone `.zim` — the articles themselves, with their images and styles carried in, not a list of links. The result opens in any ZIM reader and needs nothing from the library it came from, which makes it the way to hand somebody a reading list that still works on a machine with no internet and no Zimi.

**Subreddits.** `zimi create r/<name>` (or a reddit.com URL) fetches a subreddit's posts and comments through [ArcticZim](https://github.com/IMayBeABitShy/ArcticZim), which Zimi keeps in its own sidecar environment, and builds a ZIM that opens as a source and in the Reddot app (see [apps](apps.md)). `zimi create --setup-reddit` installs the sidecar ahead of time (needs network, about 30 s); without it the first subreddit build installs it. Retrieval runs through the Arctic Shift archive in pages of a few hundred posts; Zimi ends the fetch when the archive starts repeating its last item, which is how Arctic Shift says a subreddit is done. A large subreddit still takes a while: start with a small one. On the Create page there is no subreddit tile: paste the subreddit's reddit.com address under **Web page** and the form becomes a subreddit's (a Subreddit chip lights in the row, the capture engine and crawl limits go away, ArcticZim is named); the preview names the subreddit and the maker's state. The build's progress reads as a sentence: how many posts and comments so far, and how far back.

**From the web UI.** The Create page (the topbar `+`) drives the URL-based modes — single page, `--site`, video, and a subreddit by its address — for admins and creator-role accounts, and packages bookmarks. **Folder** and **Import** read the server's disk, so they are on the page for the primary admin only, and neither takes a typed path. Folder is a tree of the create directory (`ZIMI_CREATE_ROOT`, else the ZIM directory), read one folder at a time as you open it; see [Folders](#folders). Import is a picker over the archives in the same directory, subdirectories included.

## Folders

`zimi create <folder>` packages a folder of files into one ZIM, and the Create page's **Folder** tile does the same from the browser. Each file becomes what it is best at, so a mixed folder makes one ZIM whose apps each find their part:

| Files | Become |
| --- | --- |
| `.html` `.htm` `.xhtml`, `.md` `.markdown`, `.txt` | Pages in the reader. Markdown is rendered; plain text keeps its line breaks. `index.html` (else a README) is the main page; with neither, Zimi writes an index of everything. |
| `.pdf` `.epub` | Documents on the Bookshelf, listed in `zimi-database.js`, and readable in the reader |
| `.png` `.jpg` `.jpeg` `.gif` `.webp` `.svg` `.avif` `.bmp` | Pictures, gathered on a gallery page linked from the index (unless the folder is a site with its own `index.html`, whose pages show them already) |
| `.mp4` `.webm` `.m4v` `.mov` `.mkv` `.ogv`; `.mp3` `.m4a` `.aac` `.ogg` `.oga` `.opus` `.flac` `.wav` | Videos and audio in ZimiTube, listed in `videos.json`. Nothing is transcoded: Safari and iPhones play neither `.mkv` nor `.ogv`, and a `.mov` plays where it holds H.264, so the picker and the build log mark them. |
| Anything else (stylesheets, fonts, scripts) | Carried as is, so a site's pages keep working |

Left out, with the reason in the picker and the log: ZIM files (add them to the library instead), compressed archives (unpack first), office documents (save as PDF first), video formats browsers cannot play (`.avi`, `.wmv`, `.flv`, `.mpg`; convert to MP4), unfinished downloads, programs. Hidden files and folders, system droppings (`Thumbs.db`, `@eaDir`) and symlinks are never read.

**A subset.** `--only <path>...` packages just those files and subfolders (paths inside the folder), walking only what was named: `zimi create ~/Archive --only photos letters/1962.txt`. On the Create page, tick a folder to package all of it, or tick files and subfolders: the folder they share becomes the ZIM's root.

### Describing a folder: sidecars

Metadata lives in small text files beside what it describes. Plain `Key: value` lines, keys in any case, unknown keys ignored; or the same as a JSON object. A sidecar is folded into what it describes and is not packaged itself.

**The folder**, `zimi.txt` (or `zimi.json`) at its top:

```
Title: The Family Attic
Description: Letters, photos and films from the attic
Language: eng
Creator: The Lees
Publisher: Lee Press
Tags: family; photos
Icon: icon.png
```

`Language` is ISO 639-3 (or a two-letter code). `Tags` are separated by `;` or `,` (a JSON list works too). `Icon` names a picture in the folder, scaled to the ZIM's 48x48 illustration (needs Pillow). Anything given on the command line (`--title`, `--description`, `--language`, `--creator`) or typed on the Create page wins over the file.

**A file**, `<name>.txt` or `<name>.json` beside it. `talk.mp4` takes `talk.txt` or `talk.mp4.txt`:

```
Title: Home movie, 1962
Author: Grandpa
Date: 1962-07-04
Description: The garden in summer.
Cover: covers/home-movie.jpg
```

`Cover` is a picture path relative to the file. On the Bookshelf a document shows the sidecar's title, author, date, description and cover; in ZimiTube the author stands where a channel would, and the cover is the poster (a picture with the video's own name, `talk.jpg`, is the poster without a sidecar). A picture's sidecar captions it in the gallery. A text file is only a sidecar when it says at least one of these keys, so a `notes.txt` of prose beside `notes.pdf` stays a page of its own.

### Two pictures

Every capture keeps a picture of the live page as the web served it, and a picture of the same page as this ZIM serves it: full page, both taken after the same ad blocking, consent-wall reveal and scroll, so the only difference between them is what packaging lost. Right-click a card, **About this ZIM**, and they sit side by side. They are stored as metadata beside the illustration (not as entries, so they never count as content), and served at `/w/<zim>/-/shot-live` and `-/shot-zim`.

The rendered and alive engines take them on the page they already have open. The fast engine has no browser of its own, so it takes them on a second, cheap visit when a browser is installed, and simply has none when there is not. When the packaged picture comes out a fraction of the live one's height, the job log says so: something did not survive, usually a stylesheet.

## Configure

| Setting | Where | Default | Effect |
| --- | --- | --- | --- |
| `--engine` | flag | stored default, else `builtin` | `builtin` / `rendered` / `singlefile` / `alive` / `zimit` |
| `ZIMI_BEHAVIORS` | env | unset | Path to a `behaviors.js`. Zimi otherwise looks in npm's global roots; without it the browser engines fall back to a plain scroll |
| `--block-ads` / `--no-block-ads` | flag | on (rendered/alive) | Block ad/tracker/consent requests at capture time |
| `--max-bytes` | flag | 4G (site) / 16G (video) | Total size budget |
| `--max-pages` | flag | 10,000 (site) | Page cap for `--site` |
| `--max-depth` | flag | 10 (site) | Link hops from the start page |
| `--scope` | flag | `prefix` | `prefix` (the start page's section) / `host` / `domain` / `any` |
| `--include` / `--exclude` | flag, repeatable | none | Regular expressions on page addresses: also capture / never capture |
| `--extra-hops` | flag | 0 | Links to follow past the scope (0 to 10) |
| `--delay` | flag | 0.5s (site) | Seconds between requests |
| `--time-limit` | flag | none | Stop crawling after this long (`90m`, `8h`, seconds) and keep what is captured (site) |
| `--sitemap` / `--no-sitemap` | flag | off | Also visit the pages a sitemap lists; bare finds it, or give its address (site) |
| `--user-agent` | flag | Zimi's own | The User-Agent to present (page or site) |
| `--mobile` / `--no-mobile` | flag | off | Present a phone; with a browser engine, a 390 pixel touch screen (page or site) |
| `--page-timeout` | flag | the engine's own | Seconds a browser engine waits on one page (page or site; rendered, alive, zimit) |
| `--description` | flag | generated | The ZIM's description, at most 80 characters |
| `--creator` / `--publisher` | flag | stored default, else `Zimi` | The ZIM's author and publisher |
| `--tags` | flag | none | Tags added to the ZIM's own, `a;b` |
| `--cookies` | flag | none | Cookie header text, sent to each page's own host and subdomains only, never stored (page or site; fast, rendered, alive) |
| `--skip` | flag | none | Kinds to leave out: `video,audio,pdf,archives,images` (page or site; fast, rendered, alive) |
| `--max-file-size` | flag | none | Leave out any one file larger than this, e.g. `50M` (page or site; fast, rendered, alive) |
| `--workers` | flag | zimit's own | Pages zimit fetches at once, 1 to 16 (site, zimit) |
| `--ignore-robots` | flag | off | Crawl robots-disallowed pages (site only) |
| `--format` / `--audio-only` / `--limit` | flag | ~720p cap, H.264 first | Video source selection. H.264 plays in every browser; YouTube's default MP4 is AV1, which iPhones before the 15 Pro cannot decode. |
| `--language` | flag | stored default, else detected, else `eng` | ISO 639-3 content language |
| `--out` | flag | ZIM dir + register | Explicit output path |
| `--only` | flag | the whole folder | Folder only: package just these files and subfolders |
| `ZIMI_CREATE_ROOT` | env / config `create_root` | unset (the ZIM directory) | The directory the Create page's Folder tree and Import picker read from (subdirectories included). Unset, the ZIM directory. It is where you keep what you might make a ZIM from; what you make always goes to the ZIM directory's `created/` folder, so keep the two apart. Nothing outside it is listed or read, Zimi's own data folder is never shown, and no path is ever typed in the browser; the CLI is unaffected. |

## Troubleshoot

**A site you reported.** Every site a user reports goes into `tests/sites/reported.json` and stays there. `python3 scripts/site_suite.py` captures each one, opens it through the reader, compares its two pictures, and exercises the thing that was broken; `ZIMI_SITE_SUITE=1 pytest tests/test_reported_sites.py` runs the same from the suite. If a site you use breaks, the fastest way to keep it working is to add it there with what should happen, and file the issue.

- **`--engine rendered` fails to start / no Chromium** — install the browser extra: `pip install 'zimi[browser]'` then `playwright install chromium`.
- **`--engine alive` errors on conversion** — it needs both the browser extra and the warc2zim sidecar. Run `zimi import --setup` once (network), then `zimi import --status` to confirm.
- **`--engine singlefile` says the CLI is missing** — install Node, then `npm install -g single-file-cli`. It also needs a Chromium; `playwright install chromium` provides one.
- **`--engine zimit` can't run** — it shells out to Docker; ensure Docker is installed and the daemon is running.
- **`--engine-arg` reads as a missing value** — argparse treats a bare flag-shaped token as missing. Write it attached: `--engine-arg=--workers=2`.
- **Crawl stops early / ZIM smaller than expected** — you hit `--max-bytes`, `--max-pages`, or `--max-depth`, or robots.txt disallowed pages. Raise the caps or add `--ignore-robots` (site only) where appropriate.
- **A page renders blank or paywalled** — it may gate on a blocked endpoint. Retry with `--no-block-ads`, or use `--engine rendered`/`alive` so scripts run.
- **No Folder or Import tile on the Create page**: both are for the primary admin only (a creator account never sees them). Put the folder or archive under the create directory (`ZIMI_CREATE_ROOT`, else the ZIM directory) and it appears in the tree or the picker.
- **A file is greyed out in the Folder tree**: it is left out (hover it for why: a ZIM, an archive, an office document, a video format browsers cannot play) or it is a sidecar, folded into the file it describes.
- **The video plays on a laptop but not on an iPhone**: `.mkv` and `.ogv` do not play in Safari, and a `.mov` only does with H.264 inside. Zimi does not transcode; convert to MP4 (H.264) and package again.
- **A subreddit build says the sidecar is missing** — run `zimi create --setup-reddit` once with network access; an air-gapped machine can be seeded the same way before it goes offline.
- **Where is the subreddit option on the Create page?** — there is no tile. Paste the subreddit's address (`https://www.reddit.com/r/<name>`) under Web page; the preview turns into a subreddit's.

---

## Importing a web archive

Convert a WARC or WACZ web archive into a library ZIM.

### How it works

`zimi import <file>` converts a `.warc`, `.warc.gz`, or `.wacz` archive into a ZIM and registers it in the library (or writes an explicit path with `--out`). The conversion runs through **warc2zim**, which Zimi keeps in a dedicated sidecar virtual environment rather than the main install — warc2zim pulls in heavier dependencies (and libmagic) that most users never need. The sidecar is provisioned on demand.

`zimi import --setup` installs the sidecar venv now (needs network) so an air-gapped machine can be pre-seeded before it goes offline. `zimi import --status` reports the sidecar's state and version. Name and metadata come from `--name` / `--title` / `--description`, with the name derived from the filename by default.

Import reads a file on the server's disk, so it stays with the **primary admin**: at a shell with `zimi import <file>`, or on the Create page as a picker over the archives in the import directory (`ZIMI_CREATE_ROOT`, else the ZIM directory, subdirectories included). No path is ever typed into the browser. The Docker image ships the sidecar prerequisites (Python 3.14 + libmagic) so import works there out of the box.

### Configure

| Setting | Where | Effect |
| --- | --- | --- |
| `file` | positional | The `.warc` / `.warc.gz` / `.wacz` to convert |
| `--name` | flag | ZIM short name (default: derived from filename) |
| `--title` / `--description` | flag | ZIM metadata |
| `--out` | flag | Explicit output `.zim` path (default: ZIM dir + register) |
| `--setup` | flag | Install the warc2zim sidecar venv now (network) |
| `--status` | flag | Report sidecar state and version |

### Troubleshoot

- **"sidecar not installed" / conversion won't start** — run `zimi import --setup` once with network access, then `zimi import --status` to confirm the venv and version.
- **Preparing an offline machine** — run `zimi import --setup` while it still has internet; the sidecar then works air-gapped.
- **libmagic errors on a bare install** — the sidecar needs libmagic on the host. The Docker image already includes it; on a manual install, install your platform's libmagic package.
- **Looking for an import button in the web UI** — it is the **Import** tile on the Create page, shown to the primary admin only, and it lists the archives in the import directory rather than taking a path. Drop the file there (or set `ZIMI_CREATE_ROOT` to where your archives live) and reload.
- **Related** — the `--engine alive` capture path in [Creating ZIMs](making-zims.md) uses the same warc2zim sidecar, so `--setup` provisions both.
