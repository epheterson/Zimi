# Zimi 1.8.0 — Community Edition

**You asked. Zimi listened.**

This is the release the people using Zimi shaped: every open issue on the tracker answered, the ZIM ecosystem's longest-standing requests built, a native Windows app, and a real API for agents.

---

## You filed it. We fixed it.

- **New ZIMs are easy to spot** — a **New** badge on anything freshly installed, plus **Recently added** and **Recently updated** filter pills on your home library (30-day window). The badge clears when you open the ZIM. → [#34](https://github.com/epheterson/Zimi/issues/34)
- **Organize your library your way** — right-click any ZIM (or use the ⋯ gear on its Manage row) to **move it into another category**, including brand-new ones you name, and **drag your home sections into any order** from the Reorder panel in Manage. → [#37](https://github.com/epheterson/Zimi/issues/37)
- **Settings stop locking you out on your own network** — Tailscale and other CGNAT clients (100.64.0.0/10) now count as your private network, so Manage doesn't force a password prompt over the tailnet. → [#36](https://github.com/epheterson/Zimi/issues/36)
- **"Not found" errors, gone** — in-page `#fragment` links in single-page docs (devdocs) resolve instead of 404ing, and leftover `.zim.torrent` files no longer masquerade as broken ZIMs (they're moved aside at startup). → [#38](https://github.com/epheterson/Zimi/issues/38)
- **Country holidays get their own colour** on the calendar, distinct from worldwide observances, and place correctly on every calendar system. → [#33](https://github.com/epheterson/Zimi/issues/33)

## The ecosystem asked, too

- **"Did you mean?"** — offline spelling correction on weak searches, built entirely from your own library's vocabulary. No network, ever. (The long-standing offline spell-check ask, [libzim#731](https://github.com/openzim/libzim/issues/731).) *Coverage grows with your title indexes — a work-in-progress we're widening in 1.8.1.*
- **Read aloud** — a speak/stop control in the reader uses your browser's offline speech engine. ([kiwix-js#166](https://github.com/kiwix/kiwix-js/issues/166).)

## Read the way you want

- **Reader View** — a Safari-Reader-style clean reading column: ZIM chrome (navboxes, infoboxes, edit links) stripped, wide tables wrapped, dark by default, with **Dark / Light / Sepia** themes, serif or sans, an A−/A+ text size, and an **AUTO** mode that opens articles straight into it. Reach it from the reader's **⋯ menu**.
- **Word lookup** — **double-tap or select any word** inside an article and a small **Define** popover appears; tap it for the first definition, pulled from your own installed **Wiktionary**. It follows your language, works in the normal reader and Reader View, and stays out of the way when no Wiktionary is installed.
- **Tap-to-zoom images** — a scaled-down image opens full size in a lightbox.
- **Print, Save as PDF, and Share** — a new row in the Reader palette.

## One server, your whole household

- **Named user accounts** on top of the existing password admin — sign in and out, manage everyone from an admin **Users** pane (Manage → ⋯ → Users). Roles are **admin / user / limited**, with an optional management username and last-login tracking. Single-password installs need zero migration.

## For agents and developers

- **`GET /chunks`** — deterministic, embedding-free article chunking for RAG clients, with stable content-addressed chunk IDs (the same ZIM and parameters produce identical IDs on every server; a ZIM update rolls them).
- **`GET /openapi.json`** — a real OpenAPI 3.1 description of the read API, with `info.version` tracking the running server.
- **MCP `get_chunks`**, did-you-mean passed through MCP search, plus a documented API stability policy in `docs/api-stability.md`.

## Downloads that don't lose your progress

- **Resumable downloads** — quit mid-download and it picks up where it left off.
- **Delta updates** — updating a ZIM that has a torrent reuses the unchanged pieces of the old file instead of re-fetching gigabytes; the download shows how much it saved.
- **Download-this-ZIM buttons** on the source header and every Manage row (where the raw file can actually be pulled), a **switch-to-direct** escape hatch for a stuck torrent, and **seeding goals** with a progress bar that survives restarts.

## A native Windows app

A one-dir `Zimi-windows-x64.zip` (Edge WebView2) that **self-updates via WinSparkle**, signed with the same appcast key as the macOS Sparkle path, with a per-user installer that needs no admin rights.

## Also in the box

- **Library health report** — Manage → library runs a per-ZIM ✓/⚠ check (main page, entry count, index status, size against the catalog, age).
- **Save your bookmarks to a ZIM** — export them to a standalone `.zim` any reader can open.
- **Instant Catalog** (stale-while-revalidate), **faster update checks** (concurrent OPDS fetches), **compact tile view**, **language pills and badges** so six same-named Wikipedias are finally tellable apart, and **real article counts** on every card.

## Under the hood

- **One BitTorrent engine** — the aria2 sidecar is gone, replaced by in-process libtorrent: real per-torrent stats, fast-resume, no stray processes or RPC ports. Bare `pip install zimi` falls back to HTTP as always.
- **Security hardening** — a P0 libzim segfault race fixed, `/dl/` no longer exposed to the public internet, the multi-user surface locked down, and a cross-user search-cache leak closed.
- **Ten languages, audited** — every user-visible string translated, English leaks closed, orphan keys removed.

## Install

```bash
brew tap epheterson/zimi && brew install --cask zimi   # macOS
sudo snap install zimi                                  # Linux
docker run --network host -v ./zims:/zims -v ./zimi-config:/config epheterson/zimi
pip install zimi
```

Windows: download the installer from the release page.

Full detail in [CHANGELOG.md](https://github.com/epheterson/Zimi/blob/main/CHANGELOG.md).
