"""``zimi service``: the systemd unit that runs Zimi at boot after a pip install.

The unit ships inside the package (assets/zimi.service), so a pip user has it
without a checkout. ``print`` shows it, ``install`` writes it where systemd
looks; both point ExecStart at the Python this command runs under, which for
the documented install is /var/lib/zimi/venv/bin/python.
"""

import os
import sys

UNIT_PATH = "/etc/systemd/system/zimi.service"
_TEMPLATE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets", "zimi.service")


def unit_text(python=None):
    """The unit, with ExecStart on ``python`` (this interpreter by default)."""
    with open(_TEMPLATE, encoding="utf-8") as f:
        return f.read().replace("@PYTHON@", python or sys.executable)


def cli_service(args):
    text = unit_text()
    if args.action == "print":
        sys.stdout.write(text)
        return
    target = args.to or UNIT_PATH
    try:
        with open(target, "w", encoding="utf-8") as f:
            f.write(text)
    except PermissionError:
        sys.exit(f"zimi: cannot write {target}: run it with sudo (or --to a path you can write)")
    except OSError as e:
        sys.exit(f"zimi: cannot write {target}: {e.strerror}")
    print(f"Wrote {target}. Next: sudo systemctl daemon-reload && sudo systemctl enable --now zimi")
