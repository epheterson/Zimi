#!/usr/bin/env python3
"""
Zimi MCP Server — Expose offline knowledge as MCP tools for AI agents.

Two tool sets over stdio. lean: search, read (a page as Markdown, a long
one as its intro and an outline) and read_section. full: every tool,
collections, chunks, translations and the apps included.

Usage:
  zimi mcp [ZIM_DIR] [--tools lean|full]     lean unless told otherwise
  python3 -m zimi.mcp_server [--tools ...]   full unless told otherwise

Configuration:
  ZIM_DIR         Path to directory containing *.zim files (default: /zims)
  ZIMI_MCP_TOOLS  lean or full, when --tools is not given

Claude Code config (local):
  {
    "mcpServers": {
      "zimi": { "command": "zimi", "args": ["mcp", "/path/to/zims"] }
    }
  }

Claude Code config (Docker via SSH):
  {
    "mcpServers": {
      "zimi": {
        "command": "ssh",
        "args": ["your-server", "docker", "exec", "-i", "zimi", "python3", "-m", "zimi", "mcp"]
      }
    }
  }
"""

import json

# FastMCP is the high-level server API this file is built on. It shipped inside
# the `mcp` package through 1.x at `mcp.server.fastmcp`; `mcp` 2.0 dropped that
# vendored copy and moved FastMCP to its own `fastmcp` distribution. requirements
# pins `mcp<2.0` so the first import always resolves, but a user who upgraded mcp
# by hand (issue #52: crashed under mcp 2.0 via OpenWebUI) falls through to the
# standalone package, and if neither is present gets a fixable message instead of
# a bare ModuleNotFoundError.
try:
    from mcp.server.fastmcp import FastMCP
except ModuleNotFoundError:
    try:
        from fastmcp import FastMCP
    except ModuleNotFoundError as exc:
        raise SystemExit(
            "Zimi's MCP server needs FastMCP. Install a compatible mcp with "
            "`pip install 'mcp<2.0'`, or add the standalone package with "
            "`pip install fastmcp`."
        ) from exc

import os
import threading
from typing import Annotated

from pydantic import Field

from zimi import server as zimi

# Two tool sets. "lean" is three tools a 3B model can drive: search, read a
# page as Markdown, read one of its sections. "full" is every tool Zimi has
# (collections, chunks, translations, the apps), unchanged. `zimi mcp` serves
# lean unless told otherwise; `python -m zimi.mcp_server` keeps serving full,
# so a config written for it before lean existed gets what it always got.
TOOL_SETS = ("lean", "full")
TOOLS_ENV = "ZIMI_MCP_TOOLS"
_INSTRUCTIONS_FULL = "Search and read articles from offline ZIM knowledge archives."
_INSTRUCTIONS_LEAN = (
    "An offline library. search finds pages; read returns one as Markdown; "
    "a long page comes back as its intro and a numbered outline, and "
    "read_section returns any part of it."
)
# How many source names the lean instructions list before "and N more".
_SOURCES_LISTED = 30
# Lean search's snippet, cut at a word: enough to tell two pages apart.
_SNIPPET_CHARS = 160
LEAN_LIMIT_MAX = 20


