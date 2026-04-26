# P2P / Torrent ZIM Sharing — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task.

**Goal:** Turn every Zimi instance into a distribution node. ZIM files are large, static, content-addressed — perfect for BitTorrent. Critical for off-grid / mesh scenarios where a few seeded devices serve the rest of a community.

**Architecture:** Use `aria2c` as the BitTorrent client subprocess (already common, MIT, no Python C-deps). `aria2c --enable-rpc` runs as a sidecar; Zimi controls it via JSON-RPC. Local-network discovery via mDNS/Zeroconf. Info-hashes come from Kiwix's published `.torrent` companions next to each `.zim` on download.kiwix.org.

**Tech Stack:** Python 3.10+, `zeroconf` (already pure-Python), `aria2c` binary (Synology + most Linuxes have it), JSON-RPC over HTTP localhost.

---

## Pre-work / unknowns to resolve in Task 0

- **Does Kiwix publish `.torrent` next to every `.zim`?** Spot-check 5 random URLs:
  ```bash
  for u in $(curl -s "https://library.kiwix.org/catalog/v2/entries?count=10" | grep -oE 'https://download.kiwix.org/zim/[^"]+\.zim'); do
    curl -sI "${u}.torrent" | head -1
  done
  ```
  If yes → use those. If no → fall back to magnet links derived from `.meta4` checksums or generate our own `.torrent` server-side (more complex).

- **Is `aria2c` installable on Synology DSM?** Check `/usr/local/bin/aria2c` or `synogear`. If not, build static binary.

- **Mesh routing tradeoff:** mDNS only works on same L2 segment. Cross-subnet mesh would need a tracker. Out-of-scope for v1; document as limitation.

---

## Task 0: Verify pre-work

**Step 1:** Run the spot-check above; commit findings to `docs/plans/p2p-feasibility.md`.
**Step 2:** Decide on torrent-source strategy and update this plan if `.torrent` companions don't exist.

## Task 1: aria2c sidecar lifecycle

**Files:**
- Create: `zimi/p2p.py` (~250 lines)
- Test: `tests/test_p2p_aria2.py`

Subprocess management: spawn `aria2c --enable-rpc --rpc-listen-all=false --rpc-listen-port=6800 --bt-tracker= --dir=$ZIM_DIR`. Health-check via JSON-RPC `aria2.getVersion`. Restart on death. Stop on Zimi shutdown.

**Tests:** mock subprocess; verify start/stop/restart paths. RPC client uses bounded retries.

## Task 2: Replace `_download_thread` with aria2-driven path (opt-in)

**Files:**
- Modify: `zimi/library.py` (`_download_thread` learns to delegate to aria2)
- Add: `ZIMI_TORRENT=1` env opt-in flag

When the flag is set, `_start_download` queues via aria2 instead of urllib. `aria2.addTorrent` if `.torrent` URL is given, else `aria2.addUri`. Progress polled via `aria2.tellStatus`.

**Why opt-in:** existing urllib path is rock-solid; aria2 path is new. Let users opt in until proven.

## Task 3: mDNS discovery — `_zimi._tcp.local`

**Files:**
- Create: `zimi/p2p_discovery.py` (~150 lines)
- Test: `tests/test_p2p_discovery.py`

Advertise on Zeroconf: name=`<hostname>`, port=`<HTTP_PORT>`, TXT records `version=1.6.x`, `zim_count=N`. Browse for peers; cache for 30s. New endpoint `/manage/peers` returns the list.

## Task 4: Catalog UI — peers row

**Files:**
- Modify: `zimi/static/app.js` (catalog drilldown)

When a discovered peer has a ZIM the user wants, show a "From peer @home-nas (LAN)" pill alongside the Kiwix download. Click → fetch from peer instead of internet.

## Task 5: Info-hash storage on installed ZIMs

**Files:**
- Modify: `zimi/server.py` (extend metadata cache with `info_hash`)
- Modify: `zimi/library.py` (compute on download success)

Store the info-hash (SHA1 of bencoded info dict) in the metadata cache. Lets a peer answer "do you have this exact ZIM?" by hash, not name.

## Task 6: Seeding mode

**Files:**
- Modify: `zimi/p2p.py` (auto-seed installed ZIMs when ZIMI_SEED=1)

Tell aria2 to start seeding every installed ZIM that has a known info-hash. New endpoint `/manage/seeding` to view + toggle per-ZIM.

## Task 7: Sub-plan for "Become-a-mirror" (W3.6)

Once seeding works, the mirror toggle is just "set ZIMI_SEED=1 and expose `/catalog` to peers." Document the additional steps:
- HTTP basic auth on `/catalog` for upstream-only access
- Bandwidth caps via aria2 `--max-overall-upload-limit`
- Public-facing safety: rate-limit + connection cap

## Verification

- `pytest tests/test_p2p*.py`
- Two-machine LAN test: install Zimi on a second host (RPi), advertise a ZIM, watch it appear in the first instance's `/manage/peers`.
- Cross-restart durability: kill aria2, verify Zimi restarts it without losing state.

## Out of scope

- **Public trackers / DHT**: limit to LAN by default. DHT brings legal/privacy concerns; opt-in only via `ZIMI_DHT=1`.
- **Web-based BitTorrent (WebTorrent)**: doesn't share peers with native clients. Would need a separate parallel implementation. Skip.
- **P2P search**: out of scope; peers only share ZIMs, not query results.

## Estimate

Five working sessions:
1. Tasks 0-1: aria2 sidecar + RPC plumbing
2. Task 2: download path delegation
3. Task 3-4: mDNS + UI
4. Task 5-6: hash storage + seeding
5. Task 7 + cross-machine testing
