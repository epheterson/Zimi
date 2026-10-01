# App candidates (running list)

Eric, 2026-09-28: "keep a running list of apps that make sense ie data we have easy access too and no nice interface or place for".

An app earns a place when the library already holds the data, in a shape Zimi can read cheaply, and nothing today gives it a good home. Add to this list whenever new data shows up; move a row to "Built" when it ships.

**The bar** (Eric, 2026-09-28): "Some of these are good ideas but if we can't parse and display with good enough info the original experience might be better." An app has to beat the ZIM's own pages, or it isn't built. Counts are from Kiwix's catalog snapshot (2,653 ZIMs, 2026-09) unless noted; see `2026-09-28-app-coverage.md` for the evidence.

## Candidates

| App | The data we have | Where it lives today | Recommendation |
|---|---|---|---|
| **Labs** (PhET) | 114 ZIMs, 7.8 GB: interactive science simulations, listed per language in each ZIM's `catalog.js` (id, title, categories, topics) | Each ZIM's own page | Build next: one file per ZIM, 114 languages, and nothing else in Zimi is interactive like it |
| **Khan Academy** (Kolibri) | 3 ZIMs, 442 GB of lessons and videos, a Kolibri content tree | Its own page; not in ZimiTube | Next after Labs: one Kolibri tree walker feeds ZimiTube (videos by course) and Bookshelf (African Storybook, 5,165 picture books) |
| **Health** | WikiMed (mdwiki), zimgit Medical Library, Military Medicine, LibreTexts Medicine, Wikipedia's medical articles | Scattered across Zimipedia, Bookshelf and the reader | Strong for Zimi's offline audience: first-aid cards up front, then conditions and drugs across every medical source, never presented as advice |
| **Prepared** | zimgit water, food, knots and post-disaster libraries, survivorlibrary and other captured PDF libraries | Bookshelf documents (from 1.12) | A task-first view over the same documents: water, fire, shelter, first aid, food, power |
| **Travel, in Maps** | Wikivoyage (24 ZIMs, guides and phrasebooks), maps, Wikipedia places | Zimipedia and Maps, separately | A trip-planning view inside Maps: destinations, travel times between them, the language at each, the guide, things to know and do; turn-by-turn later |
| **Dictionary** | Wiktionary (146 ZIMs); the reader's Define popover already looks words up | The Define popover, Discover's Word of the day | A word page across every installed Wiktionary: meanings, pronunciation, etymology, translations; later with Saved lists for vocabulary |
| **Docs** | devdocs (231 ZIMs, `navbar.json` contents per ZIM), Gentoo and Arch wikis, the PHP manual | Each ZIM on its own | Start as a search scope and one contents view across docs; a full app only if that proves thin |
| **Repair** (iFixit) | 12 ZIMs, 42.7 GB, 188k guides by device | The ZIM's own interface, which works | Later: a guide walker by device and part |
| **Nearby** | Wikipedia articles with coordinates, maps | Not surfaced | "What's around here" on a map. To verify: which Wikipedia builds keep article coordinates |
| **Zimi Earth** | The Almanac's 3D Earth (1.12), maps, Wikipedia articles with coordinates, satellites, Wikivoyage | Pieces in the Almanac, Maps and Zimipedia | A Google Earth of the library: drag the globe, see places, articles, day and night and satellites together |
| **Zimiflix** (Eric, 2026-09-29: "For ZimiTube I can point it to my own tv and movie directories?... I literally had the idea for Zetflix or Zimiflix... Especially for people's random folders that may be hard to discover otherwise.") | Your own media folders (Eric's NAS: tv, movies, movies4k), read in place without packing into a ZIM | Nothing; ZimiTube only reads ZIMs (a folder packed with Create a ZIM) | ZimiTube, or a sibling app, over local media folders: posters, seasons, continue watching; needs a folder indexer, metadata and a player for large files |
| **Arcade** | The library itself: a link race across Wikipedia, geography from maps, Wiktionary word games, On this day trivia | Nothing | Parked by Eric (2026-09-27: "maybe not arcade this time") |

## Eric's reactions (2026-09-28)

- **Labs:** "sounds interesting".
- **Khan Academy:** "isn't an app like school or I dunno, not saying no just needs to be reframed, and picture books with academy?" Picture books are not a Khan thing: they belong on the shelf. Khan needs a frame of its own before it is built.
- **Health and Prepared:** "Hospital or First Aid or I dunno, maaaaybe or combine health and prepared into one? Can it be done well tho?" Open: one app, and only if the sources parse into something better than their own pages.
- **Travel:** "seems odd but maybe. Or can be built into maps like a combined view for planning trips and travel maybe flight and driving times between destinations and language at each and things to know and do and stuff I dunno. I did want turn by turn eventually." So Travel is a Maps feature, not an app: trip planning, travel times, languages, things to know and do; turn-by-turn is the long-term goal.
- **Dictionary:** "done really well might be nice, especially if it's like a nice down the wormhole experience."
- **Docs:** "maaaybe reader view could help and sorting but we might not have enough info."
- **Nearby:** "Wikipedia on the map is interesting."
- **Arcade:** "someday".
- **Zimi Earth** (new): "maybe we need Zimi Earth like Google earth that has a bunch of the stuff mixed?" The Almanac's 3D Earth (1.12) is the seed: the globe you can drag, with maps, Wikipedia places, satellites, day and night, and travel on it. Nearby and Travel may belong inside it.

## Eric's reactions (2026-10-01)

- **Dictionary:** building in 1.13: "seeing the same word in all is nice. Can it speak the word!? Properly!?"
- **Travel in Maps:** "interesting".
- **Zimi Earth:** "when we get whole solar system maybe, and more features" (with 2.0's flown solar system).
- **Labs and School:** "would be cool to like follow through lesson plans and keep track or something": lesson paths through the simulations and courses, with progress kept like Bookshelf's places.
- **The rest:** "a lil hairy".

## Folded into existing apps (not separate apps)

- Audiobooks and document-library videos: ZimiTube (1.12).
- Documents, textbooks, Wikisource, Wikibooks, EPUB and PDF folders: Bookshelf (1.12).
- Wikiquote and Wikispecies: Zimipedia v2's one-topic strip.
- freeCodeCamp and MOOCs: their own pages already work; no app.

## Built

- Maps, ZimiTube, ZimiExchange, Reddot (1.10); Bookshelf (1.11); Zimipedia (opt-in in 1.11; v2 in 1.12); the Almanac (always).
