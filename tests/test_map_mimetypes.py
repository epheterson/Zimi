"""Map ZIMs (Leaflet / MapLibre) store vector tiles as .pbf/.mvt. A tile
loader that inspects Content-Type needs protobuf, not octet-stream — so the
server's extension→MIME fallback must resolve the map/geodata types.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi.server as server  # noqa: E402


def test_vector_tile_extensions_resolve_to_protobuf():
    assert server.MIME_FALLBACK[".pbf"] == "application/x-protobuf"
    assert server.MIME_FALLBACK[".mvt"] == "application/x-protobuf"


def test_geodata_extensions_resolve():
    assert server.MIME_FALLBACK[".geojson"] == "application/geo+json"
    assert server.MIME_FALLBACK[".topojson"] == "application/json"


def test_raster_tiles_still_covered():
    # Raster (.png) OSM tiles were already handled — guard against regression.
    assert server.MIME_FALLBACK[".png"] == "image/png"
