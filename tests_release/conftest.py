"""Release gate harness: boot a real server, drive it over HTTP, score it.

Every check here boots `python -m zimi serve --port 0` as a real subprocess
against a real library of fixture ZIMs and talks to it the way a browser does.
Nothing is stubbed, and no port is ever hard-coded — the server prints the port
it actually got and the harness reads it back.

Each test module gets its own server so a check that mutates the library
(create, delete, export) cannot change the answer another check gets.
"""

import http.client
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.parse

import pytest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO_ROOT)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from fixtures_zim import build_gate_library  # noqa: E402

READY_RE = re.compile(rb"^READY (\d+)\s*$", re.MULTILINE)
READY_TIMEOUT_SEC = 45
POLL_INTERVAL_SEC = 0.2
HTTP_TIMEOUT_SEC = 30

#: Env that makes a boot quiet and self-contained: no update polling, no
#: torrent engine, no LAN discovery, no rate limiting to trip over, and no
#: network at all. Individual checks override what they are actually testing.
QUIET_ENV = {
    "ZIMI_AUTO_UPDATE": "0",
    "ZIMI_TORRENT": "0",
    "ZIMI_PEER_DISCOVERY": "0",
    "ZIMI_RATE_LIMIT": "0",
    "ZIMI_OFFLINE": "1",
    "ZIMI_PEER_SHARE": "1",
    "PYTHONUNBUFFERED": "1",
}

#: Env keys that would otherwise leak the developer's own instance into a boot.
_INHERITED_KEYS = (
    "ZIM_DIR",
    "ZIMI_DATA_DIR",
    "ZIMI_CONFIG",
    "ZIMI_HOST",
    "ZIMI_PORT",
    "ZIMI_MANAGE",
    "ZIMI_MANAGE_PASSWORD",
    "ZIMI_MANAGE_USER",
    "ZIMI_API_TOKEN",
    "ZIMI_SSO_TEAM",
    "ZIMI_SSO_AUD",
)


class GateServer:
    """A booted zimi instance plus the small HTTP client the checks use."""

    def __init__(self, port, log_path, zim_dir, data_dir):
        self.port = port
        self.log_path = log_path
        self.zim_dir = zim_dir
        self.data_dir = data_dir

    @property
    def base(self):
        return f"http://127.0.0.1:{self.port}"

    def log_text(self):
        with open(self.log_path, encoding="utf-8", errors="replace") as f:
            return f.read()

    def request(self, method, path, body=None, headers=None):
        """Return (status, headers_dict, body_bytes). Never raises on 4xx/5xx."""
        conn = http.client.HTTPConnection(
            "127.0.0.1", self.port, timeout=HTTP_TIMEOUT_SEC
        )
        send_headers = dict(headers or {})
        payload = None
        if body is not None:
            payload = json.dumps(body).encode()
            send_headers.setdefault("Content-Type", "application/json")
        try:
            conn.request(method, path, body=payload, headers=send_headers)
            resp = conn.getresponse()
            return resp.status, dict(resp.getheaders()), resp.read()
        finally:
            conn.close()

    def get(self, path, headers=None):
        return self.request("GET", path, headers=headers)

    def get_json(self, path, headers=None):
        status, hdrs, raw = self.get(path, headers=headers)
        return status, _decode_json(status, path, raw)

    def post_json(self, path, body, headers=None):
        status, hdrs, raw = self.request("POST", path, body=body, headers=headers)
        return status, _decode_json(status, path, raw)

    def poll_json(self, path, until, timeout=120, interval=0.3):
        """Poll `path` until `until(payload)` is true; return the last payload."""
        deadline = time.time() + timeout
        payload = None
        while time.time() < deadline:
            status, payload = self.get_json(path)
            assert status == 200, f"{path} returned {status}: {payload}"
            if until(payload):
                return payload
            time.sleep(interval)
        pytest.fail(
            f"timed out after {timeout}s polling {path}; last payload: {payload}"
        )