def search(
    query: str, zim: str = "", collection: str = "", language: str = "", limit: int = 5
) -> str:
    """Full-text search across offline knowledge sources.

    Searches Wikipedia, Stack Overflow, dev docs, and other ZIM archives.
    Returns ranked results with titles and snippets.

    Args:
        query: Search query (e.g. "water purification", "Python asyncio").
            Operators: -word leaves out, "exact words" in order, a OR b,
            in:<source> / lang:<code> (negate with -). Exclusions and
            phrases are checked against result titles.
        zim: Optional — scope to specific source(s), comma-separated (e.g. "wikipedia,stackoverflow")
        collection: Optional — search within a named collection (overrides zim)
        language: Optional — filter results by language code (e.g. "en", "fr", "de")
        limit: Max results to return (default 5, max 50)
    """
    limit = max(1, min(limit, 50))
    filter_zim = None
    if collection:
        cdata = zimi._load_collections()
        coll = cdata.get("collections", {}).get(collection)
        if not coll:
            return f"Collection '{collection}' not found."
        filter_zim = coll.get("zims", []) or None
    elif zim:
        parts = [z.strip() for z in zim.split(",") if z.strip()]
        filter_zim = parts if len(parts) > 1 else (parts[0] if parts else None)

    # If language filter, narrow to ZIMs matching that language
    if language:
        lang_zims = []
        for z in zimi._zim_list_cache or []:
            if z.get("language") == language:
                lang_zims.append(z["name"])
        if not lang_zims:
            return f"No sources found for language '{language}'."
        if filter_zim:
            # Intersect with existing filter
            if isinstance(filter_zim, str):
                filter_zim = [filter_zim]
            filter_zim = [z for z in filter_zim if z in lang_zims] or None
            if not filter_zim:
                return f"No matching sources for language '{language}' in the specified scope."
        else:
            filter_zim = lang_zims if len(lang_zims) > 1 else lang_zims[0]

    with zimi._zim_lock:
        result = zimi.search_all(query, limit=limit, filter_zim=filter_zim)

    items = result.get("results", [])
    suggestion = result.get("did_you_mean")
    if not items:
        msg = f"No results found for '{query}'."
        if suggestion:
            msg += f" Did you mean '{suggestion}'?"
        return msg

    lines = [f"Found {result['total']} results in {result.get('elapsed', '?')}s:\n"]
    if suggestion:
        lines.append(f"Did you mean '{suggestion}'?\n")
    for r in items[:limit]:
        lines.append(f"- **{r['title']}** [{r['zim']}]")
        lines.append(f"  zim: {r['zim']}")
        lines.append(f"  path: {r['path']}")
        if r.get("snippet"):
            snippet = r["snippet"][:200]
            lines.append(f"  {snippet}")
        lines.append("")
    return "\n".join(lines)


def read(zim: str, path: str, max_length: int = 8000) -> str:
    """Read an article from a ZIM source as plain text.

    Use search() first to find articles, then read() to get the full content.

    Args:
        zim: Source name (e.g. "wikipedia", "stackoverflow")
        path: Article path within the source (from search results)
        max_length: Max characters to return (default 8000, max 50000)
    """
    max_length = max(100, min(max_length, 50000))
    with zimi._zim_lock:
        result = zimi.read_article(zim, path, max_length=max_length)

    if "error" in result:
        return f"Error: {result['error']}"

    header = f"# {result['title']}\nSource: {result['zim']} / {result['path']}"
    if result.get("truncated"):
        header += f"\n(Showing {max_length} of {result['full_length']} chars)"
    return f"{header}\n\n{result['content']}"


def get_chunks(zim: str, path: str, size: int = 1200, overlap: int = 120) -> str:
    """Chunk an article into deterministic, RAG-ready text segments.

    Embedding-free: returns evenly-sized, paragraph-aware chunks with stable IDs
    so you can build your own vector store. Same ZIM + params → identical IDs on
    every server; a ZIM update flips content_rev (and every chunk id) so caches
    invalidate automatically. Returns JSON: {zim, path, title, size, overlap,
    content_rev, total_chunks, chunks:[{id, seq, start, end, text}]}.

    Args:
        zim: Source name (e.g. "wikipedia")
        path: Article path within the source (from search results)
        size: Target chunk size in chars (clamped 200-4000, default 1200)
        overlap: Chars of the previous chunk repeated at the start of each chunk
                 (clamped 0-size/2, default 120)
    """
    with zimi._zim_lock:
        result = zimi.chunk_article(zim, path, size=size, overlap=overlap)
    if result.get("error"):
        return f"Error: article not found in '{zim}'."
    return json.dumps(result, ensure_ascii=False)


def suggest(query: str, zim: str = "", collection: str = "", limit: int = 10) -> str:
    """Title autocomplete — find articles by title prefix.

    Faster than full-text search. Good for finding specific articles.

    Args:
        query: Title prefix (e.g. "pytho" → "Python", "Python (programming language)")
        zim: Optional — scope to specific source(s), comma-separated
        collection: Optional — suggest within a named collection (overrides zim)
        limit: Max suggestions (default 10)
    """
    limit = max(1, min(limit, 50))
    zim_names = None
    if collection:
        cdata = zimi._load_collections()
        coll = cdata.get("collections", {}).get(collection)
        if coll:
            zim_names = coll.get("zims", [])
    elif zim:
        zim_names = [z.strip() for z in zim.split(",") if z.strip()]

    with zimi._zim_lock:
        if zim_names:
            result = {}
            for zn in zim_names:
                r = zimi.suggest(query, zim_name=zn, limit=limit)
                result.update(r)
        else:
            result = zimi.suggest(query, zim_name=None, limit=limit)

    if not result:
        return f"No suggestions for '{query}'."

    lines = []
    for source, items in result.items():
        for item in items:
            if "error" in item:
                continue
            lines.append(f"- {item['title']} [{source}]")
            lines.append(f"  zim: {source}")
            lines.append(f"  path: {item['path']}")
    return "\n".join(lines) if lines else f"No suggestions for '{query}'."


