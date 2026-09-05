# Where 1.9 stands — 2026-08-25, end of day

Written to survive a context compaction. Everything a fresh session needs to pick this up without re-deriving it.

## The one-line state

1.9 is **green and deployed**, and the only open question is whether ZIM creation ships in it. That question is now answerable, because the thing that made creation feel broken was found tonight and it is small.

## Hard facts, all verified today

| | |
|---|---|
| Branch | `v1.9`, HEAD `460493f`, clean tree, nothing unpushed |
| Commits today | 12 |
| Local suite | **2474 passed, 9 skipped** — and `pytest tests/` now runs the `.cjs` tests too |
| CI | **green, both jobs**, first time the whole suite has ever run there (2438 passed / 45 skipped on Linux) |
| Docker publish | green; `epheterson/zimi:dev` published from the branch push (by design — `latest` is gated on main) |
| Prod | knowledge.zosia.io on today's code, asset `zimi-v1.9.0-626641f9`, create slot free |
| Capture verified on prod | CNN via Fast: **904 entries** (the pre-fix capture got 471), 19/19 images, 0 offsite requests. SingleFile on apple.com: 32/32 images, survives scroll, 1.8 MB |

## THE DECISION ON THE TABLE

Eric's position, verbatim, 2026-08-25 22:25:

> "We would have to remove it fully. I'm not cool with fewer options. I'd want more and more and can't ship this. Maybe we can or can't we"

He rejected the middle path (ship page mode, hide site mode). It is all of creation or none of it.

Earlier, 22:08:

> "What is the release without it because honestly I shoved it in. Maybe we can bring in user csv import or something and flesh out industry release doesn't have to be creator release. Bummer I wanted it but we suck I guess"

### What 1.9 is without creation

46 feature commits on the branch. **22 are creation. 24 are not**, and the 24 are precisely what 1.9 was scoped to be:

`zimi backup` / `zimi restore` · a config file + `zimi config` showing where every value came from · Prometheus `/metrics` · deployment manifests for a host and a cluster · Cloudflare Access SSO verified for real · update channels + update delay + sneakernet bundle · `ZIMI_OFFLINE` killing all outbound traffic · read-only media boots clean · a folder of ZIMs beside the binary just works · a folder in the ZIM dir is a category · `--zim-dir/--data-dir/--host` · Manage knows when a new Zimi exists and how *you* should install it · exported bookmark ZIMs travel · one activity stream that knows who did what · staleness made impossible.

`docs/plans/2026-08-07-v19-plan.md` states the thesis in Eric's words — "a grown up professional app that fits into any setting, a USB drive standalone in a bunker … up to a deployed maintained secure system used by millions. And the dude with a NAS. Ready, for anyone" — and the standing decision **"Ops and packaging before identity."**

The creation scoping doc is dated **2026-08-10, three days later**. Creation is provably the late addition. Cutting it returns 1.9 to its designed shape rather than leaving a hole.

### Recommendation on record

Fix the three things below tonight/next session, Eric re-tests with fresh eyes, tag with creation in. NOT tag-tonight — two hours of work puts a re-test at 1:30am, which is not a plan.

## THE ROOT CAUSE FOUND TONIGHT (most perishable knowledge here)

Eric's apple.com site capture appeared to hang forever. Watched the whole thing on prod. **It is not apple.com, and not browsertrix-behaviors.**

The note `used browsertrix-behaviors to reveal the page` is emitted *after* `_lazy_scroll` returns, so behaviors and the scroll had both completed. What runs next is the variant sweep:

```
ALIVE_MAX_VARIANTS    = 240      per page      (renderer.py:243)
ALIVE_VARIANT_TIMEOUT = 20.0s    per fetch     (renderer.py:247)
progress emitted during the sweep: NONE — only at the cap, or at the end
```

**240 × 20s = 80 minutes of total silence.** Apple's CDN throttles a headless client, the fetches hang, the sweep sits mute. Nobody chose 80 minutes; it is just the two constants multiplied.

The watchdog watches `job.progressed`. The sweep never updates it, so the watchdog correctly concludes "dead" at `CREATE_STALL_SECONDS = 600`, asks for cancel and kills the browsers — and then the worker thread's own error **overwrites the watchdog's careful explanation**. What the user is left with:

```
cannot read https://apple.com after rendering it: Page.evaluate:
Target page, context or browser has been closed
```

instead of "no progress for 10 minutes — giving up on this job. Whatever it was waiting for never answered."

Measured while wedged: container CPU **0.60%**, memory 2.24 of 4 GiB, server responsive throughout. Blocked, not slow. Watchdog fired at 615.4s exactly as designed.

CNN works because its variants answer fast. This is also the root of #63 (counters roll in bursts).

### The three fixes (~2 hours)

1. **The sweep reports as it goes** — a counter instead of a void, which also feeds `job.progressed` so the watchdog stops mistaking work for death.
2. **A total time budget on the sweep**, not just per-item.
3. **The watchdog's message wins** — a stalled job's error text must not be replaced by the collateral error from the browser it just killed.

