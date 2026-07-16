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
- [ ] Trusted tier: valid Bearer credential (result cached 5 min by digest —
      PBKDF2 once, not per request) OR passwordless + private-IP client.
      `ZIMI_RATE_LIMIT_TRUSTED` env, default 10x base (600/min).
- [ ] `/snippet` moves to the content bucket (20x) — 10 fetches per search
      tripped the 60/min API budget for anonymous users (item 21).
- [ ] Client: 429 never clears a panel — keep last-known content, honor
      Retry-After for the next poll.
- [ ] Extract `_is_private_client()` (shared with `_peer_share_allowed`).
- [ ] DECISION: skip endpoint consolidation (item 9) tonight — with the
      trusted tier, 3 polls/2s = 90/min against 600/min budget; rewiring
      three client consumers into one endpoint is regression risk without
      user-visible gain. Revisit if telemetry says otherwise.

### W2 — Downloads robustness (items 15, 2, 12) [task 23]
- [ ] Auto-resume download queue after server restart (persist queue,
      resume .zim.tmp partials via existing resume machinery).
- [ ] Enforce `should_pause_for_disk_pressure` in the download loop.
- [ ] Dedup duplicate Wikipedia results in cross-ZIM search.

### W3 — UI polish (items 11, 4, 6, 7) [task 24]
- [ ] Reader-close URL desync (history state vs closed reader).
- [ ] RTL bidi isolation on mixed-direction rows.
- [ ] Button-family unification (CSS base class per CLAUDE.md).
- [ ] env_controlled copy dedupe (one i18n string, one helper).

### W4 — Almanac worldliness (#28, item 19) [task 25]
- [ ] World timezone picker: full UTC offset range with representative
      cities, not US-centric list.
- [ ] Worldwide holidays: fixed national days (major countries) + computed
      movable feasts (Easter math, Islamic approximations flagged ±1 day).
      All offline math/data, no APIs.

### W5 — Server extras (items 10, 13, 24) [best effort, task 26]
- [ ] /manage private-IP gating when passwordless.
- [ ] Thumbnail server prefetch.
- [ ] Mirror lifecycle: retire old-version seeds on update.

## Held back (not tonight)
- aria2 bundled in DMG/AppImage — next release headline (pipeline validation).
- Post-world resilience (item 25), true mirror mode (20) — design work.
- qBittorrent backend (22), UPnP (23) — new dependencies.
- a11y rewriter default-ON (3) — needs Eric decision, separate discussion.

## Ship checklist
- [ ] Full suite green after each wave; new tests per behavior change.
- [ ] CHANGELOG [1.7.2] with user-facing Highlights (tight, no em-dashes).
- [ ] pyproject + snap/server versions handled by existing drift test.
- [ ] NAS deploy for overnight soak; morning smoke before Eric merges.
- [ ] PR to main; Eric merges; two-gate release (verify assets → publish).
- [ ] Replies to #30 (Eric's text) and #28 after publish.
