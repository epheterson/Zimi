"""What Zimi fetches from the internet, and the settings that decide it.

Eric, 2026-09-28: "i'm not positive how i feel about unexpected network calls
from zimi, maybe that update should be optional or at least controllable".

Two things live here:

``FetchPolicy``
    One "from the internet" setting with three answers: Ask first (nothing is
    fetched until an admin asks), Automatically, Never. Its environment
    variable wins over the saved choice, and ZIMI_OFFLINE forces Never over
    both. The satellite data and the Zimi update check are both one of
    these, so they read, lock and save the same way.

``inventory()``
    Every destination Zimi can reach beyond this machine and its network, one
    row each, with what sets it off and whether it is on right now. Server
    settings lists it under "What Zimi fetches from the internet", and
    docs/features/operations.md carries the same table. ``SOURCES`` names the
    modules that open an outbound connection; tests/test_outbound.py walks
    the package and fails when a module reaches out without being listed
    here, because a list that quietly goes stale would answer "nothing else"
    while something was.
"""

import logging
import os

log = logging.getLogger("zimi")

__all__ = ["FetchPolicy", "inventory", "normalize_mode", "SOURCES"]

ASK = "ask"
AUTO = "auto"
NEVER = "never"
MODES = (ASK, AUTO, NEVER)
LOCKED_ENV = "env"
LOCKED_OFFLINE = "offline"

# A row's state: what happens without anyone asking.
STATE_AUTO = "auto"  # on its own: at startup, on a schedule, or while seeding
STATE_ASK = "ask"  # only when someone asks (a click, a download, a capture)
STATE_OFF = "off"  # never, or the feature is off
STATE_UNSET = "unset"  # not set up on this server
STATE_LAN = "lan"  # on, and never leaves the local network


def _offline():
    from zimi import p2p

    return bool(p2p.is_offline())


def normalize_mode(value):
    """'Auto ' -> 'auto'; anything that is not a mode -> None."""
    name = str(value or "").strip().lower()
    return name if name in MODES else None


class FetchPolicy:
    """Ask first / Automatically / Never for one thing Zimi fetches.

    Saved beside the other server-wide choices, in the app-update prefs file
    (manage._read_app_update_prefs). ``offline`` is how this policy reads
    ZIMI_OFFLINE; a module passes its own reader so its tests can stand in
    for it."""

    def __init__(self, env, prefs_key, default, name, offline=None):
        self.env = env
        self.prefs_key = prefs_key
        self.default = default
        self.name = name
        self._offline = offline or _offline

    def mode(self, prefs=None):
        """``(mode, locked)``: locked is "offline" (ZIMI_OFFLINE: never),
        "env" (the variable names a mode) or None, when the saved choice or
        the default decides. ``prefs`` is the saved choices, for a caller
        that has read them from somewhere other than this server's data
        directory (the desktop app, before its server is up)."""
        if self._offline():
            return NEVER, LOCKED_OFFLINE
        from_env = normalize_mode(os.environ.get(self.env))
        if from_env:
            return from_env, LOCKED_ENV
        if prefs is None:
            from zimi import manage

            prefs = manage._read_app_update_prefs()
        return normalize_mode(prefs.get(self.prefs_key)) or self.default, None

    def setting(self):
        """The setting as Server settings shows it."""
        mode, locked = self.mode()
        return {"mode": mode, "locked": locked, "choices": list(MODES), "env": self.env}

    def set(self, value):
        """Save the choice. ``(mode, error)``: error is "invalid", "env" or
        "offline" (the choice is not the setting's to make), or "unwritable"."""
        mode = normalize_mode(value)
        if not mode:
            return None, "invalid"
        _, locked = self.mode()
        if locked:
            return None, locked
        from zimi import manage

        manage._write_app_update_prefs(**{self.prefs_key: mode})
        # A failed write logs itself; read back so a choice that did not land
        # is never reported as made.
        if self.mode()[0] != mode:
            return None, "unwritable"
        log.info("%s: %s", self.name, mode)
        return mode, None


