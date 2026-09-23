# Regression results: Library and Catalog, Sharing

Tester run 2026-09-22 against Zimi 1.10.1: the NAS test copy at http://10.0.0.14:8977 (78 ZIMs, passworded) for what people see, and my own local servers from `regression-pass` (ports 8961 to 8964) for downloads, queue, updates, BitTorrent, seeding and peer sharing. Browsers: Playwright webkit at 390x844 (iPhone UA, DPR 2) and chromium at 1280x800.

Evidence paths are relative to `/private/tmp/claude-502/-Users-elp-Repos-zimi/f2b98424-c2c4-4999-a823-ef803e2af907/scratchpad/regress/library/` (screenshots `*.png`, server logs `serve*.log`, suite output `pytest.log` and `cjs.log`).

Suite baseline: every pytest file named in both sections plus `tests/test_unit.py` ran green: `967 passed, 1 skipped` (pytest.log). The five `.cjs` files named in these sections all passed (cjs.log). Where a row says "suite" the claim was not driven live, only that suite.

Counts: **works 69 · broken 7 · regressed 0 · docs wrong 2 · not tested 6** (84 claims).

## Broken

Ordered by how much a user would notice.

1. **L-24 / SH-02: a BitTorrent download that is in flight when the server restarts starts over from zero.**
   - Steps: set Download speed limit to 60 KB/s. Queue `devdocs_en_python` (4.4 MB), which goes BT (`source: bt, bt_peers: 11`). At 37.7% stop the server (SIGTERM) and start it again with the same ZIM_DIR and data dir.
   - Expected: it resumes from about 37% ("does not re-check the whole partial", "resumes from its byte count").
   - Seen: the download is resumed from the queue, but progress reads `4.5%`, then `10.8%`, `20.1%`... It re-downloads from zero (serveA4.log; `downloaded_bytes` comes from libtorrent `total_done`, p2p.py:1177). A `.fastresume` file for the torrent was written at shutdown (dataA/bt/resume), so the resume data exists but its pieces are not honored.
   - Worse variant: a download that was paused when the server stopped came back with `downloaded_bytes 0` and `0 peers` for 60 s, then `BT stalled ... falling back` to HTTP from byte 0. The 4.4 MB of 6.4 MB it already had was thrown away (serveA3.log lines 31 to 35). Its BT staging file (`staging/devdocs_en_pytorch_2026-07.zim`, 6.4 MB) was never cleaned up after the HTTP fallback finished: the Storage bar still showed "Staging 6.4 MB" 30 minutes later (settings-Server-A-chromium.png, cache-rebuild-click.png). That space leaks for good.
   - Cause: not pinned down. The restart path re-adds the torrent through `add_torrent` (p2p.py:987), which builds fresh params and `return tid`s early only when a handle already exists. The fastresume loaded by `_load_resume_files` (p2p.py:898) is the thing to check first. `TestResume` passes because it runs on `fake_lt`.

2. **L-10: catalog hierarchy invents bundles, and hides real items as "you already have".** The client-side mirror of `catalog_hierarchy.py` groups families by category plus language and treats any `*_all` name in that family as the superset of everything else in it.
   - Seen (loc-devdocs-selected.png, B-jq-card-webkit.png): every English Dev Docs card says **"Part of cheatography.com_en_all"** (244 items). Maître Lucas and C'est pas sorcier are "part of" `pokepedia_fr_all` (64 items). Avanti physics lessons are part of `slam-out-loud_hi_all` (66 items). `wikivoyage_en_europe` is part of `wikipedia_en_all`.
   - User impact on the real NAS library (s7.js output): `wikivoyage_en_europe` is hidden behind "Show 35 you already have" because `wikipedia_en_all` is installed, and `www.ready.gov_es` and `usda-2015_en` are hidden because `armypubs_en_all` is installed. Someone browsing the catalog never sees those three.
   - Steps: Catalog, Dev & Tech Docs (any card), or Encyclopedias, then "Show 35 you already have" with wikipedia_en_all installed.
   - Expected: a bundle covers only its own project (e.g. `wikipedia_en_*`).
   - Cause: app.js:8150 to 8195 (`_enrichCatalogHierarchy`) keys families on `category + '_' + language` with no project-prefix check. The client assigns `category = 'devdocs'` to cheatography, so it joins the devdocs family. `catalog_hierarchy.py` has the same family rule (`_family_key`, line 72) but sees the raw empty categories from OPDS, so the server output is clean and the tests pass.

