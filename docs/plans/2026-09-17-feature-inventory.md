# Feature inventory: nothing left behind

Eric, 2026-09-17: "I don't want to lose sight of anything we've ever decided is worth doing. Let's dive into docs and make sure no feature is left behind. What have we discussed built and abandoned, intentionally or unintentionally and get that all sorted into releases as well."

Sources swept: PLAN.md (every unchecked box), docs/plans (release scoping, create-flow design, v18 final push, where-19-stands, v190 test plan, maps vision, true-release-diff, multiuser), the memory notes, open and closed GitHub issues, and the code itself (two TODO-shaped comments, neither a TODO).

Status words: **built** is on a branch with tests; **shipped** is on main; **decided** means Eric said yes and nobody started; **parked** means Eric said later; **killed** means Eric said no, and it stays no.

## 1.10 (branch v1.10-env, 20 commits, not pushed)

Built:

- Env panel: every ZIMI_* variable in effect, secrets masked, coverage test that fails when a new variable is not tabled.
- Offline catalog: shipped snapshot (2,653 entries, 292 KB, 1,055 icons, every entry a magnet derived from Kiwix's own metalinks), cached full catalog on first successful fetch, live replaces cache, cache outranks snapshot. Verified air-gapped.
- Maps first-class: reader renders Kiwix maps2zim and StreetZim maps (hollow-block sweep fixed), position hash `#map=z/lat/lng` on pan, bookmarks carry position, hash edits jump the map, Back and Forward correct, Maps browse category (193 Kiwix maps out of Other), server reads Scraper and Tags so a renamed map still files under Maps, Discover card with a chip per installed map.
- #78 fixed: /w/ deep links no longer stack history; Forward works.
- Search results that cannot be read are dropped instead of shown as paths.
- libtorrent marker gates on architecture as well as Python version, with a reason shown in the BT row.
- Podman (asked for on r/Kiwix, 2026-09-18): README run line with keep-id and :Z, a Quadlet unit under deploy/podman, and a CI job that runs the image rootless and checks file ownership.
- The atomic writer waits out Windows's file-in-use refusal (the flake that cost the 1.9.6 release its Windows leg once).

Before the PR: full pytest with no leftover servers, the browser gate on Eric's phone, NAS deploy, then the PR draft for Eric.

Built after the inventory was first written: the search bar now reaches ZIMs with no full-text index, which is every Kiwix map. maps2zim writes one `search/<Place>` entry per place, so typing a place name finds it on every installed Kiwix map and opening it flies the map there (maps2zim's own `#lat=&lon=&zoom=` redirect; the map's maxBounds may clamp the centre, the place stays in view).

Built the same night, after Eric could not find Danville, CA on the Kiwix world map (maps2zim indexes administrative divisions only; "Danville" is a municipality in Québec): the search bar offers the words to a map's own search box, for maps that have one (StreetZim, AtlasZim), by typing into the box inside the same-origin frame. One tap from "Kailua" in the bar to fifteen results in the map's dropdown.

Still 2.0 with sources: Zimi reading StreetZim's shards itself. StreetZim keeps its places in `search-data/<2-char prefix>.json` shards behind a manifest (139,067 places for Hawaii), not as titled entries, so the title index cannot see them. Cutting through several StreetZim files from Zimi's search bar means reading the shard for the query prefix on the server and returning `{name, lat, lng}` rows that open `#map=`. Worth doing once StreetZim is a catalog source.

## 2.0, the maps and sources release

Eric: "We're on a new major release here maps release and each of those apps of the internet will be its own release too."

- Arbitrary catalog sources (decided): a source is a URL plus a format. Bake in Kiwix OPDS, StreetZim, AtlasZim; accept Internet Archive collections and a plain manifest URL. One catalog tagged by origin, per-source magnets, per-source refresh. The Kiwix community catalog (announced for "a few weeks") becomes one more source. Absorbs the parked "Community backend" note.
- The third source, Eric's words 2026-09-17: "I want to include like a third source for adding sources not more maps." Recommended first: any OPDS catalog URL. kiwix-serve, another Zimi and Project NOMAD all publish the same OPDS feed Zimi already parses, so "add a friend's library" costs a URL field and an origin tag. Second: the Internet Archive, whose advancedsearch API lists ZIM items by collection or query and is where community-uploaded and historical ZIMs actually live (the wayback idea starts there). Map builders (StreetZim, AtlasZim) come after, as sources with a manifest each.
- Custom categories (Eric: "Custom categories"; planned, not designed). Folder categories shipped in 1.9; this is naming and ordering your own.
- Map places in search (above), and a Maps entry in the catalog's category order so a new install sees it.
- Kiwix maps: `#map=` verified on maps2zim output (2026-09-17).
- StreetZim issue #18 (posted): asking for a stable handle and a documented hash format instead of relying on `__szMap`.

## Apps of the internet, one release each (Eric's list)

- Wayback: keep old ZIM versions and diff them. Shdwdrgn on the Kiwix subreddit has 10 TB of old ZIMs. Design doc exists (true-release-diff). Parked by Eric until maps ship.
- Reddot: ArcticZim makes subreddit ZIMs. Wrap its seven-step CLI as a create-flow engine, then a spliced multi-subreddit feed. Parked by Eric.
- ZimiTube: a browsing interface over video ZIMs. `zimi create <video URL>` already makes them. Not designed.
- Peer chat or forums between Zimi instances. mDNS discovery and `/dl/` peer HTTP exist. Genuinely new; not designed.

## Almanac ("I gotta get back to almanac amazingness")

- Date/time editor (decided, four takes rejected 2026-07-20). Five requirements at once: trigger identical to today's header, click to an in-place direct-entry editor, no steppers, everything fits in view, sticks to the top while scrolling, reads and writes in the displayed location's zone.
- Hero moon in the real solar system (Eric, 2026-08-03): phase emerges from geometry, earthshine, libration, apparent size with perigee and apogee. One simulation drives every number on the page.
- Unified scene graph and camera: hop from the moon to any planet or star, a drivable solar system. Ruled in as the 2.0 Time Machine centerpiece, not a dot release.
- Tides (decided 2026-08-03): harmonic constants (M2/S2/N2/K1/O1) per port, real heights offline. Homework first: NOAA publishes US constants, global coverage varies. Non-negotiable framing: inland has no tide, accuracy varies by coast, never presented as navigational authority.
- Sky objects: boats, planes, a whale breaching, shooting stars passing through the simulated sky. Captured, no QA, future.
- Orrery: Venus and Neptune position bugs, a missions panel, spinning globe (PLAN.md, unchecked).
- Period newspaper that re-typesets as you scrub the time control. 2.0, pairs with the LLM work.

## Users and auth

- Auth simplification (parked by Eric 2026-09-16, branch v1.10-rebuilt): nine ways to be trusted become accounts, roles, one secret.
- Users-v2 backlog, in the order recorded: emails on accounts, last-login display, password reset flows, per-user bookmarks and history on the server (currently per-browser; Eric flagged this 2026-07-27 as a promise), kid mode (open ethics question), an anonymous-access policy (public sees everything today, which makes Limited odd), allowlist UI redesign.
- Private-mode content cache: purge the service worker's article cache on logout when mode is private. Deliberate 1.8.1 trade-off, marked 1.9 candidate, never done.
- Per-user backup and restore of bookmarks, history and config (pairs with the backup hub).

## Promises ledger (public or explicit commitments)

- Bookmarks-to-ZIM export v2: v1 ships bare text; v2 carries images and styling so the export resembles the articles. Not started.
- Demo walkthrough GIF replacing screenshots. Not started.
- Windows: make the per-user installer the headline download; Authenticode decision. Not started.
- Onboarding or feature tour ("What can Zimi do?"). Not started.
- Right-click coherence and Define discoverability: scoped in 1.8; verify what shipped before listing again.
- Capture screenshots, live site next to the ZIM, in Create and About (Eric, after 1.9). Not started.
- Folders that physically move files (Eric, after 1.9). Folder categories shipped; verify whether the physical move did.
- Upstream, owed: scraperlib #329 port of wabac.js parseGlobals (benoit74 asked, Eric said yes); scraperlib #338 and #339 and the xlink branch (local, waiting on Eric); wombat #238 (open, supported); warc2zim #476 and #413 comments; StreetZim #18 (posted).
- Reported sites stay in the suite (tests/sites/reported.json).

## Smaller parked items

- Localization: `pl()` pluralization, about fifteen hardcoded strings, a full localization revamp "eventually, not this PR".
- @ and # search tokens with a picker; query-shape ranking. Both parked by Eric after the first cut was reverted.
- #69 update frequency not selectable. Open; needs a decision on whether the schedule is a setting.
- #53 external qBittorrent. Deferred; Eric: skip external BT.
- Create flow 2.0: the engine chooser learns per-domain overrides.
- Catalog: multi-column layout; purge catalog caches on demand; cache management UI (Q-ID and title index sizes, clear buttons); pre-built English Wikipedia Q-ID index hosted for download.
- Reader: reading position resume; related articles; server-side sync.
- Desktop: tabbed browsing in the pywebview app; Windows pywebview app.
- Extensibility: card plugin system (card types in files, ZIMs shipping Discover metadata); ZIM metadata extensions; the extended ZIM format proposal and almanac-as-ZIM.
- 2.0 "Vox": chat with your library, the voice or video librarian. Once the 1.8 hero, now behind maps and sources.
- Kiwix and NOMAD outreach. Parked.

## Killed, and staying killed

- Article Map (v1.6, removed).
- Open-core edition split (Eric killed it; one lean package).
- AI re-ranking of search results (won't fix).
- Voice control (out of scope).
- Routing on maps (out of scope for the maps release).
- @ and # tokens as first shipped (reverted; the picker version is parked, not this).

## Answers Eric asked for alongside

Are places searchable and addressable? Yes for named places. StreetZim ships a place index (`search-data/<prefix>.json`, entries with name, type, lat, lng) and its in-map search uses it; 601 of the Samoa-area entries are address-shaped. Any place is addressable from outside the map by `#map=z/lat/lng`, and a bookmark keeps that. Flying to a street address works when OSM has the address node; Zimi's own search bar does not reach the index yet (the 2.0 item above).

What other map sources exist? Kiwix maps2zim (193 regions, in the catalog, `__openzim_map`), StreetZim (vector tiles plus Sentinel-2 imagery and elevation, built from a web app, not in the Kiwix catalog), AtlasZim and offline-world-map (Leaflet, GeoNames search, satellite imagery, GitHub releases). Organic Maps and CoMaps are apps with their own formats, not ZIMs.
