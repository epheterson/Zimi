# Creating ZIMs

Turn a folder, a web page, a whole small site, or a video source into a ZIM that lives in your library and works forever offline.

## How it works

`zimi create` is one command with several input shapes. The positional `source` is either a folder path or one or more `http(s)://` URLs (several URLs land in a single ZIM behind a generated index page). Add `--site` to crawl one origin instead of capturing a single page; pass a video URL to package a playlist or channel via yt-dlp.

Web captures run through one of four **engines**, chosen with `--engine`:

- **builtin** (default) — no JavaScript, no install. Fetches HTML and assets directly. Fastest, smallest, and the only engine with zero dependencies.
- **rendered** — runs a headless Chromium in-process so client-rendered pages produce real content. Needs `pip install 'zimi[browser]'` and `playwright install chromium`.
- **alive** — records the live browser session to a WARC and converts it with warc2zim, so the saved site's JavaScript still runs inside the reader. Needs the browser extra above plus the warc2zim sidecar (`zimi import --setup`).
- **singlefile** — hands the page to [SingleFile](https://github.com/gildas-lormeau/SingleFile), the reference implementation of "save this page as one file". It drives a browser, waits for the page to finish, and inlines every image, stylesheet and font as a data URI. The result is a single self-contained entry that **cannot** break: there is nothing to lazy-load and no reference that can fail to resolve, so it is the only engine whose images survive a scroll on every site tested. Costs about a third in size (base64) and stores one entry rather than a browsable tree. Needs Node and `npm install -g single-file-cli`, plus a Chromium.
- **zimit** — openZIM's browser-based crawler (browsertrix), run via Docker. Now available for a single page as well as a `--site` crawl, and offered in the web UI wherever Zimi can reach a Docker daemon. Extra crawler arguments pass through with `--engine-arg` (write it attached, e.g. `--engine-arg=--workers=2`).

**What each engine trades.** They are not better and worse, they are three bargains. Measured on one CNN front page, iPhone width, served offline with the network sealed:

| Engine | Assets kept | Images that render | What it is for |
| --- | --- | --- | --- |
| builtin (fast) | ~380 | all, arriving as you scroll | Biggest archive, correct at any screen width, keeps lazy-loading |
| rendered | ~95 | all | Smallest archive and exact: each `srcset` collapses to the one image the browser chose, so nothing can re-pick a size the archive lacks |
| alive | ~315 | fewer on image-heavy sites | The page's own JavaScript still runs — faithful to behaviour, at the cost of image coverage on sites that lazy-load aggressively |

A capture is also **refused rather than packaged** when the site does not return a web page at all. Some sites answer an automated browser with HTTP 200 and a few bytes of error text; the rendered and alive engines check what the browser actually received and fail with the reason instead of writing an archive of an error message.

**Resource hints are dropped.** `<link rel="preload">` and friends are advice to a live browser about what to fetch early. In an archive they are requests for addresses that do not exist, so all of them — `preload`, `modulepreload`, `prefetch`, `preconnect`, `dns-prefetch` — are removed. The files themselves are still carried through the stylesheets and markup that actually use them.

**Making a page reveal itself.** The browser engines (rendered, alive, zimit) drive the page before serialising it, because a modern site holds most of its content back until something asks. Zimi's own pass is a scroll. When [browsertrix-behaviors](https://github.com/webrecorder/browsertrix-behaviors) is installed (`npm install -g browsertrix-behaviors`, or point `ZIMI_BEHAVIORS` at a `behaviors.js`), Zimi runs Webrecorder's catalogue first — per-site scripts for the sites people archive most, plus a better generic autoscroll — and then still runs its own scroll, because adopting somebody else's coverage should never subtract from your own. Zimi does not ship the bundle: it is AGPL, so it is used when present and never distributed. Without it every engine works exactly as before.

**Capture defaults.** Ad, tracker, and consent-manager requests are blocked during capture by default (`--block-ads`, on for the rendered and alive engines) — smaller ZIMs, and pages that gate on those endpoints render their real content. `--no-block-ads` captures everything. The blocklist snapshot ships in `zimi/assets/blocklist-snapshot.txt.gz` (StevenBlack/hosts, MIT) and is not auto-refreshed. Image-variant capture is a Manage/Creator toggle (`capture_variants`) and a `create` internal option.

**Size budget.** `--max-bytes` caps output (e.g. `512MiB`, `4G`). For `--site` it counts pages plus assets (default 512MiB); for video sources it caps total media (default 4G). Crawls are also bounded by `--max-pages` (site default 200), `--max-depth` (site default 5), and `--delay` between requests (site default 0.5s; robots.txt `Crawl-delay` wins when larger). `--ignore-robots` (site only) crawls disallowed pages and prints a warning.

**Language** is read off the source (a page's `lang`, a folder's HTML, video metadata) and falls back to `eng`; override with `--language` (ISO 639-3). **Output** defaults to the ZIM directory with library registration; `--out` writes an explicit `.zim` path instead. Title/description/creator metadata is set with `--title` / `--description` / `--creator` (creator defaults to `Zimi`).

**Bookmarks as a ZIM.** The Create page's **Bookmarks** tile packages your saved articles into one standalone `.zim` — the articles themselves, with their images and styles carried in, not a list of links. The result opens in any ZIM reader and needs nothing from the library it came from, which makes it the way to hand somebody a reading list that still works on a machine with no internet and no Zimi.

**From the web UI.** The Create page (the topbar `+`) drives the URL-based modes — single page, `--site`, video — for admins and creator-role accounts. **Folder mode and web-archive import are CLI-only.** The web UI has no folder tile and no import tile: folder mode is refused from the web entirely, and import reads a server path, which stays a primary-admin, shell-only operation. Run `zimi create <folder>` / `zimi import <file>` from a terminal on the machine.

## Configure

| Setting | Where | Default | Effect |
| --- | --- | --- | --- |
| `--engine` | flag | `builtin` | `builtin` / `rendered` / `singlefile` / `alive` / `zimit` |
| `ZIMI_BEHAVIORS` | env | unset | Path to a `behaviors.js`. Zimi otherwise looks in npm's global roots; without it the browser engines fall back to a plain scroll |
| `--block-ads` / `--no-block-ads` | flag | on (rendered/alive) | Block ad/tracker/consent requests at capture time |
| `--max-bytes` | flag | 512MiB (site) / 4G (video) | Total size budget |
| `--max-pages` | flag | 200 (site) | Page cap for `--site` |
| `--max-depth` | flag | 5 (site) | Link hops from the start page |
| `--delay` | flag | 0.5s (site) | Seconds between requests |
| `--ignore-robots` | flag | off | Crawl robots-disallowed pages (site only) |
| `--format` / `--audio-only` / `--limit` | flag | ~720p cap | Video source selection |
| `--language` | flag | detected → `eng` | ISO 639-3 content language |
| `--out` | flag | ZIM dir + register | Explicit output path |
| `ZIMI_CREATE_ROOT` | env / config `create_root` | unset (web off) | The one directory tree the web UI may package a server path from. Unset means the web cannot read any server path; the CLI is unaffected. |

## Troubleshoot

- **`--engine rendered` fails to start / no Chromium** — install the browser extra: `pip install 'zimi[browser]'` then `playwright install chromium`.
- **`--engine alive` errors on conversion** — it needs both the browser extra and the warc2zim sidecar. Run `zimi import --setup` once (network), then `zimi import --status` to confirm.
- **`--engine singlefile` says the CLI is missing** — install Node, then `npm install -g single-file-cli`. It also needs a Chromium; `playwright install chromium` provides one.
- **`--engine zimit` can't run** — it shells out to Docker; ensure Docker is installed and the daemon is running.
- **`--engine-arg` reads as a missing value** — argparse treats a bare flag-shaped token as missing. Write it attached: `--engine-arg=--workers=2`.
- **Crawl stops early / ZIM smaller than expected** — you hit `--max-bytes`, `--max-pages`, or `--max-depth`, or robots.txt disallowed pages. Raise the caps or add `--ignore-robots` (site only) where appropriate.
- **A page renders blank or paywalled** — it may gate on a blocked endpoint. Retry with `--no-block-ads`, or use `--engine rendered`/`alive` so scripts run.
- **Web UI has no folder or import option** — by design. These are CLI-only: `zimi create <folder>` and `zimi import <file>`.

---

## Importing a web archive

Convert a WARC or WACZ web archive into a library ZIM.

### How it works

`zimi import <file>` converts a `.warc`, `.warc.gz`, or `.wacz` archive into a ZIM and registers it in the library (or writes an explicit path with `--out`). The conversion runs through **warc2zim**, which Zimi keeps in a dedicated sidecar virtual environment rather than the main install — warc2zim pulls in heavier dependencies (and libmagic) that most users never need. The sidecar is provisioned on demand.

`zimi import --setup` installs the sidecar venv now (needs network) so an air-gapped machine can be pre-seeded before it goes offline. `zimi import --status` reports the sidecar's state and version. Name and metadata come from `--name` / `--title` / `--description`, with the name derived from the filename by default.

Import is **CLI-only**. It reads a path on the server's disk — a read-the-server's-disk primitive — so it is deliberately not exposed in the web UI and stays with the primary admin at a shell on the machine. The Docker image ships the sidecar prerequisites (Python 3.14 + libmagic) so import works there out of the box.

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
- **Looking for an import button in the web UI** — there isn't one by design. Run `zimi import <file>` from a shell on the server; it's a primary-admin, server-disk operation.
- **Related** — the `--engine alive` capture path in [Creating ZIMs](making-zims.md) uses the same warc2zim sidecar, so `--setup` provisions both.