## Open tasks, grouped by what they block

**Blocks the creation decision** — #77 (wedge/silence/message, cause above), #78 (another job's completion screen bled into Eric's mid-run), #79 (recents + running job not on first paint), #80 (favicon 404 cached in the non-private browser; the `401` on `apple-touch-icon-precomposed.png` in the session log is a lead), #81 (mode caption off-centre under the title).

**Blocks nothing, Eric's call on timing** — #82 (file-breakdown bar in About-this-ZIM for *all* ZIMs, not just created ones; cost driver is that an arbitrary 90 GB ZIM has no creation record, so it means walking entries under the global libzim lock — cache it or sample it, do not stall a big library).

**#42 — decided tonight, not yet done.** The engine copy says "Wants ~1 GB free memory" and nothing measures memory. Eric: *"that wants text is a lil off … we should really understand the system capabilities not add that line."* **The call: delete the line for 1.9 rather than ship a claim we do not check.** Real capability detection is 1.9.1.

**On ship** — #4 (post held issue replies #48/#49/#50/#51), #46 (GHSA-5mw2 advisory, deliberately post-tag, needs Eric's go).

**Deferred, unchanged** — #13, #22, #30, #34, #40, #41, #51, #56, #63, #70, #71.

**#20 is the tag gate** and is partially done: Eric ran the flow tonight and it produced this list. It is not passed.

## Owed by Eric

- **Rotate the API token.** `0tOx…` was pasted into this session and has been in shell history all day.
- Decide creation in-or-out for 1.9.
- The zimscraperlib srcset patch is drafted and waiting on his read before it goes upstream (post-ship, not blocking).

## Today's bug haul, for context on why this took a day

All found by making instruments honest, in this order:

1. `deploy.sh` piped its build through `tail -3`, so a failed build reported success and left the old image running. Also took prod DOWN for the whole `--no-cache` build because it ran `down` first — now builds first, and checks the container is actually running before saying "deployed".
2. `pytest --timeout=600` with pytest-timeout absent is an argument error, and pytest **exits 0** on it. A suite that never ran looked green.
3. CI ran **305 of 2469** tests; `desktop-release.yml` — the release gate — ran `python tests/test_unit.py`, which has no `unittest.main()` and executed **zero** of its 245 tests while exiting 0. Both now run `pytest tests/`, pinned by `tests/test_ci_contract.py`.
4. Asking for the `zimit` engine silently ran the **alive** engine — one tuple was doing two jobs. Split into `CAPTURE_ENGINES` (constructible) and `OFFERED_ENGINES` (askable).
5. browsertrix-behaviors' `autofetch` walked past Zimi's variant ceiling; the setting reported a bound it did not hold.
6. Six regexes could not see `<link rel=stylesheet href=/a.css>` (legal HTML5), and `\bsrc` matched inside `data-src` so lazy-loading pages handed back the placeholder. One `attr_re` builder now. **This is what took CNN from 471 to 904 entries.**
7. Then that refactor shipped its own regression — a page-derived value re-emitted between double quotes broke `<img src='a"b.png'>`. Fixed with `attr_quote`.
8. `pip install zimi[mcp]` resolved to mcp 2.x, which dropped FastMCP, so the MCP server refused to start. `requirements.txt` had the `<2.0` pin with a comment naming issue #52; `pyproject.toml` did not — and pyproject is what PyPI users get. **Exactly the path the inbound Open WebUI user takes.**
9. `docker compose up` crash-looped on a clean clone: bind-mounted `./zimi-config` is created root-owned, image runs as uid 1000, and 1.9 correctly refuses an unwritable explicit `ZIMI_DATA_DIR`. Now a named volume.
10. PyMuPDF's `fitz` alias **prints a deprecation warning to stdout**, corrupting the MCP JSON-RPC handshake and `zimi config` output. Both surfaced as "JSON decode error". Importing `pymupdf` fixes pollution and deprecation together.
11. Two `.cjs` tests broken all day because `pytest` does not collect them and every local run was `pytest tests/`. Now run from pytest.

## The pattern worth carrying forward

Nearly every bug above is the same shape: **a thing that reports success or a bound without checking it.** A pipe that returns tail's exit code. A test runner that exits 0 on a usage error. A gate that runs two files. A release step that imports a module and calls it a test run. A ceiling a subcontractor walks past. A sweep with limits that never says where it is inside them — which fooled our own watchdog, not just the user.

Fixing the instrument is what found the bugs. The Docker crash-loop was invisible until the wait loop was made to print what actually happened; it had been failing as a `JSONDecodeError` about an empty body.

One correction on the record: I reported a "70-second Back" in the reader as a finding. It was my instrument — `waitUntil:'load'` waiting on the captured page's videos, plus a fixed 6s settle, with runs disagreeing 12.7s vs 70.7s. Re-measured against first-painted-image: cold ~3.1s, back 0.9–3.3s. There is no bug. #62 closed. A measurement whose runs disagree 5× is not a measurement.
