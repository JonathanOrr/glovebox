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
import bisect
import functools
import glob
import json
import os
import random
import re
import shutil
from collections import Counter
from concurrent.futures import ThreadPoolExecutor

import cv2

from camera_model import CAMS, HERE, default_teslacam
import telemetry

GAP, TURN_GAP = 6, 18   # frames between the two instants of a moment (sharp turns: longer)
SCAN_STEP = 3           # read telemetry for every 3rd frame (the gaps must be multiples)
FPS = 36
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


@functools.cache
def frame_times(path):
    """Each frame's time in a clip (seconds from the file's start), or None if unreadable."""
    try:
        with open(path, "rb") as f:
            times, end = telemetry._sample_table(telemetry._read_moov(f))[2:]
        return times + [end]  # the last entry is where the file ends
    except (OSError, ValueError, KeyError):
        return None


def save_frames(clip, wanted):
    """Save frames of one clip, given as [(frame index, output file)]."""
    cv2.setNumThreads(2)
    cap = cv2.VideoCapture(clip)
    pos = None
    for k, out in sorted(wanted):
        if pos is None or not 0 <= k - pos < 40:  # seek, or read on if it's just ahead
            cap.set(cv2.CAP_PROP_POS_FRAMES, k)
            pos = k
        while pos < k and cap.grab():
            pos += 1
        ok, img = cap.read()
        pos += 1
        if ok and pos - 1 == k:
            cv2.imwrite(out, img, [cv2.IMWRITE_JPEG_QUALITY, 95])
    cap.release()


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
    # The six files of a minute end at the same instant but start up to half a second
    # apart, so the front camera's file time t is file time t + (its duration - the
    # front's) in another camera. Every camera is read at the same real instants.
    jobs = {}  # clip -> [(frame index, output file)]
    for i, p in enumerate(picks):
        p["id"] = i
        front = frame_times(p["clip"])
        for c in cams:
            src = p["clip"].replace("-front.mp4", f"-{c}.mp4")
            times = frame_times(src)
            if not front or not times:
                continue
            lag = times[-1] - front[-1]
            for which in ("t1", "t2"):
                t = p[which] + lag
                k = bisect.bisect_left(times, t, hi=len(times) - 1)
                k = min((j for j in (k - 1, k) if 0 <= j < len(times) - 1), key=lambda j: abs(times[j] - t), default=None)
                if k is not None and abs(times[k] - t) < 1 / FPS:  # the nearest frame, if the camera has one then
                    jobs.setdefault(src, []).append((k, os.path.join(frames, f"{i}-{c}-{which}.jpg")))
    print(f"extracting {sum(map(len, jobs.values()))} frames ...", flush=True)
    with ThreadPoolExecutor(8) as ex:
        list(ex.map(lambda j: save_frames(*j), jobs.items()))

    # Drop moments with a missing frame (e.g. past the end of a camera's clip) and dark
    # ones (dusk, car parks, tunnels), which have too few features to match.
    kept = []
    for p in picks:
        paths = [os.path.join(frames, f"{p['id']}-{c}-{w}.jpg") for c in cams for w in ("t1", "t2")]
        img = cv2.imread(paths[0], cv2.IMREAD_GRAYSCALE) if all(map(os.path.exists, paths)) else None
        if img is not None and img.mean() > 60:
            kept.append(p)
        else:
            for f in glob.glob(os.path.join(frames, f"{p['id']}-*.jpg")):
                os.remove(f)
    with open(os.path.join(args.work, "moments.json"), "w") as fh:
        json.dump({"cameras": cams, "moments": kept}, fh, indent=0)
    print(f"{len(kept)} moments saved to {args.work} ({len(picks) - len(kept)} dark or incomplete, dropped)")


if __name__ == "__main__":
    main()
