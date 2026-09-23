# Regression results: Reading (R-01 to R-60)

Tested 2026-09-22 against the 1.10.1 test server at http://10.0.0.14:8977 (78-ZIM library), Playwright webkit at 390x844 (iPhone UA, dsf 2) and chromium at 1280x800. Screenshots are in `/private/tmp/claude-502/-Users-elp-Repos-zimi/f2b98424-c2c4-4999-a823-ef803e2af907/scratchpad/regress/reading/` (paths below are relative to that folder). Test scripts are in the sibling `rt/` folder.

Counts: works 42, broken 13, regressed 1, docs wrong 1, not tested 3 (60 claims).

## Broken

Ordered by how much a reader would notice.

1. **R-27 (regressed) Tap-to-zoom does nothing for the first 15 seconds of every article.**
   - Steps: open `/?a=wikipedia/Water` (phone or desktop), tap the H2O diagram within 15 s of the page loading.
   - Expected: lightbox opens. Seen: nothing. The same tap at 19 s opens it (`r27-phone-after-16s.png`; `phone-r27-raw-lightbox.png` is the dead tap).
   - Cause: the captured-site wall sweep `_sweepBlockingOverlays` (app.js:20597, watching for `OVERLAY_WATCH_MS` = 15000, app.js:20393) removes any `position:fixed` element covering 55% of the viewport. Zimi's own lightbox overlay (app.js:15314, `position:fixed;inset:0`) matches, so it is removed in the same tick it is added. Traced: `_readerOpenLightbox` runs, a MutationObserver sees `+zimi-img-lightbox` then `-zimi-img-lightbox`, removal stack is `sweep` (app.js:20605) from the observer at app.js:20624. It runs on every ZIM, not just captures. Reader View has the same exposure (its lightbox is the same overlay).
2. **R-14, R-15 The language globe opens the wrong article in other languages.**
   - Steps: open `/?a=wikipedia/Water`, globe, click the switch arrow next to Français (or Español, Português, 中文).
   - Expected: "Eau", "Agua", etc. Seen: `/article-languages?zim=wikipedia&path=Water` returns fr `A/Water` (the French disambiguation page, `r14-water-fr.png`), es `Inodoro` (toilet), pt `Água_(filme)` (a film), ru `Уотер`, zh `水_(消歧義)` (disambiguation). `wikipedia_fr/Eau` offers English `A/Tetrahedral_symmetry`. `Mercury_(element)` offers only Hindi, no French. Jerusalem works for fr/he/ru/zh/pt but es is the disambiguation page.
   - Cause: interlang.py Strategy 2 (around line 1418) accepts a same-title entry whenever the candidate has no Q-ID to compare (`cand_qid is None`), which is every article in the mini/nopic Wikipedias here (none of `wikipedia_fr/Eau`, `wikipedia_es/Inodoro`, `wikipedia_zh/水` contain a wikidata link). The cross-cache block right after (around line 1450) then stores that guess under the source's Q-ID, so the wrong match becomes a "verified" Q-ID row for every later lookup and the reverse hop. The docstring promises "only VERIFIED entries".
3. **R-30 (also R-17, R-23) On desktop the first article's ⋯ button is stuck as "Read aloud".**
   - Steps: desktop, open any article by deep link or from search results (`/?a=wikipedia/Water`).
   - Expected: ⋯ opens a menu with Reader View and Read aloud. Seen: the ⋯ slot shows a speaker icon labelled "Read aloud" (`d-water.png`, `r08-fragment.png`); clicking it starts speech. Reader View is unreachable on that article (the book button is CSS-hidden while reading, app.css:517). After following one in-article link the ⋯ is correct (`desktop-menu-after-link.png`). On a PDF opened first, the same stale button offers Read aloud on the PDF (`desktop-r38-pdf.png`, label "Lire à voix haute" in French), which R-23 says must not happen.
   - Cause: the one-item rule `_syncTopbarMoreSolo` runs only inside `updateTopbar` (app.js:1789), before the new frame has loaded, so it judges the previous (or empty) document; the frame-load path calls `_syncReaderViewBtn` (app.js:15709) but never re-runs `_syncTopbarMoreSolo`. At rest `_topbarMenuSoloItem()` returns null while the button still says "Read aloud".
