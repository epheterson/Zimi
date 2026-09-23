# Regression results: Almanac

Tester: almanac lane. Server: Zimi 1.10.1 test copy at http://10.0.0.14:8977 (78-ZIM library, English Wikipedia installed). Browsers: Playwright chromium at 1280x800, webkit at 390x844 DSF 2 with an iPhone Safari user agent. Device timezone America/Los_Angeles (also Europe/London and Asia/Tokyo for the phase-marker check). Reference values from PyEphem 4.x and convertdate (Hebrew) in a scratch venv.

Screenshots: `/private/tmp/claude-502/-Users-elp-Repos-zimi/f2b98424-c2c4-4999-a823-ef803e2af907/scratchpad/regress/almanac/` (paths below are relative to that folder). The scripts that produced them (s1.js to s12.js, common.js) are in the same folder.

Counts: 31 works, 4 broken, 2 regressed, 0 docs wrong, 1 not tested (38 claims).

## Broken

Ordered by how much a user would notice.

1. **Hebrew calendar is 2 to 3 days off, every day (AL-16, and the Hebrew row shown under every calendar).**
   - Steps: open the Almanac on 22 Sep 2026 and read the calendar cross-reference, or switch the grid to Hebrew and pick 15 Nisan 5786.
   - Expected: 22 Sep 2026 is 11 Tishrei 5787. 15 Nisan 5786 (Passover) is 2 Apr 2026. Rosh Hashanah 5787 is 12 Sep 2026.
   - Seen: "Tishrei 14, 5787". Passover maps to 30 Mar 2026. In the Tishrei 5787 grid, Patriot Day (11 Sep) sits on 3 Tishrei, so 1 Tishrei lands on 9 Sep. `_hebrewNewYear` is 2 days early for every year 5780 to 5790, compared with convertdate (for example 5780 gives 28 Sep 2019; the real date is 30 Sep 2019).
   - Cause: `almanac.js:6292-6294` `_hebrewNewYear` returns `EPOCH + delay1 + delay2`. The standard algorithm (Fourmilab `hebrew_to_jd`) adds `day + 1`, so 1 Tishrei needs +2. The cross-reference is one more day off because `_jdnToCalendar` compares an integer JDN + 0.5 against a .5 new-year value (`almanac.js:6526-6532`). Hebrew holidays sit on the right Hebrew day, but every Gregorian date they map to is wrong. The CHANGELOG's 1.7.3 claim "Hebrew holidays in non-leap years" rests on this conversion.
   - Evidence: `s4-01-hebrew-nisan-5786.png`, `s4-02-hebrew-passover-selected.png`, `s4-03-hebrew-tishrei-5787.png`, `desk-12-almanac-calendar.png`.

2. **Moon-phase glyphs on the month grid land a day early (AL-06).**
   - Steps: open September 2026 in the Almanac calendar with the device in America/Los_Angeles.
   - Expected: last quarter on 4 Sep (00:51 PDT).
   - Seen: the glyph is on 3 Sep. Across all 50 principal phases in 2026, the glyph is a day early for 12 in Los Angeles, 29 in London and 45 in Tokyo. It is never late and never missing.
   - Cause: `almanac.js:427-431` `_principalPhaseOnDay` builds its window from `(cellJDN - 2440587.5) * 86400000 + 43200000`. That window runs from 12:00 UTC on the cell's date to 12:00 UTC on the next day, not over the local day, so any phase in the first half of the next UTC day is drawn on the previous cell. The error grows the further east the viewer is.
   - Evidence: `desk-12-almanac-calendar.png`, `phone-s7-sec_almanac-calendar.png`, s9.js output.

3. **Esc in the Golden Record lightbox closes the whole Almanac (found while testing AL-31).**
   - Steps: open Messages Across Time, pick Voyager Golden Record, tap any thumbnail, then press Esc.
   - Expected: the lightbox closes and you stay in the Almanac.
   - Seen: the lightbox and the Almanac both close and the `#almanac` hash is gone. Reproduced in chromium and webkit.
   - Cause: `almanac.js:7162-7163` `_grKeyHandler` does not call `stopPropagation`/`preventDefault` on Escape, so the app's global Escape handler (`goBack`, `app.js:2543`) also closes the Almanac. The month-grid popover already handles this case with `swallowEsc`.
   - Evidence: `desk-s6-11-gr-lightbox.png`, `phone-s7-07-after-gr-esc.png`.

