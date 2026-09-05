"""Boot behaviour a deployer depends on: where settings came from, and silence.

`zimi config` is the answer to "why is this instance using that value" — if its
provenance column is wrong, every support conversation starts from a lie.
ZIMI_OFFLINE is the air-gap switch: the promise is not "fewer calls", it is
zero, so this proves it by making an outbound connection impossible and
checking nothing tried.
"""

import json
import os
import subprocess
import sys

import pytest

from conftest import REPO_ROOT, boot, clean_env

pytestmark = pytest.mark.gate("config provenance and offline boot")

#: A launcher that installs a network guard and then runs zimi normally. It has
#: to be a launcher rather than a sitecustomize: this interpreter already ships
#: one, and shadowing it drops site-packages off sys.path entirely.
_NET_GUARD_LAUNCHER = '''\
"""Release gate launcher: refuse and record every non-loopback connection."""

import os
import socket
import sys

_LOG = os.environ["ZIMI_GATE_NETLOG"]
_LOCAL_PREFIXES = ("127.", "::1", "localhost", "0.0.0.0", "")


def _is_local(host):
    return isinstance(host, str) and host.startswith(_LOCAL_PREFIXES)


def _wrap(name):
    original = getattr(socket.socket, name)

    def guarded(self, address, *args, **kwargs):
        host = address[0] if isinstance(address, tuple) else None
        if not _is_local(host):
            with open(_LOG, "a") as handle:
                handle.write("%s %r\\n" % (name, address))
            raise OSError("release gate: outbound network blocked")
        return original(self, address, *args, **kwargs)

    setattr(socket.socket, name, guarded)


for _name in ("connect", "connect_ex"):
    _wrap(_name)
with open(_LOG + ".installed", "w") as _handle:
    _handle.write("ok\\n")

sys.argv[0] = "zimi"
from zimi.server import main  # noqa: E402

main()
'''


def _parse_config_report(stdout):
    """{setting: (value, provenance)} from `zimi config` output."""
    rows = {}
    for line in stdout.splitlines():
        line = line.rstrip()
        if not line or not line.endswith(")") or "(" not in line:
            continue
        head, _, source = line.rpartition("(")
        parts = head.split()
        if len(parts) < 2:
            continue
        rows[parts[0]] = (" ".join(parts[1:]), source[:-1])
    return rows


def test_config_reports_where_each_value_came_from(tmp_path):
    """A value set in the config file must be attributed to that file by path."""
    zim_dir = tmp_path / "zims"
    data_dir = tmp_path / "data"
    zim_dir.mkdir()
    data_dir.mkdir()
    config_path = tmp_path / "zimi.json"
    config_path.write_text(
        json.dumps(
            {
                "zim_dir": str(zim_dir),
                "data_dir": str(data_dir),
                "host": "127.0.0.1",
                "port": 8911,
            }
        )
    )

    env = clean_env()
    # The gate's own quiet-boot env would otherwise out-rank the config file.
    for key in ("ZIMI_OFFLINE", "ZIMI_RATE_LIMIT", "ZIMI_AUTO_UPDATE"):
        env.pop(key, None)

    result = subprocess.run(
        [sys.executable, "-m", "zimi", "config", "--config", str(config_path)],
        cwd=REPO_ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    rows = _parse_config_report(result.stdout)
    assert rows, f"`zimi config` printed nothing parseable:\n{result.stdout}"

    for setting, expected in (("host", "127.0.0.1"), ("port", "8911")):
        assert setting in rows, f"{setting} missing from the report:\n{result.stdout}"
        value, source = rows[setting]
        assert value == expected, f"{setting} resolved to {value!r}, not {expected!r}"
        assert (
            source == f"config file: {config_path}"
        ), f"{setting} came from the config file but is attributed to {source!r}"

    assert rows["zim_dir"][1] == f"config file: {config_path}"
    # Nothing invented a provenance it cannot justify.
    assert all(source for _value, source in rows.values())


def test_an_env_var_out_ranks_the_config_file(tmp_path):
    zim_dir = tmp_path / "zims"
    zim_dir.mkdir()
    config_path = tmp_path / "zimi.json"
    config_path.write_text(json.dumps({"host": "127.0.0.1"}))

    env = clean_env(ZIMI_HOST="10.0.0.5")
    result = subprocess.run(
        [sys.executable, "-m", "zimi", "config", "--config", str(config_path)],
        cwd=REPO_ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    rows = _parse_config_report(result.stdout)
    assert rows["host"] == ("10.0.0.5", "env: ZIMI_HOST")


def test_an_offline_boot_makes_no_outbound_connection(gate_library, tmp_path_factory):
    """The air-gap promise, proved: every non-loopback connect is recorded and
    refused, and the recording must stay empty across a real session."""
    root = tmp_path_factory.mktemp("gate-offline")
    launcher = root / "guarded_boot.py"
    launcher.write_text(_NET_GUARD_LAUNCHER)
    netlog = root / "outbound.log"

    env = clean_env(ZIMI_GATE_NETLOG=str(netlog), ZIMI_OFFLINE="1")

    with boot(
        zim_dir=gate_library,
        data_dir=str(root / "data"),
        env=env,
        launcher=str(launcher),
    ) as server:
        assert os.path.exists(
            str(netlog) + ".installed"
        ), "the network guard never loaded — this check would pass vacuously"
        # Every surface that reaches the internet on a connected instance.
        for path in (
            "/health",
            "/list",
            "/manage/status",
            "/manage/catalog?count=5",
            "/manage/app-update?force=1",
            "/manage/updates",
            "/manage/bt-status",
            "/search?q=water&limit=5",
        ):
            status, _headers, _body = server.get(path)
            assert status < 500, f"{path} returned {status} on an offline instance"

        attempts = netlog.read_text() if netlog.exists() else ""
        assert attempts == "", (
            "ZIMI_OFFLINE=1 still tried to reach the network:\n" + attempts
        )


def test_offline_is_reported_to_the_ui(gate_library, tmp_path_factory):
    root = tmp_path_factory.mktemp("gate-offline-flag")
    with boot(
        zim_dir=gate_library,
        data_dir=str(root / "data"),
        env=clean_env(ZIMI_OFFLINE="1"),
    ) as server:
        status, body = server.get_json("/manage/create/status")
        assert status == 200
        assert (
            body.get("offline") is True
        ), "the Create page would offer network modes on an air-gapped box"
