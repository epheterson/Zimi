"""Wait for a state, never for a time.

A test that sleeps a fixed while and then asserts passes on a quiet machine and
fails on a loaded CI runner (1.15.4 lost hours to this). ``until`` polls a
condition and returns the moment it holds; the deadline is only how long a
broken run takes to fail, so it is generous.
"""

import time

DEADLINE_S = 30.0


def until(condition, what, deadline_s=DEADLINE_S, every_s=0.02):
    """Poll ``condition()`` until it is truthy and return its value; fail with
    ``what`` if it never is within ``deadline_s``."""
    end = time.monotonic() + deadline_s
    while True:
        value = condition()
        if value:
            return value
        if time.monotonic() >= end:
            raise AssertionError("never became true: %s" % what)
        time.sleep(every_s)
