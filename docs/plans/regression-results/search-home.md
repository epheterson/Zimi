# Regression results: Search, Home and Discover

Tester: search-home lane. Server: test copy at http://10.0.0.14:8977 (reports 1.10.1, asset `zimi-v1.10.1-9caf0066`, container `zimi-regress2`, 78 ZIMs). Its log strings show it carries the regression-pass did-you-mean change (c03fc1d) on top of 1.10.1. Tested 2026-09-22 22:18 to 23:05 PDT in Playwright webkit at 390x844 (DPR 2, iPhone Safari UA) and chromium at 1280x800, plus curl.

Screenshots: `/private/tmp/claude-502/-Users-elp-Repos-zimi/f2b98424-c2c4-4999-a823-ef803e2af907/scratchpad/regress/search-home/` (paths below are relative to that folder). Scripts and logs are in the same folder (`search.js`, `search2.js`, `home.js`, `final.js`, `h21.js`, `*.log`).

Test conditions worth knowing:

- All six testers share one source IP, and anonymous API traffic is limited to 60 requests a minute per IP. Early browser runs hit 429s, so later runs sent the admin password as a Bearer header purely for the 10x rate budget; the page itself never held a token and rendered as a public visitor. That exposed one real bug (search shows "No results found" on a 429, listed below).
- The startup worker was still building title indexes (43/78 at 22:39, 77/78 at 23:00) while I tested. The did-you-mean vocabulary ran twice during that window and hit its budget both times after reading 1 of 60 index files (21k words, then 28k words; "partial build kept in memory, not saved"). The did-you-mean verdicts below describe that state. At 23:02 PDT indexing was still at 77/78 (FTS5 for `wikipedia_fr`), so a clean recheck was not possible before this report.
- One accidental shared-state change, since undone: a synthetic tap-away during the H-21 long-press test landed on a star and favorited `wikipedia_hi`. I removed it with `POST /favorites` about a minute later. `/collections` now shows the original three favorites.

## Broken (ordered by how much a user would notice)

