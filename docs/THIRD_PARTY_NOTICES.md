# Third-party software distributed with Zimi desktop builds

## libtorrent-rasterbar

Zimi's BitTorrent transfers run in-process through libtorrent-rasterbar,
imported dynamically when it is present (Docker images install the wheel via
pip; desktop builds bundle the compiled extension module). Zimi works without
it — downloads fall back to plain HTTP.

- Project: https://libtorrent.org/
- License: BSD 3-Clause
- Source code: https://github.com/arvidn/libtorrent

## Noto Sans Math

The Almanac's tables PDF embeds Noto Sans Math so its equations draw on a server with no maths font of its own. Shipped unmodified as `zimi/static/fonts/NotoSansMath-Regular.ttf`, with its licence text (`zimi/static/fonts/NotoSansMath-OFL.txt`).

- Project: https://github.com/notofonts/math
- License: SIL Open Font License 1.1

## Temml

The Almanac's Tables and Calculations draw their Equations from LaTeX to MathML with Temml 0.13.5, shipped unmodified in `zimi/static/temml/` (`temml.min.js`, `Temml-Local.css`, `Temml.woff2`) with its licence text (`zimi/static/temml/LICENSE`), and loaded only when Equations are opened or printed. Every build carries it, not only the desktop ones.

- Project: https://temml.org/
- License: MIT, Copyright (c) 2020 Ron Kok
- Source code: https://github.com/ronkok/Temml

## Voices for the Dictionary (zimi-voice)

The Dictionary's Say runs Piper and Kokoro as a separate program, `zimi-voice` (`zimi/voicehelper.py`), beside Zimi in the desktop builds and under Python in the Docker image. Zimi never imports them. Piper (piper-tts), espeak-ng (inside piper-tts and espeakng-loader) and phonemizer are GPL-3.0; kokoro-onnx, espeakng-loader, onnxruntime, jieba, pypinyin, cn2an and docopt are MIT; num2words is LGPL-2.1; misaki is Apache-2.0; numpy is BSD-3-Clause. Each component's licence text ships in its `.dist-info` beside `zimi-voice`, and `zimi/assets/voices-NOTICE.txt` lists every component with its source link. The voices themselves are downloaded on request, each under the licence shown in Settings.

- Piper: https://github.com/OHF-Voice/piper1-gpl
- espeak-ng: https://github.com/espeak-ng/espeak-ng
- kokoro-onnx: https://github.com/thewh1teagle/kokoro-onnx
- misaki: https://github.com/hexgrad/misaki
- Kokoro-82M (weights, Apache-2.0, downloaded): https://huggingface.co/hexgrad/Kokoro-82M

## browsertrix-behaviors

Capture engines that drive a browser inject Webrecorder's browsertrix-behaviors 0.15.0 into the page being captured, to reveal what it hides (infinite feeds, "show more", per-site expanders). It is shipped unmodified in `zimi/assets/browsertrix-behaviors/` (`dist/behaviors.js`, `package.json`, and the licence text as `LICENSE.md`) in every build, and runs inside the captured page, not inside Zimi's process. It is AGPL-3.0-or-later; Zimi is GPL-3.0-or-later, and section 13 of both licences allows the two to be combined. The file is the unmodified upstream release, so its source is upstream's.

- Project: https://github.com/webrecorder/browsertrix-behaviors (Webrecorder Software)
- License: AGPL-3.0-or-later
- Pinned: npm release 0.15.0, tarball sha512 `Gm9Ni/yq68k3ub7S0JT4muZWGj++fkFVQ95RFczc29hFZYmyX1yMfUs7UrApMZ+1uPW6q6JpBmjRcsC+sHN6lg==`; shipped `dist/behaviors.js` sha256 `82c60aae18588aa6c1a6e54d75887a72c970d840c54cb8b36eb9c9ccf946d7da`
- An operator can replace it with `ZIMI_BEHAVIORS` or a global npm install.

## ZIMs kept on the phone: libzim for the browser, fzstd, and the ZIM reader

"Keep on this phone" stores a ZIM in the browser's private file system and reads it with no server. Three pieces, none of them loaded until a ZIM is kept:

- `zimi/static/libzim/libzim-wasm.js` and `libzim-wasm.wasm`: the release build of javascript-libzim v0.95, unmodified (libzim and Xapian compiled to WebAssembly), for full-text search in a Web Worker. License: GPL-3.0-or-later (javascript-libzim), GPL-2.0-or-later (libzim, Xapian); zstd, xz, ICU and zlib are linked in under their own licences. Its licence text and source pointers are in `zimi/static/libzim/NOTICE.txt`.
  - Project: https://github.com/openzim/javascript-libzim
  - Source code: https://github.com/openzim/javascript-libzim/tree/v0.95
