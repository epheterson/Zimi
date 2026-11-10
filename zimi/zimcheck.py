"""``zimi check``: is this ZIM well formed, the way openZIM's zimcheck asks.

One file in, a list of findings out. It runs the checks that zim-tools'
``zimcheck`` is used for, with the same tables Zimi writes its own ZIMs by
(zimwriter's mandatory metadata, caps and the 48x48 illustration):

  checksum    the file's own checksum (``zimcheck -C``)
  main        a main page that exists
  metadata    every mandatory key, in its format and length (``-M``)
  icon        a 48x48 illustration
  redirects   a redirect that points at nothing
  links       an internal link in a page that resolves to no entry (``-U``)

Findings are errors (a reader may fail on it) or warnings (a library may
mislabel it). Nothing here changes the file. The link scan reads every page,
so ``quick`` leaves it, and the checksum, out.
"""

import logging
import posixpath
import re
import struct
import sys

from zimi.libzimcompat import entry_by_id

log = logging.getLogger("zimi.zimcheck")

ERROR, WARNING = "error", "warning"
MANDATORY = (
    "Name",
    "Title",
    "Language",
    "Creator",
    "Publisher",
    "Date",
    "Description",
    "Illustration_48x48@1",
)
LANGUAGE_RE = re.compile(r"^[a-z]{3}(,[a-z]{3})*$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
# The references inside tags only: a script's `a.href = "x/"` is code, not a link.
NON_MARKUP_RE = re.compile(r"<(script|style)\b.*?</\1>|<!--.*?-->", re.I | re.S)
HREF_RE = re.compile(r"""<[a-z][^>]*?\s(?:href|src)\s*=\s*["']([^"']*)["']""", re.I)
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
# A page with a thousand broken links is one finding, not a thousand lines.
MAX_LINK_FINDINGS = 25
ILLUSTRATION_SIZE = 48


def _finding(level, check, message):
    return {"level": level, "check": check, "message": message}


def _text(archive, key):
    try:
        return bytes(archive.get_metadata(key)).decode("utf-8", "replace")
    except Exception:
        return ""


def _check_metadata(archive):
    from zimi import zimwriter as zw

    out = []
    for key in MANDATORY:
        if key not in archive.metadata_keys:
            out.append(_finding(ERROR, "metadata", f"{key} is missing"))
        elif not _text(archive, key) and key != "Illustration_48x48@1":
            out.append(_finding(ERROR, "metadata", f"{key} is empty"))
    title, description = _text(archive, "Title"), _text(archive, "Description")
    if title and len(title) > zw.MAX_TITLE_LENGTH:
        out.append(
            _finding(
                ERROR,
                "metadata",
                f"Title is {len(title)} characters, the limit is {zw.MAX_TITLE_LENGTH}",
            )
        )
    if description and len(description) > zw.MAX_DESCRIPTION_LENGTH:
        out.append(
            _finding(
                ERROR,
                "metadata",
                f"Description is {len(description)} characters, the limit is {zw.MAX_DESCRIPTION_LENGTH}",
            )
        )
    long_text = _text(archive, "LongDescription")
    if long_text and len(long_text) < len(description):
        out.append(
            _finding(ERROR, "metadata", "LongDescription is shorter than Description")
        )
    language = _text(archive, "Language")
    if language and not LANGUAGE_RE.match(language):
        out.append(
            _finding(
                ERROR,
                "metadata",
                f"Language {language!r} is not ISO 639-3 (eng, or eng,fra)",
            )
        )
    date = _text(archive, "Date")
    if date and not DATE_RE.match(date):
        out.append(_finding(ERROR, "metadata", f"Date {date!r} is not YYYY-MM-DD"))
    return out


def _check_icon(archive):
    try:
        item = archive.get_metadata_item("Illustration_48x48@1")
        png = bytes(item.content)
    except Exception:
        return []  # the metadata check already says it is missing
    if png[:8] != PNG_MAGIC:
        return [_finding(ERROR, "icon", "the 48x48 illustration is not a PNG")]
    size = struct.unpack(">II", png[16:24])
    if size != (ILLUSTRATION_SIZE, ILLUSTRATION_SIZE):
        return [_finding(ERROR, "icon", "the 48x48 illustration is %dx%d" % size)]
    return []


def _resolve(base_path, ref):
    """A page's reference as an entry path, or None for what is not one (an
    address, data, a mailto, an anchor)."""
    ref = ref.split("#", 1)[0].split("?", 1)[0].strip()
    if not ref or ref.startswith("//") or re.match(r"^[a-z][a-z0-9+.-]*:", ref, re.I):
        return None
    if ref.startswith("/"):
        return ref.lstrip("/")
    resolved = posixpath.normpath(
        posixpath.join(posixpath.dirname(base_path), ref)
    ).lstrip("/")
    while resolved.startswith("../"):
        resolved = resolved[3:]
    return None if resolved in ("", ".", "..") else resolved


def _walk(archive, links):
    """Redirects to nothing, and (when asked) internal references to nothing."""
    out, dangling = [], 0
    for i in range(archive.all_entry_count):
        entry = entry_by_id(archive, i)
        if entry.is_redirect:
            try:
                entry.get_redirect_entry()
            except Exception:
                out.append(
                    _finding(ERROR, "redirects", f"{entry.path} redirects to nothing")
                )
            continue
        if not links:
            continue
        item = entry.get_item()
        if item.mimetype != "text/html":
            continue
        html = NON_MARKUP_RE.sub("", bytes(item.content).decode("utf-8", "replace"))
        for ref in dict.fromkeys(HREF_RE.findall(html)):
            target = _resolve(entry.path, ref)
            if target and not archive.has_entry_by_path(target):
                dangling += 1
                if dangling <= MAX_LINK_FINDINGS:
                    out.append(
                        _finding(
                            ERROR,
                            "links",
                            f"{entry.path} links to {ref}, which is not in the ZIM",
                        )
                    )
    if dangling > MAX_LINK_FINDINGS:
        out.append(
            _finding(
                ERROR,
                "links",
                f"... and {dangling - MAX_LINK_FINDINGS} more broken links",
            )
        )
    return out


def check(path, quick=False):
    """Every finding for the ZIM at ``path``; an empty list is a clean bill."""
    from libzim.reader import Archive

    try:
        archive = Archive(path)
    except Exception as e:
        return [_finding(ERROR, "open", f"cannot be opened: {e}")]
    out = []
    if not quick:
        try:
            if archive.has_checksum and not archive.check():
                out.append(
                    _finding(
                        ERROR, "checksum", "the file does not match its own checksum"
                    )
                )
        except Exception as e:
            out.append(
                _finding(ERROR, "checksum", f"the checksum could not be verified: {e}")
            )
    if not archive.has_main_entry:
        out.append(_finding(WARNING, "main", "there is no main page"))
    else:
        try:
            archive.main_entry.get_item()
        except Exception:
            out.append(_finding(ERROR, "main", "the main page points at nothing"))
    out += _check_metadata(archive)
    out += _check_icon(archive)
    out += _walk(archive, links=not quick)
    return out


def cli_check(args):
    """``zimi check FILE...``: print findings per file, exit 1 when any is an error."""
    failed = False
    for path in args.files:
        findings = check(path, quick=args.quick)
        errors = [f for f in findings if f["level"] == ERROR]
        failed = failed or bool(errors)
        print(
            f"{path}: {'ok' if not findings else '%d errors, %d warnings' % (len(errors), len(findings) - len(errors))}"
        )
        for f in findings:
            print(f"  {f['level']:7s} {f['check']:9s} {f['message']}")
    if failed:
        sys.exit(1)
