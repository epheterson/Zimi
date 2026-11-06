"""The Almanac HD release job installs every third-party module its build script imports (scipy was missing, so the
job failed at the relief layer)."""

import ast
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STDLIB = set(getattr(sys, "stdlib_module_names", ()))
PIP_NAME = {"PIL": "pillow"}


def _imports(path):
    tree = ast.parse(open(path, encoding="utf-8").read())
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            yield from (a.name.split(".")[0] for a in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module and not node.level:
            yield node.module.split(".")[0]


def test_the_hd_job_installs_what_the_build_imports():
    third = {m for m in _imports(os.path.join(ROOT, "scripts", "build_almanac_hd.py")) if m not in STDLIB and m != "zimi"}
    wf = open(os.path.join(ROOT, ".github", "workflows", "almanac-hd.yml"), encoding="utf-8").read()
    installs = " ".join(re.findall(r"pip install ([^\n]+)", wf)).lower()
    if "-r requirements.txt" in installs:
        installs += " " + open(os.path.join(ROOT, "requirements.txt"), encoding="utf-8").read().lower()
    missing = [m for m in sorted(third) if PIP_NAME.get(m, m).lower() not in installs]
    assert not missing, missing