4. **BCE years are shown without an era in the header, so the past reads as the future (AL-12).**
   - Steps: in the time machine, type year -270000 (or any year of 0 or below) and press GO.
   - Expected: the header shows a BCE year, for example "270001 BC" or "-270000".
   - Seen: "Saturday, January 1, 270001". The dock shows -270000 and the calendar shows "January -270000", but the header and eclipse dates (for example "January 24, 269880, 44218 days") drop the sign.
   - Cause: `almanac.js:484` formats with `{ year: 'numeric' }` and no `era`. Intl in en-US prints astronomical year -270000 as "270001" with the era omitted. `_renderAstroPanel` eclipse dates have the same problem.
   - Evidence: `s2-08-head-m270000.png`, `s2-10-dock-m270000.png`.

5. **Deep time shows nonsense instead of "beyond range" (AL-13).**
   - Steps: travel to -270000 or +270000.
   - Expected: the page stays live, and a panel whose math no longer holds says "Beyond this calendar's range".
   - Seen: the page stays live (it takes about 3.2 s to settle). But Deep Time reads "Earth's Tilt -10076.27°" at -270000 and "9680.74°" at +270000, beside text that says the tilt cycles between 22.1° and 24.5°. The Chinese row gives "Jiǔyue 6 · Monkey · -267303", which is 3.4M lunations past the span the code's own comment says the Meeus series can describe. The orrery also throws `TypeError: createRadialGradient ... non-finite` at `almanac-orrery.js:464` (from `_orreryAnimate`, `:1068`). No row said "beyond range" at either extreme.
   - Cause: the obliquity polynomial is not bounded in `_renderDeepTime` (`almanac.js:6876`). `_calResultUsable` (`almanac.js:6102`) accepts finite but meaningless Chinese results. `_planetPosition` goes non-finite in the orrery.
   - Evidence: `s2-09-cal-m270000.png`, `s2-08-head-m270000.png`, s7.js output.

6. **Regressed: twilight and the Morning/Evening golden-hour labels are gone (AL-21).** Sun times do follow the chosen place: Tokyo on 21 Jun 2026 reads sunrise 4:25 AM and sunset 7:00 PM, in Tokyo time. But `_computeSunTimes` still computes civil, nautical and astronomical dawn and dusk, and nothing renders them (no reference outside `almanac.js:3913-3920`). The head shows a single "Golden Hour" value (the evening one) with no Morning/Evening label. 1.8.0's CHANGELOG says "The almanac's daylight labels read 'Evening' and 'Morning'", and 1.7.3 says "proper twilight". Evidence: `s3-08-head-tokyo.png`, `phone-s7-03-top.png`.

7. **Regressed: the "About this data" section no longer exists (AL-38).** The rendered Almanac has no such section in English or French (checked the full `#almanac-content` text), and no i18n key or code for it remains. The only footer is "All calculations are math-driven and work offline forever." The CHANGELOG (1.7.2) announced it, and no entry records its removal. Evidence: s3.js output, `phone-s7-sec*.png` (last section).

Minor, not claim-breaking:
- The header's zone abbreviation is computed once from "now" and cached (`almanac.js:287-305`), so travelling to January still reads "PDT" (`phone-s10-03-lever-throw.png`: "2:01 AM · PDT" on 12 Jan 1999).
- The "Peak!" badge shows only from about noon on the peak date to noon the next day. On the peak evening itself it says "Tonight!" (`almanac.js:5145`, a rounded day count from local midnight).
- The eclipse list omits the 2027-07-18 and 2027-08-17 penumbral lunar eclipses but includes the 2027-02-20 penumbral. Nothing phantom was found.
- `/almanac-links` returned 429 three times during one run while other testers loaded the server. Links resolved on the other runs (4 chunks, all 200).
- On plain http to a LAN IP, the 📍 GPS button can never work, because browsers refuse geolocation on insecure origins. It falls back to the manual lat/lon prompt, which works.

## Results

