"""The Almanac staged as a folder, for ownzims to build into ``zimi_almanac.zim``.

The Almanac is Zimi's own pages (``static/almanac*.js`` and their data), and
they lean on the app shell in two ways: they call a few dozen of app.js's
top-level functions and variables (the Moon's renderer, the saved-settings
keys, the escaping helpers), and they fetch things by absolute ``/static/``
paths. A ZIM has no shell and no server root, so the stage:

1. copies the Almanac's files and data from ``static/`` (the same files Zimi
   serves, so the two never drift), with every absolute ``/static/`` path made
   relative to the ZIM's root;
2. pulls the app.js pieces the Almanac calls out BY NAME into ``shell.js``
   (``function name(`` to the line that is exactly ``}``, or a variable's
   declaration statement), so no refactor of app.js is needed;
3. adds ``index.html`` (``builtin/almanac/``): the page the Almanac draws into
   and the few stand-ins for what needs a Zimi server (strings, toasts, links
   into a library, satellites, tides).

A name app.js no longer has fails the build with that name: a half-built page
never ships. ``missing_dependencies`` is the test's check that the list is
complete.
"""

import gzip
import os
import re
import shutil

STATIC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
HOST = os.path.join(os.path.dirname(os.path.abspath(__file__)), "builtin", "almanac")

#: What the Almanac loads, in order (they share one global scope). app.js's
#: _ALMANAC_MODULES, then what it adds on open and on use.
SCRIPTS = (
    "almanac-links.js",
    "almanac-orrery.js",
    "almanac-sky.js",
    "almanac-skygl.js",
    "zone-places.js",
    "almanac-skyfacts.js",
    "almanac.js",
    "almanac-ephem.js",
    "almanac-earth.js",
)
#: Loaded later, on first use, by the Almanac itself (by relative URL).
LAZY = (
    "almanac-look.js",
    "almanac-skyfind.js",
    "almanac-tides.js",
    "almanac-tides.css",
    "almanac-reference.css",
    "almanac-reference.js",
    "almanac-navdata.js",
    "almanac-tables.js",
)
STYLES = ("almanac.css",)
#: Data and assets the pages fetch (files or whole folders under static/).
DATA = (
    os.path.join("i18n", "en.json"),
    "tz-borders.json",
    "world-map.svg",
    "earth",
    "rosetta",
    "golden-record",
    "temml",
    os.path.join("fonts", "DSEG14Classic-Bold.woff2"),
)

#: The app.js pieces the Almanac's code calls directly, pulled into shell.js
#: with everything they in turn use (``shell_names``). What the host page
#: defines itself (index.html) is never pulled.
SHELL_SEEDS = (
    "SK",
    "_copyText",
    "_sheetAboveKeyboard",
    "_MOON_ALBEDO_GAIN",
    "_MOON_ALBEDO_LIFT",
    "_MOON_DISPLAY_GAMMA",
    "_MOON_EQUATOR_TILT_DEG",
    "_MOON_LAT_TERMS",
    "_MOON_LON_TERMS",
    "_MOON_LUNAR_L",
    "_MOON_MAP_HI_URL",
    "_MOON_MAP_URL",
    "_MOON_PLAIN_GREY",
    "_MOON_ROUGH_MU",
    "_MOON_TINT_B",
    "_MOON_TINT_R",
    "_localMoonName",
    "_moonAnimDurMs",
    "_moonAnimPhaseAt",
    "_moonAnimViewAt",
    "_moonEarthshine",
    "_moonEcliptic",
    "_moonEqCoords",
    "_moonLimbAngles",
    "_moonLoadHiMap",
    "_moonPhase",
    "_moonSpriteCanvas",
    "_moonSpriteKey",
    "_moonTexReady",
    "_moonView",
    "_renderMoonHTML",
    "_scrollBehavior",
    "_setMoonSprite",
    "_smoothstep",
    "_weekFirstDay",
    "openAlmanacFind",
    "openAlmanacLook",
)

#: app.js names the Almanac only calls behind a ``typeof x === 'function'``
#: guard (or after one): in the ZIM they are absent and the feature steps
#: aside (no library to open, no PDF reader, no account).
GUARDED = frozenset(
    (
        "_armTapRelay",
        "_chromeReset",
        "_getPrefLanguages",
        "_gearSvg",
        "_nightSet",
        "_pdfViewerUrl",
        "_zimiVersion",
        "authedFetch",
        "closeReader",
        "openArticle",
        "openReader",
        "updateTopbar",
    )
)
#: Classes the Almanac's markup uses that only app.css styles.
SHELL_CLASSES = ("pill", "pills-row")
#: Names the Almanac's code uses as locals or object keys that app.js also
#: happens to declare at top level.
LOCALS = frozenset(("init", "mode", "q"))

