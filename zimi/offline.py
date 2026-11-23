"""Offline Readiness: everything that needs a download before Zimi works fully with no internet, in one list.

"I'm worried folks will set this up and then go into an offline area and feel like they're
missing out." Each piece already has its own store and its own install (add-ons, Almanac HD, voices, satellite data);
this reads their answers side by side and invents no state of its own. Nothing here reads the network or starts a
download: a row says what is here, what is missing, its size, and the request that would fetch it, which the page
sends to that piece's own endpoint.

A row: ``id``, ``group``, ``here``, ``bytes`` (0 when small or unknown), ``get`` (``{"path", "body"}`` to POST) and,
when it cannot be fetched now, ``why``: "offline" (ZIMI_OFFLINE), "never" (that piece's setting), "unsupported"
(this install brings its own) or "unavailable" (no file for this version).
"""

import logging
from zimi import outbound

log = logging.getLogger("zimi")

OFFLINE = "offline"
NEVER = "never"
UNSUPPORTED = "unsupported"
UNAVAILABLE = "unavailable"


def _why(mode, locked):
    """Why a piece cannot be fetched under its setting, or None."""
    if mode != outbound.NEVER:
        return None
    return OFFLINE if locked == outbound.LOCKED_OFFLINE else NEVER


def _row(rid, group, here, size=0, get=None, why=None, **extra):
    row = {"id": rid, "group": group, "here": bool(here), "bytes": int(size or 0)}
    if not here:
        row["get"] = get
        if why:
            row["why"] = why
    row.update(extra)
    return row


def _coming(done, total):
    """A piece being fetched now: ``{"busy": True, "done", "total"}`` for a progress bar."""
    return {"busy": True, "done": int(done or 0), "total": int(total or 0)}


def _addon_rows():
    from zimi import addons

    st = addons.status()
    never = _why(st["mode"], st["locked"])
    out = []
    for a in st["addons"]:
        if a.get("absent") and not a["ready"]:
            continue  # this kind of install can never have it (a desktop app): not a thing it is missing
        p = a.get("progress") or {}
        coming = _coming(p.get("done"), p.get("total")) if p.get("active") else {}
        why = (
            None
            if a["ready"]
            else (never or (None if st["supported"] else UNSUPPORTED))
        )
        out.append(
            _row(
                "addon:" + a["key"],
                "addon",
                a["ready"],
                a["size"],
                {"path": "/manage/addons", "body": {"install": a["key"]}},
                why,
                key=a["key"],
                requires=a["requires"],
                **({"note": a["note"]} if a.get("note") else {}),
                **coming,
            )
        )
    return out


def _almanac_hd_row():
    from zimi import almanachd

    st = almanachd.status()
    offer = st["offers"].get("hd") or {}
    why = _why(st["mode"], st["locked"])
    if not why and not offer.get("size") and not st["installed"]:
        why = UNAVAILABLE
    dl = st.get("downloading") or {}
    return _row(
        "almanac_hd",
        "almanac",
        st["installed"],
        offer.get("size"),
        {"path": "/manage/almanac-hd", "body": {"start": True}},
        why,
        **(_coming(dl.get("done"), dl.get("size")) if dl else {}),
    )


def _voices_row(lang):
    """A voice better than the basic one for the person's language: a Natural or a Clear voice, here or fetchable."""
    from zimi import voices

    try:
        have = voices.installed()
        primary = voices._primary(lang or "en")
        mode, locked = voices.POLICY.mode()
        row = voices._lang_row(
            primary,
            have,
            voices.choices(),
            voices._usable(voices.PIPER) and mode != outbound.NEVER,
        )
    except Exception as e:
        log.debug("offline readiness: voices: %s: %s", type(e).__name__, e)
        return None
    here = any(e in (voices.KOKORO, voices.PIPER) for e in row["engines"])
    offer = row.get("piper")
    from zimi import runtimes

    way = runtimes.way_for("voices")
    if not here and way and way.how == runtimes.ABSENT:
        return None  # this kind of install carries no such voices
    if not here and not offer:
        return None  # nothing could be fetched for this language
    dl = voices.downloading()
    return _row(
        "voices",
        "voices",
        here,
        offer["bytes"] if offer else 0,
        (
            {"path": "/manage/voices/download", "body": {"lang": offer["tag"]}}
            if offer
            else None
        ),
        _why(mode, locked),
        lang=primary,
        **(_coming(dl.get("done"), dl.get("total")) if dl.get("tag") else {}),
    )


def _satellites_row():
    """Orbit data fresh enough for the Earth view; one that ships with Zimi is always there, so only a stale one asks."""
    from zimi import satellites

    st = satellites.get(allow_refresh=False)
    return _row(
        "satellites",
        "almanac",
        not st["stale"],
        0,
        {"path": "/manage/satellites/refresh", "body": {}},
        _why(st["mode"], st["locked"]),
    )


def _maps_row():
    """A map of where you are, for the Almanac's Earth and Zimi's places: any ZIM the scan knows as a map. A map of here
    is the person's to choose, so a row without one leads to the catalog and never fetches for them.
    """
    from zimi import server

    zim = next(
        (n for n in server.get_zim_files() if server._zim_kind_of(n) == "map"), None
    )
    return _row("maps", "almanac", zim, choose=True, zim=zim)


#: The list's order, one place: Zimi's own pieces that help offline, Create's extras (the add-ons) last.
ORDER = ("almanac_hd", "maps", "voices", "satellites", "addon")


def _rank(row):
    for i, key in enumerate(ORDER):
        if row["id"] == key or row["group"] == key:
            return i
    return len(ORDER)


def readiness(lang="en"):
    """{"offline": ZIMI_OFFLINE is on, "items": [row, ...]} for the "Offline Readiness" list, in ORDER."""
    items = []
    for build in (_almanac_hd_row, _satellites_row, _maps_row):
        try:
            items.append(build())
        except Exception as e:
            log.debug(
                "offline readiness: %s: %s: %s", build.__name__, type(e).__name__, e
            )
    voices_row = _voices_row(lang)
    if voices_row:
        items.append(voices_row)
    items = sorted(
        items + _addon_rows(), key=_rank
    )  # stable: add-ons keep their own order
    from zimi import runtimes

    # config_kept: False when a container's data folder is not on a volume (told once, in the list); None elsewhere.
    return {
        "offline": _offline(),
        "items": items,
        "config_kept": runtimes.config_kept(),
    }


def _offline():
    from zimi import addons

    return addons.POLICY.mode()[1] == outbound.LOCKED_OFFLINE
