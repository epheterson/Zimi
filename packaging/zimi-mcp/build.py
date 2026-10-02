#!/usr/bin/env python3
"""Build the zimi-mcp distribution from this tree.

zimi-mcp is Zimi's MCP server and search alone: the modules that search and
read a ZIM, nothing of the web app, downloads, sharing or capture. It is not
a fork. This script copies MODULES out of zimi/ into a staging directory
beside this folder's pyproject.toml, stamps the main package's version on it,
and runs `python -m build` there.

    python packaging/zimi-mcp/build.py [--outdir dist-mcp] [--wheel-only]
    python packaging/zimi-mcp/build.py --stage DIR    (the package, no build)

The module list is checked by tests/test_zimi_mcp_package.py: every module
here must import with only the others beside it.
"""

import argparse
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
SRC = ROOT / "zimi"

# What `zimi-mcp` imports, lean or full. server.py is the core (config, the
# ZIM pools, the metadata cache); search and its helpers answer search and
# read; tube, exchange and reddot are the full set's app readers.
MODULES = (
    "__init__",
    "server",
    "mcp_server",
    "search",
    "query",
    "previews",
    "interlang",
    "datepages",
    "wikilang",
    "htmlmd",
    "mapsearch",
    "subproc",
    "zimwriter",
    "zimpatch",
    "tube",
    "nautilus",
    "details",
    "exchange",
    "reddot",
)
# Data the core reads at import: the language-code table.
DATA = ("assets/lang-codes.json",)
# Distributions zimi-mcp must never pull in (the CI smoke test checks).
EXCLUDED_DISTS = ("libtorrent", "zeroconf", "pywebview", "PyMuPDF", "playwright")

VERSION_RE = re.compile(r'^version = "([^"]+)"', re.M)
CODE_VERSION_RE = re.compile(r'^ZIMI_VERSION = "([^"]+)"', re.M)


def version():
    """The main package's version, which zimi-mcp shares. Refuses a tree
    whose pyproject and ZIMI_VERSION disagree."""
    main = VERSION_RE.search((ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    code = CODE_VERSION_RE.search((SRC / "server.py").read_text(encoding="utf-8"))
    if not main or not code or main.group(1) != code.group(1):
        raise SystemExit(
            "zimi-mcp: pyproject.toml's version and server.ZIMI_VERSION disagree"
        )
    return main.group(1)


def stage(dest):
    """The zimi-mcp source tree in ``dest``: pyproject, README, LICENSE and
    zimi/ holding MODULES and DATA. Returns ``dest``."""
    dest = Path(dest)
    pkg = dest / "zimi"
    pkg.mkdir(parents=True, exist_ok=True)
    for name in MODULES:
        shutil.copy2(SRC / f"{name}.py", pkg / f"{name}.py")
    for rel in DATA:
        (pkg / rel).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(SRC / rel, pkg / rel)
    pyproject = (HERE / "pyproject.toml").read_text(encoding="utf-8")
    (dest / "pyproject.toml").write_text(
        pyproject.replace("@VERSION@", version()), encoding="utf-8"
    )
    shutil.copy2(HERE / "README.md", dest / "README.md")
    shutil.copy2(ROOT / "LICENSE", dest / "LICENSE")
    return dest


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--outdir", default=str(ROOT / "dist-mcp"))
    parser.add_argument("--wheel-only", action="store_true")
    parser.add_argument("--stage", metavar="DIR", help="stage the package only")
    args = parser.parse_args(argv)
    if args.stage:
        print(stage(args.stage))
        return
    outdir = Path(args.outdir).resolve()
    with tempfile.TemporaryDirectory(prefix="zimi-mcp-") as tmp:
        stage(tmp)
        cmd = [sys.executable, "-m", "build", "--outdir", str(outdir)]
        if args.wheel_only:
            cmd.append("--wheel")
        subprocess.run([*cmd, tmp], check=True)
    for built in sorted(outdir.glob("zimi_mcp-*")):
        print(built)


if __name__ == "__main__":
    main()
