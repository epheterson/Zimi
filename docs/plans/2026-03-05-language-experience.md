# Language Experience Overhaul — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make Zimi genuinely useful for non-English speakers end-to-end — from first visit through daily use. A French speaker, Arabic speaker, or Chinese speaker should feel like this tool was built for them.

**Architecture:** Fix broken/hidden features first (lang bar, banner, unlocalized strings, clock layout), then make the catalog language-aware, then improve the mobile topbar, then add a welcome experience for new language users. All changes in `index.html` + i18n JSON files.

**Tech Stack:** Vanilla JS (SPA), CSS, JSON i18n files

**User personas considered:**
- **Fatima (Arabic):** RTL speaker, wants Arabic Wikipedia offline for her students. Lands on GitHub, needs to find Zimi, install it, switch to Arabic, find Arabic ZIMs. Has never spoken English.
- **Yuki (Japanese):** Technical user, reads some English. Wants dev docs + Japanese Wikipedia. Expects the UI to adapt when she switches language.
- **Pierre (French):** Casual user, comfortable with English but prefers French. Has French Wikipedia installed alongside English. Wants seamless switching between article translations.
- **Amit (Hindi):** First-time user on mobile. Small screen, lots of icons confusing. Needs clear path to Hindi content.
- **Chen (Chinese):** Power user, multiple ZIMs. Wants catalog to prioritize Chinese content when browsing.

---

### Task 1: Fix the language bar not appearing in Wikipedia articles

The lang bar exists but has two bugs: (1) `_langBarDismissed` persists forever in localStorage — once dismissed, never comes back. (2) Users don't know it exists since there's no indication.

**Files:**
- Modify: `zimi/templates/index.html` — `_fetchArticleLanguages()`, `_dismissLangBar()`, `_renderLangBar()`

**Changes:**
1. Change dismiss behavior: dismiss per-session (sessionStorage) instead of forever (localStorage). Remove the localStorage set.
2. Add a subtle language indicator to the reader topbar — when translations are available, show a small badge on a "translate" icon that appears next to the back button.
3. Clicking the translate icon toggles the lang bar visibility.

**Key code changes:**

In `_dismissLangBar()` (~line 6335):
```javascript
// BEFORE:
_langBarDismissed = true;
localStorage.setItem('zimi_lang_bar_dismissed', '1');

// AFTER:
_langBarDismissed = true;
sessionStorage.setItem('zimi_lang_bar_dismissed', '1');
```

In the variable initialization (~line 6280):
```javascript
// BEFORE:
var _langBarDismissed = localStorage.getItem('zimi_lang_bar_dismissed') === '1';

// AFTER:
var _langBarDismissed = sessionStorage.getItem('zimi_lang_bar_dismissed') === '1';
```

Add translate button to reader topbar (in `updateTopbar()`) — a small globe/translate icon that only appears when `currentArticle` is set and the ZIM is a Wikimedia type. Clicking it calls `_fetchArticleLanguages()` to show/toggle the bar.

**Verify:** Open a Wikipedia article. Lang bar should appear automatically. Dismiss it. Navigate to another article — it should reappear. Close the browser tab and reopen — dismiss state is gone.

**Commit:** `fix: lang bar uses session dismiss, add translate toggle in reader`

---

### Task 2: Move language banner from home page to reader context

The banner currently shows on the home page when switching UI language. Move it to show only when reading a Wikipedia article — much more contextual and useful.

**Files:**
- Modify: `zimi/templates/index.html` — `_checkLanguageBanner()`, `setLanguage()`

**Changes:**
1. Remove `_checkLanguageBanner()` call from `setLanguage()`.
2. Instead, call it from `openReader()` / `frame.onload` — when we detect the current article's ZIM language differs from the UI language, show the banner suggesting to switch to matching Wikipedia.
3. The banner should say: "[Lang] Wikipedia is available — Switch?" with a button, or "[Lang] Wikipedia — Download?" if not installed.
4. Also: if user switches UI language while reading, refresh the banner check.

**Verify:** Switch to French on home page — no banner. Open English Wikipedia article — banner appears: "Français Wikipedia est disponible — Changer?" Click Switch — navigates to French Wikipedia version of same article (using article-languages endpoint).

**Commit:** `feat: language banner shows in reader context, not home page`

---

### Task 3: Fix remaining unlocalized strings