def list_sources() -> str:
    """List all available offline knowledge sources.

    Shows every ZIM archive with article counts and sizes.
    Use source names with search() and read().
    """
    sources = zimi.list_zims()
    if not sources:
        return "No ZIM sources found. Add .zim files to the ZIM_DIR directory."

    lines = [f"{len(sources)} sources available:\n"]
    for z in sources:
        entries = z["entries"] if isinstance(z["entries"], int) else 0
        lines.append(
            f"- **{z.get('title', z['name'])}** (`{z['name']}`) — "
            f"{entries:,} entries, {zimi.format_bytes(z.get('size_bytes', 0))}"
        )
    return "\n".join(lines)


def random(zim: str = "") -> str:
    """Get a random article from the knowledge base.

    Args:
        zim: Optional — scope to a specific source (e.g. "wikipedia")
    """
    if zim:
        if zim not in zimi.get_zim_files():
            return f"Source '{zim}' not found."
        pick_name = zim
    else:
        eligible = [
            z
            for z in (zimi._zim_list_cache or [])
            if isinstance(z.get("entries"), int) and z["entries"] > 100
        ]
        if not eligible:
            return "No sources available."
        import random as _random

        pick_name = _random.choice(eligible)["name"]

    with zimi._zim_lock:
        archive = zimi.get_archive(pick_name)
        if archive is None:
            return "Archive not available."
        result = zimi.random_entry(archive)

    if not result:
        return "No articles found."

    return f"**{result['title']}** [{pick_name}]\nzim: {pick_name}\npath: {result['path']}\n\nUse read(zim=\"{pick_name}\", path=\"{result['path']}\") to read the full article."


def list_collections() -> str:
    """List all favorites and collections.

    Shows which ZIM sources are favorited and any named collections.
    """
    data = zimi._load_collections()
    favs = data.get("favorites", [])
    colls = data.get("collections", {})

    lines = []
    if favs:
        lines.append("**Favorites:** " + ", ".join(f"`{f}`" for f in favs))
    else:
        lines.append("No favorites set.")

    if colls:
        lines.append(f"\n**Collections ({len(colls)}):**")
        for name, info in colls.items():
            label = info.get("label", name)
            zim_list = info.get("zims", [])
            lines.append(
                f"- **{label}** (`{name}`) — {', '.join(f'`{z}`' for z in zim_list) if zim_list else 'empty'}"
            )
    else:
        lines.append("No collections created.")

    return "\n".join(lines)


def manage_collection(
    action: str, name: str = "", label: str = "", zims: str = ""
) -> str:
    """Create, update, or delete a named collection of ZIM sources.

    Collections let you group ZIMs for scoped search (e.g. "dev-docs" = stackoverflow + devdocs).

    Args:
        action: "create", "update", or "delete"
        name: Collection identifier (e.g. "dev-docs"). Auto-generated from label if omitted.
        label: Display name (e.g. "Dev Docs") — used for create/update
        zims: Comma-separated ZIM names (e.g. "stackoverflow,devdocs_python") — used for create/update
    """
    import re

    # Auto-generate name from label if not provided
    if not name and label:
        name = re.sub(r"[^a-z0-9]+", "-", label.lower()).strip("-")[:64]
    if not name:
        return "Error: provide 'name' or 'label'."

    with zimi._collections_lock:
        data = zimi._load_collections()

        if action == "delete":
            if name not in data.get("collections", {}):
                return f"Collection '{name}' not found."
            del data["collections"][name]
            zimi._save_collections(data)
            return f"Deleted collection '{name}'."

        if action in ("create", "update"):
            zim_list = [z.strip() for z in zims.split(",") if z.strip()] if zims else []
            data.setdefault("collections", {})[name] = {
                "label": label or name,
                "zims": zim_list,
            }
            zimi._save_collections(data)
            return f"{'Created' if action == 'create' else 'Updated'} collection '{name}' with {len(zim_list)} sources."

    return f"Unknown action '{action}'. Use create, update, or delete."


