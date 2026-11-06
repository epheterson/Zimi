"""ZimCity's licence notices name files that ship beside them (the GPL's text is COPYING.txt in zimcity/)."""

import os
import re

DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "zimi", "builtin", "games", "zimcity")


def test_every_licence_file_a_notice_names_ships():
    text = open(os.path.join(DIR, "NOTICE-cities.txt"), encoding="utf-8").read()
    named = set(re.findall(r'the file "([A-Za-z.]+)"', text))
    assert named, "the notice names the GPL's file"
    for name in named:
        here = os.path.exists(os.path.join(DIR, name))
        mapped = re.search(r'"%s"[^\n]*is ([A-Za-z.]+) beside this file' % re.escape(name), text)
        assert here or (mapped and os.path.exists(os.path.join(DIR, mapped.group(1)))), name
