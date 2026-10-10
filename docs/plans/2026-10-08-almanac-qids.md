# Almanac: every named thing, mapped to a Wikipedia article

Eric, 2026-10-08: "The tables and stuff I want all the strings mapped to wiki q-id we need another full almanac check for that."

The mechanism is the closed set in `zimi/static/almanac-links.js`: a curated map from an entity key to a Wikidata Q-ID and the English article title that Q-ID stands for, resolved once on open against the installed library (`POST /almanac-links`). A Q-ID that resolves is a link; one that does not is plain text. The Q-IDs are baked in, so runtime stays fully offline; the network is used only to earn them (`scripts/verify_almanac_qids.py`).

## What the audit found first

`scripts/verify_almanac_qids.py` asks English Wikipedia for each entry's `wikibase_item`. Of the 490 entries already in the map, ten were wrong:

| Entry | Was | Now |
|---|---|---|
| Merak | the disambiguation page "Merak" | Merak (star), Q13096 |
| Pollux | the disambiguation page "Pollux" | Pollux (star), Q13028 |
| Epiphany | a disambiguation page | Epiphany (holiday), Q132001 |
| Heritage Day (South Africa) | a disambiguation page | Heritage Day (South Africa), Q1945098 |
| Indigenous Peoples' Day | a disambiguation page | Indigenous Peoples' Day (United States), Q6024620 |
| National Foundation Day (Japan) | a disambiguation page | National Foundation Day (Japan), Q1059995 |
| Heliopause | a title that now redirects to the Heliosphere | Heliosphere, Q131687 |
| May Day, Workers' Day, Labour Day | two Q-IDs for one article, one with no English article | Labour Day, Q47499 |

A second defect: a regional holiday lost its country on the way into the calendar grid (the base-event projection dropped the `region`), so a shared label (India's and Brazil's Independence Day, for one) linked the first country's article. The region now travels.

## Inventory by surface

"Strings" is how many distinct named things the surface can show. "Before" is how many linked at the start of this work (a link that went to the wrong article counts as not linked). Counts come from running the shipped code: `tests/test_almanac_qids.cjs` for the data lists, `tests/test_almanac_qids_browser.py` for the calendar and the tables.

