# Regression results: Accounts and Access, Ops, Create, Desktop and Platforms

Tester run 2026-09-22 on branch `regression-pass` (HEAD cc07300, server reports 1.10.1), macOS 15 Intel (x86_64), Python 3.14.7, Playwright webkit (390x844 @2x, iPhone Safari UA) and chromium (1280x800). Local servers only, ports 8941 to 8944, fixture ZIMs plus a Russian-titled folder ZIM. CI evidence is the v1.10.1 Desktop Release run 35805721565, the v1.10.1 PR CI run 35804227573, Post-Publish 35812241409 and Docker Publish 35805721668.

Screenshot paths are relative to `/private/tmp/claude-502/-Users-elp-Repos-zimi/f2b98424-c2c4-4999-a823-ef803e2af907/scratchpad/regress/ops/`.

"works (suite)" means the pinning tests pass on this branch (1065 + 748 pytest cases run for these four areas, plus the create and env `.cjs` files) and the claim was not also driven live. Two unrelated suite flakes are noted where they fall.

## Broken

Ordered by how much a user would notice.

1. **C-32, regressed (1.10.0): a video ZIM made by `zimi create <video URL>` never shows in ZimiTube.** The home card routes to ZimiTube, which says "No video ZIMs installed yet".
   - Steps: `zimi create "https://www.youtube.com/watch?v=jNQXAC9IVRw" --limit 1` into the library; open ZimiTube, or `curl /tube`.
   - Expected: one video card. Seen: `{"items":[],"total":0,"sources":0,"zims":[]}`; the ZIM's `kind` is `video` and `tube._zimi(archive)` reads the row fine.
   - Cause: `zimi/tube.py:273` filters with `any(_present(archive, m) for m in v["media"])`, which assumes a list. Zimi's own `videos.json` (written at `zimi/video.py:924`) stores `media` as a string, so the loop walks the characters, finds none present, and drops every video. It came in with 40a535c ("a zero-byte file is no file"), which shipped in v1.10.0. The regex fallback at tube.py:207 builds a list, so only ZIMs with `videos.json` (every Zimi-made one) are hit.
   - Evidence: `reader_chromium_desktop_Me_at_the_zoo.png`, `reader_webkit_phone_Me_at_the_zoo.png`.
2. **D-03, broken: the macOS app bundle says it is version 1.4.0.** Sparkle therefore sees every appcast entry as newer.
   - Steps: download `Zimi-Intel.dmg` from v1.10.1, mount it, `plutil -p Zimi.app/Contents/Info.plist`.
   - Expected: 1.10.1. Seen: `CFBundleShortVersionString => "1.4.0"`, `CFBundleVersion => "1.4.0"`. The appcast carries `sparkle:version 1.10.1`.
   - Effect, by Sparkle's standard comparator (not driven through the GUI): 1.10.1 > 1.4.0 on every launch, even right after updating, so users get a perpetual "update available" offer. Finder's Get Info also shows 1.4.0.
   - Cause: `desktop/zimi_desktop.spec:283-284` hardcodes `'1.4.0'`. It has not changed since f5b6386 (2026-02-19). The Windows build reads pyproject (`desktop-release.yml:470`) and the snap got a sync step (line 231), but the macOS plist never got one.
3. **AC-09, regressed (intermittent): after signing in from Manage, the Library pane can stay on "Loading…" forever.**
   - Steps: set a password, open `/?manage` signed out, sign in in the modal.
   - Seen: stuck in 1 of 3 webkit-desktop runs, plus 1 of 1 webkit-desktop and 1 of 1 chromium-desktop in earlier runs; the other runs were ready in 0.5 to 2.6 s. In a stuck run, the only requests after sign-in are `/manage/creator/inventory` and `/manage/activity`, and `/manage/status` is never retried. A reload fixes it.
   - Cause: `manageFetch` (`zimi/static/app.js:1375`) keeps one global `_pwResolve`. `enterManage` fires `_creatorLoadInventory()` (app.js:7244) at the same time as the pane's `/manage/status`, both get 401, and whichever 401 lands second overwrites the first one's resolver. That promise never settles, so the pane that owned it spins.
   - Evidence: `man4_3_webkit_desktop_stuck.png`, `man2_webkit_desktop_signin.png`, `man_chromium_desktop_3_manage_after_signin.png`.
