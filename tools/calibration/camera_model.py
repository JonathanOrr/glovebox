"""Camera model shared by the calibration scripts (matches static/js/pano.js).

Lens (Kannala-Brandt): a ray at angle th from the optical axis lands
f * (th + k1*th^3 + k2*th^5) image-widths from the image centre.
Orientation: yaw (+ = right), pitch (+ = up), roll, in degrees; R = Ry @ Rp @ Rr.
Car frame: x right, y up, z forward, metres; origin on the ground under the rear axle.
"""
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, PROJECT)  # for telemetry.py

# Every camera TeslaCam can record (clip filename suffixes). Some cars record fewer.
CAMS = ["front", "left_pillar", "right_pillar", "left_repeater", "right_repeater", "back"]
# Neighbouring cameras whose views may overlap (on a Model 3, front and pillars don't).
NEIGHBOURS = [("front", "left_pillar"), ("front", "right_pillar"), ("left_pillar", "left_repeater"),
              ("right_pillar", "right_repeater"), ("back", "left_repeater"), ("back", "right_repeater")]
VEHICLES = os.path.join(HERE, "vehicles")


def default_teslacam():
    user = os.environ.get("USER", "")
    for base in (f"/run/media/{user}", f"/media/{user}", "/media", "/mnt"):
        if os.path.isdir(base):
            for d in sorted(os.listdir(base)):
                if os.path.isdir(os.path.join(base, d, "TeslaCam")):
                    return os.path.join(base, d, "TeslaCam")
    return None


def rotations(yaw, pitch, roll):
    """Rotation matrices (n, 3, 3) from arrays of angles in degrees."""
    y, p, r = (np.radians(np.asarray(a, float)) for a in (yaw, pitch, roll))
    c, s, o, i = np.cos, np.sin, np.zeros_like(y), np.ones_like(y)
    Ry = np.stack([np.stack([c(y), o, s(y)], -1), np.stack([o, i, o], -1), np.stack([-s(y), o, c(y)], -1)], 1)
    Rp = np.stack([np.stack([i, o, o], -1), np.stack([o, c(p), s(p)], -1), np.stack([o, -s(p), c(p)], -1)], 1)
    Rr = np.stack([np.stack([c(r), -s(r), o], -1), np.stack([s(r), c(r), o], -1), np.stack([o, o, i], -1)], 1)
    return Ry @ Rp @ Rr


def unproject(pts, W, H, f, k1, k2):
    """Pixels -> unit rays in camera coordinates (x right, y up, z along the axis)."""
    x = pts[:, 0] / W - 0.5
    y = -(pts[:, 1] / W - 0.5 * H / W)
    r = np.hypot(x, y)
    th = r / f
    for _ in range(10):  # Newton: solve f*(th + k1 th^3 + k2 th^5) = r
        th = np.clip(th - (f * (th + k1 * th**3 + k2 * th**5) - r) / (f * (1 + 3 * k1 * th**2 + 5 * k2 * th**4)), 0, 2.2)
    ph = np.arctan2(y, x)
    return np.stack([np.sin(th) * np.cos(ph), np.sin(th) * np.sin(ph), np.cos(th)], 1)


def project(v, W, H, f, k1, k2):
    """Camera-coordinate vectors -> pixels."""
    n = np.linalg.norm(v, axis=1)
    th = np.arccos(np.clip(v[:, 2] / n, -1, 1))
    ph = np.arctan2(v[:, 1], v[:, 0])
    r = f * (th + k1 * th**3 + k2 * th**5)
    return np.stack([W * (0.5 + r * np.cos(ph)), W * (0.5 * H / W - r * np.sin(ph))], 1)


def hfov(f, k1, k2):
    """Horizontal field of view in degrees."""
    th = 0.5 / f
    for _ in range(20):
        th -= (f * (th + k1 * th**3 + k2 * th**5) - 0.5) / (f * (1 + 3 * k1 * th**2 + 5 * k2 * th**4))
    return 2 * np.degrees(th)


def load_vehicle(path):
    """A vehicle file (see vehicles/): name, eye point, and per camera its lens
    position (car frame, metres) and rough aim [yaw, pitch] to start the solve from."""
    if not os.path.exists(path) and os.path.exists(os.path.join(VEHICLES, path + ".json")):
        path = os.path.join(VEHICLES, path + ".json")
    with open(path) as fh:
        v = json.load(fh)
    bad = [c for c, cam in v["cameras"].items() if c not in CAMS or len(cam.get("pos", [])) != 3]
    if bad:
        sys.exit(f"{path}: unknown camera or missing position for: {', '.join(bad)}")
    return v
