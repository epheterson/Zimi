# Third-party software distributed with Zimi desktop builds

## libtorrent-rasterbar

Zimi's BitTorrent transfers run in-process through libtorrent-rasterbar,
imported dynamically when it is present (Docker images install the wheel via
pip; desktop builds bundle the compiled extension module). Zimi works without
it — downloads fall back to plain HTTP.

- Project: https://libtorrent.org/
- License: BSD 3-Clause
- Source code: https://github.com/arvidn/libtorrent

## Voices for the Dictionary (zimi-voice)

The Dictionary's Say runs Piper and Kokoro as a separate program, `zimi-voice` (`zimi/voicehelper.py`), beside Zimi in the desktop builds and under Python in the Docker image. Zimi never imports them. Piper (piper-tts), espeak-ng (inside piper-tts and espeakng-loader) and phonemizer are GPL-3.0; kokoro-onnx, espeakng-loader, onnxruntime, jieba, pypinyin, cn2an and docopt are MIT; num2words is LGPL-2.1; misaki is Apache-2.0; numpy is BSD-3-Clause. Each component's licence text ships in its `.dist-info` beside `zimi-voice`, and `zimi/assets/voices-NOTICE.txt` lists every component with its source link. The voices themselves are downloaded on request, each under the licence shown in Settings.

- Piper: https://github.com/OHF-Voice/piper1-gpl
- espeak-ng: https://github.com/espeak-ng/espeak-ng
- kokoro-onnx: https://github.com/thewh1teagle/kokoro-onnx
- misaki: https://github.com/hexgrad/misaki
- Kokoro-82M (weights, Apache-2.0, downloaded): https://huggingface.co/hexgrad/Kokoro-82M

# Data shipped with Zimi

## NOAA CO-OPS tide stations (`zimi/assets/tides-snapshot.json.gz`)

Harmonic constants, tidal datums and subordinate-station offsets for every NOAA tide prediction station (the United States and its territories), from the CO-OPS metadata API. The Almanac predicts tides from them; it does not reproduce NOAA's published predictions. Built by `scripts/build_tide_snapshot.py`.

- Source: NOAA Center for Operational Oceanographic Products and Services, https://tidesandcurrents.noaa.gov/
- Terms: work of the U.S. Government, public domain in the United States (17 U.S.C. 105). NOAA asks that it be credited as the source and that its data not be presented as an official NOAA product; Zimi's predictions are its own computation and say so.

## Checked and not shipped

Tides outside the United States, recorded so the next look starts here (2026-10-01):

- TICON-3 / TICON-4 (Hart-Davis et al., tidal constants from GESLA tide-gauge records, about 1,100+ gauges worldwide): CC BY 4.0, so redistributable with attribution. The best candidate for world coverage. https://doi.pangaea.de/10.1594/PANGAEA.951610, https://www.seanoe.org/data/00980/109129/
- Canadian Hydrographic Service: listed under the Open Government Licence - Canada on open.canada.ca, but the tides.gc.ca licence agreement says CHS data "shall not be sold, licensed, leased, assigned or given to a third party". Not clearly redistributable; ask CHS before shipping. https://www.tides.gc.ca/en/licence-agreement
- UK Hydrographic Office (Admiralty) tidal constants: Crown copyright under commercial licence. Not redistributable.
- Australian Bureau of Meteorology tide predictions: published under the Bureau's copyright terms, not an open licence for the constants. Not shipped.