4. **R-25 Define shows the wrong entry for common words.**
   - Steps: desktop, select "process" in `/?a=wikipedia/Photosynthesis`, click Define.
   - Expected: "A series of events which produce a result". Seen: "Obsolete spelling of Prozess ... 1902" (German entry "Process", `r25-define-desktop.png`). "energy" gives "(low register) a serving of an energy drink" (`r25-define-in-rv.png`), "system" gives "(geology) period" (`r26-phone-card.png`). The ledger's own word "photosynthesis" works because it has no capitalized homograph.
   - Cause: `_defineRun` (app.js ~20267) matches the suggestion title case-insensitively and takes the first hit; `/suggest?q=process&zim=wiktionary` returns `Process` and no lowercase `process` at all (same for `house` -> `House`), though `/w/wiktionary/A/process` exists. An exact-case lookup of the lowercased word first would fix it.
5. **R-02 A raw `/w/` URL shows a bare page on a plain-HTTP LAN address.**
   - Steps: open `http://10.0.0.14:8977/w/wikipedia/Water` in a new tab (chromium or webkit).
   - Expected: Zimi boots on the article. Seen: the raw article with no Zimi chrome, URL unchanged (`r02-raw-w.png`).
   - Cause: http.py ~2618 serves the SPA shell only when `Sec-Fetch-Dest: document`; browsers send no `Sec-Fetch-*` headers to non-secure origins (verified: both engines send none to this origin). The NAS LAN URL (`http://knowledge.zosia.lan`) is plain HTTP too. HTTPS and localhost were not tested (off limits).
6. **R-28, R-29 Print / Save as PDF and Share cannot be reached.**
   - Steps: open an article, turn on Reader View from ⋯, look for Print or Share (phone with `navigator.share` stubbed present, and desktop).
   - Expected: Print and Share rows. Seen: ⋯ holds Reader View, swatches, Serif/Sans, A-/A+, Read aloud and nothing else (`r28-r29-phone-menu-rv.png`, `r17-rv-menu-open.png`); `.rv-action-row` count 0; the book button that opens the full palette is hidden (`offsetWidth` 0).
   - Cause: Print, Share and the in-article Auto switch live only in `_readerSettingsRowsHtml` (app.js:15884-15900), the palette opened by `#readerview-btn`, and `body.reading #readerview-btn {display:none !important}` (app.css:517-518) hides that button whenever an article is open. The compact controls in ⋯ (app.js:15845) omit them.
7. **R-39 Switching language while a PDF is open does not relocalize the viewer (except back to English).**
   - Steps: open `/?a=zimgit-medicine/files/First Aid and Medicine (2).pdf` in English, switch the UI to Deutsch (or Français).
   - Expected: "1 von 544". Seen: "1 of 544"; frame URL gains `#locale=de` but the viewer does not reload (`r39-pdf-switch-to-de.png`). Opening a PDF with French already set works ("1 sur 544", `r39-pdf-opened-in-fr.png`), switching FR to EN works, and a reload shows German.
   - Cause: app.js:963 calls `location.replace(_pdfViewerUrl(...))`; when the only difference is the `#locale=` fragment this is a same-document navigation, so pdf.js never re-reads its locale.
8. **R-45 A TED talk whose video is missing shows a dead player, not "not included in this ZIM".**
   - Steps: open `/?a=ted_en_technology/crispr-s-next-advance-is-bigger-than-you-think` (its `videos/115190/video.webm` answers 404).
   - Seen: desktop shows video.js's "The media could not be loaded, either because the server or network failed or because the format is not supported" (`desktop-r45-missing.png`); iPhone webkit shows a poster with an empty play box (`r45-missing-video.png`). No Zimi message in either.
   - Cause (likely): video.js with the ogv.js tech owns the element (`.vjs-tech` present, webkit has no `<video>` at all), so `_bindVideoError` (app.js:15464) either finds no `<video>` or never sees the error it listens for.
