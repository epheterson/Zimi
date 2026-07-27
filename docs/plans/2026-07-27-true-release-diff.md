# The TRUE 1.7.4 → 1.8.0 release diff

Baseline: tag `v1.7.4` (last shipped). Head: branch `v1.8` (`f6a42c8`).
Scope: `git log v1.7.4..HEAD` = **270 commits**; `git diff v1.7.4...HEAD --stat`
= 137 files, +26,881 / −3,544.

This document exists because the maintainer's trust in our release notes broke:
the notes led with the almanac (an easter egg he doesn't even like mentioning),
named features he thought we didn't have (per-user filtering, word lookup), and
under-sold the community work that is the actual point of the release. So every
line below is traceable to a commit and, where it's a user-facing surface, to a
file:line entry point and a verification level:

- **LIVE-TESTED** — I drove it in a browser/curl this session and saw it work.
- **UI-ENTRY-VERIFIED** — I confirmed the entry point exists in code and is
  wired to a reachable control, but did not exercise the full runtime path.
- **CODE-ONLY** — present and correct in code; not exercised this session.

## Live-test results for the two disputed features

The maintainer specifically said we were "mentioning ones we DO NOT have like
per-user filtering and selecting a word to get the definition." **Both exist and
both work.** They are invisible, not absent. Evidence:

### Word lookup — LIVE-TESTED on http://knowledge.zosia.lan (real library)
1. Opened `wikipedia/A/Water` in the reader.
2. Double-clicked the word "Water" in a paragraph.
3. A **Define** popover appeared (`.define-trigger`, label "Define").
4. Clicked it → a `.define-card` rendered the real definition pulled from the
   installed English Wiktionary: **"(in most dialects, including Low Prussian)
   water (H₂O)"**, tagged `en`, with an "Open full" link.
5. Turned Reader View **on** and repeated — the Define trigger appeared again.
   So it works in the raw reader **and** Reader View.

The gesture is undiscoverable by design: there is no button. You must
**double-tap or select a word** inside an article, and a Wiktionary ZIM must be
installed (the NAS has `wiktionary`, `wiktionary_en_simple`). With no Wiktionary
installed the feature is dormant with zero UI (`app.js:11818-11819`). Entry:
`app.js:11831` (dblclick handler) → `_defineConsider` → `_defineShowTrigger`
(`app.js:11712`) → `_defineRun` (`app.js:11721`).

### Multi-user allowlists — LIVE-TESTED on a local server (HEAD code, isolated)
Ran an isolated server (`ZIM_DIR` with 3 ZIMs, throwaway `ZIMI_DATA_DIR`, never
touched production users):
1. Created a **Limited** user `kid` with `allowlist=["zimgit-water"]` via
   `POST /manage/users`.
2. Logged in as `kid` → `role:user, restricted:true, allowlist:["zimgit-water"]`.
3. `GET /list` **as anon** → all 3 ZIMs. `GET /list` **as kid** → only
   `zimgit-water`. Search as `kid` never surfaced the other two ZIMs.
4. In the admin UI, opened each user's ⋯ menu:
   - `kid` (role=limited) → menu shows **Set password / Change role / Edit
     allowlist / Delete**.
   - `grownup` (role=user) → menu shows **Set password / Change role / Delete**
     — **no** Edit allowlist.

That is exactly why the maintainer never saw it: **"Edit allowlist" only exists
inside a user's ⋯ menu, and only after that user's role is already `limited`**
(`app.js:6655`). A fresh account defaults to role=user, so the option is hidden
until you first switch the account to Limited. The filtering itself is
server-side and real (`users.py` allowlist → filtered `/list`, `/search`,
`/suggest`, `/random`, `/chunks`, almanac-links). Reach: sign in as admin →
Manage → ⋯ menu (top-right of the manage view) → **Users** → a user's ⋯ →
**Change role → Limited** → the same ⋯ → **Edit allowlist**.

**Neither feature is cut. Both stay — with the exact gesture spelled out in
prose** (Deliverable 3 note: nothing was cut for being unreachable; see the
did-you-mean caveat below, which is a coverage limitation, not a false claim).

---

## 1. Community asks & bug reports — THE STORY

Every item here answers a filed issue or a known ecosystem request.

| Change | How a user reaches it | Verify | Origin |
|---|---|---|---|
| **"New" / "Updated" badges** on recently installed/updated ZIMs; clear on open with a 7-day backstop | Home library tiles/rows show the badge automatically (`app.js:e973de6`, `51aac9e`) | UI-ENTRY | **#34** "Newly installed ZIMs need a New tag" |
| **Recently added / Recently updated filter pills** (30-day window) on the home library | Pills on the home library header; collapse into a filter dropdown on small screens (`app.js:252`, `5aa4006`) | UI-ENTRY | **#34** |
| **Honest first-seen stamps** so a date-renamed ZIM update reads "Updated", not "New"; self-heals a mass-badge on rebuild | Automatic (`4949e7d`, `285e616`, `f667ee7`) | CODE-ONLY | **#34** |
| **Custom categories — move any ZIM to another category** (incl. brand-new ones) | Right-click a ZIM, or its ⋯ gear on the Manage/Installed row → "Move to…" (`b46fe52`, `dd8a7e4`) | UI-ENTRY | **#37** "Custom sections and re-arrange library" |
| **Reorder home sections** (categories + collections) via a drag Reorder panel | Manage → preferences → Reorder panel; deep-linked from a card menu (`app.js:1508`, `ee04451`, `7ce47ba`) | UI-ENTRY | **#37** |
| **Management no longer password-locks Tailscale/CGNAT clients** — 100.64.0.0/10 counts as private-tier | Reach Manage over a tailnet with no password set; it no longer forces a password prompt (`http.py:70`, `a4629dd`) | CODE-ONLY | **#36** "Settings are password locked" |
| **LAN-only lock vs password prompt distinguished**; initial password setup is LAN-gated | Manage on a fresh install over LAN vs WAN (`d2055a5`, `53c41bd`) | CODE-ONLY | **#36** |
| **`#fragment` links resolve** in single-page docs (devdocs) instead of 404ing | Open a devdocs article and click an in-page anchor link (`search.py:1872`, `e70acfb`) | CODE-ONLY | **#38** "Keep getting not found errors" |
| **Stray `.zim.torrent` files no longer look like broken ZIMs**; migrated out of the ZIM dir at startup, flagged in health | Automatic at startup (`server.py:365 _migrate_stray_torrent_files`); health report flags any left (`health.py:65`, `b80d2e5`, `2ed5c2d`) | CODE-ONLY | **#38** |
| **Country-specific holidays get their own colour**, distinct from worldwide observances; holidays project onto any calendar system | Almanac → calendar; holidays coloured by scope (`d9eb702`, `4ef00de`) | CODE-ONLY | **#33** "unique colour to country specific calendar dates" (CLOSED) |
| **"Did you mean?" offline spelling correction** on weak searches, built from your own library's title vocabulary | Type a misspelling that returns few/no results; a clickable correction line appears (`search.py:1142`, `app.js` DYM link) | LIVE-TESTED (see caveat) | **libzim#731** (offline spell-check, long-standing ecosystem ask) |
| **Read-aloud (TTS)** in the reader, fully offline via the browser's speech engine | Reader toolbar speak/stop control; hides where the API is absent (`app.js:9408 _ttsSpeak`, `9427 _ttsToggle`) | UI-ENTRY | **kiwix-js#166** (read-aloud, ecosystem ask) |

**did-you-mean caveat (Deliverable 3, honest):** on the current NAS deploy the
`did_you_mean` field returned `null` for every misspelling I tried (`einstien`,
`watre`, `phlosophy`, `pyhton`, `photosynthisis`, `relativty`), including
zero-result queries. This is **not** a false claim — the correction only fires
when the correct word is present in the vocabulary built from the installed
**title indexes**, and the huge English Wikipedia's titles may sit above the
FTS-index threshold (`search.py:468`) so the correction word never enters the
vocab. This is precisely the coverage limitation already documented for v1.8.1
in the scoping doc ("saturates on ~3/66 index files; spread-out science words
get evicted"). The **logic** is proven by the unit suite; **coverage on a big
Wikipedia is thin**. Release-note language should stay hedged ("on weak
searches, built from your own library's vocabulary") and must NOT promise
specific corrections like "einstien → einstein".

Also in this bucket, less directly issue-numbered but community/field-driven:
- **Recent-search chips** on the home view (`3ccc55f`) — bring back your last
  searches with one tap.
- **Clear (×) affordance** in the search box (`03c281e`).

## 2. Downloads & sharing

| Change | How a user reaches it | Verify | Origin |
|---|---|---|---|
| **Resumable downloads** — quit mid-download, it resumes; partials protected by download state, not file age | Automatic on any interrupted download (`21ba9f7`, `e2932e1`) | CODE-ONLY | field-QA (relates to **#30** downloads clearing) |
| **Delta ZIM updates over BitTorrent** — an update reuses unchanged pieces of the old file instead of re-fetching gigabytes | Update a ZIM that has a torrent; the download shows bytes reused (`library.py`, `065ac62`) | CODE-ONLY | internal |
| **Download-this-ZIM buttons** on the source header and every Manage row, gated by a capability probe | Source header + Manage rows (`fca4d0a`, `876b01f`) — only where the raw `/dl/` file can be pulled | UI-ENTRY | internal (peer-sharing) |
| **Switch a stuck BitTorrent transfer to direct HTTP** | Per-download "switch to direct" button in Manage (`manage.py:1139 /manage/switch-direct`, `033f353`) | CODE-ONLY | internal |
| **Seeding goals** — each seed card shows uploaded-vs-goal with a progress bar; survives restarts | Seeding panel (`00d6c19`/`00285e9`) | UI-ENTRY | internal |
| **Pull LAN peer ZIMs over Tailscale/CGNAT peers** | Automatic on a tailnet (`e9fa9bf`) | CODE-ONLY | **#36**-adjacent |

## 3. Reader & search

| Change | How a user reaches it | Verify | Origin |
|---|---|---|---|
| **Reader View** — Safari-Reader-style clean column; strips ZIM chrome, wraps wide tables, dark by default | Reader ⋯ menu → Reader View (`app.js:9880 _readerViewToggle`, entry `10118`) | LIVE-TESTED (toggled on NAS) | internal |
| **Reader settings palette** — Dark/Light/Sepia themes, serif/sans, A−/A+ (85–130%), and an AUTO mode | Reader ⋯ menu → settings palette (`2c3c74d`, `7135fb8`) | UI-ENTRY | internal |
| **Word lookup (Define)** | Double-tap/select a word in an article (needs a Wiktionary ZIM) (`app.js:11831`) | **LIVE-TESTED** | (see §1 / libzim ecosystem) |
| **Read-aloud (TTS)** | Reader toolbar (`app.js:9427`) | UI-ENTRY | **kiwix-js#166** |
| **Tap-to-zoom images** — a scaled image opens full-size in a lightbox | Tap an article image; Esc/tap-out closes (`2780c88`) | CODE-ONLY | internal |
| **Print / Save as PDF / Share** row in the Reader palette | Reader palette (Reader View on); Share via `navigator.share` where supported (`app.js:10102`, `9b93147`) | UI-ENTRY | internal |
| **"Did you mean?"** clickable correction line | Sparse search results (`app.js`, `bb19cc0`) | LIVE-TESTED (caveat §1) | **libzim#731** |
| **Language badges on search-result source pills** — same-titled Wikipedias disambiguated by language code | Search across multilingual library (`aaa97b3`) | UI-ENTRY | field-QA |
| **Real article count** on cards — libzim `article_count`, not raw entry count | Home tiles/rows (`712f932`, `fca4d0a`) | UI-ENTRY | internal |

## 4. Library & management

| Change | How a user reaches it | Verify | Origin |
|---|---|---|---|
| **Compact tile view** for the home library, with a per-section view toggle | Home library view toggle (`b3f4d9c`, `89903cd`) | UI-ENTRY | internal |
| **Language pills** filter a multilingual library on home + category sections | Home/category pill rows (`3ccc55f`, `adc2441`) | UI-ENTRY | field-QA |
| **Library health report** — per-ZIM ✓/⚠ table (main page, count, index status, size vs catalog, age) | Manage → library → integrity check (`health.py`, `9518ab3`, `d698f3d`) | UI-ENTRY | internal |
| **Save your bookmarks to a ZIM** — export bookmarks to a standalone `.zim` any reader can open | Bookmarks panel → Save to ZIM button (`app.js:10798 exportBookmarksToZim`, `zimwriter.py`, `2405374`) | UI-ENTRY | internal |
| **Storage/caches breakdown** in Manage — data dir by category + top per-ZIM contributors, no library scan | Manage settings caches bar (`manage.py:321 _cache_info_payload`, `033f353`) | CODE-ONLY | internal (**#6**-adjacent, cache separation) |
| **Catalog renders instantly** (stale-while-revalidate) and reuses the feed for the session | Open Catalog (`8f695ca`) | UI-ENTRY | internal |
| **Update check is fast again** — concurrent OPDS page fetches vs one-at-a-time (~16s → instant on warm cache) | Manage → check for updates (`bb4e699`, `fcf11b9`) | CODE-ONLY | field-QA (3,600+ catalog entries) |
| **One pill geometry everywhere** + an "All" reset pill on every filter row | Search/home/manage filter rows (`bdc2c1a`) | UI-ENTRY | internal |
| **Collections split out** in the reorder/installed rows | Manage reorder + installed list (`ee04451`, `7ce47ba`) | UI-ENTRY | **#37** |

## 5. Multi-user

| Change | How a user reaches it | Verify | Origin |
|---|---|---|---|
| **Named user accounts** on top of the password admin — sign in/out, admin Users pane | Sign-in modal; Manage → ⋯ → Users (`users.py`, `0853b31`, `694115f`) | LIVE-TESTED | internal (community: household/classroom) |
| **Per-user ZIM allowlists (Limited role)** filter the whole read surface | Users pane → user ⋯ → Change role → Limited → **Edit allowlist** (`app.js:6655`, `users.py`) | **LIVE-TESTED** | internal |
| **Roles: admin / user / limited** + in-memory migration of legacy records | Users pane role picker (`48620c1`, `02addd6`) | LIVE-TESTED | internal |
| **Secondary-admin login** + primary-only hierarchy (only primary manages admins) | Sign in as a role=admin account (`da3e89f`, `29b27b5`) | CODE-ONLY | internal |
| **Optional management username** as a case-insensitive second factor; login prefills `admin` | Sign-in modal (`1a76512`, `5916efd`) | UI-ENTRY | internal |
| **Last-login shown**; admin password-reset for a user | Users pane (`8e9bffa`) | CODE-ONLY | internal |
| **Your Account panel** — Change password / Log out; solo admin sees no user list | Manage → ⋯ → Users (`4393550`, `0f5e357`) | UI-ENTRY | internal |
| **Search cache keyed by allowlist identity** — one user's results can't surface another's restricted ZIMs | Automatic (`ab8ef79`) | LIVE-TESTED (no leak observed) | internal (security) |

## 6. Agent / API

| Change | How reached | Verify | Origin |
|---|---|---|---|
| **`GET /chunks`** — deterministic, embedding-free RAG chunking with stable content-addressed IDs | `curl /chunks?zim=…&path=…` (`http.py:760`, `search.py chunk_article`, `76e6435`) | **LIVE-TESTED** (228 chunks, stable IDs, NAS) | internal (v1.8 RAG vision) |
| **MCP `get_chunks` tool** wrapping the same logic | MCP client (`mcp_server.py`, `609631b`) | CODE-ONLY | internal |
| **`GET /openapi.json`** — hand-authored OpenAPI 3.1 of the read API; `info.version` tracks the server | `curl /openapi.json` (`http.py:1022`, `openapi.py`, `111bcce`) | **LIVE-TESTED** (3.1.0, v1.8.0, NAS) | internal |
| **`docs/api-stability.md`** + agent-cycle benchmark | Repo docs (`5761be3`, `97fd31c`) | CODE-ONLY | internal |
| **did-you-mean passed through MCP search** | MCP search tool (`8797e9c`) | CODE-ONLY | libzim#731 |

## 7. Platform

| Change | How reached | Verify | Origin |
|---|---|---|---|
| **Native Windows portable build** (`Zimi-windows-x64.zip`, WebView2, in-process libtorrent where a wheel exists) | Download from the release page; built by desktop CI (`windows/zimi.iss`, `920c505`) | CODE-ONLY | internal |
| **Windows auto-update via WinSparkle** — parity with macOS Sparkle, same signed appcast key; per-user Inno Setup installer (no UAC) | Windows app self-updates (`zimi_winsparkle.py`, `2166952`) | CODE-ONLY | internal |
| **Desktop bundles libtorrent**; aria2 sidecar retired from Docker + desktop | Automatic (`120613b`, `7ccf0f0`, `c413902`) | CODE-ONLY | internal |

## 8. Security & privacy

| Change | How reached | Verify | Origin |
|---|---|---|---|
| **P0 libzim segfault race fixed** in the passive Q-ID extractor (+ real-ZIM stress test) | Automatic (`aa36e32`) | CODE-ONLY | internal (grow-up audit) |
| **`/dl/` no longer serves whole ZIMs to the public internet** — private-IP gated + trusted-proxy allowlist | Automatic (`4a8f4ae`, `7f78f0b`, `5ea132f`) | CODE-ONLY | internal (security) |
| **Unauthenticated surface hardened** for multi-user; users auto-rejected from `/manage/*` | Automatic (`909fb68`, `users.py`) | LIVE-TESTED (kid blocked from manage) | internal |
| **UTF-8 forced on all text I/O** (fixes Windows cp1252 crash); `os.fchmod` guarded on Windows | Automatic (`df2b5ed`, `fa15e08`) | CODE-ONLY | internal (Windows) |
| **Personal domains / LAN topology genericized** in tracked files; `SECURITY.md`, issue templates added | Repo (`400e6f4`, `e1657ac`) | CODE-ONLY | internal |
| **Cross-user search-cache leak closed** (allowlist-keyed cache) | Automatic (`ab8ef79`) | LIVE-TESTED | internal |

## 9. Almanac (easter egg — one compact subsection, NOT the story)

- **Deep-links into your library** — planets, probes, stars, the Moon, named
  people/places/events resolve by Wikidata Q-ID against your installed
  Wikipedia/Vikidia and open the real article; unresolved entities stay plain
  text (`almanac-links.js:762 linkFor`, `db6043f`, `b04db28`). UI-ENTRY.
- **Time machine** — a skeuomorphic three-row time circuit + brass lever; the
  sky, orrery, moon and calendars move to any year from −270000 to 270000
  (`almanac.js`, `748044a`, `a4a1777`/`a4d05e8`). UI-ENTRY.
- Q-IDs audited against live Wikidata (`3eecdb4`, `df225b1`); on-this-day and
  holiday links (`024473a`, `581bd75`); real high-res NASA moon, accurate
  Chinese calendar, 224 more searchable cities, interstellar-probe orrery view.

## 10. Under the hood

- **One BitTorrent engine**: in-process libtorrent replaces the aria2 sidecar —
  real per-torrent stats, fast-resume, no RPC ports or orphaned processes
  (`p2p.py`, `b545661`). Where libtorrent is absent (bare `pip install`),
  downloads use HTTP as always.
- **Ten languages, audited** — full i18n sweep, English leaks closed, orphan
  keys removed, Chinese typography (`d5d4bd6`, `2e86308`).
- **a11y** — keyboard-navigable card context menu, reader-palette AA contrast,
  Escape handling, ARIA roles (`d3210cf`, `bf557d4`).
- Unbounded-recursion fix on failed partial-download cleanup (`847eb5d`);
  pooled-archive lock-race fix (`7f78f0b`).

---

## CUT / NOT in this release (so the boundary is explicit)

From `docs/plans/2026-07-24-release-scoping.md`, deferred to **v1.8.1**:
- Video-ZIM playback/resume/discovery polish
- zimgit / PDF collections first-class pass
- Scheduled / night-window / bandwidth-capped downloads
- Backup & export hub (library-list import/export, settings/bookmarks backup)
- Whole-app light/dark theme toggle; auto-dark for raw articles
- Almanac time-machine skeuomorphic **re-do** (the 1.8.0 version ships but Eric
  "doesn't love it"); link-map expansion round 2; real bright-star catalogue
  night sky; almanac's own header icon; "Worldwide" holidays option
- did-you-mean vocab-coverage tuning (the caveat in §1)
- iFixit snippet boilerplate-skip
- README demo GIF walkthrough (removed for launch); repo-root slimming

Deferred to **v1.9 "Industry Edition"**: SSO/OIDC, SCIM/CSV user import,
per-group ZIM policies, audit logs, forced-login/private mode, fleet deploy,
Prometheus, users-v2 (self password change, per-user history/bookmarks),
phrase/snippet search, reading-resume, maps.

Deferred to **v2.0**: chat-with-your-library, period-newspaper time travel,
extended ZIM format / almanac-as-ZIM.

**Do not claim any of the above as shipped in 1.8.0.**

## Verification summary

- Community-traceable items (issues #33/#34/#36/#37/#38 + libzim#731 +
  kiwix-js#166): **7 filed sources**, ~15 distinct shipped changes.
- LIVE-TESTED this session: word lookup (NAS, both reader modes), allowlist
  filtering + Edit-allowlist UI gate (local), `/chunks`, `/openapi.json`,
  no cross-user search leak, users blocked from `/manage/*`.
- Nothing cut for being unreachable. One honesty flag: **did-you-mean fires in
  code/tests but is silent on the big-Wikipedia NAS deploy** — keep the release
  wording hedged and don't promise specific corrections.
