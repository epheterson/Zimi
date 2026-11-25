"""A port the OS says is free, so no test binds a fixed one and the suite can
run in parallel (pytest-xdist) beside whatever else is on the machine."""

import socket


def free_port(host="127.0.0.1"):
    with socket.socket() as s:
        s.bind((host, 0))
        return s.getsockname()[1]


def held_server(host="127.0.0.1"):
    """A listening HTTP server on a port nobody else can take: bound now, served later.

    free_port() hands the number back before anything binds it, so two modules asking at import
    can be given the same one (or an outgoing connection can take it), and the second bind fails
    with "Address already in use". A test that must know its port at import binds it here and
    keeps it: set `.RequestHandlerClass`, then run `serve_forever` in a thread.
    """
    import http.server

    return http.server.ThreadingHTTPServer((host, 0), http.server.BaseHTTPRequestHandler)
