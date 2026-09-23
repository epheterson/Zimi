# Regression pass (2026-09-22)

Every claim Zimi has made since 1.0 (CHANGELOG, README, docs/features), 423 after merging and dropping what was deliberately replaced, listed in `2026-09-22-regression-ledger.md` with the test that pins each one. Six testers then drove every claim in WebKit and Chromium, phone and desktop, against a copy of the live library on the NAS (a second 1.10.1 container: the 78 ZIMs read-only, its own data folder, LAN only, a throwaway admin password). Their verdicts, with steps and file:line causes, are in `regression-results/`.

| Area | Claims | Works | Broken or regressed | Docs wrong | Not tested |
|---|---|---|---|---|---|
| Search, Home | 52 | 29 | 12 | 3 | 8 |
| Reading | 60 | 42 | 14 | 1 | 3 |
| Almanac | 38 | 31 | 6 | 0 | 1 |
| Library, Sharing | 84 | 69 | 7 | 2 | 6 |
| Apps, Bookmarks, API | 65 | 51 | 12 | 1 | 1 |
| Accounts, Ops, Create, Desktop | 124 | 111 | 6 | 2 | 5 |

## Fixed on `regression-pass`

Each with a test that fails on the old code, and the page fixes checked in a browser on the real library.

- Did-you-mean: the live vocabulary was from July and stale, built only on the first misspelled search, starved to 1 of 60 indexes inside a busy server, and saved partial as if whole. Now built at startup in a process of its own (78 of 78 indexes on the NAS copy, no search needed), never saved partial, and the page shows every suggestion the server sends (it hid those with 3 to 29 results since 1.8.0).
- Search ranking: the article titled as typed leads (Albert Einstein, Photosynthesis, Honolulu, Isaac Newton, Python and water purification were not first, and Einstein's article was missing).
- Search snippets are the article's lead sentence, not infobox HTML.
- A throttled search says so, in ten languages, instead of "No results found".
- The first Escape closes suggestions and keeps the query.
- Language badges: Maltese is MT, not ML (Malayalam); Bosnian BS, not BO.
- The language globe offers the same article or nothing: English Water offered Spanish "Inodoro" (a toilet) and French Eau offered "Tetrahedral symmetry". The Q-ID cache is versioned so cached guesses go.
- An article opened directly over plain http (knowledge.zosia.lan bookmarks, shared links) opens inside Zimi.
- Tap-to-zoom works from the start (the cookie-wall sweep removed Zimi's own lightbox for 15 seconds).
- The PDF viewer follows a language switch (it did only for English).
- The ... button on the first desktop article is the menu, not a Read aloud speaker.
- Define reads the word's own entry ("process" read "Obsolete spelling of Prozess").
- Almanac: Hebrew dates were 2 to 3 days late (Rosh Hashanah, Passover, every date); moon-phase marks were a day early in most zones; Esc in the Golden Record closed the whole almanac.
- ZIMI_OFFLINE fetched the catalog from kiwix.org behind the snapshot.
- Catalog "Part of" badges crossed projects (every Dev Docs card was "part of cheatography") and hid real ZIMs as already had.
- Seeding off then on lost every seed for good.
- A small library's total size read 0 B.
- ZimiTube dropped every video Zimi made (1.10.0 regression).
- The Mac app reported version 1.4.0 since February, so Sparkle always had an update to offer.
- Manage could stick on "Loading..." after a correct password (two 401s at once lost one resolver).
- A visitor opening the map picker, or a signed-in reader opening settings, got the admin sign-in.
- Maps: typing on a map opened from a link fell through to "No results found"; Enter on "Honolulu" on the Hawaii map flew to the World map.
- Right-click on a search result gave the browser's menu (regressed in 1.9.0).
- Home's filters left every Favorite and collection member on screen.
- One ZimiTube card per talk when two TED builds spell the speaker differently.
- A TED talk whose file is missing says so instead of showing a dead player.
- A link to an article the ZIM lacks shows a page (with a library search), not raw JSON; the missing-ZIM page, which read "This page wasn't captured" in every language but English, translates as itself.
- Random on a captured site lands on its page instead of leaving it.
- Print and Share are reachable (the ... menu, with Reader View on).
- The Define card closes when the article scrolls.
- Almanac dates before year 1 keep their BC.
- `/exchange/*` and `/reddot/*` are rate limited; `/read` and `/search` answer 404 for an unknown ZIM or article, as the API guide says; MCP `read_question`/`read_post` take a glued path.
- Manage's setup commands name the server's data dir (#61); README brew line trusts the tap on Homebrew 6; seven doc contradictions corrected.
- Tests added for the one-time `/dl/` ticket (the 1.9.0 security fix had none).

On `release-names`: release files named `Zimi-<version>-<platform>-<chip>`.

## Decided by Eric (2026-09-23), done

1. Nearby announces only when it is switched on.
2. UPnP opens router ports only when BitTorrent is on. Unchanged: that was already the rule, but BitTorrent is on by default since 1.7.0, so a default install opens them.
3. "Remember me" keeps a session token; a stored password is removed from the browser.
4. Preferred languages narrow search; the other languages stay as dimmed, tappable pills.
5. Two flavors of one ZIM (maxi, nopic, mini) are served once, as the richer one; links to the other redirect.
6. The Mac app reports its real version from 1.10.2; users on 1.10.1 see the update offer until they take it.
7. "About this data" is built, in the almanac.
8. Quick search: the fallback to libzim's SuggestionSearcher is gone for indexed ZIMs (warm 0.07 s on the NAS copy), and title and Q-ID index builds over big ZIMs run in a process of their own. Measured while a Q-ID build ran: a thread build put a title lookup's p95 at 7.6 ms (0.14 ms idle); on 42 ZIMs quick search p95 went from 123 ms to 23 ms with the build moved out.

## Fixed on 2026-09-23

- The snap under the desktop portal (#81) and sticky apps (#88).
- A killed title index build no longer breaks the next start (the `maps` index).
- Book of the Day is stable (the prefix fallback shuffled unseeded).
- On This Day shows its date; recent history shows titles; Reader View draws one line; the Discover strip and pill rows scroll with a mouse wheel.
- The Q-ID badge is set before the full scans, not hours after.
- Nearby: two servers on one host get different names; the advert's ZIM count and BT port follow changes.
- Almanac: zone label, meteor Peak!, deep time and the Chinese row say "beyond" past their spans, the orrery stays finite, the 2027 Aug 17 penumbral eclipse is listed (Jul 18, magnitude 0.001, stays out: Meeus's gamma cannot resolve it).
- The release gate is green (51 checks): one real defect (the shot event in the progress stream), two checks stale since 1.10.0, and a fixture that relied on the guess the language globe no longer makes.
- A multilingual ZIM's badge reads "18 languages".

## Still open

- Apps: current youtube2zim 3.x, multi-language TED and Blender Studio ZIMs give no rows (#89, in progress); on iPhone the docked TED video is clipped and has no subtitles, and tapping the dock pauses.
- Desktop app binds to localhost only, so other devices cannot open it (#90, in progress).
- CNN captures stay light under simulated dark mode.
- A restart throws away BitTorrent download progress.
- Stale Playwright specs (`test_tabs.mjs`, `visual_validation.spec.mjs`); none of the 20 Playwright specs run in CI.
- The NAS Docker daemon hangs on operations on the test containers (the live container is unaffected).
