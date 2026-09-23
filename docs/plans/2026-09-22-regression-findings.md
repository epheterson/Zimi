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

## Needs Eric

1. **Nearby announces a default install on the LAN.** Name `zimi-<hostname>` (here `zimi-Erics-iMac`), IP, port, exact version, ZIM count and BT port, while the Settings switch reads OFF and the README says off by default. Recommend: advertise only when Nearby is on.
2. **UPnP opens router ports on a default install** (6884, 6885, 6899 seen). Recommend: only when sharing or seeding is switched on.
3. **"Remember me" keeps the primary admin's password in localStorage in plain text** (`zimi_manage_pw`). Recommend: a session token, as secondary admins already get.
4. **Preferred languages do not narrow search**, though 1.7.0 says they do. Build it, or correct the changelog.
5. **A medicine maxi and nopic in one folder are both served.** Prefer one, as `_all` names already do?
6. **Where the Mac app's perpetual update offer leaves 1.10.1 users**: the fix ships in the next build; users on 1.10.1 keep seeing the offer until they take one.
7. **"About this data" (1.7.2 changelog) was never built.** No version of the code or translations has it. Build it, or drop the claim.
8. **Quick search takes 5 to 12 s for many multi-word queries on the NAS.** When no title starts with the first word, 72 of 78 ZIMs fall back to libzim's SuggestionSearcher. Since 1.5 (which dropped FTS5 prefix queries at 5 to 6 s per ZIM); not a regression. Whole-word FTS5 measured up to 1 s per large ZIM cold. Needs a design pass: which ZIMs deserve the fallback, and whether results can stream per ZIM.

## Still open (not yet fixed)

- Apps: current youtube2zim 3.x ZIMs give no rows; on iPhone the docked TED video is clipped and has no subtitles, and tapping the dock pauses; zero ZIMs shows no Apps row; a new collection needs a reload while the service worker is on.
- Reading: the Q-ID badge never shows; Reader View draws two lines under every title; CNN captures stay light under simulated dark mode.
- Search, Home: Book of the Day differs between identical requests; On This Day never shows its date; the desktop Discover strip does not scroll with a mouse wheel; recent history shows file names for some entries; the `maps` title index fails to build.
- Almanac: deep time shows nonsense instead of "beyond range"; the zone label stays PDT in January; the meteor "Peak!" badge is a day late; two 2027 penumbral lunar eclipses are missing. (Twilight and the Morning/Evening labels were not a regression: the labels are the planets', and present; twilight was always computed, never shown.)
- Library, Sharing: a restart throws away BitTorrent download progress; two Zimis on one host clash on the Nearby name; the advertised BT port and ZIM count are frozen at startup.
- Ops: `scripts/release-gate.sh` has three stale checks; stale Playwright specs (`test_tabs.mjs`, `visual_validation.spec.mjs`); none of the 20 Playwright specs run in CI; duplicate changelog bullets.
