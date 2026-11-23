Vendored for tests/test_js_undefined_names.cjs, which finds names the shipped JavaScript uses and nothing defines.
Unmodified, except that the requires between them are relative paths (and esrecurse reads no package.json):

- acorn 8.15.0 (MIT, acorn.LICENSE): the parser
- eslint-scope 8.4.0 (BSD-2-Clause, eslint-scope.LICENSE), esrecurse 4.3.0, estraverse 5.3.0 (BSD-2-Clause, estraverse.LICENSE): scope analysis
- globals.json: the browser, worker, service-worker and ES2021 global names, from the `globals` package (MIT)
