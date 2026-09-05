# Create flow: what the person should actually see

Written overnight Aug 21. The delegated design review produced nothing across three attempts, so this is my own position, grounded in the measurements from the same night. It is opinion where it says so, and evidence where it says so.

## The measurement that decides the design

CNN home page, iPhone profile, network sealed to the Zimi host, article scrolled before counting:

| engine | assets | entries | images loaded |
|---|---|---|---|
| Fast | 377 | 396 | 41 / 68 |
| Rendered | 94 | 113 | **70 / 70** |
| Alive | 315 | 334 | 12 / 68 |

The naive reading — "Rendered is best" — is wrong, and so is "Fast is biggest so Fast is most complete". They are three different bargains:

- **Rendered** collapses each srcset to the one candidate the browser chose and strips `loading="lazy"`. One image per image. Smallest archive, every reference resolves, exactly this screen's sizes.
- **Fast** carries every srcset variant. Biggest archive, correct at *any* viewport, keeps lazy-loading so images arrive as you scroll.
- **Alive** records the session and replays it with the JavaScript intact. Faithful to *behaviour*, which nothing else here is.

That is the real content of the choice. Three engine names are not.

## 1. Nobody should see the words Fast, Rendered, Alive

Those are implementation names. "Rendered" and "Alive" do not distinguish themselves to anyone who has not read the source — both sound like "it works properly", which tells a person nothing about which to pick.

**Zimi should choose, and say what it chose.** The probe already computes the input to the decision: `looks_like_spa()` exists and already refuses SPAs in site mode. A page whose content is server-rendered wants Fast. A page built in JavaScript wants Rendered. Alive is for the person who specifically wants the thing to still *behave*, which is not a default anybody arrives at by accident.

So the primary screen has one action and no engine question at all. After the capture, one line of provenance says what happened and why:

> `create_chose_rendered`: "This page builds itself in JavaScript, so Zimi captured it with a browser."
> `create_chose_fast`: "This page was already complete when it arrived, so Zimi captured every image size."

That line is doing real work: it is honest, it teaches the model over time, and it makes the Options disclosure discoverable to exactly the person who will want it.

**If a choice is shown** — behind Options, or when someone overrides — the labels must name the outcome, never the mechanism:

- **Exact copy** — "Looks exactly as it does on this screen. Smallest file."
- **Every size** — "Bigger, and right on any device you read it on."
- **Still interactive** — "The page's own scripts keep running. Most faithful, least predictable."

Opinion, held firmly: shipping three mechanism names was the single biggest UX error in the feature, because it pushed a decision onto the user that the server is better positioned to make and that the user has no information to make well.

## 2. The wait should show the thing being captured

Thirty to ninety seconds of a scrolling log is dead air, and the log is the least interesting thing on the screen. The user's actual question during a capture is one question: **is this working, or is it hung?** Numbers answer that badly. A number that has not moved in four seconds reads as a hang even when it is fine.

What we already have, and are not showing:

- the site's favicon and title (the probe fetches both — `site_illustration`, `_page_title_from_html`)
- the count and byte total of assets carried, emitted throttled (`carried N assets, M bytes`)
- the actual image bytes, as they land

So: as soon as the probe returns, put the site's **favicon and title** at the top — the person sees Zimi has found the right thing before any waiting begins. Then, as assets arrive, grow a **small grid of thumbnails of the images actually carried**, newest last.

A thumbnail appearing every second or two answers "is it working" in a way no spinner can, because it is not a representation of progress, it *is* the progress. It also makes a slow capture feel like collecting rather than waiting.

Keep one honest line under it — the current phase and elapsed time. Kill the log from the default view; put it behind a disclosure for when something goes wrong.

## 3. The completion screen leads with the page, not the numbers

The one thing a person wants when a capture finishes is not size and not counts. It is: **did I get it, and can I read it now?**

So the completion screen should show **the captured page itself** — a real thumbnail of the stored result, which we can produce because we have the page and a browser. That is the proof, and it is the only element on that screen that can be trusted at a glance. Under it, one sentence:

> **Saved.** 94 images · 13 MB

and one primary button: **Open it**.

The composition bar and the per-type breakdown are good and should stay — as secondary detail, below the fold, for the person who wants them. They are currently doing a job they are not suited to: being the answer to "did this work".

## Ranking

**1.9 (days, small):**
- Favicon + title at the top of the run, from the probe. Cheapest win on the list.
- Completion screen leads with "Saved. N images · M MB" and an **Open it** button.
- Engine names replaced with outcome labels; default is chosen by the server with a one-line explanation.

**1.9.1:**
- Growing thumbnail grid during capture. Needs a way to stream carried image bytes to the client; the counts already stream, the bytes do not.
- Captured-page thumbnail on the completion screen.
- Log moves behind a disclosure.

**2.0:**
- The chooser learns: remember overrides per-domain, so a site someone always captures Alive stops asking.

## What I am least sure about

The automatic engine choice is the right call for the default, but `looks_like_spa()` is a heuristic and it will be wrong sometimes. The mitigation is that being wrong is cheap and visible — the provenance line says what was chosen, and re-capturing with an override is one tap. That is a better failure than the current one, where the person makes an uninformed choice and has no idea it was wrong.
