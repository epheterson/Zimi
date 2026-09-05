# ZIM creation and editing — scope proposal

Eric, 2026-08-09: "maybe we should add a slew of zim creation and editing features."

This doc cuts the slew into what ships in 1.9, what waits for 2.0, and what we should never build. The principle: 1.9 is the industry release — one sharp creation feature that completes the bunker story beats five half-done editors bolted onto an ops release.

## What already exists

`zimi/zimwriter.py` (~695 lines) builds real ZIMs today: bookmark export walks articles out of installed ZIMs, rewrites their links, and feeds them through libzim's `Creator`. The hard integration work — Creator lifecycle, metadata, main page, FRONT_ARTICLE hints, atomic tmp-then-replace output, incremental registration of the finished file — is done and tested. Creation from user content is a new front door on an existing house.

## 1.9: `zimi create` (proposed, needs Eric's go)

Point it at a folder, get a ZIM.

```
zimi create ./my-docs --title "Field Manual" --out fieldmanual.zim
```

- **Input**: a folder of HTML, Markdown, and PDFs. Markdown renders through a minimal stdlib-friendly converter (no new hard dependency; if we can't render it well with what we ship, we render it as preformatted text and say so). HTML passes through with asset paths rewritten. PDFs embed as-is — the reader already serves them inline.
- **Structure**: folder hierarchy becomes ZIM paths; an index page is generated when the folder has no obvious entry point (index.html, README.md).
- **Metadata**: title, description, language, creator flags; sensible defaults from the folder name.
- **Output**: lands in the ZIM dir and registers incrementally (the just-fixed no-rescan path), so it appears in the library immediately. Or `--out` anywhere for sneakernet.
- **UI hook**: one card in Manage — pick a server-side folder, fill in title, go. No upload pipeline in 1.9; uploads mean multipart handling, quotas, and temp-space management, which is 2.0 surface.

Why this completes 1.9: the bunker story currently ends at "read what you brought." With `zimi create`, the USB stick in the bunker also captures what the bunker produces — procedures, logs, local documentation — in the same format everything else already speaks.

Estimate: roughly two focused days including tests and the field-guide entry. Risk is low because the Creator plumbing is proven.

## 2.0: the actual slew

- **Editing**: the ZIM format is write-once by design — "editing" is always rebuild-with-changes. A real editor means unpack → modify → rebuild, with the UI hiding that. Deserves its own release.
- **Merge/split**: combine ZIMs, or carve a subset (one wiki category, one date range) into a smaller ZIM. Pairs naturally with the chatbot ("make me a medical pack from these five sources").
- **Annotations layered over read-only ZIMs**: user notes stored Zimi-side, exportable as a companion ZIM. This might be the best "editing" of all, because it never fights the format.
- **Browser upload → ZIM**: drag a folder into the web UI. Needs the upload pipeline.
- **Scheduled captures**: re-run a creation recipe on a folder that changes (nightly ops-log ZIM).

## Never (unless something changes)

- **WYSIWYG article editing inside existing ZIMs** — fights the format, fights the checksums, breaks the mirror/torrent story where a ZIM's identity is its hash.
- **A web scraper** — that's zimit/warc2zim's whole project; we'd ship a worse one. Point people at zimit and import its output instead.

## Open questions for Eric

1. Go / no-go on `zimi create` for 1.9?
2. Markdown support in v1, or HTML+PDF only and Markdown in 1.9.x? (Markdown is the most likely bunker format, but it's also the only piece that tempts a new dependency.)
3. Does the Manage UI card make 1.9, or does v1 ship CLI-only?
