"""Make vehicle files (camera positions and rough aims) from a Blender model.

Each camera is a mesh with a single edge: first vertex on the lens, second
roughly where the camera looks (within ~20° is plenty; the solve finds the
exact angle). Names (Blender's .001 suffixes are fine):
    Front_cam, L_pillar_cam, L_repeater_cam, Rear_cam   (+ R_pillar_cam, R_repeater_cam)
Right-side cameras that aren't placed are mirrored from the left.

Several cars in one file: one collection per car, named
after it, holding an empty called Rear_axle on the ground under the rear axle
(its x axis to the car's right, y forward, z up) and that car's camera edges.
Writes one vehicle file per collection into the output folder:

    blender -b cars.blend --python blender_cameras.py -- tools/calibration/vehicles/

One car without a Rear_axle empty (Blender axes x right, y forward, z up; the
defaults suit Tesla's Model 3 paint-kit model):

    blender -b car.blend --python blender_cameras.py -- out.json "Model 3 (HW4)" [--rear-axle-y -1.373] [--ground-z 0]

The .blend is only read, never saved.
"""
import json
import math
import os
import re
import sys

import bpy

NAMES = {"front": "Front_cam", "left_pillar": "L_pillar_cam", "right_pillar": "R_pillar_cam",
         "left_repeater": "L_repeater_cam", "right_repeater": "R_repeater_cam", "back": "Rear_cam"}


def base(name):
    return re.sub(r"\.\d{3}$", "", name)


def read_car(objects, to_car):
    """Camera positions and aims in the car frame (x right, y up, z forward).
    to_car maps a world point to (right, forward, up) from the ground under the rear axle."""
    cams = {}
    for cam, obj in NAMES.items():
        o = next((o for o in objects if base(o.name) == obj and o.type == "MESH" and o.data.vertices), None)
        if o is None:
            continue
        vs = []
        for v in o.data.vertices[:2]:
            r, f, u = to_car(o.matrix_world @ v.co)
            vs.append((r, u, f))
        cams[cam] = {"pos": [round(c, 4) for c in vs[0]]}
        if len(vs) == 2:
            dx, dy, dz = (b - a for a, b in zip(*vs))
            cams[cam]["aim"] = [round(math.degrees(math.atan2(dx, dz)), 1), round(math.degrees(math.atan2(dy, math.hypot(dx, dz))), 1)]
    for r, l in (("right_pillar", "left_pillar"), ("right_repeater", "left_repeater")):
        if r not in cams and l in cams:
            cams[r] = {k: [-v[0]] + v[1:] for k, v in cams[l].items()}
    return cams


def vehicle(name, cams):
    f = cams["front"]["pos"]
    return {"name": name, "about": "Camera positions placed by hand on a 3D model, exported by blender_cameras.py",
            "eye": [0, round(f[1] - 0.04, 3), round(f[2] - 0.55, 3)],  # head height, roughly mid-cabin
            "cameras": cams}


def report(name, cams):
    print(f"--- {name}")
    for c, v in cams.items():
        p = v["pos"]
        print(f"  {c:>14}: x {p[0]:+.3f}  height {p[1]:.3f}  forward of rear axle {p[2]:+.3f}  aim {v.get('aim')}")


args = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
if not args:
    sys.exit(__doc__)
cars = [(c, next(o for o in c.objects if base(o.name) == "Rear_axle")) for c in bpy.data.collections
        if any(base(o.name) == "Rear_axle" for o in c.objects)]
if cars:
    os.makedirs(args[0], exist_ok=True)
    for col, axle in cars:
        inv = axle.matrix_world.inverted()
        cams = read_car(col.all_objects, lambda w: tuple(inv @ w))
        if "front" not in cams:
            print(f"--- {col.name}: no Front_cam, skipped")
            continue
        report(col.name, cams)
        path = os.path.join(args[0], re.sub(r"[^a-z0-9]+", "_", col.name.lower()).strip("_") + ".json")
        with open(path, "w") as fh:
            json.dump(vehicle(col.name, cams), fh, indent=1)
        print("  wrote", path)
else:
    out, rest, name = args[0], args[1:], "Unnamed vehicle"
    if rest and not rest[0].startswith("--"):
        name, rest = rest[0], rest[1:]
    opt = dict(zip(rest[0::2], map(float, rest[1::2])))
    axle_y, ground_z = opt.get("--rear-axle-y", -1.373), opt.get("--ground-z", 0.0)
    cams = read_car(bpy.data.objects, lambda w: (w.x, w.y - axle_y, w.z - ground_z))
    if "front" not in cams:
        sys.exit("no Front_cam object found")
    report(name, cams)
    with open(out, "w") as fh:
        json.dump(vehicle(name, cams), fh, indent=1)
    print("wrote", out)
