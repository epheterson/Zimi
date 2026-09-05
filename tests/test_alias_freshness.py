"""server.py's re-export block must never copy a name its owner rebinds.

``from zimi.interlang import _domain_zim_map`` copies the current binding once.
When _build_domain_zim_map does ``global _domain_zim_map; _domain_zim_map = dmap``
the copy stops tracking, and every consumer reading ``_srv._domain_zim_map``
serves import-time state forever. That is exactly how /resolve?domains=1 —
the browser's cross-ZIM pre-check — shipped dead.

These tests re-derive the classification from the source AST rather than
trusting a hand-kept list, so adding a ``global`` rebind to a re-exported name
fails here immediately instead of in production.
"""

import ast
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import zimi.server as server  # noqa: E402

ZIMI_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "zimi"
)


def _parse(module_name):
    path = os.path.join(ZIMI_DIR, module_name.split(".")[-1] + ".py")
    with open(path, encoding="utf-8") as f:
        return ast.parse(f.read())


def _reexported_by_value():
    """{name: owning module} for every ``from zimi.x import name`` in server.py."""
    out = {}
    for node in _parse("server").body:
        if isinstance(node, ast.ImportFrom) and (node.module or "").startswith("zimi."):
            for alias in node.names:
                out[alias.name] = node.module
    return out


def _rebound_globals(module_name):
    """Names the module rebinds at runtime (``global x`` then ``x = ...``)."""
    found = set()

    class Walker(ast.NodeVisitor):
        def __init__(self):
            self.declared = []

        def _enter_function(self, node):
            """Each function body is its own ``global`` declaration scope."""
            self.declared.append(set())
            self.generic_visit(node)
            self.declared.pop()

        def visit_FunctionDef(self, node):
            self._enter_function(node)

        def visit_AsyncFunctionDef(self, node):
            self._enter_function(node)

        def visit_Global(self, node):
            if self.declared:
                self.declared[-1].update(node.names)

        def _check(self, name):
            if any(name in scope for scope in self.declared):
                found.add(name)

        def visit_Assign(self, node):
            for target in node.targets:
                if isinstance(target, ast.Name):
                    self._check(target.id)
            self.generic_visit(node)

        def visit_AugAssign(self, node):
            if isinstance(node.target, ast.Name):
                self._check(node.target.id)
            self.generic_visit(node)

    Walker().visit(_parse(module_name))
    return found


def test_no_rebound_name_is_re_exported_by_value():
    """The guard. A rebind-class name must be in _REBOUND_ALIASES, not imported."""
    by_value = _reexported_by_value()
    offenders = []
    for module_name in sorted(set(by_value.values())):
        for name in sorted(_rebound_globals(module_name)):
            if by_value.get(name) == module_name:
                offenders.append(f"{name} (rebound in {module_name})")
    assert not offenders, (
        "server.py copies these names by value but their owner rebinds them, so "
        "the copy goes stale forever: "
        + ", ".join(offenders)
        + ". Move each into _REBOUND_ALIASES in zimi/server.py."
    )


def test_rebound_alias_table_has_no_dead_entries():
    """Every table entry must name a real rebind — a stale table hides real ones."""
    for name, module_name in server._REBOUND_ALIASES.items():
        assert name in _rebound_globals(module_name), (
            f"{name} is listed as rebind-class but {module_name} never rebinds it; "
            "re-export it by value or drop the entry."
        )


@pytest.mark.parametrize("name", sorted(server._REBOUND_ALIASES))
def test_alias_tracks_a_rebind(name):
    """Rebinding the owner's global must be visible through zimi.server at once."""
    owner = sys.modules[server._REBOUND_ALIASES[name]]
    original = getattr(owner, name)
    sentinel = object()
    try:
        setattr(owner, name, sentinel)
        assert getattr(server, name) is sentinel
    finally:
        setattr(owner, name, original)
    assert getattr(server, name) is original


def test_load_cache_publishes_a_live_domain_map(tmp_path, monkeypatch):
    """The exact production regression: a normally-booted server (load_cache,
    not register_zim_file) must serve a populated domain map."""
    pytest.importorskip("libzim.writer")
    from conftest_zim import build_fixture_zim

    import zimi.interlang as interlang

    zdir = tmp_path / "zims"
    zdir.mkdir()
    ddir = tmp_path / "data"
    ddir.mkdir()
    build_fixture_zim(str(zdir / "wikipedia_en_all_2026-01.zim"))
    monkeypatch.setattr(server, "ZIM_DIR", str(zdir))
    monkeypatch.setattr(server, "ZIMI_DATA_DIR", str(ddir))
    server._archive_pool.clear()
    try:
        server.load_cache(force=True)
        assert server._domain_zim_map, "boot left /resolve?domains=1 empty"
        assert server._domain_zim_map is interlang._domain_zim_map
        assert set(server._domain_zim_map.values()) == {"wikipedia"}
    finally:
        server._archive_pool.clear()