def manage_favorites(action: str, zim: str) -> str:
    """Add or remove a ZIM source from favorites.

    Favorites appear at the top of the homepage for quick access.

    Args:
        action: "add" or "remove"
        zim: ZIM source name (e.g. "wikipedia", "stackoverflow")
    """
    with zimi._collections_lock:
        data = zimi._load_collections()
        favs = data.get("favorites", [])

        if action == "add":
            if zim in favs:
                return f"'{zim}' is already a favorite."
            favs.append(zim)
            data["favorites"] = favs
            zimi._save_collections(data)
            return f"Added '{zim}' to favorites."

        if action == "remove":
            if zim not in favs:
                return f"'{zim}' is not a favorite."
            favs.remove(zim)
            data["favorites"] = favs
            zimi._save_collections(data)
            return f"Removed '{zim}' from favorites."

    return f"Unknown action '{action}'. Use add or remove."


def article_languages(zim: str, path: str) -> str:
    """Find available translations for a Wikipedia/Wikimedia article.

    Shows which languages the article is available in, distinguishing between
    installed ZIMs (can read immediately) and available ones (can be downloaded).

    Args:
        zim: Source name (e.g. "wikipedia")
        path: Article path (e.g. "A/Water")
    """
    with zimi._zim_lock:
        result = zimi.get_article_languages(zim, path)

    installed = result.get("languages", [])
    available = result.get("available", [])

    if not installed and not available:
        return "No translations found for this article."

    lines = []
    if installed:
        lines.append(f"**Installed translations ({len(installed)}):**")
        for lang in installed:
            lines.append(
                f"- {lang['name']} ({lang['lang']}) → read(zim=\"{lang['zim']}\", path=\"{lang['path']}\")"
            )
    if available:
        lines.append(f"\n**Available for download ({len(available)}):**")
        for lang in available:
            lines.append(f"- {lang['name']} ({lang['lang']})")
    return "\n".join(lines)


def read_with_links(zim: str, path: str, max_length: int = 8000) -> str:
    """Read an article and show cross-ZIM links found in it.

    Returns article text plus a list of links to other installed ZIM sources.
    Useful for exploring connections between knowledge sources.

    Args:
        zim: Source name (e.g. "wikipedia")
        path: Article path (from search results)
        max_length: Max characters for article text (default 8000, max 50000)
    """
    max_length = max(100, min(max_length, 50000))
    with zimi._zim_lock:
        result = zimi.read_article(zim, path, max_length=max_length)
        if "error" in result:
            return f"Error: {result['error']}"

        # Get the raw HTML to extract links
        archive = zimi.get_archive(zim)
        cross_links = []
        if archive:
            try:
                entry = archive.get_entry_by_path(path)
                item = entry.get_item()
                if item.mimetype in ("text/html", "application/xhtml+xml"):
                    import re

                    html = bytes(item.content).decode("utf-8", errors="replace")
                    # Find external links
                    urls = re.findall(r'href="(https?://[^"]+)"', html)
                    seen = set()
                    for url in urls[:100]:
                        resolved = zimi._resolve_url_to_zim(url)
                        if resolved and resolved["zim"] != zim:
                            key = f"{resolved['zim']}/{resolved['path']}"
                            if key not in seen:
                                seen.add(key)
                                cross_links.append(resolved)
                                if len(cross_links) >= 20:
                                    break
            except Exception:
                pass

    header = f"# {result['title']}\nSource: {result['zim']} / {result['path']}"
    if result.get("truncated"):
        header += f"\n(Showing {max_length} of {result['full_length']} chars)"

    output = f"{header}\n\n{result['content']}"

    if cross_links:
        output += "\n\n---\n**Cross-source links found:**"
        for link in cross_links:
            output += f"\n- [{link['zim']}] {link['path']}"
    return output