_LINE_COMMENT = re.compile(r"(?m)^\s*//.*$")
_BLOCK_COMMENT = re.compile(r"/\*.*?\*/", re.S)
_TOP_DECL = re.compile(
    r"^(?:async\s+)?(?:function\s+|var\s+|let\s+|const\s+)([A-Za-z_$][\w$]*)", re.M
)
_WIRING = re.compile(r"^([A-Za-z_$][\w$]*)\s*(?:\.|\[|=[^=])")
_IDENT = re.compile(r"(?<![\w$.])[A-Za-z_$][\w$]*")
_ABS_STATIC = re.compile(r"""(['"(=])/static/""")
_REWRITTEN = (".js", ".css", ".html")


class StageError(Exception):
    """The stage could not be made whole; the message names what is missing."""


def strip_comments(text):
    """Whole-line and block comments removed (so a name in a comment is not a use)."""
    return _LINE_COMMENT.sub("", _BLOCK_COMMENT.sub("", text))


def app_names(src):
    """Every top-level function and variable app.js declares."""
    return set(_TOP_DECL.findall(src))


def _statement_end(lines, i):
    """Index of the line a ``var`` statement starting at ``i`` ends on: the first
    line ending in ``;`` with its brackets closed (strings skipped)."""
    depth, quote = 0, None
    for j in range(i, len(lines)):
        line = lines[j]
        k = 0
        while k < len(line):
            c = line[k]
            if quote:
                if c == "\\":
                    k += 1
                elif c == quote:
                    quote = None
            elif c in "'\"`":
                quote = c
            elif c == "/" and line[k + 1 : k + 2] == "/":
                break
            elif c in "([{":
                depth += 1
            elif c in ")]}":
                depth -= 1
            k += 1
        if quote in ("'", '"'):
            quote = None  # a plain string ends with its line
        if depth <= 0 and quote is None and line.rstrip().endswith(";"):
            return j
    raise StageError("unterminated statement")


def extract(src, name):
    """The source of top-level ``name`` in ``src``: a function from its
    ``function name(`` line to the next line that is exactly ``}``, a variable
    from its declaration to the end of the statement. Raises StageError naming
    ``name`` when it is not there."""
    lines = src.split("\n")
    fn = re.compile(r"(?:async\s+)?function\s+%s\s*\(" % re.escape(name))
    var = re.compile(r"(?:var|let|const)\s+%s\b" % re.escape(name))
    for i, line in enumerate(lines):
        if fn.match(line):
            if line.count("{") == line.count("}") and line.rstrip().endswith("}"):
                return line  # a function written on one line
            for j in range(i, len(lines)):
                if lines[j] == "}":
                    return "\n".join(lines[i : j + 1])
            break
        if var.match(line):
            return "\n".join(lines[i : _statement_end(lines, i) + 1])
    raise StageError("app.js has no top-level %s" % name)


def host_defines(host_html, name):
    """Whether the host page declares ``name`` (a function, a variable, or a window property)."""
    n = re.escape(name)
    return bool(
        re.search(r"(?:function\s+%s\s*\(|(?:var|let|const)\s+%s\b|window\.%s\s*=)" % (n, n, n), host_html)
    )


def _uses(text):
    return set(_IDENT.findall(strip_comments(text)))


def shell_names(app_src, host_html, seeds=None):
    """``seeds`` and everything they use that app.js declares, except what the
    host page defines, in the order app.js declares them (a variable is
    initialised before the code that reads it runs). A seed app.js lacks raises."""
    declared = app_names(app_src)
    want, todo = set(), list(seeds or SHELL_SEEDS)
    while todo:
        n = todo.pop()
        if n in want:
            continue
        want.add(n)
        todo.extend(
            u
            for u in _uses(extract(app_src, n))
            if u in declared
            and u not in want
            and u not in LOCALS
            and not host_defines(host_html, u)
        )
    order = {m.group(1): m.start() for m in _TOP_DECL.finditer(app_src)}
    return sorted(want, key=order.__getitem__)


def wiring(app_src, names):
    """The top-level statements app.js runs on what was pulled (``_MOON_TEX.src =
    ...``): a declaration alone would leave the Moon's map never loading."""
    lines, out, i = app_src.split("\n"), [], 0
    while i < len(lines):
        m = _WIRING.match(lines[i])
        if m and m.group(1) in names:
            end = _statement_end(lines, i)
            out.append("\n".join(lines[i : end + 1]))
            i = end
        i += 1
    return out


