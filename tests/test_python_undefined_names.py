"""Shipped Python must not use a name nothing defines.

A merge can drop a function or an import and leave its callers: the code runs until the one path that needs it
(behaviors.py caught SubprocessError without importing subprocess, so a failing `npm` raised NameError instead of falling
back). pyflakes reads every module without running it and reports each name that is used but bound nowhere, a name listed in
``__all__`` that is not defined, and a local read before it is assigned.

Not caught: a name that exists but is the wrong one, an attribute gone from a module (``mod.fn()``), a name built at run
time, and anything behind ``from x import *``.

Needs pyflakes (the ``test`` extra). CI installs it; elsewhere the test skips when it is missing.
"""

import os
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

try:
    from pyflakes import checker
except ImportError:  # pragma: no cover
    checker = None

#: What counts: a use with no binding. Unused imports and the like are style, not loss.
_FATAL = ("UndefinedName", "UndefinedExport", "UndefinedLocal")
_SCAN = ("zimi", "scripts", os.path.join("packaging", "zimi-mcp"), "desktop")


def _sources():
    for top in _SCAN:
        for dirpath, dirnames, files in os.walk(os.path.join(ROOT, top)):
            dirnames[:] = [d for d in dirnames if d not in ("builtin", "static", "__pycache__", "node_modules")]
            for name in files:
                if name.endswith(".py"):
                    yield os.path.join(dirpath, name)


def _undefined(source, filename="<test>"):
    import ast

    tree = ast.parse(source, filename)
    found = checker.Checker(tree, filename=filename)
    return sorted(
        "%s:%d %s" % (os.path.relpath(m.filename, ROOT) if os.path.isabs(m.filename) else m.filename, m.lineno, m.message % m.message_args)
        for m in found.messages
        if type(m).__name__ in _FATAL
    )


@pytest.fixture(scope="module", autouse=True)
def _need_pyflakes():
    if checker is None:
        if os.environ.get("CI"):
            pytest.fail("pyflakes is not installed; CI installs it with the test extra")
        pytest.skip("pyflakes is not installed")


def test_the_check_finds_a_missing_import_and_a_missing_function():
    source = "def f():\n    try:\n        g()\n    except subprocess.SubprocessError:\n        pass\n"
    got = _undefined(source)
    assert any("undefined name 'subprocess'" in g for g in got) and any("undefined name 'g'" in g for g in got), got
    assert _undefined("import os\n\n\ndef f():\n    return os.getcwd()\n") == []


def test_no_module_uses_a_name_nothing_defines():
    problems = []
    for path in _sources():
        with open(path, encoding="utf-8") as f:
            problems.extend(_undefined(f.read(), path))
    assert not problems, "names used and defined nowhere:\n  " + "\n  ".join(problems)
