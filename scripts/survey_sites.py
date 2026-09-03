"""The 20 sites and 74 jobs of the creation survey. Data only.

Chosen so every failure mode has a representative: six sites Kiwix publishes
a zimit-made ZIM for (size and coherence can be compared), five static docs
and blogs, five JavaScript-heavy or news homepages, four awkward shapes.
"""

from collections import namedtuple

Site = namedtuple("Site", "key url kind released")
Job = namedtuple("Job", "site mode engine extra")

SITES = [
    Site(
        "lowtech",
        "https://solar.lowtechmagazine.com/",
        "released",
        "solar.lowtechmagazine.com_mul_all",
    ),
    Site("peps", "https://peps.python.org/", "released", "peps.python_en_all"),
    Site("planetmath", "https://planetmath.org/", "released", "planetmath.org_en_all"),
    Site(
        "cheatography",
        "https://cheatography.com/",
        "released",
        "cheatography.com_en_all",
    ),
    Site("fosscooking", "https://foss.cooking/", "released", "foss.cooking_en_all"),
    Site("sh1", "https://sh1.org/", "released", "sh1.org_en_all"),
    Site("sqlite", "https://www.sqlite.org/", "static", ""),
    Site("sivers", "https://sive.rs/n", "static", ""),
    Site("pg", "https://paulgraham.com/articles.html", "static", ""),
    Site("dockerdocs", "https://docs.docker.com/get-started/", "static", ""),
    Site("react", "https://react.dev/learn", "static", ""),
    Site("cnn", "https://www.cnn.com/", "js", ""),
    Site("bbc", "https://www.bbc.com/", "js", ""),
    Site("verge", "https://www.theverge.com/", "js", ""),
    Site("apple", "https://www.apple.com/", "js", ""),
    Site("github", "https://github.com/openzim/zimit", "js", ""),
    Site("hn", "https://news.ycombinator.com/", "awkward", ""),
    Site("xkcd", "https://xkcd.com/", "awkward", ""),
    Site("wiki", "https://en.wikipedia.org/wiki/Water_purification", "awkward", ""),
    Site(
        "medium",
        "https://medium.com/@steve.yegge/the-death-of-the-junior-developer-6c4e3f3ba3a8",
        "awkward",
        "",
    ),
]

VIDEOS = [
    "https://www.youtube.com/playlist?list=PLzMcBGfZo4-kCLWnGmK0jUBmGLaJxvi4j",
    "https://www.youtube.com/@Kurzgesagt/videos",
]

ENGINES = ("builtin", "rendered", "alive")


def matrix():
    """The jobs in run order: cheapest engine first for every site, then the
    whole-site captures of the compare set, then video."""
    jobs = []
    for engine in ENGINES:
        for site in SITES:
            jobs.append(Job(site, "page", engine, {}))
    for site in SITES:
        if site.released:
            for engine in ("builtin", "rendered"):
                jobs.append(Job(site, "site", engine, {"max_pages": 25}))
    for url in VIDEOS:
        jobs.append(
            Job(Site("video", url, "video", ""), "video", "builtin", {"limit": 2})
        )
    return jobs
