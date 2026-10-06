# Dictionary voices: Say as real audio from the server

Eric, 2026-10-03: "It's worth getting dictionary right if it's the new app." And: "If it sounds clearer and is more accurate that might be better than letting the system do whatever."

## Why

The browser's `speechSynthesis` is not media on an iPhone, so the ring switch mutes it. Each device also has its own voices, or none. Workarounds that play a silent clip under the voice were slow and unreliable on Eric's phone. Real audio played by an `<audio>` element counts as media: it plays on silent and sounds the same everywhere.

## Shape

- `GET /dictionary/speak?text=<word>&lang=<code>[&accent=<region>]` returns `audio/wav` (cached), or 404 when no engine can say that language.
- Engines run as subprocesses, never imported, so GPL code stays a separate program beside MIT Zimi, as ffmpeg is. Order of preference:
  1. **Piper** (`python -m piper`, piper-tts, GPL-3), when a voice for the language (and accent, where Piper has one) is installed. Natural speech, the first choice everywhere including the Mac.
  2. **macOS `say`** (`say -v <voice> -o x.aiff`, converted to WAV with `afconvert`), only on macOS hosts, only when Piper has no voice.
  3. **espeak-ng**, when installed. Robotic; the last server engine.
  4. None: 404, and the page falls back to `speechSynthesis` as today.
- A cache under the data dir: `voices/cache/<engine>-<voice>/<sha1(text)>.wav`, size-capped with oldest-first eviction. One synthesis at a time, with a timeout. Text is limited to a word or short phrase (a length cap); it never reaches a shell.
- The word's JSON (or a small `/dictionary/voices` the page fetches once) says which languages and accents the server can speak. The speaker button then decides in the tap without a round trip: server audio when available (an `<audio>` element whose `src` is set and played inside the tap, as iOS requires), otherwise `speechSynthesis`. The silent-clip workaround is deleted.
- Buttons appear when either the server or the device can say the language. Today they appear only when the device can.

## Voices

- One curated Piper voice per language, plus accents where Piper has them (en_US and en_GB, pt_BR and pt_PT, es_ES and es_MX). Use medium quality (about 60 MB) from `rhasspy/piper-voices`, pinned to a version. Record each voice's license from its model card; only voices whose license allows redistribution are listed.
- Stored under `<data dir>/voices/piper/`.
- Downloading is an outbound fetch, so it follows the existing pattern in `zimi/outbound.py`:
  - a "Voices for Dictionary" control with Ask first (default), Automatically and Never;
  - an env var that wins;
  - `ZIMI_OFFLINE` blocks it;
  - it is listed in what Zimi fetches.
- Ask first means nothing downloads until someone asks. The Dictionary offers it: on a word in a language with no server voice, "Download a voice for French (61 MB)". Manage lists the voices (installed, size, remove) under the same control.
- The languages offered are those of the installed Wiktionaries' entries that Piper has a voice for.

## Packaging

- Docker: `pip install piper-tts` (it brings onnxruntime) and `apt-get install espeak-ng`, in the image layer before `COPY zimi/`, so code deploys stay fast. Measure the image growth.
- pip users: piper-tts is not a dependency. The docs say how to add it.
- Desktop DMG and AppImage: bundle piper-tts if it fits the existing build cleanly. Otherwise the Mac app uses `say` and the AppImage uses espeak-ng if present, and the gap is noted for the next release.
- `zimi-mcp`: untouched (`server.bundled()` guards).

## Tests

- Unit:
  - engine choice and order;
  - the cache, including its size cap;
  - text limits, and that the text never reaches a shell;
  - a 404 when there is no engine;
  - the outbound control's states, with `ZIMI_OFFLINE` blocking downloads.
- Live, with a fake Piper binary on PATH that writes a known WAV: Say plays `/dictionary/speak` audio through `<audio>`, and does not call `speechSynthesis`, when the server has the language. It falls back when the server doesn't.
- Real Piper on the NAS: deploy, download an English voice, and Say "water". Then Eric checks it on his phone with the ring switch on silent. That check is the release gate for this feature.