4. **D-02, docs wrong: the README's brew line fails on current Homebrew.**
   - Steps: README line 99, `brew tap epheterson/zimi && brew install --cask zimi`, on Homebrew 6.0.22.
   - Seen: `Error: Refusing to load cask epheterson/zimi/zimi from untrusted tap epheterson/zimi. Run brew trust ...`.
   - The cask itself is correct (1.10.1, both sha256 values match the release). The README needs the `brew trust` step.
5. **C-10, broken (partial): Manage > Creator gives the install command without this server's data dir, which is the #61 trap.**
   - Steps: run a server with `ZIMI_DATA_DIR` set somewhere non-default and no sidecars; open Manage > Creator.
   - Seen: bare `zimi import --setup` and `zimi create --setup-reddit`. Pasted into a shell, they install into another library's state dir.
   - Cause: `app.js:10660` and `app.js:10705` pass literal strings and ignore `d.sidecar.dir`. Only the Create page (`create.js:289 _createSidecarCommand`) adds `--data-dir`, and no reddit command anywhere does.
   - Evidence: `engines_creator_pane.png`.
6. **C-14, docs wrong: whole-site captures and SingleFile captures carry no pictures.** `making-zims.md` says "Every capture keeps a picture of the live page".
   - Seen: `--site` with rendered and with fast, finished normally or early, has no `X-Zimi-Screenshot*` metadata; `cern_singlefile` has none either.
   - The code says so on purpose (`crawler.py:703` "A crawl takes no pictures"). Page mode, Fast, Rendered and Alive all carry both pictures.
7. **O-32, broken: `scripts/release-gate.sh` fails on the released code.** `test_04_create` fails 3 of 9 checks (4 failed, 46 passed on a full run, where one of the 4 was my own mistake, see the O-32 note).
   - `test_import_mode_is_a_closed_door_not_a_hidden_one` and `test_without_a_configured_root_the_web_cannot_reach_the_filesystem` expect "CLI" in the error, but 1.10.0 made import a library-folder picker (C-37), so the error is now "choose an archive from the list".
   - `test_the_progress_stream_carries_structured_events` gets `KeyError: 't'` on the `{"event":"shot","i":3}` event (`zimwriter.py:2175 SHOT_EVENT`).
   - The gate file was last touched in 1.9.0, so it has been red since 1.10.0.
8. **O-23, regressed (this branch only, not in 1.10.1): `test_startup_serial.py::test_warm_indexes_spawns_single_named_worker` fails.** Seen: `2 != 1 : ['zimi-startup-worker', 'zimi-dym-vocab']`. c03fc1d added a `zimi-dym-vocab` thread during warm-up. Either the test or the claim ("one worker") needs updating before this branch merges.

## Accounts and Access

