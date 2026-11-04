"""A port the OS says is free, so no test binds a fixed one and the suite can
run in parallel (pytest-xdist) beside whatever else is on the machine."""

import socket


def free_port(host="127.0.0.1"):
    with socket.socket() as s:
        s.bind((host, 0))
        return s.getsockname()[1]
