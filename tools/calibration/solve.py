#!/usr/bin/env python3
"""Step 3: solve all the cameras together (bundle adjustment).

Unknowns: each camera's orientation and lens (f, k1, k2), and a depth for every
matched point. Camera positions come from the vehicle file (measured on a 3D
model of the car); the footage pins them down poorly, so by default they stay put
(--bound lets them move). Evidence: the matches from step 2, with the car's
motion between the two instants of a moment taken from telemetry. Errors are
reprojection distances in pixels (at a 1448-px-wide image's scale).

The vehicle file's aims only need to be rough: each camera is first fitted on its
own from a spread of starting angles around its aim, and the best fit is kept.

Writes calibration.json in the project folder; the viewer's 360° view picks it
up on the next page load.

Usage: python3 solve.py [--work DIR] [--vehicle model_3_highland_hw4] [--bound 0] [--out FILE]
"""
import argparse
import itertools
import json
import os
import pickle
import time
from multiprocessing import Pool

import numpy as np
from scipy.optimize import least_squares
from scipy.sparse import lil_matrix

from camera_model import HERE, PROJECT, hfov, load_vehicle, project, rotations, unproject

# Starting lens (f, k1, k2) per camera unless the vehicle file gives one: Tesla's
# narrow-ish main front camera, wide side cameras and a fisheye at the back.
LENS_START = {"front": [1.2, 0.05, 0], "left_pillar": [0.7, -0.1, 0], "right_pillar": [0.7, -0.1, 0],
              "left_repeater": [0.72, -0.1, 0], "right_repeater": [0.72, -0.1, 0], "back": [0.34, 0, 0]}
LO = [-400, -40, -20, 0.25, -0.15, -0.03]   # k2 >= -0.03 keeps the lens curve from folding back
HI = [400, 25, 20, 1.5, 0.6, 0.3]
NP = 9                  # parameters per camera: the six above + x, y, z
TEMPORAL_PER_MOMENT = 40
CROSS_PER_PAIR = 500
CROSS_WEIGHT = 2.0      # few cross matches, but they're what ties the cameras together
# Left and right pillar (and repeater) cameras are the same part, so each right
# camera shares its left twin's lens; this stops a weakly-seen camera trading
# field of view for yaw.
TWINS = {"right_pillar": "left_pillar", "right_repeater": "left_repeater"}
# Per-camera search around the vehicle file's aim (degrees).
SEARCH_YAW = (-30, -15, 0, 15, 30)
SEARCH_PITCH = (-15, 0, 15)
SEARCH_PER_MOMENT = 12

B = None  # the problem (set in each worker process by init())


def ry(deg):
    a = np.radians(deg)
    return np.array([[np.cos(a), 0, np.sin(a)], [0, 1, 0], [-np.sin(a), 0, np.cos(a)]])


