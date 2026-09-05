# Alive: perfect on arrival, empty after a scroll

Found 2026-08-21 while trying to reconcile two true statements — Eric's ("Alive looked great for apple.com, pictures videos animations, it was the only way that worked") and the harness's ("0 of 49 images"). Both were right. They were looking at different moments.

## The measurement

apple.com, alive engine, iPhone profile, served locally, network sealed to the Zimi host:

```
on arrival        46 / 49 images loaded,  9 404s
after scrolling    0 / 49 images loaded, 49 404s
```

82 `error` events fire during the scroll, and zero `load` events. Every image ends `complete`, and every one ends with `naturalWidth === 0`. Response codes across the session: 64×200, 78×404.

cnn.com behaves the same way at a lower starting point (17/73, unchanged by scrolling — its images were already mostly missing for the separate variant-coverage reason).

Rendered on the same page: 70/70 before, 70/70 after. That contrast is the whole diagnosis.

## Why it happens

Alive's premise is that the captured page's JavaScript still runs. On a modern page that JavaScript includes a lazy-loader: it watches for images approaching the viewport and swaps them to the real file. Offline, that loader is still running, still watching, and still swapping — to URLs the capture never fetched, because a capture only ever fetches what the browser asked for, at the size it asked for, at the width it was rendered at.

So the loader replaces a picture that is on screen with one that 404s. The page is not failing to load; it is actively taking down images that already loaded.

The rendered engine cannot have this bug: it collapses each srcset to the single candidate the browser chose and strips `loading="lazy"` at capture time, so there is nothing left for a loader to re-pick — which is exactly why it holds 70/70 through the same scroll.

## Two fixes tried, both failed, both reverted

Recorded so neither gets retried.

**1. Restore on error.** Remember the `src` of every image that actually loaded; on `error`, put the working URL back. Result: no change, 0/49 after scroll. The 82 errors do fire and the handler is live in the served bundle, so the restore is either losing a race with the script or restoring a URL that also 404s.

**2. Freeze the srcset at read time.** Pin `currentSrc` into `src` and drop `srcset`/`sizes` on every loaded image — the rendered engine's trick applied in the reader. Result: no change, 0/49. So the loader is not re-picking a srcset candidate; it is replacing the element or setting `src` directly, and a reader-side attribute change does not reach it.

What this rules out matters: the failure is not srcset re-evaluation, and it is not recoverable after the fact from the parent document.

## Where the real fix probably is

Capture-side, not read-side. The archive has to contain the URLs the lazy-loader will ask for at replay time. The variant sweep is aimed at this and does not reach it — raising its cap from 240 to 700 moved cnn.com from 17 to 18 images, so the budget was never the constraint; the sweep is fetching the wrong URLs, not too few of them.

The candidate worth building: after the recording pass, drive the lazy-loader deliberately — scroll the page at two or three device widths while still recording — so the archive holds exactly what a phone, a tablet and a desktop will each request. That is a real change to `alive.py`'s recording pass, and it is a day of work with a real test, not an afternoon.

## What this means for 1.9

Alive is genuinely excellent for what Eric used it for and genuinely broken for scrolling an image-heavy page. Both halves have to be said together, because saying only the second one is how a good engine gets killed and saying only the first is how a user gets ambushed.
