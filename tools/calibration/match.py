#!/usr/bin/env python3
"""Step 2: find the same scenery in pairs of frames (SIFT + RANSAC), in parallel.

 - temporal: one camera, the two instants of a moment (the car moved in between)
 - cross:    neighbouring cameras at the same instant

Usage: python3 match.py [--work DIR]
"""
import argparse
import json
import os
import pickle
import time
from multiprocessing import Pool

import cv2
import numpy as np

from camera_model import HERE, NEIGHBOURS

FRAMES = ""


def features(path):
    img = cv2.imread(path, cv2.IMREAD_GRAYSCALE)
    if img is None:
        return None, None, 1.0
    s = 1.0
    if img.shape[1] > 2000:  # HW4's front camera: match at the side cameras' scale
        img, s = cv2.resize(img, None, fx=0.5, fy=0.5), 2.0
    kp, des = cv2.SIFT_create(nfeatures=5000).detectAndCompute(img, None)
    return np.array([k.pt for k in kp]) * s, des, s


def good_matches(fa, fb, ratio):
    (pa, da, _), (pb, db, _) = fa, fb
    if da is None or db is None:
        return None, None
    g = [m[0] for m in cv2.BFMatcher().knnMatch(da, db, k=2) if len(m) == 2 and m[0].distance < ratio * m[1].distance]
    return pa[[m.queryIdx for m in g]], pb[[m.trainIdx for m in g]]


def temporal(job):
    cam, mid = job
    cv2.setNumThreads(1)
    f1 = features(f"{FRAMES}/{mid}-{cam}-t1.png")
    a, b = good_matches(f1, features(f"{FRAMES}/{mid}-{cam}-t2.png"), 0.7)
    if a is None or len(a) < 15:
        return None
    s = f1[2]  # pixel thresholds at the scale features were found at
    moved = np.linalg.norm(a - b, axis=1) > 1.0 * s  # still in the picture = the car's own body
    a, b = a[moved], b[moved]
    if len(a) < 15:
        return None
    F, mask = cv2.findFundamentalMat(a, b, cv2.FM_RANSAC, 1.5 * s, 0.999)
    if F is None:
        return None
    mask = mask.ravel().astype(bool)
    return "temporal", cam, mid, a[mask], b[mask]


def cross(job):
    (ca, cb), mid = job
    cv2.setNumThreads(1)
    a, b = good_matches(features(f"{FRAMES}/{mid}-{ca}-t1.png"), features(f"{FRAMES}/{mid}-{cb}-t1.png"), 0.75)
    if a is None or len(a) < 12:
        return None
    F, mask = cv2.findFundamentalMat(a, b, cv2.FM_RANSAC, 2.0, 0.999)
    if F is None or mask.sum() < 12:
        return None
    mask = mask.ravel().astype(bool)
    return "cross", (ca, cb), mid, a[mask], b[mask]


def run(job):
    return temporal(job) if isinstance(job[0], str) else cross(job)


def init(frames):
    global FRAMES
    FRAMES = frames


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--work", default=os.path.join(HERE, "work"))
    ap.add_argument("--procs", type=int, default=max(1, (os.cpu_count() or 2) - 2))
    args = ap.parse_args()
    with open(os.path.join(args.work, "moments.json")) as fh:
        rec = json.load(fh)
    cams, moments = rec["cameras"], rec["moments"]
    pairs = [p for p in NEIGHBOURS if p[0] in cams and p[1] in cams]
    jobs = [(c, m["id"]) for c in cams for m in moments] + [(p, m["id"]) for p in pairs for m in moments]
    t = time.time()
    frames = os.path.join(args.work, "frames")
    with Pool(args.procs, initializer=init, initargs=(frames,)) as pool:
        res = [r for r in pool.imap_unordered(run, jobs, chunksize=4) if r]
    frames_of = lambda c: cv2.imread(os.path.join(frames, f"{moments[0]['id']}-{c}-t1.png"), cv2.IMREAD_GRAYSCALE).shape
    out = {"cameras": cams, "sizes": {c: (frames_of(c)[1], frames_of(c)[0]) for c in cams},
           "temporal": {c: [] for c in cams}, "cross": {p: [] for p in pairs}}
    for kind, key, mid, a, b in res:
        out[kind][key].append((mid, a, b))
    with open(os.path.join(args.work, "matches.pkl"), "wb") as fh:
        pickle.dump(out, fh)
    for c in cams:
        it = out["temporal"][c]
        print(f"{c:>14}: {len(it):3d} moments, {sum(len(a) for _, a, _ in it):6d} matches")
    for a, b in pairs:
        it = out["cross"][(a, b)]
        print(f"{a:>14} ~ {b:<14} {len(it):3d} frame sets, {sum(len(x) for _, x, _ in it):5d} matches")
    print(f"{time.time() - t:.0f}s")


if __name__ == "__main__":
    main()