Found these still hardcoded in English:
- `BROWSE_CATEGORIES` names and descriptions (Encyclopedias, Q&A Communities, etc.)
- Auto-update dropdown labels: Disabled, Daily, Weekly, Monthly
- FTS section: "Full-text finds results inside articles..." and "Build" button
- Cross-ZIM Navigation header
- "Powered by Kiwix" footer
- Stats empty state and disclaimer
- "Checking..." update status
- Various `formatLanguage()` labels (LANG_NAMES)
- Catalog placeholder: "Search catalog..."
- History clear button text context
- "All languages" in catalog dropdown
- Password modal: "Set password", "Change password", "New password" (partially done)

**Files:**
- Modify: `zimi/templates/index.html`
- Modify: `zimi/static/i18n/en.json` — add ~20 new keys
- Modify: All 10 i18n JSON files — add translations

**Changes:**
Wire up each string with `t()` / `tH()`. Add keys to en.json. Use a subagent to translate to all 9 other languages.

Note: `BROWSE_CATEGORIES` names/descriptions are tricky — they're used as constants. Either: (a) make them i18n keys referenced by the constant's `key` field, or (b) keep them English since they're category labels visible primarily in the manage view. **Recommendation:** Localize the `name` field (short labels like "Encyclopedias"), keep `desc` in English (too many words, low value).

**Verify:** Switch to French. Open Library Manager > Catalog. Category names should be French. Auto-update dropdown should be French. FTS section should be French.

**Commit:** `feat: localize remaining UI strings — categories, auto-update, FTS, footer`

---

### Task 4: Fix Almanac clock mobile layout — center clock, fill grid width

Clock is centered but the timezone grid doesn't fill the available width. The grid is left-aligned instead of stretching.

**Files:**
- Modify: `zimi/templates/index.html` — mobile CSS for `.alm-tz-wrap`, `.alm-tz-list`

**Changes:**
```css
/* Mobile (existing media query, ~line 831) */
.alm-tz-wrap { flex-direction: column; gap: 12px; align-items: center; width: 100%; }
.alm-tz-clock-side { text-align: center; }
.alm-tz-clock-side canvas { width: 180px; height: 180px; }
.alm-tz-list { grid-template-columns: repeat(3, 1fr); gap: 4px; width: 100%; }
```

The key fix: add `width: 100%` to `.alm-tz-list` so the grid stretches to fill the container.

**Verify:** Open almanac on mobile (375px width). Clock should be centered. Timezone grid should span full width below it.

**Commit:** `fix: almanac timezone grid fills width on mobile`

---

### Task 5: Hide globe icon on mobile when search is focused

Currently `.topbar.search-focused` hides random-btn, library-btn, manage-btn but NOT lang-selector-btn.

**Files:**
- Modify: `zimi/templates/index.html` — mobile CSS (~line 828)

**Changes:**
```css
/* BEFORE: */
.topbar.search-focused .random-btn,
.topbar.search-focused .library-btn,
.topbar.search-focused .manage-btn { display: none !important; }

/* AFTER: */
.topbar.search-focused .random-btn,
.topbar.search-focused .library-btn,
.topbar.search-focused .manage-btn,
.topbar.search-focused .lang-selector-btn { display: none !important; }
```

**Verify:** On mobile (375px), tap the search bar. Globe icon should disappear along with other buttons, giving full width to the search input.

**Commit:** `fix: hide globe icon on mobile when search focused`

---

### Task 6: Make catalog language-aware when UI language changes

When a user switches UI to French, the catalog should auto-filter to French ZIMs (or at least default the language dropdown to French). Currently it's hardcoded to English.

**Files:**
- Modify: `zimi/templates/index.html` — catalog language dropdown, `renderBrowseGallery()`, `setLanguage()`

**Changes:**
1. Map UI language codes to ISO 639-3 catalog codes: `{en:'eng', fr:'fra', de:'deu', es:'spa', pt:'por', ru:'rus', zh:'zho', ar:'ara', hi:'hin', he:'heb'}`
2. When `setLanguage()` is called, update the catalog language dropdown to match (if the catalog tab is visible, also refresh the view).
3. Change the catalog dropdown default from hardcoded `<option value="eng" selected>English</option>` to dynamically set based on `_currentLang`.
4. Add an "All languages" option that shows everything (already exists but should be more prominent).
5. When first entering catalog, auto-select the UI language's catalog language.

**Key code (~line 4693 renderManageSettings / catalog dropdown):**
```javascript
// Map UI lang to catalog lang code
var _UI_TO_CATALOG = {en:'eng',fr:'fra',de:'deu',es:'spa',pt:'por',ru:'rus',zh:'zho',ar:'ara',hi:'hin',he:'heb'};

// In catalog dropdown rendering, set selected based on _currentLang
var catalogLang = _UI_TO_CATALOG[_currentLang] || '';
```

