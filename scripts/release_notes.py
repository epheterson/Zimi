#!/usr/bin/env python3
"""The GitHub release body for a version, from CHANGELOG.md.

Desktop Release calls this: ``release_notes.py 1.14.1 > notes.md``.

A version's section may open with a ``### Highlights`` block of one to three
short sentences. The release body is then that block plus one line linking the
full entry in the CHANGELOG at the version's tag. A section without the block
is used whole, as it always was, and a version with no section at all gets a
bare "Release vX.Y.Z".
"""

import re
import sys

REPO_URL = "https://github.com/epheterson/zimi"
HIGHLIGHTS_HEADING = "### Highlights"


def _section(changelog, version):
    """The lines under ``## [version]``, up to the next ``## [`` heading, and
    the heading itself; ``(None, [])`` when the version has no section."""
    heading, body = None, []
    for line in changelog.splitlines():
        if heading is None:
            if line.startswith("## [%s]" % version):
                heading = line
        elif line.startswith("## ["):
            break
        else:
            body.append(line)
    return heading, body


def _highlights(body):
    """The text of a leading ``### Highlights`` block, or ``""``."""
    lines = iter(body)
    for line in lines:
        if line.strip():
            if line.strip() != HIGHLIGHTS_HEADING:
                return ""
            break
    text = []
    for line in lines:
        if line.startswith("### "):
            break
        text.append(line)
    return "\n".join(text).strip()


def heading_anchor(heading):
    """The fragment GitHub generates for a heading: lowercase, anything but
    letters, digits, spaces, hyphens and underscores dropped, spaces to
    hyphens. ``## [1.14.1] - 2026-10-20`` becomes ``1141---2026-10-20``."""
    text = heading.lstrip("#").strip().lower()
    return re.sub(r"[^\w\- ]", "", text).replace(" ", "-")


def release_body(changelog, version, repo_url=REPO_URL):
    heading, body = _section(changelog, version)
    if heading is None:
        return "Release v%s" % version
    highlights = _highlights(body)
    if not highlights:
        return "\n".join(body).strip() or "Release v%s" % version
    link = "%s/blob/v%s/CHANGELOG.md#%s" % (repo_url, version, heading_anchor(heading))
    return "%s\n\n[Full changelog for v%s](%s)" % (highlights, version, link)


def main(argv):
    if len(argv) not in (2, 3):
        sys.stderr.write("usage: release_notes.py VERSION [CHANGELOG.md]\n")
        return 2
    with open(argv[2] if len(argv) == 3 else "CHANGELOG.md", encoding="utf-8") as f:
        print(release_body(f.read(), argv[1]))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
