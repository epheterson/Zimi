"""What the environment is overriding, so an admin can see it.

Zimi reads fifty-odd environment variables, and most of them silently win over
a control in Settings. Until now the only way to discover one was to click a
greyed-out widget and read the hint beside it, if there was a hint.

Issue #69 is what that costs. Someone reported the update frequency was "stuck
on daily and isn't changeable", we spent a release making the control explain
itself, they came back still puzzled, and the answer was ZIMI_AUTO_UPDATE set
in their own launcher. Nobody could see it, so nobody could say so.

This module is the list. It answers "what is overriding my settings" and
nothing else: it never writes, and it deliberately reports only variables
actually present in the environment, because the interesting number is usually
zero and a wall of fifty defaults would bury the one that matters.

The table below must name every variable Zimi reads. tests/test_envinfo.py
walks the source for ZIMI_* literals and fails if one is missing, because a
panel that quietly goes stale is worse than no panel: it would answer "nothing
is overridden" while something was.
"""

import os
import re

__all__ = ["effective", "known_names", "VARS"]

# Secrets never leave the process. Two are known by name, and anything that
# LOOKS like a credential is masked too — a variable added later is covered
# before anyone remembers to come back here and flag it.
_SECRET_RE = re.compile(r"TOKEN|PASSWORD|SECRET|_KEY$", re.IGNORECASE)
_MASKED = "set"

# name -> (what it does, which Settings control it takes over)
# The second field is empty when a variable configures something with no UI of
# its own. Better blank than a guess: this panel exists to be trusted.
VARS: dict[str, tuple[str, str]] = {
    # ── access and identity ───────────────────────────────────────────────
    "ZIMI_MANAGE": ("Enables the admin interface", ""),
    "ZIMI_MANAGE_PASSWORD": ("Admin password", "Set password"),
    "ZIMI_MANAGE_USER": ("Admin username", "Set password"),
    "ZIMI_MANAGE_OPEN": ("Leaves the admin interface unauthenticated", "Set password"),
    "ZIMI_API_TOKEN": ("Bearer token for the API", "API token"),
    "ZIMI_PUBLIC_ACCESS": ("Who may read: open, limited or private", "Access"),
    "ZIMI_LAN_ADMIN": ("Treats direct LAN clients as admin", "Access"),
    "ZIMI_SSO_PROXY": ("Trusted SSO proxy (Cloudflare Access)", "Single sign-on"),
    "ZIMI_SSO_AUD": ("SSO audience tag to require", "Single sign-on"),
    "ZIMI_SSO_TEAM": ("SSO team domain", "Single sign-on"),
    "ZIMI_SSO_ROLE": ("Role given to users arriving via SSO", "Single sign-on"),
    "ZIMI_TRUSTED_PROXIES": ("Proxies whose forwarded-for header is believed", ""),
    "ZIMI_TRUST_CGNAT": ("Treats carrier-grade NAT ranges as private", ""),
    # ── where things live ─────────────────────────────────────────────────
    "ZIMI_CONFIG": ("Path to the config file", ""),
    "ZIM_DIR": ("Where the ZIM files are", "ZIM folder"),
    "ZIMI_DATA_DIR": ("Where Zimi keeps its own data", "Data folder"),
    "ZIMI_STAGING_DIR": ("Where downloads are assembled", ""),
    "ZIMI_CREATE_ROOT": ("Where the Create page looks for archives to import (the library folder when unset)", ""),
    "ZIMI_HOST": ("Address the server binds to", ""),
    "ZIMI_PORT": ("Port the server binds to", "Port"),
    # ── updates ───────────────────────────────────────────────────────────
    "ZIMI_AUTO_UPDATE": ("Keeps installed ZIMs up to date", "Auto-update"),
    "ZIMI_UPDATE_FREQ": ("How often to check for ZIM updates", "Frequency"),
    "ZIMI_UPDATE_CHANNEL": ("App update channel: stable or beta", "App updates"),
    "ZIMI_UPDATE_DELAY_DAYS": (
        "Waits this long before taking an app update",
        "App updates",
    ),
    "ZIMI_INSTALL_TYPE": ("How Zimi was installed, for the updater", ""),
    # ── downloads ─────────────────────────────────────────────────────────
    "ZIMI_MAX_CONCURRENT_DOWNLOADS": (
        "How many downloads run at once",
        "Max downloads",
    ),
    "ZIMI_DL_WINDOW": (
        "Hours downloads are allowed, as HH:MM-HH:MM",
        "Download window",
    ),
    # ── sharing: BitTorrent ───────────────────────────────────────────────
    "ZIMI_OFFLINE": ("Air-gap switch: turns off everything internet-bound", "Sharing"),
    "ZIMI_APPS": ("The apps row (Maps, ZimiTube, ZimiExchange, Reddot) on the home page; 0 hides it for everyone", "Apps"),
    # ── the desktop app ────────────────────────────────────────────────────
    "ZIMI_DESKTOP_BROWSER": ("1 runs the desktop app in the system browser instead of a native window", "Desktop"),
    "ZIMI_APPCAST_URL": ("Where the Windows desktop app looks for updates", "Desktop"),
    "ZIMI_DESKTOP_SMOKE": ("CI: 1 opens a window and exits; app renders the home view and exits", "Desktop"),
    "ZIMI_DESKTOP_SMOKE_DWELL": ("CI: seconds the smoke window stays open for a screenshot", "Desktop"),
    "ZIMI_DESKTOP_DEBUG": ("1 opens the desktop window with the page's console on stdout and the inspector", "Desktop"),
    "ZIMI_DESKTOP_KEEP_MARK": ("CI: 1 leaves the mark of the web on the Windows zip's libraries", "Desktop"),
    "ZIMI_BT": ("BitTorrent settings, as one blob", "BitTorrent"),
    "ZIMI_TORRENT": ("Turns BitTorrent on or off", "BitTorrent"),
    "ZIMI_BT_PORT": ("Inbound BitTorrent port", "Port"),
    "ZIMI_BT_UP_KB": ("Upload limit, KB/s", "Upload limit"),
    "ZIMI_BT_DOWN_KB": ("Download limit, KB/s", "Download limit"),
    "ZIMI_DHT": ("Distributed hash table lookups", "BitTorrent"),
    "ZIMI_SEED": ("Seeds what you have downloaded", "Seeding"),
    "ZIMI_SEED_RATIO": ("Stops seeding at this ratio", "Seed ratio"),
    "ZIMI_SEED_DISK_PCT": ("Stops seeding when the disk is this full", "Seeding"),
    "ZIMI_MIRROR": ("Seeds the whole library and mirrors the catalog", "Mirror"),
    "ZIMI_MIRROR_RATIO": ("Seed ratio while mirroring", "Mirror"),
    "ZIMI_MIRROR_UPLOAD_KB": ("Upload limit while mirroring, KB/s", "Mirror"),
    # ── sharing: the local network ────────────────────────────────────────
    "ZIMI_NEARBY": ("Nearby sharing settings, as one blob", "Nearby"),
    "ZIMI_PEER_DISCOVERY": ("Announces this Zimi on the local network", "Nearby"),
    "ZIMI_PEER_SHARE": ("Lets nearby Zimis pull ZIMs from this one", "Nearby"),
    "ZIMI_PEER_SHARE_PUBLIC": ("Shares beyond the local network too", "Nearby"),
    "ZIMI_PEER_NAME": ("Name this Zimi announces itself under", "Server name"),
    # ── performance and limits ────────────────────────────────────────────
    "ZIMI_HOT_ZIMS": ("ZIMs to keep warm, so the first search is fast", ""),
    "ZIMI_INDEX_THROTTLE": ("Slows index building to spare the disk", ""),
    "ZIMI_RATE_LIMIT": ("Requests per minute, anonymous", ""),
    "ZIMI_RATE_LIMIT_TRUSTED": ("Requests per minute, signed in", ""),
    "ZIMI_RATE_LIMIT_LOGIN": ("Login attempts per minute", ""),
    # ── capture ───────────────────────────────────────────────────────────
    "ZIMI_BEHAVIORS": ("Path to browsertrix-behaviors, for capture", ""),
}