def _decode_json(status, path, raw):
    try:
        return json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        pytest.fail(f"{path} returned {status} with non-JSON body: {raw[:200]!r}")


def _wait_for_ready(proc, log_path):
    """Read the port the server actually bound off its own READY line."""
    deadline = time.time() + READY_TIMEOUT_SEC
    out = b""
    while time.time() < deadline:
        with open(log_path, "rb") as f:
            out = f.read()
        match = READY_RE.search(out)
        if match:
            return int(match.group(1))
        if proc.poll() is not None:
            raise AssertionError(
                f"server exited with code {proc.returncode} before READY:\n"
                + out.decode("utf-8", errors="replace")[-4000:]
            )
        time.sleep(POLL_INTERVAL_SEC)
    raise AssertionError(
        f"server never printed READY within {READY_TIMEOUT_SEC}s:\n"
        + out.decode("utf-8", errors="replace")[-4000:]
    )


def clean_env(**overrides):
    """A boot environment with the developer's own instance scrubbed out."""
    env = os.environ.copy()
    for key in _INHERITED_KEYS:
        env.pop(key, None)
    env.update(QUIET_ENV)
    env["PYTHONPATH"] = os.pathsep.join(
        [REPO_ROOT] + ([env["PYTHONPATH"]] if env.get("PYTHONPATH") else [])
    )
    for key, value in overrides.items():
        if value is None:
            env.pop(key, None)
        else:
            env[key] = str(value)
    return env


class _BootedServer:
    """Context manager owning one server subprocess and its temp dirs."""

    def __init__(
        self,
        zim_dir=None,
        data_dir=None,
        env=None,
        argv=None,
        owns_dirs=(),
        launcher=None,
    ):
        self._zim_dir = zim_dir
        self._data_dir = data_dir
        self._env = env
        self._argv = argv
        self._launcher = launcher
        self._owns_dirs = list(owns_dirs)
        self.proc = None
        self.server = None
        self._log_path = None

    def __enter__(self):
        fd, self._log_path = tempfile.mkstemp(prefix="zimi-gate-log-")
        os.close(fd)
        env = self._env if self._env is not None else clean_env()
        if self._zim_dir is not None:
            env["ZIM_DIR"] = str(self._zim_dir)
        if self._data_dir is not None:
            env["ZIMI_DATA_DIR"] = str(self._data_dir)
            os.makedirs(self._data_dir, exist_ok=True)
        argv = self._argv or ["serve", "--port", "0"]
        # A launcher runs zimi in-process behind a wrapper (used to install the
        # network guard). sitecustomize is not an option — this interpreter
        # already ships one, and shadowing it loses site-packages entirely.
        entry = [self._launcher] if self._launcher else ["-m", "zimi"]
        with open(self._log_path, "w") as log_f:
            self.proc = subprocess.Popen(
                [sys.executable] + entry + argv,
                cwd=REPO_ROOT,
                env=env,
                stdout=log_f,
                stderr=subprocess.STDOUT,
            )
        port = _wait_for_ready(self.proc, self._log_path)
        self.server = GateServer(port, self._log_path, self._zim_dir, self._data_dir)
        return self.server

    def __exit__(self, *exc):
        if self.proc is not None:
            try:
                self.proc.terminate()
                self.proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait(timeout=5)
        for path in self._owns_dirs:
            shutil.rmtree(path, ignore_errors=True)
        if self._log_path:
            try:
                os.remove(self._log_path)
            except OSError:
                pass
        return False


def boot(zim_dir=None, data_dir=None, env=None, argv=None, owns_dirs=(), launcher=None):
    """Boot a server on an ephemeral port. Use as a context manager."""
    return _BootedServer(zim_dir, data_dir, env, argv, owns_dirs, launcher)


