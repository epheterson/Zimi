# Zimi 1.8.1

A polish-and-hardening release on top of the Community Edition. The big one is **access control** — a Zimi server can now be open to everyone, limited to a chosen set of ZIMs, or sign-in-required — and the whole private-mode path is tightened so private really means private. On top of that: the offline "did you mean?" grows into the coverage 1.8.0 promised, downloads get a nightly window and bandwidth caps, and light mode gets a proper contrast pass.

## Choose who sees what

- **Three access modes for anonymous visitors.** Set your server to **Open** (the whole library, the default), **Limited** (only the ZIMs you pick), or **Private** (sign-in required to see anything). Named user accounts and their per-ZIM allowlists still work exactly as before on top of this — Limited/Private just decide what someone who *isn't* signed in gets. Set it in Manage → Users, or with `ZIMI_PUBLIC_ACCESS`.
- **Private really means private.** The private-mode gate is default-deny: every read and data endpoint is blocked for an anonymous visitor unless it's on a tiny login allowlist, so nothing leaks by omission. A corrupt policy file fails *closed*, not open.
- **Your own account, on the server.** Signed-in users can now save their bookmarks, history and preferences to their own server account and restore them on another device — each user can only ever touch their own data.

## Backup, rebuilt

- **Two clearly-separated cards** — "**My data**" (this browser's bookmarks, history and preferences) and "**Server backup**" (the library, collections, layout and every user's server-side data). Each has its own Export and Import.
- **Imports merge by default** with a preview-then-apply step and an overwrite escape hatch, and they're scope-checked so you can't drop a My-data file on the Server card (or the reverse) by mistake.

## "Did you mean?", delivered

- 1.8.0 shipped offline spelling correction and flagged that its coverage was a work-in-progress. 1.8.1 is the widening: it now finds words spread thin across your titles (mitochondria, photosynthesis), catches longer two-typo misspellings (`fotosynthesis` → `photosynthesis`), and fixes a common typo even when the misspelling itself appears in your library (`einstien` → `einstein`) — all still built entirely from your own ZIMs, with no network, ever.
- The corrected vocabulary is now cached to disk, so it isn't rebuilt on every start.

## Downloads on your terms

- **Nightly window** — schedule downloads to run only inside a time window (say, overnight); anything you start outside it waits, with a start-now override when you don't want to wait.
- **Bandwidth caps** — a download speed limit that's shared across all your transfers (so ten downloads still sum to your cap, not ten times it) and an upload limit, plus bulk Pause / Resume / Delete-all over the queue.
- **BitTorrent** — max concurrent downloads and max peer connections are now adjustable knobs.

## Read better

- **App theme** — an Auto / Dark / Light switch for the whole interface, with an option to auto-darken raw article pages when the app is dark, and a Reader View Auto theme that turns sepia in light mode.
- **Light mode contrast pass** — toggles, badges, disabled fields and icons all pass WCAG AA now, tiles are redesigned, and the Safari tab-switch flash is gone.
- **Define** clamps to the screen and dismisses on scroll like a native menu, and no longer collides with the iOS text-selection callout.
- **PDF collections** (`zimgit-*` ZIMs) render as a searchable document list — title, author, size, description — instead of a raw page.
- **Video ZIMs** remember where you left off, size correctly on phones, and get a random-video card.

## Fixes

- **#38** — in-page `#fragment` links (single-page docs like devdocs) now scroll instantly instead of hanging for 15 seconds behind a loading spinner.
- **Health report** now catches a ZIM that opens fine but is a broken scrape — every article an empty shell, or its media all 0-byte — and flags it, instead of reporting it healthy.
- **Snippets** on iFixit device pages show the device's own description instead of the one repeated boilerplate blurb baked into every page.
- Raw articles no longer overflow sideways on narrow screens; the **Move to…** menu stays put and stays on-screen.

## Under the hood

- **BitTorrent installs by default** now. `pip install zimi` pulls libtorrent automatically wherever a prebuilt wheel exists — CPython 3.9–3.13 across Linux (glibc *and* Alpine/musl, including ARM NAS), macOS and Windows — closing the 1.8.0 gap where a bare pip install left you on HTTP-only. No wheel for your interpreter (e.g. Python 3.14, which has none yet)? Zimi quietly falls back to HTTP and tells you the one-line fix; `pip install zimi[bt]` forces it.
- **Security hardening** across the private-mode path: the service worker no longer caches identity or library endpoints (fixing a "sign in twice" bug and a stale-library leak), and a new HttpOnly admin session cookie means a private-mode admin sees the full library and can open articles again — revoked on logout and on any password change.

## Also in the box

- The almanac gains a real bright-star field, a Regional / Worldwide holidays toggle, a wider set of cities with click-anywhere map selection, and more of its stars, planets and people linking straight into your installed encyclopedias.

## Install

```bash
brew tap epheterson/zimi && brew install --cask zimi   # macOS
sudo snap install zimi                                  # Linux
docker run --network host -v ./zims:/zims -v ./zimi-config:/config epheterson/zimi
pip install zimi
```

Windows: download the installer from the release page.

Full detail in [CHANGELOG.md](https://github.com/epheterson/Zimi/blob/main/CHANGELOG.md).