- `zimi/static/fzstd.js`: fzstd 0.1.1, unmodified, decodes zstd-compressed ZIM clusters in the service worker. License: MIT, Copyright (c) 2020 Arjun Barrett.
  - Project: https://github.com/101arrowz/fzstd
- `zimi/static/zimreader.js`: Zimi's own reader for the ZIM file format, written from the openZIM format description (https://wiki.openzim.org/wiki/ZIM_file_format). No Kiwix code is in it.

# Data shipped with Zimi

## Natural Earth first-level regions (`zimi/assets/admin1-snapshot.json.gz`)

The outline of every first-level region of every country (states, provinces, prefectures), simplified to about 3 km, and each region's name and country, so a town on a map is given its region and country offline ("Springfield, Illinois"). Built by `scripts/build_admin1.py` from Natural Earth's 1:10m Admin 1 States, Provinces file; 425 KB.

- Source: Natural Earth, https://www.naturalearthdata.com/
- Terms: public domain. Natural Earth asks for no credit; Zimi gives it anyway.

## NOAA CO-OPS tide stations (`zimi/assets/tides-snapshot.json.gz`)

Harmonic constants, tidal datums and subordinate-station offsets for every NOAA tide prediction station (the United States and its territories), from the CO-OPS metadata API. The Almanac predicts tides from them; it does not reproduce NOAA's published predictions. Built by `scripts/build_tide_snapshot.py`.

- Source: NOAA Center for Operational Oceanographic Products and Services, https://tidesandcurrents.noaa.gov/
- Terms: work of the U.S. Government, public domain in the United States (17 U.S.C. 105). NOAA asks that it be credited as the source and that its data not be presented as an official NOAA product; Zimi's predictions are its own computation and say so.

## TICON-3 tide gauges, in the same file (`zimi/assets/tides-snapshot.json.gz`)

Harmonic constants for tide gauges outside NOAA's coverage (about 1,500 after leaving out lakes, gauges with too small a tide to tell, repeated records and any gauge within 5 km of a NOAA station), with two datums the build works out from them. Built by `scripts/build_tide_world.py`, which adds them beside NOAA's stations.

- Source: Hart-Davis, M. G., Dettmering, D. and Seitz, F. (2022): TICON-3: Tidal Constants based on GESLA-3 sea-level records from globally distributed tide gauges including gauge type information (data). PANGAEA, https://doi.org/10.1594/PANGAEA.951610
- Terms: Creative Commons Attribution 4.0 International (CC BY 4.0), https://creativecommons.org/licenses/by/4.0/ . Zimi keeps 37 of the 40 constituents, rounds amplitudes to the millimetre and phases to the degree, and adds estimated datums; the Almanac credits TICON-3 under each world station's tide and in "About this data".
- Gauge names: GeoNames cities1000, https://www.geonames.org/ , CC BY 4.0. Only the name and country of the town each gauge stands in are used.

## The live sky's Milky Way and constellations (`zimi/static/earth/`)

- Milky Way panorama (`milkyway-v1.webp`): ESO / S. Brunier, "The Milky Way panorama" (eso0932a), CC BY 4.0, https://www.eso.org/public/images/eso0932a/ . Zimi removed the point stars, resized it and recompressed it; the stars drawn over it are the Yale Bright Star Catalogue's (`stars-v1.bin`, public domain).
- Constellation figures (`constellations-v1.json`): d3-celestial, Copyright (c) 2015 Olaf Frohn, BSD 3-Clause License, https://github.com/ofrohn/d3-celestial . Built by `scripts/build_constellations.py`. The lines follow the IAU's constellation pages. Stellarium's GPL data is not used.

## Checked and not shipped

Tides outside the United States, recorded so the next look starts here (2026-10-01):

- TICON-3: shipped since 1.15.3 (above). TICON-4 (https://www.seanoe.org/data/00980/109129/) is the next look.
- Canadian Hydrographic Service: listed under the Open Government Licence - Canada on open.canada.ca, but the tides.gc.ca licence agreement says CHS data "shall not be sold, licensed, leased, assigned or given to a third party". Not clearly redistributable; ask CHS before shipping. https://www.tides.gc.ca/en/licence-agreement
- UK Hydrographic Office (Admiralty) tidal constants: Crown copyright under commercial licence. Not redistributable.
- Australian Bureau of Meteorology tide predictions: published under the Bureau's copyright terms, not an open licence for the constants. Not shipped.
