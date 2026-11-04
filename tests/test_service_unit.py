"""The systemd unit a pip install runs Zimi with (#137).

The 1.15.2 proof followed the unit in a real systemd container and found it
worked, with two gaps: a pip user had no unit to copy (it lived only in the
repository), and /var/lib/zimi/zims, the unit's ZIM_DIR, was never made. It
also found state files written 0644 whatever the umask, over the unit's
UMask=0027.
"""

import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from zimi import service  # noqa: E402


def test_the_unit_ships_inside_the_package():
    assert os.path.isfile(service._TEMPLATE)
    with open(os.path.join(ROOT, "pyproject.toml"), encoding="utf-8") as f:
        assert '"assets/**"' in f.read(), "assets/ is no longer package data: the unit would not ship"


def test_the_unit_starts_this_python_and_makes_its_folders():
    text = service.unit_text("/var/lib/zimi/venv/bin/python")
    assert "ExecStart=/var/lib/zimi/venv/bin/python -m zimi serve --port 8899" in text
    assert "@PYTHON@" not in text
    state = [ln.split("=", 1)[1].split() for ln in text.splitlines() if ln.startswith("StateDirectory=")]
    assert state and "zimi/zims" in state[0] and "zimi/data" in state[0], state
    assert "Environment=ZIM_DIR=/var/lib/zimi/zims" in text
    assert "UMask=0027" in text


def test_print_and_install_from_the_command_line(tmp_path):
    out = subprocess.run([sys.executable, "-m", "zimi", "service", "print"], cwd=ROOT, capture_output=True, text=True)
    assert out.returncode == 0 and "ExecStart=" + sys.executable + " -m zimi serve" in out.stdout, out.stderr
    target = tmp_path / "zimi.service"
    out = subprocess.run([sys.executable, "-m", "zimi", "service", "install", "--to", str(target)], cwd=ROOT,
                         capture_output=True, text=True)
    assert out.returncode == 0, out.stderr
    assert target.read_text(encoding="utf-8") == service.unit_text()


def test_state_files_follow_the_umask(tmp_path):
    """Under the unit's UMask=0027 a state file is 0640, not 0644."""
    if not hasattr(os, "fchmod"):
        return  # Windows: no mode bits
    path = tmp_path / "state.json"
    code = (
        "import os; os.umask(0o027); import zimi.server as s; "
        "assert s._atomic_write_json(%r, {'a': 1}); print(oct(os.stat(%r).st_mode & 0o777))" % (str(path), str(path))
    )
    out = subprocess.run([sys.executable, "-c", code], cwd=ROOT, capture_output=True, text=True)
    assert out.returncode == 0, out.stderr
    assert out.stdout.strip() == "0o640", out.stdout
    assert json.loads(path.read_text(encoding="utf-8")) == {"a": 1}