1. **Searching a famous title does not return its article first, and title suggestions hide the English article (S-02, S-03, S-05).** The full-text path gives every title that contains the phrase the same 100-point title score, so Xapian's ordering wins. `/search?q=Albert Einstein` puts "List of things named after Albert Einstein" first; English Wikipedia's "Albert Einstein" is 16th inside its own ZIM, so it misses a 5-per-source API response entirely. In the UI, the phone shows the Stack Overflow profile "User Albert EInstein" above the Wikipedia article (`phone-02-einstein.png`). Cross-ZIM title dedup then drops the English article whenever another ZIM has the same title with a better rank. Typing "Photosyn" never suggests Photosynthesis from English Wikipedia (`phone-s2-suggest.png`): the only "Photosynthesis" row kept is `wikipedia_ar`'s, at 123.2. Typing "Honol" keeps `wikipedia_ru`'s "Honolulu". Repro: `curl '/suggest?q=Photosyn&limit=5'`, or type Photosyn in the box. Expected: English Wikipedia's Photosynthesis. Seen: other titles, and the one "Photosynthesis" hit, when there is one, opens a foreign-language wiki. Cause: `zimi/search.py:1189` `_score_result` (substring = exact, 100 either way); `zimi/search.py:620` single-word title index returns alphabetical order, so the exact title is not rank 0; `zimi/search.py:1213` `_dedup_results_by_title` collapses same-titled results across unrelated ZIMs and languages, not just bundle and subset.
2. **Home filters leave Favorites and collections unfiltered (H-11).** On Home, tap the search box, then tap "Recently added 15". Expected: only the 15 recent ZIMs. Seen: Favorites (Medical Library, Water Treatment, both 7 months old) and Signature Collection (CIA Factbook, Gutenberg, TED...) still render above them (`phone-h11-recent.png`). The same happens with a language pill: Deutsch shows 8 non-German ZIMs plus `wikipedia_de`. Cause: `zimi/static/app.js:3446-3452` renders Favorites whenever `!filter`, ignoring `homeRecentFilter` and `homeLangFilter`. Collections have the same gap.
3. **Search result snippets show raw HTML, CSS and infobox debris (S-21).** Albert Einstein's snippet: `and Albert Einstein (disambiguation) . ... 14 March 1879 <a rel="mw:WikiLink" href="Ulm" t`. Arabic results show `/* start https://ar.wikipedia.org/ */ .mw-parser-output .entete{background-position:...` (`phone-s2-arabic.png`, `phone-02-einstein.png`). Repro: `curl '/snippet?zim=wikipedia&path=Honolulu'` returns `". Honolulu State capital city City and County of Honolulu <div class=\"thumb tm"`. Expected: the lead sentence. Cause: `zimi/previews.py:61` `extract_snippet`. Wikipedia pages have no meta description, so it falls back to `strip_html` over the first 15 KB, which leaves inline styles and escaped markup and then cuts at 300 characters.
4. **The first Escape wipes the query (S-25).** Type "Photosyn" so the dropdown opens, then press Esc once. Expected: the dropdown closes and the text stays. Seen: dropdown closed and query emptied on the first press, in both engines (`search2.log`: esc0 `{"dd":"block","v":"Photosyn"}` then esc1 `{"dd":"none","v":""}`). Cause: the input's keydown handler (`zimi/static/app.js:6404`) hides the dropdown without stopping propagation. The document handler (`app.js:19828-19832`) then sees no dropdown and falls through to `if (q.value) { q.value = ''; ... }`.
5. **A rate-limited search reads "0 results / No results found / Try different keywords".** When `/search?fast=1` returns 429, `doSearch` renders the 429 JSON as an empty result set and never runs the full phase (`s4.js` output: `resp 429 ... {"error": "rate limited"}` then `count: "0 results"`). This affects any household or office behind one NAT on a public instance: one search fans out to about 20 requests (search plus snippets and thumbs on the content bucket), and the API budget is 60 a minute. Cause: `zimi/static/app.js:6497-6499` never checks `r1.ok`.
6. **Did-you-mean is hidden in the UI for 3 to 29 results (S-08).** The server now suggests below 30 results (`_DYM_MIN_RESULTS = 30`, `search.py:1239`), but the client shows the line only when `totalCount < 3` (`app.js:6737`; its comment still says "server already gates on <3"). Repro: search "wikipediaa". The server answers `did_you_mean: "wikipedia"` with 7 to 9 results, and the page shows no correction (`phone-s08-wikipediaa.png`). With 0 results ("wikipedaa") the line appears and tapping it reruns the search (`phone-s08-wikipedaa.png`, `phone-s08-after.png`).
7. **Preferred languages do not scope search (S-17).** With `zimi_pref_languages=["fr"]` set, searching "riviere" sends `/search?q=riviere&limit=10` with no language parameter and returns English, German and Spanish sources (`desktop-s17.png`). `_getPrefLanguages` is read only by the catalog and Manage (`app.js:7367`, `8497`, `8550`, `8687`, `13155`), never by `doSearch`. The 1.7.0 changelog claims it for search.
8. **Language badges clip 3-letter codes into wrong languages (H-14).** `wiktionary_mt` (Maltese, `mlt`) shows "ML", which is Malayalam. `wiktionary_tn` (`tsn`) shows "TS", which is Tsonga. Both Bosnian ZIMs (`bos`) show "BO", which is Tibetan (`home.log` langBadges). Tiles view spells the names correctly (`phone-h14-mt-tile.png`). Cause: `app.js:3586` `lang.slice(0, 2)` on ISO 639-3 codes.
9. **Did-you-mean vocabulary never covered the big ZIMs during the test window (S-09, S-10, S-12).** Both builds stopped at 1 of 60 index files on the loaded NAS. "einstien" (37 results), "fotosynthesis" (8) and "mitochondira" (1) get no suggestion; "wikipediaa" does. The second build logged no further retry. This may clear once title indexing finishes; not rechecked.
10. **Right-click on a search result gets the browser menu, not Zimi's (S-31).** The custom Open in New Tab / Copy Link / Copy Title menu never opens. `contextmenu` is not default-prevented and `#link-ctx-menu` stays closed (`search2.log`). The native menu still covers new tab and copy link. Copy Title is gone. Cause: `app.js:20686` looks for `[onclick*="openArticle"]`, but since 1.9.0 (#49) results are anchors with `onclick="return _spaCardClick(...)"`. The same class of bug is described and fixed for cards at `app.js:5860`.
11. Smaller things seen on the way (not ledger claims):
    - Book of the Day is not stable within a day. `/random?zim=gutenberg&seed=0922` returned two different books across three identical calls, so different browsers see different "daily" books.
    - The On This Day card never shows its date line. `app.js:5361` expects `it.event_text`, but the item built at `app.js:5205` copies no `event_text` or `event_year`.
    - The desktop Discover strip scrolls only with a horizontal wheel or trackpad. Mouse drag and a vertical wheel do nothing, and there is no visible scrollbar.
    - Every query leads with a "Find X on OSM - Hawaii" row, including Arabic, Chinese and a 30-word question. Source pills filter results but the map rows stay.
    - Recent history lists deep-link opens by path ("ce.html", "cover.453", "a-prosthetic-eye-to-treat-blindness") instead of title (`phone-h11-dropdown.png`).
    - The log has `Title index build failed for maps: table titles already exists` at 05:04 UTC (Ops lane).

## Counts

