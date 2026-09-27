#!/usr/bin/env python3
"""Local TeslaCam viewer: synced 6-camera playback, telemetry, delete, and camera calibration.

Usage: python3 server.py [/path/to/TeslaCam] [--port 8765]
"""
import argparse
import importlib.util
import json
import mimetypes
import os
import re
import shutil
import string
import subprocess
import sys
import threading
import webbrowser
from datetime import datetime
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

import telemetry

HERE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(HERE, "static")
mimetypes.add_type("text/javascript", ".js")  # ES modules require a JS MIME type
SOURCES = ("SavedClips", "SentryClips")
CAMERAS = ("front", "back", "left_pillar", "right_pillar", "left_repeater", "right_repeater")
CLIP_RE = re.compile(r"^(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})-(\w+)\.mp4$")
NAME_RE = re.compile(r"^[\w.-]+$")
RANGE_CHUNK = 4 << 20

CALIB_TOOLS = os.path.join(HERE, "tools", "calibration")
CALIB_FILE = os.path.join(HERE, "calibration.json")
CALIB_PREVIOUS = os.path.join(HERE, "calibration.previous.json")

ROOT = ""  # a TeslaCam folder given on the command line; otherwise found on a drive
_telemetry_cache = {}
_track_cache = {}
_duration_cache = {}
_cache_lock = threading.Lock()


def find_teslacam():
    """The TeslaCam folder on a plugged-in USB drive (Linux, macOS or Windows), or a copy in the home folder."""
    user = os.environ.get("USER", "")
    places = []
    for base in (f"/run/media/{user}", f"/media/{user}", "/media", "/mnt", "/Volumes"):
        if os.path.isdir(base):
            places += [os.path.join(base, d) for d in sorted(os.listdir(base))]
    if os.name == "nt":
        places += [f"{d}:\\" for d in string.ascii_uppercase[2:]]
    home = os.path.expanduser("~")
    places += [home, os.path.join(home, "Desktop"), os.path.join(home, "Downloads")]
    for p in places:
        cand = os.path.join(p, "TeslaCam")
        if os.path.isdir(cand):
            return cand
    return None


def teslacam():
    """The folder to show: the one given on the command line, else whichever drive is plugged in now."""
    return ROOT or find_teslacam()


def event_dir(source, event):
    if source not in SOURCES or not NAME_RE.match(event) or event.startswith("."):
        return None
    root = teslacam()
    if not root:
        return None
    path = os.path.join(root, source, event)
    return path if os.path.isdir(path) else None


def clip_duration(path):
    key = (path, os.path.getmtime(path))
    with _cache_lock:
        if key in _duration_cache:
            return _duration_cache[key]
    try:
        with open(path, "rb") as f:
            dur = telemetry._sample_table(telemetry._read_moov(f))[3]
    except Exception:
        dur = 60.0  # unreadable/truncated clip: assume a normal one-minute file
    with _cache_lock:
        _duration_cache[key] = dur
    return dur


def event_segments(d):
    """Lay out an event's one-minute clips on a single timeline.

    Returns (t0, segments): t0 is the datetime the first clip starts, and each
    segment is {"ts", "cameras", "start", "dur"} with start in seconds from t0.

    Filenames give each clip's start time, but occasionally a clip is named
    late (seen after the car wakes from being parked: a 60 s clip named only
    18 s before the next one). When a clip would run past the next clip's
    start, it's slid earlier to end there, never before the previous clip ends.
    File modification times confirm this placement on every case seen so far.
    """
    clips = {}
    for fn in os.listdir(d):
        m = CLIP_RE.match(fn)
        if m and m.group(2) in CAMERAS and os.path.getsize(os.path.join(d, fn)) > 0:
            clips.setdefault(m.group(1), []).append(m.group(2))
    segs = []
    for ts in sorted(clips):
        cams = sorted(clips[ts])
        cam = "front" if "front" in cams else cams[0]
        start = datetime.strptime(ts, "%Y-%m-%d_%H-%M-%S").timestamp()
        segs.append({"ts": ts, "cameras": cams, "start": start, "dur": clip_duration(os.path.join(d, f"{ts}-{cam}.mp4"))})
    for i, s in enumerate(segs):
        if i + 1 < len(segs) and s["start"] + s["dur"] > segs[i + 1]["start"] + 1:
            earliest = segs[i - 1]["start"] + segs[i - 1]["dur"] if i else float("-inf")
            s["start"] = max(segs[i + 1]["start"] - s["dur"], earliest)
    if not segs:
        return None, []
    t0 = segs[0]["start"]
    for s in segs:
        s["start"] = round(s["start"] - t0, 3)
        s["dur"] = round(s["dur"], 3)
    return datetime.fromtimestamp(t0), segs


