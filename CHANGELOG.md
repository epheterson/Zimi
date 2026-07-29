# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [1.8.1] - 2026-07-28

A polish-and-hardening release on top of the Community Edition. The headline is
access control: a Zimi server can now be open, limited to a chosen set of ZIMs,
or sign-in-required — with the security model tightened end to end so private
really means private. "Did you mean?" grows up into the coverage 1.8.0 promised,
"sections" become "Categories", light mode gets a real contrast pass, and
downloads gain a nightly window and bandwidth caps.

### Added

- **Public-access modes — open / limited / private.** An anonymous (not
  signed-in) visitor now sees one of three things, set by the admin: the whole
  library (**open**, the default and the legacy behaviour), a chosen allowlist
  of ZIMs (**limited**), or a **sign-in-required** gate (**private**). Anonymous
  simply gets an allow-set instead of the all-access sentinel, so every existing
  choke point (`get_zim_files` / `list_zims` / `zim_allowed` / the search-cache
  key) filters it with no new leak surface. Admin-only `GET`/`POST
  /manage/public-access`, an `ZIMI_PUBLIC_ACCESS` env override, and a picker in
  the Users pane. A corrupt policy file fails **closed** to private.
- **Per-user server-side data.** A signed-in named user can save their
  bookmarks, history and preferences to their own server account (`/userdata`
  GET/POST), stored per-user under `ZIMI_DATA_DIR/userdata/`. The blob is gated
  to the **session** user — a user can only ever touch their own data; an
  anonymous or admin-without-a-named-user visitor keeps everything in the
  browser as before. Casefolded keys, size-capped, path-traversal refused.