| Verdict | Search (31) | Home and Discover (21) | Total (52) |
|---|---|---|---|
| works | 16 | 13 | 29 |
| broken | 9 | 2 | 11 |
| regressed | 1 | 0 | 1 |
| docs wrong | 1 | 2 | 3 |
| not tested | 4 | 4 | 8 |

## Search

| ID | Verdict | Evidence | Note |
|---|---|---|---|
| S-01 | works | `curl /search?q=water&limit=5`: 211 results from 54 ZIMs | |
| S-02 | broken | `/search?q=Albert Einstein` top: "List of things named after Albert Einstein" 123.7; article missing from the API response; UI puts a Stack Overflow user above it (`phone-02-einstein.png`) | Also "Paris": maps "Paris (city)" first, then "Category:Paris–Roubaix". See Broken 1 |
| S-03 | broken | `/search?q=Photosyn&fast=1`: the only "Photosynthesis" kept is `wikipedia_ar`; English article dropped | Dedup is by lowercase title across all ZIMs, so it collapses unrelated sources and keeps whichever ranked higher, not "the strongest source". Bundle+subset case not testable (no subset installed) |
| S-04 | works | `fast=1` returns `partial:true`; UI painted title hits at 214 ms (desktop, warm), then the FTS indicator; phone cold 6.9 s | First `fast=1` after boot took 22.6 s (cold title DBs) |
| S-05 | works | Dropdown after typing "Photosyn": 1.3 s on phone incl. debounce, 36 ms warm desktop (`phone-s2-suggest.png`) | Suggestions miss the exact article: see S-03 |
| S-06 | not tested | | Needs a server restart (shared server) |
| S-07 | docs wrong | `/search?q=wikipediaa` returns `did_you_mean: "wikipedia"` with 7 results | Ledger says "fewer than 3"; code suggests below 30 (`search.py:1239`). The field itself works |
| S-08 | broken | `phone-s08-wikipedaa.png` (0 results, line shown, tap reruns: `phone-s08-after.png`); `phone-s08-wikipediaa.png` (9 results, server suggests, UI hides) | `app.js:6737` gates on `< 3`. See Broken 6 |
| S-09 | broken | `/search?q=fotosynthesis`: 8 results, `did_you_mean: null` | Vocabulary built from 1/60 index files while indexing ran; see Broken 9 |
| S-10 | broken | `/search?q=einstien`: 37 results, null | Same cause as S-09 |
| S-11 | not tested | Log after the 05:17 UTC restart shows a rebuild, not a load of the 05:09 file | Needs a controlled restart. The rebuild may be correct (the 05:09 file was itself a 3/60 partial) |
| S-12 | broken | Log: `28197 words ... from 1/60 index files ... budget_hit=True`, "partial build kept in memory" | Under a loaded NAS the budget ends inside the first index. Not rechecked after indexing finished |
| S-13 | works | Weak searches returned in 1 to 2 s, same as ordinary ones on this server | Cannot isolate the 50 ms correction budget from outside |
| S-14 | works | "Москва", "北京", "القاهرة", "Zürich": no `did_you_mean`, sensible hits | |
| S-15 | not tested | | Needs a second, restricted account (creating one changes shared state); pinned by tests |
| S-16 | works | `/search?q=eau&lang=fr`: 5 results, only `wikipedia_fr`; UI language pills present | |
| S-17 | broken | `desktop-s17.png`; request has no language filter | See Broken 7 |
| S-18 | works | `/w/wikivoyage` then "water": 18 hits, all `wikivoyage` (`phone-s2-scoped.png`); API `zim=wikivoyage,xkcd` returns only those two | |
| S-19 | works | `/search?q=water&collection=signature-collection`: only its 5 ZIMs; unknown collection returns an error | API only; UI not driven |
| S-20 | works | `/search?q=volcano`: all 174 results have `category` (general, images, video) | |
| S-21 | broken | Thumbnails show on some hits (`desktop-02-einstein.png`); snippets carry raw HTML/CSS (`phone-s2-arabic.png`) | See Broken 3 |
| S-22 | works | Pills left-aligned (first pill at row start), row scrolls (`overflow-x:auto`); one source filter, toggle off, two filters then "All" all behave (`search.log`) | Pills are all "(10)" (per-source limit), so hit-count order is mostly a tie |
| S-23 | works | Volcano pills: "Wikipédia PT", "Wikipédia FR", "Wikipedia ES"; Arabic query: "Wikipedia DE" | |
| S-24 | works | Focus the box on Home: RECENT lists the previous searches (`phone-07-recent.png`) | |
| S-25 | broken | `search2.log` esc1 clears the text | The x button works (value emptied, focus kept). See Broken 4 |
| S-26 | not tested | | Needs two accounts; pinned by tests |
| S-27 | works | `maps` (no full-text index) answers "water", "Honolulu", "Paris" from titles | |
| S-28 | works | "Honolulu" has no `s/NNNN` rows; log: "streetzim_hawaii matched 5 entries the archive cannot read; its results are dropped" | |
| S-29 | works | `/suggest?q=water` and `news`: no captured-site rows, Wikipedia present; captures appear only for their own words (apple, iphone, dracula) | |
| S-30 | works | 20 parallel uncached `/search?q=glacier lake`: every call 30 sources, 123 results; `/health` ok after | No coalescing: calls took 7 to 28 s each |
| S-31 | regressed | Right-click on a result: `defaultPrevented:false`, `#link-ctx-menu` closed | Superseded in part by 1.9.0 native links (#49); Copy Title lost, dead handler at `app.js:20686` |

## Home and Discover

| ID | Verdict | Evidence | Note |
|---|---|---|---|
| H-01 | works | 10 cards: Picture, Today, On This Day, Word, Destination, Book, Quote, Talk, Comic, Country (`phone-dc-0.png` to `phone-dc-9.png`); each opened its article in the reader (`home.log`) | Book of the Day changes between fetches (Broken 11) |
| H-02 | works | `/random?zim=wikipedia&date=0922`: `event_text` "Wilhelm Wattenbach, German historian...", a person link, not a year | The card shows only the name; the date line never renders (Broken 11) |
| H-03 | works | Quote card attributes the quote to "D.J. Butler" (`phone-dc-6.png`) | |
| H-04 | works | At 22:18 PDT the picture is dated Sep 22 (local), not Sep 23 (UTC) | The ZIM (2026-08) has no 2026-09-22 page, so the card falls back to Sep 22, 2025 |
| H-05 | not tested | Fresh browser: Discover filled in 688 ms without a reload | Cold server start needs a restart |
| H-06 | works | Clicked Wikivoyage while 3 skeletons were loading: opened in 607 ms (`phone-h06-source.png`) | |
| H-07 | works | Desktop horizontal wheel moved the strip 538 px (`desktop-h07-strip.png`) | Mouse drag and vertical wheel do nothing; no visible scrollbar |
| H-08 | works | Live moon sprite on the Today card; Cmd-click opened the Almanac in a new tab and left Home in place (`desktop-h08-almanac-tab.png`) | |
| H-09 | works | Sections: Favorites, Signature Collection, 9 categories, Other; favorites starred (`phone-h09-full.png`) | |
| H-10 | docs wrong | Wikipedia card: "21,673,012 entries" (`article_count`; `entries` is 30,142,521); Medical Library "808 entries" | The number is the article count and zimgit falls back to entries, as designed (`app.js:1126`), but the word is always "entries", never "articles" or "documents" |
| H-11 | broken | `phone-h11-recent.png`, `home.log` (23 cards for "Recently added 15") | See Broken 2. At 390 px the pills sit in the search-focus dropdown (`phone-h11-dropdown.png`) |
| H-12 | works | New badges on the 4 ZIMs added in the last week (maps, streetzim_hawaii, reddit_kiwix, YouTube_check); nothing older is badged after two restarts today | Updated half not tested: ZIM folder is read-only |
| H-13 | works | Wikivoyage (3 days old) had no badge after being opened; reddit_kiwix (never opened) kept it; 100r.co (12 days) has none | |
| H-14 | broken | List badges BO / ML / TS for bos / mlt / tsn; no "ALL" badge anywhere; in tiles the star is hidden until hover (0 then 0.4, `desktop-h14-tile-hover.png`) | Broken 8. In list view (the default) the empty star stays visible at 30% |
| H-15 | works | Sort menu: Alphabetical, Recently added, Recently updated, Most articles; order changes and "12d" / "7mo" / "3d" appear only under the date sorts (`desktop-h15-sort-*.png`) | No ZIM has an update, so "Recently updated" shows no dates |
| H-16 | not tested | Long-press, then Move to lists all categories plus "New category…" (`phone-h21-sub.png`) | Saving a move or reorder changes the server-wide layout |
| H-17 | not tested | | Needs a server restart with a large library |
| H-18 | docs wrong | No activity bar exists; `/manage/activity` reports indexing; the gear shows no badge when idle | The bar was replaced by the gear dot in 1.10.0 (#80) |
| H-19 | not tested | Gear has no badge while idle | Needs internet downloads, which change shared state |
| H-20 | works | Reader: X at the gear's slot (x=1228, "Library manager") (`desktop-h20-reader.png`) | On the phone the gear lives in the more-menu |
| H-21 | works | Card at the bottom of a 390 px screen: menu opens upward (534 to 836 of 844), Move to submenu fits (17 to 198 px wide, `phone-h21-sub.png`), tap-away closes it | |