class Bundle:
    def __init__(self, cams, sizes, obs, P0, bound):
        self.cams, self.NC, self.P0 = cams, len(cams), P0
        CI = {c: i for i, c in enumerate(cams)}
        self.twins = [(CI[r], CI[l]) for r, l in TWINS.items() if r in CI and l in CI]
        self.cA = np.array([o[0] for o in obs])
        self.cB = np.array([o[1] for o in obs])
        self.PA = np.array([o[2] for o in obs], float)
        self.PB = np.array([o[3] for o in obs], float)
        self.DR = np.array([o[4] for o in obs])
        self.TT = np.array([o[5] for o in obs])
        self.W0 = np.array([o[6] for o in obs])
        self.WH = np.array([sizes[c] for c in cams], float)
        self.SCALE = 1448.0 / self.WH[:, 0]
        b = max(bound, 1e-4)  # the solver needs lower < upper
        self.lo = np.concatenate([LO + list(P0[c, 6:] - b) for c in range(self.NC)])
        self.hi = np.concatenate([HI + list(P0[c, 6:] + b) for c in range(self.NC)])

    def cams_of(self, x, twins):
        P = x[:self.NC * NP].reshape(self.NC, NP).copy()
        if twins:
            for r, l in self.twins:
                P[r, 3:6] = P[l, 3:6]
        return P

    def solve(self, P, idx, twins=True, trims=(None, 20, 10, 6), nfev=60):
        """Adjust cameras P to the observations idx; returns (P, kept idx, errors of kept)."""
        n = len(idx)
        cA, cB, PA, PB, DR, TT = (a[idx] for a in (self.cA, self.cB, self.PA, self.PB, self.DR, self.TT))
        W0 = self.W0[idx]
        WT = W0.copy()
        WH, NC = self.WH, self.NC

        def resid(x):
            Q = self.cams_of(x, twins)
            rho = x[NC * NP:]  # inverse depth of each point along camera A's ray
            R = rotations(Q[:, 0], Q[:, 1], Q[:, 2])
            o = Q[:, 6:9]
            dA = np.einsum("nij,nj->ni", R[cA], unproject(PA, WH[cA, 0], WH[cA, 1], Q[cA, 3], Q[cA, 4], Q[cA, 5]))
            X = o[cA] + dA / np.maximum(rho, 1e-4)[:, None]        # the point, in the car frame at instant 1
            cBw = TT + np.einsum("nij,nj->ni", DR, o[cB])           # camera B's centre at instant 2
            vB = np.einsum("nji,nj->ni", DR @ R[cB], X - cBw)       # the point seen from camera B
            pb = project(vB, WH[cB, 0], WH[cB, 1], Q[cB, 3], Q[cB, 4], Q[cB, 5])
            e = (pb - PB) * (self.SCALE[cB] * WT)[:, None]
            e[vB[:, 2] < -0.99 * np.linalg.norm(vB, axis=1)] = 50   # behind the camera
            prior = ((o - self.P0[:, 6:9]) / 0.15 * 6).ravel()      # gentle pull toward the measured positions
            return np.concatenate([e.ravel(), prior])

        S = lil_matrix((2 * n + 3 * NC, NC * NP + n), dtype=int)
        tw = dict(self.twins) if twins else {}
        for i in range(n):
            for c in {cA[i], cB[i]}:
                S[2 * i:2 * i + 2, c * NP:(c + 1) * NP] = 1
                if c in tw:
                    S[2 * i:2 * i + 2, tw[c] * NP + 3:tw[c] * NP + 6] = 1
            S[2 * i:2 * i + 2, NC * NP + i] = 1
        for c in range(NC):
            S[2 * n + 3 * c:2 * n + 3 * c + 3, c * NP + 6:c * NP + 9] = 1
        lo = np.concatenate([self.lo, np.zeros(n)])
        hi = np.concatenate([self.hi, np.full(n, 2.0)])
        x = np.concatenate([np.clip(P.ravel(), self.lo + 1e-9, self.hi - 1e-9), np.full(n, 0.05)])  # points start ~20 m away
        keep = np.ones(n, bool)
        for thr in trims:
            if thr is not None:  # drop bad matches; trimming only ever removes observations
                e = resid(x)[:2 * n].reshape(n, 2) / np.maximum(WT, 1e-9)[:, None]
                keep &= np.linalg.norm(e, axis=1) < thr
                WT[:] = np.where(keep, W0, 0.0)
            x = least_squares(resid, x, jac_sparsity=S, bounds=(lo, hi), loss="soft_l1", f_scale=2.0,
                              x_scale="jac", tr_solver="lsmr", max_nfev=nfev).x
        d = np.linalg.norm(resid(x)[:2 * n].reshape(n, 2), axis=1) / np.maximum(W0, 1e-9)
        return self.cams_of(x, twins), idx[keep], d[keep]


def init(bundle):
    global B
    B = bundle


def search_one(job):
    """Fit one camera alone from one starting angle; returns (camera, median error, its parameters)."""
    c, idx, P = job
    P, _, d = B.solve(P, idx, twins=False, trims=(None, 20), nfev=40)
    return c, float(np.median(d)) if len(d) > 20 else np.inf, P[c]