def deep_search(
    query: str, zim: str = "", language: str = "", max_results: int = 3
) -> str:
    """Search and auto-read top results for comprehensive context.

    Performs a search, then reads the top results and returns a synthesized
    summary with article contents. Ideal for research queries where you need
    substance, not just titles.

    Args:
        query: Search query (e.g. "quantum entanglement applications")
        zim: Optional — scope to specific source(s), comma-separated
        language: Optional — filter by language code (e.g. "en", "fr")
        max_results: Number of top results to read (default 3, max 5)
    """
    max_results = max(1, min(max_results, 5))

    # Build filter
    filter_zim = None
    if zim:
        parts = [z.strip() for z in zim.split(",") if z.strip()]
        filter_zim = parts if len(parts) > 1 else (parts[0] if parts else None)

    if language:
        lang_zims = [
            z["name"]
            for z in (zimi._zim_list_cache or [])
            if z.get("language") == language
        ]
        if lang_zims:
            if filter_zim:
                if isinstance(filter_zim, str):
                    filter_zim = [filter_zim]
                filter_zim = [z for z in filter_zim if z in lang_zims] or lang_zims
            else:
                filter_zim = lang_zims if len(lang_zims) > 1 else lang_zims[0]

    with zimi._zim_lock:
        search_result = zimi.search_all(
            query, limit=max_results * 2, filter_zim=filter_zim
        )

    items = search_result.get("results", [])
    if not items:
        return f"No results found for '{query}'."

    lines = [f"# Deep Search: {query}\n"]
    lines.append(
        f"Found {search_result['total']} results. Reading top {min(max_results, len(items))}:\n"
    )

    read_count = 0
    for r in items:
        if read_count >= max_results:
            break
        with zimi._zim_lock:
            article = zimi.read_article(r["zim"], r["path"], max_length=4000)
        if "error" in article:
            continue
        read_count += 1
        lines.append(f"## {read_count}. {article['title']} [{r['zim']}]")
        lines.append(f"zim: {r['zim']}")
        lines.append(f"path: {r['path']}")
        content = article["content"][:3000]
        lines.append(f"\n{content}\n")

    if read_count == 0:
        return f"Found results but could not read any articles for '{query}'."

    return "\n".join(lines)


# ── the apps: the library's videos, Q&A and subreddits, sorted and threaded ──
#
# The same readers ZimiTube, ZimiExchange and Reddot draw from, as text an
# agent can use: a feed of talks across every video ZIM, a site's questions
# most voted first, a question with its answers (accepted first), a
# subreddit's posts top or new, a post with its comment tree indented.


def _strip_html(html):
    import html as _h
    import re

    text = re.sub(r"<(script|style)\b.*?</\1>", "", html or "", flags=re.S | re.I)
    text = re.sub(r"</(p|div|li|br|h\d|blockquote|pre)>", "\n", text, flags=re.I)
    text = re.sub(r"<[^>]+>", "", text)
    return re.sub(r"\n{3,}", "\n\n", _h.unescape(text)).strip()


def list_videos(query: str = "", limit: int = 30, offset: int = 0) -> str:
    """List videos across every video ZIM (TED, YouTube, Zimi's own): one
    card per talk, sources interleaved in each ZIM's own order (TED's most
    watched first).

    Args:
        query: keep videos whose title, description or speaker carry every word
        limit: how many (default 30)
        offset: skip this many
    Use read(zim, path=page) for a video's page; /tube/play for its media.
    """
    from zimi import tube

    got = tube.feed(query, limit=max(1, min(int(limit), 500)), offset=max(0, int(offset)))
    if not got["items"]:
        return "No videos match." if query else "No video ZIMs installed."
    lines = [f"{got['total']} videos across {got['sources']} sources" + (f" for '{query}'" if query else "") + ":\n"]
    for v in got["items"]:
        who = " · ".join(x for x in (v.get("speaker"), v.get("zim_title")) if x)
        extra = " · ".join(str(x) for x in (v.get("duration"), v.get("date")) if x)
        lines.append(f"- **{v['title']}** ({who})" + (f" · {extra}" if extra else "") + f"\n  zim: {v['zim']}  path: {v['page']}")
        if v.get("description"):
            lines.append(f"  {str(v['description'])[:200]}")
    return "\n".join(lines)


def list_questions(site: str = "", tag: str = "", page: int = 1) -> str:
    """List a Stack Exchange site's questions, most voted first (the site's
    own order), or a tag's. With no site, list the installed sites.

    Args:
        site: the ZIM name of the site (see the listing with no arguments)
        tag: narrow to one tag
        page: page number (default 1)
    Use read_question(site, path) for a question with its answers.
    """
    from zimi import exchange

    if not site:
        sites = exchange.sites()
        if not sites:
            return "No Stack Exchange sites installed."
        return "Installed sites:\n" + "\n".join(f"- **{s['title']}** (`{s['name']}`)" for s in sites)
    got = exchange.listing(site, max(1, int(page)), tag or "")
    if not got["rows"]:
        return f"No questions found for '{site}'" + (f" tagged {tag}" if tag else "") + "."
    lines = [f"{site}" + (f" [{tag}]" if tag else "") + f" — page {page} of {got['pages']}:\n"]
    for r in got["rows"]:
        mark = " ✓" if r.get("accepted") else ""
        lines.append(f"- **{r['title']}** — {r['votes']} votes, {r['answers']} answers{mark}" + (f" · {', '.join(r['tags'])}" if r.get("tags") else "") + f"\n  path: {r['page']}")
        if r.get("excerpt"):
            lines.append(f"  {r['excerpt'][:200]}")
    return "\n".join(lines)


