# Zimi 1.7.0 — Reach + Pro

**The release that helps your library find every reader, on every network, at every ability.**

## Highlights

### 🌐 Reach: P2P discovery and BitTorrent transport

Zimi instances on the same LAN now find each other automatically over mDNS. When you browse the catalog, ZIMs that a peer already has show a green **📡 peer-name** pill — click it to download from the LAN at gigabit speed instead of pulling from the WAN.

- BitTorrent-first downloads via a bundled `aria2` sidecar (`ZIMI_TORRENT=1`)
- Default 2× ratio seeding, disk-pressure auto-pause, ratio-bar UI per torrent
- Public-mirror mode: `ZIMI_MIRROR=1` lifts caps for people running an actual mirror
- Custom peer names: `ZIMI_PEER_NAME="Eric Home Mirror"` to override the auto-generated one

### ♿ Accessibility: build once, benefit everyone forever

**Lighthouse a11y score: 100/100.** Zimi now works for screen-reader users, keyboard-only users, low-vision users, and users who need reduced motion or forced-color modes.

- New "Improve ZIM article accessibility" toggle in Preferences runs every article through a server-side rewriter that adds missing alt text, ensures one heading per article, and fills in document language. Validated on Wikipedia: **42 of 42 images now have alt** (was 17 of 42).
- Skip-to-main-content link, dialog focus-trap with Esc-to-close, focus-restore, screen-reader live region for toasts, sr-only descriptions for the canvas-based almanac sky scene
- High-contrast amber `:focus-visible` ring, dotted underlines on text-block links, WCAG 2.5.5 touch targets
- Forced-colors / Windows High Contrast support
- Every icon button has both `aria-label` and `data-i18n-aria` (announced in the user's UI language)

### 📦 Pro: 1000+ ZIM scale UX

The full set of fixes from issue #15 (warlordattack feedback at 1000+ ZIM scale):

- Pro hot-cache, download queue with concurrency cap, multi-select downloads, pause/resume, filter pills
- Catalog hierarchy detection with bundle/subset relationship badges
- SearXNG + OpenWebUI integration docs
- Updates Available section, top-search analytics, cache management UI
- Languages and default flavor preferences

### 🐛 Fixed (#16)

- **Wikipedia maxi auto-updating to mini** — auto-update now filters catalog candidates to the same flavor as the installed file
- Almanac crash on render
- Bitwarden / 1Password ignoring the manage password input
- "Remember me" not persisting across tab close

## Networking note

Recommended deployment is now `network_mode: host` so mDNS LAN discovery and BT seeding work without manual port plumbing. Bridge mode still works, with explicit port mappings for 6881 (BT TCP+UDP) and 5353 (mDNS UDP). See [docs/deployment-networking.md](deployment-networking.md) for the full discussion.

## Test + validation footprint

- 458 unit tests, all passing
- Lighthouse a11y 100/100 against the live site
- Two-machine LAN test confirmed peer discovery + catalog peer-pill rendering end-to-end

## Upgrade

Docker:

```yaml
services:
  zimi:
    image: epheterson/zimi:1.7.0
    network_mode: host
    volumes:
      - ./zims:/zims
      - ./zimi-config:/config
    environment:
      - ZIMI_TORRENT=1
```

PyPI: `pip install --upgrade zimi`