def list_events(root):
    events = []
    for source in SOURCES:
        src = os.path.join(root, source)
        if not os.path.isdir(src):
            continue
        for name in sorted(os.listdir(src), reverse=True):
            path = os.path.join(src, name)
            if not os.path.isdir(path):
                continue
            size = sum(os.path.getsize(os.path.join(path, fn)) for fn in os.listdir(path))
            t0, segments = event_segments(path)
            info = {}
            try:
                with open(os.path.join(path, "event.json")) as f:
                    info = json.load(f)
            except (OSError, ValueError):
                pass
            events.append({
                "source": source,
                "name": name,
                "info": info,
                "size": size,
                "thumb": os.path.exists(os.path.join(path, "thumb.png")),
                "t0": t0.isoformat(timespec="milliseconds") if t0 else None,  # local time
                "segments": segments,
            })
    return events


def clip_telemetry(path):
    key = (path, os.path.getmtime(path))
    with _cache_lock:
        if key in _telemetry_cache:
            return _telemetry_cache[key]
    try:
        raw = telemetry.extract(path)
    except Exception as e:  # corrupt/truncated clip
        return {"error": str(e), "t": [], "d": []}
    # Compact to parallel arrays; keep every frame that has data.
    keys = ("speed_mps", "accel_pedal", "steering_angle", "brake", "blinker_left", "blinker_right",
            "gear", "autopilot", "lat", "lon", "heading", "accel_x", "accel_y", "accel_z")
    t, d = [], []
    for ts, fr in zip(raw["times"], raw["frames"]):
        if fr is None:
            continue
        t.append(round(ts, 3))
        d.append([fr.get(k, 0) for k in keys])
    result = {"keys": keys, "t": t, "d": d}
    with _cache_lock:
        _telemetry_cache[key] = result
    return result


TRACK_STEP = 36  # ~1 GPS point per second at 36 fps


def event_track(d):
    """GPS trail for an event: [[lat, lon, t, speed_mps], ...], t in seconds on the event timeline."""
    points = []
    for s in event_segments(d)[1]:
        cam = "front" if "front" in s["cameras"] else s["cameras"][0]
        path = os.path.join(d, f"{s['ts']}-{cam}.mp4")
        offset = s["start"]
        key = (path, os.path.getmtime(path))
        with _cache_lock:
            seg = _track_cache.get(key)
        if seg is None:
            try:
                raw = telemetry.extract(path, TRACK_STEP)
                seg = [(fr["lat"], fr["lon"], t, abs(fr.get("speed_mps", 0))) for t, fr in zip(raw["times"], raw["frames"])
                       if fr and fr.get("lat") and fr.get("lon")]
            except Exception:
                seg = []
            with _cache_lock:
                _track_cache[key] = seg
        points += [[round(la, 6), round(lo, 6), round(offset + t, 2), round(v, 1)] for la, lo, t, v in seg]
    return points


def vehicles():
    out = []
    for fn in sorted(os.listdir(os.path.join(CALIB_TOOLS, "vehicles"))):
        if fn.endswith(".json"):
            with open(os.path.join(CALIB_TOOLS, "vehicles", fn)) as f:
                out.append({"id": fn[:-5], "name": json.load(f)["name"]})
    return out


