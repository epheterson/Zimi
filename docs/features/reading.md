# Reading

Search across every ZIM at once, open an article, and read it — the part of Zimi you spend the most time in, and the only one that has to work with no network at all.

## How it works

**Search** runs across the whole library from one box. Results are ranked by title match, then by position within the source's own results, then by source authority (a bigger ZIM's hit outranks a tiny one's, on a log scale, capped so a large source cannot flood the page). A query with no hits gets a "did you mean" from a vocabulary and trigram pass rather than nothing; with operators in the query, only the words are corrected and every operator stays as typed. Search a single source by opening it, or by searching while you read one of its articles: the box says "Search in {source}…" (on a phone, where that does not fit, the source's chip beside the logo says where it searches) and narrows to it.

**Results.** The words searched for are marked in each result's title and snippet: a phrase as the phrase, and never an excluded word, a filter's words or a common word typed alone ("the"). When results come from three or more sources and are more than a screen (20), they are grouped by source: each source's best three under its name, the sources in the order of their best result (so an exact title still leads), and "More from {source}" runs the same search in that source alone. Fewer sources or fewer results read better as one ranked list, and so does a list narrowed with the source pills. "Show more" pages through what was found; in one source, once everything found is on screen, "More results" asks that source for up to 50. The arrow keys walk the results from the search box (Enter opens one, up from the first returns to the box), and Esc clears the search. The query, operators and all, is the address (`/?q=…`, `/w/<zim>?q=…`), so a search can be shared; taking a chip off or taking a "did you mean" is a step of its own, so Back returns to the search before it.

**Recent searches** show in the dropdown of the empty search box, with the articles recently opened. Each row has a × to take it away, and "Clear searches" takes every search away at once. They are kept in this browser only, with the rest of History; they go to a signed-in account only when My data is saved there (Settings > Preferences > My data), and nowhere else.

**Search operators.** The library search, the catalog and `GET /search` (so MCP and the CLI too) share one grammar:

| Type | Means |
|---|---|
| `word` | every word must match |
| `"two words"` | the words together, in that order (straight or curly quotes) |
| `-word`, `-"two words"` | leave out anything containing it |
| `cats OR dogs` | either one; `OR` in capitals, between two terms |
| `in:wikipedia` or `source:wikipedia` | only sources whose name or title contains it (the catalog also matches the category) |
| `lang:fr` | only sources in that language, two or three letters (`lang:fra`) |
| `-in:ted`, `-lang:en` | a filter, the other way round |

A hyphen inside a word (`e-mail`, `x-ray`) is part of the word, a lone `-` or a stray quote is ignored, and a lower-case `or` is an ordinary word. An exclusion matches from the start of a word or of a word part, case and accents aside, so `-wiki` leaves out Wikipedia, Wikipédia and MediaWiki, and `-ted` leaves out TED and TEDx but not United States (Wiktionary stays too: it does not contain "wiki"); in Chinese, Japanese, Thai and other scripts written without spaces it matches anywhere. The same operators filter the home page and Settings > Library.

What each operator did shows as a chip above the results, in the UI's language, the same in the library and the catalog: `-ted` reads "without ted", `"solar panel"` "exact: solar panel", `lang:fr` the language's name (French, Français, צרפתית), `in:wikipedia` the source's title, `cats OR dogs` "cats or dogs". A chip's × searches again without that one operator (a phrase keeps its words, as words). The ? beside the search box lists a few examples written for each language, each a tap from a search.

In the library, exclusions and phrases are checked against a result's title. libzim's own search treats `-`, quotes and `OR` as plain words, and reading every article to check its text would make these queries slow; the words themselves still match anywhere in the article. A query with only exclusions or filters (`-ted`) finds nothing in the library, since it asks for nothing; in the catalog it lists everything else. A query with no operators takes exactly the path it always did.

**The reader** opens an article in place. Titles, history and the address stay in step, so Back does what a browser's Back does and a link you share reopens the same article. `?a=<zim>/<path>` is the deep link; `/w/<zim>/<path>` serves the raw article.

