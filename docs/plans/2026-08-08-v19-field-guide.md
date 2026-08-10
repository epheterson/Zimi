# 1.9 field guide — validate it yourself

Every feature below has a two-minute check you can run with your own hands. The browser features run against the preview instance; the CLI features run on your Mac from the repo. Nothing here touches prod.

**Preview instance: http://10.0.0.14:8905** — the `v1.9` branch against the real 53-ZIM library, mounted read-only, own state, torrenting off. Prod at knowledge.zosia.lan is untouched and stays 1.8.2. The preview copied prod's metadata cache and bookmarks at first boot, so it looks like home; changes you make there stay there.

For CLI checks: `cd ~/Repos/zimi` (branch `v1.9`), and `alias z='python3 -m zimi'` if you like.

## The USB stick story (portable discovery)

```
mkdir -p /tmp/stick && cp /tmp/zimi-empty/*.zim /tmp/stick/ && cd /tmp/stick
python3 -m zimi serve --port 8765
```

No env, no flags, no config. Expect: it announces the discovered directory, serves the ZIMs, and state lands in `/tmp/stick/.zimi`. Then prove explicit config still wins: `ZIM_DIR=/zims python3 -m zimi config` from the same directory shows `(env: ZIM_DIR)`, not the discovery.

## zimi config, and where every value comes from

```
python3 -m zimi config
ZIMI_DATA_DIR=/var/lib/nope python3 -m zimi config
```

First: four rows, each with provenance (default / discovered). Second: same table plus a `warning:` line naming the unwritable dir and its source, exit 0. Then try `ZIMI_DATA_DIR=/var/lib/nope python3 -m zimi backup /tmp/b.json` and watch a write-command refuse with one line, exit 2.

## Backup and restore, round trip

```
cd /tmp && rm -rf bk && mkdir -p bk/zims bk/data
python3 -m zimi backup --zim-dir bk/zims --data-dir bk/data
ls -la zimi-backup-*.json        # expect -rw------- (0600)
rm -rf bk/data
python3 -m zimi restore zimi-backup-*.json --zim-dir bk/zims --data-dir bk/data
```

Expect: backup prints what it captured, restore prints applied vs skipped, and the data dir is recreated from nothing.

## ZIMI_OFFLINE, provable silence

```
ZIMI_OFFLINE=1 ZIMI_BT=on python3 -c "from zimi import p2p; print(p2p.is_torrent_enabled(), p2p.get_backend(data_dir='/tmp/x'))"
```

Expect `False None` even though BT was explicitly requested. For the full proof, run a server under `ZIMI_OFFLINE=1` with Little Snitch watching, or `sudo tcpdump -i any host library.kiwix.org` in another terminal: zero packets, including at boot.

## The boot-time kiwix call is gone

```
rm -rf /tmp/pol && mkdir /tmp/pol
ZIM_DIR=/tmp/zimi-empty ZIMI_DATA_DIR=/tmp/pol python3 -m zimi serve --port 8766
# second terminal, after ~15s:
ls /tmp/pol                       # expect NO catalog_cache.json
```

Before the fix this wrote `catalog_cache.json` about two seconds after boot, every boot, on every instance with torrenting on.

## Prometheus metrics

```
curl -s http://10.0.0.14:8905/metrics | head -30
```

Expect `# HELP` / `# TYPE` pairs, `zimi_` prefixes, counters ending `_total`, and a `_sum`/`_count` latency pair per endpoint. (Preview has no admin password, so the LAN open-admin rule lets you read it; on a passworded instance it needs the API token, same as /manage.)

## App update checking (#76, your ask)

Preview → Manage → Server → **App updates**. Expect current version, a Check now pill, and because the preview identifies as Docker, the instruction is a `docker compose pull` snippet. `ZIMI_OFFLINE` or no network: one quiet line, no button.

## The four issue fixes (browser, on preview)

- **#48**: Almanac → summon the time machine → GO to 2100. The solar system's planets move; its sliders dim; its readout says Jun 2100. Return to now: sliders wake, local clock resumes.
- **#49**: right-click the Zimi logo → "Open link in new tab" exists and works. Same on the Almanac card, source tiles, search results.
- **#50**: Catalog → search mdwiki. One card, flavors "Maxi" and "Full + video", exactly one checkmark, and the 10.75GB video build is never the preselected default.
- **#51**: can't be clicked on the preview (torrenting off); the evidence is the measured numbers in commit b8bd0ec: worst lock wait 10.6s → 0.45s, archives opened 53 → 1, plus a live test that a /read answers while a registration is deliberately stalled mid-extraction.

## In-article bookmarks + calendar glide

Preview → open any article → bookmark button in the reader chrome opens your tree over the article; Escape closes the panel, not the reader. Almanac → pick a date in another month: the grid glides instead of popping. System Settings → Reduce Motion kills the glide.