def shell_source(app_src, host_html):
    """shell.js: the pulled pieces of app.js, each once, then their wiring."""
    names = shell_names(app_src, host_html)
    parts = ["// Pieces of Zimi's app.js the Almanac calls, pulled out by name at build time."]
    parts.extend(extract(app_src, n) for n in names)
    parts.extend(wiring(app_src, set(names)))
    return "\n\n".join(parts) + "\n"


def missing_dependencies(app_src, scripts, host_html, shell_src):
    """Names app.js declares that ``scripts`` or shell.js use but nothing in the
    ZIM provides: each would be a ReferenceError there. Empty when whole."""
    used, own = set(), set()
    for text in list(scripts) + [shell_src]:
        used |= _uses(text)
        own |= app_names(text)  # the Almanac's own files declare some of the same names
    return sorted(
        n
        for n in app_names(app_src) & used
        if n not in GUARDED
        and n not in LOCALS
        and n not in own
        and not host_defines(host_html, n)
    )


def css_rules(css, classes=SHELL_CLASSES):
    """The top-level rules of app.css whose selector starts with one of
    ``classes`` (the Almanac's pills), as written. Raises when a class has none."""
    lines, out, found = css.split("\n"), [], set()
    pat = re.compile(r"^  \.(%s)(?![\w-])" % "|".join(map(re.escape, classes)))
    i = 0
    while i < len(lines):
        m = pat.match(lines[i])
        if m:
            j = i
            while "}" not in lines[j]:
                j += 1
            out.append("\n".join(l[2:] for l in lines[i : j + 1]))
            found.add(m.group(1))
            i = j
        i += 1
    for c in classes:
        if c not in found:
            raise StageError("app.css has no rule for .%s" % c)
    return "\n".join(out) + "\n"


def _relative(text):
    """Absolute /static/ paths made relative to the ZIM's root. Every page and
    stylesheet sits at the root, and a script's URLs resolve against its page."""
    return _ABS_STATIC.sub(lambda m: m.group(1), text)


def _copy(rel, dest):
    src = os.path.join(STATIC, rel)
    if not os.path.exists(src):
        raise StageError("static/%s is missing" % rel)
    out = os.path.join(dest, rel)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    if os.path.isdir(src):
        shutil.copytree(src, out)
        return
    if rel.endswith(_REWRITTEN):
        with open(src, encoding="utf-8") as f:
            text = _relative(f.read())
        with open(out, "w", encoding="utf-8", newline="\n") as f:
            f.write(text)
    else:
        shutil.copyfile(src, out)


def _snapshots(dest):
    """The two shipped snapshots a server would answer from, for local.js: the satellites' elements and the tide
    stations (Zimi keeps them as assets, the tides gzipped)."""
    assets = os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets")
    out = os.path.join(dest, "data")
    os.makedirs(out, exist_ok=True)
    for name in ("satellites-snapshot.json", "tides-snapshot.json.gz"):
        if not os.path.exists(os.path.join(assets, name)):
            raise StageError("assets/%s is missing" % name)
    shutil.copyfile(
        os.path.join(assets, "satellites-snapshot.json"),
        os.path.join(out, "satellites-snapshot.json"),
    )
    with gzip.open(os.path.join(assets, "tides-snapshot.json.gz"), "rb") as f:
        raw = f.read()
    with open(os.path.join(out, "tides-snapshot.json"), "wb") as f:
        f.write(raw)


def stage(dest):
    """Write the folder to build into ``dest`` (empty)."""
    with open(os.path.join(STATIC, "app.js"), encoding="utf-8") as f:
        app_src = f.read().replace("\r\n", "\n")
    with open(os.path.join(HOST, "index.html"), encoding="utf-8") as f:
        shell = shell_source(app_src, f.read())
    for rel in SCRIPTS + LAZY + STYLES + DATA:
        _copy(rel, dest)
    with open(os.path.join(dest, "shell.js"), "w", encoding="utf-8", newline="\n") as f:
        f.write(_relative(shell))
    with open(os.path.join(STATIC, "app.css"), encoding="utf-8") as f:
        shell_css = css_rules(f.read().replace("\r\n", "\n"))
    with open(os.path.join(dest, "shell.css"), "w", encoding="utf-8", newline="\n") as f:
        f.write(shell_css)
    for fn in os.listdir(HOST):
        shutil.copyfile(os.path.join(HOST, fn), os.path.join(dest, fn))
    _snapshots(dest)