# Every module that opens a connection beyond this machine, and the row that
# accounts for it. The coverage test reads this.
SOURCES = {
    "library": ("catalog", "downloads", "bittorrent"),
    "p2p": ("bittorrent",),
    "p2p_nat": ("portcheck", "bittorrent"),
    "p2p_discovery": ("nearby",),
    "manage": ("app_updates",),
    "desktop": ("app_updates",),
    "winsparkle": ("app_updates",),
    "satellites": ("satellites",),
    "streetzim": ("streetzim",),
    "sso": ("sso",),
    # Captures: the page, site, video or subreddit someone named, and the
    # helpers they install on first use (pip, Docker, a browser).
    "creator": ("create",),
    "crawler": ("create",),
    "renderer": ("create",),
    "alive": ("create",),
    "singlefile": ("create",),
    "importer": ("create",),
    "video": ("create",),
    "reddot": ("create",),
}


def _mode_state(mode):
    return {AUTO: STATE_AUTO, ASK: STATE_ASK}.get(mode, STATE_OFF)


def inventory():
    """One row per destination, in the order Server settings lists them.

    ``{id, hosts, state, control}``. The words (name, when it happens) are
    the client's, keyed by id, so they read in the reader's language;
    ``hosts`` are names nobody translates. ``control`` says where the switch
    is: a setting in Server settings, "offline" when only ZIMI_OFFLINE turns
    it off, or "" when the person's own action is the control."""
    from zimi import library, manage, p2p, p2p_discovery, satellites, sso
    from zimi import server as _srv

    offline = _offline()

    def asked():
        return STATE_OFF if offline else STATE_ASK

    auto_update = bool(getattr(_srv, "_auto_update_enabled", False))
    bt_on = p2p.is_torrent_enabled() and p2p._lt() is not None
    seeds = p2p.is_seeding_enabled() or p2p.is_mirror_enabled()
    if not bt_on:
        bt_state = STATE_OFF
    else:
        bt_state = STATE_AUTO if seeds else STATE_ASK
    # The 12h upkeep refreshes the catalog only while something uses it
    # (Auto-update, Mirror, or someone browsed it this week): the same test.
    catalog = (
        STATE_AUTO if not offline and library._catalog_refresh_wanted() else asked()
    )
    sso_host = sso.team_base_url().split("://", 1)[-1]
    rows = [
        {
            "id": "catalog",
            "hosts": ["library.kiwix.org"],
            "state": catalog,
            "control": "offline",
        },
        {
            "id": "downloads",
            "hosts": ["download.kiwix.org"],
            "state": STATE_AUTO if (auto_update and not offline) else asked(),
            "control": "auto_update",
        },
        {"id": "bittorrent", "hosts": [], "state": bt_state, "control": "sharing"},
        {
            "id": "portcheck",
            "hosts": ["portcheck.transmissionbt.com"],
            "state": STATE_ASK if bt_on else STATE_OFF,
            "control": "sharing",
        },
        {
            "id": "app_updates",
            "hosts": ["api.github.com", "raw.githubusercontent.com"],
            "state": _mode_state(manage.UPDATE_CHECK.mode()[0]),
            "control": "update_check",
        },
        {
            "id": "satellites",
            "hosts": ["celestrak.org"],
            "state": _mode_state(satellites.update_mode()[0]),
            "control": "satellites",
        },
        {
            "id": "streetzim",
            "hosts": ["archive.org"],
            "state": asked(),
            "control": "offline",
        },
        {
            "id": "sso",
            "hosts": [sso_host] if sso_host else [],
            "state": (
                (STATE_OFF if offline else STATE_AUTO)
                if sso.is_configured()
                else STATE_UNSET
            ),
            "control": "",
        },
        {"id": "create", "hosts": [], "state": asked(), "control": ""},
        {
            "id": "nearby",
            "hosts": [],
            "state": STATE_LAN if p2p_discovery.is_enabled() else STATE_OFF,
            "control": "sharing",
        },
    ]
    return {"offline": offline, "rows": rows}
