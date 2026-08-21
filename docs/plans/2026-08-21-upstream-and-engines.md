# Upstream posture, and what each engine is for

Written overnight Aug 20→21 while the NAS was down, from measurement on this machine. Nothing here has been published; the upstream report below is a **draft for Eric's review**, not something posted.

## The decision on licensing

**Keep MIT.** Leaning heavily on upstream costs nothing today, because the pattern this repo already uses is the one that makes it free: a process boundary is a license boundary. `crawler.py` says it outright — *"No zimit code is vendored or imported — it is GPL-3 and pinned to a single Python minor version, and the dependency boundary and the license boundary are the same boundary."* warc2zim (GPL-3) runs as a venv sidecar; zimit (GPL-3) runs as a container. Neither touches Zimi's license.

The only thing that would force a relicense is vendoring `browsertrix-behaviors` — AGPL JavaScript injected into a page we distribute. And that has a clean path too: zimit *is* browsertrix plus warc2zim, and Zimi already has `--engine zimit`. Leaning into behaviors means making that path first-class, not vendoring anything.

Why MIT is load-bearing: Zimi's wedge is being the grounding layer other systems embed. Corporate legal bans AGPL dependencies by policy, unread. AGPL would trade that for protection against a hosted competitor that does not exist.

**The one time-sensitive part:** Eric is the sole copyright holder today, which is what makes relicensing free. Once outside contributors land, moving to AGPL needs every contributor's consent. If 2.0's community backend might ever want copyleft, decide before more contributors arrive or add a lightweight CLA. Nobody sends a notice when that window shuts.

## What each engine is actually for

Measured on this machine, CNN home page, iPhone profile, network sealed to the Zimi host, article scrolled before counting.

| engine | assets | entries | images loaded | still absolute | fragments |
|---|---|---|---|---|---|
| Fast (builtin) | 377 | 396 | 41 / 68 | 0 | 0 |
| Rendered | 94 | 113 | **70 / 70** | 0 | 0 |
| Alive (patched upstream) | 315 | 334 | 12 / 68 | 1 | 0 |
| Alive (upstream as shipped) | 315 | 334 | 2 / 68 | 11 | 289 |

Read that carefully, because the naive reading is wrong. Rendered carries the FEWEST assets and renders PERFECTLY. That is not a coincidence and it is the whole design:

- **Rendered** collapses every srcset to the one candidate the browser actually chose (`img.currentSrc`) and strips `loading="lazy"`. It stores one image per image, and every reference resolves. Fewest bytes, best fidelity, no guessing.
- **Fast** parses the markup and carries every reference it can find, including all srcset variants. Biggest archive, correct at any viewport, keeps `loading="lazy"` so images arrive as you scroll.
- **Alive** records what the browser did and replays it with the JavaScript intact. Most faithful to *behaviour*. Its weakness is structural, see below.

So the three are not better/worse, they are three different bargains: smallest-and-exact, biggest-and-viewport-agnostic, and behaviourally-alive. That is worth saying in the UI instead of three engine names.

## Alive's real gap, and why it is upstream-shaped

warc2zim rewrites **every** srcset candidate to an in-ZIM path, but the archive only holds the candidate the browser actually fetched. Every other candidate becomes a link to an entry that does not exist, so a phone that picks `w_780` gets a 404 where the archive holds `w_1280`.

Rendered does not have this problem because it collapses the srcset before storing. Zimi's variant sweep (`_record_variants`, `capture_variants`) exists to fetch the other candidates so they DO exist — that is the right shape, and it needs to cover what warc2zim will go on to rewrite.

This is the clearest case for Eric's "own alternative" instinct: nobody serves *one page, JavaScript intact, thirty seconds, no Docker* well. browsertrix is a heavyweight crawler. That gap is Alive's reason to exist.

## The upstream contribution — DRAFT, not posted

**Project:** openZIM `zimscraperlib`
**File:** `zimscraperlib/rewriting/html.py`, `rewrite_srcset_attribute`, line 640
**Affects:** warc2zim, zimit, and every openZIM scraper that rewrites HTML.

```python
value_list = attr_value.split(",")
```

A srcset candidate URL may itself contain commas. Every Cloudinary- or imgix-style image API puts them in the transform segment, and CNN's does:

```
?c=16x9&q=h_720,w_1280,c_fill/f_webp
```

Splitting the attribute on a bare comma turns one candidate into three: a URL truncated at the first comma, then `w_1280`, then `c_fill/f_webp`. All three are rewritten and written into the ZIM as image addresses. Measured on a warc2zim 2.3.1 capture of cnn.com: **289 fragment candidates across 163 srcset attributes**, and the page renders with 2 of 68 images.

The spec's rule is positional rather than delimiter-based: skip leading whitespace and commas, take the run of non-whitespace as the URL, and everything up to the next comma after that is the descriptor.

Patch verified locally against the sidecar (`/tmp/zimidata/tools/warc2zim`) by re-capturing cnn.com: **289 fragments → 0**, absolute references 11 → 1, images loaded 2 → 12. The remaining shortfall is the separate variant-coverage issue described above, not this bug.

Eric must review before any of this is filed. See the repo rule: nothing goes out under his name unread.

## What to do next

1. Deploy the night's commits and re-run `scripts/capture-matrix.mjs` on the NAS — everything above is local measurement.
2. File the zimscraperlib issue/PR **after Eric reads it**.
3. Make the variant sweep cover what warc2zim will rewrite, which is Alive's remaining fidelity gap.
4. Decide the engine-naming question with the design review (running separately) — three engine names is a UI problem, and the table above is the content of the answer.
