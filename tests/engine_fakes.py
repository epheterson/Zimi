"""A MagicMock BitTorrent engine that behaves like the built-in one where the
download loop asks how to find and install a finished file."""

import os
from unittest.mock import MagicMock

from zimi.p2p import BTBackend


def engine_mock():
    m = MagicMock()
    m.external = False
    m.retired = False
    m.payload_path.side_effect = lambda tid, filename, staging_dir: os.path.join(staging_dir, filename)
    m.install.side_effect = lambda tid, src, dest: BTBackend.install(m, tid, src, dest)
    return m