**Find in page.** Cmd/Ctrl+F while an article is open, or Find in page in the reader's ⋯ menu, opens a find bar over the article: every match is tinted as you type, the one you are on more strongly, with "3 of 12", next and previous (Enter, Shift+Enter, the arrows in the bar) and Esc to close. Case, accents and Hebrew or Arabic vowel marks do not count ("cafe" finds "Café"); a match in a closed section opens it. It works in the article as the ZIM wrote it, in Reader View and in Zimipedia's reader, left to right or right to left. Outside an article (home, results, a map, an app, a PDF, which has its own), Cmd+F is the browser's. The find code (`static/find.js`) is fetched the first time a find is asked for, and adds nothing to the article's DOM (the CSS Custom Highlight API paints the matches; a browser without it selects the current match instead).

**Reader View** re-renders an article as plain, readable prose — one column, your font and size, your theme (dark / light / sepia). It is per-article, and `zimi_reader_auto` opens every article straight into it.

**Saved and history.** The bookmark button saves the article at the section you are reading; saved things go in lists (as many as you like), and the Saved panel holds them all. See [Saving](saving.md). History records what you opened. Signed in as a named account, what you save follows the account to every device; an admin without a named user keeps it in the browser, which means it is per-browser and a private window starts empty. See [Users & access](access.md).

**Word lookup (Define).** Select a word — or double-tap it on a phone — and Zimi looks it up in an installed Wiktionary. It is dormant with no Wiktionary installed. There is no tooltip advertising it; it is found the way every other text gesture is found.

**The same article in another language.** Zimi matches articles across ZIMs by their Wikidata Q-ID rather than by title, so an article open in one language offers the same subject in every other installed language edition that has it. Titles differ, redirects differ, spelling differs — the Q-ID does not. Matching is on demand and cached; nothing is precomputed for a library you never read across.

**PDFs** open in an embedded PDF.js viewer, so a ZIM full of documents (the zimgit collections) reads without leaving the page.

**Offline and installable.** A service worker precaches the shell, so Zimi opens with no server round trip and works as an installed PWA. The cache key is the asset-bundle hash, so every deploy invalidates it and a new version takes over immediately rather than waiting for tabs to close.

**Accessibility.** Zimi scores 100/100 on Lighthouse a11y and targets WCAG 2.1 AA. Passing `?a11y=1` on a content URL additionally rewrites the article server-side: fills in a missing `<html lang>`, adds empty `alt` to unlabelled images (decorative by default, per WCAG 1.1.1), and promotes a leading title `div` to a real `<h1>` so heading navigation works.

### Pages captured without their JavaScript

A page captured by the **fast** engine keeps its markup and drops every script. That is what makes it fast and what makes the archive readable in twenty years — but on a modern site the *chrome* is JavaScript, and without it three things misbehave. The reader settles them:

| What you would see | Why | What the reader does |
| --- | --- | --- |
| A large blank gap above the content | An ad slot reserves its height in CSS and waits for a script to fill or collapse it | A reserved box with nothing in it is hidden |
| A header stranded in the middle of the article as you scroll | `position: sticky`, positioned by a scroll handler that is no longer there | Sticky elements return to `static`, the flow they were written for |
| Blocks pulsing forever | Skeleton placeholders animating until content arrives, which it never does | Animations run once and stop |

None of this is a bad capture — every one of those elements is stored faithfully. It is chrome that only ever made sense with a script behind it. Each rule fires only on the exact condition it names, so an encyclopedia article (no empty ad slots, nothing pulsing) is untouched.

A page captured by **alive** keeps its scripts and does not need this; see [Creating ZIMs](making-zims.md) for what each engine trades away.

## Configure

| Setting | Where | Default | Effect |
| --- | --- | --- | --- |
| Reader theme | reader menu | follows app theme | `dark` / `light` / `sepia` for article text |
| Reader font + size | reader menu | system | Typeface and scale inside Reader View |
| Auto Reader View | reader menu | off | Open every article straight into Reader View |
| `?a11y=1` | content URL | off | Server-side accessibility rewrite of the article |
| Word lookup | — | automatic | Active when any Wiktionary ZIM is installed; dormant otherwise |

## Troubleshoot

