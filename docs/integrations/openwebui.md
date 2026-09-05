# OpenWebUI / Generic AI Integration

Zimi ships with an MCP (Model Context Protocol) server that any AI client can call to search and read ZIM content. This page covers OpenWebUI specifically; the same pattern works for Open Claw, LM Studio, ollama-ui, or any tool that consumes MCP servers.

## What an AI gets

An MCP-connected agent can:

- **`search`** — full-text search across all (or a specific) ZIM(s); language and collection filters
- **`read`** — fetch a specific article as plain text
- **`get_chunks`** — deterministic, embedding-free RAG chunking of an article with stable chunk IDs
- **`suggest`** — title autocomplete (instant, useful for low-latency interactive flows)
- **`list_sources`** — enumerate available ZIMs with article counts and sizes
- **`random`** — random article from a specific ZIM (or any)
- **`article_languages`** — find translations of a given article
- **`read_with_links`** — read with cross-language links extracted
- **`deep_search`** — multi-hop search that follows article links
- **`list_collections`** / **`manage_collection`** / **`manage_favorites`** — group ZIMs into reusable bundles

Full tool signatures: see `zimi/mcp_server.py`.

## Installing

The MCP server needs one extra dependency, which a plain `pip install zimi` does not pull in:

```bash
pip install "zimi[mcp]"
```

The Docker image already has it. To check any install, run `python3 -m zimi.mcp_server` — it should sit there waiting on stdin rather than exiting with an ImportError.

### Direct subprocess (same machine)

```json
{
  "mcpServers": {
    "zimi": {
      "command": "python3",
      "args": ["-m", "zimi.mcp_server"],
      "env": { "ZIM_DIR": "/path/to/your/zims" }
    }
  }
}
```

### Docker on a remote host

```json
{
  "mcpServers": {
    "zimi": {
      "command": "ssh",
      "args": [
        "your-server",
        "docker", "exec", "-i", "zimi", "python3", "-m", "zimi.mcp_server"
      ]
    }
  }
}
```

The container must already be running. `python3 -m zimi.mcp_server` reads/writes MCP frames on stdio so SSH passthrough works without extra setup.

### OpenWebUI specifics

Open WebUI doesn't read `mcpServers` JSON, and its native MCP support (v0.6.31+) speaks Streamable HTTP only — it can't launch a stdio server like Zimi's itself. Bridge it with [mcpo](https://github.com/open-webui/mcpo), Open WebUI's own MCP-to-OpenAPI proxy:

```bash
ZIM_DIR=/path/to/your/zims uvx mcpo --port 8000 -- python3 -m zimi.mcp_server
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

`read` plus `article_languages` plus `read` on each translation.

**Iterative narrowing**

> I want to learn about the Apollo program. Start with a high-level overview, then drill into the engineering of the Saturn V.

The agent uses `suggest` for fast title-level orientation, `read` for context.

## Tips

- **Prefer the MCP path over scraping the HTTP API.** MCP gives the agent typed tool definitions; HTTP has the agent guessing at endpoint shapes.
- **Set `ZIMI_HOT_ZIMS`** if the agent will hammer a small set of sources. The hot list is pre-warmed at startup so first-call latency stays low.
- **Watch the logs.** `python3 -m zimi.mcp_server` writes structured logs to stderr — useful to see which tools the agent actually called for a given prompt.
