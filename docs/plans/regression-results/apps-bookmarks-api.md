# Regression results: Apps and Maps, Bookmarks/History/Collections/Export, API and MCP

Tester run 2026-09-22 against the NAS test copy of Zimi 1.10.1 at http://10.0.0.14:8977 (78 ZIMs, public open, admin password set), plus throwaway local servers from the repo (ports 8951 to 8956, all killed afterwards) for the fresh install, `ZIMI_APPS`, private mode, sign-in, accounts, export and two-builds cases. The MCP server was run over stdio from the repo against a small local ZIM_DIR (devdocs_en_lit, wikipedia_en_test, zimgit-water, medicalsciences.stackexchange, reddit_kiwix, YouTube_check copied from the NAS). Browsers: Playwright webkit at 390x844 @2x with an iPhone Safari UA, and chromium at 1280x800 (plus the crossed pairs where it mattered).

Screenshots: `/private/tmp/claude-502/-Users-elp-Repos-zimi/f2b98424-c2c4-4999-a823-ef803e2af907/scratchpad/regress/apps/shots/` (written as `shots/<name>.png` below). Scripts are next to it (`t*.js`, `mcp_client.py`, `mcp2.py`).

Caveat on load: all six testers share one Mac, so we share one IP's 60/min API budget on the NAS server, and the server was slow at times (a /health took 6.7 s). Browser runs for the apps sent the admin Bearer on API calls only to get out of each other's rate limit; the map picker and account findings were reproduced without it.

## Broken

Ordered by how much a user would notice.

1. **AP-06: opening the map picker asks an anonymous visitor to sign in, and Cancel throws them out of the map.** On any server with an admin password (the NAS test copy, knowledge.zosia.io).
   - Steps: not signed in, open Maps (Hawaii), tap the layers button (Other maps here).
   - Expected: the installed maps, then catalog maps of here, Where I am, All maps in the catalog.
   - Seen: a "Sign in" dialog prefilled with `admin` appears over the map; the picker shows only the installed rows and a "…" that never resolves. Cancel sends you to the home page, and a second Sign in dialog opens. Seen in webkit and chromium. `HTTP 401 /manage/catalog?lang=&count=500&start=0` then `401 /manage/catalog-streetzim`. Evidence: `shots/map_picker_webkit_phone.png`, `shots/picker_after_cancel_webkit.png`.
   - Cause: `_mapOfferItems` (zimi/static/app.js:16874-16892) fetches the catalog through `manageFetch`/`_fetchCatalogItems`, and `manageFetch` opens the sign-in modal on any 401 (app.js:1362-1373), with Cancel calling `goHome()` (app.js:1372). Signed in as admin, the picker works in full (`shots/picker_admin_chromium.png`).
2. **AP-12: ZimiTube leaves out two whole kinds of video ZIM:** current youtube2zim (3.x) ZIMs, and every video ZIM made by Zimi 1.10.
   - Steps: open ZimiTube on the NAS copy. The home tile lists five sources (Linux Experiment, Project Fuel, TED Technology, TED 2020, YouTube check), but the feed has three: `/tube` returns `sources 3`, with no rows from `project-fuel` or `YouTube_check`.
   - YouTube_check (made by "Zimi 1.10.0 + yt-dlp") ships `videos.json` whose `media` is a string (`"media/aqz_KE_bpKQ.mp4"`). `tube.videos_for` then checks `any(_present(archive, m) for m in v["media"])` (zimi/tube.py:273), which iterates the string's characters, finds none present, and drops the video. Locally, `tube.videos_for('YouTube_check')` returns `[]` for the NAS file and one video for the older 1.9 build. The writer puts a string there at zimi/video.py:924.
   - project-fuel is `youtube2zim 3.4.1`. It carries `playlists/*.json`, `channel.json` and `videos/<slug>.json`, but no `videos.json` and no `assets/data.js`, so `_youtube2zim` (tube.py:132-171) finds no rows and every fallback reader fails. Its `/tube/play` says `no media on that page`. The tests only cover youtube2zim 2.3.0.
