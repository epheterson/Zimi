"""``zimi.winsparkle`` under its old name, for the tests and the spec."""

import os
import sys

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if not getattr(sys, "_MEIPASS", None) and _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

from zimi import winsparkle as _winsparkle  # noqa: E402

sys.modules[__name__] = _winsparkle
