"""The folder-mode fixture for tests/test_create_folder.spec.mjs: a create
root holding a mixed folder (pages, a PDF with a sidecar and a cover, photos,
a film and a song with sidecars, a zimi.txt, and two files that are left
out) beside a second folder.

    python3 tests/make_folder_fixture.py <dir>    # makes <dir>/root and <dir>/zims

Needs Pillow; ffmpeg makes a real film and song when it is there.
"""

import sys
import os
import shutil
import subprocess

from PIL import Image

BASE = os.path.abspath(sys.argv[1])
root = os.path.join(BASE, "root")
zims = os.path.join(BASE, "zims")
for made in (root, zims):
    shutil.rmtree(made, ignore_errors=True)
os.makedirs(zims)


def png(path, color, size=(320, 240)):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    Image.new("RGB", size, color).save(path, "PNG")


def w(rel, text):
    p = os.path.join(root, rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w", encoding="utf-8") as f:
        f.write(text)


def _media(cmd, check=True):
    """A real file from ffmpeg, or a few bytes of the right name without it."""
    try:
        subprocess.run(cmd, check=check)
    except (OSError, subprocess.CalledProcessError):
        with open(cmd[-1], "wb") as f:
            f.write(b"\x00" * 64)


a = "Family Attic"
w(
    a + "/zimi.txt",
    "Title: The Family Attic\nDescription: Letters, photos and films from the attic\nCreator: The Lees\nPublisher: Lee Press\nTags: family; photos\nIcon: icon.png\n",
)
png(os.path.join(root, a, "icon.png"), (200, 60, 40), (96, 96))
w(
    a + "/letter-1962.txt",
    "Dear all,\n\nThe attic is full of boxes. I found the old films.\n\nLove,\nAnn\n",
)
w(a + "/notes.md", "# Notes on the attic\n\n- the films\n- the photos\n- the book\n")
w(
    a + "/about.html",
    '<html lang="en"><head><title>Readme page</title></head><body><h1>About this attic</h1><p>Plain HTML.</p></body></html>',
)
# A real PDF, small
os.makedirs(os.path.join(root, a, "books"), exist_ok=True)
Image.new("RGB", (612, 792), (250, 248, 240)).save(os.path.join(root, a, "books", "attic-book.pdf"), "PDF")
w(
    a + "/books/attic-book.txt",
    "Title: The Attic Book\nAuthor: Ann Lee\nDate: 1950\nDescription: A short history of the house.\nCover: covers/attic-book.png\n",
)
png(
    os.path.join(root, a, "books", "covers", "attic-book.png"),
    (40, 80, 160),
    (300, 450),
)
for i, col in enumerate(
    [(240, 200, 60), (60, 160, 90), (90, 90, 200), (200, 100, 150)]
):
    png(os.path.join(root, a, "photos", "photo-%d.png" % (i + 1)), col)
w(a + "/photos/photo-1.json", '{"title": "At the beach, 1961"}')
films = os.path.join(root, a, "films")
os.makedirs(films)
_media(
    [
        "ffmpeg",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc=duration=2:size=320x240:rate=15",
        "-pix_fmt",
        "yuv420p",
        "-c:v",
        "libx264",
        os.path.join(films, "home-movie.mp4"),
    ],
    check=True,
)
w(
    a + "/films/home-movie.txt",
    "Title: Home movie, 1962\nAuthor: Grandpa\nDescription: The garden in summer.\n",
)
_media(
    [
        "ffmpeg",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=2",
        os.path.join(films, "song.mp3"),
    ],
    check=True,
)
w(a + "/films/old-tape.mkv", "not really")
w(a + "/budget.xlsx", "PK")
w(a + "/old.zim", "ZIM")
os.makedirs(os.path.join(root, "Other things"))
w("Other things/readme.md", "# Other")
print(root)
print(zims)