def read_question(site: str, path: str, max_length: int = 8000) -> str:
    """A question with its answers, the accepted one first, as text.

    Args:
        site: the ZIM name of the site
        path: the question's path (questions/<id>/<slug>), from list_questions
        max_length: cut the text here
    """
    from zimi import exchange

    q = exchange.question(site, path)
    if not q:
        return f"Not a question page: {path}"
    out = [f"# {q['title']}", f"{q['votes']} votes · asked by {q.get('author') or 'unknown'}" + (f" · {', '.join(q['tags'])}" if q.get("tags") else ""), "", _strip_html(q.get("body")), ""]
    for i, a in enumerate(q.get("answers") or [], 1):
        out.append(f"## Answer {i} — {a['score']} points" + (" (accepted)" if a.get("accepted") else "") + (f" · {a['author']}" if a.get("author") else ""))
        out.append(_strip_html(a.get("body")))
        out.append("")
    text = "\n".join(out)
    return text[: max(200, int(max_length))]


def list_posts(zim: str = "", subreddit: str = "", sort: str = "top", page: int = 1) -> str:
    """List a subreddit's posts, top or new. With no arguments, list the
    installed subreddit ZIMs and their subreddits.

    Args:
        zim: the subreddit ZIM's name
        subreddit: the subreddit, as the ZIM names it
        sort: "top" (default) or "new"
        page: page number (default 1)
    Use read_post(zim, path) for a post with its comments.
    """
    from zimi import reddot

    if not zim or not subreddit:
        zims = reddot.zims()
        if not zims:
            return "No subreddit ZIMs installed."
        return "Installed:\n" + "\n".join(f"- `{z['name']}`: " + ", ".join("r/" + s for s in z["subreddits"]) for z in zims)
    got = reddot.listing(zim, subreddit, sort, max(1, int(page)))
    if not got["rows"]:
        return f"No posts found for r/{subreddit} in '{zim}'."
    lines = [f"r/{subreddit} — {sort}, page {page} of {got['pages']}:\n"]
    for r in got["rows"]:
        facts = " · ".join(x for x in (r.get("flair"), (f"by {r['author']}" if r.get("author") else ""), r.get("date")) if x)
        lines.append(f"- **{r['title']}** — {r['score']} points" + (f" · {facts}" if facts else "") + (f" · {r['external']}" if r.get("external") else "") + f"\n  path: {r['page']}")
    return "\n".join(lines)


def read_post(zim: str, path: str, max_length: int = 8000) -> str:
    """A post with its comment tree, replies indented under their parents.

    Args:
        zim: the subreddit ZIM's name
        path: the post's path (r/<sub>/<id>/), from list_posts
        max_length: cut the text here
    """
    from zimi import reddot

    p = reddot.post(zim, path)
    if not p:
        return f"Not a post page: {path}"
    out = [f"# {p['title']}", f"r/{p['subreddit']} · {p['score']} points" + (f" · by {p['author']}" if p.get("author") else "") + (f" · {p['date']}" if p.get("date") else ""), "", _strip_html(p.get("body")), ""]

    def walk(comments, depth):
        for c in comments or []:
            pad = "  " * depth
            out.append(f"{pad}- **{c.get('author') or 'unknown'}** ({c.get('score', 0)} points" + (f", {c['date']}" if c.get("date") else "") + ")")
            for line in _strip_html(c.get("body")).splitlines():
                out.append(f"{pad}  {line}")
            walk(c.get("children"), depth + 1)

    n = sum(1 for _ in _each(p.get("comments")))
    out.append(f"## {n} comments")
    walk(p.get("comments"), 0)
    text = "\n".join(out)
    return text[: max(200, int(max_length))]


def _each(comments):
    for c in comments or []:
        yield c
        yield from _each(c.get("children"))


# ── lean: three tools, Markdown out ──────────────────────────────────────
#
# For small local models (szmcp's point: Gemma 12B, Granite 8B, even 3B):
# few tools, short schemas, answers that are Markdown with the page's own
# sections, and a long page that arrives as an outline instead of 60k chars.