class Calibration:
    """Runs tools/calibration's three steps in the background, one run at a time."""
    STEPS = [("extract.py", "Picking moments from your drives"), ("match.py", "Finding the same scenery in each camera"),
             ("solve.py", "Working out where each camera points")]

    def __init__(self):
        self.lock = threading.Lock()
        self.status = {"running": False}

    def start(self, root, vehicle):
        missing = [m for m in ("numpy", "scipy", "cv2") if importlib.util.find_spec(m) is None]
        if missing:
            return "Calibration needs a few extra parts. Close this window and start the viewer with the Start file."
        if not root:
            return "Plug in the USB drive from your car first."
        if vehicle not in {v["id"] for v in vehicles()}:
            return "Unknown car."
        with self.lock:
            if self.status["running"]:
                return "Already calibrating."
            self.status = {"running": True, "step": 0, "steps": len(self.STEPS), "message": self.STEPS[0][1]}
        threading.Thread(target=self.run, args=(root, vehicle), daemon=True).start()
        return None

    def run(self, root, vehicle):
        work = os.path.join(CALIB_TOOLS, "work")
        out = os.path.join(work, "calibration.json")
        args = {"extract.py": [root], "match.py": [], "solve.py": ["--vehicle", vehicle, "--out", out]}
        for i, (script, message) in enumerate(self.STEPS):
            with self.lock:
                self.status.update(step=i, message=message)
            p = subprocess.run([sys.executable, os.path.join(CALIB_TOOLS, script), "--work", work, *args[script]],
                               cwd=CALIB_TOOLS, capture_output=True, text=True)
            if p.returncode:
                lines = (p.stderr or p.stdout).strip().splitlines()
                with self.lock:
                    self.status = {"running": False, "error": friendly_error(lines[-1] if lines else "")}
                return
        shutil.rmtree(os.path.join(work, "frames"), ignore_errors=True)  # a few hundred MB, no longer needed
        if os.path.exists(CALIB_FILE):
            os.replace(CALIB_FILE, CALIB_PREVIOUS)
        os.replace(out, CALIB_FILE)
        with self.lock:
            self.status = {"running": False, "done": True}


def friendly_error(line):
    if "no daytime clips" in line or "no driving found" in line or "no matches for" in line:
        return ("Not enough daytime driving on the USB drive. Save a few drives in daylight "
                "(tap the dashcam icon while driving), then try again.")
    return f"Calibration stopped: {line or 'unknown error'}"


CALIBRATION = Calibration()