def main():
    global B
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--work", default=os.path.join(HERE, "work"))
    ap.add_argument("--vehicle", default="model_3_highland_hw4", help="a file in vehicles/ (name or path)")
    ap.add_argument("--bound", type=float, default=0.0, help="metres each camera may move from the vehicle file's positions")
    ap.add_argument("--out", default=os.path.join(PROJECT, "calibration.json"))
    ap.add_argument("--procs", type=int, default=max(1, (os.cpu_count() or 2) - 2))
    args = ap.parse_args()
    rng = np.random.default_rng(0)
    vehicle = load_vehicle(args.vehicle)
    with open(os.path.join(args.work, "moments.json")) as fh:
        moments = {m["id"]: m for m in json.load(fh)["moments"]}
    with open(os.path.join(args.work, "matches.pkl"), "rb") as fh:
        matches = pickle.load(fh)
    cams = matches["cameras"]
    CI = {c: i for i, c in enumerate(cams)}
    missing = [c for c in cams if c not in vehicle["cameras"]]
    if missing:
        raise SystemExit(f"the footage has cameras the vehicle file doesn't: {', '.join(missing)}")
    print(f"vehicle: {vehicle['name']}; cameras: {', '.join(cams)}")

    # ---- observations: camera A sees pixel pa at instant 1, camera B sees pb at instant 2
    obs = []  # (camA, camB, pa, pb, car rotation 2->1, car translation 2->1, weight)
    for cam, items in matches["temporal"].items():
        for mid, a, b in items:
            m = moments[mid]
            dh = np.radians(m["dh"])
            T = m["dist"] * np.array([np.sin(dh / 2), 0, np.cos(dh / 2)])  # chord of the turn
            for i in rng.choice(len(a), min(TEMPORAL_PER_MOMENT, len(a)), replace=False):
                obs.append((CI[cam], CI[cam], a[i], b[i], ry(m["dh"]), T, 1.0))
    for (ca, cb), items in matches["cross"].items():
        pts = [(x, y) for _, a, b in items for x, y in zip(a, b)]
        for i in rng.choice(len(pts), min(CROSS_PER_PAIR, len(pts)), replace=False):
            obs.append((CI[ca], CI[cb], pts[i][0], pts[i][1], np.eye(3), np.zeros(3), CROSS_WEIGHT))
    same = np.array([o[0] == o[1] for o in obs])
    print(f"{len(obs)} observations ({same.sum()} within cameras, {(~same).sum()} across cameras)")
    for c in cams:
        if not any(o[0] == CI[c] for o in obs):
            raise SystemExit(f"no matches for the {c} camera; extract more daytime moments")

    def start(c):
        cam = vehicle["cameras"][c]
        yaw, pitch = cam.get("aim", [0, 0])
        return [yaw, pitch, 0] + list(cam.get("lens", LENS_START[c])) + list(cam["pos"])
    P0 = np.array([start(c) for c in cams], float)
    B = Bundle(cams, matches["sizes"], obs, P0, args.bound)

    # ---- 1. each camera alone, from a spread of starting angles around its aim
    t = time.time()
    jobs = []
    for c in range(len(cams)):
        own = np.flatnonzero((B.cA == c) & (B.cB == c))
        idx = np.sort(rng.permutation(own)[:SEARCH_PER_MOMENT * len(matches["temporal"][cams[c]])])
        for dy, dp in itertools.product(SEARCH_YAW, SEARCH_PITCH):
            P = P0.copy()
            P[c, 0] += dy
            P[c, 1] = np.clip(P[c, 1] + dp, LO[1] + 1, HI[1] - 1)
            jobs.append((c, idx, P))
    with Pool(args.procs, initializer=init, initargs=(B,)) as pool:
        res = pool.map(search_one, jobs)
    P = P0.copy()
    for c in range(len(cams)):
        err, best = min(((e, p) for cc, e, p in res if cc == c), key=lambda r: r[0])
        P[c] = best
        print(f"  {cams[c]:>14}: best fit alone yaw {best[0]:7.1f} pitch {best[1]:5.1f} ({err:.2f}px)")
    print(f"per-camera search: {time.time() - t:.0f}s", flush=True)

    # ---- 2. all cameras together
    t = time.time()
    P, kept, d = B.solve(P, np.arange(len(obs)))
    within = B.cA[kept] == B.cB[kept]
    print(f"joint solve: {time.time() - t:.0f}s, median error {np.median(d[within]):.2f}px within cameras, "
          f"{np.median(d[~within]):.2f}px across cameras ({len(kept)} matches kept)")

    out = {}
    for c, p in zip(cams, P):
        print(f"{c:>14}: yaw {p[0]:7.1f}  pitch {p[1]:5.1f}  roll {p[2]:5.1f}  hFOV {hfov(*p[3:6]):4.0f}°"
              f"  pos {p[6]:+.3f} {p[7]:+.3f} {p[8]:+.3f} m")
        out[c] = {"yaw": round(p[0], 2), "pitch": round(p[1], 2), "roll": round(p[2], 2), "f": round(p[3], 5),
                  "k1": round(p[4], 5), "k2": round(p[5], 5), "pos": [round(v, 4) for v in p[6:9]]}
        if "mask" in vehicle["cameras"][c]:  # e.g. {"circle": 0.49, "maxAngle": 72}, or null for none
            out[c]["mask"] = vehicle["cameras"][c]["mask"]
    for a, b in matches["cross"]:
        m = (B.cA[kept] == CI[a]) & (B.cB[kept] == CI[b])
        print(f"  {a:>14} ~ {b:<14} {m.sum():4d} matches, median {np.median(d[m]) if m.any() else float('nan'):.2f}px")
    out["vehicle"] = vehicle["name"]
    if "eye" in vehicle:
        out["eye"] = vehicle["eye"]
    with open(args.out, "w") as fh:
        json.dump(out, fh, indent=1)
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
