# OpenWebUI / Generic AI Integration

Zimi ships with an MCP (Model Context Protocol) server that any AI client can call to search and read ZIM content. This page covers OpenWebUI specifically; the same pattern works for Open Claw, LM Studio, ollama-ui, or any tool that consumes MCP servers.

## What an AI gets

`zimi mcp` serves three tools by default, sized for small local models (a 3B to 27B model handles them well; the three schemas together are about 330 tokens):

- **`search`**: search one source, several, or all of them. Each hit is a title, its source, its path and a short snippet. Supports `"exact phrase"`, `-word` and `a OR b`. A source can be named by part (`wikipedia`, `stackexchange`).
- **`read`**: a page as Markdown with its headings, lists, tables, infobox and math (as TeX). No navigation, footnote marks or images; references only when asked for. A long page comes back as its intro and a numbered outline.
- **`read_section`**: one section of a page by number or heading, with its subsections.

With `--tools full` (or `ZIMI_MCP_TOOLS=full`) it serves every tool instead, about 3,300 tokens of schema:

- **`search`** with collection and language filters, and **`read`** as plain text
- **`get_chunks`**: deterministic, embedding-free RAG chunking of an article with stable chunk IDs
- **`suggest`**: title autocomplete
- **`list_sources`**: the installed ZIMs with article counts and sizes
- **`random`**: a random article from one ZIM or any
- **`article_languages`**: translations of an article
- **`read_with_links`**: an article with its links into other installed ZIMs
- **`deep_search`**: search, then read the top results
- **`list_collections`** / **`manage_collection`** / **`manage_favorites`**: group ZIMs into reusable bundles
- **`list_videos`**, **`list_questions`**, **`read_question`**, **`list_posts`**, **`read_post`**: the apps' readers

Full tool signatures: see `zimi/mcp_server.py`.

## Installing

The MCP server needs one extra dependency, which a plain `pip install zimi` does not pull in:

```bash
pip install "zimi[mcp]"
```

The Docker image already has it. To check any install, run `zimi mcp /path/to/your/zims`: it should sit there waiting on stdin rather than exiting with an error.

### Direct subprocess (same machine)

```json
{
  "mcpServers": {
    "zimi": {
      "command": "zimi",
      "args": ["mcp", "/path/to/your/zims"]
    }
  }
}
```

Add `"--tools", "full"` to `args` for every tool. `python3 -m zimi.mcp_server` (with `ZIM_DIR` in `env`) still works and serves the full set, so a config written for it keeps working.

### Docker on a remote host

```json
{
  "mcpServers": {
    "zimi": {
      "command": "ssh",
      "args": [
        "your-server",
        "docker", "exec", "-i", "zimi", "python3", "-m", "zimi", "mcp"
      ]
    }
  }
}
```

The container must already be running; it sets `ZIM_DIR`, so no directory is needed. `zimi mcp` reads and writes MCP frames on stdio, so SSH passthrough works without extra setup.

### OpenWebUI specifics

Open WebUI doesn't read `mcpServers` JSON, and its native MCP support (v0.6.31+) speaks Streamable HTTP only — it can't launch a stdio server like Zimi's itself. Bridge it with [mcpo](https://github.com/open-webui/mcpo), Open WebUI's own MCP-to-OpenAPI proxy:

```bash
uvx mcpo --port 8000 -- zimi mcp /path/to/your/zims
```

Then add `http://localhost:8000` as a tool server in Open WebUI (**Settings → Tools** for yourself, or **Admin Settings → Tools** for everyone); the model will see the Zimi tools alongside whatever else you've configured. The `mcpServers` JSON above is for clients that launch stdio servers directly (Claude Code, Claude Desktop, LM Studio, and friends).

If you also use the SearXNG integration ([searxng.md](searxng.md)), you can route `search` queries through SearXNG instead, getting Zimi results merged with whatever other engines you have. Pick one or both depending on whether the agent needs raw article content or just citations.

## Example prompts

These work after the MCP server is wired up. The agent decides when to call which tool.

**Research with citations**

> Find three articles in our offline library that discuss water purification techniques in low-resource settings. For each, give me the title, source ZIM, and a one-paragraph summary.

The agent will likely call `search` then `read` on each hit. Replies cite real article paths so you can verify.

**Cross-language lookup**

> Read the English Wikipedia article on plate tectonics, then check whether translations exist in French and Spanish. If they do, summarize the differences.

`read` plus `article_languages` plus `read` on each translation (the full set).

**Iterative narrowing**

> I want to learn about the Apollo program. Start with a high-level overview, then drill into the engineering of the Saturn V.

With the default tools the agent reads the Apollo program page, gets its intro and outline, then calls `read_section` for the parts it needs; with the full set it can also use `suggest` for fast title-level orientation.

## Tips

- **Prefer the MCP path over scraping the HTTP API.** MCP gives the agent typed tool definitions; HTTP has the agent guessing at endpoint shapes.
- **Set `ZIMI_HOT_ZIMS`** if the agent will hammer a small set of sources (full set). The hot list is pre-warmed at startup so first-call latency stays low.
- **Watch the logs.** `zimi mcp` writes its logs to stderr, useful to see which tools the agent actually called for a given prompt.
