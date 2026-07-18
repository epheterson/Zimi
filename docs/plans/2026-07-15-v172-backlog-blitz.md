# v1.7.2 — Backlog Blitz (one big push, 2026-07-15 evening)

Fast-follow shipping user reports #30/#28 plus every backlog item that can
land at high quality in one night. Eric merges in the morning after NAS soak.

## Decrees
- Authenticated clients get a HIGHER rate limit, not a bypass.
- Reply to #30 with Eric's own text ("D'oh! We're exceeding our own rate
  limit...") once the release is published.
- Quality bar: every item validated; drop items cleanly rather than ship shaky.

## Waves

### W1 — Rate limiter (#30, items 21, 9) [task 22]
- [x] Trusted tier: valid Bearer credential (result cached 5 min by digest —
      PBKDF2 once, not per request) OR passwordless + private-IP client.
      `ZIMI_RATE_LIMIT_TRUSTED` env, default 10x base (600/min).
- [x] `/snippet` moves to the content bucket (20x) — 10 fetches per search
      tripped the 60/min API budget for anonymous users (item 21).
- [x] Client: 429 never clears a panel — keep last-known content, honor
      Retry-After for the next poll.
- [x] Extract `_is_private_client()` (shared with `_peer_share_allowed`).
- [x] DECISION: skip endpoint consolidation (item 9) tonight — with the
      trusted tier, 3 polls/2s = 90/min against 600/min budget; rewiring
      three client consumers into one endpoint is regression risk without
      user-visible gain. Revisit if telemetry says otherwise.

### W2 — Downloads robustness (items 15, 2, 12) [task 23]
- [x] Auto-resume download queue after server restart (persist queue,
      resume .zim.tmp partials via existing resume machinery).
- [x] Enforce `should_pause_for_disk_pressure` in the download loop.
- [x] Dedup duplicate Wikipedia results in cross-ZIM search.

### W3 — UI polish (items 11, 4, 6, 7) [task 24]
- [x] Reader-close URL desync (history state vs closed reader).
- [x] RTL bidi isolation on mixed-direction rows.
- [x] Button-family unification (CSS base class per CLAUDE.md).
- [x] env_controlled copy dedupe (one i18n string, one helper).

### W4 — Almanac worldliness (#28, item 19) [task 25]
- [x] World timezone picker: full UTC offset range with representative
      cities, not US-centric list.
- [x] Worldwide holidays: fixed national days (major countries) + computed
      movable feasts (Easter math, Islamic approximations flagged ±1 day).
      All offline math/data, no APIs.

### W5 — Server extras (items 10, 13, 24) [best effort, task 26]
- [x] /manage private-IP gating when passwordless.
- [x] Thumbnail server prefetch.
- [x] Mirror lifecycle: retire old-version seeds on update.

## Held back (not tonight)
- aria2 bundled in DMG/AppImage — next release headline (pipeline validation).
- Post-world resilience (item 25), true mirror mode (20) — design work.
- qBittorrent backend (22), UPnP (23) — new dependencies.
- a11y rewriter default-ON (3) — needs Eric decision, separate discussion.

## Ship checklist
- [x] Full suite green after each wave; new tests per behavior change.
- [x] CHANGELOG [1.7.2] with user-facing Highlights (tight, no em-dashes).
- [x] pyproject + snap/server versions handled by existing drift test.
- [x] NAS deploy for overnight soak; morning smoke before Eric merges.
- [x] PR to main; Eric merges; two-gate release (verify assets → publish).
- [x] Replies to #30 (Eric's text) and #28 after publish.


## Day extension (2026-07-16, Eric: "push on", ship after 5 PM)

All landed on the same branch, each validated:
- [x] Desktop aria2 sidecar (DMG/AppImage) — validated by dispatch CI run
      (all 3 builds green incl. new smoke assertion that BT reaches ready)
- [x] Port health row: open/closed/unknown + UPnP (stdlib SSDP/SOAP,
      default on, env-lockable) + Retry — validated against real router
      (read-only) + local UI
- [x] Post-world: catalog persists to disk, served stale offline with UI
      note; BT downloads keep infohash/magnet/.torrent
- [x] True mirror mode: seeds whole installed library (hash-check in
      place); retire_stale_seeds at startup + after updates
- [x] Thumbnail prefetch (gentle, capped, once per run)
- [x] APOD stale-day fix, tinted clock grid + glyphs, location-driven
      holidays + caption/tooltips (morning batch)
Deliberately NOT tonight: qBittorrent backend, NAT-PMP, holiday packs
beyond 17 countries.
