"""A planet's and its rings' eye vector is in the world's axes, as the Sun's direction and a ring's normal are.

It was made in the camera's own axes, so a ring was lit (and a planet's rim glowed) as if seen from the wrong side: Saturn's rings came out dim.
Read back from the GL: the vertex shader's `vView` at the middle of the picture, for a sphere straight ahead, is the direction back to the camera.

Run: pytest tests/test_almanac_ring_light_browser.py -v
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_almanac_iss_browser import _browser, _open, served  # noqa: E402,F401

PROBE = """() => {
  var S = _ae.gl, T = S.THREE, cam = S.camera;
  _ae.fly = null; _ae.az = 0.9; _ae.el_ = 0.5; _ae.dist = 6; _aePlaceCamera(); cam.updateMatrixWorld(true);
  var look = cam.getWorldDirection(new T.Vector3());
  var mesh = new T.Mesh(new T.SphereGeometry(0.5, 16, 16), new T.ShaderMaterial({
    vertexShader: AE_SPHERE_VERT,
    fragmentShader: 'precision highp float; varying vec2 vUv; varying vec3 vWorld; varying vec3 vNormal; varying vec3 vView; varying vec3 vRel; void main() { gl_FragColor = vec4(normalize(vView) * 0.5 + 0.5, 1.0); }'
  }));
  mesh.position.copy(cam.position).addScaledVector(look, 3);
  mesh.updateMatrixWorld(true);
  var scene = new T.Scene(); scene.add(mesh);
  var rt = new T.WebGLRenderTarget(64, 64), px = new Uint8Array(4);
  var old = S.renderer.getRenderTarget();
  S.renderer.setRenderTarget(rt);
  S.renderer.render(scene, cam);
  S.renderer.readRenderTargetPixels(rt, 32, 32, 1, 1, px);
  S.renderer.setRenderTarget(old);
  rt.dispose(); mesh.geometry.dispose(); mesh.material.dispose();
  return { got: [px[0], px[1], px[2]].map(function (v) { return v / 255 * 2 - 1; }), want: [-look.x, -look.y, -look.z] };
}"""


def test_the_eye_vector_is_in_world_axes(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = _browser(pw)
        try:
            ctx, pg, errors = _open(br, served, "earth")
            pg.wait_for_function("() => !!_ae.scene", timeout=120_000, polling=300)
            r = pg.evaluate(PROBE)
            for g, w in zip(r["got"], r["want"]):
                assert abs(g - w) < 0.08, r
            assert not errors, errors
            ctx.close()
        finally:
            br.close()
