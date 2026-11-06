"""The portable headless build's entry point, for PyInstaller (desktop/zimi_portable.spec).

``./zimi serve``, ``./zimi service install``, ``./zimi doctor``: the whole command line of ``python -m zimi``,
with no Python on the machine and no window. ``portable`` tells ``zimi doctor`` and the updater which kind of
install this is; a person's own ZIMI_INSTALL_TYPE still wins."""

import multiprocessing
import os

os.environ.setdefault("ZIMI_INSTALL_TYPE", "portable")

from zimi.server import main  # noqa: E402

if __name__ == "__main__":
    multiprocessing.freeze_support()
    main()