## Share an exported ZIM between devices

Preview → Bookmarks → Export to ZIM. The new card carries a Download button. Your iMac's Zimi should list the preview's exports under Catalog → "On nearby devices"… except the preview has torrenting and its own quirks — the honest check is between your iMac and Mac Zimi instances, where it already surfaced five real exports during testing.

## Timezone map, 2026 politics

Preview → Almanac → sun map. Click Moscow: +3 lights all of western Russia (was +4 politics from 2014). Kathmandu +5:45, Chatham +12:45. Click McMurdo: the +12 station zone lights with New Zealand.

## Chinese calendar ΔT (the one you can't click)

The proof is reference data, not our own output: `tests/test_almanac_deltat.cjs` pins all 67 Chinese New Years 1920–1986 and the 16 moved month boundaries to the Hong Kong Observatory's published conversion tables (hko.gov.hk, T-year files). Spot-check one by hand: HKO's T1954e.txt says CNY 1954 = Feb 3; we now say Feb 3; we used to say Feb 4.

## The config file carries real settings now (wave 4)

```
cd /tmp && mkdir -p cfgdemo && cat > cfgdemo/zimi.json <<'EOF'
{"zim_dir": "/tmp/zimi-empty", "manage": false, "offline": true, "hot_zims": ["wikipedia_en_all_maxi"]}
EOF
ZIMI_CONFIG=/tmp/cfgdemo/zimi.json python3 -m zimi config
```

Expect eleven rows, with manage/offline/hot_zims showing `(config file: ...)` as their source and the secrets masked. Then export `ZIMI_OFFLINE=0` and re-run: offline flips to `(env: ZIMI_OFFLINE)` — your environment always beats the file.

## Update channels and the update delay

Preview → Manage → Server → App updates now has a channel select (Latest (recommended) / Beta (early releases)). Latest is the default and behaves exactly as the check always did: finished releases, the day they ship. Beta takes whatever is newest — pre-release or final — and marks a prerelease quietly. There is no "Stable" channel by design; `stable` is accepted as a synonym for `latest` in the env var, over the API, and in a preference file written by an earlier build. Set `ZIMI_UPDATE_CHANNEL=latest` on a server and the select greys out with an env-controlled note, and writes to it return 403.

Below it sits Update delay: None / 1 / 3 / 7 / 14 / 30 days. Pick 7 and a release published today is not offered until next week — Manage says "1.9.1 is out — offering it in 7 days" rather than claiming you are up to date. `ZIMI_UPDATE_DELAY_DAYS` locks it the same way the channel variable does, and accepts any whole number of days, not just the presets. `ZIMI_OFFLINE` still silences the whole feature, both controls and all.

## Air-gapped install bundle

```
cd ~/Repos/zimi && ./scripts/make-airgap-bundle.sh --out /tmp/bundle
```

Expect ~34 wheels, an install.sh, INSTALL.md, SHA256SUMS, and a tarball. The install refuses to run if any file's checksum fails, and the build refuses to include a source distribution (an sdist is a promise to download build tools the target can't keep). Cross-build for a Pi with `--target linux-arm64`.

## Deep time has no timezones

Almanac → sun map, then time machine → GO to 1500. The zone borders, label gutter and offset chips are gone — clean continents and terminator only. Try 1885: the civil layer sits at half strength (and the Paris offset chip reads +0:09, which is not a bug, it is Paris Mean Time). Return to now: full grid back.

## Export without the freeze

Bookmarks → Export to ZIM on the preview. The moment the export lands, search in another tab — no stall. Before wave 4 the export finished by re-scanning all 69 ZIMs under the global lock, same bug class as the Pi crash in #51.

## zimi create — a folder or a page becomes a ZIM

```
mkdir -p /tmp/pack && printf '# Field Notes\n\nWater: boil 1 min.\n' > /tmp/pack/README.md
cp ~/Documents/*.pdf /tmp/pack/ 2>/dev/null
python3 -m zimi create /tmp/pack --title "Field Notes" --out /tmp/pack.zim
ZIM_DIR=/tmp your-favorite-check: python3 -m zimi list
```

Expect: a real ZIM with your markdown rendered and PDFs inside, openable in any Kiwix reader. Then try a live page: `python3 -m zimi create https://example.com --out /tmp/page.zim`. Try it on a JS-heavy SPA and it refuses with a message naming zimit instead of packaging a loading spinner. `ZIMI_OFFLINE=1` refuses URL mode outright.

## What has no demo yet

Identity (design only, waiting on your OIDC/Cloudflare call), k8s manifest against a real cluster, and the two P0s from the Pi audit (delete-under-lock, uncapped media serve) which are queued but not yet fixed. If it's not in this guide, treat it as unproven.