@pytest.fixture(scope="session")
def gate_library(tmp_path_factory):
    """The fixture library, built once and copied per module that mutates it."""
    zim_dir = tmp_path_factory.mktemp("gate-library")
    build_gate_library(str(zim_dir))
    return str(zim_dir)


@pytest.fixture(scope="module")
def gate_server(gate_library, tmp_path_factory):
    """A private server with its own copy of the library, one per test module.

    ZIMI_CREATE_ROOT is set to the run's scratch area because folder and import
    capture are refused outright without it — that door is closed by default,
    and an operator who wants the web to package server paths opens exactly one
    directory. Here that directory is the one every fixture builds its sources
    under. The closed default has its own gate check in test_04_create.py."""
    root = tmp_path_factory.mktemp("gate-instance")
    zim_dir = os.path.join(str(root), "zims")
    data_dir = os.path.join(str(root), "data")
    shutil.copytree(gate_library, zim_dir)
    env = clean_env()
    env["ZIMI_CREATE_ROOT"] = str(tmp_path_factory.getbasetemp())
    with boot(zim_dir=zim_dir, data_dir=data_dir, env=env) as server:
        yield server


def free_port():
    """A port nothing is listening on — for refusal checks, never for binding."""
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def quote(value):
    return urllib.parse.quote(str(value), safe="")


# ---------------------------------------------------------------------------
# Scoreboard
# ---------------------------------------------------------------------------
# Unit tests report per-assertion. A release gate has one audience — the person
# deciding whether to tag — so it reports per FEATURE: one line saying whether
# the thing a user does still works.

_FEATURE_ORDER = []
_FEATURE_STATS = {}


def pytest_configure(config):
    config.addinivalue_line(
        "markers", "gate(name): the user-facing feature this check belongs to"
    )


def _feature_of(item):
    marker = item.get_closest_marker("gate")
    if marker and marker.args:
        return marker.args[0]
    return item.nodeid.split("::")[0]


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_makereport(item, call):
    outcome = yield
    report = outcome.get_result()
    if report.when not in ("setup", "call"):
        return
    feature = _feature_of(item)
    if feature not in _FEATURE_STATS:
        _FEATURE_ORDER.append(feature)
        _FEATURE_STATS[feature] = {
            "passed": 0,
            "failed": 0,
            "skipped": 0,
            "seconds": 0.0,
            "failures": [],
        }
    stats = _FEATURE_STATS[feature]
    # Setup time is the server boot; it belongs to the feature's cost even when
    # setup itself passes, but only the call phase decides pass/fail.
    stats["seconds"] += report.duration
    if report.when == "setup" and report.passed:
        return
    if report.failed:
        stats["failed"] += 1
        stats["failures"].append(item.name)
    elif report.skipped:
        stats["skipped"] += 1
    else:
        stats["passed"] += 1


def pytest_terminal_summary(terminalreporter):
    if not _FEATURE_ORDER:
        return
    write = terminalreporter.write_line
    width = max(len(name) for name in _FEATURE_ORDER)
    write("")
    write("=" * (width + 40))
    write("RELEASE GATE SCOREBOARD")
    write("=" * (width + 40))
    for feature in _FEATURE_ORDER:
        stats = _FEATURE_STATS[feature]
        if stats["failed"]:
            verdict, colour = "FAIL", {"red": True, "bold": True}
        elif stats["passed"] == 0 and stats["skipped"]:
            verdict, colour = "SKIP", {"yellow": True}
        else:
            verdict, colour = "PASS", {"green": True}
        checks = stats["passed"] + stats["failed"] + stats["skipped"]
        suffix = f" ({stats['skipped']} skipped)" if stats["skipped"] else ""
        terminalreporter.write(f"  {verdict}  ", **colour)
        write(
            f"{feature.ljust(width)}   {checks:>2} checks   "
            f"{stats['seconds']:5.1f}s{suffix}"
        )
        for name in stats["failures"]:
            write(f"        broken: {name}")
    write("=" * (width + 40))
