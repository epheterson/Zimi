# Issue replies for the 1.9.0 release ,  DRAFTS, post only on Eric's go

One reply per issue, posted after the release is tagged and live. No hard wrapping (GitHub renders single newlines as breaks). Close each issue after replying.

---

## #48 (orrery ignores the time machine)

Fixed in 1.9.0. The solar system view now follows the time machine: travel somewhere and the planets go with you, return to now and the live clock resumes. The speed controls dim while you are traveling since the time machine owns the clock during a trip, exactly as you expected it to work.

Thanks for catching this one. The two features shipped in adjacent releases and had never been formally introduced to each other.

## #49 (links are not real links)

Fixed in 1.9.0. The logo, source tiles, search results and the Almanac card are now genuine anchors, so middle-click, right-click and open-in-new-tab all behave like the rest of the web. The app also picked up real URLs for its full-page views along the way (the Create page is `/#create`, matching the Almanac's `/#almanac`), so this class of problem should stay fixed.

## #50 (MDWiki appears twice, Update fetched the wrong flavor)

Fixed in 1.9.0, and thank you for the exact catalog names, which made this one reproducible in minutes. Three things were wrong and all three are fixed: the two MDWiki builds collided into cards that both claimed to be "Full" (flavor identity now comes from the filename token, so you see "Maxi" and "Full + video"), installed detection matched by prefix so the wrong card got the checkmark, and Update could quietly fetch the 10.75 GB video edition you never installed. The same trap existed for a few Wikipedia entries and is covered by the same fix.

## #51 (server freezes after a download completes on a Pi)

Fixed in 1.9.0, and this was the most valuable report of the batch, because it led us to a whole class of problems. What you hit: a finished download re-verified the whole file and then re-scanned every installed archive while holding the one lock every reader needs, which on a Pi with network storage reads as a crash. Registration is now incremental: in our measurements the worst lock wait went from 10.6 seconds to 0.45 seconds and archives opened went from all 53 to just the new one. We then hunted the same pattern out of bookmark export and ZIM deletion, and the release gate now watches for regressions here before every release.

Your reports made this a better release across the board. Thanks for running Zimi on real hardware and telling us what broke.

## #55 (snap dies at launch: GLIBC_2.38 not found)

Fixed in 1.9.0, and sorry this sat unanswered since August. You had it exactly right: the snap asked its base for a glibc it does not have. The base is core22 (glibc 2.35); the binary inside it was built on a runner that had floated to Ubuntu 24.04 (glibc 2.39). Under confinement the binary gets the base's glibc, not your machine's, so your Ubuntu version was never the problem. The build runner is now pinned to 22.04, the coupling is written down in both files so they move together, and the AppImage from the same job benefits from the same pin. The 1.9.0 snap is built that way; if it still fails to launch for you, say so here and it becomes the first thing we look at.