def _source_names():
    names = sorted(zimi.get_zim_files())
    if not names:
        return "No sources installed."
    more = len(names) - _SOURCES_LISTED
    listed = ", ".join(names[:_SOURCES_LISTED])
    return f"Sources: {listed}" + (f" and {more} more." if more > 0 else ".")


def _resolve(zim):
    """The installed sources ``zim`` names, as (names, error). A name may be
    exact, the start of one ("wikipedia") or a part of one; a part that fits
    several sources means all of them."""
    installed = list(zimi.get_zim_files())
    out = []
    for want in (z.strip() for z in zim.split(",")):
        if not want:
            continue
        if want in installed:
            hits = [want]
        else:
            low = want.lower()
            hits = [n for n in installed if n.lower().startswith(low)] or [
                n for n in installed if low in n.lower()
            ]
        if not hits:
            return None, f"No source named '{want}'. {_source_names()}"
        out.extend(h for h in hits if h not in out)
    return out, None


def _cut(text, limit):
    text = " ".join((text or "").split())
    if len(text) <= limit:
        return text
    return text[:limit].rsplit(" ", 1)[0] + "…"


def _snippet(zim, path):
    """A result's snippet when the search had none (most full-text hits come
    back without one: reading every page would slow every search)."""
    from zimi.previews import extract_snippet, lead_text
    from zimi.search import refresh_target

    archive = zimi.get_archive(zim)
    if archive is None:
        return ""
    try:
        item = archive.get_entry_by_path(path).get_item()
    except Exception:
        return ""
    if item.size > zimi.MAX_CONTENT_BYTES or "html" not in (item.mimetype or ""):
        return ""
    lead = lead_text(item)
    hop = refresh_target(lead, path)
    if hop:
        return f"(leads to {hop[0]}" + (f" § {hop[1]}" if hop[1] else "") + ")"
    return extract_snippet(lead, zim)


def lean_search(
    query: Annotated[
        str, Field(description='Words to find. Also: "exact phrase", -word, a OR b')
    ],
    zim: Annotated[
        str, Field(description="Source name(s), comma-separated. Empty: all")
    ] = "",
    limit: Annotated[int, Field(description="Results, 1-20")] = 5,
) -> str:
    """Search the offline library. Each hit: title, zim, path, snippet."""
    limit = max(1, min(int(limit), LEAN_LIMIT_MAX))
    names = None
    if zim.strip():
        names, err = _resolve(zim)
        if err:
            return err
    with zimi._zim_lock:
        result = zimi.search_all(query, limit=limit, filter_zim=names)
        items = result.get("results", [])[:limit]
        for r in items:
            if not r.get("snippet"):
                r["snippet"] = _snippet(r["zim"], r["path"])
    if result.get("error"):
        return f"Search failed: {result['error']}"
    lines = []
    if result.get("did_you_mean"):
        lines.append(f"Did you mean: {result['did_you_mean']}")
    if not items:
        lines.append(f"No results for '{query}'.")
    for r in items:
        lines.append(f"- {r['title']} | zim: {r['zim']} | path: {r['path']}")
        snip = _cut(zimi.strip_html(r.get("snippet") or ""), _SNIPPET_CHARS)
        if snip:
            lines.append(f"  {snip}")
    return "\n".join(lines)


def _page(zim, path, references=False):
    """(page, error) for the lean readers. When ``zim`` names several
    sources ("wikipedia"), the first that has the page answers."""
    from zimi.search import article_markdown

    names, err = _resolve(zim)
    if err:
        return None, err
    for name in names:
        with zimi._zim_lock:
            got = article_markdown(name, path, references=references)
        if got.get("error") == "not_text":
            return None, f"'{path}' is {got['mimetype']}, not a page of text."
        if not got.get("error"):
            return got, None
    where = names[0] if len(names) == 1 else ", ".join(names)
    return None, f"No page '{path}' in {where}. Use search to find one."


def _header(got, section=None):
    title = got["title"]
    if section is not None and section.index:
        title += f" § {section.heading}"
    return f"# {title}\nzim: {got['zim']} | path: {got['path']}\n\n"


def lean_read(
    zim: Annotated[str, Field(description="Source, from search")],
    path: Annotated[str, Field(description="Page path, from search")],
    references: Annotated[bool, Field(description="Keep the references")] = False,
) -> str:
    """A page as Markdown. A long page: its intro and a numbered outline."""
    from zimi import htmlmd

    got, err = _page(zim, path, references)
    if err:
        return err
    # A page that is a pointer into another page's section: that section.
    sec = got["doc"].find(got["section"]) if got["section"] else None
    return _header(got, sec) + htmlmd.view(got["doc"], sec)


