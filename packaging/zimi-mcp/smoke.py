#!/usr/bin/env python3
"""Drive an installed `zimi-mcp` over stdio against fixture ZIMs.

    <venv>/bin/python packaging/zimi-mcp/smoke.py <venv>/bin/zimi-mcp [--lean-only]
        [--check-excluded]

Run it with the Python of the install under test: the fixtures are written
with that install's libzim, and --check-excluded asks that install's metadata
which distributions are present. For each tool set it handshakes, lists the
tools, searches and reads, every stdout line strictly JSON, then prints what
it measured (seconds from start to the first search answer, the server's RSS
after a read) as one JSON line.
"""

import argparse
import importlib.metadata
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent.parent / "tests"))

import build as zimi_mcp_build  # noqa: E402
import mcp_lean_fixture as fx  # noqa: E402

TIMEOUT = 60.0


def _read(proc, deadline):
    while time.time() < deadline:
        line = proc.stdout.readline()
        if not line:
            break
        if line.strip():
            try:
                return json.loads(line)
            except json.JSONDecodeError:
                raise SystemExit(f"non-JSON on the MCP stdout: {line[:200]!r}")
    raise SystemExit("no answer from zimi-mcp:\n" + proc.stderr.read()[-3000:])


def _rpc(proc, deadline, id_, method, params=None):
    msg = {"jsonrpc": "2.0", "id": id_, "method": method}
    if params is not None:
        msg["params"] = params
    proc.stdin.write(json.dumps(msg) + "\n")
    proc.stdin.flush()
    reply = _read(proc, deadline)
    if "error" in reply:
        raise SystemExit(f"{method} failed: {reply['error']}")
    return reply["result"]


def _call(proc, deadline, id_, name, arguments):
    got = _rpc(
        proc, deadline, id_, "tools/call", {"name": name, "arguments": arguments}
    )
    text = got["content"][0]["text"]
    if got.get("isError"):
        raise SystemExit(f"{name} errored: {text}")
    return text


def _rss_mb(pid):
    out = subprocess.run(
        ["ps", "-o", "rss=", "-p", str(pid)], capture_output=True, text=True
    )
    return round(int(out.stdout.split()[0]) / 1024, 1)


def run(command, library, tools, workdir):
    env = dict(os.environ, ZIMI_TORRENT="0", ZIMI_OFFLINE="1")
    for key in ("ZIM_DIR", "ZIMI_MCP_TOOLS", "PYTHONPATH"):
        env.pop(key, None)
    started = time.time()
    proc = subprocess.Popen(
        [command, library, "--tools", tools],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        env=env,
        bufsize=1,
        cwd=workdir,  # not the repo: the installed package must answer
    )
    try:
        deadline = started + TIMEOUT
        init = _rpc(
            proc,
            deadline,
            1,
            "initialize",
            {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "zimi-mcp-smoke", "version": "1"},
            },
        )
        proc.stdin.write(
            json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n"
        )
        proc.stdin.flush()
        assert init["serverInfo"]["version"] == zimi_mcp_build.version(), init[
            "serverInfo"
        ]
        names = [t["name"] for t in _rpc(proc, deadline, 2, "tools/list")["tools"]]
        if tools == "lean":
            assert names == ["search", "read", "read_section"], names
        else:
            assert {
                "search",
                "read",
                "list_questions",
                "list_videos",
                "read_post",
            } <= set(names), names
        found = _call(proc, deadline, 3, "search", {"query": "chop onions", "limit": 3})
        first_search = round(time.time() - started, 2)
        assert fx.QUESTION_PATH in found, found
        page = _call(proc, deadline, 4, "read", {"zim": "wikipedia_en_test", "path": "Water"})
        assert "Water" in page and "inorganic compound" in page, page[:500]
        if tools == "full":
            sites = _call(proc, deadline, 5, "list_questions", {})
            assert "cooking" in sites, sites
        else:
            sec = _call(
                proc,
                deadline,
                5,
                "read_section",
                {"zim": "wikipedia", "path": "Water", "section": "History"},
            )
            assert "History" in sec, sec[:500]
        return {
            "tools": tools,
            "first_search_s": first_search,
            "rss_mb": _rss_mb(proc.pid),
        }
    finally:
        proc.kill()
        proc.wait(timeout=10)


def check_excluded():
    present = []
    for dist in zimi_mcp_build.EXCLUDED_DISTS:
        try:
            importlib.metadata.distribution(dist)
            present.append(dist)
        except importlib.metadata.PackageNotFoundError:
            pass
    if present:
        raise SystemExit(f"zimi-mcp pulled in {', '.join(present)}")
    import zimi

    pkg = Path(zimi.__path__[0])
    shipped = {p.stem for p in pkg.glob("*.py")}
    if shipped != set(zimi_mcp_build.MODULES) or (pkg / "static").exists():
        raise SystemExit(
            f"the installed zimi package is not zimi-mcp's: {sorted(shipped)}"
        )
    print(f"excluded distributions absent; {len(shipped)} modules in {pkg}")


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("command", help="the zimi-mcp executable to drive")
    parser.add_argument("--lean-only", action="store_true")
    parser.add_argument("--check-excluded", action="store_true")
    args = parser.parse_args()
    if args.check_excluded:
        check_excluded()
    command = os.path.abspath(shutil.which(args.command) or args.command)
    with tempfile.TemporaryDirectory(prefix="zimi-mcp-smoke-") as tmp:
        library = fx.build(os.path.join(tmp, "zims"))
        for tools in ("lean",) if args.lean_only else ("lean", "full"):
            print(json.dumps(run(command, library, tools, tmp)))


if __name__ == "__main__":
    main()
