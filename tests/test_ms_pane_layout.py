"""Settings panes cannot be made wider than the card by their content (#150).

A flex item's automatic minimum width is its widest unbreakable line. The Capture pane's install
commands are nowrap and carry the folder Zimi sits in, so on a machine with a long enough path the
pane outgrew its card, which clips: switches cut off, lower sections unreachable. Reproduced in
Firefox at 734 px; min-width:0 on the pane fixes it.
"""

import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _read(*parts):
    with open(os.path.join(ROOT, *parts), encoding="utf-8") as f:
        return f.read()


def test_the_settings_pane_may_shrink_below_its_widest_line():
    rule = re.search(
        r"^\s*\.ms-pane \{ flex: 1;[^}]*\}", _read("zimi", "static", "app.css"), re.M
    )
    assert rule and "min-width: 0" in rule.group(0)


def test_capture_defaults_use_the_one_switch_size():
    assert "switch-sm" not in _read("zimi", "static", "create.js")
