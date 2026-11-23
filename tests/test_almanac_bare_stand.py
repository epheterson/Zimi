"""Hide controls on the ground (Stand here) hides the rover and the phone's buttons too."""

import os

STAND = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "zimi", "static", "almanac-stand.js")


def test_hide_controls_covers_the_rover_and_phone_buttons():
    src = open(STAND, encoding="utf-8").read()
    rule = [ln for ln in src.splitlines() if ".ae-view.ae-bare .ae-stand-drive" in ln]
    assert rule and ".ae-view.ae-bare .ae-stand-motion" in rule[0] and "visibility:hidden" in rule[0]
