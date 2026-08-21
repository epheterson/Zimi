# Morning deploy — 2026-08-21

Written the night of Aug 20 with the NAS unreachable. Everything below is committed on `v1.9`, nothing pushed.

## Do this first

The NAS stopped answering ping, SSH (2222), and both hostnames at about 21:20. The gateway was fine, so it is the box, not the network. Five full `docker compose build --no-cache` cycles ran against it that evening, each re-downloading Chromium and rebuilding the Playwright layer — worth checking disk and memory before assuming a coincidence.

Once it is back:

```bash
./deploy.sh
ZIMI=http://10.0.0.14:8899 TOKEN=<token> ENGINES=builtin,rendered,alive \
  OUT=/tmp/fid node scripts/capture-fidelity.mjs https://www.cnn.com
```

Prod is currently running `9527fd8`. Four commits after it have never been deployed or verified against a live site.

**Rotate the API token** — it was pasted into a chat transcript.

## What is proven and what is not

| commit | change | evidence |
|---|---|---|
| `c202cf2` | UA drops `Headless`; a non-HTML `document.contentType` fails the job | Measured on the NAS: headless UA → 13 bytes / 0 images, normal UA → 5.6 MB / 72 |
| `af29738` | Serialization drops viewport-covering fixed overlays | Live CNN: consent text visible → gone, overlays 1 → 0, `overflow` hidden → visible |
| `0684ce6` | Reader clears rebuilt overlays; Define tip keeps a ledger | Verified on Alive/Rendered/Fast ZIMs built *before* the fix — all three clear |
| `9527fd8` | Comma bug, JS copies 3 and 4 | Real-browser test over CNN-shaped URLs |
| `6e9f2fd` | Lazy scroll runs to the bottom, bounded | **Tests pass, but it did NOT fix CNN's images.** See below |
| `e7b924c` | `video_ready` + parity guard | Guard verified to fail on an unprobed mode |
| `ddf0e9f` | Comma bug, copy 5 (`_fix_srcset`) | Invariant test: no candidate is ever a fragment |

Full suite: 2421 passed, 9 skipped. Touched modules re-verified after the last commits: 124 passed.

## The open one: Rendered carries ~30 assets, Fast carries ~380

I diagnosed this as the lazy scroll stopping after 12 viewport-heights (9,720px of a 56,638px page). That was a real bug and `6e9f2fd` fixes it, **but it did not change the outcome** — a local CNN capture after the fix still produced 29 assets, 48 entries, 10.7 MB.

Instrumenting the actual gates in `_collect` rules out the obvious suspects:

```
TOTAL RESPONSES: 76
BY KIND: {document: 3, font: 4, image: 45, media: 5, script: 9, fetch: 7, xhr: 2, stylesheet: 1}
GATES:   {KEPT: 55, document: 3, kind-not-kept:script: 9, kind-not-kept:fetch: 7, kind-not-kept:xhr: 2}
DOM IMAGES: 72
```

Nothing is lost to body eviction, size caps, or budgets — every kept response yielded a body. The browser simply **requests 45 images for 72 DOM images**, and Fast carries 380 because it parses every reference in the HTML including all srcset variants, while a browser downloads only the one variant it picks.

So the gap is partly by design. What is *not* explained: why the real capture carries 29 when the same page yields 55 keepable responses, and why 66 of 71 images are broken in the reader when the assets that were carried do resolve. Start there — compare the carried set against the DOM's `src` set after `_PREPARE_JS`, and find which side of the join is missing.

Do not assume the scroll fix helped. It is correct on its own merits and its tests are honest, but it is not the cause of this symptom.

## Still open, unchanged

- **Alive replays a 404** for `.../c_fill/f_webp`. Copy 5 may have fixed it — unverified, since Alive needs the warc2zim sidecar and this machine has none. Check on the NAS. If it survives, the split is happening inside warc2zim/wombat and is upstream.
- **Rendered black bar** at the top of the capture. A probe found zero black-background elements on the live page after cleaning, so it is not the fixed ad slot. Undiagnosed.
- **#65 pulsing** — the harness counts 6 infinite animations on live CNN and 0 in all three captures. Needs a repro.
- **#67** — rendered with `--out` and no `ZIM_DIR` works here. Needs a repro or close it.

## The pattern worth naming

Pillow missing, then yt-dlp missing, then the comma bug in its third, fourth and fifth homes. Same class each time, found one at a time by field testing. `e7b924c` closes the first class structurally — a mode cannot be advertised without a readiness answer. The duplicated-logic class now has one implementation and an invariant test, but the only reason copy five was found is that someone grepped for the shape instead of waiting for a user to hit it.
