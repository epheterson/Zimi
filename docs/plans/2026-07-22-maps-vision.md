# Maps done right (v1.9 vision)

## What map ZIMs actually are (2026 field findings)

Kiwix ships `maps_en_*` ZIMs (per-country, plus a 72 GB `maps_en_all` world).
They are **Maps2ZIM** output: a Vite-bundled single-page app that boots
**MapLibre GL JS** (WebGL) against **vector tiles** stored in the ZIM.

Verified structure of `maps_en_bhutan` on library.kiwix.org:

- Main entry: `index.html` → `<script type="module" crossorigin src="./assets/index-*.js">`
  + hashed CSS. A `#map` div, a `#loading` spinner, a `#error` fallback that
  reads "requires <WebGL> and <WebAssembly>".
- `content/config.json` → style/source config.
- Vector tiles at `tiles/{z}/{x}/{y}.pbf`, served `application/x-protobuf`,
  **raw uncompressed MVT** (first bytes `1a fd 24 0a …`, not gzip `1f 8b`).
- Glyphs/sprite as `.pbf` / `.png` / `.json`.

So a map ZIM is a WebGL app, not an article. It opens in Zimi's reader iframe
as a "regular" ZIM (it has a main path), and the iframe already grants
`allow-scripts allow-same-origin` → MapLibre's WebGL + workers run.

## Render-quality pass — what shipped now

- **`.pbf`/`.mvt` → `application/x-protobuf`, `.geojson`/`.topojson` → geo/JSON**
  in `MIME_FALLBACK`. Before, a tile/glyph with no ZIM-declared mimetype fell
  to `application/octet-stream`. MapLibre's own tile loader reads arrayBuffers
  and tolerates that, but any content-type-checking loader (and correctness)
  wanted protobuf. Cheap, safe, standards-correct.

## What is NOT broken (checked, don't "fix")

- **Tiles are not gzipped** in these ZIMs, so no `Content-Encoding` handling is
  needed. Do not blindly sniff-and-set gzip — it would corrupt these.
- **Scripts run**: iframe sandbox has `allow-scripts`; CSP is
  `default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:`, so same-origin
  module JS, blob: workers, and WebGL all pass.
- **`.js` MIME is correct**, so even if Zimi later adds `nosniff` to ZIM content,
  ES modules won't be refused.

## Honest gaps (candidate 1.9 work, in priority order)

1. **Reader View must refuse maps.** The readability toggle tries to extract
   article prose; on a MapLibre app it yields a blank pane. Detect app-shell
   ZIMs (no extractable body / known map signature) and hide/disable Reader
   View + read-aloud for them. Small, high-value.
2. **Service-worker tile cache is unbounded.** `cacheFirst` on `/w/` sub-resources
   caches every panned tile forever within a cache version. Heavy map use can
   bloat Cache Storage silently. Add an LRU-capped tile cache bucket (by
   `.pbf`/tiles path) or skip-cache for tile-shaped URLs.
3. **`maps_en_all` is 72 GB.** Per-country ZIMs (125–800 MB) are the realistic
   unit. Surface map ZIMs as a first-class **"Maps" catalog category** with the
   per-country list, so users pull Bhutan not the planet.

## The 1.9 hero: maps as a Zimi surface, not just an embedded app

- **Integrated map view.** A top-level "Map" mode that loads the installed map
  ZIM(s) directly in Zimi chrome (not the reader iframe), sharing the theme and
  the search bar. Search a place → fly-to.
- **Article ↔ location.** Wikipedia article HTML carries coordinates in geo
  microformats (`<span class="geo">lat; lon</span>`, `Kartographer`
  `data-lat`/`data-lon`). Extract them at read time (cheap regex, already have
  the HTML in `http.py`) and expose `lat`/`lon` additively on `/read`. Then:
  - **Pins**: drop the current article on the map; "what's near here" lists
    other installed-ZIM articles within a radius (needs a coord index — a real
    but bounded build, like the Q-ID index).
  - **Discover integration**: a "Nearby" card, and map thumbnails on geolocated
    articles.
- **Offline routing — reality check: no.** Turn-by-turn needs a routing graph
  (OSRM/Valhalla data + engine), not vector tiles. Out of scope for a ZIM
  reader; Zimi shows *where*, not *how to drive there*. Say so plainly rather
  than half-building it.

## Non-goals

- Editing/authoring maps. Live tile fetching (defeats offline). Bundling a
  routing engine. Re-scraping OSM — we consume Kiwix's ZIMs, we don't make them.
