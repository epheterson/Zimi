"""Hand-authored OpenAPI 3.1 description of Zimi's stable agent API.

Served at /openapi.json (unauthenticated, rate-limited). Kept by hand rather
than generated: the stdlib server has no framework to introspect, and a curated
spec documents only the endpoints we commit to keeping stable (see
docs/api-stability.md). `info.version` mirrors the running server VERSION so the
spec never drifts from the build serving it.

The raw-content endpoint is `/w/{zim}/{path}`: it serves an article's original
HTML/asset bytes for the reader, distinct from /read which returns stripped
plain text.
"""

import zimi.server as _srv


def _param(name, schema, required=False, where="query", description=None):
    p = {"name": name, "in": where, "required": required, "schema": schema}
    if description:
        p["description"] = description
    return p


def _error_schema():
    return {
        "type": "object",
        "properties": {"error": {"type": "string"}},
        "required": ["error"],
    }


def _json_response(description, schema):
    return {
        description: {
            "description": description,
            "content": {"application/json": {"schema": schema}},
        }
    }


def build_openapi():
    """Return the OpenAPI 3.1 document as a plain dict (version from VERSION)."""
    error = _error_schema()

    chunk_schema = {
        "type": "object",
        "properties": {
            "id": {
                "type": "string",
                "description": "sha256(zim|path|content_rev|seq|size|overlap)[:16]",
            },
            "seq": {"type": "integer"},
            "start": {
                "type": "integer",
                "description": "Char offset into stripped text",
            },
            "end": {"type": "integer"},
            "text": {"type": "string"},
        },
        "required": ["id", "seq", "start", "end", "text"],
    }

    paths = {
        "/search": {
            "get": {
                "summary": "Full-text search across ZIM sources",
                "operationId": "search",
                "parameters": [
                    _param("q", {"type": "string"}, required=True),
                    _param(
                        "zim",
                        {"type": "string"},
                        description="Comma-separated source names",
                    ),
                    _param("collection", {"type": "string"}),
                    _param("lang", {"type": "string"}),
                    _param("limit", {"type": "integer", "default": 5}),
                    _param("fast", {"type": "string", "enum": ["1"]}),
                ],
                "responses": {
                    **_json_response(
                        "200",
                        {
                            "type": "object",
                            "properties": {
                                "results": {
                                    "type": "array",
                                    "items": {"type": "object"},
                                },
                                "by_source": {"type": "object"},
                                "by_language": {"type": "object"},
                                "total": {"type": "integer"},
                                "elapsed": {"type": "number"},
                                "partial": {"type": "boolean"},
                                "detected_language": {
                                    "type": "string",
                                    "description": (
                                        "Language auto-detected from the query, "
                                        "when one could be inferred. Optional."
                                    ),
                                },
                                "did_you_mean": {
                                    "type": "string",
                                    "description": (
                                        "Spelling suggestion, present only when "
                                        "results are sparse and a correction was "
                                        "found. Optional."
                                    ),
                                },
                            },
                        },
                    ),
                    **_json_response("400", error),
                },
            }
        },
        "/suggest": {
            "get": {
                "summary": "Title autocomplete",
                "operationId": "suggest",
                "parameters": [
                    _param("q", {"type": "string"}, required=True),
                    _param("zim", {"type": "string"}),
                    _param("collection", {"type": "string"}),
                    _param("limit", {"type": "integer", "default": 10}),
                ],
                "responses": {
                    **_json_response(
                        "200",
                        {
                            "type": "object",
                            "additionalProperties": {
                                "type": "array",
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        "path": {"type": "string"},
                                        "title": {"type": "string"},
                                    },
                                },
                            },
                        },
                    ),
                    **_json_response("400", error),
                },
            }
        },
        "/read": {
            "get": {
                "summary": "Read an article as stripped plain text",
                "operationId": "read",
                "parameters": [
                    _param("zim", {"type": "string"}, required=True),
                    _param("path", {"type": "string"}, required=True),
                    _param("max_length", {"type": "integer"}),
                ],
                "responses": {
                    **_json_response(
                        "200",
                        {
                            "type": "object",
                            "properties": {
                                "zim": {"type": "string"},
                                "path": {"type": "string"},
                                "title": {"type": "string"},
                                "content": {"type": "string"},
                                "truncated": {"type": "boolean"},
                                "full_length": {"type": "integer"},
                                "mimetype": {"type": "string"},
                            },
                        },
                    ),
                    **_json_response("400", error),
                },
            }
        },
        "/chunks": {
            "get": {
                "summary": "Deterministic, embedding-free RAG chunking of an article",
                "operationId": "chunks",
                "parameters": [
                    _param("zim", {"type": "string"}, required=True),
                    _param("path", {"type": "string"}, required=True),
                    _param(
                        "size",
                        {
                            "type": "integer",
                            "minimum": 200,
                            "maximum": 4000,
                            "default": 1200,
                        },
                    ),
                    _param(
                        "overlap",
                        {"type": "integer", "minimum": 0, "default": 120},
                        description="Clamped to size/2",
                    ),
                ],
                "responses": {
                    **_json_response(
                        "200",
                        {
                            "type": "object",
                            "properties": {
                                "zim": {"type": "string"},
                                "path": {"type": "string"},
                                "title": {"type": "string"},
                                "size": {"type": "integer"},
                                "overlap": {"type": "integer"},
                                "content_rev": {
                                    "type": "string",
                                    "description": "sha256(stripped_text)[:12]",
                                },
                                "truncated": {
                                    "type": "boolean",
                                    "description": "True when the article's text exceeded the per-request cap and was truncated before chunking.",
                                },
                                "total_chunks": {"type": "integer"},
                                "chunks": {"type": "array", "items": chunk_schema},
                            },
                            "required": [
                                "zim",
                                "path",
                                "content_rev",
                                "truncated",
                                "total_chunks",
                                "chunks",
                            ],
                        },
                    ),
                    **_json_response("400", error),
                    **_json_response("404", error),
                },
            }
        },
        "/w/{zim}/{path}": {
            "get": {
                "summary": "Raw article content (original HTML/asset bytes) for the reader",
                "operationId": "content",
                "parameters": [
                    _param("zim", {"type": "string"}, required=True, where="path"),
                    _param("path", {"type": "string"}, required=True, where="path"),
                ],
                "responses": {
                    "200": {
                        "description": "Raw article bytes",
                        "content": {"text/html": {"schema": {"type": "string"}}},
                    },
                    "404": {"description": "Not found"},
                },
            }
        },
        "/list": {
            "get": {
                "summary": "List installed ZIM sources",
                "operationId": "list",
                "parameters": [
                    _param(
                        "layout",
                        {"type": "string"},
                        description="When truthy, wrap the response as "
                        '{"zims": [...], "section_order": [...]} — the '
                        "additive envelope carrying the home page's saved "
                        "section order (#37). Omit for the bare array "
                        "(default, unchanged).",
                    )
                ],
                "responses": {
                    **_json_response(
                        "200",
                        {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "name": {"type": "string"},
                                    "title": {"type": "string"},
                                    "entries": {"type": "integer"},
                                    "category": {
                                        "type": "string",
                                        "description": (
                                            "Effective category: a saved per-ZIM "
                                            "override (#37) when set, otherwise the "
                                            "ZIM dir subfolder the file lives in, "
                                            "otherwise the name-pattern heuristic. "
                                            "May be null."
                                        ),
                                    },
                                    "folder": {
                                        "type": "string",
                                        "description": (
                                            "Raw name of the ZIM dir subfolder this "
                                            "file lives in, prettified into "
                                            "`category`. Absent for root-level files."
                                        ),
                                    },
                                    "article_count": {
                                        "type": "integer",
                                        "description": (
                                            "Real article count (libzim "
                                            "article_count). Optional: absent for "
                                            "ZIMs cached before this field existed."
                                        ),
                                    },
                                    "size_gb": {"type": "number"},
                                    "language": {"type": "string"},
                                    "first_seen": {
                                        "type": "number",
                                        "description": (
                                            "Unix time Zimi first saw this ZIM "
                                            "(#34). Drives the 'New' badge and the "
                                            "'Recently added' library filter. "
                                            "Optional: absent for ZIMs cached "
                                            "before this field existed."
                                        ),
                                    },
                                    "updated_at": {
                                        "type": "number",
                                        "description": (
                                            "Unix time the ZIM's file last changed "
                                            "on disk (#34). Set only on an update "
                                            "(greater than first_seen); drives the "
                                            "'Updated' badge and the 'Recently "
                                            "updated' library filter. Null/absent "
                                            "for a fresh install."
                                        ),
                                    },
                                },
                            },
                        },
                    ),
                },
            }
        },
        "/random": {
            "get": {
                "summary": "Random article",
                "operationId": "random",
                "parameters": [
                    _param("zim", {"type": "string"}),
                ],
                "responses": {
                    **_json_response(
                        "200",
                        {
                            "type": "object",
                            "properties": {
                                "zim": {"type": "string"},
                                "title": {"type": "string"},
                                "path": {"type": "string"},
                                "error": {"type": "string"},
                            },
                        },
                    ),
                    **_json_response("404", error),
                },
            }
        },
        "/health": {
            "get": {
                "summary": "Liveness + build info",
                "operationId": "health",
                "responses": {
                    **_json_response(
                        "200",
                        {
                            "type": "object",
                            "properties": {
                                "status": {"type": "string"},
                                "version": {"type": "string"},
                                "asset_version": {"type": "string"},
                                "zim_count": {"type": "integer"},
                                "pdf_support": {"type": "boolean"},
                            },
                            "required": ["status", "version", "zim_count"],
                        },
                    ),
                },
            }
        },
    }

    return {
        "openapi": "3.1.0",
        "info": {
            "title": "Zimi API",
            "version": _srv.ZIMI_VERSION,
            "description": (
                "API-first offline knowledge server for ZIM files. Stable, "
                "additive-only agent surface — see docs/api-stability.md."
            ),
        },
        "paths": paths,
    }