| ID | Verdict | Evidence | Note |
|---|---|---|---|
| AC-01 | works | `ZIMI_PUBLIC_ACCESS=private`: LAN `/list` 401; POST mode=open answers `env_controlled:true`, mode stays private; corrupt `access.json` (`{not json`) gives LAN `/list` 401 | env wins, fails closed |
| AC-02 | works | `acc_webkit_phone_1_firstframe.png` (sign-in at 250 ms, no library ever rendered); anon `/list /search /languages /random /suggest /read /w/` 401; `/ /whoami /health` 200 | |
| AC-03 | works | limited to wikipedia_en_test: anon `/list` and `/languages` show only it; `/zim-info` and `/article-languages` of a hidden ZIM 404 | |
| AC-04 | works | alice (allowlist survival_en_test): list, search and suggest show only it; `/random` of hidden 404 | `/read` of a hidden ZIM answers HTTP 200 with an error body (`ZIM ... not found`); should be 404 |
| AC-05 | works | secondary admin bob: stats 200, edit primary 403 "cannot modify the primary admin", create admin 403, reset a user's password 200; `last_login` in the roster | |
| AC-06 | works | carol with `can_create`: create/probe 200, `/manage/stats` 401, import probe 403 "archive import is for the primary admin" | |
| AC-07 | works | Set-Cookie `zimi_session ... HttpOnly; SameSite=Lax`, no Secure over http, expires in 30 d; after an admin resets alice's password her token's `/whoami` is anonymous | |
| AC-08 | works | private mode, admin cookie: `/w/` 200, anon 401, after logout 401; library loads after sign-in (`acc_webkit_phone_3_after_signin.png`) | |
| AC-09 | regressed | see Broken 3 | sign-in does stick across reload and a new tab (webkit phone and chromium desktop: overlay none, `/whoami` admin, `/list` 200 in the new tab). In private mode admin sign-in lands on home, not Manage |
| AC-10 | works | user Bearer at `/manage/stats` 401 | |
| AC-11 | works | username "Admin" stored as the second line of the password file; login as `ADMIN` and `admin` 200, wrong one 401 with the generic message | |
| AC-12 | works | `users_solo_admin.png`: Your account, Public access, and "+ Add a user" with no list | |
| AC-13 | works | public access limited, then carol's role changed; reply still `mode: limited` | |
| AC-14 | works | from LAN IP without key: `needs_setup_key`; with `X-Zimi-Setup-Key`: "password set"; setup-key file gone; loopback with a forwarded header 403 | |
| AC-15 | works | `ZIMI_LAN_ADMIN=1`: LAN stats 200; the same with `X-Forwarded-For` 403 | |
| AC-16 | works | `ZIMI_MANAGE_OPEN=1`: LAN stats 200 even after a password is set; boot log "Library management is OPEN: no password, no setup key, anyone ..." | |
| AC-17 | works (suite) | `test_unit.py::TestPasswordlessManageGate`, `TestClientIPResolution` pass | no tailnet here |
| AC-18 | works | password file is `<salt>$<hash>` | |
| AC-19 | works | generate, then token stats 200; removing the password with a token live gives 400 "Revoke the API token before removing the password"; revoke, then 401; `ZIMI_API_TOKEN` shows as locked in the env panel | |
| AC-20 | not tested | | needs the Docker image (multi-GB, disk nearly full). Note: under a Docker bridge the host is not loopback, so since 1.9.1 it needs the setup key; host networking avoids that |
| AC-21 | works | wrong logins: the 11th in a minute is 429 | |
| AC-22 | works | alice's `/languages` lists only survival_en_test; Q-ID half by suite | |
| AC-23 | works | alice saves bookmarks, reads them back; carol sees empty; anon 401 | |
| AC-24 | works (suite) | `test_sso.py` all pass | no Cloudflare Access here |
| AC-25 | works | Remember me: a new tab in the same browser is still admin; logout clears the manage keys from localStorage and the cookie, and reload shows signed out | the admin password itself is kept in localStorage as `zimi_manage_pw` in plain text while Remember me is on; worth a look |
| AC-26 | works | changed password in the UI, server accepts the new one, reload keeps Manage open (`users_after_pw_change_reload.png`) | |
| AC-27 | works | webkit phone: both login fields 16px (no iOS zoom), Cancel hidden on the private gate | emulated, not a physical iPhone |
| AC-28 | works | `ZIMI_MANAGE=0`: `/manage/stats` 404 | |
| AC-29 | works (suite) | `TestClientIPResolution` passes | no proxy here |
| AC-30 | works | password set, open mode: anon `/search` 200, `/manage/stats` 401 | |

## Ops

