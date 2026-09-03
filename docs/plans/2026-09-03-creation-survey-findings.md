# Creation survey — findings (hand-written; the table is in 2026-09-03-creation-survey.md)

Each item names what a person sees, where it comes from, and what to do. Ordered by how early a person meets it. Status moves from `open` to a commit hash.

## Flow (the create page, driven in a browser on a scratch server)

| # | what a person sees | where it comes from | do | status |
|---|---|---|---|---|
| F1 | The finished card's size rolls up from 0 B over two seconds while WHAT'S INSIDE beneath it already shows the final total; for that window the two numbers disagree on one screen (0 B, 209 KB, 444 KB, 465 KB seen against 498.2 KB). | `create.js:55` roll-up by design, card starts at `_fmtBytes(0)` (`create.js:2907`); the inside bar renders the final `shape.file_bytes` at once. | Design pass: one number, one moment. Either the bar waits for the roll, or nothing rolls. | open |
| F2 | The `769 B size` chip from the run stays on screen after Ready, next to a 498.2 KB result. | The chip is bytes-streamed-so-far (`create.js:2534`), never reconciled to the written file. | Reconcile the chip to the file's bytes at Ready, or drop it once the card is up. | open |
| F3 | While the job runs the working title is the URL path, `/n`, in the status row. | No title until the page is fetched; the placeholder is the path. | Show the host (`sive.rs`) until the real title arrives. | open |
| F4 | WHAT'S INSIDE parts add to 552.5 KB inside a 498.2 KB whole (images 328.8 + pages 223.7). | Parts are uncompressed content bytes; the total is the compressed file. | Scale parts to the file, or label the parts as content. Eric's gate wants them to agree. | open |
| F5 | The library name is shown twice on the card: `sive_rs_n-2` and `sive_rs_n-2.zim`. | Card layout. | Design pass. | open |
| F6 | Idle create page: no polling (0 requests in 6 s). Good. | — | — | ok |
| F7 | Whole site, sqlite.org, Fast: at 14 s the job screen was replaced by the blank form (with the Recent list) for one poll, then the job came back at 26/200 pages. Seen once in a 2 s-frame run; not reproduced in a 1 s-frame run with the API watched at 0.3 s (no server flap). | Reproduced with a render trace: the page's opening poll carries `probe=1` and takes seconds; its reply lands after the new job is on screen and describes the previous, finished job. `_createIngest` treated that foreign reply by nulling the status, so the form came back for one poll. | Ingest takes only capabilities and the recent list from a foreign reply, nothing about the run. Spec test holds the probe poll back 2.5 s: 20 blank samples before, 0 after. | `3780cee` |
| F8 | Tapping Create leaves the form on screen for 1–2 s until the first poll answers; no immediate acknowledgement. | The job screen is drawn from the first status reply. | Draw the job screen optimistically from the form's own values on tap. | open |
| F9 | Site mode: the `2.3 MB size` chip stays beside a card that says 573.2 KB. Same defect as F2, four times larger. | Chip is bytes fetched, card is the file. | Same fix as F2. | open |
| F10 | The 40-page crawl ends with "Stopped early — this is everything captured up to the stop." Nobody stopped it; it reached the page limit it was given. | The page-cap exit shares the stop-early wording. | Say "Reached the 40-page limit" when the cap ended it; keep "stopped early" for a person's Stop. | open |
| F11 | Site mode: the finished card sits below the 40-row page list; on a phone the person scrolls past every page to find Open. | Card is appended after the run log. | Design pass: the result goes to the top the moment it exists; the list collapses under it. | open |
| F12 | Page mode: the working title is the URL path (`/n`); site mode gets the real title at once. | Site mode has the title from the first fetch; page mode shows the path placeholder until packaging. | Fold into F3. | open |

| F13 | Video mode, a 17-video playlist: "Creation failed — could not download … the site refused it" five seconds in. | yt-dlp was asked for subtitles in `all` languages: auto-captions in a hundred-odd languages per video, one request each; YouTube answered the Abkhazian one with 429 and yt-dlp raised. | Ask for English plus the requested language; retry once without captions when the refusal names subtitles. | `1172da0` |
| F14 | Video mode counts "1 / 17 page". | The counter label is the page-mode word. | Say "video". Design pass. | open |
| F15 | After the video job failed, the page went back to the form with the probe card ("Videos 12+ · Playlist Django & React…") rather than a failure card with the reason. Seen on the second run; the first run showed "Creation failed …" with Create another. | Not yet traced. | Trace which path shows the form after a failure. | open |
| F16 | YouTube now answers this Mac's media downloads with 403 after the caption blast; the real video re-run has to wait for the throttle to lift. | External. | Re-run later; the fix is unit-tested. | waiting |

## Engines: what the survey should decide (Eric, 09-03: "Should we just have fast and alive? When should I use rendered? Maybe we should prod the site and suggest which automatically.")

Keep three, stop making people choose. Fast for the static web (most of it, and the most durable file). Rendered for pages whose content is built by JavaScript: the finished DOM in a plain file any reader opens. Alive only when the JavaScript itself must keep running offline. The probe the create page already runs (title, robots) can add "built by JavaScript" from the fast fetch's own SPA-shell test in `creator.py`, pick the engine, and say why in one line; the picker becomes a disclosure. The Fast-versus-Rendered columns of the survey table are the evidence for which sites need it.

## Output (from the survey table; filled as rows land)

_pending the matrix_
