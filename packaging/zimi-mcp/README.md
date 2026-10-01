# zimi-mcp

[Zimi](https://github.com/epheterson/Zimi)'s MCP server and search, without the rest of Zimi. Search and read Wikipedia, Stack Overflow, dev docs and any other ZIM file offline, from Claude, Open WebUI or any MCP client.

```bash
pip install zimi-mcp
zimi-mcp /path/to/zims
```

```json
{
  "mcpServers": {
    "zimi": { "command": "zimi-mcp", "args": ["/path/to/zims"] }
  }
}
```

Three tools by default (search, read a page as Markdown, read one section), about 330 tokens of schema, sized for small local models. `zimi-mcp --tools full` serves every tool Zimi has. Nothing listens on a port.

zimi-mcp is built from the same source as Zimi and released with it, same version. It depends on libzim and mcp only: no web app, downloads, BitTorrent, LAN discovery or desktop window. For text out of the PDFs in zimgit ZIMs, `pip install "zimi-mcp[pdf]"`.

Want the web app, the catalog and the rest? `pip install zimi` is the complete experience and includes the same `zimi-mcp` command. Install one or the other, not both: they share the `zimi` module.

Tools, options and measured numbers: [API & MCP](https://github.com/epheterson/Zimi/blob/main/docs/features/api-and-mcp.md#just-the-basics).