3. **AP-05: place search on a map opened from a link, bookmark or reload runs a text search and leaves the map.**
   - Steps: open `/?a=streetzim_hawaii%2Findex.html` directly, click the box, type `Kalakaua`.
   - Expected: place rows from the map.
   - Seen: no rows. After 500 ms the page switches to the OSM Hawaii source page, reading "No results found", at `/w/streetzim_hawaii?q=Kalakaua`. Same in webkit phone and chromium desktop, typed or filled (`t4_probe.js` output). The same typing after opening Maps from the home tile works: the address `2255 Kalakaua` flies to z15 21.27687/-157.83032. Evidence: `shots/map_addrrows_webkit_phone.png`.
   - Cause: the map branch of the input handler (app.js:6350-6352) doesn't `return`, so it falls through to `searchTimer = setTimeout(() => doSearch(val), 500)` (app.js:6381) whenever `currentSource` is set, which it is on a cold deep link.
   - Second defect: Enter takes the first row, and the rows are grouped in library order (`find_places`, zimi/search.py:2137), so on the Hawaii StreetZim, `Honolulu` + Enter jumps to the World (Kiwix) map's "Honolulu County" at zoom 8 and leaves the open map. Evidence: `shots/map_places_webkit_phone.png`, `shots/map_honolulu_webkit_phone.png`. The docs say "The box finds a place on the open map".
4. **B-16: a signed-in (non-admin) user who opens their settings gets an admin Sign in dialog over their My data card, and Cancel sends them home.** So Save to server and Restore from server can't be used from the UI.
   - Steps: on a server with users, sign in as a normal user and tap the gear (Manage).
   - Seen: `HTTP 401 /manage/creator/inventory`, then a Sign in dialog over the Users / My data card. Cancel lands on `/`. Evidence: `shots/user_settings_chromium.png`.
   - Cause: `manageFetch('/manage/creator/inventory')` at app.js:10734 runs for users who can't create, and hits the same prompt-on-401 path as item 1. Called directly, the functions work: `saveMyDataToServer()` stored the bookmark (`/userdata` returned it), and a fresh webkit browser signed in as the same user had 0 bookmarks, then `Acrux` after restore.
5. **AP-13 on iPhone: the docked player is drawn wrong, subtitles never show, and tapping the dock misbehaves.**
   - Steps: webkit phone, ZimiTube, play the Bill Gates TED talk, press the header back arrow.
   - Seen: the dock keeps playing, but the ogv.js canvas sits shifted right and clipped past the dock's edge, keeping its stage-sized inline height (205.875 px), in two runs (`shots/dock_webkit.png`, `shots/dock2_webkit.png`). Chromium's dock is fine (`shots/dock_chromium.png`).
   - Tapping the docked video on iPhone returns to the player but pauses it. In chromium, tapping the docked video does not return at all (the native controls take the click); only the title strip does.
   - Subtitles: the ogv path never reads `m.subs` (zimi/static/tube.html:353-375), so TED talks on iPhone have no subtitles. Chromium gets `en:English`. The dock CSS for the ogv canvas is scoped to `.stage` (tube.html:38-39), which `#dock-stage` is not (tube.html:104-105).
6. **API-07: `/article-languages` returns wrong articles as translations.** `/article-languages?zim=wikipedia&path=Water` (Q283) returns:
   - de → `A/Water`, the 2005 film
   - fr → `A/Water`, a disambiguation page
   - es → `Inodoro` (toilet)
   - pt → `Água_(filme)`
   - ru → `Уотер`
   - zh → `水_(消歧義)`

   Only ar `ماء` is right. None of the wrong targets carries Q283. The function claims "only VERIFIED entries".
   - Cause: Strategy 2 accepts a same-title candidate whenever its own Q-ID can't be extracted (`cand_qid is None`, zimi/interlang.py:1439-1444, and `_qid_extract_from_html` returns None for items under 2000 bytes, interlang.py:368). The cross-cache step then stores the source's Q-ID against every match (interlang.py:1465-1471), which poisons the cache for later lookups, which explains the toilet.
