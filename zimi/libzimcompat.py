"""The one place that knows libzim 3.x from 4.x.

python-libzim 4.0 renamed what Zimi walks entries and searches with
(``_get_entry_by_id`` became ``get_entry_by_id``; ``getEstimatedMatches`` and
``getResults`` became ``get_estimated_matches`` and ``get_results``), made a
search hit an object with a ``path`` where 3.x yielded the bare path, and
moved ``Creator.add_illustration`` from ``(size, content)`` to
``(content, width)``. Everything else Zimi uses is the same in both. Callers
use these helpers and never branch on the version themselves; the old names are
tried first so a test double written against 3.x still works.
"""

from importlib import metadata



def _libzim_major():
    """The writer's argument order cannot be told from the method, so it comes
    from the installed version, or, where the package carries no metadata (a
    PyInstaller bundle), from the reader's 4.0 rename."""
    try:
        return int(metadata.version("libzim").split(".")[0])
    except (metadata.PackageNotFoundError, ValueError):
        pass
    try:
        from libzim.reader import Archive
    except ImportError:
        return 3
    return 3 if hasattr(Archive, "_get_entry_by_id") else 4


LIBZIM_MAJOR = _libzim_major()


def _first(obj, *names):
    for name in names:
        method = getattr(obj, name, None)
        if method is not None:
            return method
    raise AttributeError(names[0])


def entry_by_id(archive, index):
    """The entry at position ``index`` in the archive's own order."""
    return _first(archive, "_get_entry_by_id", "get_entry_by_id")(index)


def can_walk_entries(archive):
    return hasattr(archive, "_get_entry_by_id") or hasattr(archive, "get_entry_by_id")


def estimated_matches(search):
    """How many hits a Search or SuggestionSearch reports."""
    return _first(search, "getEstimatedMatches", "get_estimated_matches")()


def result_paths(search, start, count):
    """The paths of ``count`` hits from ``start``, as strings in either version."""
    hits = _first(search, "getResults", "get_results")(start, count)
    return [getattr(hit, "path", hit) for hit in hits]


def add_illustration(creator, size, content):
    """Add a square PNG illustration of ``size`` CSS pixels at scale 1."""
    if LIBZIM_MAJOR >= 4:
        creator.add_illustration(content, size)
    else:
        creator.add_illustration(size, content)
