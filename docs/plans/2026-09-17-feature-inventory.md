# Feature inventory: nothing left behind

Eric, 2026-09-17: "I don't want to lose sight of anything we've ever decided is worth doing. Let's dive into docs and make sure no feature is left behind. What have we discussed built and abandoned, intentionally or unintentionally and get that all sorted into releases as well."

Sources swept: PLAN.md (every unchecked box), docs/plans (release scoping, create-flow design, v18 final push, where-19-stands, v190 test plan, maps vision, true-release-diff, multiuser), the memory notes, open and closed GitHub issues, and the code itself (two TODO-shaped comments, neither a TODO).

Status words: **built** is on a branch with tests; **shipped** is on main; **decided** means Eric said yes and nobody started; **parked** means Eric said later; **killed** means Eric said no, and it stays no.

## 1.10 (branch v1.10-env)

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

Built 2026-09-18 evening on Eric's direction: Zimi reads StreetZim's shards itself (`zimi/mapsearch.py`, a port of the map's own lookup, bounded to twelve chunks a query), places render above the article results and open the map at the place; and StreetZim's 47 regions are in the catalog behind a Kiwix/StreetZim toggle in the Maps category (`zimi/streetzim.py`, Internet Archive listing cached on disk). Zimi Maps as its own surface is the 1.11 direction. StreetZim keeps its places in `search-data/<2-char prefix>.json` shards behind a manifest (139,067 places for Hawaii), not as titled entries, so the title index cannot see them. Cutting through several StreetZim files from Zimi's search bar means reading the shard for the query prefix on the server and returning `{name, lat, lng}` rows that open `#map=`. Worth doing once StreetZim is a catalog source.

Built later the same night, on Eric's next three messages:

- Updates for maps from both sources. A StreetZim file carries its date to the day (`osm-hawaii-2026-09-08.zim`); the date parser reads both shapes, an installed StreetZim map is named `osm-hawaii` and survives an update, `_check_updates` asks StreetZim's own listing for the `osm-` files, and an archive.org update goes through the import path. The StreetZim listing ships as a 2.5 KB snapshot beside the Kiwix one.
- Same place, another map. Eric: "in the maps UI we can change source so I could have multiple and not be limited. Like it uses same GPS position and zoom then swaps out." A topbar button on a map page lists the installed maps, the ones that cover the spot first and the rest under Elsewhere; the position travels only where it can be shown. The server reads each map's bounds from its own config (StreetZim `map-config.json`, maps2zim `content/config.json`) and its publisher from the Scraper metadata, cached with the kind.
- Get a map of here. Eric: "It should offer the one in their region if they share it or worldwide for both or top few by language I guess with a punch out to the full catalog?" A picker, one line per map (name left, whose map or how big right): the installed maps of here, then under "Get a map of here" the catalog's maps that cover the spot (up to three, smallest first) with the planet last in the same list, then the installed maps of elsewhere folded behind one row, then "All maps in the catalog", which opens the Maps category with its toggle. Eric on the first version: "That dropdown is ugly." It was: two lines per row, bordered uppercase headings, a Download word per row, offers below the fold. Coverage of a catalog map comes from `zimi/assets/map-regions.json`, approximate boxes built by `scripts/build_map_regions.py` (Kiwix from Natural Earth admin-0, public domain; StreetZim's 47 regions by hand). "Top few by language" waits for a second language: Kiwix's 193 maps are all `maps_en_` today, and StreetZim's are English.
- A map's own top bar. Eric: "Maps should remove speaker icon and either remove or modify random bookmarks history to be for maps. Think about that whole top bar." On a map: no read-aloud, Reader View or type size (inline or in ⋯); the dice roll a place (StreetZim from its place index, a settlement over an address; Kiwix from its `search/<Place>` pages; the open dice leave maps out); history records the place, so two places on one map are two visits and a row returns there; bookmarks already did. A place on the map already open flies there instead of reloading the map, and Back walks the places with their titles.
- Zimi Maps, the surface (2026-09-19). Eric on the Discover card: "that's not it and the discover thing you built is useless. Maps doesn't feel first class yet"; on a top-bar button: "That's not the right entry either"; asked, he chose "Maps as its own surface now: /#maps full screen with the picker and one search box across installed maps, entered from a Maps tile that sits with the sources grid like a source does." Built: a Maps tile first among the sources (pin icon, the installed maps named); the tile and /#maps open the map you were last on where you were; on a map page the search box is the one box (`/places`: StreetZim from their place index, Kiwix from their place pages, one group per map), Enter takes the first place, a pick flies or opens; the breadcrumb is Maps and links to /#maps; a map keeps the title Zimi gave it. The URL of a map page is still its `?a=` address with the `#map=` position.
- Import back on the Create page (2026-09-19). A user: "I'd like a way to convert warc files within the app's gui." Eric: "Did I remove it because I don't like file paths in the browser flow? That's necessary here right?" It was removed with folder capture because a form that reads a typed server path is a door onto the disk. It is back without the path: the form lists the archives under the import directory (ZIMI_CREATE_ROOT when set, else the library folder; subfolders walked, bounded), the request names one, the server checks the name against the same listing. Primary admin only. Eric: "Allow defining a create or import directory instead of that path and support subdirectories within." A browser upload is the next step if people ask.
- The browser engine that "wasn't installed" (same user). Two causes, both fixed: the renderer cached a negative answer for the life of the process (an install while running never showed until a restart; a no is now re-asked, a yes kept), and the hint said `pip install`, which under uv or another venv installs into the wrong Python (the hint now names the server's interpreter, or the uv command).
- Zimi Tube v1 (2026-09-19 evening). Eric: "Did we start on ZimiTube? Bubble up my TED YouTubes and maybe some others whose structures we know? What's one more we can ship with it?" Built: `zimi/tube.py` reads each video ZIM's own index (ted2zim `assets/data.js`; youtube2zim `videos.json` or `data.js`; Zimi's own `videos.json`, written from 1.10, else the index page's rows), cached per file; `/tube?q=&limit=&offset=` interleaves sources; a video ZIM is known by its scraper (ted2zim, youtube2zim, Zimi + yt-dlp), never by the `_videos:yes` tag Wikipedia carries too; cache records decided before "video" existed are re-read once (`kind_v`). The surface is `/static/tube.html`, a page Zimi owns shown in the reader (so bookmark, history, Back and the X are the reader's), opened from a Tube tile in the apps row beside Maps or from /#tube; the top bar's box drives its search; a card opening a video becomes a real page with history. Untested against a real youtube2zim ZIM (the smallest in the catalog is Khan Academy at 100 GB); the reader is written to its documented shape and falls back through every reader. Then, the same evening, Eric: "keep going and it needs to be called ZimiTube. show zim icons? the layout is bad no space around the text. look at youtube and get creative, like categories and rows and stuff? Sorts? it's popping me into the zim what about a playback experience we own right there? then we can like roll into the next and own the experience more kinda like reader mode for videos." Built as ZimiTube v2: shelves per source with the ZIM icon, chips to one source, sorts (mixed, title, newest, longest), roomier cards with the ZIM icon, and a player Zimi owns: `/tube/play` reads the `<source>`, `<track>` and poster behind the video's own page (every video ZIM writes a plain video element), the page plays it with subtitles, "Up next" beside it, autoplay into the next, and "Open the original page" for the publisher's view. Related videos (by tags, speaker, then embeddings) are the next layer.
- The download badge (#80): the count of downloads on the gear only, while the gear is a gear; on the Downloads tab; in words on the phone's ⋯ Manage row. Nothing for indexing or seeding, nothing on the ⋯ or an X.
- A cold deep link with a place in its hash now lands at the place (the boot rewrote the URL before the map could read it).
- Verified inside Zimi's frame on StreetZim's Hawaii: the geolocate control puts the blue dot and recentres (the URL follows), and turn-by-turn works (Honolulu to Kailua, 18.3 km, 15 min, step list, drive mode). Both are StreetZim's own; Zimi's job was not to break them. In the desktop app, geolocation permission in the frame is untested; the iframe is same-origin so no `allow` attribute is needed in a browser.

Forward design, recorded so 1.11 starts from it:

- Entry points: one lazy-loaded route per app (`/#maps`, `/#tube`, later `/#mail`, `/#bee`, `/#chat`, `/#overflow`) with a Discover card each, the way the Almanac and Create already work. Nothing new on the home page's primary path.
- Zimi Maps (1.11): one MapLibre view owned by Zimi, reading tiles and styles from whichever installed map covers the viewport, so the source switch becomes seamless rather than a page open; one search box across every installed map's index (Zimi already reads StreetZim's shards and maps2zim's place pages); the region and source chooser is the catalog's Maps category inside the app; routing stays StreetZim's until a map-agnostic router exists.
- Eric, 2026-09-18, later: "ZimiMail to compliment ZimiBee forum/bb and ZimiChat and ZimiOverflow threading in real data and live interface. It's like a private interface and it can connect to other Zimi instances or work alone between users on same machine / connecting to the server." And: "Maybe we've really a ZimiStore with various apps and things that can be installed for fun." The store is the entry point for all of it; the catalog is its seed. Not scheduled. And: "Zimibook someday." And, on how all of this gets kept alive: "We're going to need like simulated teams in each of these projects to keep them stable and moving forward eventually." (An agent team per app, each with an owner, a test gate and a release cadence; the orchestration pattern from the 1.9 waves is the seed.)

## 1.10 is the apps release (Eric, 2026-09-19 21:15)

"This next release is apps. Let's nail it." The 1.10 PR waits for three apps in an apps row that exists on a fresh install: Maps, ZimiTube, ZimiExchange (his name question: "ZimiExchange instead? Or still overflow?"; ZimiExchange, because it is every Stack Exchange site, not one). An app with no data opens to what to install and points at the catalog category that feeds it. Maps refinements he named: show all installed maps when there are few, show what covers the viewport, a locate button (system location, else the server's idea of where it is), and turn-by-turn (StreetZim's works inside its page today; Zimi's own view with routing is the 1.11 rebuild). Lists as one primitive: playlists, saved places, reading list; URLs for every list, item and player state. Someday: "all of these become alive between users of the same server or across Zimi instances."

Built the same night (2026-09-19, 21:15 to midnight): the apps row on a fresh install with each empty tile a door to its catalog category; player URLs (`/#tube?play=`); ZimiTube uncapped, one card per talk across ZIMs, shelves alone when browsing, "Top"; the Maps picker reading the view, unfolded when few, "Where I am"; the apps switch per server (`ZIMI_APPS` or Server settings) and per account (`/me/prefs`), never per browser; ZimiExchange v1 (`zimi/exchange.py` sotoki reader, `/exchange/*`, `/static/exchange.html`, `/#exchange?q=`); a Kiwix map told its position in its own hash so a switch lands where you were.

Reddot, the fourth app (2026-09-19, late). Eric: "Love it go" and "We should add it with the ability to make great Reddit Zims." Built: `zimi/reddot.py` wraps ArcticZim (MIT; installed with git into `tools/arcticzim` on first use, 114 MB, 30 s) as a four-step pipeline (retrieve posts, retrieve comments from Arctic Shift, import to sqlite, build) with every line in the job log; `zimi create r/<name>`, `--setup-reddit`, and a Subreddit mode on the Create page. The reader owns the view over ArcticZim's layout (`r/<sub>/top_page_N`, `r/<sub>/<id>/`, `subreddits`), the comment tree from the DIV nesting via HTMLParser. Finding: ArcticZim's retrieval runs at about one post per second from Arctic Shift (r/kiwix, 1,500 posts, ten minutes for posts alone); "great Reddit ZIMs" of a big subreddit will need a faster fetch (Arctic Shift's API pages by 100) before this is more than a small-subreddit tool.

The design pass (2026-09-19, late, into the 20th). Eric: "Love it go then do a pass visually code wise and Jony Ive at the end to really like get to that inevitable design these all ship with, details and all. With joy!" Then, while it ran: "Reddot should be a red dot (or orange or whatever) as the logo", "We should probably also handle deduplocation if we're merging multiple Zims", "Any language or interlang considerations with all this". Done: six-pass review of the four apps from phone screenshots and the fixes it named (ZimiTube shelves alone with sort chips, honest Up next, no-media stage with the link; rows that stop repeating their shelf; no empty shelves; one gutter for a question and its answers; StreetZim maps named by region; placeholders that fit a phone; the red dot; one shared script beside the shared stylesheet). One thing once: `newest_per` (date, then size) on the server and `_newestPer` on the client; a site per title, a subreddit across ZIMs, a region per map source, a source named once on a tile. Languages: the app pages take the shell's language and direction (verified in Hebrew), arrows and chevrons flip, plurals and the votes word in ten languages, collation by the shell's locale, a per-source language label in ZimiTube when the library mixes languages, content keeping its own direction. `docs/features/apps.md` written. Interlang (Q-ID cross-ZIM resolution) does not apply to these kinds; StreetZim's Wikipedia links still point at wikipedia.org rather than the installed Wikipedia, parked for 1.11.

## Eric's direction for maps, 2026-09-18

"I want both maps sources (since it's only maps sources how about a toggle in maps category?) and proper search and all that. In the long run a proper Zimi Maps interface where it's like Google Maps and there's a step to chose the region and sources and use it nicely in there then maybe we limit map search to inside that thing."

So for 1.10: StreetZim's regions in the catalog behind a toggle inside the Maps category (no general sources machinery yet), and place search that Zimi does itself over StreetZim's shards. For 1.11: Zimi Maps, a surface of its own with a region and source chooser, and map search inside it.

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
