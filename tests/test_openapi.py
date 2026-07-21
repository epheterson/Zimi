#!/usr/bin/env python3
"""OpenAPI 3.1 spec — structural validity, path coverage, version sync.

No dependency added: if openapi-spec-validator is importable we use it, else we
run a structural self-check (openapi field present, paths non-empty, every
operation carries responses).
"""

import json
import os
import sys
import threading
import tempfile
import unittest
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi.server as server  # noqa: E402
from zimi.openapi import build_openapi  # noqa: E402

# The eight stable paths the spec documents. /w/{zim}/{path} is the raw-content
# endpoint the plan calls "/content".
EXPECTED_PATHS = {
    "/search",
    "/suggest",
    "/read",
    "/chunks",
    "/w/{zim}/{path}",
    "/list",
    "/random",
    "/health",
}


class TestOpenAPISpec(unittest.TestCase):
    def setUp(self):
        self.spec = build_openapi()

    def test_parses_as_json(self):
        # Round-trips cleanly (no non-serializable values).
        reparsed = json.loads(json.dumps(self.spec))
        self.assertEqual(reparsed["openapi"], "3.1.0")

    def test_documents_all_eight_paths(self):
        self.assertEqual(set(self.spec["paths"].keys()), EXPECTED_PATHS)
        self.assertEqual(len(self.spec["paths"]), 8)

    def test_version_mirrors_server(self):
        self.assertEqual(self.spec["info"]["version"], server.ZIMI_VERSION)

    def test_search_documents_optional_fields(self):
        # The /search 200 body advertises the optional did_you_mean suggestion
        # and the auto-detected language that search_all can attach.
        props = self.spec["paths"]["/search"]["get"]["responses"]["200"]["content"][
            "application/json"
        ]["schema"]["properties"]
        self.assertIn("did_you_mean", props)
        self.assertEqual(props["did_you_mean"]["type"], "string")
        self.assertIn("detected_language", props)
        self.assertEqual(props["detected_language"]["type"], "string")

    def test_structural_self_check(self):
        try:
            from openapi_spec_validator import validate  # type: ignore

            validate(self.spec)
            return
        except ImportError:
            pass
        # Fallback structural check — no dependency required.
        self.assertTrue(self.spec.get("openapi"))
        self.assertTrue(self.spec.get("paths"))
        for path, ops in self.spec["paths"].items():
            for method, op in ops.items():
                self.assertIn("responses", op, f"{method} {path} missing responses")
                self.assertTrue(op["responses"], f"{method} {path} empty responses")


class TestOpenAPIRoute(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from http.server import ThreadingHTTPServer
        import zimi

        cls._tmp = tempfile.mkdtemp()
        os.environ["ZIM_DIR"] = cls._tmp
        zimi.ZIM_DIR = cls._tmp
        zimi.ZIMI_DATA_DIR = os.path.join(cls._tmp, ".zimi")
        os.makedirs(zimi.ZIMI_DATA_DIR, exist_ok=True)
        zimi.load_cache()
        cls._srv = ThreadingHTTPServer(("127.0.0.1", 0), zimi.ZimHandler)
        cls._port = cls._srv.server_address[1]
        threading.Thread(target=cls._srv.serve_forever, daemon=True).start()
        cls._base = f"http://127.0.0.1:{cls._port}"

    @classmethod
    def tearDownClass(cls):
        cls._srv.shutdown()
        import shutil

        shutil.rmtree(cls._tmp, ignore_errors=True)

    def test_served_unauthenticated(self):
        # No Authorization header — the spec is public.
        with urllib.request.urlopen(f"{self._base}/openapi.json", timeout=10) as r:
            data = json.loads(r.read())
            self.assertEqual(r.status, 200)
        self.assertEqual(len(data["paths"]), 8)
        self.assertEqual(data["info"]["version"], server.ZIMI_VERSION)


if __name__ == "__main__":
    unittest.main()
