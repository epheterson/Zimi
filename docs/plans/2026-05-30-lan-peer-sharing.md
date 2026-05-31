# LAN Peer ZIM Sharing over HTTP — Build Plan (2026-05-30)

Part of the v1.7.0 Reach release. Closes the gap between "peer discovery exists" and "peers can actually share ZIMs."

## The gap (verified in code)

Peer *awareness* is fully built; peer *transfer* does not exist:
- `p2p_discovery.py` advertises/browses `_zimi._tcp`, peers carry host/port/bt_port — but bt_port/host are **never fed into any transfer**.
- `library.py` BT path only ever pulls the **Kiwix `.torrent` companion** (`_resolve_torrent_url`, trusted-Kiwix-only). aria2 runs with **DHT off**.
- `app.js:_downloadFromPeer()` calls `downloadZim(kiwix_url)` with a comment claiming "BT naturally pulls from the LAN peer." **False.** Every byte comes from Kiwix. Offline → the peer pill fails.

## Design (approved)

HTTP is the universal substrate; BitTorrent stays an optional internet/Kiwix-swarm accelerator only.

- **LAN/offline peer→peer = direct HTTP range pull from the peer + verify.** Pure Python, no binary, works in Docker/pip/desktop identically.
- **The existing HTTP download machinery already does range/resume/atomic-rename** (`_download_thread` mirror loop → `_download_from_url`). So a peer download is, at core, `_start_download(<peer_file_url>)`. The only genuinely new backend capability is the peer *serving* a raw `.zim` over HTTP+Range.
- Not "two flows": HTTP base + optional BT turbo for the public swarm.

## Backend

### 1. Serve raw `.zim` over HTTP+Range (new capability)
- New route, e.g. `GET /dl/<zim_name>` in `http.py`. Resolve `zim_name` → path via `get_zim_files()` (known-names only; **no arbitrary path → no traversal**).
- Stream from disk in chunks (must NOT load multi-GB into memory; current range code at `http.py:1240` reads in-memory ZIM *content* — different path). Reuse `_parse_range` (`http.py:1342`).
- Emit `Accept-Ranges: bytes`, `206 Partial Content` + `Content-Range` on range, `Content-Length`, `Content-Type: application/octet-stream`.
- **Safe-by-default exposure:** serve only when client remote IP is private/loopback/link-local, OR `ZIMI_PEER_SHARE_PUBLIC=1`. Master toggle `ZIMI_PEER_SHARE` (default on). Prevents WAN (`knowledge.zosia.io`) from vacuuming ZIMs.

### 2. Peer manifest: exact size + optional sha
- Extend the peer-facing list (`/list` → `list_zims()` at `server.py:631`) to add `size_bytes` (exact, for byte verification) and `sha256` **only if already cached** (never hash a 90 GB file on demand — would hammer NAS disk; compute lazily/once, store in `cache.json`).

### 3. Peer download path + verification
- `_downloadFromPeer` (client) → POST a peer-file URL to download enqueue. Reuses `_start_download` → mirror loop. (`_resolve_torrent_url` returns None for non-Kiwix host, so BT is correctly skipped.)
- After download: verify `size_bytes` matches (mandatory); verify sha256 if the peer advertised one (best-effort). Mismatch → fail loudly, discard `.tmp`.
- Surface `_source: "peer"` + peer name in `dl` so the UI/activity bar can label it.

## UI/UX

### 4. Make the peer pill tell the truth
- `_downloadFromPeer(url, peerName)` (`app.js:3345`): build the **peer** URL (`http://<peer host:port>/dl/<file>`) from peer data, not the Kiwix url. Need peer host:port — extend `/manage/peers/list` items or `/manage/peers` to carry it (discovery already has host+port in `_peers`).
- Remove the fictional "BT naturally pulls from peer" comment. Toast/labels become accurate ("Downloading from <peer> over LAN").
- Progress lands in the existing downloads UI + activity bar (already wired via `dl` fields). Label peer transfers distinctly (📡 LAN).
- Offline-friendly: if Kiwix is unreachable but a peer has it, the pill is the *primary* path, not a hint.

## Packaging — all distribution flows

### 5. Fix discovery dependency + verify each flow
- `zeroconf` is in `requirements.txt` but **missing from `pyproject.toml` deps** → `pip install zimi` gets no mDNS. Add it (and confirm `certifi`/`libzim` set is right).
- Verify enablement matrix:
  - **Docker:** aria2 bundled (BT), zeroconf via requirements. Peer-serve + peer-pull pure-python ✓
  - **pip:** zeroconf now a dep → discovery ✓. Peer transfer pure-python ✓. BT optional (no aria2; fail-soft already handled).
  - **desktop pywebview:** same server code → ✓. Confirm the bundled app ships zeroconf.

## Tests + validation

### 6. Quality gate
- Unit: range parsing on raw-file endpoint, private-IP gate, size/sha verification (match + mismatch), manifest fields.
- Integration: two local instances on loopback/distinct ports — B pulls a small ZIM from A over `/dl/`, verifies, lands in ZIM_DIR. **Offline** (no internet) must succeed.
- The real 3-machine offline test (iMac .229 / mini .149 / NAS) as final ratification.
- Update `CLAUDE.md` architecture (add `p2p.py`, `p2p_discovery.py`, refresh line counts), CHANGELOG, memory. Remove the fictional comment.

## Risk / decisions
- **sha on giant files:** never hash on demand. Size-match is the mandatory floor; sha is opportunistic (cached only). Acceptable for trusted LAN.
- **WAN exposure:** private-IP gate is the safe default; public sharing is explicit opt-in.
- **BT untouched:** this work doesn't modify the aria2/Kiwix path — lower blast radius.

## Build order
1. Serve endpoint (`/dl/<name>`, range, IP gate) + tests
2. Manifest fields (`size_bytes`, cached sha)
3. Client peer-download + verification
4. UI truth-fix (peer pill → peer URL, labels, activity bar)
5. Packaging (zeroconf dep) + per-flow verify
6. Tests green + offline integration + docs/memory