- **Saved things vanished / a private window shows none**: you are signed in as an admin without a named user, so they live in that browser only. Create a named account and they follow you. See [Users & access](access.md).
- **Selecting a word does nothing** — no Wiktionary is installed. Add one from the catalog and the gesture starts working; nothing else needs enabling.
- **An old version of the interface keeps loading** — a hard reload clears it. The service worker takes over on the next load after a deploy; a page left open from before will still be on the old bundle.
- **A captured page still shows a gap or a stranded header** — the settling rules run in Zimi's reader. Opening the same `.zim` in another reader will show the page as captured, gap and all.
- **A link in a captured page leads nowhere** — only pages inside the capture were saved. Zimi shows what the link pointed at and offers the live address rather than a raw error.
- **An image is missing in a captured page** — see [Creating ZIMs](making-zims.md); the engine you chose decides which image sizes the archive holds.

---

## Almanac & space

A self-contained astronomical almanac that runs entirely in the browser, computed from formulas — no APIs, no network. It works forever offline.

### How it works

The almanac is a lazy-loaded mini-app (its JS loads only when you open it) reached from the Home view. Everything it shows is derived from math at render time — moon phase, sun and daylight, an animated simulated sky, an interactive star chart with a bright-star catalogue, a Keplerian solar-system orrery with a time machine, a real-timezone sun/world map, meteor showers, and deep-time views. Because it's all computed, it needs no internet and produces the same result on any machine for a given date and location.

Location is asked for once and kept **session-scoped** on purpose — the almanac is deliberately ephemeral (`zimi_almanac_location`). A "time machine" lets you drive the whole scene (orrery, sky, calendars) to any date; the sky, orrery, and map all obey it.

**Deep-links.** Almanac objects (planets, stars, and other entities) can deep-link into the installed library via a closed set of Q-IDs resolved against your ZIMs, so clicking an object opens its article when a matching source is installed.

**The 3D Earth.** Tap the glow around the Earth in the orrery to drop to a 3D Earth lit by the real Sun, with the Moon, eclipses, the ISS and the GPS satellites. The Sun, the Moon and the eclipses are computed like the rest of the almanac. The satellites are drawn from orbital elements: a snapshot ships with every release, and the server can fetch fresher ones from CelesTrak (`GET /almanac-satellites` answers at once with the newest it has). Whether it does is the one almanac setting that touches the network, **Satellite data from the internet**:

- **Ask first** (the default). Zimi never contacts CelesTrak on its own. When the data is more than six hours old, the view says its date ("Orbital data from 27 Sep") and offers an admin **Get fresh data**, which fetches once (`POST /manage/satellites/refresh`) and redraws the view. Anyone else sees the date.
- **Automatically.** A stale answer has the server fetch fresh data in the background, at most once every six hours, and the open view picks it up.
- **Never.** Nothing is fetched; the view says how old its data is.

The choice sits behind a gear in the Earth view's corner (admins change it there; everyone else sees it read-only). It is not in Settings: the Almanac is an Easter egg. `ZIMI_SATELLITE_UPDATES=ask|auto|never` overrides the saved choice, and `ZIMI_OFFLINE=1` forces Never; either way the control says why it will not move.

### Configure

Location is entered in the UI (browser geolocation, or a manual lat/lon prompt when geolocation is unavailable, e.g. the desktop app). It resets each session by design. The one server-side setting is Satellite data from the internet (above; `GET`/`POST /manage/satellites`, or `ZIMI_SATELLITE_UPDATES`).

### Troubleshoot

- **It asks for location every time** — intended. The almanac is session-scoped and doesn't persist location.
- **Geolocation does nothing (desktop app)** — GPS can fail silently in the pywebview shell; enter latitude/longitude manually when prompted.
- **The Earth's satellite data is old and there is no Get fresh data button.** The button is for admins, under Ask first. Check the gear: Never, `ZIMI_SATELLITE_UPDATES` or `ZIMI_OFFLINE` each keep Zimi from fetching, and the panel names which.
- **Clicking an object doesn't open an article** — deep-links resolve against a closed Q-ID set and only land when a ZIM containing that entity is installed. Install the relevant source (e.g. a Wikipedia ZIM) and retry.
- **The scene looks "wrong" for today** — check the time machine; it may be parked on another date. Reset it to now.
