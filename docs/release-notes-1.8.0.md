# Zimi 1.8.0 — Community Edition

**The release the community asked for.**

Every open issue addressed, the ZIM ecosystem's longest-standing requests
shipped, and a native Windows app. 260+ commits, 1,025 tests.

---

## The headline

**Your almanac now opens your library.** Tap a planet, a star, a constellation,
a holiday, or the Rosetta Stone — and the matching article opens from your own
installed encyclopedias, in your language. No internet, no search box, no
guessing: a curated set of entities mapped to Wikidata IDs, each verified, that
resolve against whatever you actually have installed. Nothing installed for it?
It stays quiet text. It never guesses.

**A time machine to go with it.** A real instrument: a three-row time circuit,
a brass lever you pull — ease it for minutes, throw it for centuries — and the
sky, the planets, the moon and the calendars all move with you. Land on a date
and feel it. Type year 10000, or −10000, and see what the sky does. Forward to
a 2040 eclipse or back to the night you were born.

## For everyone who asked

- **"Did you mean?"** — offline spelling correction on weak searches, built from
  your own library's vocabulary ([libzim#731](https://github.com/openzim/libzim/issues/731))
- **Read aloud** — text-to-speech in the reader, no network ([kiwix-js#166](https://github.com/kiwix/kiwix-js/issues/166))
- **Reader View** — a clean reading mode with themes, fonts, and text size
- **Word lookup** — tap any word in an article, get the definition from your own
  Wiktionary
- **User accounts** — named logins with roles; a *limited* account only sees the
  ZIMs you allow. One server, whole household or classroom.
- **A native Windows app** — with the same signed auto-update channel as macOS
- **Resumable downloads** — quit mid-download and it picks up where it left off,
  and a ZIM update reuses the unchanged pieces of the old file instead of
  fetching gigabytes again
- **Library organization** — move any ZIM to a different category, reorder your
  sections, and see recently added and updated at a glance
- **Health report** — check any ZIM's integrity on demand

## For agents and developers

- `GET /chunks` — deterministic, embedding-free article chunking for RAG
  clients, with stable content-addressed chunk IDs
- `GET /openapi.json` — a real OpenAPI 3.1 description of the read API
- MCP `get_chunks`, plus a documented API stability policy

## Under the hood

- **One BitTorrent engine.** The aria2 sidecar is gone, replaced by in-process
  libtorrent: real per-torrent stats, fast-resume across restarts, no stray
  processes or RPC ports.
- **Trust that matches reality.** Tailscale and other CGNAT clients count as
  your private network, so management stops locking you out over the tailnet.
- **Ten languages, audited.** Every user-visible string is translated in all ten.

## Fixed

Issues #34 (filter pills), #36 (management locked over Tailscale), #37 (library
organization), #38 (devdocs `#fragment` links 404'ing, plus stray `.torrent`
files flagged as broken ZIMs) — plus a long tail of polish across the reader,
the almanac, the catalog, and mobile.

## Install

```bash
brew tap epheterson/zimi && brew install --cask zimi   # macOS
sudo snap install zimi                                  # Linux
docker run --network host -v ./zims:/zims -v ./zimi-config:/config epheterson/zimi
pip install zimi
```

Windows: download the installer from the release page.

Full detail in [CHANGELOG.md](../CHANGELOG.md).
