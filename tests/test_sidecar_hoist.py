"""The patch that gives wombat's block-wrapped inline scripts their globals back.

zimscraperlib wraps an inline script that touches a global in a bare block so
wombat can shadow `window`, `self`, `location` with `let`. Upstream knows the
block is wrong for globals (python-scraperlib#329): `const`, `let` and `class`
declared inside it are block-scoped and never reach the page. A page that puts
its data in one inline script and reads it from another breaks with "X is not
defined" while every byte of X sits in the ZIM — nerdfonts.com/cheat-sheet in
issue #64, `const glyphs = {...}` in the page, search finding nothing.

Zimi patches the sidecar at install time, the way it already patches the
srcset splitter. These tests drive the helper that gets appended to js.py, and
the patcher's own contract: idempotent, and self-removing once upstream fixes
the line it replaces.
"""

import os
import sys
import types

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from zimi import importer  # noqa: E402


@pytest.fixture(scope="module")
def helper():
    """The appended code, executed as a module of its own — exactly what the
    sidecar's js.py will run."""
    mod = types.ModuleType("zimi_hoist_helper")
    exec(importer._BLOCK_GLOBALS_HELPER, mod.__dict__)
    return mod


def test_top_level_declarations_are_found(helper):
    names = helper._zimi_top_level_names(
        'const glyphs = {"a": 1};\nlet count = 0;\nclass Widget {}\n'
    )
    assert names == ["glyphs", "count", "Widget"]


def test_declarations_inside_functions_and_blocks_are_not(helper):
    """Only the block's own top level leaks the way `var` would have. A name
    inside a function was never visible to the page and must not become so."""
    src = "function f() { const inner = 1; }\nif (x) { let alsoInner = 2; }\nconst outer = 3;"
    assert helper._zimi_top_level_names(src) == ["outer"]


def test_braces_in_strings_templates_and_comments_do_not_count(helper):
    src = (
        'const a = "{";\n'
        "let b = `{${1}}`;\n"
        "// const fake = 1\n"
        "/* let alsofake = 2 */\n"
        "const c = 3;"
    )
    assert helper._zimi_top_level_names(src) == ["a", "b", "c"]


def test_the_word_inside_an_identifier_or_member_is_not_a_declaration(helper):
    src = "obj.const = 1; xconst = 2; letter = 3; const real = 4;"
    assert helper._zimi_top_level_names(src) == ["real"]


def test_the_hoist_is_what_var_would_have_done(helper):
    out = helper._zimi_hoist_block_globals("const glyphs = {}; let n = 1;")
    assert "self.glyphs=glyphs" in out
    assert "self.n=n" in out
    # Guarded, so a declaration that threw before initialising cannot turn a
    # working page into a broken one.
    assert out.count("try{") == 2
    assert helper._zimi_hoist_block_globals("f(); g();") == ""


def test_the_patch_is_idempotent_and_self_removing(tmp_path):
    """Applying twice changes nothing the second time; a js.py that no longer
    carries the line reports 'not needed' and is left alone."""
    site = (
        tmp_path
        / "lib"
        / "python3.14"
        / "site-packages"
        / "zimscraperlib"
        / "rewriting"
    )
    site.mkdir(parents=True)
    js = site / "js.py"
    js.write_text(
        "class R:\n    def rewrite(self, text, opts):\n"
        + importer._BLOCK_GLOBALS_BUG
        + "\n        return new_text\n"
    )
    said = []
    assert importer._patch_block_scoped_globals(str(tmp_path), said.append) == "applied"
    first = js.read_text()
    assert importer._BLOCK_GLOBALS_FIX in first
    assert "_zimi_hoist_block_globals" in first
    assert importer._patch_block_scoped_globals(str(tmp_path), said.append) == "applied"
    assert js.read_text() == first, "a second application must change nothing"

    js.write_text("class R:\n    def rewrite(self, text, opts):\n        return text\n")
    assert (
        importer._patch_block_scoped_globals(str(tmp_path), said.append) == "not needed"
    )
    assert importer._patch_block_scoped_globals("/nowhere", said.append) == "not found"


def test_the_appended_helper_is_valid_python_on_its_own():
    compile(importer._BLOCK_GLOBALS_HELPER, "hoist_helper", "exec")