def read_section(
    zim: Annotated[str, Field(description="Source, from search")],
    path: Annotated[str, Field(description="Page path, from search")],
    section: Annotated[str, Field(description="Number or heading, from read")],
) -> str:
    """One section of a page (with its subsections) as Markdown."""
    from zimi import htmlmd

    got, err = _page(zim, path)
    if err:
        return err
    doc = got["doc"]
    sec = doc.find(section)
    if sec is None:
        return f"No section '{section}'. Sections:\n{doc.outline()}"
    return _header(got, sec) + htmlmd.view(doc, sec)


FULL_TOOLS = tuple(
    (fn.__name__, fn)
    for fn in (
        search,
        read,
        get_chunks,
        suggest,
        list_sources,
        random,
        list_collections,
        manage_collection,
        manage_favorites,
        article_languages,
        read_with_links,
        deep_search,
        list_videos,
        list_questions,
        read_question,
        list_posts,
        read_post,
    )
)
LEAN_TOOLS = (
    ("search", lean_search),
    ("read", lean_read),
    ("read_section", read_section),
)


def build(tools="full"):
    """A FastMCP server offering one tool set. Builds nothing else: no cache
    load, no thread, no scan beyond the ZIM directory's file names (lean
    names the sources in its instructions)."""
    if tools not in TOOL_SETS:
        raise ValueError(f"tools must be one of {', '.join(TOOL_SETS)}")
    instructions = _INSTRUCTIONS_FULL
    if tools == "lean":
        instructions = f"{_INSTRUCTIONS_LEAN} {_source_names()}"
    server = FastMCP("zimi", instructions=instructions)
    # Report ZIMI's version, not FastMCP's.
    #
    # The low-level server carries `version=None`, and the library then answers
    # the handshake with its OWN version — so a client asking what it just
    # connected to was told "zimi 1.26.0" while Zimi was 1.9.0.
    #
    # Set after construction because FastMCP's __init__ signature differs
    # between the vendored `mcp.server.fastmcp` and the standalone `fastmcp`
    # distribution, and only one of them takes `version`. Guarded: a private
    # attribute that moves should cost us a wrong version string, never a
    # server that will not start.
    try:
        server._mcp_server.version = zimi.ZIMI_VERSION
    except Exception:  # pragma: no cover - shape changed upstream
        pass
    if tools == "full":
        for name, fn in FULL_TOOLS:
            server.tool(name=name)(fn)
        return server
    # Lean answers are text, so no output schema rides along in tools/list:
    # every token of it would be one a small model's context pays for twice.
    import inspect

    plain = {}
    if "structured_output" in inspect.signature(server.tool).parameters:
        plain["structured_output"] = False
    for name, fn in LEAN_TOOLS:
        server.tool(name=name, **plain)(fn)
    return server


# The full server, as this module has always offered it to anyone importing it.
mcp = build("full")


def run(tools):
    """Serve ``tools`` over stdio until the client hangs up.

    Lean starts only what it answers with: the metadata cache (read from
    disk; a first run reads each ZIM's header once). No title-index builds,
    BitTorrent, mDNS, catalog or web server; search uses an index already on
    disk and libzim's own otherwise. Full also warms every index in the
    background, as it always has, for the tools that want them."""
    zimi.load_cache()
    if tools == "full":
        threading.Thread(target=zimi.warm_indexes, daemon=True).start()
    build(tools).run(transport="stdio")


def tools_setting(value, default):
    """``value`` (a flag or ZIMI_MCP_TOOLS) checked, or ``default``."""
    value = (value or "").strip().lower() or default
    if value not in TOOL_SETS:
        raise SystemExit(
            f"zimi: {TOOLS_ENV} / --tools must be one of {', '.join(TOOL_SETS)}, "
            f"not '{value}'"
        )
    return value


def main(argv=None):
    import argparse

    parser = argparse.ArgumentParser(
        prog="python -m zimi.mcp_server",
        description="Zimi's MCP server on stdio. `zimi mcp` is the same, lean by default.",
    )
    parser.add_argument(
        "--tools",
        default=None,
        help=f"lean or full (default: ${TOOLS_ENV}, else full)",
    )
    args = parser.parse_args(argv)
    run(tools_setting(args.tools or os.environ.get(TOOLS_ENV), "full"))


if __name__ == "__main__":
    main()
