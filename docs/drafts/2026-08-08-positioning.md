# Positioning drafts for 1.9 (Workstream E)

Status: DRAFT. Nothing in this file ships without Eric's review. Every piece of public text below is a proposal.

Assumptions baked into the README draft, all true on branch `v1.9` as of 2026-08-08: `--zim-dir/--data-dir/--host` flags shipped, ZIM auto-discovery shipped, `deploy/docker-compose.yml` and `deploy/kubernetes.yaml` exist, `zimi backup`/`restore` exist. If any of these get cut from 1.9, the corresponding README lines come out.

---

## Section 1: README rewrite (full draft)

Rationale in one line: the current README is a feature brochure (12 bullets of "what is Zimi" before anyone sees an install command). This draft is a tool manual: what it is in two sentences, then four ways to run it, then why it is different. The almanac drops from a headline bullet to one line, per Eric: "this is a ZIM viewer with a fun thing to click on, not that thing itself."

Everything between the BEGIN/END markers is the proposed README.md, verbatim.

<!-- BEGIN README DRAFT -->

# Zimi

[![CI](https://github.com/epheterson/Zimi/actions/workflows/ci.yml/badge.svg)](https://github.com/epheterson/Zimi/actions/workflows/ci.yml)
[![Docker Pulls](https://img.shields.io/docker/pulls/epheterson/zimi)](https://hub.docker.com/r/epheterson/zimi)
[![PyPI](https://img.shields.io/pypi/v/zimi)](https://pypi.org/project/zimi/)
[![Lighthouse Accessibility](https://img.shields.io/badge/Lighthouse%20a11y-100%2F100-success?logo=lighthouse&logoColor=white)](docs/plans/2026-04-26-accessibility.md)
[![i18n](https://img.shields.io/badge/i18n-10%20languages-blueviolet)](#languages)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Zimi is a self-hosted server for ZIM files, the format [Kiwix](https://kiwix.org) uses to pack entire websites, Wikipedia included, into single files. Point it at a folder of ZIMs and you get search across every source at once, a clean reader, a JSON API, and an MCP server for AI agents, all of it working with no internet at all.

It runs the same from a USB stick in a basement to a NAS in a closet to a managed fleet. One package, no editions, no setup wizard: Zimi serves whatever ZIMs it finds.

## Quickstart

Pick the path that matches where your ZIMs live. All four end at http://localhost:8899.

### Python

```bash
pip install zimi        # or: uv tool install zimi
zimi serve --zim-dir ./zims
```

### Docker

```bash
docker run -p 8899:8899 -v ./zims:/zims -v ./zimi-config:/config epheterson/zimi
```

For a real deployment, use the maintained compose file instead. It pulls the released image, documents every choice in comments, and never needs the source tree:

```bash
curl -fsSLO https://raw.githubusercontent.com/epheterson/Zimi/main/deploy/docker-compose.yml
mkdir -p zims && docker compose up -d
```

A Kubernetes manifest lives next to it. See [deploy/](deploy/) for both, and [docs/deployment-networking.md](docs/deployment-networking.md) for what Zimi talks to on the network and how to make that zero.

### Desktop

macOS: `brew tap epheterson/zimi && brew install --cask zimi`, or grab the DMG from [Releases](https://github.com/epheterson/Zimi/releases).

Windows: the installer from [Releases](https://github.com/epheterson/Zimi/releases).

Linux: `sudo snap install zimi`, or the AppImage from [Releases](https://github.com/epheterson/Zimi/releases).

### A folder of ZIMs and nothing else

Put the app (or the Windows zip build) in a folder next to your `.zim` files and launch it. Zimi finds ZIMs beside the executable and in the current directory, keeps its state next to them, and quietly falls back to a local cache directory when the media is read-only. A USB stick with ZIMs and a Zimi binary is a complete, working installation on any machine, forever, with no internet.

Anything you set explicitly always wins over discovery: `--zim-dir`, `ZIM_DIR`, a Docker mount, or a folder chosen in the desktop app.

## What makes it different

**Built for agents, not just browsers.** An MCP server for Claude and friends, a `/chunks` endpoint for deterministic, embedding-free RAG chunking, and an OpenAPI 3.1 description at `/openapi.json`. Your local AI tools can search, read, and cite your offline library like it was the web.

**A polite Kiwix citizen.** An idle Zimi makes zero requests to kiwix.org. Downloads arrive over BitTorrent and seed back to the Kiwix swarm at a ratio you choose, and one switch turns your library into a full mirror. Kiwix built the commons; Zimi tries to give back more than it takes.

**Your machines share.** Turn on Nearby and Zimi instances find each other on your LAN and pass ZIMs around at LAN speed, over plain HTTP, no internet involved.

**Search that hits everything.** One query across all sources, 100M+ articles, spelling suggestions computed offline, results ranked so the right answer lands on top.

**One server, many readers.** Serve the whole library openly, limit anonymous visitors to a chosen shelf, or require sign-in, with named accounts and per-ZIM access lists. `zimi backup` and `zimi restore` carry users, policies, and settings between machines in one JSON file.

**Actually multilingual.** Switch any article into any language it exists in, ten UI languages, RTL support throughout.

**Accessible.** Keyboard, screen reader, high contrast: built in, not bolted on. Lighthouse 100/100.

There is also an almanac hiding behind the moon on the home page. It computes the sky locally and will keep doing so long after the internet is gone.

## Screenshots

| Homepage | Search Results |
|----------|---------------|
| ![Homepage](screenshots/homepage.png) | ![Search](screenshots/search.png) |

| Language Switching | Catalog |
|-------------------|---------|
| ![Languages](screenshots/language-dropdown.png) | ![Catalog](screenshots/browse-library.png) |

## Configuration

Most people set nothing. Every setting has a sensible default or lives in the UI, and `zimi config` prints the resolved configuration with where each value came from.

| Variable | Default | Description |
|----------|---------|-------------|
| `ZIM_DIR` | `/zims` | Path to ZIM files. Scanned one level deep. |
| `ZIMI_DATA_DIR` | `/config` (Docker) or `$ZIM_DIR/.zimi` | Cache, indexes, settings, users. Back this up; the ZIMs are re-downloadable. |
| `ZIMI_MANAGE_PASSWORD` | none | Protect library management. |
| `ZIMI_PUBLIC_ACCESS` | `open` | What an anonymous visitor sees: `open`, `limited` (an admin-chosen allowlist), or `private` (sign-in required). |
| `ZIMI_BT` | `on` | BitTorrent transfers and seeding. `off`, or a comma list like `on,port=6881,ratio=2,mirror=off`. `ratio=0` means never seed. |
| `ZIMI_NEARBY` | `off` | LAN sharing between your Zimi devices: `off`, or `on,name=my-zimi`. |

<details>
<summary>All variables</summary>

| Variable | Default | Description |
|----------|---------|-------------|
| `ZIMI_MANAGE` | `1` | Library manager. `0` for a read-only instance. |
| `ZIMI_AUTO_UPDATE` | `0` | Auto-update ZIM content (`1` to enable; also a UI setting). |
| `ZIMI_UPDATE_FREQ` | `weekly` | `daily`, `weekly`, or `monthly`. |
| `ZIMI_RATE_LIMIT` | `60` | Requests/min/IP for anonymous clients. `0` disables. |
| `ZIMI_RATE_LIMIT_TRUSTED` | `600` | Budget for logged-in clients. |
| `ZIMI_API_TOKEN` | none | Pin the API token instead of generating in the UI. |
| `ZIMI_HOT_ZIMS` | none | Comma-separated ZIM names to pre-warm at startup. |

The full `ZIMI_BT` grammar (ports, connection caps, UPnP, DHT, mirror mode) and bridge-network Docker details are in [docs/deployment-networking.md](docs/deployment-networking.md).

</details>

## API

The read API is stable and described at `/openapi.json`. The endpoints agents and integrations use most:

| Endpoint | Description |
|----------|-------------|
| `GET /search?q=...&limit=5&zim=...&lang=...` | Full-text search across sources. `fast=1` for title matches only. |
| `GET /read?zim=...&path=...&max_length=8000` | Article as plain text. |
| `GET /chunks?zim=...&path=...&size=1200&overlap=120` | Deterministic article chunking for RAG clients. |
| `GET /suggest?q=...&limit=10` | Title autocomplete. |
| `GET /list` | All sources with metadata. |
| `GET /random?zim=...` | Random article. |
| `GET /article-languages?zim=...&path=...` | Languages an article is available in. |
| `GET /w/<zim>/<path>` | Raw ZIM content. |
| `GET /health` | Health check with version. |

```bash
curl "http://localhost:8899/search?q=water+purification&limit=5"
curl "http://localhost:8899/read?zim=wikipedia&path=A/Water_purification"
```

Collections, resolve, snippets, and the rest are in [`/openapi.json`](docs/api-stability.md).

## MCP server

```json
{
  "mcpServers": {
    "zimi": {
      "command": "python3",
      "args": ["-m", "zimi.mcp_server"],
      "env": { "ZIM_DIR": "/path/to/zims" }
    }
  }
}
```

For Docker on a remote host:

```json
{
  "mcpServers": {
    "zimi": {
      "command": "ssh",
      "args": ["your-server", "docker", "exec", "-i", "zimi", "python3", "-m", "zimi.mcp_server"]
    }
  }
}
```

Tools: `search`, `read`, `get_chunks`, `deep_search`, `read_with_links`, `suggest`, `list_sources`, `random`, `article_languages`, `list_collections`, `manage_collection`, `manage_favorites`.

## Integrations

- **[SearXNG](docs/integrations/searxng.md)**: route queries through Zimi from a self-hosted metasearch instance.
- **[OpenWebUI / generic AI](docs/integrations/openwebui.md)**: wire the MCP server into any AI client for offline research.

## Languages

English, French, German, Spanish, Portuguese, Russian, Chinese, Arabic, Hindi, Hebrew. Language is wired through everything: filtered lists, labeled sources, per-article language switching, RTL.

## Contributing

Bugs and feature requests: [Issues](https://github.com/epheterson/Zimi/issues). Every issue filed against Zimi so far has been answered with a fix.

Questions and ideas: [Discussions](https://github.com/epheterson/Zimi/discussions). <!-- TBD: Discussions is enabled on the repo but not yet announced. This line ships only on Eric's go. -->

Code: see [CONTRIBUTING.md](CONTRIBUTING.md). Security reports: [SECURITY.md](SECURITY.md), privately please.

## License

[MIT](LICENSE). Desktop and Docker builds bundle [libtorrent-rasterbar](https://libtorrent.org/) (BSD-3-Clause); see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

---

Built in California by [@epheterson](https://github.com/epheterson) and [Claude Code](https://claude.ai/code).

<!-- END README DRAFT -->

### What changed vs the current README, and why

1. **Leads with what it is and how to run it.** Two sentences, then quickstart. The current README spends 12 marketing bullets and 5 screenshots before the first install command. Evaluators (the 1.9 audience) decide in the quickstart, not the brochure.
2. **Four install paths, including the two new 1.9 stories.** The deploy/ compose file becomes the recommended Docker path (it did not exist when the current README was written), and drop-binary-in-a-folder gets its own section because auto-discovery now makes it true.
3. **Almanac demoted to one line.** Currently it is a headline bullet ("Fresh daily... a live almanac sky"). Per Eric it is an easter egg, so it gets exactly one dry sentence at the end of the differentiators.
4. **Removed sections:** "Long-requested, shipped here" (issue-number name-dropping reads as inside baseball to a stranger; the content survives as release notes), the standalone "Sharing" deep-dive (condensed into two differentiator paragraphs; the full grammar moves to deployment-networking.md), the static "tests-1244" and WCAG badges (hand-maintained numbers drift; CI badge stays because it is live).
5. **No em dashes anywhere,** one line per paragraph, no exclamation marks.

### Open questions for Eric

- The Discussions line is in the draft with a TBD comment. Ships only on your go.
- The `WCAG 2.1 AA` badge: kept out because it is self-asserted. If you want it back, it goes next to the Lighthouse badge.
- "Built with love in California" footer: I dropped the heart emoji, kept the sentence. Your call.
- The env table now says "Scanned one level deep" for `ZIM_DIR`; if the one-level scan gets cut from 1.9, revert that cell.

---

## Section 2: GitHub repo polish checklist

Current state, verified read-only on 2026-08-08 via `gh repo view` / `gh release list`.

**Description line.** Current: "The offline internet — searchable, browsable, and self-updating. A modern server for ZIM files with cross-source search, built-in library management, JSON API and MCP server." Two problems: it has an em dash, and "The offline internet" leads with the metaphor instead of the noun. Proposed replacement (needs Eric approval, it is public text):

> Self-hosted server for ZIM files: offline Wikipedia and 1,000+ other sources with cross-source search, a web reader, a JSON API, and an MCP server for AI agents.

**Topics.** Current: `api, docker, kiwix, knowledge-base, mcp, offline, self-hosted, wikipedia, zim`. Solid base. Proposed additions (GitHub allows 20): `offline-first`, `ai-agents`, `rag`, `python`, `selfhosted` (the r/selfhosted crowd searches both spellings), `pwa`, `bittorrent`. Skip `mcp-server` only if the topic does not exist yet; if it does, add it, that is how people find MCP servers now.

**Social preview.** Almost certainly unset (default GitHub card). Suggest: 1280x640 PNG, dark homepage screenshot with the word "Zimi" and the one-liner overlaid, exported once for 1.9 and updated per major release only. This is the image every HN/Reddit/Slack link unfurls to, so it is worth 20 minutes. Needs Eric to upload (repo Settings, no API for it worth automating).

**About sidebar / homepage URL.** Currently empty. Suggest pointing it at https://hub.docker.com/r/epheterson/zimi (the most useful third-party surface) unless Eric wants a project page later. Do not use knowledge.zosia.io; that is a personal instance, not a demo commitment.

**Releases.** Current and healthy: v1.8.2 is Latest (2026-08-08), five releases in the last three weeks. No action. One nit: release titles are inconsistent ("Zimi v1.8.2" vs "Zimi 1.8.1" vs "v1.7.4"). Pick one form for 1.9 ("Zimi 1.9.0" reads best in the sidebar) and keep it.

**Screenshots.** All five PNGs date from Jul 28 (1.8.0). The UI has since gained did-you-mean, access modes, and the 1.8.2 almanac work, but the five screenshotted views themselves have not visibly changed, so they are current enough to ship 1.9 with. Recommend a refresh pass anyway as part of the 1.9 release checklist, same five shots, because "screenshots match the release" is cheap credibility. The `sharing.png` shot drops out of the README draft above; keep the file for docs.

**Badges.** The static "tests-1244 passing" badge is already stale the moment a test lands and links to `#`. Drop it (done in the draft). Everything else is live-generated.

**Discussions.** Already enabled on the repo (`has_discussions: true`) but unannounced and unlinked. Decision needed from Eric before the README links it: enabling was the cheap half, answering within a day or two every time is the commitment.

---

## Section 3: Placement plan

Ordered by value per unit of effort. The honest summary: every single one of these needs Eric personally, either because it is public text under his name or because the venue bans or distrusts anything else. My drafts below are starting points for his rewrite, not submissions.

### 1. awesome-selfhosted

**Eligibility, checked against their live CONTRIBUTING (awesome-selfhosted-data repo):** first release must be more than 4 months old (Zimi's v1.6 shipped 2026-03-23, so eligible as of late July); active maintenance required (five releases in three weeks, trivially met); FOSS license with SPDX identifier (MIT, met). Zimi qualifies cleanly.

**The catch that matters:** their rules explicitly ban "machine/LLM-generated contributions" on penalty of ban. So this one Eric writes himself, in his own words, full stop. The value of the YAML below is telling him which fields exist, not giving him text to paste.

**Mechanics:** PR to `awesome-selfhosted/awesome-selfhosted-data`, new file `software/zimi.yml`. Fields: name, website_url, source_code_url, description (they reject descriptions containing "self-hosted" or "open-source" as redundant), licenses, platforms, tags. Likely tags from their taxonomy: Wikis, Search Engines, or Archiving and Digital Preservation; Eric should browse `tags/` in their repo and pick what fits.

**Effort:** 1 hour. **Value:** high and permanent; it is the canonical discovery list for this audience and entries compound for years. **Needs Eric:** yes, entirely, per their LLM rule.

### 2. Hacker News, Show HN

**Proposed title** (80 char limit, no em dashes):

> Show HN: Zimi, a self-hosted server for offline Wikipedia and 1,000+ ZIM archives

**Proposed first comment, for Eric to rewrite in his own voice:**

> Author here. Zimi serves ZIM files, the archive format Kiwix uses to pack whole websites into single files. Point it at a folder of them and you get full-text search across every source at once, a reader, a JSON API, and an MCP server so local AI tools can search and cite the library. Everything works with zero internet, including a version that runs straight off a USB stick.
>
> It builds on Kiwix's ecosystem rather than replacing it: the content all comes from their library, downloads arrive over BitTorrent and seed back to their swarm, and an idle instance makes zero requests to their servers. Python, MIT, no build step, no database. Happy to answer questions.

**Timing note:** Show HN posts live or die on the author answering comments for the first 3 to 4 hours. Post on a weekday morning US time when Eric can actually be present. Do not post 1.9 day if release firefighting is possible; the week after is fine.

**Effort:** 30 minutes to post, half a day of presence. **Value:** highest single-day exposure available, plus HN is exactly the MCP/agents/offline-preparedness audience. High variance; a miss costs nothing. **Needs Eric:** yes, his account, his words, his presence in the thread.

### 3. r/selfhosted

The posts that land there are "I built X" with screenshots, an honest limitations paragraph, and the author in the comments. Blatant marketing gets torn apart; builders get adopted.

**Proposed post body (title: "I built Zimi, a server that turns a folder of ZIM files into a searchable offline library"):**

> Zimi is a server for ZIM files, the format Kiwix uses to pack Wikipedia, Stack Exchange, dev docs, and about a thousand other sites into single files. One container pointed at a folder of ZIMs gets you search across every source at once, a clean reader with dark mode, user accounts with per-ZIM access lists, and a JSON API plus MCP server so your local AI stack can do research against your offline library. Downloads arrive over BitTorrent and seed back to the Kiwix network at a ratio you set. MIT, Python, single container, no external services, and everything keeps working with the internet unplugged. Screenshots in the repo. Happy to answer anything, including "why not just kiwix-serve" (short answer: cross-source search, accounts, the agent API, and library management with auto-updating).

**Effort:** 1 hour. **Value:** high; this is the core NAS-guy audience from Eric's 1.9 range, and good posts there convert to sustained GitHub traffic. **Needs Eric:** yes, his Reddit account, and Reddit sniffs out ghostwritten PR fast; he should rework the paragraph into his own phrasing.

### 4. r/DataHoarder

Different angle for a different crowd: they care about the collection, mirroring, and resilience, not the UI.

**Proposed post body (title: "A server for your ZIM collection: search it, share it on your LAN, and seed it back as a mirror"):**

> If you hoard ZIMs, Zimi turns the folder into a searchable library: full-text search across every archive, real article counts, auto-updates that reuse unchanged pieces of the old file instead of re-downloading 100 GB, resumable downloads, and LAN transfer so your machines pass ZIMs to each other at wire speed with no internet. There is also a one-switch mirror mode that lifts the seeding cap and gives your whole collection back to the Kiwix swarm. I run it against ~575 GB on a Synology. MIT, Docker or pip.

**Effort:** 30 minutes if posted alongside the r/selfhosted one (space them a week apart, do not cross-post the same text). **Value:** medium; smaller overlap but the mirror-mode story is uniquely strong here. **Needs Eric:** yes, same reasons.

### 5. Kiwix community channels

The real story after 1.8.2: Zimi deliberately became a better citizen of Kiwix's infrastructure, and several features requested in their issue trackers exist in Zimi today. This message has to be delivered as a peer offering things, not as a product announcement in someone else's living room.

**Proposed message (for the Kiwix Slack or forum; Eric should verify which channel is actually active before posting, and consider emailing the team directly given the mirror angle):**

> Hi, I build Zimi, an MIT-licensed server for ZIM files on top of libzim. Two things worth sharing here. First, the last release focused on being a good citizen of your infrastructure: an idle instance now makes zero requests to library.kiwix.org, downloads default to BitTorrent and seed back to the swarm at a user-set ratio, and there is a one-switch mirror mode for people who want to give back long-term. If the swarm behavior looks wrong from your side ever, tell me and I will treat it as a bug. Second, a few things people have asked for in your trackers are implemented in Zimi and the approaches are all MIT if any are useful upstream: offline spelling suggestions (libzim #731), read-aloud via Web Speech (kiwix-js #166), and resumable delta downloads. Happy to compare notes.

**Effort:** 1 hour including finding the right channel. **Value:** strategically the highest on this list; Kiwix's goodwill (or a mention from them) legitimizes Zimi to the entire ZIM ecosystem, and the mirror feature is a genuine gift to them. Also the riskiest to get wrong. **Needs Eric:** absolutely; this is relationship-building between maintainers, not a posting task.

### 6. alternativeto.net

Create a listing for Zimi as an alternative to Kiwix / kiwix-serve. Fields: name, description, license, platforms, screenshots, links. Low ongoing SEO value but permanent, and the Kiwix page there gets steady traffic from exactly the right searchers.

**Effort:** 30 minutes. **Value:** low but nonzero and compounding. **Needs Eric:** the account can be anyone's, but the description is public text under Zimi's name, so it gets his review like everything else; this is the one item where the mechanical work could be done for him with text he approved.

### Sequencing suggestion

awesome-selfhosted first (permanent, no timing sensitivity), then r/selfhosted, then Kiwix outreach, then Show HN once 1.9 is out and stable (HN should land on the best version of the README, which is why Section 1 gates everything), r/DataHoarder and alternativeto whenever. Do not do all of them the same week; staggered posts each get their own traffic instead of cannibalizing one wave.
