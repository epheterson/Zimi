"""app.js and manage.js: the Library Manager is fetched when it is first opened.

What the rest of the app calls on its own stays in app.js, and what it calls
only to open or redraw Manage is a stub there that loads manage.js and runs
manage.js's function of the same name. A name that crossed over without a stub
would be a ReferenceError on the first click, with manage.js not yet loaded.
"""

import os
import re

STATIC = os.path.join(os.path.dirname(__file__), "..", "zimi", "static")
DECL = re.compile(r"^(?:async\s+)?function\s+([\w$]+)|^(?:var|let|const)\s+([\w$]+)", re.M)
STUB = re.compile(r"^function ([\w$]+)\(\) \{ return _manageThen\('\1', arguments\); \}$", re.M)
# A stub that does something itself until manage.js replaces it: drawing the top bar (every boot) must not load manage.js,
# and with no manage.js there is no selection bar to draw. Each is one line, declared by app.js and then by manage.js.
LOCAL_STUB = re.compile(r"^function (_renderSelectionBar)\(\) \{ var bar = document\.getElementById\('ci-selection-bar'\); if \(bar\) bar\.remove\(\); \}$", re.M)


def _stubs(app):
    return set(STUB.findall(app)) | set(LOCAL_STUB.findall(app))


def _read(name):
    with open(os.path.join(STATIC, name), encoding="utf-8") as f:
        return f.read()


def _code_words(src):
    """The words of a script outside whole-line and block comments."""
    src = re.sub(r"/\*.*?\*/", " ", src, flags=re.S)
    src = "\n".join(l for l in src.split("\n") if not l.lstrip().startswith("//"))
    return set(re.findall(r"[A-Za-z_$][\w$]*", src))


def _names(src):
    return {a or b for a, b in DECL.findall(src)}


def test_every_stub_is_defined_by_manage_js():
    stubs = _stubs(_read("app.js"))
    assert len(stubs) > 10
    missing = stubs - _names(_read("manage.js"))
    assert not missing, f"stubs manage.js does not define: {sorted(missing)}"


def test_app_js_reaches_manage_js_only_through_stubs():
    app = _read("app.js")
    stubs = _stubs(app)
    without_stubs = LOCAL_STUB.sub("", STUB.sub("", app))
    crossed = (_names(_read("manage.js")) - stubs) & _code_words(without_stubs)
    assert not crossed, f"app.js uses names only manage.js declares: {sorted(crossed)}"


def test_no_name_is_declared_in_both():
    stubs = _stubs(_read("app.js"))
    both = (_names(_read("app.js")) & _names(_read("manage.js"))) - stubs
    assert not both, f"declared in app.js and manage.js: {sorted(both)}"


def test_other_scripts_reach_manage_js_only_through_stubs():
    stubs = _stubs(_read("app.js"))
    declared = _names(_read("manage.js")) - stubs
    for name in sorted(os.listdir(STATIC)):
        if not name.endswith(".js") or name in ("app.js", "manage.js", "sw.js"):
            continue
        if name.startswith(("almanac", "pdf", "fzstd", "keep", "zim", "bookmath")):
            continue
        used = declared & _code_words(_read(name))
        # A name another script declares for itself is its own.
        used -= _names(_read(name))
        assert not used, f"{name} uses names only manage.js declares: {sorted(used)}"


def test_the_page_reaches_manage_js_only_through_stubs():
    stubs = _stubs(_read("app.js"))
    with open(os.path.join(STATIC, "..", "templates", "index.html"), encoding="utf-8") as f:
        page = f.read()
    used = (_names(_read("manage.js")) - stubs) & set(re.findall(r"[A-Za-z_$][\w$]*", page))
    assert not used, f"index.html uses names only manage.js declares: {sorted(used)}"