3. **L-04: Settings > Library "Total size" reads "0 B" for any library under about 50 MB.**
   - Steps: a library of 10 small ZIMs (about 9 MB), then Settings > Library.
   - Seen: "ZIM files 10 / Total size 0 B" (settings-A.png).
   - Cause: `/manage/status` rounds `total_size_gb` to one decimal place (manage.py:4714, search.py:734: `round(total_gb, 1)`), and the client turns that back into bytes (`fmtSize`, app.js:1097). 0.009 GB rounds to 0.0. Per-ZIM sizes are right ("67.0 KB", "20.0 KB"; installed-A-chromium.png). Only the total is wrong. People who only make small ZIMs will see "0 B".

4. **SH-17: turning Seed off and then on again silently drops every existing seed, for good.**
   - Steps: with 5 ZIMs seeding (dataA/bt/torrents.json), POST `{"seed": false}`, then `{"seed": true}`.
   - Seen: `/manage/seeding` lists 0 torrents, `bt/seeds.json` is `{}`, and after a restart still only the one ZIM downloaded since is seeding. The 5 older ones never come back, although SH-05 promises that "a ledger restores missing seeds".
   - Cause: the off path clears the intent ledger instead of pausing, so nothing is left to restore. Persistence of the switch itself works.

5. **L-01: two flavors of a topical ZIM in one folder are both served instead of resolving to the richer one.**
   - Steps: put `wikitest_en_medicine_maxi_2026-07.zim` and `wikitest_en_medicine_nopic_2026-07.zim` (Kiwix's real naming for topic subsets such as `wikipedia_en_medicine_*`) in one folder, then restart.
   - Seen: two library entries, `wikitest_en_medicine` and `wikitest_en_medicine_nopic` (serveA5.log, /list). The `_all_` pair `testlib_en_all_maxi` / `testlib_en_all_mini` resolves correctly: "keeping ...maxi, ignoring ...mini".
   - Cause: `_zim_short_name` (server.py:2517 to 2519) strips a flavor only right after `_all` or right after a language code. `_en_medicine_nopic` survives, so the names never collide and `_zim_build_rank` never runs. The same names also make update matching and "Installed" matching treat the nopic as a separate ZIM.

6. **ZIMI_OFFLINE does not stop the catalog from going online** (found under L-07; the ZIMI_OFFLINE claim itself belongs to Ops).
   - Steps: start a fresh server with `ZIMI_OFFLINE=1` and an empty data dir, then open Catalog.
   - Seen: the first answer is the shipped snapshot ("Catalog snapshot: 2653 entries, built 2026-09-16", `stale: true`), which is right. The background revalidation then fetches library.kiwix.org: the browser receives `total: 3630` (live), and `dataD/catalog_validators.json` holds Kiwix ETags (s19.js output).
   - Cause: `_fetch_kiwix_catalog` (library.py:1813) never consults `p2p.is_offline()`. Only the thumbnail path does (library.py:1609). An air-gapped operator's instance tries kiwix.org every time someone opens Catalog.

7. **SH-23: a second Zimi on the same host (or any two machines with the same hostname) silently never appears on Nearby.**
   - Steps: with the Zimi desktop app running (it advertises `zimi-Erics-iMac`), start `python3 -m zimi serve` with no peer name.
   - Seen: `Peer discovery startup failed: ` with an empty message (serveA.log line 26). The underlying error is zeroconf `NonUniqueNameException`. The instance is not advertised and does not browse either, so its Nearby shows nothing and nothing says why.
   - Cause: p2p_discovery.py:344 `zc.register_service(si)` without `allow_name_change=True`, and the default name is `zimi-<hostname>` (p2p_discovery.py:180). The warning at p2p_discovery.py:365 logs `%s` of an exception whose str() is empty.

8. **SH-30 (minor): after a live BitTorrent port change, mDNS keeps advertising the old port until restart.**
   - Steps: change Port 6881 to 6899 in Settings. The engine rebinds and UPnP maps 6899 (serveA5.log).
   - Seen: `_zimi._tcp` TXT still says `bt_port: 6881`. After a restart it says 6899.
   - Related: the TXT `zim_count` is also frozen at boot. B advertised `0` while holding 5 ZIMs.

## What a default install broadcasts on the LAN (the Nearby question)

A local server started with no Nearby settings of any kind (no `ZIMI_NEARBY`, no `ZIMI_PEER_*`, no prefs file), browsed with zeroconf 0.148 on `_zimi._tcp.local.`:

- It **advertises by default**. `p2p_discovery.is_enabled()` returns True unless `ZIMI_NEARBY` discovery/off or `ZIMI_PEER_DISCOVERY=0` is set (p2p_discovery.py:56 to 65).
- Service instance `zimi-<hostname>._zimi._tcp.local.`, host record `zimi-<hostname>.local.`. This Mac's default is `zimi-Erics-iMac`: it leaks the machine's hostname, which here holds the owner's first name.
- The A record is the machine's LAN IP (`10.0.0.229`). SRV port is the HTTP port.
- TXT records: `version` (exact, e.g. `1.10.1`), `zim_count` (e.g. `2`, frozen at boot), `port` (HTTP), `bt_port`.
- Live example from this LAN: `zimi-Erics-iMac` at 10.0.0.229:8899, version 1.10.0, zim_count 3, bt_port 6881. That is the Zimi desktop app, which listens on 127.0.0.1 only, so it announces an address nobody can reach. The production NAS also advertises: `zosia-zimi`, 10.0.0.14:8899, 1.10.1, 78 ZIMs, bt_port 16881.
- What stays off by default: serving files. `/dl/` from a LAN IP answers 403 until the Nearby switch is on (from loopback it answers because a passwordless local client counts as admin). A server with the switch off also does not list peers (`/manage/peers` shows `enabled: false, peers: []`).
- The UI shows the Nearby switch OFF while the advertisement is running (settings-Server-A-chromium.png). Nothing on the page says the instance is announcing itself.
- Docs: README line 74 says "Nearby (off by default)", README line 197 gives `ZIMI_NEARBY` a default of `off`, and CHANGELOG 1.7.0 says "OFF by default ... never a surprise". getting-and-sharing.md line 48 ("Discovery is on by default") is the only accurate one. Hence SH-23 is rated **docs wrong**. Whether the behavior or the docs should change is a product call: the hostname in the instance name is the part most people would not expect.

Also on by default: the BitTorrent engine asks the router for a UPnP mapping at boot (SH-13). A default local server opened external ports 6884, 6885 and 6899 on this LAN's router (serveA*.log). I saw no explicit unmapping in Zimi's code (no DeletePortMapping in p2p_nat.py). Whether libtorrent removes the mappings on shutdown was not verified.

## Library and Catalog

| ID | Verdict | Evidence | Note |
|---|---|---|---|
| L-01 | broken | serveA5.log collisions; /list shows `wikitest_en_medicine` and `wikitest_en_medicine_nopic` | Works for `_all_` names and root-over-subfolder (`medical/devdocs_en_pug` ignored). Fails for topical flavor pairs. See Broken 5 |
| L-02 | works | /list: `medical/` gives category "Medical", `flav/` gives "Flav" | quarantine/@eaDir/.nozim: suite |
| L-03 | works | serveA5.log "Cache loaded: 11 ZIMs (6 cached, 5 scanned) in 0.1s"; boot to /health 4.5 s | Small library; NAS test copy boots its 78 from cache |
| L-04 | broken | settings-A.png "Total size 0 B"; installed-A-chromium.png shows 67.0 KB, 20.0 KB, 0 B (empty file) | Per-ZIM sizes are right; the total is rounded to 0.1 GB. See Broken 3 |
| L-05 | works | nas-catalog-*.png gallery; nas-wiki-fr-chromium-desk.png: French pill narrows Encyclopedias to "24 available" instantly | |
| L-06 | works | Two `/manage/catalog` fetches of 252 KB in 0.007 s and 0.005 s; session paints instantly on reopen | |
| L-07 | works | Fresh `ZIMI_OFFLINE=1` server served the shipped snapshot: "Catalog snapshot: 2653 entries, built 2026-09-16", `stale: true`; D-offline-catalog-phone.png | Real no-internet not reproducible here. The same run exposed Broken 6 (ZIMI_OFFLINE still fetches). The date note shows only in drill and search views, not on the gallery |
| L-08 | works | thumb429-chromium.png / thumb429-webkit.png: with thumbs forced to 429 (service worker blocked), 44 of 44 cards show letter icons; icon-loc.png real icons | With the service worker active, a 429 from the shared-IP rate limit on the NAS left blank tiles instead of letters; not isolated |
| L-09 | works | `/manage/thumb` for an off-host URL gives 400, for http:// gives 400, for a non-image Kiwix URL (OPDS XML) gives 502 | Redirect refusal: suite only |
| L-10 | broken | loc-devdocs-selected.png, B-jq-card-webkit.png, s5/s6/s7 output | Wikipedia badges are right ("Already covered by wikipedia_en_all", "Includes 28 smaller editions"). Cross-project bundles are wrong. See Broken 2 |
| L-11 | works | nas-wiki-installed-webkit-phone.png: installed/covered items are hidden behind "Show 35 you already have", then shown last at opacity 0.5 | Which items get hidden is wrong because of L-10 |
| L-12 | not tested | | Needs a ZIM whose Kiwix name is truncated (canadian_prepper); none available |
| L-13 | works | loc-wiki-de-pref.png: preference `de` opens Encyclopedias on German titles | Preferences are per browser (localStorage) |
| L-14 | works | Gallery pills read English, French, Arabic... No CSS/Git pills in Dev Docs | Rare codes still show raw and in mixed case (`LI`, `GUW`, `HSB`, `sg`, `iu`, `io`), and "Akan" appears twice (s2.js output) |
| L-15 | works | Pref Mini: first cards read "Mini (296.9 MB)", "Mini (24.8 MB)" where a mini exists; pref No images: all "No images (...)" | |
| L-16 | works | loc-mdwiki-flavors.png: MDWiki offers "Full 2.3 GB" and "Full + video 11 GB"; checked item total went from 2.3 GB to 11 GB on switch | |
| L-17 | works | nas-wiki-chromium-desk.png: MediaWiki shows "6.8 GB"; pill counts match the drill ("English 44" = "44 available") | |
| L-18 | works | loc-devdocs-selected.png "3 selected · 1.0 MB, Clear, Download selected"; all three landed in zimA | |
| L-19 | works | suite (test_bt_attempt.py) | Health check flagged my truncated copy as "does not open" |
| L-20 | works | http://download.kiwix.org URL ran as https; evil.example.com and download.kiwix.org.evil.com were refused and logged "download rejected: untrusted URL" | |
| L-21 | works | /manage/downloads `mirror_host`; log "Downloading ... from ny.mirror.driftle.ss" | |
| L-22 | works | Settings shows Max downloads 4 by default | Smallest-first order: suite |
| L-23 | works | `/manage/pause` then `/manage/resume` kept the slot and bytes; Pause all / Remove all buttons present (loc-dl-active-*.png) | |
| L-24 | broken | serveA3.log, serveA4.log | See Broken 1 |
| L-25 | works | After switch to direct, pause and resume, the HTTP `.zim.tmp` grew from 1.18 MB and continued | |
| L-26 | works | Queueing a 52.7 GB nopic gave `Not enough disk space (20 GB free, 55 GB needed)` | |
| L-27 | works | With a paused HTTP partial and `stray.zim.tmp`, cleanup removed only the stray | |
| L-28 | works | loc-dl-active-webkit-phone.png: own tab, filter pills with counts, downloads above seeds, "30% · 2m left" | "Verifying" not observed. Rate reads "0.0 MB/s" at 60 KB/s (a KB/s unit is needed below 0.1 MB/s) |
| L-29 | works | s4.js: after Download selected, the three cards flipped to "Installed" in place | |
| L-30 | works | Log "Registered devdocs_en_redux_2026-07.zim (12 entries) without a library rescan" | Stall-free on a slow machine: suite |
| L-31 | works | Window 01:00 to 06:00 at 22:55: job `queued, scheduled`; Start now completed it | |
| L-32 | works | Cap 60 KB/s: BT and HTTP ran at about 55 KB/s | |
| L-33 | works | NAS test copy: check over 78 ZIMs answered in 2.3 s; local answered in 0.1 s | |
| L-34 | works | suite (test_check_updates_flavor.py) | |
| L-35 | works | `/manage/updates` lists jq 2026-04 to 2026-07; Settings row "1 available ›" (settings-A.png) | Expansion click not driven |
| L-36 | works | Weekly on: "Auto-update: first check in 30s", then next_check +7 days; coverage split "8 tracked, 2 skipped (undated)" | Env-locked control: suite. Log says "checking every weekly" |
| L-37 | works | "Removed old version: devdocs_en_jq_2026-04.zim"; only 2026-07 on disk | |
| L-38 | works | suite (test_catalog_politeness.py, test_magnet_boot_politeness.py) | Idle only. Opening Catalog under ZIMI_OFFLINE still fetches (Broken 6) |
| L-39 | works | Deleting `медицина_fixture.zim` from `medical/` succeeded, pug still reads (200); `../dataB/cache.json` refused "Invalid filename" | |
| L-40 | works | Import of a Kiwix .zim URL downloaded it | `https://download.kiwix.org/zim/../../etc/passwd.zim` is not refused up front: it is sent upstream (400) and would have landed as `passwd.zim`. No local traversal |
| L-41 | works | Health report: 11 checked, `broken` and `empty` flagged "does not open", per-ZIM title/Q-ID index state | |
| L-42 | works | settings-Server-A-chromium.png: Cache bar by category with largest indexes | It surfaces the leaked 6.4 MB staging file from Broken 1 |
| L-43 | works | All four buttons answer; cache-rebuild-click.png "Rebuild started. Runs in the background." | |
| L-44 | works | suite (test_index_staleness.py) | |
| L-45 | works | activity-A-chromium.png: type and actor filters, downloads, deletions, update, health checks with actor | Downloads resumed after a restart are attributed to "Server" although admin started them |

## Sharing

| ID | Verdict | Evidence | Note |
|---|---|---|---|
| SH-01 | works | Log "BT download complete" for redux/liquid/pug; Downloads row "BT · 10 peers"; stall fell back to HTTP ("BT stalled ... falling back") | |
| SH-02 | broken | serveA3.log, serveA4.log | See Broken 1 |
| SH-03 | not tested | | Needs a Pi. On Python 3.14 (no wheel) the install runs HTTP-only with the one-line hint (C-nolt-settings.png) |
| SH-04 | works | C-nolt-settings.png: switch off, "unavailable", reason text | The Server name field (the Nearby name) is disabled with the BT block when libtorrent is missing |
| SH-05 | works | Seeds after every download, HTTP-finished ones too (pytorch, python); seeds survived restarts; ratio shown "0.0 / 2" | Seeds dropped by the Seed off/on toggle are never restored (Broken 4) |
| SH-06 | works | suite (test_bt_seeding.py) | |
| SH-07 | works | loc-downloads-tab.png "0 B of 675.3 KB (ratio 0.0 / 2) · added 11 seconds ago", Pause/Remove | |
| SH-08 | works | Deleting redux removed it from `/manage/seeding` at once | |
| SH-09 | works | `stop_all` during a BT download: the download continued (10.7% to 30.1%) and files stayed | |
| SH-10 | works | Switch to direct: `source` bt became http, `.zim.tmp` appeared | Restarts from byte 0; BT bytes are not carried over |
| SH-11 | works | `bt_up_kb: 100` applied without restart (log "BT settings updated via UI") | Upload rate not measured (no leechers) |
| SH-12 | works | `bt_max_connections 50`, `max_active_downloads 2` applied live | |
| SH-13 | works | settings-Server-A-chromium.png green dot and retry; nat `upnp: mapped`, external IP found | On by default: a default install opens a router port (see Nearby section) |
| SH-14 | works | suite (test_bt_seeding.py DHT tests) | |
| SH-15 | works | Port 6881 to 6899: "libtorrent session up (bt port 6899)", UPnP remapped TCP/UDP 6899 live | mDNS TXT keeps the old port (Broken 8) |
| SH-16 | works | settings-Server-B-chromium.png: `ZIMI_BT=port=16962` greys the port only; the switch stays free | The env panel says it "locks BitTorrent", which overstates a port-only blob |
| SH-17 | broken | `/manage/seeding` 5 torrents, then 0 after off/on; seeds.json `{}` | Persistence across restart works. See Broken 4 |
| SH-18 | not tested | | Mirror on archives a .torrent for every catalog item (about 3,600 kiwix.org fetches); not appropriate here |
| SH-19 | works | dataA/bt/torrents.json holds an info_hash plus magnet or torrent_url for every installed Kiwix ZIM | |
| SH-20 | not tested | | 12-hour cycle |
| SH-21 | works | "delta-update: pre-seeded staging ... hash check salvaged 49.2 KB (12.8%)", `reused_bytes 49152` | |
| SH-22 | not tested | | `catalog_backup_ts` is present, but the row shows it only with Mirror on (app.js:12453), and Mirror was not turned on |
| SH-23 | docs wrong | browse.py output; Nearby section above | Sharing is opt-in and discovery works between two instances, but README and CHANGELOG say Nearby is off by default while every install advertises. Collision bug: Broken 7 |
| SH-24 | works | B-jq-card-webkit.png green "regress-a" pill; click pulled it: `source: peer`, url `http://10.0.0.229:8961/dl/...` | |
| SH-25 | works | B restarted with `ZIMI_OFFLINE=1` pulled 6.4 MB pytorch from A over the LAN, done | |
| SH-26 | works | Share off: LAN IP 403, loopback 206. Share on: LAN IP 206 | Public refusal: suite |
| SH-27 | works | `download-from-peer` to an unknown peer: "Peer not found"; URL is built server-side from the discovered peer | |
| SH-28 | works | suite (test_peer_download.py CGNAT tests) | |
| SH-29 | not tested | | No bridge-mode instance with Nearby on; the NAS test copy's Nearby is a server-wide setting I may not change |
| SH-30 | broken | browse.py: `bt_port 16962` advertised for B (works at boot); after live change A still said 6881 | Minor. See Broken 8 |
| SH-31 | works | ctx-loc.png / ctx-nas.png "Download ZIM file" on the card menu; saved `devdocs_en_redux_2026-07.zim` | |
| SH-32 | works | NAS (passworded): no ticket 403; ticket 200 `attachment; ...zim` and a .zim (not .zim.html) saved from the UI; reuse 403; unused ticket after 128 s 403 | |
| SH-33 | works | B pulled `медицина_fixture.zim`; header `filename*=UTF-8''%D0%BC...` | |
| SH-34 | works | `Range: bytes=x` gives 200; beyond-EOF range gives 200 (full body) | |
| SH-35 | works | suite (test_export_share.py) | |
| SH-36 | works | suite (test_p2p.py peek tests) | |
| SH-37 | works | "Moved 1 stray .torrent file(s) out of ZIM_DIR into bt/torrents" | |
| SH-38 | docs wrong | settings-Server-A-nearby-on.png | The "Advertising as <name> · N peers" line no longer exists: it is a "Server name" field and no peer count is shown anywhere in Settings. The claimed live rename works: renaming to regress-a2 changed the mDNS name and B's peer list with no restart |
| SH-39 | works | Read-only data dir: `{"error":"could not save setting (config dir not writable)"}` for both a sharing toggle and the speed limit | UI rendering of the message not captured |

## Test hygiene

All four local servers were killed. Every downloaded or copied ZIM and every data dir under the scratch folder was deleted. No regress-* adverts remain on mDNS. Nothing was changed on the NAS test copy beyond signing in, one `check-updates` read, and two `/dl/` tickets for its 222 KB `wiktionary_bs` file. The NAS test copy rate-limits by IP and six testers share one IP, so some NAS page loads hit 429/401 and were retried. That noise is not a Zimi finding.
