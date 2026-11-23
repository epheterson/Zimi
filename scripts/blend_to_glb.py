"""Export a NASA 3D Resources .blend to a GLB the site-model builder reads (scripts/build_site_models.py).

    blender -b "Curiosity Rover (MSL) (Clean).blend" --python scripts/blend_to_glb.py -- curiosity.glb

Run with any Blender 3.6 or later (built with 4.2.9 on the Mac mini, installed from the official disk image and removed
after). Textures are embedded (the builder takes each one's mean colour); Draco is off.
"""

import bpy, sys

out = sys.argv[sys.argv.index("--") + 1]
objs = [o for o in bpy.data.objects if o.type == "MESH"]
print("MESHES", len(objs))
tris = 0
for o in objs[:80]:
    d = o.dimensions
    print(
        o.name,
        len(o.data.polygons),
        [round(x, 2) for x in d],
        [m.name for m in o.data.materials][:2],
    )
for o in objs:
    tris += len(o.data.polygons)
print("TOTAL polys", tris)
bpy.ops.export_scene.gltf(
    filepath=out,
    export_format="GLB",
    export_apply=True,
    export_draco_mesh_compression_enable=False,
    export_image_format="AUTO",
    export_materials="EXPORT",
)
print("EXPORTED", out)