| ID | Verdict | Evidence | Note |
|---|---|---|---|
| O-01 | works | `cd zims && zimi serve --port 0`: library listed, `.zimi` created beside; read-only folder: "Data dir ... is not writable ... keeping state in ~/Library/Caches/Zimi/ro-..." | |
| O-02 | works | `zimi config` lists 18 settings with source (env, flag, config file, default), `api_token ********` | `create_root` shows "(default: web off)", which is stale since 1.10.0 made import default to the library folder |
| O-03 | works | port: file 8944 < env 8945 < flag 8946; `ZIMI_CONFIG` found the file; unknown key warns and continues | |
| O-04 | works | `offline`, `hot_zims` and `manage_password` from zimi.json: `zimi config` credits the file; server boots with the file password | |
| O-05 | works | `READY 62532` on `--port 0` | |
| O-06 | works | every run here used a separate `ZIMI_DATA_DIR`; titles, qids, users and sidecars landed there | |
| O-07 | works | backup file mode `-rw-------`; restore into an empty dir brings back users, access and user_data; a foreign JSON gives "not a Zimi backup bundle"; `--overwrite` exists | |
| O-08 | works (suite) | `test_offline_switch.py` and gate `test_07` pass; live, `offline` from the config file served the catalog from its snapshot (2653 entries) | |
| O-09 | not tested | `--help` and `bash -n` fine | needs a wheel download and a second machine |
| O-10 | works | anon `/metrics` 401; API token: `Content-Type: text/plain; version=0.0.4`, `zimi_http_requests_total`, `..._rate_limited_total` | |
| O-11 | works (suite) | tiny library can't show the difference | every admin request pays about 0.5 s of PBKDF2 on this Mac (the Bearer is the password) |
| O-12 | works | anon, password set: 70 calls, 60 are 200 and 10 are 429; admin Bearer after that 20/20 200; passwordless LAN client 70/70 200; `/w/` on the content bucket | the trusted tier needs a manage credential in the header; a signed-in named user gets the anonymous 60 |
| O-13 | works | `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin` | |
| O-14 | works (CI) | CI `docker` job success (run 35804227573), Docker publish success | not run locally (image size) |
| O-15 | works (CI) | CI `podman` job success | |
| O-16 | works | kubernetes.yaml parses to Namespace, 2 PVC, Deployment, Service; `docker compose -f deploy/docker-compose.yml config -q` ok | no cluster; kubectl on this Mac fails on any manifest |
| O-17 | works | all 10 languages load (no i18n fetch failures), placeholder translated, no raw key names; `i18n_desktop_{ar,he,zh,ru}.png` | |
| O-18 | works | webkit with locale he-IL and ar-SA: first load `lang=he`/`ar`, `dir=rtl`, logo on the right (`i18n_phone_he-IL.png`); fr-FR gives French | |
| O-19 | works | chromium `Page.getInstallabilityErrors` empty; SW active, cache `zimi-v1.10.1-d992b453` = `/health` asset_version; offline reload serves the shell (`pwa_offline_reload.png`) | |
| O-20 | works | server killed: banner "Can't reach your Zimi server. Reconnecting…", no empty library (`pwa_server_down.png`); restarted: library back by itself in 4.0 s (`pwa_server_back.png`) | |
| O-21 | works | `app.js`: `Content-Encoding: gzip`, `Cache-Control: public, max-age=31536000, immutable`, `?v=452f2381` | |
| O-22 | works | `hot_zims` from config: "Pre-warming 1 hot archive(s) of 3 total"; `/manage/hot` `env_locked: true` | |
| O-23 | regressed | see Broken 8 | branch only |
| O-24 | works | 50 parallel `/read` on one ZIM: 50x 200, server alive | |
| O-25 | works (suite) | `test_client_disconnect.py` passes | |
| O-26 | works | `/manage/env` and the Server pane list `ZIMI_BT=port=16881` (locks BitTorrent), `ZIMI_UPDATE_CHANNEL`, `ZIMI_API_TOKEN` as "set" (`env_panel_crop.png`) | cosmetic: the row reads "Where the ZIM files are locks ZIM folder" (no separator, app.js:11710, en.json `env_locks`); the channel description says "stable or beta" (envinfo.py:63) but the channels are latest and beta |
| O-27 | works | `/manage/app-update`: current and latest 1.10.1, `install_type pip`; delay 365 accepted, 366 refused; channel beta settable; env lock shown | |
| O-28 | works | cold start to READY in 1.32 s with Chromium installed | |
| O-29 | works (CI) | `desktop-env (windows-latest)` success; `test_atomic_write_retry.py` passes | |
| O-30 | works | data dir made read-only while running: set-password 500 "Could not save the password (storage is not writable)", server alive | an explicitly read-only `ZIMI_DATA_DIR` refuses to boot, with a clear message |
| O-31 | works (suite) | `test_cache_writers.py` passes | |
| O-32 | broken | see Broken 7 | my first full run also lost 2 checks to connection refused; that was my own `pkill` of a `--port 0` server, and a rerun of `-k test_04` confirms the 3 real failures |

