"""Tests for the UPnP/NAT module (stdlib SSDP + SOAP).

Network calls are stubbed — these cover URL gating, device-description
parsing, and probe result shape.
"""

import io
import os
import sys
import urllib.request

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi.p2p_nat as nat  # noqa: E402

IGD_XML = b"""<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <URLBase>http://192.168.1.1:5000</URLBase>
  <device>
    <deviceList><device><serviceList>
      <service>
        <serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType>
        <controlURL>/ctl/IPConn</controlURL>
      </service>
    </serviceList></device></deviceList>
  </device>
</root>"""


class _FakeResp(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


@pytest.fixture(autouse=True)
def _clear_status():
    with nat._status_lock:
        nat._last_status.clear()
    yield


def test_private_url_gate():
    assert nat._is_private_url("http://192.168.1.1:5000/desc.xml")
    assert nat._is_private_url("http://10.0.0.1/igd.xml")
    assert not nat._is_private_url("http://93.184.216.34/desc.xml")
    assert not nat._is_private_url("http://evil.example.com/desc.xml")  # hostname
    assert not nat._is_private_url("not a url")


def test_find_control_parses_igd_description(monkeypatch):
    monkeypatch.setattr(urllib.request, "urlopen", lambda *a, **k: _FakeResp(IGD_XML))
    found = nat._find_control("http://192.168.1.1:5000/desc.xml")
    assert found == (
        "http://192.168.1.1:5000/ctl/IPConn",
        "urn:schemas-upnp-org:service:WANIPConnection:1",
    )


def test_find_control_rejects_dtd(monkeypatch):
    evil = b'<?xml version="1.0"?><!DOCTYPE r [<!ENTITY x "y">]><root/>'
    monkeypatch.setattr(urllib.request, "urlopen", lambda *a, **k: _FakeResp(evil))
    assert nat._find_control("http://192.168.1.1/desc.xml") is None


def test_find_control_rejects_public_control_url(monkeypatch):
    xml = IGD_XML.replace(b"<URLBase>http://192.168.1.1:5000</URLBase>", b"").replace(
        b"/ctl/IPConn", b"http://93.184.216.34/ctl"
    )
    monkeypatch.setattr(urllib.request, "urlopen", lambda *a, **k: _FakeResp(xml))
    assert nat._find_control("http://192.168.1.1:5000/desc.xml") is None


def test_probe_shape_and_caching(monkeypatch):
    monkeypatch.setattr(nat, "_port_listening", lambda p: True)
    monkeypatch.setattr(nat, "add_port_mapping", lambda p: True)
    monkeypatch.setattr(nat, "get_external_ip", lambda: "203.0.113.7")
    monkeypatch.setattr(nat, "_port_reachable_external", lambda p: True)
    result = nat.probe(6881, try_upnp=True)
    assert result["listening"] is True
    assert result["upnp"] == "mapped"
    assert result["external_ip"] == "203.0.113.7"
    assert result["reachable"] is True
    assert nat.last_status()["bt_port"] == 6881


def test_probe_fails_soft_offline(monkeypatch):
    monkeypatch.setattr(nat, "_port_listening", lambda p: False)
    monkeypatch.setattr(nat, "add_port_mapping", lambda p: False)
    monkeypatch.setattr(nat, "_port_reachable_external", lambda p: None)
    result = nat.probe(6881, try_upnp=True)
    assert result["upnp"] == "unavailable"
    assert result["reachable"] is None
    assert result["external_ip"] is None


def test_probe_skips_upnp_when_disabled(monkeypatch):
    called = []
    monkeypatch.setattr(nat, "_port_listening", lambda p: False)
    monkeypatch.setattr(nat, "add_port_mapping", lambda p: called.append(p))
    monkeypatch.setattr(nat, "_port_reachable_external", lambda p: None)
    result = nat.probe(6881, try_upnp=False)
    assert result["upnp"] == "off"
    assert not called
