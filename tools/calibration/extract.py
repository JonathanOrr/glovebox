#!/usr/bin/env python3
"""Step 1: pick moments from daytime drives and save frames for calibration.

A moment is two instants 6 frames (~0.17 s) apart while the car is driving, or
18 frames (0.5 s) apart through a sharp turn, where the bigger rotation pins down
each lens's field of view. For
each, every camera's frame at both instants is saved, together with how far the
car moved and turned between them (from the telemetry embedded in the clips).
The first instant of each moment also serves as a same-time frame set for
matching scenery between neighbouring cameras.

Usage: python3 extract.py [/path/to/TeslaCam] [--work DIR] [--hours 8-17]
"""
import argparse
import glob
import json
import os
import random
import re
import shutil
import subprocess
from collections import Counter
from concurrent.futures import ThreadPoolExecutor

import cv2

from camera_model import CAMS, HERE, default_teslacam
import telemetry

GAP, TURN_GAP = 6, 18   # frames between the two instants of a moment (sharp turns: longer)
SCAN_STEP = 3           # read telemetry for every 3rd frame (the gaps must be multiples)
TS_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})_(\d{2})-\d{2}-\d{2}-front\.mp4$")


def scan_clip(path):
    """Candidate moments in one front clip, each tagged straight, gentle or sharp."""
    try:
        r = telemetry.extract(path, SCAN_STEP)
    except (OSError, ValueError):
        return []
    fr, t = r["frames"], r["times"]

    def moment(i, gap):
        k = gap // SCAN_STEP
        if i + k >= len(fr):
            return None
        a, b = fr[i], fr[i + k]
        if not a or not b or a.get("gear") != 1 or a.get("speed_mps", 0) < 4 or "heading" not in a or "heading" not in b:
            return None
        dh = (b["heading"] - a["heading"] + 540) % 360 - 180
        dist = (a["speed_mps"] + b.get("speed_mps", 0)) / 2 * (t[i + k] - t[i])
        return {"clip": path, "t1": round(t[i], 4), "t2": round(t[i + k], 4), "dh": round(dh, 4), "dist": round(dist, 4)}

    out = []
    for i in range(0, len(fr), 3):
        m = moment(i, GAP)
        if m and abs(m["dh"]) < 0.1:
            out.append(("straight", m))
        elif m and 0.8 < abs(m["dh"]) <= 3:
            out.append(("gentle", m))
        m = moment(i, TURN_GAP)
        if m and abs(m["dh"]) > 3:
            out.append(("sharp", m))
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("root", nargs="?", default=default_teslacam(), help="TeslaCam folder (auto-detected)")
    ap.add_argument("--work", default=os.path.join(HERE, "work"), help="where frames and results go")
    ap.add_argument("--hours", default="8-17", help="only use clips recorded in these local hours (daylight)")
    ap.add_argument("--straight", type=int, default=28, help="moments driving straight")
    ap.add_argument("--turning", type=int, default=50, help="moments while turning (these pin down rotation)")
    ap.add_argument("--seed", type=int, default=1)
    args = ap.parse_args()
    if not args.root or not os.path.isdir(args.root):
        ap.error("TeslaCam folder not found; pass its path")
    h0, h1 = map(int, args.hours.split("-"))

    # Which cameras this car records (HW3 cars record fewer than HW4): the most common set.
    clips = {}
    for src in ("SavedClips", "SentryClips", "RecentClips"):
        for f in sorted(glob.glob(os.path.join(args.root, src, "**", "*-front.mp4"), recursive=True)):
            m = TS_RE.match(os.path.basename(f))
            if m and h0 <= int(m.group(2)) <= h1:
                clips[f] = tuple(c for c in CAMS if os.path.exists(f.replace("-front.mp4", f"-{c}.mp4")))
    if not clips:
        raise SystemExit("no daytime clips found")
    cams = list(Counter(clips.values()).most_common(1)[0][0])
    clips = [f for f, cs in clips.items() if set(cams) <= set(cs)]
    print("cameras:", ", ".join(cams))
    print(f"scanning telemetry in {len(clips)} daytime clips ...", flush=True)
    with ThreadPoolExecutor(8) as ex:
        cands = [m for ms in ex.map(scan_clip, clips) for m in ms]
    straight, gentle, sharp = ([m for kind, m in cands if kind == k] for k in ("straight", "gentle", "sharp"))
    print(f"{len(straight)} straight, {len(gentle)} gentle-turn, {len(sharp)} sharp-turn candidates")
    if len(straight) + len(gentle) + len(sharp) == 0:
        raise SystemExit("no driving found (needs clips recorded while driving in D above ~15 km/h)")

    rnd = random.Random(args.seed)
    take = lambda pool, n: rnd.sample(pool, min(n, len(pool)))
    n_sharp = min(len(sharp), args.turning * 3 // 5)
    picks = take(straight, args.straight) + take(sharp, n_sharp) + take(gentle, args.turning - n_sharp)

    frames = os.path.join(args.work, "frames")
    shutil.rmtree(frames, ignore_errors=True)
    os.makedirs(frames)
    jobs = []
    for i, p in enumerate(picks):
        p["id"] = i
        for c in cams:
            src = p["clip"].replace("-front.mp4", f"-{c}.mp4")
            for which in ("t1", "t2"):
                jobs.append(["ffmpeg", "-v", "error", "-y", "-ss", f"{p[which]:.4f}", "-i", src, "-frames:v", "1",
                             os.path.join(frames, f"{i}-{c}-{which}.png")])
    print(f"extracting {len(jobs)} frames ...", flush=True)
    with ThreadPoolExecutor(8) as ex:
        list(ex.map(lambda j: subprocess.run(j, check=False), jobs))

    # Drop moments with a missing frame (e.g. past the end of a camera's clip) and dark
    # ones (dusk, car parks, tunnels), which have too few features to match.
    kept = []
    for p in picks:
        paths = [os.path.join(frames, f"{p['id']}-{c}-{w}.png") for c in cams for w in ("t1", "t2")]
        img = cv2.imread(paths[0], cv2.IMREAD_GRAYSCALE) if all(map(os.path.exists, paths)) else None
        if img is not None and img.mean() > 60:
            kept.append(p)
        else:
            for f in glob.glob(os.path.join(frames, f"{p['id']}-*.png")):
                os.remove(f)
    with open(os.path.join(args.work, "moments.json"), "w") as fh:
        json.dump({"cameras": cams, "moments": kept}, fh, indent=0)
    print(f"{len(kept)} moments saved to {args.work} ({len(picks) - len(kept)} dark or incomplete, dropped)")


if __name__ == "__main__":
    main()