def calibration_info():
    info = {"previous": os.path.isfile(CALIB_PREVIOUS)}
    if os.path.isfile(CALIB_FILE):
        info["id"] = str(os.path.getmtime(CALIB_FILE))
        info["date"] = datetime.fromtimestamp(os.path.getmtime(CALIB_FILE)).isoformat(timespec="seconds")
        with open(CALIB_FILE) as f:
            info["cameras"] = json.load(f)
        name = info["cameras"].get("vehicle")
        info["vehicleId"] = next((v["id"] for v in vehicles() if v["name"] == name), None)
    return info


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, format, *args):
        if os.environ.get("TC_DEBUG"):
            super().log_message(format, *args)

    def send_json(self, obj, status=200):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        url = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(url.query).items()}
        if url.path == "/":
            return self.send_file(os.path.join(STATIC, "index.html"))
        if url.path == "/api/events":
            root = teslacam()
            if not root or not os.path.isdir(root):
                return self.send_json({"waiting": True, "error": f"Can't find {ROOT}" if ROOT else
                                       "Plug in the USB drive from your car. Its TeslaCam folder will show up here."})
            return self.send_json({"root": root, "events": list_events(root)})
        if url.path == "/api/track":
            d = event_dir(q.get("source", ""), q.get("event", ""))
            if not d:
                return self.send_json({"error": "event not found"}, 404)
            return self.send_json({"points": event_track(d)})
        if url.path == "/api/telemetry":
            d = event_dir(q.get("source", ""), q.get("event", ""))
            ts, cam = q.get("ts", ""), q.get("cam", "front")
            if not d or not re.match(r"^[\d_-]+$", ts) or cam not in CAMERAS:
                return self.send_json({"error": "bad request"}, 400)
            path = os.path.join(d, f"{ts}-{cam}.mp4")
            if not os.path.exists(path):
                return self.send_json({"error": "not found"}, 404)
            return self.send_json(clip_telemetry(path))
        if url.path == "/api/calibration":
            # calibration.json is written by tools/calibration/solve.py; without it the 360° view uses built-in values.
            try:
                return self.send_json(calibration_info())
            except (OSError, ValueError) as e:
                return self.send_json({"error": f"calibration.json: {e}"}, 500)
        if url.path == "/api/calibrate":
            with CALIBRATION.lock:
                return self.send_json({**CALIBRATION.status, "vehicles": vehicles()})
        m = re.match(r"^/file/(\w+)/([^/]+)/([^/]+)$", url.path)
        if m:
            d = event_dir(m.group(1), unquote(m.group(2)))
            fn = unquote(m.group(3))
            if d and NAME_RE.match(fn) and (CLIP_RE.match(fn) or fn == "thumb.png"):
                return self.send_file(os.path.join(d, fn))
        # Page assets (styles.css, js/*.js); realpath check keeps requests inside static/.
        path = os.path.realpath(os.path.join(STATIC, unquote(url.path).lstrip("/")))
        if path.startswith(STATIC + os.sep) and os.path.isfile(path):
            return self.send_file(path)
        self.send_error(404)

    def do_POST(self):
        url = urlparse(self.path)
        length = int(self.headers.get("Content-Length", 0))
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            return self.send_json({"error": "bad json"}, 400)
        if url.path == "/api/delete":
            d = event_dir(body.get("source", ""), body.get("event", ""))
            if not d:
                return self.send_json({"error": "event not found"}, 404)
            shutil.rmtree(d)
            return self.send_json({"ok": True})
        if url.path == "/api/calibrate":
            err = CALIBRATION.start(teslacam(), body.get("vehicle", ""))
            return self.send_json({"error": err} if err else {"ok": True}, 409 if err else 200)
        if url.path == "/api/calibration/reset":
            # Back to the built-in values; the current calibration is kept as the one to undo to.
            if os.path.exists(CALIB_FILE):
                os.replace(CALIB_FILE, CALIB_PREVIOUS)
            return self.send_json({"ok": True})
        if url.path == "/api/calibration/undo":
            # Swap back to the calibration in use before the last change.
            if os.path.exists(CALIB_PREVIOUS):
                tmp = CALIB_FILE + ".swap"
                if os.path.exists(CALIB_FILE):
                    os.replace(CALIB_FILE, tmp)
                os.replace(CALIB_PREVIOUS, CALIB_FILE)
                if os.path.exists(tmp):
                    os.replace(tmp, CALIB_PREVIOUS)
            return self.send_json({"ok": True})
        return self.send_error(404)

    def send_file(self, path):
        if not os.path.isfile(path):
            return self.send_error(404)
        size = os.path.getsize(path)
        ctype = mimetypes.guess_type(path)[0] or "application/octet-stream"
        start, end = 0, size - 1
        rng = self.headers.get("Range")
        if rng:
            m = re.match(r"bytes=(\d*)-(\d*)", rng)
            if m:
                if m.group(1):
                    start = int(m.group(1))
                    if m.group(2):
                        end = min(int(m.group(2)), size - 1)
                    else:
                        # Browsers only allow 6 connections per host; with 6 videos
                        # streaming whole files nothing else (telemetry, thumbnails)
                        # could load. Serve open-ended ranges in chunks instead.
                        end = min(size - 1, start + RANGE_CHUNK - 1)
                elif m.group(2):
                    start = max(0, size - int(m.group(2)))
            if start > end:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.end_headers()
                return
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        else:
            self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        try:
            with open(path, "rb") as f:
                f.seek(start)
                remaining = end - start + 1
                while remaining > 0:
                    chunk = f.read(min(1 << 20, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass


class Server(ThreadingHTTPServer):
    def handle_error(self, request, client_address):
        # The browser routinely drops requests (switching events, seeking video);
        # that's not worth a traceback.
        if isinstance(sys.exc_info()[1], ConnectionError):
            return
        super().handle_error(request, client_address)


def main():
    global ROOT
    ap = argparse.ArgumentParser()
    ap.add_argument("root", nargs="?", help="path to the TeslaCam folder (found on a plugged-in drive if omitted)")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()
    if args.root:
        ROOT = os.path.abspath(args.root)
        if os.path.isdir(os.path.join(ROOT, "TeslaCam")):  # the drive itself was given
            ROOT = os.path.join(ROOT, "TeslaCam")
    try:
        server = Server(("127.0.0.1", args.port), Handler)
    except OSError:  # already running (e.g. started twice): just show it
        server = None
    url = f"http://127.0.0.1:{args.port}/"
    if not args.no_browser:
        threading.Timer(0.5, webbrowser.open, [url]).start()
    if server is None:
        print(f"The viewer is already running at {url}")
        return
    print(f"TeslaCam viewer: {url}\nKeep this window open while you use it. Close it (or press Ctrl+C) to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