7. **AP-15: a talk carried by two TED ZIMs shows twice.** "How bees can keep the peace between elephants and humans" has id 56901 in both `ted_en_playlist-the-most-popular-talks-of-2020` and `ted_en_technology`, and appears as two cards (`/tube?q=elephants`; also visible on the player's Up next). The dedupe key is `(title, speaker)` (zimi/tube.py:503), and the two builds spell the speaker differently (`Lucy  King` versus `King`).
8. **B-14: a collection created or deleted in the UI doesn't appear or disappear until the page is reloaded,** when the service worker is active (localhost or https).
   - Steps: Manage, Collections, type a name, Create.
   - Seen: POST 200, and the re-render still says "No collections yet". The server has it (`{"ui-col":{"label":"UI Col","zims":[]}}`) and a reload shows it.
   - Cause: `/collections` is in neither `NETWORK_ONLY_PREFIXES` nor `NETWORK_FIRST_PREFIXES` in zimi/static/sw.js:93/97, so it falls to `staleWhileRevalidate` (sw.js:126), and the follow-up GET gets the stale copy. The API CRUD itself works.
9. **AP-01: a truly fresh install (no ZIMs) has no Apps row.** A local server with an empty ZIM_DIR shows Discover, then "No knowledge sources found", with no tiles (`shots/fresh_home.png`). With a couple of non-app ZIMs the four "what it needs" tiles appear and open Catalog > Video & Talks (Reddot opens Create) as claimed. Cause: the zero-ZIM branch of `renderHome` returns before `_appsRowHtml()` (app.js:3224-3232 versus 3444). The test pins `_appsRowHtml()` alone.
10. **API-16: `/exchange/*` and `/reddot/*` are not rate-limited.** Exactly 75 back-to-back `GET /exchange/random` all returned 200. Right after, `/tube` and `/chunks` returned 429. Cause: `_RATE_LIMITED_API_PATHS` lists `"/exchange"` and `"/reddot"`, but `_rate_class` tests `path in _RATE_LIMITED_API_PATHS` (exact match, zimi/http.py:161-175, 242). No real path equals `/exchange` or `/reddot`, so every app sub-route (`/exchange/home|site|q|random`, `/reddot/home|sub|post|random`) is unlimited. The tests only assert tuple membership.
11. **API-20: MCP `read_question` and `read_post` reject a path with the ZIM name in front.**
    - `read_question(site="medicalsciences.stackexchange", path="medicalsciences.stackexchange/questions/52/...")` returns `Not a question page: ...`.
    - `read_post(zim="reddit_kiwix", path="reddit_kiwix/r/Kiwix/1n5s13v/")` returns `Not a post page: ...`.
    - `read`, `get_chunks`, `read_with_links` and `article_languages` tolerate the glued form.
    - Cause: neither tool calls `unglue_zim_path` (zimi/mcp_server.py:656-667, 708-719).
12. **API-15: unknown ZIM or article errors come back as HTTP 200, contrary to the documented `404 unknown zim/path`.**
    - `/read?zim=nosuch&path=x` → 200, `{"error":"ZIM 'nosuch' not found. Available: [...every ZIM name...]"}`.
    - `/read?zim=wikipedia&path=NoSuchXYZ` → 200.
    - `/catalog?zim=nosuch` → 200 plus the full list.
    - `/search?q=water&zim=nosuch` → 200 with `error`.
    - By contrast, `/random`, `/snippet`, `/chunks`, `/article-languages` and `/w/` answer 404.
    - Cause: `/read` always returns `self._json(200, result)` (zimi/http.py:1946-1965), and `read_article`/`get_catalog` build the error with the name list (zimi/search.py:2479, 2699). The list is allowlist-filtered, so no private names leak.

Suspected, not counted: **AP-14, a shared `/?tube=` link to a TED talk on iPhone.**
- Steps: cold-open `/?tube=ted_en_technology%2Fthe-incredible-creativity-of-deepfakes-and-the-worrying-future-of-ai` in webkit with the iPhone UA.
- Seen: autoplay is refused (`NotAllowedError`), yet the ogv control shows the Pause icon while nothing plays. In one run, tapping the canvas and the play button (four taps over about 20 s) never moved `currentTime` off 0. In a second run, under heavy server load, it stuck at 6.3 s after resuming.
- The same talk started from a card, a real tap, plays and resumes fine (4.8 → 6.8 s, paused, then 9.6 → 12.6 s).
- Likely cause: `p.play()` in `playWithOgv` (tube.html:370) is not awaited or caught, so the rejected autoplay leaves OGVPlayer's state and the control's icon out of step. Worth a rerun on a real iPhone.

## Apps and Maps

| ID | Verdict | Evidence | Note |
|---|---|---|---|
| AP-01 | broken | `shots/fresh_home.png`; t18 output: 4 `app-empty` tiles on a 2-ZIM library, tube tile opens `/?manage` Catalog > Video & Talks, reddot opens `/#create` | Works with non-app ZIMs; no row at all on an empty library (Broken 9). Row sits first among the sources: `shots/home_webkit_phone.png` |
| AP-02 | works | `ZIMI_APPS=maps,tube` → tiles `['app-empty maps-tile','tube-tile']`; `/#exchange`, `/#reddot` still open their pages; `POST /manage/apps {"shown":["tube"]}` → shell `data-zimi-apps="tube"` without restart, then back to all | Per-account untick not exercised in the UI (test pins it) |
| AP-03 | works | Kiwix World map and StreetZim Hawaii both render tiles; both `kind: map` in /list; `shots/map_honolulu_webkit_phone.png`, `shots/picker_admin_chromium.png` | |
| AP-04 | works | `/?a=maps%2Findex.html#map=8.00/21.45543/-157.96138` in a new tab → `z 8, 21.4554/-157.9614`; `#map=12.00/21.3/-157.85` cold → same | |
| AP-05 | broken | `shots/map_addrrows_webkit_phone.png`, `shots/map_places_webkit_phone.png`; tile path: `2255 Kalakaua` → 2 addr rows, Enter → z15 21.27687/-157.83032 | Broken 3: cold links run a text search; Enter can jump to another map |
| AP-06 | broken | `shots/map_picker_webkit_phone.png`, `shots/picker_after_cancel_webkit.png`; admin: `Hawaii ✓ / World / MAPS OF HERE Hawaii, Pacific Islands, Australia and Oceania / Locate me / Catalog`, switch World ↔ Hawaii keeps `12.00/21.3000/-157.8500` | Broken 1. Also: "Maps of here" offers Hawaii for download although it is installed (the installed file is renamed `streetzim_hawaii.zim`). Rows are labelled "Locate me" and "Catalog", not "Where I am" / "All maps in the catalog" as the docs say |
| AP-07 | works | `/manage/catalog-streetzim` → 55 items, `source: cache`, e.g. `osm-hawaii-2026-09-20.zim` | |
| AP-08 | works | Map top bar: tts, Reader View, font hidden; layers shown. Dice on desktop → `Pearl and Hermes Reef` z14; on phone via ⋯ → `Royal Hawaiian Estates`; history entries carry `pos`; a map bookmark at 15/21.27687/-157.83032 reopens there after panning away | Cold-link bookmark title is "Hawaii", not the place |
| AP-09 | works | Fresh browser, Maps tile → settles at `7.0/20.92/-156.67` (over Maui), 1 s after a brief `6.0/23.50/-166.50` box centre; `shots/map_tile_open_webkit.png`; after visiting, the tile reopens the last map at the last place | |
| AP-10 | not tested | `/manage/check-updates` → `{"updates":[],"count":0}` | The only StreetZim installed is renamed (`streetzim_hawaii.zim`, 2026-09-08) while the listing has `osm-hawaii-2026-09-20`. `_check_streetzim_updates` matches by filename prefix `osm-` (zimi/library.py:3202), so a renamed StreetZim never gets updates. Couldn't install an old map on the read-only share |
| AP-11 | works | `tiles/12/252/1799.pbf` → `application/x-protobuf`; Kiwix `.webp` → `image/webp` | Side note: StreetZim asks for `/w/wiki-qid-titles.json`, which answers 200 with the SPA HTML |
| AP-12 | broken | `/tube` → `sources 3` (no project-fuel, no YouTube_check); local `tube.videos_for('YouTube_check')` → `[]` | Broken 2 |
| AP-13 | broken | Chromium: plays, `en:English` track, Up next, Autoplay ✓, `pip` and `theater` buttons, theater toggles, dock keeps playing 9.6 → 11.6 s (`shots/tube_play_chromium_desktop.png`, `shots/dock_chromium.png`) | Broken 5 (iPhone dock drawing, no subtitles on the ogv path, dock tap) |
| AP-14 | works | webkit iPhone UA, card tap: `OGVJS` currentTime 0.1 → 7.1 s over 8 s; pause/resume works; webkit desktop gets OGVJS too | See the suspected cold-shared-link problem under Broken |
| AP-15 | broken | `/tube?q=elephants` → id 56901 twice, from two ZIMs | Broken 7 |
| AP-16 | works | `/tube/play?...crispr-s-next-advance...` → `missing: true`; `/tube?q=crispr` doesn't list it | |
| AP-17 | works | 10 shelves with top tags; onions question: scores `158✓, 172, 100, 65...` (accepted first); tag `[onions]` list `1 / 15`, More → 30 rows; box `onion` → titles across sites (`shots/ex_q_webkit_phone.png`, `shots/ex_search_chromium_desktop.png`) | Back from a search leaves "onion" in the box. The question view has no asker name ("asked by unknown" in MCP too) |
| AP-18 | works | One subreddit opens on r/Kiwix list; Top and New differ; Follow → `reddot_follow ["reddit_kiwix\|Kiwix"]`, Home chip lists top posts; post shows 26 comments nested 12 deep (`shots/rd_post_chromium_desktop.png`) | |
| AP-19 | works | Exchange: question → Open the original page (`/?a=cooking...`) → Back → question → Back → app home (no arrow); search list → Back → home; dice stays in app for ZimiTube (plays), ZimiExchange, Reddot | On the phone the dice is in the ⋯ menu |
| AP-20 | works | Private local server, signed out: `/?tube=`, `/?reddot=`, `/?exchange=` each show the gate; after sign-in the same item opens (webkit and chromium); chromium video advances to 3.8 s | |
| AP-21 | works | Bookmarks panel rows `... / ZimiTube`, `... / ZimiExchange`, `... / Reddot`; history `app=exchange`; opening each from Bookmarks reopens it in its app (`shots/rd_bmpanel_chromium_desktop.png`) | Race: bookmarking within about 1 s of a cold `/?exchange=` load saved the title "ZimiExchange" instead of the question |
| AP-22 | works | Arabic: shell and app frames `dir=rtl lang=ar`, chrome strings translated (`الكل`, `متابعة`) for all three apps (`shots/rtl_tube-tile_webkit_phone.png`) | Shelf "All ›" chevron still points right in RTL |
| AP-23 | works | Local: nopic 2026-01 plus all 2026-02 of medicalsciences → one shelf; two reddit_kiwix builds → one shelf | Maps case not tested (one map per source). `/list` also shows only the newest of two same-named builds, while the docs say "The library itself lists every file" |
| AP-24 | works | project-fuel (`youtube2zim 3.4.1`) and YouTube_check (`Zimi 1.10.0 + yt-dlp`) are `kind: video` in /list | Recognised correctly; they're still left out of the feed (AP-12) |

## Bookmarks, History, Collections, Export

| ID | Verdict | Evidence | Note |
|---|---|---|---|
| B-01 | works | Panel History: `photosynthesis · All Sources · 16 results`, Steam, Ice, Water; Bookmarks tab lists them (`shots/bm_history_chromium_desktop.png`) | |
| B-02 | works | Inline New folder "Science"; pointer drag of Water onto it → `Water@f_...`; collapse survives reload (`aria-expanded=false`, count 1); right-click and touch long-press menus `Open / Move to… / Rename / Remove bookmark`; ArrowDown moves focus to the next row (`shots/bm_folder_chromium_desktop.png`) | |
| B-03 | works | Rename to "Frozen", then clear and Enter → back to "Ice"; ArrowLeft and Space while editing stay in the input (`My fa v`) | |
| B-04 | works | Prompt `Delete "Trip"? It holds 1 bookmark(s).` / keep / delete all; keep → Water at top level (`shots/bm_delprompt_chromium_desktop.png`) | |
| B-05 | works | Row reads "Source no longer installed"; clicking it keeps the reader closed (`shots/bm_ghost_chromium_desktop.png`) | |
| B-06 | works | Reading Water, bookmark button opens the panel over the article on the Bookmarks tab; Esc closes the panel, the reader stays; picking Ice navigates in place (webkit phone and chromium) | |
| B-07 | works | Fresh webkit browser signed in as `tester`: 0 bookmarks; after restore: `['Acrux']` | Done through the functions because of B-16's dialog |
| B-08 | works | Local export "My Trip: Docs/Wiki!" → `My_Trip_Docs_Wiki.zim`: index with sections Lit docs, Wiki, and "Empty one" (`No bookmarks in this folder.`), articles with inline style; a second export carried `_assets/.../thumbs/*.webp`, SE images and SVGs | Opened with libzim (the Kiwix reader library), not the Kiwix GUI |
| B-09 | works | Zero bookmarks: no Export button; only-empty folder ticked: Export disabled, "Nothing to export: the selected folders have no bookmarks." (`shots/export_empty_sel.png`) | The ledger says "disabled"; with no bookmarks the button is absent instead |
| B-10 | works | Links to non-exported devdocs pages become unlinked anchors titled "Not in this export - this article is in the devdocs_en_lit ZIM"; no href dangles; NAS `/resolve?url=https://en.wikipedia.org/wiki/Water` → `wikipedia A/Water` | The Wikipedia link round trip wasn't exercised inside an export (no local Wikipedia with links). A devdocs page's own canonical `https://lit.dev/...` opens the web, because /resolve doesn't know lit.dev |
| B-11 | works | Server `{"phase":"done","done":3,"total":3}`; /list has the new ZIM immediately after done, no rescan | The UI went `Building ZIM… (0/3)` → `Created 1 ZIM`; with a small export, the final count never shows before closing |
| B-12 | works | Create page Bookmarks mode: "The pages you saved, packaged as one ZIM ... Saved 1 ... Choose folders…" (`shots/create_bookmarks.png`) | |
| B-13 | works | Card: `4 entries · 88.0 KB · 2026-09-22`, NEW badge | |
| B-14 | broken | API: create, scoped search (`labs` → only devdocs_en_lit; `acrux` → none), update, delete, 404 on unknown | Broken 8 (UI stale via the service worker). The API accepts a collection of nonexistent ZIMs |
| B-15 | works | Star Wikipedia Test → first card; survives reload; server `favorites: ['wikipedia_en_test']` | |
| B-16 | broken | Admin: My data export (`scope my-data`) imported on the Server card → "That's a My data backup - import it in the My data card."; server bundle → preview "Review these changes before applying"; My data import merges (`Bookmarks: 1 merged, 0 duplicates skipped`) | Broken 4: signed-in users hit an admin sign-in dialog |
| B-17 | works | Signed in: "...Save to server keeps a copy in your account on this Zimi server..."; not signed in: "...Export a copy to a file to back them up." (`shots/mydata_signedin.png`) | |

## API and MCP

| ID | Verdict | Evidence | Note |
|---|---|---|---|
| API-01 | works | `/search?q=python+asyncio&limit=5` 200 (6.2 s cold); zim, fast, lang=fr, collection all honoured; missing q → 400 | |
| API-02 | works | `/read?zim=wikipedia&path=A/Water&max_length=200` → `truncated: true` | |
| API-03 | works | `/suggest?q=photo` 200 | Took 17.5 s on the 78-ZIM library |
| API-04 | works | /list has `article_count`, `first_seen`, `updated_at`, `language`; `?layout=1` gives the envelope | The ledger says /list carries Q-ID support; it doesn't (`has_qids` appears only on search results) |
| API-05 | works | `/random?zim=wikipedia` 200; unknown → 404 | |
| API-06 | works | `/snippet` 200 with snippet; missing params → 400; unknown zim → 404 | |
| API-07 | broken | `/languages` fine; `/article-languages` returns wrong targets | Broken 6 |
| API-08 | works | `/catalog?zim=zimgit-water` lists PDFs; missing zim → 400 | |
| API-09 | works | POST, update, DELETE; DELETE unknown → 404 | |
| API-10 | works | GET resolve → `A/Water`; batch POST of 3 URLs → found/not found each | |
| API-11 | works | NAS `/health` `zim_count 78`, version 1.10.1; local private mode `/health` 200 `zim_count 6` while `/list` is 401 | |
| API-12 | works | `If-None-Match: "104ec7145bedd35b"` → 304 | |
| API-13 | works | default 1200/120; size 50 → 200, 5000 → 4000; stable IDs across calls; `content_rev`; `truncated`; 400/404; 429 seen during the burst | |
| API-14 | works | `openapi 3.1.0`, `info.version 1.10.1` = /health; unauthenticated 200 on an open server; 19 paths including the tube, exchange, reddot and map-home routes | 401 in private mode |
| API-15 | broken | See Broken 12 | Error text is generic otherwise; no stack traces seen |
| API-16 | broken | `/tube?q=climate` works and is limited; the /exchange and /reddot sub-routes aren't | Broken 10. Also: `/exchange/q` without q → 404 (not 400), `/reddot/sub` without the required `r` → 200 `{"rows":[],"pages":0}` |
| API-17 | works | stdio handshake `serverInfo name=zimi version=1.10.1` in 7.8 s; empty ZIM_DIR handshake clean with 17 tools | About 3.5 s of that is importing the `mcp` package itself |
| API-18 | works | All 17 tools called and answering (`mcp_out.txt`): search with language and collection, read, get_chunks, suggest, list_sources, random, article_languages, read_with_links, deep_search, list_collections, manage_collection create/delete, manage_favorites add/remove | README and api-and-mcp.md call the filter `lang`; the tool parameter is `language`. Did-you-mean returned nothing on the tiny local set (vocab 0 words at the time) |
| API-19 | works | list_videos, list_questions (sites, page 1 of 100, tag `eye`), read_question (accepted first), list_posts (top and new), read_post (tree) | read_question prints "asked by unknown" on the real medicalsciences ZIM |
| API-20 | broken | read, get_chunks, read_with_links, article_languages accept `zim/path`; read_question, read_post don't | Broken 11 |
| API-21 | works | `mcp 1.26.0` installed; pyproject pins `mcp>=1.0,<2.0`; FastMCP stands up | |
| API-22 | docs wrong | The SearXNG guide's engine fields (`zim`, `path`, `title`, `snippet`, `score`) match live `/search` JSON (SearXNG itself not run) | docs/integrations/openwebui.md says `deep_search` is "multi-hop search that follows article links" (it reads the top results), and that `read_with_links` gives "cross-language links" (it's cross-ZIM links); it also omits the five app tools |
| API-23 | works | `python3 -m zimi search/read/suggest/list` all answer against a local ZIM_DIR | |
| API-24 | works | Two searches for `regressprobezz` → `top_searches` count 2; `/manage/usage` needs admin (401 without) | |

## Counts

| Verdict | Apps and Maps | Bookmarks etc. | API and MCP | Total |
|---|---|---|---|---|
| works | 17 | 15 | 19 | 51 |
| broken | 6 | 2 | 4 | 12 |
| regressed | 0 | 0 | 0 | 0 |
| docs wrong | 0 | 0 | 1 | 1 |
| not tested | 1 | 0 | 0 | 1 |
