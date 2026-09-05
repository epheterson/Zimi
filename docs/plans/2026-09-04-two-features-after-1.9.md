# Two features for after 1.9 ships

Eric, 2026-09-04, 15:15: *"Track two features screenshot of original and final zim saved into zim and shown in create and about views. Second keep zims organized by folder option that literally moves them when you move in the app and keeps all sorted into category subdirectories. After we ship."*

Both are post-1.9.0. Neither goes on the branch before the tag. Written at the level a builder can start from, against the code as it stands at `656d350`.

---

## Feature A: the capture shows its work

**One sentence.** A capture stores a picture of the live page and a picture of the finished ZIM, and shows them side by side on the done card and in About, so a person can see for themselves whether the capture is faithful.

**Why it is worth building.** The whole 09-03 survey was one person opening captures and comparing them to the original by eye. That labour is exactly what the product should do for its user, once, at capture time, and keep. It also turns "creation is a beta, tell us about sites that fail" from a request into a glance: the pair is the report.

### What gets stored

Two images, written as ordinary ZIM entries at capture time:

| entry | what it is |
|---|---|
| `_zimi/shot-live.jpg` | the page as the live web served it, full height, at a fixed width |
| `_zimi/shot-zim.jpg` | the packaged ZIM's main page, opened from the finished file, same width and settling rules |

Plus one metadata key so a reader finds them without scanning: `X-Zimi-Screenshots` carrying the two paths, their pixel sizes, the capture width, and the engine. `add_standard_metadata` in `zimwriter.py` is where it joins the existing `X-Zimi-Source` and `X-Zimi-History` record.

Fixed capture width 1280, JPEG quality 70, long edge capped so a 45,000 px page (cnn.com) does not put 4 MB of picture into a 30 MB ZIM. Measure the real cost before choosing the cap; the survey's own strips are the sample.

### Where the pictures come from

- **Rendered and Alive engines** already drive Playwright Chromium (`renderer.py`), so the live shot is one call on the page they already have open, after the same settle-and-scroll the capture uses.
- **Fast engine** has no browser by design. When a browser is installed it gets the same treatment as a second, cheap visit; when it is not, the ZIM simply has no `shot-live` and the UI says the picture is not available rather than showing an empty frame.
- **The final shot is always possible**, browser or not: open the finished ZIM through the local server in the headless browser and shoot the main page. If there is no browser at all, neither picture exists and nothing in the UI pretends otherwise.

### Where they show

- **Create, done card** (`_createMountDone` in `create.js`): a two-up strip under WHAT'S INSIDE, live on the left, ZIM on the right, tap to open full size. This is the moment the person is looking at the result.
- **About panel** (`_openZimAbout` / `/zim-info` in `app.js` and `server.py`): the same pair, for any ZIM that carries them, so it survives past the session that made it.
- Both surfaces already exist and already read one JSON payload; the pictures ride in that payload as entry paths, not as base64.

### Open questions to settle before building

- Cost: how much do two pictures add to a small ZIM, in percent? A 65 KB gobyexample capture must not become 400 KB of screenshots.
- Whether the pair belongs in an export ZIM (bookmarks) at all, or only in a capture.
- Whether a site with a consent wall should shoot before or after the wall is swept, since the two pictures would otherwise disagree for an honest reason.
- Privacy: a capture of a logged-in page would store a picture of that page. Same exposure as the capture itself, but a picture is more legible than markup; it deserves a line in the docs.

---

## Feature B: folders that actually move

**One sentence.** An option that makes the app's category the file's real location: change a ZIM's category and the file moves into that folder on disk, and a single action files every ZIM in the library into its category's subdirectory.

**What exists today.** Folders are already categories, read-only: `_effective_category(name, path)` in `server.py` returns `_folder_category(_zim_folder(path))` when a ZIM lives in a subfolder, else the filename heuristic, and a hand-set per-ZIM override in `library_layout.json` beats both at the `/list` boundary. So the app can already *say* a ZIM is Medical while the file sits in the library root. This feature closes that gap in the direction Eric wants: the app's word becomes the truth on disk.

### Behaviour

- A setting, off by default: **Keep ZIMs organized by folder.**
- With it on, setting a ZIM's category moves `<ZIM_DIR>/<file>.zim` to `<ZIM_DIR>/<Category>/<file>.zim`, creating the folder if needed, and clears the per-ZIM override, because the folder now carries the fact.
- A **File everything** action: move every ZIM whose effective category differs from its folder, reporting what it will do before it does it, and what it did after.
- Turning the setting off changes nothing on disk. Files stay where they are.

### What makes this harder than it looks

Each of these is a real hazard in this codebase, and each has a known landing place:

1. **The archive is open.** libzim holds the file. A move under a running server has to take `_zim_lock`, close the pooled archive for that name, rename, then reopen. The pool and lock plumbing is in `server.py`; the deletion path already does the close-and-splice dance and is the model to copy.
2. **Rename is not always cheap.** Same filesystem is `os.replace`. Across devices (a NAS mount, a USB stick) it is a copy, an fsync and a replace, and a 90 GB Wikipedia must not be copied silently: refuse a cross-device move by default and say why.
3. **The library must splice, not rescan.** Deleting already splices (1.9.0, from the #51 class of bug). A move is a delete and an add of the same content; it must reuse that path, never `_scan_zim_directory`.
4. **Something may be seeding it.** BitTorrent seeds by path, and the peer `/dl/` endpoint serves by path. A move while a seed is live has to pause and re-point, or refuse.
5. **Caches are keyed on paths.** The shape cache is keyed on the file (there is a test that pins this), and the title and Q-ID indexes live beside the data dir. Confirm every one of them survives a move, with a test per cache.
6. **The deny list and `.nozim`.** A category named like a quarantine folder must not send a ZIM somewhere the scanner ignores. Validate the category as a folder name and refuse the reserved ones.
7. **Auto-update writes by path.** The updater replaces files in place; a moved ZIM must still be found by name, not by remembered path.

### Shape of the work

- `server.py`: a `move_zim(name, category)` that takes the lock, closes, moves, reopens and splices, with a cross-device guard and a dry-run mode.
- `manage.py`: `/manage/organize` for one ZIM and for the whole library, reporting a plan and then a result, one job at a time like creation.
- `app.js`: the setting in Manage, the category control writing through it, and a confirmation for the whole-library action that names how many files move and how many bytes cross a device boundary.
- Tests: a move under an open archive, a cross-device refusal, a seeding refusal, cache survival per cache, deny-list validation, and a whole-library plan that is idempotent when run twice.

---

## Tracking

Both are 1.9.1 candidates and both are listed in `docs/plans/2026-08-31-v190-test-plan.md` under the 1.9.1 decisions, so they sit beside the other deferred items rather than only in a chat log. Neither is started. Neither blocks the 1.9.0 tag.