9. **R-58 Random on a captured site usually leaves the site.**
   - Steps: open `/?a=www_cnn_com`, press the dice four times; repeat on `www_apple_com_site`.
   - Seen: CNN went to reddit_kiwix, electronics.stackexchange, medicalsciences.stackexchange, devdocs_en_nginx; Apple stayed three times, left once to devdocs_en_postgresql. `/random?zim=www_cnn_com` returned `{"error":"no articles found"}` 7 of 7 times; `100r.co` 2 of 3 times, `www_apple_com_site` 2 of 3.
   - Cause: http.py ~2438 gives every ZIM that is not Wiktionary/Gutenberg/Wikiquote exactly one `random_entry` try; in a capture most entries are assets, so the single try usually misses and the client falls back to a library-wide roll.
10. **R-26 The Define popover does not dismiss on scroll in Wikipedia articles.**
    - Steps: select a word, popover opens, scroll the article with the wheel (desktop) or programmatically (phone).
    - Seen: article body scrolled 0 -> 400 and 747 -> 1147; popover still open. Clamping to the viewport works (`r26-phone-card.png`).
    - Cause: these articles scroll on `<body>` (overflow auto), and element scroll events do not bubble to the window; the only frame listener is `frame.contentWindow.addEventListener('scroll', ...)` without capture (app.js:20671).
11. **R-16 No Q-ID badge anywhere.**
    - `/list` has no `has_qids` key for any ZIM; `/search` reports `has_qids: false` even for `wikipedia` (en maxi, whose articles carry Q-IDs); `.qid-badge` count on home is 0. Cause not confirmed: the flag is set by the startup pass `_build_all_qid_indexes` (interlang.py:824, called from server.py:4676); it may not have run or finished on this instance.

Also seen, not ledger claims:
- A deep link to an article that does not exist in a regular ZIM shows raw JSON in the reader: `{"error":"Entry 'No_such_article_zzqx' not found in wikipedia"}` (`x-missing-entry-json.png`). Captured sites and deleted sources get the styled prose page; ordinary ZIMs do not, because `/w/wikipedia/<missing>` answers 404 JSON even with `Accept: text/html`.
- Reader View draws two horizontal rules under the title on every article (`r17-rv-default.png`, `p-ar-water-rv.png`).
- Captured CNN pages throw `ReferenceError: imageLoadError` dozens of times (onerror handlers from the scripts the capture dropped). Harmless, noisy.
- With Zimi dark and Simulate dark mode on, `www_cnn_com` paints light and undarkened, with a washed-out hero image (`r33-on-www_cnn_com.png`). Probably judged as declaring its own dark mode; worth a look.

## Results