# Names that appear in the source as ZIMI_* but are not environment variables.
# Listed so the coverage test can tell "not a variable" from "forgotten".
NOT_ENV = {
    # A module attribute read with getattr(_srv, "ZIMI_VERSION"), not os.environ.
    "ZIMI_VERSION",
}


def known_names() -> set[str]:
    return set(VARS)


def is_secret(name: str) -> bool:
    return bool(_SECRET_RE.search(name))


def effective(environ=None, published=None) -> list[dict]:
    """Every known variable actually set, in the table's order.

    Table order, not alphabetical: it groups by what the variable affects, and
    an admin reading three rows wants them grouped the way the settings are.

    Secrets report the string "set" and never their value. A variable present
    but empty still counts as set — that is the subtlety behind #69, where
    merely HAVING ZIMI_AUTO_UPDATE in the environment locks the control
    whatever it is set to.
    """
    env = os.environ if environ is None else environ
    published = published or {}
    rows = []
    for name, (description, locks) in VARS.items():
        if name not in env:
            continue
        rows.append(
            {
                "name": name,
                "value": _MASKED if is_secret(name) else env[name],
                "secret": is_secret(name),
                "description": description,
                "locks": locks,
                # apply_env_settings publishes config-file values into the
                # environment; they are the file's, and the row says so.
                "source": "config" if name in published else "env",
                "path": published.get(name, "") if name in published else "",
            }
        )
    return rows
