# Accessibility — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task.

**Goal:** Make Zimi work for screen-reader users, keyboard-only users, low-vision users, and users who need reduced motion. Currently the SPA assumes a mouse + sighted user.

**Architecture:** Layered. Static landmarks first (cheap big wins), then interactive widgets (more involved), then injected fixes for ZIM content (harder because it's third-party HTML). No build step — keep vanilla.

**Tech Stack:** ARIA, semantic HTML, `prefers-reduced-motion`, `prefers-contrast`, focus management.

---

## Task 1: ARIA landmarks

**Files:** `zimi/templates/index.html`, `zimi/static/app.js` (dynamic regions)

Add `role="navigation"` to topbar, `role="main"` to results area, `role="complementary"` to history-panel, `role="search"` to the search-form region. `aria-label` on each. Toast region gets `role="status" aria-live="polite"`. The password modal gets `role="dialog" aria-modal="true" aria-labelledby="pw-title"`.

**Verify:** macOS VoiceOver — Ctrl+Opt+U opens the rotor, lists landmarks. Should see "Navigation, Search, Main, Complementary" at minimum.

## Task 2: Keyboard navigation audit

Walk every flow with Tab only, never touching the mouse:
- Search → results → click an item → reader → close
- Manage → catalog drilldown → multi-select → download
- Almanac → location prompt → moon view

Catalog the breaks:
- Items that aren't tab-focusable but should be
- Items that focus-trap (modal that doesn't release on Esc)
- Visible focus indicators that disappear in dark mode

**Files:** Mostly CSS (`:focus-visible` styles, currently inconsistent) + a few `tabindex="0"` and `keydown` handlers.

## Task 3: Screen-reader descriptions for the simulated sky

Right now the sky animation is a `<canvas>` with no semantic info. Add a sibling `<div class="sr-only">` updated on each frame with computed values:

> "Almanac for Saturday April 26 2026, 11:43 AM PDT. Moon: First quarter, 39% illuminated, altitude 45 degrees, azimuth south-southwest. Sun set 4 hours ago. Visible constellations: Leo, Ursa Major. Next meteor shower: Eta Aquariids in 9 days."

The almanac already computes all these values; just emit them as text.

**Files:** `zimi/static/almanac.js` — find the render loop, add sr-only update.

## Task 4: prefers-reduced-motion

**Files:** `zimi/static/app.css`, `zimi/static/almanac.js`, `zimi/static/space.js`

Wrap every transition/animation in:
```css
@media (prefers-reduced-motion: no-preference) {
  /* the animation */
}
```

In the almanac canvas: gate the orbital animation; show a static snapshot instead.

## Task 5: prefers-contrast / forced-colors

Test in Windows High Contrast mode (Edge), and macOS Increase Contrast. Catalog the breakage:
- Custom CSS-variable colors → respected? (Probably not.)
- Border-only buttons → still distinguishable?
- Amber-on-dark → contrast ratio ≥ 4.5:1?

Audit with axe-devtools or Lighthouse.

## Task 6: Inject heading structure into served ZIM HTML

**Why:** ZIM articles vary wildly. Wikipedia is fine, dev-docs sometimes have `<h1>` missing or duplicated, some sites use only `<div>`. Screen-reader users navigate by heading — broken structure breaks them.

**Files:** `zimi/http.py` (the iframe-content path)

Use a tiny HTML rewriter (already have BeautifulSoup or could use stdlib `html.parser`):
- Ensure exactly one `<h1>` in the body
- Promote `<div class="title">` to `<h1>` when no heading exists
- Add `alt=""` to images that have none (decorative-by-default per WCAG)

**Trade-off:** modifies third-party content. Default opt-in via `?a11y=1` to keep purist users happy.

## Task 7: Skip-to-content link

Standard a11y pattern. Hidden until focused; jumps focus to `#main-content`. First tab-stop on every page.

**Files:** `zimi/templates/index.html`, `zimi/static/app.css`

## Task 8: Form labeling

Every input gets a `<label>` — currently several use `placeholder` only.

**Files:** `zimi/templates/index.html`, modals + forms.

## Verification

- **VoiceOver walkthrough:** record a video of completing each major flow; embed in `docs/accessibility.md`.
- **Lighthouse a11y score:** must hit ≥ 90 (currently ~60-70).
- **axe-devtools:** zero violations on Home, Catalog, Reader.
- **Keyboard-only:** complete a search → read article → bookmark → close — no mouse.

## Out of scope

- **i18n RTL polish:** existing 10-language support already handles RTL via `dir="rtl"`. Spot-check Hebrew + Arabic but don't deep-dive.
- **Voice control:** out of scope; would need explicit gesture mapping.
- **AI alt-text generation for ZIM images:** offline-first; defer.

## Estimate

Three working sessions:
1. Tasks 1-2 (landmarks + keyboard audit fixes)
2. Tasks 3-5 (sky descriptions + media-query gates)
3. Tasks 6-8 (HTML rewriting + remaining polish + verification pass)
