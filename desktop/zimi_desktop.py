"""The desktop app's entry point, for PyInstaller and for a dev launch.

The app itself is ``zimi.desktop``, inside the package, so a ``pip install
zimi[desktop]`` has it too (``zimi desktop``). This file is the door the
build spec and ``python desktop/zimi_desktop.py`` come through; imported,
it IS that module, so ``import zimi_desktop`` in a test sees the real one.
"""

import os
import sys

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if not getattr(sys, "_MEIPASS", None) and _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

from zimi import desktop as _desktop  # noqa: E402

if __name__ == "__main__":
    _desktop.main()
else:
    sys.modules[__name__] = _desktop
