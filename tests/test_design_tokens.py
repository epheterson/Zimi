"""The design tokens (type, radius, spacing, touch, motion) are declared once, in tokens.css. The shell inlines them in
its head and each app page in front of apps.css, so every document that reads one finds it, and no stylesheet declares
its own. The shared stylesheets use them in place of the literals they replace.

Run: pytest tests/test_design_tokens.py -v
"""

import os
import re

STATIC = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "zimi", "static"
)
SCALE = {"11", "13", "15", "17", "20", "26", "32"}


def _read(name):
    with open(os.path.join(STATIC, name), encoding="utf-8") as f:
        return f.read()


def _block(css):
    return css


def test_the_type_scale_is_the_seven_sizes():
    block = _block(_read("tokens.css"))
    assert set(re.findall(r"--fs-[a-z]+:\s*(\d+)px", block)) == SCALE


def test_the_tokens_exist():
    block = _block(_read("tokens.css"))
    for name in (
        "--fw-regular",
        "--fw-strong",
        "--r-chip",
        "--r-sheet",
        "--r-full",
        "--sp-1",
        "--sp-5",
        "--gutter",
        "--target",
        "--dur-press",
        "--dur-settle",
        "--dur-travel",
        "--ease-press",
        "--ease-settle",
        "--ease-travel",
    ):
        assert re.search(re.escape(name) + r"\s*:", block), name
    assert "--target: 44px" in block
    assert (
        "--dur-press: 120ms" in block
        and "--dur-settle: 200ms" in block
        and "--dur-travel: 320ms" in block
    )
    assert "cubic-bezier(.25, 1, .5, 1)" in block


def test_reduced_motion_zeroes_the_durations():
    block = _block(_read("tokens.css"))
    m = re.search(r"prefers-reduced-motion: reduce\)\s*\{\s*:root\s*\{([^}]*)\}", block)
    assert m
    assert len(re.findall(r"--dur-\w+: 0\.001ms", m.group(1))) == 3


def test_no_stylesheet_declares_the_tokens_again():
    for name in ("app.css", "apps.css"):
        assert not re.search(r"--(?:fs-[a-z]+|sp-\d|dur-[a-z]+|ease-[a-z]+|target|r-chip|r-sheet|r-full)\s*:", _read(name)), name


def test_the_shell_and_the_app_pages_get_the_tokens_inlined():
    from zimi import http

    assert http._TOKENS_MARK not in http.SEARCH_UI_HTML
    head = http.SEARCH_UI_HTML.split("</head>", 1)[0]
    assert "--dur-settle: 200ms" in head and head.index("--dur-settle") < head.index("/static/app.css")
    with open(os.path.join(STATIC, "tube.html"), "rb") as f:
        served = http._inline_apps_assets(f.read())
    assert served.count(b"--dur-settle: 200ms") == 1
    assert served.index(b"--dur-settle") < served.index(b"--amber:")


# What a stylesheet says in a token's place: the literal each token replaces.
SCALE_LITERALS = (
    r"font-size:\s*(?:11|13|15|17|20|26|32)px",
    r"font-weight:\s*(?:400|600)\b",
    r"min-height:\s*44px",
    r"(?<![-\w])gap:\s*(?:4|8|12|16|24)px\s*;",
    r"border-radius:\s*6px",
)


def _after_tokens(name):
    return _read(name)


def test_apps_css_does_not_reintroduce_the_literals_the_tokens_replace():
    body = _after_tokens("apps.css")
    for pattern in SCALE_LITERALS:
        assert not re.search(pattern, body), pattern


def _staged_rules(css):
    import zimi.almanacstage as stage

    return stage.css_rules(css)


def test_app_css_does_not_reintroduce_the_literals_the_tokens_replace():
    """The Almanac ZIM's page copies app.css's pill rules and has no :root of its own, so those stay as literals."""
    css = _read("app.css")
    body = _after_tokens("app.css")
    staged = _staged_rules(css)
    assert not re.search(r"var\(--(?:fs|fw|sp|r-|dur|ease|target|gutter)", staged), staged
    for line in body.splitlines():
        if line.startswith("  .pill") or line.startswith("  .pills-row"):
            continue
        for pattern in SCALE_LITERALS:
            assert not re.search(pattern, line), (pattern, line.strip()[:120])


def test_the_ground_is_declared_once_apart_from_red_night():
    """The shell and the app pages draw on one paper and one night: dark and light neutrals live in tokens.css."""
    for line in _read("apps.css").splitlines():
        if re.search(r"--(?:bg|surface2?|border|text2?|amber2?):", line):
            assert "night-red" in line or line.startswith("  --amber"), line.strip()[:100]
    assert "#fbfaf6" in _read("tokens.css") and "#fbfaf6" not in _read("app.css")


def test_random_is_a_line_icon_not_the_colour_emoji():
    """The die sits among line icons; U+1F3B2 is a colour picture that no theme can tint."""
    for rel in ("zimi/static/app.js", "zimi/templates/index.html"):
        with open(os.path.join(os.path.dirname(STATIC), "..", rel), encoding="utf-8") as f:
            src = f.read()
        assert "\U0001F3B2" not in src and "&#x1F3B2;" not in src.replace("&#x1f3b2;", "&#x1F3B2;"), rel
    with open(os.path.join(os.path.dirname(STATIC), "templates", "index.html"), encoding="utf-8") as f:
        assert re.search(r'class="dice"[^>]*><svg', f.read())


def test_app_css_transitions_use_the_three_durations_and_their_curves():
    """Press 120ms ease-out, settle 200ms, travel 320ms: no loose .15s or .25s. The springs, the pill rules the Almanac ZIM
    copies and one half-second fade are the only literals left."""
    css = _read("app.css")
    copied = {ln.strip() for ln in _staged_rules(css).splitlines()}
    for line in css.splitlines():
        if line.strip() in copied:
            continue
        for decl in re.findall(r"(?<![-\w])transition:([^;{}]*);", line):
            for part in re.split(r",(?![^()]*\))", decl):
                if "cubic-bezier(0.34" in part or re.search(r"(?<![\d.])0?\.5s", part) or part.strip() in ("none", "all"):
                    continue
                assert not re.search(r"(?<![\w-])\d*\.?\d+m?s\b", part), (part.strip(), line.strip()[:100])
                if "var(--dur-" in part and "linear" not in part:
                    kind = re.search(r"var\(--dur-(\w+)\)", part).group(1)
                    assert "var(--ease-%s)" % kind in part, (part.strip(), line.strip()[:100])
