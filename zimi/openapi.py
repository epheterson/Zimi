"""Hand-authored OpenAPI 3.1 description of Zimi's stable agent API.

Served at /openapi.json (unauthenticated, rate-limited). Kept by hand rather
than generated: the stdlib server has no framework to introspect, and a curated
spec documents only the endpoints we commit to keeping stable (see
docs/api-stability.md). `info.version` mirrors the running server VERSION so the
spec never drifts from the build serving it.

The raw-content endpoint is `/w/{zim}/{path}` (the plan's "/content"): it serves
an article's original HTML/asset bytes for the reader, distinct from /read which
returns stripped plain text.
"""

import zimi.server as _srv


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
                    {
                        "name": "q",
                        "in": "query",
                        "required": True,
                        "schema": {"type": "string"},
                    },
                    {
                        "name": "zim",
                        "in": "query",
                        "required": False,
                        "schema": {"type": "string"},
                        "description": "Comma-separated source names",
                    },
                    {
                        "name": "collection",
                        "in": "query",
                        "required": False,
                        "schema": {"type": "string"},
                    },
                    {
                        "name": "lang",
                        "in": "query",
                        "required": False,
                        "schema": {"type": "string"},
                    },
                    {
                        "name": "limit",
                        "in": "query",
                        "required": False,
                        "schema": {"type": "integer", "default": 5},
                    },
                    {
                        "name": "fast",
                        "in": "query",
                        "required": False,
                        "schema": {"type": "string", "enum": ["1"]},
                    },
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
                    {
                        "name": "q",
                        "in": "query",
                        "required": True,
                        "schema": {"type": "string"},
                    },
                    {
                        "name": "zim",
                        "in": "query",
                        "required": False,
                        "schema": {"type": "string"},
                    },
                    {
                        "name": "collection",
                        "in": "query",
                        "required": False,
                        "schema": {"type": "string"},
                    },
                    {
                        "name": "limit",
                        "in": "query",
                        "required": False,
                        "schema": {"type": "integer", "default": 10},
                    },
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
                    {
                        "name": "zim",
                        "in": "query",
                        "required": True,
                        "schema": {"type": "string"},
                    },
                    {
                        "name": "path",
                        "in": "query",
                        "required": True,
                        "schema": {"type": "string"},
                    },
                    {
                        "name": "max_length",
                        "in": "query",
                        "required": False,
                        "schema": {"type": "integer"},
                    },
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
                    {
                        "name": "zim",
                        "in": "query",
                        "required": True,
                        "schema": {"type": "string"},
                    },
                    {
                        "name": "path",
                        "in": "query",
                        "required": True,
                        "schema": {"type": "string"},
                    },
                    {
                        "name": "size",
                        "in": "query",
                        "required": False,
                        "schema": {
                            "type": "integer",
                            "minimum": 200,
                            "maximum": 4000,
                            "default": 1200,
                        },
                    },
                    {
                        "name": "overlap",
                        "in": "query",
                        "required": False,
                        "schema": {"type": "integer", "minimum": 0, "default": 120},
                        "description": "Clamped to size/2",
                    },
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
                                "total_chunks": {"type": "integer"},
                                "chunks": {"type": "array", "items": chunk_schema},
                            },
                            "required": [
                                "zim",
                                "path",
                                "content_rev",
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
                    {
                        "name": "zim",
                        "in": "path",
                        "required": True,
                        "schema": {"type": "string"},
                    },
                    {
                        "name": "path",
                        "in": "path",
                        "required": True,
                        "schema": {"type": "string"},
                    },
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
                                    "size_gb": {"type": "number"},
                                    "language": {"type": "string"},
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
                    {
                        "name": "zim",
                        "in": "query",
                        "required": False,
                        "schema": {"type": "string"},
                    },
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
