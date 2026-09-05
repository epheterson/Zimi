# Create UX round 2 — guided and previewable

Eric, on the round-1 Create page: **"feels like a shot in the dark."**

He is right, and the diagnosis is specific. Round 1 asks you to type a server path you cannot see, an ISO 639-3 language code you have to know, and a byte budget with no sense of scale, then press a button and hope. Every one of those is the user supplying information the server already has or could cheaply find out.

The cure is not more controls. It is **the server telling you what it found before you commit**.

## What is already done (do not rebuild)

Commit `ed9dc9a` ("Advanced lives in the UI now") already moved every engine option into a per-mode Advanced disclosure: depth, size budgets, crawl delay, language, robots override, import name, video quality presets. Directives 1 and 2 are therefore **half done** — the fields exist and are validated server-side. What is missing from each is the part that removes the guesswork:

- language exists as a free-text field with placeholder `eng`. Typing an ISO 639-3 code from memory is the shot in the dark.
- max_bytes exists as free text with placeholder `500M`. No sense of scale.

## The six directives, in the order they attack the complaint

**D4 — pre-flight probe + inline preview.** The centrepiece. `POST /manage/create/probe` runs the cheap half of each mode and returns what the job would produce, without writing anything: folder → file count, total size, main-page candidate; page/site → final URL, title, SPA verdict, robots allowance; video → playlist length and first titles; import → size and sidecar readiness. Rendered as a preview line under the form. This is what turns "hope" into "see".

**D1 — language becomes a select, with server-side auto-detect.** The select's first option is Auto, and the probe reports what it detected (`<html lang>` for folder/page/site, yt-dlp metadata for video) so the preview line reads "Language: French (detected)". Detection belongs in the probe, not buried in Advanced — a value nobody sees is a value nobody trusts.

**D2 — size budget becomes a select.** Presets (100M / 500M / 1G / 4G / 16G / no limit) mapped to the strings `parse_size` already accepts. Per-mode default from the existing `hints`.

**D6 — admin folder browse picker.** `GET /manage/create/browse`. See the security note below; this one reverses an explicit rule from round 1 and needs Eric's eyes.

**D3 — tile reorder + bookmarks tile.** Reorder so the two that always work (local, offline, zero config) come first. Bookmarks is a shortcut to the existing `/manage/export-bookmarks`; the bookmark data lives in the client's localStorage, so this tile posts what the browser holds rather than naming a server source. Note: the export engine itself is being fixed under task #15 — this lane calls it, and does not touch it.

**D5 — multi-URL page mode (`create_pages_zim`).** A new engine function in `creator.py`: N URLs, one ZIM, cross-linked where the set captured the target, reusing the crawler's own `_assign_article_paths` / `_link_resolver`. Sequenced last on purpose: it is the only directive that adds a capability rather than removing guesswork, so it is the one to cut if the lane runs long.

## Security note — D6 reverses a round-1 hard rule

Round 1's brief said, verbatim: **"NEVER add a directory-browsing/listing endpoint."** I built to that, and the comment enforcing it is still in `_create_validate`. This directive asks for the opposite, and Eric's complaint is the reason: typing an invisible server path IS the shot in the dark.

The reversal is defensible on capability grounds. Folder mode already lets an admin package **any** readable directory into a ZIM and then read it, so a lister grants an admin no new power; it makes an existing power discoverable. The risk delta is not zero though: it is a new information-disclosure surface that pays out to anyone who reaches the admin gate, including a secondary admin, and it converts "you must already know the path" into "you can go looking".

Built with these constraints:

- **Directories only.** Never file names. File *counts* and total size come from the probe, which is what the preview actually needs; a list of filenames is disclosure with no UI purpose.
- **Primary-admin-gated**, not merely admin-gated. Between round 1 and now, folder and import modes were restricted to the primary admin (`_primary_admin_authorized`) because they read arbitrary server paths. The picker exists to feed folder mode, so it inherits that exact gate: a discovery surface that outranks the thing it discovers for is a hole. The probe inherits it too, for the same reason — it reads the same filesystem more cheaply.
- **Bounded** entry count per response, and no recursion.
- **No symlink escape**: entries are resolved and dropped if they leave the parent.
- The typed field stays as the escape hatch, so the picker never has to be exhaustive.

**Open for Eric:** whether the picker should be confined to a root set (home, the ZIM directory, configured extras) rather than reachable from `/`. Confinement is one constant; I have left it unconfined to match what folder mode already accepts, and flagged it rather than deciding it.

## What actually happened (2026-08-11, lane complete)

Two discoveries changed the plan mid-flight, both for the better:

**D1 and D2 were half-built already** (`ed9dc9a`), as expected. The missing halves — a language *select* with server-side detection, and a size *select* instead of free text — are what this lane added.

**D5 was being built by another lane while I planned it.** `creator.create_pages_zim` already existed by the time I reached it, along with `LANGUAGE_AUTO` and a `resolve_language` that detects at capture time. So D5 stopped being engine work and became wiring: the route, the validator, and a textarea. I touched no engine file.

That second discovery also improved D1. There are now two detections and they do different jobs: the engine's runs at capture time and decides what the ZIM is stamped with; the probe's runs at preview time and is what the admin *sees* before committing. The client sends nothing when the select says Auto, which is exactly what makes the engine use its own detection. Complementary, not duplicated.

Two things landed that were not asked for, because the work surfaced them:

- **Page mode is cancellable now.** It moved onto `create_pages_zim`, which takes a progress callback, so it gained a live log and an interrupt. `CREATE_CANCELLABLE_MODES` replaces the hardcoded tuple that said otherwise in two places.
- **A per-address length bound.** Raising the page-mode field ceiling to twenty URLs meant the whole-field check could no longer catch one absurd line. Each address now carries the single-source bound.

## Execution order

A. D4 probe endpoint + preview rendering (+ D1 server-side detection)
B. D1/D2 selects (table edits in `CREATE_FIELDS`)
C. D6 browse endpoint + picker
D. D3 tile reorder + bookmarks tile
E. D5 `create_pages_zim` + multi-URL page mode

## Done means

Per wave: pyright clean on touched Python, `node --check` on touched JS, new tests passing, i18n parity green across all 10 locales with real translations, and the full pytest suite. The lane is verified in a real browser, not route-level only — round 1's browser pass caught two bugs that route tests could not reach, and the same standard applies here.