**Verify:** Switch UI to French. Open Library Manager > Catalog. Language dropdown should show "French" selected. Categories should show French-language ZIMs. Switch to "All languages" — shows everything.

**Commit:** `feat: catalog auto-filters to UI language when browsing ZIMs`

---

### Task 7: Mobile topbar icon overflow — collapse into menu

With globe + random + library + manage, mobile topbar is crowded. Collapse secondary actions into an overflow menu.

**Files:**
- Modify: `zimi/templates/index.html` — topbar HTML, CSS, JS

**Changes:**
Add a "more" (⋯) button that appears only on mobile, containing: globe, random, manage. Library stays visible (it's the most-used action). The overflow menu is a small dropdown.

```html
<!-- Mobile overflow menu button (hidden on desktop) -->
<button class="topbar-more" onclick="toggleTopbarMenu(event)">⋯</button>
<div id="topbar-menu" class="topbar-menu">
  <!-- Globe, Random, Manage buttons move here on mobile -->
</div>
```

CSS:
```css
.topbar-more { display: none; } /* Hidden on desktop */
@media (max-width: 600px) {
  .topbar-more { display: flex; /* show on mobile */ }
  .random-btn, .lang-selector-btn, .manage-btn { display: none; } /* hide originals */
}
.topbar-menu { position: absolute; right: 8px; top: 48px; background: var(--surface); ... }
```

**Verify:** On mobile, topbar shows: back/logo, search, library, ⋯ menu. Tapping ⋯ shows globe, random, manage in a dropdown. On desktop, everything shows normally.

**Commit:** `feat: mobile topbar overflow menu for secondary actions`

---

### Task 8: Welcome card for new language users on home page

When a user switches to a non-English language and they don't have ZIMs in that language, show a friendly welcome card on the home page (above the source grid) explaining how to get content in their language.

**Files:**
- Modify: `zimi/templates/index.html` — `renderHome()` or `setLanguage()`
- Modify: `zimi/static/i18n/*.json` — add welcome card keys

**Changes:**
1. After `setLanguage()`, check if any installed ZIMs match the new language.
2. If no ZIMs match, inject a welcome card at the top of the home page:
   - "Welcome! Looking for [Language] content?"
   - "Zimi can store entire encyclopedias offline. Browse the Catalog to download [Language] Wikipedia and more."
   - [Browse Catalog] button → opens manage > catalog (already filtered to their language per Task 6)
3. If ZIMs DO match, show a subtler card: "You have [n] [Language] sources. [View them]"
4. Card is dismissible (per-language, localStorage).

**i18n keys:**
```json
"welcome_lang_title": "Looking for {lang} content?",
"welcome_lang_body": "Zimi stores entire encyclopedias offline. Browse the Catalog to download {lang} Wikipedia and more.",
"welcome_lang_browse": "Browse Catalog",
"welcome_lang_have": "You have {n} {lang} sources",
"welcome_lang_view": "View"
```

**Verify:** Switch to Arabic. If no Arabic ZIMs installed, see a welcome card with Arabic text explaining how to get Arabic content. Click "Browse Catalog" — opens catalog filtered to Arabic.

**Commit:** `feat: welcome card for non-English language users on home page`

---

### Task 9: Remaining polish and edge cases

Catch-all for small items:

1. **Remove old `_checkLanguageBanner` from home** (after Task 2 moves it to reader).
2. **Catalog "All languages" option** should use `t('all_languages')` not hardcoded.
3. **BROWSE_CATEGORIES descriptions** — leave in English (low value to localize, they're long prose).
4. **"Powered by Kiwix" footer** — keep in English (brand name, not worth localizing).
5. **Ensure `_langBarDismissed` localStorage key is cleaned up** — migration from old localStorage to new sessionStorage (delete old key on load).
6. **Test all 10 languages** end-to-end with Playwright: load home, switch language, verify placeholder/tabs/tooltips, open manage, verify catalog.

**Commit:** `chore: polish language experience edge cases`

---

### Execution Order

Tasks 1-5 are independent fixes — can be parallelized.
Task 6 builds on UI language state.
Task 7 is independent (mobile layout).
Task 8 depends on Task 6 (catalog filtering).
Task 9 is cleanup after everything else.

Recommended: 1+4+5 → 2+3 → 6 → 7 → 8 → 9

### Out of Scope (parked for later)

- **Localized landing page / website** — Separate project, not part of the app itself. Could be a simple `index.html` with language detection that redirects to GitHub releases + install instructions in their language.
- **Rosetta Stone almanac section** — Cool idea, but separate from core language UX.
- **GitHub README localization** — Worth doing but separate from app code.
