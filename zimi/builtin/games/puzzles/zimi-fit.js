/* ZimiGames: the one script every puzzle page loads before its own.
   It never touches puzzle code. Simon Tatham's frontend keeps its own menu form and its own colours; this
   script makes the page an ordinary ZimiGames page around them:
     - it builds the game's bar (Back, title, Undo) and hands the shell (../shell.js) the rest: Restart, Redo and
       Show solution go to the Menu, Game and Type go to Menu > New game, the rules are How to play (help.<name>.* in text/en.json);
     - it remaps the puzzle's canvas palette to Zimi's tokens, in light and dark;
     - a long press is the right button (touch has none), and Mark makes the next taps right presses; a keypad serves the
       puzzles that take digits;
     - Menu > Settings carries the puzzle's own preferences as rows (read from its preferences dialog, which never shows);
       its other dialogs (a custom size, a game ID) are put in the player's language;
     - Undo and Redo sit in the bar, Show solution asks first and is never a win, the best time per type is kept.
   It runs before the puzzle's script (both are deferred, in order), so the fit box exists when the puzzle looks
   for it and the palette hook is in place before the first colour arrives. */
(function () {
  "use strict";
  var d = document, root = window;
  var SHELF = "../index.html";
  var KEYPAD = { solo: 9, keen: 9, towers: 9, unequal: 9, filling: 9, group: "abcdefgh" };
  var KEY_CODES = { Backspace: 8, Enter: 13 };
  var LONG_PRESS_MS = 450;     // a touch held this long, without moving, is a right press
  var LONG_PRESS_SLOP = 10;    // px a finger may drift and still be holding still
  var TWO_FINGER_MS = 350;     // two fingers down and up within this, without moving, are the middle button
  var NATIVE_QUIET_MS = 700;   // after a touch, the browser's own mouse events for it are dropped
  var SOLVED_SHEET_MS = 1000;  // the puzzle's own flash of success plays before the sheet comes
  var READY_POLL_MS = 50;      // how often to ask whether the puzzle's own script has started the game
  var CLOCK_TICK_MS = 500;     // how often the solving clock counts
  var BEST_KEY = "zimi.games.puzzleBest";
  var ADVANCED_OPEN_KEY = "zimi.games.puzzleAdvanced";
  // Pages that stay in the ZIM but are not on the shelf: the shelf's own game of the same kind is the one tile, and Back goes to it.
  var FOLDED = { mines: "minesweeper", solo: "sudoku", guess: "codebreaker" };
  // Puzzles whose right button does nothing the left does not: no Mark toggle for them.
  var LEFT_ONLY = { fifteen: 1, sixteen: 1, flood: 1, samegame: 1, cube: 1, inertia: 1, pegs: 1, untangle: 1, netslide: 1, flip: 1 };

  // Zimi opens a page with its language in the hash (#lang=fr&dir=ltr). To the puzzle a hash is a game ID, and it would answer with
  // an error box and no saved game could come back; the words are already read (text.js), so the hash goes.
  if (/^#(?:lang|dir)=[^&]*(?:&(?:lang|dir)=[^&]*)*&?$/.test(root.location.hash) && root.history && root.history.replaceState) root.history.replaceState(null, "", root.location.pathname + root.location.search);
  // The day's puzzle (ZimiShell.daily, ../shell.js): its daily type and the day's seed as a game ID ("10x10t0dn#<seed>"), so the
  // puzzle makes the same grid for everyone that day. A daily left part-way comes back from its own save instead.
  var DAILY = root.ZimiShell && root.ZimiShell.daily;
  if (DAILY && typeof DAILY.kind === "string" && !root.location.hash && !root.ZimiShell.peekSave() && root.history && root.history.replaceState) {
    root.history.replaceState(null, "", root.location.pathname + root.location.search + "#" + DAILY.kind + "#" + DAILY.seed);
  }

  function el(tag, cls, text) {
    var e = d.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
  }
  function $(id) { return d.getElementById(id); }

  // Words go through ZimiText (shell.js loads it before this file); English is what shows when it or an id is missing. A label
  // made before the language file arrives is set again when it does.
  var labelled = [];
  function T(key, english, vars) {
    var Z = root.ZimiText;
    if (Z && Z.has(key)) return Z.T(key, vars);
    return english.replace(/\{(\w+)\}/g, function (m, k) { return vars && vars[k] !== undefined ? vars[k] : m; });
  }
  function num(n) { return root.ZimiText ? root.ZimiText.number(+n) : String(n); }
  function setWord(w) { if (w[3]) w[0].setAttribute(w[3], T(w[1], w[2])); else w[0].textContent = T(w[1], w[2]); }
  // Gives node its words (its text, or the attribute attr), and keeps them in the player's language.
  function word(node, key, english, attr) {
    var w = [node, key, english, attr];
    labelled.push(w); setWord(w);
    return node;
  }
  if (root.ZimiText && root.ZimiText.onChange) root.ZimiText.onChange(function () { labelled.forEach(setWord); });

  // ── the palette ──────────────────────────────────────────────────────────
  // The frontend asks C for its colours one by one (js_set_colour) and stores them in the global `colours`. The puzzle
  // script declares `var colours = []`; with an accessor already on window, that declaration assigns through our setter,
  // and every colour the frontend stores goes through `remap` first. Greys become a ramp from Zimi's ink (black) to its
  // surface2 (white), so a light puzzle becomes a dark one by the same rule; the background is surface2; yellows are
  // amber; the other hues keep their meaning but are pulled toward neutral, and lifted in dark.
  var FALLBACK = {
    light: { ink: "#26241f", surface2: "#ffffff", error: [4, 0.62, 0.40] },
    dark: { ink: "#e8e8ed", surface2: "#1c1c20", error: [4, 0.78, 0.64] }
  };
  var AMBER_HUE = 38;
  // Puzzles whose colours are the game itself (which block is which): their hues are kept apart, never merged into amber or red.
  var CATEGORICAL = { flood: 1, samegame: 1, guess: 1, signpost: 1, map: 1, inertia: 1 };
  var NAME = root.location.pathname.split("/").pop().replace(".html", "");
  // A pure blue is not Zimi: it becomes one muted slate, except where the hue is the game. Where a puzzle uses a
  // color for "selected" or "the active thing", that color is amber. The numbers are colour indexes in that puzzle's palette.
  var SLATE = { light: [220, 0.30, 0.42], dark: [220, 0.42, 0.70] };
  var KEEP_BLUE = { flood: 1, samegame: 1, guess: 1, map: 1 };
  var ROLES = {
    pegs: { 4: "amber" },                                   // the cursor
    net: { 5: "amber" },                                    // the wires that are lit
    mines: { 1: "sunk", 20: "surface2", 21: "edge" },       // an opened square sinks into the page; a closed one is raised, with an ink edge
    loopy: { 2: "unknown" },                                // an edge not yet drawn is a faint guide under the lines that are
    pattern: { 4: "unknown" }                               // a square not yet decided sits just above the panel
  };
  var raw = [], mapped = [];
  function isDark() {
    var t = d.documentElement.getAttribute("data-theme");
    if (t) return t === "dark";
    return !!(root.matchMedia && root.matchMedia("(prefers-color-scheme: dark)").matches);
  }
  function token(name, fallback) {
    var v = root.getComputedStyle(d.documentElement).getPropertyValue(name).trim();
    return /^#[0-9a-f]{6}$/i.test(v) ? v : fallback;
  }
  function parse(hex) { return [1, 3, 5].map(function (i) { return parseInt(hex.slice(i, i + 2), 16); }); }
  function toHex(rgb) { return "#" + rgb.map(function (v) { return ("0" + Math.max(0, Math.min(255, Math.round(v))).toString(16)).slice(-2); }).join(""); }
  function mix(a, b, t) { return a.map(function (v, i) { return v + (b[i] - v) * t; }); }
  function toHsl(rgb) {
    var r = rgb[0] / 255, g = rgb[1] / 255, b = rgb[2] / 255, mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, s = 0, h = 0;
    if (mx !== mn) {
      var dd = mx - mn;
      s = l > 0.5 ? dd / (2 - mx - mn) : dd / (mx + mn);
      h = mx === r ? (g - b) / dd + (g < b ? 6 : 0) : mx === g ? (b - r) / dd + 2 : (r - g) / dd + 4;
      h *= 60;
    }
    return [h, s, l];
  }
  function fromHsl(h, s, l) {
    var c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2, p;
    p = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
    return p.map(function (v) { return (v + m) * 255; });
  }
  function remap(index, hex) {
    if (!/^#[0-9a-f]{6}$/i.test(hex)) return hex;
    var dark = isDark(), fb = FALLBACK[dark ? "dark" : "light"];
    var ink = parse(token("--ink", fb.ink)), ground = parse(token("--surface2", fb.surface2));
    var rgb = parse(hex), hsl = toHsl(rgb), h = hsl[0], s = hsl[1], l = hsl[2];
    if (index === 0) return toHex(ground);
    var role = (ROLES[NAME] || {})[index];
    if (role === "amber") return token("--select-ring", "#f59e0b");
    if (role === "sunk") return toHex(dark ? parse(token("--ground", "#0a0a0b")) : mix(parse(token("--ground", "#f2efe8")), ink, 0.1));
    if (role === "surface2") return toHex(ground);
    if (role === "edge") return toHex(mix(ink, ground, 0.3));
    if (role === "unknown") return toHex(mix(ground, ink, 0.16));
    if (!KEEP_BLUE[NAME] && s > 0.8 && h >= 225 && h <= 250 && l >= 0.4 && l <= 0.5) { var sl = SLATE[dark ? "dark" : "light"]; return toHex(fromHsl(sl[0], sl[1], sl[2])); }
    if (s < 0.12) return toHex(mix(ink, ground, (rgb[0] + rgb[1] + rgb[2]) / 765));      // grey: black is ink, white is surface2
    var plain = !CATEGORICAL[NAME];
    if (plain && s > 0.5 && (h <= 12 || h >= 348)) return toHex(fromHsl(fb.error[0], fb.error[1], fb.error[2]));   // errors are Zimi's red
    if (plain && s > 0.5 && h >= 38 && h <= 70) h = AMBER_HUE;                                    // yellow is amber
    if (dark) {
      l = 0.28 + 0.42 * l + (h >= 190 && h <= 260 ? 0.1 : 0);
      s *= 0.75;
    } else s *= 0.8;
    return toHex(fromHsl(h, s, l));
  }
  var colours = new Proxy(mapped, {
    set: function (t, k, v) {
      if (/^\d+$/.test(k)) { raw[+k] = v; t[k] = remap(+k, v); } else t[k] = v;
      return true;
    }
  });
  Object.defineProperty(root, "colours", { configurable: true, get: function () { return colours; }, set: function () { /* the puzzle's `var colours = []` */ } });
  function recolour() {
    raw.forEach(function (v, i) { mapped[i] = remap(i, v); });
    if (mapped[0]) d.documentElement.style.setProperty("--puzzle-background", mapped[0]);
    root.dispatchEvent(new Event("resize"));      // the puzzle redraws on a resize
  }
  var lastDark = isDark();
  function themeMayHaveChanged() { if (isDark() !== lastDark) { lastDark = isDark(); recolour(); } }
  if (root.MutationObserver) new MutationObserver(themeMayHaveChanged).observe(d.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  if (root.matchMedia) {
    var mq = root.matchMedia("(prefers-color-scheme: dark)");
    if (mq.addEventListener) mq.addEventListener("change", themeMayHaveChanged);
  }

  // ── the page ─────────────────────────────────────────────────────────────
  function metaViewport() {
    if (d.querySelector('meta[name="viewport"]')) return;
    var m = el("meta");
    m.name = "viewport";
    m.content = "width=device-width, initial-scale=1, viewport-fit=cover";
    d.head.appendChild(m);
  }
  function puzzleName() { return d.title.replace(/ - ZimiGames$/, ""); }

  // The frontend finds its menu and buttons by id and clicks them itself, so they stay in the page, hidden. Ours are
  // proxies: they click the original, and follow its disabled state.
  var SVG_NS = "http://www.w3.org/2000/svg";
  var ICON_PATHS = { undo: "M9 14 4 9l5-5M4 9h9.5a6 6 0 0 1 0 12H9", redo: "M15 14l5-5-5-5M20 9h-9.5a6 6 0 0 0 0 12H15" };
  // [the original's id, English, our id, string id, icon (in the bar, no words) or null]
  var ORIGINALS = [["undo", "Undo", "pz-undo", "shell.undo", "undo"], ["redo", "Redo", "pz-redo", "pz.redo", "redo"], ["restart", "Restart", "pz-restart", "pz.restart"], ["solve", "Show solution", "pz-solve", "puzzles.showSolution"]];
  var staged = null;      // a Type chosen in the New game pane, applied by Start
  var customPick = null;  // the custom size panel, when that is what the pane has chosen
  // What a button does besides press the original: Show solution asks first, and Restart starts the clock and the win over.
  var CLICKS = { solve: function (orig) { confirmSolve(orig); }, restart: function (orig) { newGameStarted(); orig.click(); } };
  function icon(name) {
    var svg = d.createElementNS(SVG_NS, "svg"), path = d.createElementNS(SVG_NS, "path");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    path.setAttribute("d", ICON_PATHS[name]);
    svg.appendChild(path);
    return svg;
  }
  function proxy(orig, label, id, click, key, iconName) {
    var b = el("button", "ar-btn");
    b.type = "button";
    b.id = id;
    if (iconName) {
      b.classList.add("zf-icon");
      b.setAttribute("data-gs-bar", "");
      b.appendChild(icon(iconName));
      b.appendChild(word(el("span", "zf-label"), key, label));    // shown where the button is in the Menu (in Zimi's own bar), not in the bar
      word(b, key, label, "aria-label");
    } else word(b, key, label);
    function follow() {
      b.disabled = !!orig.disabled;
      b.setAttribute("aria-disabled", b.disabled ? "true" : "false");
    }
    follow();
    if (root.MutationObserver) new MutationObserver(follow).observe(orig, { attributes: true, attributeFilter: ["disabled"] });
    b.addEventListener("click", click || function () { orig.click(); });
    return b;
  }
  // Show solution shows the answer and is never a win: it asks first.
  function confirmSolve(orig) {
    if (!root.ZimiShell) { orig.click(); return; }
    root.ZimiShell.sheet({
      title: T("pz.solveTitle", "Show the solution?"), text: T("pz.solveText", "This game will not count as a win."),
      actions: [{ label: T("shell.cancel", "Cancel") }, { label: T("pz.solveGo", "Show solution"), primary: true, onclick: function () { orig.click(); } }]
    });
  }
  function buildBar() {
    var bar = el("header", "ar-bar zf-bar");
    var back = el("a", "ar-back", String.fromCharCode(0x2039));
    back.href = FOLDED[NAME] ? "../" + FOLDED[NAME] + ".html" : SHELF;
    word(back, "shell.back", "Back", "aria-label");
    bar.appendChild(back);
    bar.appendChild(el("h1", "", puzzleName()));
    ORIGINALS.forEach(function (o) {
      var orig = $(o[0]);
      if (orig) bar.appendChild(proxy(orig, o[1], o[2], CLICKS[o[0]] ? function () { CLICKS[o[0]](orig); } : null, o[3], o[4]));
    });
    // The shell hides this one and starts the game with it, from Menu > New game.
    var newOrig = $("new");
    if (newOrig) bar.appendChild(proxy(newOrig, "New game", "pz-new", startNew, "shell.menu.new"));
    d.body.insertBefore(bar, d.body.firstChild);
  }
  function startNew() {
    if (customPick) {   // a custom size: its dialog set from the pane and OK pressed (that starts the game)
      var custom = customPick;
      customPick = null; staged = null;
      newGameStarted();
      custom.apply();
      return;
    }
    var radio = staged && $("gametype") && $("gametype").querySelector('input[name="preset"][value="' + staged + '"]');
    staged = null;
    newGameStarted();
    if (radio && !radio.checked) radio.click(); else $("new").click();       // choosing a type starts a game of it
  }

  // ── the puzzle's English, in the player's language ──────────────────────
  // What the frontend and the puzzles write (a type's name, a dialog's labels) is English from the C code. The words below are the
  // ones we have; a label made of them is put in the language, and one made of anything else stays as the puzzle wrote it. An id is
  // pz.d.<the English, lowercased, runs of other characters as "_">; the older single words are pz.w.<word>.
  function slug(english) { return english.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, ""); }
  function matchCase(source, text) {
    var first = text.charAt(0);
    return source.charAt(0) === source.charAt(0).toUpperCase() ? first.toUpperCase() + text.slice(1) : first.toLowerCase() + text.slice(1);
  }
  // One phrase: its translation when we have it (never English made up), else null.
  function phrase(english) {
    var Z = root.ZimiText, k = slug(english);
    if (!Z || !k) return null;
    var id = Z.has("pz.d." + k) ? "pz.d." + k : Z.has("pz.w." + k) ? "pz.w." + k : null;
    return id ? matchCase(english, Z.T(id)) : null;
  }
  // Numbers, percentages and the like stay as they are.
  var PLAIN = /^[\d%.,\s\-()n^]*$/;
  function xl(english) { return PLAIN.test(english) ? english : (phrase(english) || english); }
  // Names with a number in them, and the one-word additions to a type; longest first so "Great-Great-Dodecagonal" beats "Dodecagonal".
  var TEMPLATES = [[/(\d+)-(\d+) balls/g, "pz.t.ballsRange", "{a}-{b} balls"], [/(\d+) balls/g, "pz.t.balls", "{a} balls"], [/(\d+) regions\b/g, "pz.t.regions", "{a} regions"],
    [/(\d+) colours/g, "pz.t.colours", "{a} colours"], [/(\d+) points/g, "pz.t.points", "{a} points"], [/(\d+)% mines/g, "pz.t.minesPct", "{a}% mines"],
    [/(\d+) mines/g, "pz.t.mines", "{a} mines"], [/Order (\d+)/g, "pz.t.order", "Order {a}"], [/regions of size (\d+)/g, "pz.t.regionSize", "regions of size {a}"],
    [/rotating (\d+x\d+) blocks/g, "pz.t.rotating", "rotating {a} blocks"], [/\b(\d+) Jigsaw/g, "pz.t.jigsaw", "{a} Jigsaw"]];
  var PHRASES = ["Squares wrapping", "Honeycomb wrapping", "Triangular wrapping", "Penrose Kite/Dart", "Penrose Rhombs", "Penrose (kite/dart)", "Penrose (rhombs)",
    "Great-Great-Dodecagonal", "Great-Dodecagonal", "Compass-Dodecagonal", "Great Hexagonal", "Great-Hexagonal", "Snub-Square", "Dodecagonal", "Octagonal", "Triangular",
    "Honeycomb", "Squares", "Kagome", "Floret", "Cairo", "Kites", "Hats", "Spectres", "Tetrahedron", "Octahedron", "Icosahedron", "Cube", "Octagon", "Crosses", "Cross",
    "Random", "identity hidden", "multiplication only", "strip clues", "rows only", "free ends", "orientable", "Killer", "Adjacent", "Super", "Size",
    "trivial", "easy", "tricky", "normal", "hard", "extreme", "unreasonable", "basic", "advanced", "medium", "intermediate", "standard", "wrapping"];
  var PHRASE_RX = new RegExp("(^|[^A-Za-z])(" + PHRASES.slice().sort(function (a, b) { return b.length - a.length; }).map(function (w) { return w.replace(/[.*+?^${}()|[\]\\\/]/g, "\\$&"); }).join("|") + ")(?![A-Za-z])", "gi");
  function typeLabel(text) {
    if (text === "Custom...") return T("pz.customSize", "Custom");
    TEMPLATES.forEach(function (t) {
      text = text.replace(t[0], function (m, a, b) { return T(t[1], t[2], { a: num(a), b: num(b) }); });
    });
    return text.replace(PHRASE_RX, function (m, pre, w) { return pre + (phrase(w) || w); });
  }
  // The frontend's own dialogs (a custom size, a game ID, a preferences form) are plain DOM: put the words in the language.
  function localizeDialog(form) {
    var title = form.querySelector("h2"), m = title && /^(.*) (configuration|game selection|random selection)$/.exec(title.textContent);
    if (m) title.textContent = T(m[2] === "configuration" ? "pz.d.title.config" : m[2] === "game selection" ? "pz.d.title.specific" : "pz.d.title.random", m[0], { name: m[1] });
    var walker = d.createTreeWalker(form, NodeFilter.SHOW_TEXT), node, nodes = [];
    while ((node = walker.nextNode())) nodes.push(node);
    nodes.forEach(function (n) {
      var raw = n.nodeValue, t = raw.trim();
      if (t && n.parentNode !== title) n.nodeValue = raw.replace(t, xl(t));
    });
    // OK and Cancel are the sheet's actions: Cancel, then OK in amber.
    var ok = form.querySelector('input[value="OK"]'), cancel = form.querySelector('input[value="Cancel"]');
    if (ok && cancel) {
      var row = el("div", "ar-sheet-actions pz-dlg-actions");
      ok.value = T("pz.d.ok", "OK");
      cancel.value = T("shell.cancel", "Cancel");
      ok.classList.add("ar-btn");
      cancel.classList.add("ar-btn");
      ok.classList.add("gs-primary");
      row.appendChild(cancel);
      row.appendChild(ok);
      form.appendChild(row);
    }
  }
  function watchDialogs() {
    if (!root.MutationObserver) return;
    new MutationObserver(function (list) {
      list.forEach(function (r) {
        Array.prototype.forEach.call(r.addedNodes, function (n) { if (n.id === "dlgform") localizeDialog(n); });
      });
    }).observe(d.body, { childList: true });
  }

  // ── Menu > New game: Type, then the Game rows ───────────────────────────
  function currentPreset() {
    var c = $("gametype") && $("gametype").querySelector('input[name="preset"]:checked');
    return c ? c.value : null;
  }
  // The English name of the type in play (its radio's label), which is the key best times are kept under; null for a custom size.
  function currentTypeName() {
    var c = $("gametype") && $("gametype").querySelector('input[name="preset"]:checked'), l = c && c.closest("label");
    var t = l ? l.textContent.replace(/\s+/g, " ").trim() : "";
    return t && t !== "Custom..." ? t : null;
  }
  // Every type the puzzle lists, in order: its radio's value and its English name ("More..." holds the rest in a list of its own).
  function typeEntries(list, out) {
    Array.prototype.forEach.call(list.children, function (li) {
      var label = li.firstElementChild, sub = li.querySelector(":scope > div > ul, :scope > label > ul, :scope > ul");
      var radio = li.querySelector(":scope > label > input.tick");
      if (radio) out.push({ value: radio.value, name: label ? label.textContent.replace(/\s+/g, " ").trim() : "" });
      else if (sub) typeEntries(sub, out);
    });
    return out;
  }
  // A puzzle whose types are a grid shape, a size and a difficulty (Loopy has 23, Mines 40) is asked as those, a short choice each.
  // A spec reads a type's name as its parts, in the order they are asked, and names what each part is (a string id and its English).
  var SIZE_HEAD = ["pz.d.size", "Size"], LEVEL_HEAD = ["pz.d.difficulty", "Difficulty"], FACET_MIN = 9, SELECT_MIN = 7;
  var SOLO_LEVEL = /^(.+?) (Trivial|Basic|Intermediate|Advanced|Extreme|Unreasonable|Killer)( X)?$/;
  var FACETS = {
    loopy: { heads: [["pz.shape", "Grid shape"], SIZE_HEAD, LEVEL_HEAD], parse: function (n) { var m = /^(\S+) (.+?) - (\S+)$/.exec(n); return m && [m[2], m[1], m[3]]; } },
    mines: { heads: [["pz.shape", "Grid shape"], SIZE_HEAD, ["mines.mines", "Mines"]], parse: function (n) { var m = /^(\d+x\d+), (\d+%? mines), (.+)$/.exec(n); return m && [m[3], m[1], m[2]]; } },
    dominosa: { heads: [SIZE_HEAD, LEVEL_HEAD], parse: function (n) { var m = /^(Order \d+), (.+)$/.exec(n); return m && [m[1], m[2]]; } },
    unequal: { heads: [["pz.type", "Type"], SIZE_HEAD, LEVEL_HEAD], parse: function (n) { var m = /^(Unequal|Adjacent): (\d+x\d+) (.+)$/.exec(n); return m && [m[1], m[2], m[3]]; } },
    solo: { heads: [SIZE_HEAD, LEVEL_HEAD], parse: function (n) { var m = SOLO_LEVEL.exec(n); return m && [m[1], m[2] + (m[3] || "")]; } }
  };
  var SIZE_AND_LEVEL = { heads: [SIZE_HEAD, LEVEL_HEAD], parse: function (n) { var m = /^(\d+ ?x ?\d+),? (.+)$/.exec(n); return m && [m[1], m[2]]; } };
  // The facets for these types, or null: the puzzle has too few types to need them, or one of them does not read as the parts.
  function facetsFor(entries) {
    var spec = FACETS[NAME] || SIZE_AND_LEVEL, rows = entries.filter(function (e) { return e.name !== "Custom..."; });
    if (rows.length < FACET_MIN) return null;
    for (var i = 0; i < rows.length; i++) {
      rows[i].parts = spec.parse(rows[i].name);
      if (!rows[i].parts) return null;
    }
    return { heads: spec.heads, rows: rows };
  }
  // The New game pane's rows are every game's option rows (boardui.js row and field): the label, then the choices joined in one
  // control (wrapped as separate buttons past three), or a select under its label.
  var CHOICES_JOINED = 3, JOINED_CHARS = 16;   // more choices than this, or longer words, wrap as separate buttons
  function seatRow(head) {
    var seg = el("div", "gs-seg"), row = el("div", "gs-row", "");
    seg.setAttribute("role", "group");
    if (head[0]) word(seg, head[0], head[1], "aria-label");
    row.appendChild(head[0] ? word(el("label"), head[0], head[1]) : el("label", "", xl(head[1])));
    row.appendChild(seg);
    return { row: row, seg: seg };
  }
  // choices [[value, text]]; isOn(value) says which is chosen; the buttons are rebuilt each time.
  function fillChoices(seg, choices, isOn, onPick) {
    seg.textContent = "";
    seg.classList.toggle("is-wrap", choices.length > CHOICES_JOINED || choices.reduce(function (n, c) { return n + c[1].length; }, 0) > JOINED_CHARS);
    choices.forEach(function (c) {
      var b = el("button", "ar-btn", c[1]);
      b.type = "button";
      b.setAttribute("aria-pressed", String(isOn(c[0])));
      b.addEventListener("click", function () { onPick(c[0]); });
      seg.appendChild(b);
    });
  }
  var fieldCount = 0;
  function fieldRow(label, control) {
    var row = el("div", "gs-row gs-field"), l = el("label", "", label);
    control.id = control.id || "pz-f" + (++fieldCount);
    l.htmlFor = control.id;
    row.appendChild(l);
    row.appendChild(control);
    return row;
  }
  function selectOf(options, value, onPick) {
    var sel = el("select", "gs-select");
    options.forEach(function (o) { var n = el("option", "", o[1]); n.value = o[0]; sel.appendChild(n); });
    sel.value = value;
    if (onPick) sel.addEventListener("change", function () { onPick(sel.value); });
    return sel;
  }

  // The custom size is the puzzle's own configuration dialog. It is read once where nobody sees it (opened, read, cancelled: the
  // chosen type comes back), shown as fields in the pane, and when Start is pressed opened again, set, and OK pressed.
  function withCustom(entry, fn, apply) {
    var radio = $("gametype") && $("gametype").querySelector('input[name="preset"][value="' + entry.value + '"]'), html = d.documentElement, result = null;
    if (!radio) return null;
    html.classList.add("zf-quiet");
    try {
      radio.click();
      var form = $("dlgform");
      if (form) {
        result = fn(form);
        var button = form.querySelector('input[value="' + (apply ? "OK" : "Cancel") + '"]') || form.querySelector('input[value="Cancel"]');
        if (button) button.click();
      }
    } finally { html.classList.remove("zf-quiet"); }
    return result;
  }
  // [{ index (of the form's labels), label (English), kind: text | select | bool, value, options [{ value, text }] }]
  function customFields(form) {
    var fields = [];
    Array.prototype.forEach.call(form.querySelectorAll("label"), function (l, index) {
      var box = l.querySelector('input[type="checkbox"]'), sel = l.querySelector("select"), txt = l.querySelector('input[type="text"]');
      var text = Array.prototype.map.call(l.childNodes, function (n) { return n.nodeType === 3 ? n.nodeValue : ""; }).join("").trim();
      var ctl = box || sel || txt;
      if (!text || !ctl) return;
      fields.push({ index: index, label: text, kind: box ? "bool" : sel ? "select" : "text", value: box ? box.checked : ctl.value,
        options: sel ? Array.prototype.map.call(sel.options, function (o) { return { value: o.value, text: o.text }; }) : null });
    });
    return fields;
  }
  function inlineField(f) {
    if (f.kind === "bool") {
      var on = !!f.value, row = seatRow([null, f.label]);
      var paint = function () { fillChoices(row.seg, [[false, T("shell.off", "Off")], [true, T("shell.on", "On")]], function (v) { return v === on; }, function (v) { on = v; paint(); }); };
      paint();
      f.get = function () { return on; };
      return row.row;
    }
    var control;
    if (f.kind === "select") control = selectOf(f.options.map(function (o) { return [o.value, xl(o.text)]; }), f.value);
    else { control = el("input"); control.type = "text"; control.value = f.value; control.setAttribute("inputmode", /^\d*$/.test(f.value) ? "numeric" : "text"); control.autocomplete = "off"; }
    f.get = function () { return control.value; };
    var row = fieldRow(xl(f.label), control);
    if (f.kind === "text") row.classList.add("pz-short");   // a width and a height stand side by side
    return row;
  }
  // `bind(fields)` says which fields the pane already asks as rows of its own: { fieldIndex: whatever chooses it }; `valueOf(that)`
  // is the English text chosen there. The rest are shown here, and only while the custom size is the choice.
  function customPanel(entry, bind, valueOf) {
    var node = el("div", "pz-custom"), fields = null, bound = {};
    node.hidden = true;
    return {
      node: node,
      show: function () {
        if (!fields) {
          fields = withCustom(entry, customFields, false) || [];
          bound = bind ? bind(fields) : {};
          fields.forEach(function (f) { if (bound[f.index] === undefined) node.appendChild(inlineField(f)); });
        }
        node.hidden = false;
        return bound;
      },
      hide: function () { node.hidden = true; },
      // A field's own choices, in its dialog's words: a custom size can ask what no preset has (Unequal's Recursive).
      choices: function (index) {
        var f = fields.filter(function (x) { return x.index === index; })[0];
        return f && f.options ? f.options.map(function (o) { return o.text; }) : [];
      },
      // The text the dialog holds now for a field (what the game in play was made with).
      current: function (index) {
        var f = fields.filter(function (x) { return x.index === index; })[0], o = f && f.options && f.options.filter(function (n) { return n.value === f.value; })[0];
        return o ? o.text : null;
      },
      apply: function () {
        withCustom(entry, function (form) {
          var labels = form.querySelectorAll("label");
          fields.forEach(function (f) {
            var l = labels[f.index], ctl = l && (l.querySelector("select") || l.querySelector('input[type="checkbox"]') || l.querySelector('input[type="text"]'));
            if (!ctl) return;
            if (bound[f.index] !== undefined) {
              var want = String(valueOf(bound[f.index])).toLowerCase();
              Array.prototype.forEach.call(ctl.options, function (o) { if (o.text.toLowerCase() === want) ctl.value = o.value; });
            } else if (f.kind === "bool") ctl.checked = !!f.get(); else ctl.value = f.get();
          });
        }, true);
      }
    };
  }

  function typeFacetRows(facets, entries, into) {
    var rows = facets.rows, heads = facets.heads, custom = entries.filter(function (e) { return e.name === "Custom..."; })[0];
    var current = staged || currentPreset(), onCustom = !!custom && custom.value === current, boxes = [], panel = null;
    var chosen = (rows.filter(function (r) { return r.value === current; })[0] || rows[0]).parts.slice();
    var sizeAt = Math.max(0, heads.map(function (h) { return h[0]; }).indexOf(SIZE_HEAD[0])), bound = {};
    if (sizeAt === 0 && heads.length > 1 && options(0).length >= SELECT_MIN) sizeAt = 1;   // the first part is a select: the custom size goes with the buttons
    function matching(i) { return rows.filter(function (r) { return chosen.slice(0, i).every(function (p, k) { return r.parts[k] === p; }); }); }
    function options(i) {
      return matching(i).reduce(function (all, r) { if (all.indexOf(r.parts[i]) < 0) all.push(r.parts[i]); return all; }, []);
    }
    // The field of the custom size's dialog that asks part i, if any.
    function boundTo(i) { return Object.keys(bound).filter(function (k) { return bound[k] === i; })[0]; }
    // What row i offers: the presets' values, or while the custom size is the choice, its dialog's own for that part.
    function rowOptions(i) { var k = boundTo(i); return onCustom && panel && k !== undefined ? panel.choices(+k) : options(i); }
    function pick(i, value) {
      chosen[i] = value;
      if (onCustom && i !== sizeAt) { render(); return; }   // the shape and the difficulty are the custom size's too: it stays the choice
      for (var j = 0; j < heads.length; j++) { var opts = options(j); if (j !== i && opts.indexOf(chosen[j]) < 0) chosen[j] = opts[0]; }
      staged = matching(heads.length)[0].value;
      customOn(false);
    }
    // Only the parts the custom size's own dialog also asks as a list (the grid shape, the difficulty) stay while it is the choice;
    // the size is its width and height, shown under the sizes.
    function bindParts(fields) {
      var map = {};
      heads.forEach(function (h, i) {
        var all = rows.reduce(function (a, r) { if (a.indexOf(r.parts[i]) < 0) a.push(r.parts[i]); return a; }, []);
        fields.forEach(function (f) {
          if (f.kind !== "select" || map[f.index] !== undefined || i === sizeAt) return;
          var texts = f.options.map(function (o) { return o.text.toLowerCase(); });
          if (all.every(function (v) { return texts.indexOf(v.toLowerCase()) >= 0; })) map[f.index] = i;
        });
      });
      return map;
    }
    function customOn(on) {
      onCustom = on;
      if (panel) { if (on) bound = panel.show(); else panel.hide(); customPick = on ? panel : null; }
      render();
    }
    function render() {
      boxes.forEach(function (box, i) {
        var opts = rowOptions(i), keeps = !onCustom || i === sizeAt || boundTo(i) !== undefined;
        box.group.hidden = !keeps || (opts.length < 2 && !(custom && i === sizeAt));
        var choices = opts.map(function (v) { return [v, typeLabel(v)]; });
        if (box.select) {
          if (box.select.options.length !== choices.length || choices.some(function (c, k) { return box.select.options[k].value !== c[0]; })) {
            box.select.textContent = "";
            choices.forEach(function (c) { var n = el("option", "", c[1]); n.value = c[0]; box.select.appendChild(n); });
          }
          box.select.value = chosen[i];
          return;
        }
        if (custom && i === sizeAt) choices.push([CUSTOM_CHOICE, typeLabel("Custom...")]);
        fillChoices(box.chips, choices, function (v) { return v === CUSTOM_CHOICE ? onCustom : (!onCustom || i !== sizeAt) && v === chosen[i]; },
          function (v) { if (v === CUSTOM_CHOICE) customOn(true); else pick(i, v); });
      });
    }
    heads.forEach(function (h, i) {
      var box = {}, opts = options(i);
      if (i === 0 && opts.length >= SELECT_MIN) {
        box.select = selectOf(opts.map(function (v) { return [v, typeLabel(v)]; }), chosen[i], function (v) { pick(i, v); });
        word(box.select, h[0], h[1], "aria-label");
        box.group = fieldRow("", box.select);
        word(box.group.firstChild, h[0], h[1]);
      } else {
        var r = seatRow(h);
        box.group = r.row; box.chips = r.seg;
      }
      boxes.push(box);
      into.appendChild(box.group);
      if (custom && i === sizeAt) {
        panel = customPanel(custom, bindParts, function (k) { return chosen[k]; });
        into.appendChild(panel.node);
      }
    });
    if (onCustom && panel) {   // a custom game is in play: its shape and difficulty are what the pane starts on
      bound = panel.show(); customPick = panel;
      heads.forEach(function (h, j) {
        var k = boundTo(j), v = k !== undefined && panel.current(+k), opts = rowOptions(j);
        if (v && opts.indexOf(v) >= 0) chosen[j] = v; else if (opts.indexOf(chosen[j]) < 0) chosen[j] = opts[0];
      });
    }
    render();
  }
  var CUSTOM_CHOICE = "\0custom";
  function typeRows(entries, into) {
    var facets = facetsFor(entries);
    if (facets) { typeFacetRows(facets, entries, into); return; }
    var custom = entries.filter(function (e) { return e.name === "Custom..."; })[0], panel = custom && customPanel(custom);
    var row = seatRow(["pz.type", "Type"]), on = staged || currentPreset();
    function paint() {
      fillChoices(row.seg, entries.map(function (e) { return [e.value, typeLabel(e.name)]; }), function (v) { return v === on; }, function (v) {
        on = staged = v;
        if (panel) { if (custom && v === custom.value) { panel.show(); customPick = panel; } else { panel.hide(); customPick = null; } }
        paint();
      });
    }
    into.appendChild(row.row);
    if (panel) into.appendChild(panel.node);
    paint();
    if (panel && custom.value === on) { panel.show(); customPick = panel; }
  }
  // A game's id and seed, and saving to a file, are for people who share or reproduce a game: behind one fold.
  function advancedRows() {
    var rows = [["specific", "Enter game ID…"], ["random", "Enter random seed…"], ["save", "Download save file…"], ["load", "Upload save file…"]];   // pz.<id> in the string table
    var fold = el("details", "pz-advanced");
    try { fold.open = root.localStorage.getItem(ADVANCED_OPEN_KEY) === "1"; } catch (e) { /* no storage: closed */ }
    fold.addEventListener("toggle", function () { try { root.localStorage.setItem(ADVANCED_OPEN_KEY, fold.open ? "1" : "0"); } catch (e) { /* kept for this visit only */ } });
    fold.appendChild(word(el("summary", "pz-opt-head"), "pz.advanced", "Advanced"));
    var box = el("div", "pz-game-rows");
    rows.forEach(function (r) {
      var orig = $(r[0]);
      if (!orig) return;
      var b = word(el("button", "ar-btn pz-opt"), "pz." + r[0], r[1]);
      b.type = "button";
      b.addEventListener("click", function () { if (root.ZimiShell) root.ZimiShell.closeMenu(); orig.click(); });
      box.appendChild(b);
    });
    if (!box.children.length) return null;
    fold.appendChild(box);
    return fold;
  }
  function newGameOptions() {
    var nodes = [], types = $("gametype");
    staged = null; customPick = null;
    if (types && types.children.length) {
      var box = el("div", "pz-types");
      box.setAttribute("role", "group");
      word(box, "pz.type", "Type", "aria-label");
      typeRows(typeEntries(types, []), box);
      nodes.push(box);
    }
    var fold = advancedRows();
    if (fold) nodes.push(fold);
    return { options: nodes };
  }

  // ── Menu > Settings: the puzzle's own preferences ───────────────────────
  // The frontend builds its preferences form (checkboxes and drop-downs) from the C side. We open it where nobody sees it, read it
  // into rows, and close it; a change opens it again, sets the one control, and presses OK, so the puzzle's own code applies and
  // keeps it. The keyboard-shortcut switch is for a keyboard with no Ctrl key and means nothing on a phone: it is left out.
  var HIDDEN_PREFS = { "Keyboard shortcuts without Ctrl": 1 };
  function withDialog(buttonId, fn) {
    var button = $(buttonId), result = null;
    if (!button) return null;
    var html = d.documentElement;
    html.classList.add("zf-quiet");
    try {
      button.click();
      var form = $("dlgform");
      if (form) {
        result = fn(form);
        var action = form.querySelector('input[value="' + (result && result.apply ? "OK" : "Cancel") + '"]') || form.querySelector('input[value="Cancel"]');
        if (action) action.click();
      }
    } finally { html.classList.remove("zf-quiet"); }
    return result;
  }
  // [{ label (English), control, options [{ value, text }] or null for a checkbox }] in the form's order.
  function prefRows(form) {
    var rows = [];
    Array.prototype.forEach.call(form.querySelectorAll("label"), function (l, index) {
      var box = l.querySelector('input[type="checkbox"]'), sel = l.querySelector("select");
      var text = Array.prototype.map.call(l.childNodes, function (n) { return n.nodeType === 3 ? n.nodeValue : ""; }).join("").trim();
      if (!text || HIDDEN_PREFS[text] || !(box || sel)) return;
      rows.push({ index: index, label: text, bool: !!box, value: box ? box.checked : sel.value,
        options: sel ? Array.prototype.map.call(sel.options, function (o) { return { value: o.value, text: o.text }; }) : null });
    });
    return rows;
  }
  function setPref(index, value) {
    withDialog("prefs", function (form) {
      var l = form.querySelectorAll("label")[index], box = l && l.querySelector('input[type="checkbox"]'), sel = l && l.querySelector("select");
      if (box) box.checked = !!value; else if (sel) sel.value = value;
      return { apply: true };
    });
  }
  function prefsSettings() {
    var rows = withDialog("prefs", prefRows);
    if (!rows || !rows.length) return [];
    var nodes = [word(el("h3", "pz-opt-head"), "pz.prefsHead", "This puzzle")];
    rows.forEach(function (r) {
      var choices = r.bool ? [[false, T("shell.off", "Off")], [true, T("shell.on", "On")]] : r.options.map(function (o) { return [o.value, xl(o.text)]; });
      var seg = el("div", "gs-seg");
      seg.setAttribute("role", "group");
      if (choices.length > 3 || choices.some(function (c) { return c[1].length > 16; })) seg.classList.add("pz-stack");
      var label = el("label", "", xl(r.label));
      choices.forEach(function (c) {
        var b = el("button", "ar-btn", c[1]);
        b.type = "button";
        b.setAttribute("aria-pressed", String(c[0] === r.value));
        b.addEventListener("click", function () {
          setPref(r.index, c[0]);
          Array.prototype.forEach.call(seg.children, function (o) { o.setAttribute("aria-pressed", String(o === b)); });
        });
        seg.appendChild(b);
      });
      var row = el("div", "gs-row");
      row.appendChild(label);
      row.appendChild(seg);
      nodes.push(row);
    });
    return nodes;
  }

  // ── the status line ──────────────────────────────────────────────────────
  // The frontend writes "Moves: 12" and such into #statusbar. We keep that element (the frontend needs it), hide it,
  // and show one sentence of what a player needs in the shared status style.
  // Each line the frontends write, in the player's language. The number-bearing ones are matched by their English shape.
  var STATUS = [
    [/\bMoves(?: since auto-solve)?: \d+\s*/g, function () { return ""; }],
    [/^COMPLETED!\s*/i, function () { return T("pz.solved", "Solved") + ". "; }],
    [/\bAuto-solve[dr]( used)?\.?/i, function () { return T("pz.solutionShown", "Solution shown") + "."; }],
    [/^\[(\d+:\d\d)\]\s*/, function (m, clock) { return clock + " · "; }],
    [/\bBalls marked: (\d+) \/ (\d+)-(\d+)\.?/, function (m, a, lo, hi) { return T("pz.ballsRange", "Balls marked: {a} of {lo} to {hi}", { a: num(a), lo: num(lo), hi: num(hi) }); }],
    [/\bBalls marked: (\d+) \/ (\d+)/, function (m, a, b) { return T("pz.balls", "Balls marked: {a} of {b}", { a: num(a), b: num(b) }); }],
    [/\bMarked: (\d+) \/ (\d+)/, function (m, a, b) { return T("pz.marked", "Marked: {a} of {b}", { a: num(a), b: num(b) }); }],
    [/\bActive: (\d+)\/(\d+)/, function (m, a, b) { return T("pz.active", "Active: {a} of {b}", { a: num(a), b: num(b) }); }],
    [/(\d+) \/ (\d+) moves/, function (m, a, b) { return T("pz.movesOf", "Moves: {a} of {b}", { a: num(a), b: num(b) }); }],
    [/\bGems: (\d+)/, function (m, n) { return T("pz.gems", "Gems: {n}", { n: num(n) }); }],
    [/\bDeaths: (\d+)/, function (m, n) { return T("pz.deaths", "Deaths: {n}", { n: num(n) }); }],
    [/\bDEAD!/, function () { return T("pz.dead", "Dead"); }],
    [/\bScore: (\d+)/, function (m, n) { return T("pz.score", "Score: {n}", { n: num(n) }); }],
    [/\bSelected: (\d+) \((\d+)\)/, function (m, a, b) { return T("pz.selected", "Selected: {a} ({b})", { a: num(a), b: num(b) }); }],
    [/\bWrong! Guess again\.?/, function () { return T("pz.wrong", "Wrong. Guess again"); }],
    [/\bCORRECT!/, function () { return T("pz.correct", "Correct"); }],
    [/ \((\d+) errors?\)/, function (m, n) { return " (" + T("pz.errors", "Errors: {n}", { n: num(n) }) + ")"; }],
    [/(\d+) wrong and (\d+) missed balls\.?/, function (m, a, b) { return T("pz.wrongMissed", "Wrong: {a}, missed: {b}", { a: num(a), b: num(b) }); }]
  ];
  function sayStatus(text) {
    STATUS.forEach(function (s) { text = text.replace(s[0], s[1]); });
    return text.replace(/\s+/g, " ").trim();
  }
  // ── a win, the clock and the best times ─────────────────────────────────
  // Solved yourself is a win with a sheet. A game that comes back solved, one the solver finished and one that was solved by
  // Show solution are not. Most puzzles say COMPLETED! in their status bar; the ones with no status bar (the frontend removes
  // it) only flash, so the flash is the signal there: a timer that runs past FLASH_MIN_S just after the player's own input.
  var FLASH_MIN_S = 0.2;       // the longest a move's own animation runs; a completion's flash runs longer
  var FLASH_MIN_OVERRIDE = { dominosa: 0.1 };   // Dominosa's flash is 0.13 s and its moves never animate
  var BURST_GAP_MS = 100;      // frames this far apart are different animations
  var INPUT_TO_FLASH_MS = 250; // a flash starts this soon after the move that completed the game
  var solved = false, elapsed = 0, ticked = 0, lastInput = 0;
  function readBest() { try { return JSON.parse(root.localStorage.getItem(BEST_KEY)) || {}; } catch (e) { return {}; } }
  function writeBest(all) { try { root.localStorage.setItem(BEST_KEY, JSON.stringify(all)); } catch (e) { /* not kept */ } }
  function clockText(ms) {
    var sec = Math.round(ms / 1000), m = Math.floor(sec / 60), r = sec % 60;
    return num(m) + ":" + (r < 10 ? "0" : "") + num(r);
  }
  // Records a win under the type's name; returns [time, best] chips (no record for a custom size, which has no name).
  function recordWin() {
    var type = currentTypeName(), chips = [[T("play.time", "Time"), clockText(elapsed)]];
    if (!type) return chips;
    var all = readBest(), mine = all[NAME] = all[NAME] || {}, row = mine[type] = mine[type] || { won: 0, best: 0 };
    var better = !row.best || elapsed < row.best;
    row.won += 1;
    if (better) row.best = elapsed;
    writeBest(all);
    chips.push(better && row.won > 1 ? [T("pz.newBest", "New best"), clockText(row.best)] : [T("pz.bestLabel", "Best"), clockText(row.best)]);
    return chips;
  }
  function puzzleStats() {
    var mine = readBest()[NAME] || {};
    return Object.keys(mine).sort().map(function (type) {
      return [typeLabel(type), T("pz.statLine", "Best {t} · Solved {n}", { t: clockText(mine[type].best), n: num(mine[type].won) })];
    });
  }
  // The save text lists the moves up to the place in the history; Show solution is one of them (a SOLVE line). Undone, it no longer counts.
  function solverUsed() {
    var text = saveText() || "", place = /^STATEPOS:\d+:(\d+)/m.exec(text), applied = place ? +place[1] - 1 : 0, kinds = [];
    text.replace(/^(MOVE|SOLVE)\s*:\d+:/gm, function (m, kind) { kinds.push(kind); return m; });
    return kinds.slice(0, applied).indexOf("SOLVE") >= 0;
  }
  // Pattern flashes for no time at all, so its completion is read from the save text: every row and column of filled squares
  // runs as the clues say (the clues are the game's DESC, columns first; the moves are F, E and U over a box x,y,w,h).
  function patternSolved(text) {
    var par = /^PARAMS\s*:\d+:(\d+)x(\d+)/m.exec(text), desc = /^DESC\s*:\d+:(.*)$/m.exec(text), place = /^STATEPOS:\d+:(\d+)/m.exec(text);
    if (!par || !desc || !place) return false;
    var w = +par[1], h = +par[2], clues = desc[1].split("/"), grid = [], x, y, moves = [];
    for (y = 0; y < h; y++) grid.push(new Array(w).fill(0));
    text.replace(/^MOVE\s*:\d+:(.*)$/gm, function (m, mv) { moves.push(mv); return m; });
    moves.slice(0, +place[1] - 1).forEach(function (mv) {
      var m = /^([FEU])(\d+),(\d+),(\d+),(\d+)/.exec(mv);
      if (!m) return;
      for (y = +m[3]; y < +m[3] + +m[5]; y++) for (x = +m[2]; x < +m[2] + +m[4]; x++) if (grid[y] && x < w) grid[y][x] = m[1] === "F" ? 1 : 0;
    });
    function runs(line) { var out = [], n = 0; line.concat([0]).forEach(function (v) { if (v) n++; else if (n) { out.push(n); n = 0; } }); return out.length ? out : [0]; }
    function says(i, line) { return clues[i] === runs(line).join("."); }
    for (x = 0; x < w; x++) if (!says(x, grid.map(function (row) { return row[x]; }))) return false;
    for (y = 0; y < h; y++) if (!says(w + y, grid[y])) return false;
    return true;
  }
  var FLASHLESS = { pattern: patternSolved };   // puzzles with no status bar and no flash worth timing: name -> does this save text say it is solved
  function watchFlashless(canvas) {
    var judge = FLASHLESS[NAME], pending = 0;
    if (!judge) return;
    ["pointerup", "keyup", "mouseup"].forEach(function (t) {
      canvas.addEventListener(t, function () {
        root.clearTimeout(pending);
        pending = root.setTimeout(function () { var text = saveText(); if (text && !solved && judge(text)) declareWin(); }, READY_POLL_MS);
      }, true);
    });
  }
  var freshLoad = true;      // the game that is there when the page opens (or comes back from a save) is not a win
  function declareWin() {
    if (solved) return;
    solved = true;
    if (!freshLoad && !solverUsed() && root.ZimiShell) root.ZimiShell.endSheet({ result: "win", after: SOLVED_SHEET_MS, stats: recordWin() });
  }
  // The solving clock: counts while a game is under way, the page is showing and the Menu is shut. A new game, or taking every move
  // back, starts it over.
  var held = false;
  function tickClock() {
    var now = Date.now(), under = canMove("undo") || canMove("redo");
    if (under && !solved && !held && d.visibilityState !== "hidden") elapsed += Math.min(now - ticked, 2 * CLOCK_TICK_MS);
    if (!under) { if (solved) newGameStarted(); elapsed = 0; }
    ticked = now;
  }
  function newGameStarted() { solved = false; elapsed = 0; }
  // The frontend calls timer_callback each frame with the seconds since the last one; a burst of calls is one animation or flash.
  function watchFlash() {
    var orig = root.timer_callback, burst = null, idle = 0;
    if (typeof orig !== "function") return;
    root.timer_callback = function (dt) {
      var now = Date.now();
      if (!burst || now - burst.last > BURST_GAP_MS) burst = { afterInput: now - lastInput < INPUT_TO_FLASH_MS, ran: 0, last: now };
      burst.ran += dt;
      burst.last = now;
      root.clearTimeout(idle);
      idle = root.setTimeout(function () {
        var b = burst; burst = null;
        if (b && b.afterInput && b.ran >= (FLASH_MIN_OVERRIDE[NAME] || FLASH_MIN_S) && !$("statusbar") && canMove("undo")) declareWin();
      }, BURST_GAP_MS);
      return orig.apply(this, arguments);
    };
  }
  function watchInput(canvas) {
    ["pointerup", "keydown", "mouseup"].forEach(function (t) { canvas.addEventListener(t, function () { lastInput = Date.now(); freshLoad = false; }, true); });
  }
  function watchStatus(frame) {
    var bar = $("statusbar");
    if (!bar) return;
    var line = el("div", "pz-status");
    line.setAttribute("role", "status");
    line.setAttribute("aria-live", "polite");
    frame.parentNode.insertBefore(line, frame.nextSibling);
    function sync() {
      var raw = bar.textContent, t = sayStatus(raw);
      if (/^(\[\d+:\d\d\]\s*)?COMPLETED!/i.test(raw)) declareWin(); else if (solved && !/COMPLETED!/i.test(raw)) { solved = false; }
      if (line.textContent !== t) line.textContent = t;
      line.hidden = !t;
    }
    sync();
    if (root.MutationObserver) new MutationObserver(sync).observe(bar, { childList: true, characterData: true, subtree: true });
  }

  // ── touch is the mouse ───────────────────────────────────────────────────
  // The frontend speaks mouse. A finger sends its mouse events only once it lifts, never while it drags, and it has no right
  // button; so a touch or pen press is translated here and the browser's own mouse events for it are dropped. A tap is a left
  // click; a finger that moves is a left drag; a finger held still for LONG_PRESS_MS is a right press (the frontend reads
  // ctrl as the right button), and if it then moves, a right drag. The left press is only sent once we know which it is.
  var markOn = false;      // the Mark toggle: a tap is a right press (a pencil mark, a flag, the other way round)
  function touchIsMouse(canvas) {
    var press = null, quietUntil = 0;
    function mouse(type, e, ctrl, shift) {
      var ev = new MouseEvent(type, { bubbles: true, cancelable: true, view: root, button: 0, buttons: type === "mouseup" ? 0 : 1,
        clientX: e.x, clientY: e.y, screenX: e.sx, screenY: e.sy, ctrlKey: ctrl, shiftKey: !!shift });
      ev.zfTouch = true;
      canvas.dispatchEvent(ev);
    }
    function at(e) { return { x: e.clientX, y: e.clientY, sx: e.screenX, sy: e.screenY }; }
    function fire() {
      var p = press;
      if (!p || p.phase !== "wait") return;
      p.phase = "right";
      mouse("mousedown", p.start, true);
      if (navigator.vibrate) try { navigator.vibrate(10); } catch (err) { /* not allowed */ }
    }
    canvas.addEventListener("pointerdown", function (e) {
      if (e.pointerType === "mouse") return;
      quietUntil = Infinity;
      if (!e.isPrimary) {
        // A second finger while the first is still waiting: this may be a two-finger tap (the frontend reads shift as the middle button).
        if (press && press.phase === "wait") { root.clearTimeout(press.timer); press.phase = "two"; press.two = Date.now(); }
        return;
      }
      press = { id: e.pointerId, start: at(e), phase: "wait", timer: root.setTimeout(fire, LONG_PRESS_MS) };
    });
    canvas.addEventListener("pointermove", function (e) {
      var p = press;
      if (!p || (e.pointerId !== p.id && p.phase !== "two")) return;
      var here = at(e);
      if (p.phase === "two") { if (e.pointerId === p.id && Math.hypot(here.x - p.start.x, here.y - p.start.y) > LONG_PRESS_SLOP) press = null; return; }
      if (p.phase === "wait" && Math.hypot(here.x - p.start.x, here.y - p.start.y) > LONG_PRESS_SLOP) {
        root.clearTimeout(p.timer);
        p.phase = "left";
        mouse("mousedown", p.start, false);
      }
      if (p.phase !== "wait") mouse("mousemove", here, p.phase === "right");
    });
    function end(e, cancelled) {
      var p = press;
      if (e.pointerType === "mouse") return;
      quietUntil = Date.now() + NATIVE_QUIET_MS;
      if (!p || e.pointerId !== p.id) return;
      press = null;
      root.clearTimeout(p.timer);
      if (p.phase === "two") {
        if (!cancelled && Date.now() - p.two < TWO_FINGER_MS) { mouse("mousedown", p.start, false, true); mouse("mouseup", p.start, false, true); }
        return;
      }
      var here = at(e);
      if (p.phase === "wait") {
        if (cancelled) return;
        mouse("mousedown", p.start, markOn);
        mouse("mouseup", p.start, markOn);
      } else mouse("mouseup", here, p.phase === "right");
    }
    canvas.addEventListener("pointerup", function (e) { end(e, false); });
    canvas.addEventListener("pointercancel", function (e) { end(e, true); });
    ["mousedown", "mousemove", "mouseup", "click"].forEach(function (t) {
      canvas.addEventListener(t, function (ev) {
        if (!ev.zfTouch && ev.isTrusted && Date.now() < quietUntil) { ev.stopImmediatePropagation(); ev.preventDefault(); }
      }, true);
    });
    canvas.addEventListener("contextmenu", function (e) { e.preventDefault(); });
  }

  // ── digits ───────────────────────────────────────────────────────────────
  function sendKey(canvas, key) {
    var code = KEY_CODES[key] || key.toUpperCase().charCodeAt(0);
    var init = { key: key, keyCode: code, which: code, bubbles: true, cancelable: true };
    canvas.focus();
    canvas.dispatchEvent(new KeyboardEvent("keydown", init));
    canvas.dispatchEvent(new KeyboardEvent("keyup", init));
  }
  // The row under the board on touch: the digits for the puzzles that take them, and Mark (Pencil, where there are digits), which
  // makes the taps that follow right presses until it is pressed again. Neither is shown with a keyboard and a mouse.
  function touchRow(canvas, name, into) {
    var spec = KEYPAD[name], labels = spec ? (typeof spec === "number" ? "123456789".slice(0, spec).split("") : spec.split("")) : [];
    var keys = el("div", "zf-keys");
    keys.setAttribute("role", "group");
    word(keys, "pz.keypad", "Keypad", "aria-label");
    labels.concat(spec ? ["Backspace"] : []).forEach(function (k) {
      var b = el("button", "ar-btn", k === "Backspace" ? String.fromCharCode(0x232b) : k);
      b.type = "button";
      if (k === "Backspace") word(b, "pz.clear", "Clear", "aria-label"); else b.setAttribute("aria-label", k);
      b.onpointerdown = function (e) { e.preventDefault(); };
      b.onclick = function () { sendKey(canvas, k); };
      keys.appendChild(b);
    });
    if (!LEFT_ONLY[name]) {
      var mark = word(el("button", "ar-btn zf-mark"), spec ? "pz.pencil" : "pz.mark", spec ? "Pencil" : "Mark");
      mark.type = "button";
      mark.setAttribute("aria-pressed", "false");
      mark.onpointerdown = function (e) { e.preventDefault(); };
      mark.onclick = function () { markOn = !markOn; mark.setAttribute("aria-pressed", String(markOn)); };
      keys.appendChild(mark);
    }
    if (keys.children.length) into.appendChild(keys);
  }

  // ── never lose a game ────────────────────────────────────────────────────
  // The frontend can serialise the whole game (the same text Game > Download save file writes: parameters, the moves, the
  // place in the history). ZimiShell.persist keeps that text on leaving and after every move, and puts it back with the
  // frontend's own loader, so an opened puzzle is the one that was left, undo history and all.
  var encoder = root.TextEncoder ? new root.TextEncoder() : null;
  function saveText() {
    var cw = root.Module && root.Module.cwrap;
    if (!cw || typeof root.UTF8ToString !== "function") return null;
    var ptr = cw("get_save_file", "number", [])();
    var text = root.UTF8ToString(ptr);
    cw("free_save_file", "void", ["number"])(ptr);
    return text;
  }
  function loadText(text) {
    var bytes = encoder.encode(text), pos = 0;
    root.savefile_read_callback = function (buf, len) {
      if (pos + len > bytes.length) return false;
      root.writeArrayToMemory(new Int8Array(bytes.buffer, pos, len), buf);
      pos += len;
      return true;
    };
    try { root.Module.cwrap("load_game", "void", [])(); } finally { root.savefile_read_callback = null; }
  }
  function canMove(id) { var b = $(id); return !!b && !b.disabled; }
  function persistGame() {
    root.ZimiShell.persist({
      // A game that was only dealt is kept too, so the puzzle that comes back is the one that was left; a solved one is not.
      save: function () { return solved ? null : { sav: saveText(), t: elapsed }; },
      load: function (data) {
        // A link to one particular game (#id) is that game, not the one left behind; a daily's own save is the day's game.
        if (!data || typeof data.sav !== "string" || !encoder || (root.location.hash && !DAILY)) return false;
        loadText(data.sav);
        elapsed = +data.t || 0;
        return true;
      }
    });
  }
  function whenRunning(fn) {
    var timer = root.setInterval(function () {
      var shown = $("puzzle") && $("puzzle").style.display !== "none";
      if (typeof root.command !== "function" || !shown) return;
      root.clearInterval(timer);
      fn();
    }, READY_POLL_MS);
  }

  // ── start ────────────────────────────────────────────────────────────────
  function fitBox() {
    var frame = el("div", "gs-frame pz-frame");
    var box = el("div");
    box.id = "puzzlecanvascontain";
    var resizable = $("resizable");
    resizable.parentNode.insertBefore(frame, resizable);
    frame.appendChild(box);
    box.appendChild(resizable);
    return frame;
  }
  function start() {
    metaViewport();
    if (navigator.maxTouchPoints > 0 || root.matchMedia("(pointer: coarse)").matches) d.documentElement.classList.add("zf-touch");
    var canvas = $("puzzlecanvas");
    if (!canvas) return;
    buildBar();
    var frame = fitBox();
    watchStatus(frame);
    touchIsMouse(canvas);
    touchRow(canvas, NAME, frame.parentNode);
    watchInput(canvas);
    watchFlashless(canvas);
    watchDialogs();
    ticked = Date.now();
    root.setInterval(tickClock, CLOCK_TICK_MS);
    if (root.ZimiShell) {
      root.ZimiShell.game({
        // A game is under way once a move can be undone, until it is solved.
        inProgress: function () { var u = $("undo"); return !!u && !u.disabled && !solved; },
        menu: newGameOptions, settings: prefsSettings, stats: puzzleStats
      });
      if (root.ZimiShell.onHold) root.ZimiShell.onHold(function (on) { held = on; });
      whenRunning(function () { watchFlash(); persistGame(); d.documentElement.classList.add("zf-running"); });   // zf-running: the saved game, if any, is back
    }
  }
  start();
})();
