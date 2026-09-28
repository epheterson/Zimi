# App candidates (running list)

Eric, 2026-09-28: "keep a running list of apps that make sense ie data we have easy access too and no nice interface or place for".

An app earns a place when the library already holds the data, in a shape Zimi can read cheaply, and nothing today gives it a good home. Add to this list whenever new data shows up; move a row to "Built" when it ships. Counts are from Kiwix's catalog snapshot (2,653 ZIMs, 2026-09) unless noted; see `2026-09-28-app-coverage.md` for the evidence.

## Candidates

| App | The data we have | Where it lives today | Recommendation |
|---|---|---|---|
| **Labs** (PhET) | 114 ZIMs, 7.8 GB: interactive science simulations, listed per language in each ZIM's `catalog.js` (id, title, categories, topics) | Each ZIM's own page | Build next: one file per ZIM, 114 languages, and nothing else in Zimi is interactive like it |
| **Khan Academy** (Kolibri) | 3 ZIMs, 442 GB of lessons and videos, a Kolibri content tree | Its own page; not in ZimiTube | Next after Labs: one Kolibri tree walker feeds ZimiTube (videos by course) and Bookshelf (African Storybook, 5,165 picture books) |
| **Health** | WikiMed (mdwiki), zimgit Medical Library, Military Medicine, LibreTexts Medicine, Wikipedia's medical articles | Scattered across Zimipedia, Bookshelf and the reader | Strong for Zimi's offline audience: first-aid cards up front, then conditions and drugs across every medical source, never presented as advice |
| **Prepared** | zimgit water, food, knots and post-disaster libraries, survivorlibrary and other captured PDF libraries | Bookshelf documents (from 1.12) | A task-first view over the same documents: water, fire, shelter, first aid, food, power |
| **Travel** | Wikivoyage (24 ZIMs, guides and phrasebooks), maps, Wikipedia places | Zimipedia and Maps, separately | One destination page: the guide, the map, the phrasebook, and what else the library has about the place (via Q-ID) |
| **Dictionary** | Wiktionary (146 ZIMs); the reader's Define popover already looks words up | The Define popover, Discover's Word of the day | A word page across every installed Wiktionary: meanings, pronunciation, etymology, translations; later with Saved lists for vocabulary |
| **Docs** | devdocs (231 ZIMs, `navbar.json` contents per ZIM), Gentoo and Arch wikis, the PHP manual | Each ZIM on its own | Start as a search scope and one contents view across docs; a full app only if that proves thin |
| **Repair** (iFixit) | 12 ZIMs, 42.7 GB, 188k guides by device | The ZIM's own interface, which works | Later: a guide walker by device and part |
| **Nearby** | Wikipedia articles with coordinates, maps | Not surfaced | "What's around here" on a map. To verify: which Wikipedia builds keep article coordinates |
| **Arcade** | The library itself: a link race across Wikipedia, geography from maps, Wiktionary word games, On this day trivia | Nothing | Parked by Eric (2026-09-27: "maybe not arcade this time") |

## Folded into existing apps (not separate apps)

- Audiobooks and document-library videos: ZimiTube (1.12).
- Documents, textbooks, Wikisource, Wikibooks, EPUB and PDF folders: Bookshelf (1.12).
- Wikiquote and Wikispecies: Zimipedia v2's one-topic strip.
- freeCodeCamp and MOOCs: their own pages already work; no app.

## Built

- Maps, ZimiTube, ZimiExchange, Reddot (1.10); Bookshelf (1.11); Zimipedia (opt-in in 1.11; v2 in 1.12); the Almanac (always).