- **Backup & export hub, rebuilt as two cards.** "**My data**" (this browser's
  bookmarks / history / preferences) and "**Server backup**" (the admin's
  library, collections and layout, plus every user's server-side data) are now
  clearly separated, each with its own Export and Import. Imports **merge** by
  default (union by identity, incoming wins) via a two-step preview→apply, with
  an overwrite escape hatch, and are **scope-validated** so a My-data bundle
  can't be applied on the Server card or vice-versa. Signed-in users get
  Save-to-server / Restore-from-server for their own data.
- **Scheduled downloads.** An optional nightly window (server-local time,
  overnight-spanning) holds downloads started outside it as `scheduled` and
  releases them when the window opens, with a per-download **start-now**
  override. Configurable in the UI or via `ZIMI_DL_WINDOW`.
- **Download bandwidth caps.** A shared token-bucket throttle paces all
  concurrent HTTP pulls to a single global **download** cap (N streams sum to
  the cap, not N × the cap); the cap is the same number as the BitTorrent down
  limit. An **upload** cap too, plus bulk **Pause / Resume / Delete-all**
  controls over the download queue.
- **BitTorrent tunables.** Max concurrent downloads (`active`) and the global
  peer-connection limit (`conns`) are now adjustable in Settings and via
  `ZIMI_BT`; the connection limit lands on the session at startup and can be
  changed live.
- **"Did you mean?" — the widening 1.8.0 promised.** The vocabulary now uses
  lossy-counting eviction plus stride sampling, so words spread thin across many
  titles (mitochondria, photosynthesis) survive the build instead of being
  dropped; a trigram index adds **distance-2** corrections for long words
  (`fotosynthesis` → `photosynthesis`); a frequency-ratio guard corrects a
  common-typo that is itself in the vocabulary (`einstien` → `einstein`) while
  leaving genuinely common words alone; and the vocabulary is persisted to disk
  and reloaded (invalidated by index changes or a builder-version bump) so it
  isn't rescanned every boot. Still fully offline and time-budgeted.
- **App theme switch — Auto / Dark / Light** for the whole UI, plus
  **auto-darken** for raw (non-Reader-View) ZIM articles when the app is dark,
  and a **Reader View Auto** theme that renders sepia in light mode.
- **zimgit / PDF collections, first-class.** A `zimgit-*` collection now renders
  as a searchable document list (title, author, size, description) instead of a
  raw ZIM page.
- **Video-ZIM polish** — a resume ledger that restores playback position,
  correct sizing on mobile, and a random-video card.
- **Almanac** — a real bright-star field in the sky scene, a **Regional /
  Worldwide** holidays toggle, a wider city set (~500) with click-anywhere map
  selection, its own header identity, and a larger library tap-through link map
  (every added Q-ID dual-verified against Wikidata).

### Changed

- **libtorrent now installs by default** via `pip` wherever a prebuilt wheel
  exists — CPython 3.9–3.13 on manylinux **and** musllinux (incl. aarch64),
  macOS and Windows — marker-gated below Python 3.14 (no wheel there yet, and no
  sdist) so a plain install never breaks on a new interpreter. Where no wheel
  exists, Zimi runs HTTP-only and prints the one-line fix; `pip install zimi[bt]`
  forces the attempt. The Dockerfile drops its separate libtorrent step (the
  requirement now resolves from `requirements.txt`); Python 3.13 is added to the
  classifiers.
- **Reader Define** popover clamps fully to the viewport and dismisses on scroll
  like a native menu; on touch it clears more room below the selection (away
  from the iOS system callout) and flips above when near the top of the screen.
- Server backup bundle bumped to **schema v3** (carries per-user server data).
- Repo layout: desktop build entry-points moved under `desktop/`, the Playwright
  config under `tests/`.

### Fixed

- **#38 — same-page `#fragment` links.** An in-page anchor in a single-page doc
  now scrolls in place instantly; it previously routed through a full
  `location.replace()` and hung behind the 15-second safety overlay, making
  every anchor jump look like a 15s page load.
- **Health report flags broken scrapes.** A ZIM that opens and reports entries
  can still be broken — every article a 0-byte shell, or its media all empty. A
  universal text-sanity sampler and a media sampler now catch both and demote
  the ZIM to a warning; a stray `.zim.torrent` metadata file is surfaced as a
  distinct info row, never as a broken ZIM.
- **iFixit snippets.** `extract_snippet` prefers a device page's own summary
  block over the one repeated featured-guide `<meta description>` baked into
  every iFixit page, without regressing ZIMs (wikipedia / gutenberg / ted) whose
  meta description *is* the right snippet.
- **Light mode contrast pass (WCAG AA)** — toggles, badges, amber ink, and
  disabled-field / blank-icon legibility; a redesigned, deterministic tile card;
  and a fix for the Safari tab-switch theme flash.
- **Move to…** stays in place when used from Settings, and its submenu clamps to
  the viewport.
- Raw-article horizontal overflow on narrow screens.
- iOS input-zoom guard on the private-mode login field; the inert Cancel button
  is hidden in the non-dismissible login gate.

### Security

- **Private/limited mode is fail-closed.** In private mode the request gate
  401s every read/data endpoint that isn't on a tiny login-surface allowlist —
  default-deny, so a newly added read endpoint is covered automatically rather
  than leaking until someone remembers to list it. In limited mode anonymous is
  filtered by every choke point, including the `zim_allowed` bypass paths
  (`/languages`, `/article-languages`, almanac-links).
- **The service worker never caches or serves stale identity endpoints.**
  `/whoami`, `/login`, `/logout`, `/list`, `/search`, `/suggest` and `/random`
  are now network-only. This closes two field bugs: a stale cached anonymous
  `/whoami` that re-showed the login screen after a successful sign-in ("sign in
  twice"), and a cached full-library `/list` that could be served to a
  now-anonymous visitor of a private instance on a network blip.
- **Admin session cookie.** The primary admin authenticates with a password
  Bearer that only rides `/manage/*`; the data endpoints (`/list`, `/search`)
  and the `/w/` reader iframe carry no Authorization header, so a private- or
  limited-mode admin loaded an empty library and blank article frames. Login and
  `/whoami` now mint an HttpOnly `zimi_session` admin cookie that authenticates
  both transports. It is unforgeable, never resolves as a named user, and is
  revoked server-side on logout and on password rotation.
- The `zimi_session` cookie sets `Secure` only behind an HTTPS proxy (a browser
  silently drops a Secure cookie over plain http, which is what broke logins on
  the LAN); `HttpOnly` and `SameSite=Lax` are always present.

## [1.8.0] - 2026-07-28 — the Community Edition

A release shaped by the people using Zimi: the open issues, the long-standing
asks from the wider ZIM ecosystem, and a week of field testing on real phones.
Reader View, read-aloud, word lookup, "did you mean", library organization,
filter pills — and the almanac now deep-links its stars, planets and people
straight into your installed encyclopedias, with a skeuomorphic time machine
that flies the whole sky to any date. Multiple named accounts with per-user
library allowlists arrive alongside a native Windows build, and under the hood
the torrent engine is finally in-process, with a real agent-facing API and
delta updates on top.

### Added

- **`GET /chunks`** — deterministic, embedding-free chunking of any article,
  built for RAG clients. Paragraph-aware packing to a `size` budget
  (200–4000 chars, default 1200) with a configurable `overlap` (default 120),
  `start`/`end` char offsets, and stable content-addressed chunk IDs: the same
  ZIM and parameters produce identical IDs on every server, and a ZIM update
  rolls them (cache invalidation for free). Text is capped by `CHUNK_MAX_TEXT`
  with a `truncated` flag so a giant article can't blow up a client. 404 for an
  unknown ZIM or path, 400 for bad params, rate-limited like `/search`.
- **MCP `get_chunks` tool** wrapping the same logic, so an agent can pull an
  article in ready-to-embed pieces without leaving the MCP surface.
- **`GET /openapi.json`** — a hand-authored OpenAPI 3.1 description of the read
  API (`/search`, `/suggest`, `/read`, `/w/{zim}/{path}`, `/list`, `/random`,
  `/health`, `/chunks`) with real parameter and response schemas. `info.version`
  tracks the running server version.
- **`docs/api-stability.md`** — which endpoints are stable, the additive-only
  JSON policy, and the one-minor-release deprecation notice. Plus an honest
  agent-cycle benchmark and methodology in `docs/benchmarks/2026-07-agent-api.md`.
- **"Did you mean?" spelling correction.** When a search turns up almost
  nothing, Zimi offers a correction drawn from a title-word vocabulary built
  from the ZIMs you actually have — fully offline, bounded so it never slows a
  search down. Surfaced as an additive `did_you_mean` field on `/search`, passed
  through MCP search, and rendered as a clickable line in the UI.
- **Read-aloud in the reader.** A speak/stop control uses the browser's offline
  speech synthesis to read the current article; it hides itself where the API
  isn't available.
- **Reader View.** A toggle re-renders the current article as a single
  distraction-free reading column inside the reader — ZIM chrome (navboxes,
  infoboxes, edit links, TOC) stripped, wide tables wrapped to scroll, Zimi's
  dark palette by default — with no reload or server round-trip. A settings
  palette adds designed Dark/Light/Sepia themes, serif/sans fonts, an A−/A+
  text-size control (85–130%), and an AUTO mode that opens eligible articles
  straight into Reader View without the raw white page flashing first.
  Preferences stick across article navigation and between sessions; PDFs and
  thin pages skip it silently.
- **Word lookup.** Select or double-tap a word in the reader and a Define
  popover pulls the first definition from the best installed Wiktionary ZIM —
  one suggest, one fetch, fully offline. It follows your language preference,
  works in the normal reader and Reader View, and stays dormant with zero UI
  when no Wiktionary is installed.
- **Tap-to-zoom images.** A scaled-down image in an article opens to full size
  in a lightbox on tap, and closes on tap-out or Escape.
- **Almanac deep-links into your library.** Entities across the almanac — the
  planets and interstellar probes in the orrery, the stars, planets and Moon in
  the star chart, and the named people, places and events in the panels —
  resolve against your installed Wikipedia/Vikidia ZIMs by Wikidata Q-ID in one
  batch when the almanac opens. A match becomes a direct tap-through to the
  installed article (canvas taps included, via hit-testing); anything
  unresolved stays plain text, so a link is never wrong. The resolver is pure
  SQLite over each ZIM's Q-ID index — no title guessing, no per-tap fetch, no
  miss toast.
- **The almanac's time machine.** The velocity scrubber and destination panel
  are replaced by a skeuomorphic instrument: a three-row time circuit (amber
  displayed date, neutral destination, dimmed now) beside a side-mounted brass
  lever you throw — ease it for minutes, throw it for centuries — with a single
  large readout while travelling and a transform-only landing shake (disabled
  under reduced motion). The sky, orrery, moon and every calendar move with the
  chosen moment. Type any year from −270000 to 270000; at extreme epochs, a
  panel whose calendar math runs out shows a quiet "beyond this calendar's
  range" note while the sky, orrery and deep-time carry on. 13 new i18n keys,
  parity across all ten locales.
- **Multiple user accounts.** Named accounts (on top of the existing password
  admin) with per-user ZIM allowlists that filter the whole read surface —
  search, read, suggest, random, list, chunks and almanac-links — for a
  signed-in user. Login mints an HttpOnly session cookie (so iframe reads carry
  it) and a Bearer token; users are auto-rejected from `/manage/*`. Admin and
  anonymous visitors are unchanged (all-access), and single-password installs
  need zero migration. A management username is now an optional, case-insensitive
  second factor for admin login (env var or a second line in the password file);
  the login field prefills `admin`. The search cache is keyed by allowlist
  identity so one user's results can never surface another's restricted ZIMs.
  The Users panel leads with Your Account (Change password / Log out as plain
  buttons) and lists only other users below — a solo admin sees no list.
- **Library health report.** A check in Manage → library opens each installed
  ZIM in turn and reports a per-ZIM ✓/⚠ table — main page, entry count,
  title/Q-ID index status, size against the catalog, age — with a summary line,
  flagging broken (0-entry or unopenable) sources.
- **Save your bookmarks to a ZIM.** A button in the bookmarks panel exports your
  local bookmarks to a standalone, portable `.zim` (one article per bookmark
  plus an index page) that any ZIM reader can open. Disabled when you have no
  bookmarks.
- **Print, Save as PDF, and Share.** A new row in the Reader palette prints or
  saves the current article as a PDF through the browser, and offers the native
  Share sheet where the platform supports it.
- **Seeding goals.** Each seed card shows lifetime uploaded bytes against its
  goal (ratio cap × file size) with a progress bar — e.g. "1.2 GB of 4.0 GB" —
  while a mirror-mode seed shows "shared · mirror ∞" and no cap. The uploaded
  total is read from the seed ledger, so it survives restarts.
- **Manage view: storage and download controls.** A caches bar breaks down
  Zimi's data directory by category (title indexes, Q-ID indexes, catalog
  caches, staging) with the top per-ZIM contributors, so you can see what's
  using disk without ever scanning the ZIM library. A per-download "switch to
  direct" button drops a stuck BitTorrent transfer to a plain HTTP pull, and the
  settings panel now prefetches so it opens instantly.
- **Keyboard-navigable card menu.** The right-click / ⋯ card context menu is now
  fully operable from the keyboard — arrow keys, Enter and Escape — with proper
  focus handling and ARIA roles.
- **Download-this-ZIM buttons** — on the source header and on every row in
  Manage, pointing at the existing `/dl/` peer endpoint. Each button is gated by
  a capability probe, so it only appears where the raw file can actually be
  pulled and the public WAN never sees a dead control.
- **Library filter pills** — the home library view gains All · Recently added ·
  Recently updated pills (30-day window, newest first), so a new ZIM is easy to
  find in a big library without searching (#34). Recent-search chips bring back
  your last searches with one tap, and language pills filter a multilingual
  library the same way the other views already could.
- **Organize your library** — right-click any ZIM (or use the ⋯ control on its
  row in Manage) to move it into another category, including brand-new custom
  ones, and reorder the home sections — default categories and collections
  alike — from a new Reorder panel in Manage preferences (#37).
- **Native Windows app** — a per-user Inno Setup installer
  (`Zimi-windows-x64-Setup.exe`, no UAC) that self-updates via WinSparkle,
  verified with the same signed appcast key as the macOS Sparkle path; updates
  install silently and relaunch on their own. A portable `Zimi-windows-x64.zip`
  (Edge WebView2 backend, in-process libtorrent when a wheel is available) is
  shipped beside it for no-install use. Both are built by the desktop release CI
  alongside the macOS DMGs and Linux AppImage/snap.
- **Delta updates over BitTorrent.** When updating a ZIM that has a torrent,
  Zimi copies the previous version into staging under the new name first, so
  libtorrent's hash check salvages every unchanged piece and only the changed
  pieces download. Wikipedia monthlies overlap heavily, so an update can pull a
  fraction of the full size. The download shows how much was reused; if there's
  no room to copy or anything goes wrong, it falls back to a normal full
  download. Zero new infrastructure.

### Changed

- BitTorrent engine: the bundled aria2c sidecar is replaced by in-process
  libtorrent. Real per-torrent stats, fast-resume across restarts, no more
  RPC ports or orphaned sidecar processes. Where libtorrent isn't available
  (e.g. bare `pip install zimi`), downloads simply use HTTP as always.
- **Cards show the real article count** — libzim's `article_count` rather than
  the raw entry count, which includes images, redirects and metadata. It's an
  additive cache field that fills in on the next natural metadata refresh;
  sources with a stale cache keep showing the entry count until then.
- The almanac's daylight labels read "Evening" and "Morning" (capitalized),
  matching the rest of the panel.
- **The Catalog renders instantly.** It now paints from its cached copy and
  refreshes in the background (stale-while-revalidate), and reuses the fetched
  feed for the rest of the session instead of re-downloading it.
- On smaller screens the home library's filter pills (recent searches,
  languages, recency) collapse into a single filter dropdown, so the header
  stays clean in a big multilingual library. Recency pills filter the home
  sections in place, the same way language pills do.
- **Everything user-visible is translated.** A full i18n audit closed English
  leaks across all ten locales, removed orphaned keys, and tightened Chinese
  typography — every string a user sees now has a translation in every language.
- **Checking for updates is fast again.** The Kiwix catalog has grown past
  3,600 entries; a cold update check used to fetch its OPDS pages one at a
  time (~16 s of "Loading…"). Pages now download concurrently and a warm
  cache still answers instantly.
- **One pill, everywhere.** Filter, language, source and category pills share
  a single geometry across search, home and management, and each filter row
  starts with an "All" pill — two clicks resets every search filter.
- **Language badges.** Home tiles and rows show a two-letter language badge
  on non-English ZIMs, and download/seed rows name their language — six
  same-named Wikipedias are finally tellable apart. Search-result source pills
  get the same treatment: when two share a display title (wikipedia and
  wikipedia_de both read "Wikipedia"), each colliding pill carries its language
  code while unique titles stay clean. Tiles got wider titles, the inactive
  favorite star stays hidden until hover, and the New/Updated badge moved off
  the source icon.
- **The sky-scene moon glides on time travel.** A focus-time jump — scrub,
  wheel/key step, Go, or Back to Now — now eases the moon to its new altitude
  and azimuth over ~500 ms inside the existing sky loop, retargeting from
  wherever it is on screen so rapid scrubbing glides instead of snapping and
  re-launching. Illumination updates on arrival; live loads and resizes are
  unchanged.
- **Calmer article header.** On desktop the reader controls (Reader View,
  text size, read-aloud) fold into the ⋯ menu like on mobile, and close is
  always the far-right button.
- **Section reorder grew its own view** — rows drag (keyboard arrows still
  work), collections sit in their own group, and ZIM row menus keep just
  "Move to…". The health report now spells out its badges ("Title index",
  "Q-ID index") and adds thousands separators to entry counts.

### Removed

- aria2 backend and bundling (Docker package, desktop sidecar binaries,
  `ZIMI_BT_BACKEND` selection). `ZIMI_BT` configuration is unchanged.

### Security

- On an internet-exposed Zimi with no management password set, the initial
  password-setup endpoint was reachable by public clients — a stranger could
  claim the instance before its owner. Initial setup now works only from
  private (LAN) addresses, like the rest of management; changing an existing
  password with the current password keeps working from anywhere.
- **Login is rate-limited.** `POST /login` — the one unauthenticated endpoint
  that runs PBKDF2 (600k rounds) — now has its own bucket
  (`ZIMI_RATE_LIMIT_LOGIN`, default 10/min), checked before any credential
  work, so it can no longer be used for unlimited password guessing or CPU
  exhaustion.
- **Allowlist leaks closed for limited accounts.** `GET /languages` read the
  raw ZIM cache, letting a `limited` user enumerate every installed ZIM by
  name; and the Q-ID interlanguage lookup answered from the SQLite index
  without the fail-closed allowlist check the other resolution strategies run,
  leaking ZIM names and article paths outside the user's allowlist. Both now
  filter to what the signed-in user is allowed to see.
- **Sessions expire.** Session tokens now carry a 30-day server-side TTL
  (`SESSION_TTL_S`), checked on every resolve and swept at login. A captured
  token is no longer a permanent credential, and `sessions.json` stops growing
  one entry per login forever.

### Fixed

- **"Did you mean?" actually fires now.** The spelling vocabulary was being
  built from whichever title indexes sorted first alphabetically inside a
  2-second budget — on a large library it never reached Wikipedia, and the
  trigger threshold was so strict that typo-matching junk results silenced
  it. The vocabulary now scans the biggest indexes first with room to
  finish, suggestions appear alongside weak result sets, and a typo that
  happens to exist in a few titles ("einstien") is still corrected when the
  real word vastly outweighs it.
- The almanac's Messages Across Time inscriptions (Rosetta Stone, Golden
  Record, Pioneer plaque, …) deep-link into your installed encyclopedias
  like the rest of the almanac — ten entities, verified both directions
  against Wikidata.
- **Almanac deep-links were silently dead on a full library.** The curated
  entity set had grown to 406 Q-IDs while `/almanac-links` rejects any batch
  over 400, so the client sent the whole set in one request, the endpoint
  400'd, and every almanac entity fell back to plain text — zero links even
  with a full English Wikipedia installed. The client now splits the set into
  chunks under the cap and merges the responses; a failed chunk retries on the
  next open while whatever resolved still renders, and a test pins the client
  chunk size against the server cap so the two can't drift back into the cliff.
- **Region-aware holidays and season names follow the map again.** After
  location storage moved to session storage this release, the holiday-region
  and hemisphere-season readers still read the old localStorage key, so
  clicking a country on the almanac map never changed which national holidays
  or season names rendered — it silently fell back to browser locale. Both now
  read through the shared session-storage getter.
- The search box has a clear (×) button, and the Updates line no longer
  strands on "Checking…" — one summary line that always reflects the
  result, with detail only when there are updates.

- **Interrupted downloads pick up where they left off.** Quitting or crashing
  mid-download no longer turns the partial file into "junk to clean up" —
  Retry resumes from the bytes already on disk (HTTP Range, with a size check
  so a changed remote file restarts clean), and the cleanup offer only lists
  genuinely orphaned partials, never anything a download still wants.
- **A failed partial-download cleanup can't spin forever.** When a mirror
  reports a different total size than the partial on disk, the download
  discards the partial and restarts clean — but if the delete failed (read-only
  mount, NFS lock, Windows sharing violation) the retry re-sent the same Range,
  got the same mismatched response, and recursed until the stack blew. It now
  fails the download with a generic message and the real reason logged, instead
  of dying with a RecursionError.
- **The update check can't hang.** A wedged connection to the Kiwix catalog
  used to spin "Loading…" forever (most visibly in the desktop app); the
  whole check is now bounded, and a failed catalog page is skipped instead
  of sinking the rest.
- The desktop reading ⋯ menu no longer lists Random and Language twice, the
  reader's serif font choice now applies to headings too, and the settings
  gear shows a single activity badge instead of stacking two.
- Orrery hover cards stay put while you mouse over to click their article
  link, and the Sun and the heliopause now link out like the planets do.
  The night sky also got real depth: a few hundred faint background stars,
  seeded deterministically and cached instead of re-rolled every frame.
- A passwordless Zimi asked non-local visitors for a password that didn't
  exist. Management is local-network-only until a password is set — the UI
  now says exactly that instead of showing a password prompt, and library
  data readers degrade gracefully on unreadable data directories instead of
  erroring (#36).
- Tailscale (and other CGNAT/overlay) clients are no longer treated as public,
  so management no longer locks when reaching Zimi over the tailnet. The
  100.64.0.0/10 range now counts as your private network by default; set
  `ZIMI_TRUST_CGNAT=0` to opt out (#36).
- LAN peer ZIM pulls now work over Tailscale/CGNAT (100.64.0.0/10) peers: the
  outbound pull gate honors the same `ZIMI_TRUST_CGNAT` knob as inbound trust,
  so tailnet peer-sharing no longer silently fails to pull.
- The almanac's meteor-shower list no longer jams the peak marker onto the
  line ("🌕 Poor Peak!"). Peak night now gets its own localized badge, styled
  like the other meteor labels and translated across all ten locales (#23).
- In-page `#fragment` links in single-page docs (devdocs) scroll to the right
  anchor instead of 404'ing — `/w/devdocs_en_markdown/index%23backslash` used
  to report `Entry 'index#backslash' not found`; the path is now split so the
  entry loads and the browser scrolls to the fragment (#38). Stray
  `<name>.zim.torrent` companions left in the ZIM directory by the old aria2
  era are migrated into the cache directory at startup and flagged as "not a
  ZIM" by the health report, so they stop showing up as broken sources (#38).
- Almanac Q-ID resolution never falls back to a wrong-language Wikipedia
  article — an entity resolves to your preferred language or stays plain text.
- **Windows crashes fixed.** All text file I/O is forced to UTF-8 (a cp1252
  decode crash on non-ASCII data), and the atomic JSON writer guards
  `os.fchmod`, which doesn't exist on Windows.
- New/Updated badges no longer light up an entire existing library as "New":
  `first_seen` is honest on a cache rebuild (backfilled from file mtime), and a
  mass badge-in no longer swallows a whole slow scan (#34).
- Saving the management password to the keychain and "remember me" now survive
  a password change.
- Reader palette meets AA contrast, Escape no longer dead-ends inside it, and
  the filter pills carry proper ARIA roles.
- Map ZIMs (Kiwix `maps_en_*`) render more reliably — vector-tile and GeoJSON
  responses now carry correct MIME types (`application/x-protobuf`,
  `application/geo+json`) so a tile loader gets protobuf, not octet-stream.

### Notes

- **Downgrade caveat:** once a management username is set, the password file
  gains a second line holding that username. A pre-1.8 server can't read the
  two-line format — if you roll back, delete the username line (or the whole
  file) so the older server reads it as a plain single-line hash again.

## [1.7.4] - 2026-07-20

A polish drop that closes the two live issues the post-1.7.3 code audit
surfaced, and grows the almanac up: an accurate Chinese calendar, a real
high-res moon, and a solar system you can travel out to. The moon finally
looks like the Moon.

### Almanac

- **Accurate Chinese calendar.** Replaced the mean-lunation approximation with
  real astronomy — month boundaries are true new moons in China Standard Time,
  leap months placed by the solar-term rule against the winter solstice.
  Verified against the Hong Kong Observatory (New Year dates and leap months
  2014–2033). It's a browsable calendar system again, with the 闰 leap-month
  marker and the correct zodiac animal.
- **Holidays land on every calendar.** Worldwide days, regional holidays, the
  Easter cycle, solstices, meteor showers and Hindu/Sikh festivals are now
  projected onto whatever calendar you're viewing (Hebrew, Islamic, Chinese…)
  instead of vanishing when you switch away from Gregorian.
- **A real high-resolution moon**, reprojected from NASA's seamless lunar
  albedo map — genuine crater detail and subtle true colour. The animated sky
  moon shares the hero's shading now, earthshine dark side and all.
- **Travel the solar system.** The interstellar probes — Voyager 1 & 2,
  Pioneer 10 & 11, New Horizons — are plotted at their real bearings out past
  Neptune and creep outward as the clock runs, framed by labelled asteroid,
  Kuiper and heliopause markers.
- **Easier location picking** — the world map cycles through overlapping
  cities on repeated clicks, and search reaches 354 cities.

### Security

- **`/dl/` no longer serves whole ZIMs to the public internet.** On a
  host-networked deploy behind a containerized reverse proxy, every WAN
  request reached Zimi from the docker bridge gateway — a private IP with no
  real client IP propagated — so the whole internet was classified "private"
  and could pull raw `.zim` files (public content, so not a data breach, but
  unmetered use of the operator's uplink) and got the trusted rate tier.
  Zimi now honours Cloudflare's un-forgeable `CF-Connecting-IP`, trusts a
  forwarded client only from a private proxy hop (optionally an explicit
  `ZIMI_TRUSTED_PROXIES` allowlist), and refuses a forwarded value that claims
  loopback. WAN clients resolve to their real IP again.

### Fixed

- **A libzim segfault under normal use.** Opening an article kicked off a
  background thread that read a shared libzim archive with no lock, while the
  request read the same archive — two threads in a non-thread-safe library, a
  silent crash. It now uses its own handle. Added a real-ZIM concurrency
  stress test so this class of bug can't hide behind mocked archives again.
- Search results could silently drop a ZIM under concurrent load (an archive
  published before its lock); the setup order is fixed.
- LAN peer discovery advertised the wrong BitTorrent port when a custom port
  was set; it now advertises the real one.
- Malformed HTTP Range headers no longer 500 the download endpoint.
- The almanac topbar showed the underlying ZIM's icon; the breadcrumb is now
  just "Zimi" while the almanac is open (you reach it only from home).
- Picking a location on the almanac's world map no longer rebuilds the whole
  panel — it refreshes the location-dependent pieces in place, so the page
  stops jumping and flashing on each click.

### Changed

- **The moon is beautiful now.** The hero and Today-card moon are rendered as
  a single physically-shaded sphere — a soft terminator, gentle limb
  darkening, the maria showing through, and a faint earthshine glow on the
  dark side of a crescent. Gone are the hard light/dark edge, the seam down
  the middle at the quarters, and the flat too-bright disc. The hero moon now
  renders at the display's device resolution (up to 512px) so its shading
  stays crisp when you lean in.
- **Country holidays get their own colour** on the calendar, apart from the
  worldwide observances (#33).

### Added

- **"New" and "Updated" badges** on ZIM cards, so fresh or changed sources
  stand out in a large library instead of being lost in the grid (#34). A
  fresh install gets a solid "New" pill; a source whose file changed on an
  update gets a quieter "Updated" pill. A badge clears the moment you open
  that ZIM, and auto-expires after a week even if you never do — so it never
  lingers.

## [1.7.3] - 2026-07-18

Both field reports closed — the downloads page no longer throttles itself
blank, and Central Europe reads its own timezone. Alongside that, the
almanac grew up: pick any day and the whole page follows it, the star chart
became something you can actually explore, and the history feed stopped
being a NASA-only timeline.

### Highlights

- **The downloads page stays put** while downloads run (#30).
- **Pick a day, the almanac follows** — moon, sun, history, sky, all of it.
- **An interactive star chart** you can scrub through time and drag across
  the Earth.
- **BitTorrent tells the truth** about whether it is actually running.

### Added

- **Star chart** — a planisphere of the sky above you: bright stars and
  constellations, the planets in their colours, and the Moon. Scrub twelve
  hours either way to watch the sky turn, tap anything to identify it, and
  drag the chart to stand somewhere else on Earth (drag far enough south and
  Polaris sets, as it should).
- **Pick any day on the calendar** and every panel that describes a moment
  re-draws for it — the moon and its numbers, sunrise and sunset, the sky
  scene, the star chart, meteor showers, eclipses, and that day's history.
  The world clock keeps reading now, because it is a clock.
- **On This Day** — a curated, offline feed of space and science milestones,
  84 dates from Luna and Leonov to Chandrayaan-3, Hayabusa, Chang'e and
  CERN, alongside Apollo and Voyager.
- **The Analemma** — the figure-eight the Sun traces over a year, drawn from
  the same offline solar maths as the sunrise times, with today marked.
- **Next full moon**, flagged as a supermoon when it falls near perigee.
- **Moon phases on the calendar** — the four turning points of each month.
- **Many more observance days** on the Gregorian calendar: a fuller set of
  UN international days and cultural observances every month, on top of the
  worldwide set and your region's national holidays.

### Fixed

- **Downloads and settings panels clearing themselves** (#30): with a
  download running, three separate pollers together exceeded the API rate
  limit and the panel 429'd itself blank. The read-only status endpoints now
  ride a generous budget that does not depend on how the client is
  classified, so it holds behind a reverse proxy and with a password set.
- **Downloads that hung forever** on a torrent with peers but no data — they
  now fall back to HTTP instead of sitting at "0% · 0.0 MB/s".
- **A green "ready" light over a dead engine**: a crashed BitTorrent sidecar
  left the status card claiming it was running.
- **Deleting a ZIM now stops seeding it.** The torrent used to keep
  advertising the missing file until the next maintenance sweep.
- **The mirror progress line freezing** mid-count after a single failed poll.
- **Timezone routing for Central Europe** (#28 follow-up): clicking a
  location in Germany (or Poland, Austria, Czechia…) resolved to London's
  timezone. It now matches real-city anchors by geography alone; Germany
  reads +2 (CEST), an hour ahead of London.
- **Almanac accuracy throughout**: moon phase naming, distance, crescent
  tilt and altitude; sun times in the selected location's timezone with
  proper twilight; Hebrew holidays in non-leap years; eclipse geometry (no
  more phantom eclipses); and the March equinox.
- **The hero moon's lit side faces the Sun.** A screen-rotation sign error
  flipped the crescent to the wrong side of the disc, so the big moon and
  the sky scene contradicted each other after sunset.
- **The sky scene's Sun sets in the west.** An unnormalized hour angle
  mirrored the Sun's azimuth to the wrong hemisphere on western-longitude
  evenings — the sunset painted on the eastern side of the scene.
- **Seeding actually works now — and survives restarts.** Two long-standing
  defects fell together: aria2's own ratio cap measures upload against the
  session's *downloaded* bytes, which is zero for a re-seed of a file
  already on disk — so every capped seed silently died the first time a
  real peer took a piece (only uncapped mirror seeds ever survived). And a
  restart could silently drop a live seed from aria2's session. Zimi now
  runs every seed uncapped at the aria2 layer and enforces your ratio cap
  itself — cumulatively, against file size, across restarts — and keeps
  its own ledger of intended seeds, restoring any that are missing at
  startup. Upload is booked every 30 seconds and flushed at shutdown, so
  the cap is enforced within half a minute and survives restarts to the
  byte. Deliberate stops (your stop button, seeding off, mirror off,
  deleting the ZIM) remove the intent, so nothing resurrects.
- **Selections no longer grey out** under the cursor, and today's date circle
  no longer pushes its holidays below the neighbouring cells.
- **Eclipse rows no longer name a visibility region.** The label came from
  sub-solar longitude alone and was wrong more often than right (the
  August 2026 totality over Greenland, Iceland and Spain read "Americas").
  Rows now show the eclipse date instead; real ground tracks come later.
- **The zodiac animal follows the Chinese year**, not the Gregorian one, so
  it no longer contradicts the year number beside it each January.

### Changed

- **The Chinese calendar grid view is withdrawn for now.** The approximation
  behind it has no leap months, which left the grid a full month off for
  stretches of leap years. The cross-reference row stays, marked "≈". The
  grid returns when real astronomical intercalation lands.
- The almanac was split into modules (shell, orrery, sky) after outgrowing a
  single 5,900-line file. No behaviour change.

## [1.7.2] - 2026-07-17

Both open field reports fixed within a day (#30, #28), and the
distribution story finished: desktop apps that torrent out of the box,
mirror nodes that can carry the whole catalog through an internet
blackout, and an almanac that tells the truth about every date it shows.
Rounded out with a sharing panel that's rock-solid and honest, and
BitTorrent that actually seeds what it says it will.

### Highlights

- **Desktop apps torrent out of the box.** The Mac and Linux apps now
  ship their own BitTorrent engine, signed and notarized with the app.
  Every install shares the load with the Kiwix mirrors, automatically.
- **Your router opens the door.** Like every real BT client: automatic
  UPnP port-forwarding, a port open/closed indicator, and a retry button,
  right in the BitTorrent settings. DHT is on, so magnet links and
  trackerless swarms just work.
- **Mirror mode is real now.** Flip one switch and Zimi seeds your whole
  library, uncapped, and archives the torrent for every catalog item —
  a single mirror node can bootstrap ZIM distribution for an entire
  offline network. Turning it off stops the mirror seeds (ordinary
  ratio-capped seeding continues) and never deletes the backup.
- **Built for the day the internet isn't there.** Every install keeps an
  offline copy of the catalog and a magnet link per installed ZIM. The
  catalog browses, searches, and installs from LAN peers with zero
  connectivity.
- **Honest seeding.** Seeds survive restarts, and the seeding panel
  shows snagged ones in red with the reason instead of hiding them.
- **The calendar is yours, wherever you are.** Click your location on
  the almanac map: national holidays follow (17 countries + a worldwide
  set), season names match your hemisphere, and equinoxes are computed
  to the minute. A new "About this data" section states the precision of
  every date on the page, in all 10 languages.
- **The world clock is alive**: 28 cities, one per UTC offset, each card
  tinted by its local daylight with solid sun/moon marks, the selected
  city glowing, and a digital card beside the analog clock — split-flap
  seconds, date, and timezone (PST/CET) included.
- **The BitTorrent port is editable in place** — change it and the
  engine respawns on the new port with UPnP re-mapped, live. Peer names
  apply instantly too (no more restart notes), and Mirror shows its
  progress while it seeds your library and backs up the catalog.
- **Panels stopped blanking themselves** (#30): the manage UI no longer
  trips Zimi's own rate limiter, and a rate-limited response keeps
  last-known content instead of clearing the page.
- **Downloads are stubborn now**: they survive server restarts, refuse
  to start when the disk can't fit them, and flip their catalog card to
  Installed the moment they land.
- **Standing maintenance**: catalog, port mapping, seeds, and magnets
  refresh themselves every 12 hours — no visit required.
- **One control for sharing speed**: set a max up/down rate right in the
  BitTorrent card (0 = unlimited); it governs downloads, personal seeds,
  and mirror alike. The Server → Sharing panel is now rock-solid — no
  layout jump, instant toggles, and status lights that never lie.

### Added

- **Global up/down bandwidth caps** for BitTorrent, set in MB/s in the
  Sharing panel (0 = unlimited). Applied to the whole aria2 engine —
  downloads, seeds, and mirror — so one pair of numbers governs all
  sharing speed. Live-adjustable without a restart.

- **Desktop apps torrent out of the box**: the DMG and AppImage now ship
  their own aria2 sidecar (hash-verified static build on Linux, relocated
  Homebrew build on macOS, codesigned and notarized with the app). The
  BT-first default finally applies to every install, not just Docker.
- **Port health in BitTorrent settings, like a real BT client**: an
  open/closed/unknown indicator for the listen port, automatic UPnP
  port-forwarding (on by default, stdlib implementation, fails soft), and
  a retry button that re-maps and re-tests on demand.
- **True mirror mode**: turning Mirror on now seeds your whole installed
  library — aria2 hash-checks each existing file and seeds it in place,
  uncapped, using saved .torrent files (works offline) or the catalog's
  torrent URLs. Seeds whose file an update replaced are retired
  automatically. Mirrors also archive the .torrent for every catalog
  item (~40-80 MB for the full catalog), making a mirror node a complete
  offline index: any ZIM can be fetched, verified, and re-seeded with no
  internet at all.
- **Post-world resilience**: the last good Kiwix catalog persists to disk
  and stays browsable when the internet is gone (with a quiet "showing
  catalog from <date>" note), and every BT download keeps its infohash,
  magnet link, and .torrent file so ZIMs can be re-seeded into offline
  swarms later.
- **Honest seeding**: completed BT downloads re-seed from the library
  file itself (the old in-place seed died silently on restart), and the
  seeding panel shows snagged seeds — errored or file-missing — in red
  instead of hiding them. Mirrors especially.
- **Nearby warns when it can't work**: Docker bridge mode advertises an
  unreachable container address; the Nearby card now says so and the
  ZIMI_NEARBY ip= field (or host networking) fixes it.
- **The almanac states its precision like an encyclopedia**: a new
  "About this data" section covers algorithms, calendar accuracy, and
  coverage in all 10 languages. Equinoxes and solstices are now computed
  (Meeus, verified to within ~1 minute of USNO reference times) instead
  of pinned to fixed dates, with hemisphere-aware season names — October
  is spring in Sydney.
- **Every install keeps the post-world basics**: the offline catalog
  copy plus a magnet link for each installed ZIM (infohash extracted
  from the catalog's torrents); mirrors additionally keep the .torrent
  files for the whole catalog. Turning Mirror off stops the seeds but
  never deletes the archive.
- **Standing maintenance every 12 hours**, no visit required: the
  offline catalog refreshes before it goes stale, the UPnP port mapping
  renews at half-lease (it silently expired after 24h otherwise), and
  magnet manifest / mirror seeds / torrent archive stay current.
- **DHT is on by default** (opt out with the ZIMI_BT dht= field):
  trackerless peer discovery makes magnet links usable and keeps swarms
  findable if the Kiwix trackers ever disappear. The routing table
  persists across restarts.
- Thumbnails prefetch gently in the background after a catalog fetch, so
  browsing doesn't trickle images in one at a time.

### Fixed

- **Downloads and settings panels no longer blank themselves** (#30):
  Zimi's own rate limiter was counting the manage UI's polling against the
  anonymous budget. Clients with a valid manage credential — or any
  private-network client on a passwordless instance — now get 10x headroom
  (`ZIMI_RATE_LIMIT_TRUSTED`), snippet fetches ride the roomier content
  bucket, and a 429 keeps the last-known panel content instead of
  rendering an empty state. The Server pane also no longer embeds the live
  seeding list, which used to grow and shrink under you — seeds live in
  the Downloads tab.
- **BitTorrent actually seeds now.** A completed BT download re-added its
  library-path seed *before* removing the staging torrent — same info-hash,
  so aria2 rejected the add as a duplicate and no seed was ever created
  (the staging torrent then snagged "file missing"). Now it removes then
  adds. Downloads that finish over HTTP (or fall back from BT when a
  torrent has no live seeders) seed too, instead of silently not sharing.
- **No more double entries in Downloads.** An in-flight BT download used
  to surface as both a download card and a "seed" card under All; the
  seeding view now excludes still-downloading torrents, and a completed
  download that's now seeding shows only its seed card.
- **Fresh builds show up immediately.** The service worker keys its cache
  on a content hash of the app bundle, so any deploy — even within the
  same version — installs a new worker that clears the stale cache.
  Previously same-version deploys served old JavaScript from cache.
- **The random button doesn't no-op.** An unlucky ZIM pick could return
  nothing and leave the dice looking dead; it now retries across a few
  sources (and the client retries) so the first roll always opens
  something.
- **The almanac speaks world, not American** (#28): Gregorian holidays
  are an international base plus one region pack (17 countries + EU
  catch-all) picked from the browser locale/timezone — a British calendar
  shows Guy Fawkes Night and bank holidays, not Thanksgiving. Clock
  changes follow the region's real rule. The timezone picker grows from
  16 to 28 cities covering every UTC offset in common use, including
  Central Europe ("Italy uses UK time" is fixed) and the half-offset
  zones, translated in all 10 languages.
- **Your location drives the calendar**: click anywhere on the almanac
  map and the holidays follow — Italy gets Ferragosto, all offline. A
  quiet caption says whose days are showing, and each national day
  carries a country tooltip.
- **The world clock is alive**: each city card is tinted by its local
  hour (day, dawn, dusk, night) with a small glyph — the grid reads as
  a band of daylight matching the map's terminator.
- Picture of the Day no longer shows yesterday's picture (the Discover
  cache keyed on the UTC date while content used the local date).
- Closing the reader now restores the underlying view's URL — a reload
  no longer reopens the article you just closed.
- Downloads survive restarts: pending and queued items persist and
  resubmit at startup through their validated entry points, resuming
  partial files. Downloads refuse to start when they would fill the disk
  (expected size + 2 GB floor, or the disk-pressure threshold).
- Passwordless instances accept management commands from the local
  network only; public clients must set a password first. Instances with
  a password are unchanged.
- RTL article/ZIM titles (Arabic, Hebrew, Farsi) no longer reshuffle
  neighboring punctuation in LTR chrome.
- Cross-ZIM duplicate suppression is regression-tested (bundle + subset
  libraries), and every locale file is CI-locked to the English key set
  so untranslated raw key names (#25's bug class) can't recur.

- Server startup no longer blocks on the BitTorrent sidecar: backend spawn
  and LAN discovery moved off the critical path, and the aria2 RPC probe is
  deadline-bounded. A half-dead process squatting the RPC port could
  previously stall startup for minutes (hung the desktop app at launch and
  the CI release smoke test).
- `SIGTERM` (docker stop, systemd) now exits through cleanup handlers, so
  the aria2 sidecar is reaped instead of orphaned.
- Test suite no longer spawns real aria2c sidecars or makes live network
  requests; a leaked sidecar from one run poisoned every later backend
  start on the same machine.

## [1.7.1] — 2026-07-15

Fast follow to v1.7.0, fixing the first two field reports and closing the
sharpest edges before more people hit them.

### Fixed

- **Updating ZIMs returned bare 400s** (#26): stale clients can send
  `http://` catalog URLs, which the https-only trust check rejected.
  Trusted hosts are now upgraded to `https://` instead, and every
  rejected download logs its reason so a syslog is enough to diagnose.
  The same report's "Request timed out" spam is also fixed: mirror-list
  resolution moved off the request thread, so starting downloads no
  longer stalls for slow metalink fetches.
- Saving a sharing setting on a read-only config directory now returns a
  clear error instead of silently failing (or crashing the request).
- **Screen-reader text visible under the almanac sky** (#25): the
  description now hides with inline styles and falls back to English
  wording, so stale cached stylesheets or translations can never render
  it visibly or as raw key names.
- **Stale caches can't disable the PWA again**: the service worker's
  version is stamped at serve time from the running server instead of a
  hardcoded constant (the constant went stale for a full release cycle
  once). The Snap package version is likewise derived from pyproject at
  build time.
- Queued downloads show the sweeping "preparing" bar instead of a
  stalled-looking 0% bar.
- Finishing a download while a catalog page is open flips its card to
  Installed immediately (peer pills included).
- Overlapping downloads-panel refreshes no longer double-fetch the
  library list.


## [1.7.0] — 2026-07-13

The "Reach + Pro" release. Addresses issue #15 (the warlordattack feedback set
covering UX at 1000+ ZIM scale) and issue #16 (Wikipedia maxi auto-updating to
mini), and delivers the Reach track: P2P distribution + accessibility.

### Highlights

- **Your downloads now share the load.** Every Zimi that can torrent
  automatically helps distribute ZIMs instead of leaning on the Kiwix
  mirrors. On by default, seeding capped at a polite 2x, controlled by
  real switches in Server Settings.
- **Share your library with nearby machines, no internet needed.** Flip
  on Nearby and Zimi instances find each other on your network. When a
  nearby machine already has a ZIM you're browsing, a green pill lights
  up on the catalog card.
- **Corruption-proof installs.** Every downloaded file, whether torrent,
  HTTP, or LAN peer, must pass structural validation before it touches
  your library. A broken transfer can never replace a good ZIM.
- **Accessible.** If you browse by keyboard, listen by screen reader, or
  need high contrast, accessibility is built-in. 100/100 Lighthouse
  score across the app.
- **The catalog and downloads got a real overhaul.** Batch-select many
  ZIMs and grab them at once, watch real per-file progress with pause
  and resume, see what you're seeding back, and let the catalog hide
  things you already have.
- **Smarter, safer updates.** A full "maxi" Wikipedia will never
  silently downgrade to "mini" again (#16), auto-update follows Kiwix's
  new mirror URLs (#20), and the updates panel shows exactly what's
  waiting.
- **Built for big libraries.** A live activity bar shows background
  work, hot-cache pins your most-used ZIMs for instant search, and
  startup is dramatically lighter (#15).

### Critical fix: BT two-phase GID bug (2026-07-13)

- **Fixed**: BT downloads via `.torrent` URL could install a full-size but
  structurally invalid ZIM. aria2 splits such downloads into a metadata
  fetch (the GID we polled) and a `followedBy` content transfer (which we
  never looked at) — the poll saw "complete" instantly and installed
  aria2's preallocated staging file. Status now follows the content GID,
  and two guards make a repeat impossible: no install while a `.aria2`
  control file exists, and every staged file must pass a libzim open
  before the atomic rename. This was the root cause of all previously
  observed ZIM corruption.
- Download UI: indeterminate "Connecting to swarm…" bar while the torrent
  resolves, real progress after — no more instant-100% lies.

### Configuration: two env vars instead of fifteen (2026-07-14)

- **Changed**: the BT/P2P env surface collapses into two compact vars:
  `ZIMI_BT` (`off`, or `on,port=6881,ratio=2,up=2048,mirror=off`) and
  `ZIMI_NEARBY` (`off`, or `on,name=my-zimi,public=off`). Any field you
  set is env-locked in the UI; fields you leave out stay UI-controlled —
  so `ZIMI_BT=port=16881` pins the port while the on/off switch stays
  yours. The old per-feature vars keep working undocumented.
- **Changed**: Nearby (LAN sharing) is opt-in — OFF by default. Talking
  to other machines on your network is one switch away, never a surprise.

### BitTorrent-first by default (2026-07-13)

- **Changed**: BT-first downloads are now ON by default — every Zimi that
  can torrent shares distribution load with the Kiwix mirrors instead of
  adding to it. Installs without `aria2c` fall back to plain HTTP
  automatically; `ZIMI_TORRENT=0` opts out. Completed downloads keep
  seeding to a 2× ratio cap (UI toggle, `ZIMI_SEED` env override).
- Status views and the activity poll now *peek* at the BT sidecar instead
  of lazily starting (or retry-spawning) it every tick.
- Desktop app does not yet bundle aria2 — planned for v1.7.1; until then
  desktop/pip users get BT by installing aria2 (`brew install aria2`).

### Release-candidate QA pass (2026-07-13)

- **Seeding controls**: "Seed while downloading" and "Mirror mode" are now
  real toggles in Server Settings, persisted server-side; an explicitly-set
  `ZIMI_SEED`/`ZIMI_MIRROR` env var wins and locks its toggle. Previously
  the UI told desktop users to set an env var.
- **Catalog polish**: denser cards, batch-select checkbox moved to the card
  corner, the batch-download bar hides outside the Catalog tab (selection
  kept), thumbnail failures fall back to letter icons, hierarchy copy
  humanized ("Most complete edition"), size-range tooltip.
- **Almanac**: clicking the sun map (or searching a city / using GPS) now
  syncs the highlighted timezone city to the new location.
- **Fixed**: `app.js` cache-busting hash now reflects the served (rewritten)
  content, so deploys that change only lazy-loaded assets propagate to
  immutable-cached clients; service worker version bumped (a stale constant
  made it unregister itself against a 1.7.0 server, disabling the PWA
  shell); anonymous loads of password-protected servers no longer log 401
  console errors; language-agnostic ZIMs no longer show an "ALL" badge.

### LAN peer ZIM sharing (Reach)

- **New**: download a ZIM directly from another Zimi instance on your LAN —
  no internet, no Kiwix. A peer serves its raw `.zim` over HTTP+Range at a
  new `/dl/<name>` endpoint; clicking the 📡 peer pill on an uninstalled
  catalog item pulls it straight from that peer (`/manage/download-from-peer`).
  Works fully offline. The puller reuses the existing download machinery
  (range/resume/atomic-rename) and verifies the transfer against the peer's
  advertised exact byte size.
- **Design**: HTTP is the universal transport; the LAN path needs no extra
  binary, so it works identically across Docker, `pip install`, and the
  desktop app. BitTorrent (aria2) remains an optional accelerator for
  internet/Kiwix-swarm downloads only. This replaces the previous peer pill,
  which *claimed* to pull from the LAN peer but actually downloaded from
  Kiwix over the internet (and failed offline).
- **Safety**: `/dl/` serves only to private/loopback clients by default
  (`ZIMI_PEER_SHARE`, on); `ZIMI_PEER_SHARE_PUBLIC=1` opts into serving the
  public internet. The download URL is built server-side from discovered
  peer state, so a client can't coerce a fetch of an arbitrary host.
- **Packaging fix**: `zeroconf` is now a real install dependency (was only
  in `requirements.txt`, so `pip install zimi` had no peer discovery), and
  the desktop PyInstaller spec now bundles `zeroconf` + the `p2p`/
  `p2p_discovery` modules (previously omitted).

### Auto-update host allowlist (#20)

- **Fix**: auto-update rejected ~40 ZIMs with "URL must be from
  download.kiwix.org" because Kiwix now serves catalog URLs from
  `lbo.download.kiwix.org` (load-balanced origin). The validator now
  accepts any `*.kiwix.org` subdomain plus the
  `dumps.wikimedia.org/kiwix/` mirror. Still requires `https://`; rejects
  third-party hosts to prevent attacker-injected metadata. Affects
  `/manage/download` and the `.torrent` companion resolver.

### Background activity bar (#15)

- **New**: a thin status row below the topbar surfaces what the server
  is doing in the background — indexing, downloads, queued items, and
  seeding count — on one line. Reported by warlordattack (#15) who runs
  Zimi with 1067 ZIMs and described the post-startup churn as invisible
  ("perhaps there could be some way to show small information on what is
  happening in the background"). Auto-hides when nothing is happening;
  slides down on appear, slides up when idle. Polls `/manage/activity`
  every 5s while active, every 30s while idle. Doesn't permanently die
  on network blips; client paths that trigger work (`/manage/cache-action`,
  `/manage/download`, `/manage/download-batch`) nudge the poller so the
  bar surfaces within ~250ms. Designed precision-density / Linear style:
  `var(--text2)` labels, single `var(--amber)` accent on the actively-
  building ZIM name, no icons or shadows, `role=status aria-live=polite`
  with re-announce only on content change.

### Startup performance & memory bound (efficient-startup)

- **Startup is sequential and lazy by default.** Two changes drop peak
  startup memory dramatically:
  1. The five parallel warmer threads (one with a 4-way ThreadPool inside)
     collapsed into one named worker (`zimi-startup-worker`) running
     phases in order.
  2. With no `hot.json` configured, Archive handles open lazily on first
     use rather than being eagerly pooled at startup. Search is unaffected
     — title indexes are SQLite, not libzim, and the worker still builds
     them before search is offered.
  Synthetic measurement with 70 stub ZIMs × 10MB payload: peak RSS delta
  dropped from ~700 MB to ~0 MB. Hot-list users (env `ZIMI_HOT_ZIMS` or
  `hot.json`) still get pre-warming for the listed ZIMs only.
- **Index staleness check is content-addressed with mtime fast-path.**
  Stored ZIM mtime is checked first (matches → no libzim open). On
  mismatch (e.g., redownload), the ZIM's stable UUID from libzim's
  archive header is the tiebreaker — same content = same UUID, so a
  redownload of the same release no longer triggers a full rebuild.
  mtime is refreshed on UUID match so subsequent checks hit the fast
  path. Legacy mtime-only indexes are honored on match.
- **Concurrent index-build calls are serialized.** A completed download
  used to trigger `_build_all_qid_indexes` on a fresh thread that could
  race the startup worker (two threads opening the same Archive). Both
  `_build_all_title_indexes` and `_build_all_qid_indexes` now serialize
  through their own lock; late callers wait, then run with a fresh ZIM
  list so newly-arrived ZIMs are picked up.
- **`_loadavg_throttle()`** sleeps briefly between per-ZIM index builds
  when 5-min loadavg / nproc exceeds 0.8. Covers title-index build,
  Q-ID build, and FTS5 auto-build. Yields to a busy host (e.g., NAS
  during RAID rebuild). Disable with `ZIMI_INDEX_THROTTLE=0`.
- **Orphan `.tmp` cleanup.** `_clean_stale_title_indexes` and the
  Q-ID cleanup loop now remove `<name>.db.tmp` and
  `<name>.qid.db.tmp` artifacts left behind by interrupted builds
  (SIGKILL during write).
- **Docker `HEALTHCHECK --start-period` 30s → 10m.** First cold start
  may build SQLite title indexes from scratch for every ZIM
  (Wikipedia EN can take 5+ min on a fragile host). The longer grace
  prevents crash-looping during initial build.

### Added

- **Pro hot-cache** — Pin selected ZIMs in memory at startup so cold ones stay
  lazy. `ZIMI_HOT_ZIMS` env var (csv) overrides `ZIMI_DATA_DIR/hot.json`. New
  `GET/POST /manage/hot` endpoints. UI in Server settings with search box,
  select-all/none, and threshold-based collapse for small libraries (#15-5b)
- **Download queue** — Concurrent-download cap (default 3, env-overridable via
  `ZIMI_MAX_CONCURRENT_DOWNLOADS`); extras queue smallest-first to maximize
  early throughput (#15-2c)
- **Multi-select downloads** — Floating action bar with selection count, total
  size, Clear, and Download Selected. Uses new `POST /manage/download-batch`
  with size hints feeding the queue order (#15-2a)
- **Pause / resume on downloads** — `/manage/pause` and `/manage/resume`
  toggle a per-download flag the read loop respects. Slot stays held so
  pausing some downloads redirects bandwidth to others (#15-2f)
- **Filter pills on Downloads tab** — All / Downloading / Queued / Completed
  with counts, persisted in localStorage (#15-2g)
- **Catalog hierarchy detection** — Heuristic detects bundle/subset
  relationships across catalog items (e.g. wikipedia_en_top is part of
  wikipedia_en_all). Surfaced as badges: green "Already covered by ..." on
  installed bundles, gray "Part of ...", amber "Includes N smaller variants",
  green "Strictly contains all parts" coverage signal, orange "N fresher
  subset(s)" freshness signal. `?include_hierarchy=1` on /manage/catalog
  (#15-3)
- **SearXNG integration** — `/search` results now include a `category` field
  (general/images/video) so SearXNG can route hits to the right tab. Engine
  template + setup guide at `docs/integrations/searxng.md` (#15-4)
- **OpenWebUI / generic-AI** — MCP integration docs at
  `docs/integrations/openwebui.md` (#15-7)
- **Updates detail panel** — Click "N available" in Library card to expand a
  list with installed-date → latest-date and full filename diff per ZIM. New
  `/manage/updates` endpoint backs the UI (#15-7b, #16-2)
- **Top-search analytics** — `/manage/usage` reports `top_searches` with
  bounded LRU counter (5000 keys cap). Grafana-scrapeable as plain JSON
  (#15-8)
- **Cache management UI** — Server-settings buttons: Clear search cache,
  Clear suggest cache, Rebuild title indexes, Rebuild Q-ID indexes. Backed
  by `POST /manage/cache-action` (v1.6.1 follow-up)
- **Languages preference** — Pill multi-select in Preferences (13 common
  languages + multi). Catalog filter respects the choice when no per-tab
  language pill is set (#15-6)
- **Default download flavor preference** — Pill radio: Full (with images),
  No images, Mini. The user's preference becomes the default in every
  flavor-selector dropdown (#15-6c)
- **Updates Available section** — Pending updates bubble to the top of the
  Installed view in their own amber-headed group instead of mixing with
  category sections
- **Plan docs** — `docs/plans/2026-04-26-p2p-torrent-sharing.md` and
  `docs/plans/2026-04-26-accessibility.md` for the Reach track
- **BitTorrent transport (opt-in)** — `ZIMI_TORRENT=1` enables the
  bundled aria2 sidecar. Downloads with a Kiwix `.torrent` companion
  use BT first; HTTP mirrors are tried on no-peers / hash mismatch.
  Completed files seed by default (capped at 2× ratio, disk-pressure
  auto-pause, `ZIMI_SEED=0` to disable). Active downloads show a small
  amber `BT · Np` pill on their card.
  - Server-settings shows live aria2 status (port, backend, ready/off
    state) and a per-torrent list with peer count, uploaded bytes,
    ratio, and a ratio progress bar
  - `GET /manage/bt-status`, `GET /manage/seeding` expose the data
  - Backend abstraction (`BTBackend`) keeps room for qBittorrent /
    Transmission / Deluge as drop-in implementations (the *arr-stack
    pattern: reuse the existing client's UI for power users)
- **LAN peer discovery (opt-in)** — `_zimi._tcp.local` advertised via
  Zeroconf with TXT records (version, zim_count, port, bt_port). New
  `GET /manage/peers` returns discovered peers. `ZIMI_PEER_DISCOVERY=0`
  disables. Note: in Docker bridge mode, mDNS multicast doesn't reach
  the LAN — use `network_mode: host` to expose discovery beyond the
  container
- **Become-a-mirror toggle (#19, W3.6)** — `ZIMI_MIRROR=1` flips
  Zimi from "personal seeder" (default 2× ratio cap) to "public
  mirror" with effectively-uncapped ratio (1000×) and raised upload
  bandwidth (default 10 MB/s, both env-overridable). New
  `effective_seed_options()` returns mirror-or-personal aria2 caps;
  `_try_bt_download` uses it transparently. New `/manage/mirror`
  endpoint exposes `{enabled, ratio_cap, upload_kb}`. Server
  settings shows a "📡 Mirror active" row when on, with the active
  ratio + upload-cap visible. 12 unit tests cover env parsing,
  default caps, override fallback, status dict shape, and the
  effective-options branching
- **Custom peer name (`ZIMI_PEER_NAME`)** — override the auto-
  detected `zimi-<hostname>` advertised on mDNS with a friendly
  string ("Eric Home Mirror"). Sanitized to `[a-zA-Z0-9-_ ]`,
  capped at 63 chars, falls back to hostname if empty after
  sanitization. Server settings BT/Seeding panel now shows
  "Advertising as ___ · N peers" so users can confirm what name
  the LAN sees.
- **Catalog peer pills (clickable)** — when a discovered LAN peer
  already has a ZIM, a small green "📡 peer-name" pill appears on
  its catalog card. Phase 1 (informational) and phase 2 (clickable)
  both shipped this release.
  - Phase 1: clients fetch each peer's `/list` via the cached
    `GET /manage/peers/list?peer=NAME` endpoint and match by
    stripped filename stem
  - Phase 2: the pill is now a real button that triggers the
    download for the user's preferred flavor (full → nopic → mini,
    or whatever the Preferences default is). BT swarm naturally
    pulls bytes from the LAN peer — TCP RTT is an order of
    magnitude lower than WAN, so the swarm prefers the LAN path
    automatically; we just trigger the download and surface a
    toast: "Starting download — elpnas on your LAN should serve
    the bytes."
  - Pill is keyboard-focusable with a green focus ring; touch
    target is 24×24 (WCAG 2.5.5)
- **Accessibility track (#19)** — Reach goal: build once and benefit
  every screen-reader, keyboard, and low-vision user, forever.
  - Skip-to-main-content link, first tab-stop, hidden until focused
  - `role="dialog" aria-modal="true" aria-labelledby="pw-title"` on
    the password modal, with Esc-to-close and Tab focus-trap that
    cycles within the modal so keyboard users can't accidentally
    escape into the background page. Focus is restored to the
    previously-focused element on close
  - `role="search"` + visually-hidden `<label>` on the topbar search,
    plus `aria-autocomplete="list"` and `aria-controls="suggest-dropdown"`
    so suggestions announce correctly
  - `role="status" aria-live="polite"` toast region. `_showToast()`
    now mirrors text into the live region so non-sighted users hear
    the same feedback sighted users see
  - High-contrast amber `:focus-visible` ring across the SPA (2px,
    offset 2px). Buttons and inputs that style their own focus opt
    out via `:not(:focus-visible)`
  - `<label for>` association added to onboarding ZIM-folder field
    and password input (was placeholder-only)
  - **ZIM article HTML rewriter** (opt-in via Preferences →
    "Improve ZIM article accessibility"): when on, every `/w/*`
    article is run through `zimi.a11y.rewrite_html()`, which adds
    missing `alt=""` to images (decorative-by-default per WCAG
    1.1.1), promotes the first `<div class="title">` to `<h1>` when
    no real `<h1>` exists, and fills `<html lang>` from the ZIM's
    language metadata. 21 unit tests cover each transform plus
    idempotency and malformed-input safety. Default off so byte-
    purist users get the original HTML; toggle persists in
    localStorage. Activated per-request via `?a11y=1` query param.
    Live measurement on the Wikipedia Albert Einstein article: 25
    additional images announced (was 17/42 with alt; now 42/42)
  - **`forced-colors` (Windows High Contrast) support** — system
    colors (`Highlight`, `ButtonText`, `ButtonFace`, `ButtonBorder`)
    applied to focus rings, buttons, and pills so the user's chosen
    OS scheme is honored end-to-end
  - **Almanac sky scene now described for screen readers** — the
    canvas-based sky animation gets a sibling `<div class="sr-only">`
    populated from the same astronomical data we render visually.
    Reads like: "Almanac sky for Monday April 27, 1:45 PM. Sun 47°
    above the horizon. Moon 83% illuminated, 23° above the horizon.
    412 stars visible above the horizon." Updates once per render
    (the per-frame visuals are decorative)
  - `prefers-reduced-motion: reduce` already gated transitions
    globally; left as-is
  - **Topbar icon buttons** — every icon-only button (random,
    library, language, manage, open-in-browser, save, more) now
    has both an `aria-label` and a `data-i18n-aria` so screen
    readers announce the action in the user's chosen UI language.
    Decorative SVGs and emoji glyphs marked `aria-hidden="true"`
  - **Keyboard navigation audit (Task 2)** — programmatically walked
    Tab order across home, manage, and reader views. Findings:
    - 171 focusable elements on home, 114 in manage panel — **0
      unnamed** (every interactive element has aria-label, title,
      visible text, or a wrapping/associated label)
    - First Tab stop is the skip-to-main-content link
    - Esc cascades correctly: closes library panel → hides suggest
      dropdown → closes almanac → exits reader → clears search
      input → exits source/manage view, in that order, never trapping
    - Two-step Esc on search (1st: hide dropdown, 2nd: clear input)
      is intentional so users can see results before discarding
  - **Two-machine LAN test** — spun up a second Zimi instance on a
    LAN host (`:9000`), bound to 0.0.0.0 with 3 ZIMs. Verified:
    - `dns-sd -B _zimi._tcp local.` from a third device on the LAN
      sees both instances simultaneously
    - NAS `/manage/peers` lists the second host with the right
      host/port/zim-count
    - Mac `/manage/peers` lists `zimi-elpnas` (69 ZIMs)
    - 8 catalog cards on the Mac show clickable "📡 elpnas" pills
      after drilling into the wikipedia category — first time
      real-world peer pills rendered
    - During the test, found and fixed one bug: peer-stem keys kept
      the flavor suffix (`_nopic`) but catalog `name` doesn't.
      Now indexing both flavor-stripped and dated stems
  - **Lighthouse a11y score: 84 → 100/100** in three deploys; every
    weighted audit passes. Specific fixes:
    - `--text2` color bumped from `#6e6e7a` (3.85:1) to `#8a8a94`
      (5.75:1) — passes WCAG AA against `--bg`. `--text3` reserved
      for large-text only with the contract documented in the CSS
    - JS-rendered images get `alt=""` (decorative — the source label
      next to them already conveys the same info): discover-card
      thumbnails, `dc-zim-icon`, source-pill icons, manage-card
      icons, drilldown grid icons. Closes 88 `image-alt` violations
    - WCAG 2.5.5 minimum touch targets: `.star-btn`, `.flavor-pill`,
      `.dl-pause-btn`, `.dl-cancel-btn`, `.dl-retry-btn` all bumped
      to `min-height: 24px` with proper padding so click/tap is
      reliable on touch devices
    - WCAG 1.4.1: footer links get a dotted underline so they don't
      rely on color alone to be distinguishable from surrounding text
- **Networking** — Default Docker compose flips to `network_mode: host`
  so mDNS + BT seeding work out of the box. New
  `docs/deployment-networking.md` covers tradeoffs (host / bridge /
  macvlan), Synology Avahi coexistence, Cloudflare Tunnel WAN-seeding
  limits

### Changed

- **Downloads is its own manage subtab** alongside Installed / Catalog /
  Collections / Activity instead of rendering above them. Active-count
  badge on the tab label. Subtab order optimized for frequency-of-use
  (#15-2b)
- **Catalog + Downloads use a responsive grid layout**
  (`grid-template-columns: repeat(auto-fill, minmax(320px, 1fr))`) so wide
  screens fit 2-3 cards per row, narrow screens fall back to 1. Catalog
  cards stack icon + info + actions vertically inside grid cells for a
  compact card aesthetic (#15-2d, #15-2d')
- **Installed and already-covered catalog items** are dimmed and pushed to
  the back of the sort so actionable items rise to the top (#15-3b)
- **Catalog item-installed matching** now also tries the prefix derived from
  the OPDS download_url. Recovers cases where Kiwix returns a truncated
  `name` field (`canadian_prep_*` vs `canadian_prepper_*`) (#15-8a)
- **Auto-version rewriter** now also processes inline `/static/X?v=N` refs
  inside app.js, served from memory. Prevents Cloudflare-immutable cache
  staleness on lazy-loaded sub-bundles (almanac.js)
- 25+ new i18n keys localized in all 10 supported languages

### Fixed

- **Wikipedia maxi auto-updating to mini** (#16) — `_check_updates` now
  filters catalog candidates to the SAME flavor as the installed file. A
  newer mini will never silently replace a maxi. New `_detect_flavor()`
  helper handles maxi/nopic/mini/None cases. Six new tests including the
  exact bug scenario verbatim
- **Almanac crash on render** — `_METEOR_SHOWERS` table only had `key`
  fields, but two callers passed `s.name` (undefined) to `_th()`. New
  `_showerName(s)` translator + defensive `_th()` against undefined input
- **Bitwarden / 1Password ignoring the manage password input** —
  `data-1p-ignore` was on the password modal field; removed. Form now
  uses the standard `current-password` autocomplete contract (#15-1a)
- **"Remember me" did not persist across tab close** — was using
  `sessionStorage`. Now uses `localStorage` when checked, `sessionStorage`
  when unchecked. Logout clears both (#15-1b)
- **Pre-existing TestSearchAllContract no-op patches** — surfaced when new
  test files imported zimi early; replaced with proper string-form
  `@patch("zimi.server.get_zim_files")` so the patches actually patch

### Performance

- Search now searches only the user's preferred languages by default when
  set, avoiding per-ZIM Xapian work on irrelevant ZIMs
- Search-query counter for top-N is bounded so distinct-query patterns
  can't grow it unboundedly

### Tooling

- `package.json`'s default `npm test` placeholder now runs `pytest -q`
- `pyproject.toml` excludes the data-dependent `test_article_languages.py`
  from default pytest runs (run explicitly when investigating ZIM-data
  drift)
- `deploy.sh` order is now `down → build → up` (was `build → down → up`,
  which raced the container-name cleanup) and ships the entire `zimi/`
  package via tar so new modules deploy automatically

## [1.6.5] — 2026-04-28

CI bite fix. Pure infrastructure — no user-facing changes from 1.6.4.

### Fixed

- **`READY <port>` not emitted by `zimi serve`** — the macOS / Linux
  desktop release smoke test in CI grep'd stdout for `READY <port>`
  to capture the bound port (needed when `--port 0` lets the OS
  choose). Server never emitted that line, so every desktop release
  build (v1.6.1 / v1.6.2 / v1.6.3 / v1.6.4) failed its push-trigger
  smoke and required a manual `workflow_dispatch` re-run. Now `serve`
  prints `READY <port>` immediately after the HTTP server binds —
  with `flush=True` so stdout buffers don't hide it.

### Tooling

- **`tests/test_serve_smoke.py`** — five-test suite that subprocesses
  `python -m zimi serve --port 0` with an empty ZIM dir and verifies
  the contract end-to-end (READY emit, /health, /list, /search, /).
  Runs in regular `pytest` so the failure that bit v1.6.4 surfaces
  on the PR rather than after merge in the release pipeline.

## [1.6.4] — 2026-04-28

A "hold-you-over" patch release with the most impactful bug fixes
from the in-progress v1.7.0 Reach release. Cherry-picked individually,
each one validated. Larger Reach work (P2P, mDNS, mirror toggle,
accessibility, BT seeding, peer pills) ships separately when v1.7.0
finishes its full validation pass.

### Fixed

- **`/docs/docs/` doubling on zimit-scraped ZIMs** (#17, ma-javaqueen)
  — ZIMs scraped by `zimit` ship with wombat.js, which rewrites
  `<a href>` ATTRIBUTES to look like the original archived URL
  (e.g. `https://ersatztv.org/docs/`) AND installs its own click
  handler that re-resolves them — doubling the path on every nested
  navigation. The iframe click chaperon now uses Kiwix's
  `_no_rewrite=true` trick to ask wombat for the actual in-archive
  URL, and registers with `capture: true` so it runs before wombat's
  interceptor. Verified end-to-end on the reporter's
  `ersatztv_2026-04.zim`. Regression test in
  `tests/test_iframe_link_chaperon.py` asserts the JS source keeps
  the four invariants (`_no_rewrite=true`, prev-flag restore,
  `capture:true`, the explanatory comment).

- **Wikipedia maxi auto-updating to mini** (#16) — `_check_updates`
  now filters catalog candidates to the SAME flavor as the installed
  file. A newer mini will never silently replace a maxi. New
  `_detect_flavor()` helper handles maxi/nopic/mini/None cases. Six
  new tests including the exact bug scenario verbatim.

- **Bitwarden / 1Password ignoring the manage password input**
  (#15-1a) — `data-1p-ignore` was on the password modal field;
  removed. Form now uses the standard `current-password` autocomplete
  contract.

- **"Remember me" did not persist across tab close** (#15-1b) — was
  using `sessionStorage`. Now uses `localStorage` when checked,
  `sessionStorage` when unchecked. Logout clears both.

- **Catalog item-installed matching** (#15-8a) — now also tries the
  prefix derived from the OPDS `download_url`. Recovers cases where
  Kiwix returns a truncated `name` field (`canadian_prep_*` vs
  `canadian_prepper_*`).

- **Missing `_updateDownloadsTabBadge` function definition** —
  internal call existed but the function body was missing on certain
  code paths.

### Added

- **Search results carry a `category` field** (#15-4) — each result
  is tagged general/images/video so SearXNG (and any future router)
  can route hits to the right tab.

- **Top-search analytics** (#15-9) — `/manage/usage` reports
  `top_searches` with a bounded LRU counter (5000-key cap).

### Changed

- **Auto-version rewriter** now also processes inline `/static/X?v=N`
  refs inside `app.js`. Prevents Cloudflare-immutable cache staleness
  on lazy-loaded sub-bundles (e.g. `almanac.js`).

- **`pyproject.toml`** excludes `tests/test_article_languages.py`
  from default `pytest` runs (data-dependent suite; run explicitly
  when investigating ZIM-data drift).

## [1.6.3] — 2026-04-05

### Fixed
- MCP server now warms search indexes on startup (search was returning empty results)

### Changed
- Extracted `warm_indexes()` from `serve()` so MCP and HTTP servers share the same startup path

## [1.6.2] — 2026-04-04

### Fixed
- Fresh Docker installs locked behind password prompt with no password to enter (#12)
- Removed `Sec-Fetch-Site` header dependency from all auth decisions
- Token generation and password removal errors now show user-facing messages

### Changed
- Auth accepts password or API token as Bearer on all requests (no header sniffing)
- API token requires a password to be set first
- Password can't be removed while an API token is active

### Removed
- 15 unused screenshots from repository
- Stale RELEASE_NOTES_v1.6.md

## [1.6.1] — 2026-03-27

### Fixed
- Ctrl+click and middle-click now open articles in new browser tabs everywhere
- Search/catalog filter pills left-aligned when overflowing (highest count visible first)
- devdocs name collision: CSS and Git no longer parsed as language codes
- Empty password file no longer triggers false auth prompt
- Discover cards more reliable on cold start (15s timeout + auto-retry)
- Auth unchanged: browser requests use password, API requests require token

### Changed
- Removed in-app tab bar (deferred to future release)
- Browser tabs open with full Zimi UI (`?view=1`)
- Cmd+click on Today card opens Almanac in new tab
- Cache info section in Server settings (title/Q-ID index sizes)
- 15 remaining hardcoded strings localized in all 10 languages

## [1.6.0] — 2026-03-19

The Language Release.

### Added
- 10-language UI (en, fr, de, es, pt, ru, ar, hi, zh, he) with auto-detection and full RTL layout
- Cross-language article navigation via Wikidata Q-IDs and exact title matching
- Q-ID badge on source cards showing cross-language linking support
- Language filtering in search (`/search?lang=XX`), catalog, and homepage source labels
- Tab bar with Cmd/Ctrl+click to open articles in background tabs
- PWA: service worker with offline fallback, web app manifest
- Messages Across Time: 10 historical inscriptions spanning 3,700 years in up to 10 languages
- Golden Record gallery with 49 NASA Voyager images
- Real star catalog (59 stars from Yale BSC) with 10 constellations in simulated sky
- 4 new MCP tools: `article_languages`, `read_with_links`, `deep_search`, language-filtered `search`
- API token system for programmatic access (generate/revoke tokens)
- Stable 4-icon topbar layout (close button replaces gear when reader is open)

### Changed
- Split server.py into 7 focused modules (980-line core + 6 specialized modules)
- Extracted CSS and JS from index.html into separate static files
- Separated browser auth (password) from API auth (tokens)
- Catalog language filtering is now instant (cached client-side, no server round-trips)
- Search filter pills sorted by result count in compact scrollable rows
- Orrery speed slider extended to 100M× with 3-phase acceleration
- Almanac calendar systems ordered chronologically
- Real star positions replace random dots; corrected moon parallactic angle
- Kiwix catalog thumbnails proxied server-side with 24-hour caching
- Sanitized all 500 error responses

### Fixed
- Desktop app white flash on startup
- Language pills disappearing after deep search completes
- Three-letter language codes showing as raw abbreviations in catalog
- Hebrew Wikipedia not matching for cross-language interlinking
- Partial Discover cards caching all day
- Cross-language article matching false positives (character overlap guard)
- Language dropdown async/await race conditions
- Discover card flash/pop on re-render
- PDF download from viewer showing white page instead of saving file
- Catalog language filter not drilling down into full results
- PDF.js locale suffix for English

### Security
- Rate limiting on /manage/ endpoints
- Hardened thumbnail proxy: blocked redirects, rejected non-image content
- Salted password hashing
- X-Content-Type-Options and Referrer-Policy headers

### Removed
- Translation feature (Zimi is offline-first; use multilingual ZIMs instead)
- Article map (deferred to future release)
- Eclipse simulation from almanac

## [1.5.0] — 2026-03-04

Discover, bookmarks, cross-ZIM links, and the Space almanac.

### Added
- Added Discover section with 9 daily editorial cards (Picture of the Day, On This Day, Quote, Word, Book, Destination, Talk, Comic, Country)
- Added bookmarks, search history, and browse history with Library slide-out panel
- Added cross-ZIM link highlighting with dotted underline for installed sources
- Added search result thumbnails and right-click context menu (Open in New Tab, Copy Link, Copy Title)
- Added Cmd/Ctrl+click and middle-click to open articles in new browser tabs
- Added Space almanac: hero moon, simulated sky, orrery, Tonight's Sky, meteors, events, deep time
- Added interactive calendar browser with 7 calendar systems and timezone picker
- Added macOS-style tabbed settings panel, manual ZIM import, and mirror downloads
- Added persistent suggest cache across server restarts

### Changed
- Rewrote search to use parallel B-tree title index (3,000x faster suggestions, eliminated FTS5)
- Added 6-layer startup warmup for near-instant first search
- Replaced hand-drawn canvas map with Natural Earth SVG in almanac
- Separated `ZIMI_DATA_DIR` from `ZIM_DIR` for independent configuration

### Fixed
- Fixed Wikiquote attribution parsing for multi-word names
- Fixed cross-ZIM resolution for MediaWiki `?title=` permanent link URLs
- Fixed PDF viewer through Cloudflare CDN with `?raw=1` parameter
- Fixed deadlock in lock contention under concurrent requests
- Fixed download reliability and temp file cleanup

## [1.4.0] — 2026-02-21

PDF viewer, navigation history, packaging, and auto-updates.

### Added
- Added embedded PDF viewer using pdf.js for zimgit documents
- Added navigation history with back button trail and long-press menu
- Added Sparkle auto-updater for macOS desktop app
- Added Homebrew cask, Linux AppImage, and Snap distribution
- Added macOS code signing, notarization, and arch-specific builds (Apple Silicon + Intel)
- Added gzip compression for static file serving

### Changed
- Restructured codebase into Python package for PyPI and Snap distribution

### Fixed
- Fixed PDF title showing "PDF.js viewer" instead of article name
- Fixed iframe polluting browser history (back button inconsistency)
- Fixed in-ZIM navigation for sites with original-domain baseURI

## [1.3.0] — 2026-02-17

Browse Library, desktop app, and mobile polish.

### Added
- Added Browse Library category gallery view with grouped catalog items
- Added desktop app via pywebview with `zimi desktop` subcommand
- Added `serve --ui` flag for launching with native window
- Added iOS web app support

### Fixed
- Fixed mobile Manage view layout
- Fixed "Other" category display and scroll-to-top behavior

## [1.2.0] — 2026-02-16

Progressive search and collections.

### Added
- Added progressive search with SQLite title index
- Added collections for organizing and scoping searches

## [1.1.0] — 2026-02-14

Security, auto-updates, and UI polish.

### Added
- Added rate limiting, server metrics, and safe download system with integrity checks
- Added auto-update checking and flavor picker for ZIM variant selection
- Added deep link routing

### Fixed
- Fixed cache invalidation, X-Forwarded-For security validation, and thread safety issues

## [1.0.0] — 2026-02-12

Initial release — offline knowledge server for ZIM files.

### Added
- Added HTTP API with JSON endpoints for search, read, suggest, list, and random
- Added single-page web UI with dark theme and cross-source search
- Added MCP server for Claude Code and AI agent integration
- Added Docker support
- Added support for regular ZIMs, zimgit PDF collections, and OPDS catalog

[Unreleased]: https://github.com/epheterson/zimi/compare/v1.6.3...HEAD
[1.6.3]: https://github.com/epheterson/zimi/compare/v1.6.2...v1.6.3
[1.6.2]: https://github.com/epheterson/zimi/compare/v1.6.1...v1.6.2
[1.6.1]: https://github.com/epheterson/zimi/compare/v1.6.0...v1.6.1
[1.6.0]: https://github.com/epheterson/zimi/compare/v1.5.0...v1.6.0
[1.5.0]: https://github.com/epheterson/zimi/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/epheterson/zimi/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/epheterson/zimi/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/epheterson/zimi/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/epheterson/zimi/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/epheterson/zimi/releases/tag/v1.0.0