## Create

| ID | Verdict | Evidence | Note |
|---|---|---|---|
| C-01 | works | admin desktop: topbar "Create a ZIM" +; phone: ⋯ row "Create a ZIM"; live log, progress, done card; cancel via API (`create_chromium_desktop_done.png`, `create_webkit_phone_done_full.png`) | anonymous users see no + (correct) |
| C-02 | works | probe returns title, bytes, assets, language, `spa`/`app`, `robots_allowed` | a site probe gives no page estimate or tree; the tree appears only once running |
| C-03 | works | web page job (Fast) gives a registered ZIM, reads in the reader (`reader_*`), declared UTF-8 by suite | |
| C-04 | works (suite) | `test_creator_page.py::test_multi_page_*` pass | |
| C-05 | works | `--site --max-pages 2` with rendered and fast, 2 pages each; `robots_allowed` in probe; rest by suite | |
| C-06 | works | Finish mid-crawl: `info_cern_ch_site`, 3 pages, valid, opens | |
| C-07 | works | `CREATE_MAX_PAGES_CEILING = 50000` (manage.py:2171), UI max 50000 (create.js:305) | |
| C-08 | works | Fast, Rendered, Alive and SingleFile each captured info.cern.ch and open (`created_*`, `reader_*`) | zimit not run (image multi-GB) |
| C-09 | works (suite) | `test_alive.py::test_an_application_shell_*` passes | |
| C-10 | broken | see Broken 5 | Create page part pinned by `test_sidecar_install_hint.cjs` (passes) |
| C-11 | works (suite) | `test_blocklist.py` passes | test page has no ads to count |
| C-12 | works | every created ZIM has Name, Title, Language, Creator, Publisher, Date, Description and a 48px illustration; no `/private`, `/Users` or `/tmp` in any metadata | zimcheck not installed |
| C-13 | works | right-click > About this ZIM: badge, provenance, live and packaged pictures (both 1280 wide) (`about_chromium_desktop.png`, `about_webkit_phone.png`) | stacked on phone |
| C-14 | docs wrong | see Broken 6 | page captures: both pictures present at `-/shot-live` and `-/shot-zim` |
| C-15 | works (suite) | `test_second_face.py`, `test_capture_theme.py` pass | |
| C-16 | works | alive ZIM: `X-Zimi-Capture` has engine, source, pages; both pictures | |
| C-17 | works (suite) | | |
| C-18 | works (suite) | | |
| C-19 | works (suite) | | |
| C-20 | works | rendered capture history records `browsertrix-behaviors 0.12.3` | installed on this Mac |
| C-21 | works (suite) | the related tests pass | `test_reader_paints.py` failed twice inside the long run (0 images, likely port or load contention) and passed alone |
| C-22 | works | `zimi import --setup`: "patched zimscraperlib's script wrapper (block-scoped globals, #329)" | |
| C-23 | works (suite) | `test_loader_shim.py` passes | |
| C-24 | not tested | | the site suite captures many live sites; out of budget |
| C-25 | works | rendered site job had 4 Chromium descendants of the server; after cancel 0; job cancelled with nothing added to the library | |
| C-26 | works | second submit gives `queued, position 1`; drop gives `dequeued`, queue `[]` | |
| C-27 | works | events: phase, node, count; done card with counts, size, Open; Manage > Creator "Made here" lists every result | |
| C-28 | works | Create button right after typing, focus still in the field, starts the job; the form empties at the end | Enter in the address field adds a newline (it is a multi-URL textarea), so the ledger's "press Enter" verify step is wrong |
| C-29 | works | `create_webkit_phone_done_full.png`: its own header; `test_create_topbar.cjs` passes | |
| C-30 | works | passworded, signed out, `/#create` shows the sign-in modal and the Create view stays hidden (chromium desktop and webkit phone: `pw overlay on #create: true, create view visible: false`) | |
| C-31 | works | Markdown + HTML folder with a Russian title, links followed inside the reader ("Другая страница" > "Back to index") | |
| C-32 | regressed | see Broken 1 | the ZIM itself is right: `subs/*.en.vtt` present (YouTube 429'd one extra track), first video shipped with `--limit 1` |
| C-33 | works | ffprobe of the packaged media: `h264` 320x240 + `aac` | |
| C-34 | works (suite) | | |
| C-35 | works | `--setup-reddit` then `zimi create r/kiwix`: 6.6 MB ZIM, opens in Reddot (reader frame shows "r/Kiwix, Top, New, 101 points [PSA] ..." on desktop and phone) | the CLI prints "ZIM written: ..." twice |
| C-36 | works | `import --setup` (198 MB sidecar), `zimi import cern.warc.gz` gives a ZIM; the same import with `ZIMI_OFFLINE=1` also works | |
| C-37 | works | `.warc.gz` dropped in the library folder is listed in `archives`; the web import job registers `cern` | |
| C-38 | works | Creator pane "Made here" with type counts and a sortable table, no spinner | engine rows said "Checking…" for a moment |
| C-39 | works | web jobs report `registered: true` and appear on home immediately | |
| C-40 | works (suite) | | |
| C-41 | works | `ZIMI_OFFLINE=1 zimi create https://example.com/`: "ZIMI_OFFLINE is set, refusing to fetch from the network ..." | |
| C-42 | works | "BETA" and a "Tell us about the site" link to github.com/epheterson/Zimi/issues/new | |
| C-43 | works (suite) | pictures on the done card | not timed live |
| C-44 | not tested | | zimit Docker image is multi-GB, disk nearly full |
| C-45 | works | `--title` and `--out` live; language falls back to eng for a folder that declares none | |
| C-46 | works | after all captures the library folder holds only .zim files (and my .warc.gz) | |
| C-47 | works (suite) | done card's What's inside matches the file size | |
| C-48 | works (suite) | | zimcheck not installed |

## Desktop and Platforms

| ID | Verdict | Evidence | Note |
|---|---|---|---|
| D-01 | works | `spctl -a -vv` on the 1.10.1 Intel DMG's app: accepted, "Notarized Developer ID"; `stapler validate` worked; CI signs and notarizes both DMGs | but see D-03, the bundle version is 1.4.0 |
| D-02 | docs wrong | see Broken 4 | |
| D-03 | broken | see Broken 2 | appcasts on main carry 1.10.1 with an EdDSA signature |
| D-04 | works (CI) | Setup.exe and zip built and uploaded; appcast-windows.xml at 1.10.1; `test_winsparkle.py` passes | not installed on Windows |
| D-05 | works (CI) | "GUI smoke test (Windows, marked bundle renders its home view)" success; `test_desktop_unblock.py` passes | |
| D-06 | works (CI) | Linux build and AppImage package success; `test_desktop_linux.py` passes | |
| D-07 | works (CI) | "The snap installs and opens its window (Linux)" success; publish-snap success | |
| D-08 | works (suite) | | |
| D-09 | works (suite) | | |
| D-10 | works | `Contents/Frameworks/libtorrent*` inside the DMG app; CI installs libtorrent on every runner | |
| D-11 | works (suite) | | |
| D-12 | works (suite) | `test_zim_discovery.py` passes | |
| D-13 | not tested | | needs the desktop GUI and a location prompt |
| D-14 | works (CI) | PR run 35804227573: desktop-env on ubuntu-22.04, windows-latest, macos-latest, macos-15-intel all success | |

## Counts

| Verdict | Accounts | Ops | Create | Desktop | Total |
|---|---|---|---|---|---|
| works | 28 | 29 | 43 | 11 | 111 |
| broken | 0 | 1 | 1 | 1 | 3 |
| regressed | 1 | 1 | 1 | 0 | 3 |
| docs wrong | 0 | 0 | 1 | 1 | 2 |
| not tested | 1 | 1 | 2 | 1 | 5 |

Of the 111 works, 33 rest on the suite or CI alone, not a live run.

## Side notes

- The first server run on 8941 had BitTorrent on and mapped TCP/UDP 6884 on the router by UPnP. Every later server ran with `ZIMI_BT=off`. If the mapping outlived that server, it is still on the router.
- `/read` of a ZIM the caller may not see answers HTTP 200 with an error body (AC-04 note).
- A Remember-me admin keeps the plain password in localStorage (`zimi_manage_pw`).