| Surface | Strings | Before | Now | Not linkable, and why |
|---|---:|---:|---:|---|
| **Calendar: holidays** (every label, every system, every country pack) | 294 | 181, of which 4 pointed at another country's article | 280 | 14: no English article of its own, or the title redirects to a different thing (1st White Night, Aban and Azar festivals, Constitution Day of Spain and Mexico, International Mountain Day, Mahayana New Year, Meatfare Sunday, the Buddhist "New Year's", Paramony, Po Wu, World Photography Day, World Science Day, Xiayuan). Each is listed with its reason in the test |
| Calendar: equinoxes and solstices | 4 | 0 | 4 | |
| Calendar: meteor shower peaks | 12 | 0 | 12 | |
| Calendar: clock changes (Spring Forward, Fall Back, Clocks Forward, Clocks Back) | 4 | 0 | 4 | |
| **On this day** | 98 events | 94 | 98 | Each event links one subject; the other names in its sentence (a second person, a place) stay text |
| **Meteor showers**: name | 12 | 12 | 12 | |
| Meteor showers: parent body (shown now) | 12 (11 bodies) | 0 (not shown) | 12 | |
| Meteor showers: radiant constellation | 11 | 11 | 11 | |
| **Stars**: the Nautical Almanac's 57 + Polaris, and the Pleiades | 59 | 31 | 59 | |
| Stars: the sky's named stars | 21 | 21 | 21 | |
| **Planets, Sun, Moon** (orrery, sky, hero, tables) | 10 | 10 on the page, 0 in tables | 10 | |
| Probes (Voyager 1 and 2, Pioneer 10 and 11, New Horizons) | 5 | 5 | 5 | |
| Belts and the heliopause | 3 | 3 (one wrong) | 3 | |
| Constellations the Sun passes | 18 (+5 drawn) | 18 | 18 | The 5 drawn-only are canvas pixels with no tap target |
| Zodiac animals | 12 | 12 | 12 | The Chinese element before the animal ("Wood") is part of one label |
| Calendar systems (the cross-reference, the tables' columns) | 7 | 7 on the page, 0 in tables | 7 | |
| Seasons, eclipse types | 4 + 7 | 11 | 11 | The seven eclipse types are two articles (solar, lunar) |
| Messages across time | 10 | 10 | 10 | |
| **World clocks**: the big clock's city | 28 | 0 | 28 | The 28 cards' city names are buttons that choose the clock; a link there would take the tap |
| **Tables** (the ten): headings, cells | 10 pages | 0 | 10 pages, 182 links on 111 distinct entities | A table's dates, times, places and numbers are not named things |
| &nbsp;&nbsp;Sun and Moon, Twilight, Phases, Seasons, Calendars, Navigation, Star calendar, Eclipses, Sun time, Tides | | 0 each | 6, 4, 3, 2, 5, 70, 15, 2, 3, 1 distinct entities | |
| **Calculations** (the eight) | 8 pages | 0 | 4 pages with links: Calendar converter (6), Sight reduction, Great-circle distance, Sundial and Days (terms in their working) | Units (a list of unit names inside a menu), Zones, Sun and Moon day: nothing named on the page |
| **Constants** rows (five pages) | 52 | 0 | 47 | 5: "Day", Julian century, the Moon's size in Earth radii, light time for 1 AU, 0 °C (a plain unit, a ratio, or a compound of two things) |
| Constants: the Source column | 14 bodies (WGS84, IUGG, CGPM, IAU, CODATA, ICAO, NOAA, USNO, IERS, Bowditch, Meeus, Espenak, SI, UTC) | 0 | 14 | |
| **Sky taps**: sea, boat, whale, airliner, birds, meteor, aurora | 7 | 1 | 7 | |
| Sky taps: the Sun, Moon, planets, stars, ISS | 5 kinds | 5 | 5 | |
| **Tides**: the section title, spring and neap | 3 | 0 | 3 | |
| Tides: the 3,493 stations | 3,493 | 0 | 0 | A gauge's place name is not an encyclopedia entity |
| **3D view**: the Sun, Moon, Earth, ISS, GPS cards | 5 | 5 | 5 | |
| **Places**: the 173 plotted and 373 search-only cities | 494 distinct | 0 (the 28 clock cities aside) | 0 | Linkable, deliberately not wired: the map's place line is the search control, and 494 more Q-IDs would add about 30 KB and two more batch requests to every open for a name that is mostly a button. A follow-up could resolve only the chosen place, lazily |
| Units menus (42 unit names) | 42 | 0 | 0 | Options in a menu cannot hold a link |
| Calendar month and weekday names | 12 + 13 + 12 + 12 + 7 | 0 | 0 | The month title is the month picker's button |

The closed set grew from 687 entries (465 distinct Q-IDs) to 980 entries (632 distinct Q-IDs), still four batch requests of at most 200.

## Rules the tests hold

- `tests/test_almanac_qids.cjs`: every Q-ID well formed, one article per Q-ID and one Q-ID per article; every row of each list above (stars, clock cities, events and their subject phrase, showers, parents, radiants, calendars, planets, zodiac, feasts, phases, constants rows and sources) has a key, or is in a plain list with its reason; unresolved means plain text. A new row without a Q-ID fails.
- `tests/test_almanac_qids_browser.py`: every holiday the calendar can print links or is listed with its reason; a regional holiday keeps its country; each table and constants page shows links; with nothing resolved no table shows a link.
- `scripts/verify_almanac_qids.py` (network): every entry's Q-ID is the article it names. Run it when an entry is added.
