# Almanac & space

A self-contained astronomical almanac that runs entirely in the browser, computed from formulas — no APIs, no network. It works forever offline.

## How it works

The almanac is a lazy-loaded mini-app (its JS loads only when you open it) reached from the Home view. Everything it shows is derived from math at render time — moon phase, sun and daylight, an animated simulated sky, an interactive star chart with a bright-star catalogue, a Keplerian solar-system orrery with a time machine, a real-timezone sun/world map, meteor showers, and deep-time views. Because it's all computed, it needs no internet and produces the same result on any machine for a given date and location.

Location is asked for once and kept **session-scoped** on purpose — the almanac is deliberately ephemeral (`zimi_almanac_location`). A "time machine" lets you drive the whole scene (orrery, sky, calendars) to any date; the sky, orrery, and map all obey it.

**Deep-links.** Almanac objects (planets, stars, and other entities) can deep-link into the installed library via a closed set of Q-IDs resolved against your ZIMs, so clicking an object opens its article when a matching source is installed.

## Configure

There's nothing to configure server-side — the almanac is a client feature. Location is entered in the UI (browser geolocation, or a manual lat/lon prompt when geolocation is unavailable, e.g. the desktop app). It resets each session by design.

## Troubleshoot

- **It asks for location every time** — intended. The almanac is session-scoped and doesn't persist location.
- **Geolocation does nothing (desktop app)** — GPS can fail silently in the pywebview shell; enter latitude/longitude manually when prompted.
- **Clicking an object doesn't open an article** — deep-links resolve against a closed Q-ID set and only land when a ZIM containing that entity is installed. Install the relevant source (e.g. a Wikipedia ZIM) and retry.
- **The scene looks "wrong" for today** — check the time machine; it may be parked on another date. Reset it to now.