| ID | Verdict | Evidence | Note |
|---|---|---|---|
| R-01 | works | `d-water.png`, `p-photosynthesis.png` | One topbar, article in reader |
| R-02 | broken | `r02-raw-w.png`; request headers show no `sec-fetch-dest` | See Broken 5. Back/Forward after boot via `/?a=` works (Water -> Ice -> Back -> Forward) |
| R-03 | works | `r03-after-close-reload.png` | Close -> `/#`, reload shows home (stray `#` in URL) |
| R-04 | works | `r04-trail.png` | Press-hold shows Glacier/Ice/Water, release on Water opens it. Touch long-press not testable headless |
| R-05 | works | new-page events for middle-click on a result and a Discover card | Results, tiles, cards are anchors with `/?a=` or `/w/` hrefs |
| R-06 | works | `r06-new-tab.png` | Cmd-click opened a new tab with search box and reader |
| R-07 | works | `r07-ready-gov-hop2.png` | www.ready.gov (baseURI https://www.ready.gov/): home -> floods -> be-informed, no doubled path |
| R-08 | works | `r08-fragment.png` | `#os.stat` in devdocs Python os page jumps at once, no overlay |
| R-09 | works | `302 -> /w/devdocs_en_bash/index#test` | HTTP; markdown devdocs not installed, used bash |
| R-10 | works | `r10-ar-redirect.png` | `wikipedia_ar/مياه` opens `ماء` |
| R-11 | works | `r11-xzim-open.png` | stackoverflow.com link in Wikipedia "Stack Overflow" opened the SO ZIM |
| R-12 | works | `r12-xzim.png`; computed `text-decoration-style: dotted` | 3 links marked |
| R-13 | not tested | | Needs deleting a ZIM; ZIM folder is read-only and shared |
| R-14 | broken | `/article-languages` output; `r14-water-fr.png` | See Broken 2 |
| R-15 | broken | `/article-languages` output; `r15-mercury-globe.png`, `r15-jerusalem-he.png` | Hebrew match works for Jerusalem; false positives elsewhere |
| R-16 | broken | `/list` keys, `.qid-badge` count 0 | See Broken 11 |
| R-17 | works | `r17-rv-default.png`, `r17-rv-table.png`, `p-ar-water-rv.png`, `p-he-jerusalem-rv-scrolled.png`, `p-zh-water-rv.png` | Navboxes/infobox gone, wide table in a scrolling wrap, RTL kept, 390 px no overflow. Unreachable on desktop's first article (Broken 3); double rule under title |
| R-18 | works | `r18-theme-dark.png`, `r18-theme-light.png`, `r18-theme-sepia.png`, `r18-theme-auto.png` | Auto in light = sepia (244,236,216) |
| R-19 | works | stepper S/M/L/XL, zoom 0.85-1.3, A+/A- disable at ends; `r19-size-xl.png` | Only inside Reader View; the raw-article size button is hidden on every viewport |
| R-20 | works | `r20-serif.png` | Serif applies to p and h1/h2 |
| R-21 | works | Ice, Glacier, in-article link and reload all open in Reader View | Dark OS: no white frame during load (frame bg sampled) |
| R-22 | works | `r22-pdf-auto.png`, `r22-thin-xkcd.png` | PDF viewer and thin xkcd page skip Reader View with Auto on |
| R-23 | broken | `desktop-r38-pdf.png` | Phone PDF and both maps are clean; desktop PDF opened first shows Read aloud (Broken 3) |
| R-24 | works | speak calls with `lang` ar/zh, chunked; Stop resets state; row hidden when the API is removed (`r24-no-speech-menu.png`) | Audio itself not verifiable headless |
| R-25 | broken | `r25-define-desktop.png`, `r25-define-in-rv.png` | See Broken 4. Popover works in Reader View and follows Wiktionary |
| R-26 | broken | `r26-phone-card.png`; scroll log | Clamp works; scroll dismissal fails (Broken 10) |
| R-27 | regressed | `phone-r27-raw-lightbox.png`, `r27-phone-after-16s.png`, `r27-lightbox-rv.png` | See Broken 1 |
| R-28 | broken | `r28-r29-phone-menu-rv.png`, `r17-rv-menu-open.png` | See Broken 6 |
| R-29 | broken | same | Unreachable; native sheet itself not testable headless |
| R-30 | broken | `d-water.png`, `desktop-menu-after-link.png` | Once unstuck: Reader View + Read aloud once each, X far right, no Random/Language rows. See Broken 3 |
| R-31 | works | `r31-auto-darkos.png`, `r31-light-on-darkos.png` | Light on dark OS, survives reload |
| R-32 | works | `r32-water-dark.png` | Dark Zimi on light OS: MediaWiki article dark |
| R-33 | works | `r33-on-xkcd.png`, `r33-off-xkcd.png`, `r33-on-draculatheme_com.png` | xkcd darkened on / not off; dracula keeps its own dark. CNN oddity noted above |
| R-34 | works | `r34-prefs-after.png` | Unticked, went home, Discover ran, reopened Manage: still unticked |
| R-35 | works | `r35-math-dark.png` | Formulas inverted, legible |
| R-36 | works | scrollWidth 390 on Photosynthesis, country list, US, ar, he, zh at 390 px | |
| R-37 | works | `desktop-r38-pdf.png`; download `First Aid and Medicine (2).pdf`, 13,726,441 bytes, `%PDF-` | Tab title is the document title "A Book for Midwives" |
| R-38 | works | `desktop-r38-pdf.png`, `phone-r38-pdf.png` | 544 pages, rendered |
| R-39 | broken | `r39-pdf-opened-in-fr.png`, `r39-pdf-switch-to-de.png` | See Broken 7 |
| R-40 | not tested | | WAN/Cloudflare is the live server, off limits |
| R-41 | works | `phone-r41-zimgit-list.png`, `desktop-r41-zimgit-filter.png` | 12 documents, author and size shown, filter "midwives" -> 1 |
| R-42 | works | small PDF `200 application/pdf`, no attachment disposition | 413 path not tested: no PDF over 50 MB located |
| R-43 | works | browser download name `The Journal of Leo Tolstoi (First Volume<U+2014>1895-1899).46272.epub` with the U+2014 intact, 404,475 bytes; header has `filename*=UTF-8''` | Gutenberg ZIM is English-only; U+2014 in the title is the non-ASCII case available |
| R-44 | works | `Range 0-99 -> 206, Content-Range bytes 0-99/172230710`; no Range -> 200, 172,230,710 bytes | TED 2020 playlist video |
| R-45 | broken | `desktop-r45-missing.png`, `r45-missing-video.png` | See Broken 8 |
| R-46 | works | chromium: seek to 95 s, leave, return -> `currentTime` 95.0; phone player 374 px wide in 390 (`phone-r46-video.png`) | Resume not testable in webkit (ogv.js player) |
| R-47 | works | `phone-r47-map.png`, `desktop-r38-pdf.png` | |
| R-48 | works | `r48-cnn-phone.png`, `r48-cnn-phone-scrolled.png` | No sticky, no infinite animations, no big gaps |
| R-49 | works | PDF viewer renders 544 pages | App pages not re-checked here |
| R-50 | works | `r50-uncaptured-reader.png`; deleted source -> "This source isn't in the library" | Missing entry in a normal ZIM is raw JSON (noted above) |
| R-51 | works | `r51-face-light.png` (serves `A/index~other`), `r51-face-dark.png` | draculatheme_com-2 |
| R-52 | works | `?a11y=1`: Water 28 alt-less imgs -> 0; xkcd, devdocs, gutenberg gain `lang="en"`; CNN gains an h1 | |
| R-53 | docs wrong | `r53-skip-link-focused.png` | Dialog role, live region, amber ring, forced-colors rules present. Skip link exists but is not the first Tab stop: the search box autofocuses on desktop, so Tab goes to Random; the skip link is reachable only by Shift+Tab |
| R-54 | works | `r54-ctx-kbd.png` | role=menu/menuitem, focus on first item, arrows move, Enter acts, Esc closes and returns focus. Opening by the ContextMenu key not reproducible headless |
| R-55 | not tested | | No Lighthouse in this environment |
| R-56 | works | `desktop-r56-he-history.png`, `phone-r56-he-history.png` | "ירושלים (ז'רום)" reads correctly in title and History in an English UI |
| R-57 | works | 10/10 presses opened an article across 10 ZIMs | |
| R-58 | broken | `/random` responses, dice log | See Broken 9 |
| R-59 | works | `r59-ext.png`; codinghorror.com link opened a new tab outside Zimi | |
| R-60 | works | Esc sequence: panel -> reader -> source -> home; search text -> reader -> home | Focus never trapped |