| ID | Verdict | Evidence | Note |
|---|---|---|---|
| AL-01 | works | `phone-s7-03-top.png`, s7.js / s6.js output | Opens from the Today card, `almanac*.js` lazy-loaded. Zero requests left the Zimi server in either browser. The network was not physically turned off; the check was that no request went to another host. |
| AL-02 | works | `phone-s8-hero-moon-crop.png`, `desk-10-almanac-head.png` | Shaded albedo sphere with craters and a faint earthshine limb. On the phone the bitmap is 400px for 282 CSS px at DSF 2 (about 71% of device pixels), but it still looks sharp. |
| AL-03 | works | `phone-s7-01-today-card.png`, `phone-s7-03-top.png`, `desk-11-almanac-sky-wrap.png` | Today card 87.4%, hero 87.3 to 87.4%, sky 87.3%, all waxing gibbous lit on the right. PyEphem gives 87.34% and 394,574 km against the app's 394,649 km. |
| AL-04 | works | `s3-01-hero-waning.png` | 3 Oct 2026 07:00 at 34N 105W: last quarter, lit limb upper left. The bright-limb direction computed with ephem for that sky (moon alt 75° WSW, sun ESE) is up and to the left, which matches. |
| AL-05 | works | `desk-10-almanac-head.png`, `s3-03-head-supermoon.png`, `s2-02-head-1969.png` | Next full moon Sep 26 (ephem 26 Sep 16:49 UTC). 15 Nov 2026 gives "Nov 24 · Supermoon" (ephem 360,765 km). 20 Jul 1969 gives "Jul 28 · Supermoon" (ephem 28 Jul 19:45 PDT, 358,441 km). |
| AL-06 | broken | `desk-12-almanac-calendar.png`, `phone-s7-sec_almanac-calendar.png` | The four phase glyphs show, but often a day early (see Broken 2). |
| AL-07 | works | `phone-s7-04-sky-dusk-LA.png`, `s2-03-sky-1969.png`, `desk-11-almanac-sky-wrap.png` | LA 22 Sep 18:40: the sun sets on the right (west) at 1.5°, moon 20° up in the SE, stars in the night scene. The moon glide on time travel was seen during lever throws, not measured. |
| AL-08 | works | s1.js output (`#almanac-sky-desc` rect 1x1 px, clipped) | The sentence exists ("Almanac sky for Tuesday, September 22 at 10:21 PM. Sun below the horizon. Moon 87.3% illuminated...") and the canvas references it with `aria-describedby`. Nothing shows on screen. VoiceOver itself was not run. |
| AL-09 | works | `desk-s6-04-starchart.png`, `desk-s6-05-starchart-tap.png`, `desk-s6-07-starchart-south.png`, phone equivalents | At 34N Polaris is 34° N, with the Big Dipper low in the north and the Summer Triangle west (right for late September). Dragging to 62S removes Polaris and brings up Crux, Canopus and Sirius. The first tap names Deneb, the second opens wikipedia/Deneb. Time scrubbing is done through the time machine. Minor: the Uranus label overprints Aldebaran. |
| AL-10 | works | `desk-s6-01-orrery-hover-jupiter.png`, `phone-s6-01-orrery-hover-jupiter.png`, `desk-s6-03-orrery-max-speed.png`, `desk-s6-02-orrery-jupiter-article.png` | The slider max reads "100M× ▶". In 3 s Voyager 1 went from 173.0 to 207.0 AU and the others also moved outward. Belt, Kuiper and heliopause rings are drawn. The hover card "Jupiter · 2.7yr transfer" stays open, and its link opened wikipedia/Jupiter on desktop and phone. Back returned to the Almanac. |
| AL-11 | works | `s2-07-orrery-2100.png` | Travelling to 1 Jan 2100 moved every planet (Jupiter 181,171 to 146,268 px, and so on). The orrery date reads "Jan 1, 2100". |
| AL-12 | broken | `s2-01-tm-summoned.png`, `s2-06-dock-1969.png`, `s2-11-lever-throw.png`, `phone-s10-03-lever-throw.png`, `s2-08-head-m270000.png` | Tapping the date summons the dock at the bottom. Typing Jul 20 1969 moves the head, calendar, orrery, On This Day, sky and moon. The lever travels both ways, and the clamp at 999999 lands on 270000. Broken because BCE years are shown without an era (see Broken 4). The zone abbreviation also stays "PDT" in January. |
| AL-13 | broken | `s2-08-head-m270000.png`, `s2-09-cal-m270000.png` | The page never hung: -270000 settled in about 3.2 s and stayed responsive. But nothing said "beyond range", and Deep Time, the Chinese row and the orrery produce nonsense or throw (see Broken 5). |
| AL-14 | works | `s11-01-head-after-day-pick.png`, s2/s11 output | Clicking 15 Oct in the grid moved the head to 15 Oct (27.9%, sunrise 6:04, sunset 5:27). The world clock kept reading now (10:50:09 before, 10:50:11 after). After typing 1969 the clock still read the present. |
| AL-15 | works | `s4-04-chinese-2033-leap.png`, s3.js output | New Years: 2023-01-22, 2025-01-29, 2026-02-17, 2027-02-06, 2033-01-31, 2034-02-19, all matching HKO. Leap months: 2023 L2, 2025 L6, 2033 L11 (闰Shíyīyue shown in the grid). 22 Sep 2026 = Bāyue 12, which is correct. The zodiac follows the Chinese year. |
| AL-16 | broken | `s4-01-hebrew-nisan-5786.png`, `s4-02-hebrew-passover-selected.png`, `desk-12-almanac-calendar.png` | The Hebrew conversion is 2 to 3 days off (see Broken 1). The system order is Persian, Gregorian, Islamic, Julian, Buddhist, Hebrew, Chinese: newest origin first, per the code comment, not oldest first. The Persian, Islamic, Julian, Buddhist and Chinese rows for 22 Sep 2026 are correct. |
| AL-17 | works | `s4-01-hebrew-nisan-5786.png`, `s4-03-hebrew-tishrei-5787.png` | In the Hebrew grid, St Patrick's Day, Easter, Palm Sunday, Vaisakhi, Patriot Day and so on still appear. Their Hebrew cells are wrong because of AL-16. |
| AL-18 | works | `s3-11-cal-rome-aug.png`, `s3-12-cal-worldwide-aug.png` | With Rome chosen, 15 Aug shows Ferragosto in its own (violet) colour with the caption "Ferragosto · Italy". The Worldwide toggle adds "Independence Day · India". Location was set by city (map click is proved under AL-24/26). |
| AL-19 | works | `desk-12-almanac-calendar.png` | September 2026 shows Literacy Day, Peace, Sign Languages and Tourism. August 2026 shows Cat, Youth, Humanitarian, Photography and Dog days. |
| AL-20 | works | s11.js output, `s3-10-astro-sydney.png` | 2026 instants: 20 Mar 14:45:30 UTC (ephem 14:45:53), 21 Jun 08:24:56 (08:24:31), 23 Sep 00:05:31 (00:05:09), 21 Dec 20:50:13 (20:50:00), all within 30 s. The Autumn Equinox is on 22 Sep in PDT, which is correct. In Sydney, 15 Oct reads "Spring · 67 days to Summer Solstice". |
| AL-21 | regressed | `s3-08-head-tokyo.png`, `phone-s7-03-top.png` | Sunrise and sunset follow the location's zone. Twilight and the Morning/Evening golden-hour labels are no longer shown (see Broken 6). |
| AL-22 | works | `phone-s7-06-analemma.png` | Figure 8 with month labels; a glowing dot marks 22 Sep. The caption reads "Sun: 7.3 min ahead of clock · declination 0.6°", which is right for the date. |
| AL-23 | works | `desk-13-almanac-sunmap.png`, `phone-s7-sec_almanac-sunmap.png`, `s5-map-after-click-desk.png` | 28 city cards, tinted by daylight with sun and moon marks. The digital card has split-flap seconds and "LOS ANGELES · PDT", and the selected city glows (Mumbai for Delhi). The ledger step "digital card says CEST" does not hold in an en-US browser: Intl names Berlin "GMT+2" and the code deliberately hides GMT aliases, so it reads just "BERLIN". |
| AL-24 | works | `s5-mapcanvas-delhi-desk.png`, `s5-map-after-click-desk.png` | Clicking Delhi highlights the whole +5:30 shape with a "+5:30" axis tag. The Andamans resolve to Asia/Kolkata (checked in code; too small to see at 598px). There are 173 map cities, and the search pool has 373 more (the ledger says 354; overlaps are deduped in search). Repeated clicks at 51.0N 4.4E cycled Brussels, Amsterdam, London. |
| AL-25 | works | s4.js output | Germany is Europe/Berlin +2 (London +1), Tbilisi +4, Baku +4, Kolkata +5.5, Yangon +6.5, Eucla +8.75, Chathams +12.75, Marquesas -9.5 (22 Sep 2026). |
| AL-26 | works | `s11-02-after-three-map-picks.png`, `s4-09-manual-location.png` | Three map picks (Rome, Tokyo, Sydney) left `scrollTop` at 1332 each time. There is no automatic prompt. The location persists across a reload in the same session. With geolocation failing, the manual lat/lon overlay appears and "Set" applies. GPS success could not be tested: the test server is http on a LAN IP, and browsers refuse geolocation there. |
| AL-27 | works | `s3-06-meteors-peak-en.png`, `s3-07-meteors-peak-fr.png`, `phone-s10-01-meteors-peak-en.png` | 14 Dec 2026 22:00 shows the "Peak!" chip; the French strings exist ("Pic !"), and in French the list, the "Ce soir !" chip and the moon conditions all translate. Minor timing note in Broken. |
| AL-28 | works | `s3-05-astro-eclipses-2026.png` | From 5 Jan 2026: Annular Solar Feb 17, Total Lunar Mar 3, Total Solar Aug 12, with date only and no region. The full list matches NASA through 2028, except two omitted 2027 penumbral lunars. |
| AL-29 | works | `s3-04-otd-gagarin.png`, `s2-05-otd-1969.png` | 12 Apr shows Gagarin (1961) and STS-1 (1981). 20 Jul shows Apollo 11 and Viking 1. Count of 84 not verified. |
| AL-30 | works | `desk-s6-08-rosetta-selected.png`, `desk-s6-09-rosetta-article.png` | 10 inscriptions listed. Tapping "Rosetta Stone" selects it; a second tap opened wikipedia/Rosetta_Stone (desktop and phone), and Back returned to the Almanac. |
| AL-31 | works | `desk-s6-10-golden-record.png`, `desk-s6-11-gr-lightbox.png` | 49 thumbnails, all 49 loaded. The lightbox shows "4 / 49" with a caption. Esc in the lightbox closes the Almanac (see Broken 3). The phone screenshot of the gallery shows only the first 24 tiles, a capture artefact of a tall element; all 49 loaded. |
| AL-32 | works | `desk-s6-02-orrery-jupiter-article.png`, `desk-s6-06-starchart-article.png`, `desk-s6-09-rosetta-article.png` | 87 entity links after load (terms 37, planets 26, calendars 7, constellations 6, showers 5, eclipses 3, and others). Jupiter, Deneb and the Rosetta Stone each opened the right English article, and Back restored the Almanac. |
| AL-33 | works | s6.js output | 4 `/almanac-links` chunks, all 200. Not tested: the "failed chunk retries on next open" path. 429s were seen once under shared load, but recovery was not traced. |
| AL-34 | not tested | | Needs a library with only a non-English Wikipedia. With English installed, every link went to `wikipedia` (English). |
| AL-35 | works | `s4-10-reload-150ms.png`, `s4-10-reload-400ms.png`, `s2-01-tm-summoned.png` | The header is dark (rgba(10,10,11,.85)) and the breadcrumb reads "Zimi / almanac icon". A reload on `#almanac` boots back into it. At 150 ms the library topbar (search, dice, history) is visible over an empty dark page, but no library content flashes. |
| AL-36 | works | `s4-05-month-grid-open.png` | Clicking the month title opens the grid, and Esc closes it while the Almanac stays open. |
| AL-37 | works | `s2-11-lever-throw.png`, `s2-12-after-release.png`, `phone-s10-03-lever-throw.png` | Desktop chromium over a 5 s throw: median frame 16.7 ms, p95 50 ms, 12 of 237 frames over 50 ms. Headless webkit phone: median 30 ms, which says little about real hardware. After release the dock returns to rest and the "Traveling" face is `display:none`. |
| AL-38 | regressed | s3.js output | The section is gone in every language (see Broken 7). |
