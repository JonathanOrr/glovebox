"""Extract Tesla dashcam telemetry (SEI metadata) from a TeslaCam MP4.

Newer Tesla firmware embeds a protobuf `SeiMetadata` message in an H.264
SEI (user_data_unregistered) NAL unit ahead of each video frame. Rather than
reading the whole ~80 MB file, we parse the MP4 sample tables and read only
the first few hundred bytes of each sample, where the SEI lives.
"""
import struct

# SeiMetadata field number -> (name, kind)
FIELDS = {
    1: ("version", "varint"),
    2: ("gear", "varint"),
    3: ("frame_seq", "varint"),
    4: ("speed_mps", "float"),
    5: ("accel_pedal", "float"),
    6: ("steering_angle", "float"),
    7: ("blinker_left", "bool"),
    8: ("blinker_right", "bool"),
    9: ("brake", "bool"),
    10: ("autopilot", "varint"),
    11: ("lat", "double"),
    12: ("lon", "double"),
    13: ("heading", "double"),
    14: ("accel_x", "double"),
    15: ("accel_y", "double"),
    16: ("accel_z", "double"),
}

SAMPLE_PEEK = 512


def _boxes(buf, start, end):
    p = start
    while p + 8 <= end:
        size, typ = struct.unpack(">I4s", buf[p:p + 8])
        hdr = 8
        if size == 1:
            size = struct.unpack(">Q", buf[p + 8:p + 16])[0]
            hdr = 16
        elif size == 0:
            size = end - p
        yield typ, p + hdr, p + size
        p += size


def _find(buf, start, end, path):
    for typ, s, e in _boxes(buf, start, end):
        if typ == path[0]:
            return (s, e) if len(path) == 1 else _find(buf, s, e, path[1:])
    return None


def _read_moov(f):
    f.seek(0, 2)
    file_end = f.tell()
    p = 0
    while p < file_end:
        f.seek(p)
        hdr = f.read(16)
        size, typ = struct.unpack(">I4s", hdr[:8])
        if size == 1:
            size = struct.unpack(">Q", hdr[8:16])[0]
        elif size == 0:
            size = file_end - p
        if typ == b"moov":
            f.seek(p)
            return f.read(size)
        p += size
    raise ValueError("no moov box")


def _sample_table(moov):
    stbl = _find(moov, 8, len(moov), [b"trak", b"mdia", b"minf", b"stbl"])
    mdhd = _find(moov, 8, len(moov), [b"trak", b"mdia", b"mdhd"])
    if stbl is None or mdhd is None:
        raise ValueError("no video track sample table")
    s, _ = mdhd
    if moov[s] == 1:
        timescale = struct.unpack(">I", moov[s + 20:s + 24])[0]
    else:
        timescale = struct.unpack(">I", moov[s + 12:s + 16])[0]

    tables = {typ: (bs, be) for typ, bs, be in _boxes(moov, *stbl)}

    s, _ = tables[b"stsz"]
    fixed, count = struct.unpack(">II", moov[s + 4:s + 12])
    sizes = [fixed] * count if fixed else list(struct.unpack(f">{count}I", moov[s + 12:s + 12 + 4 * count]))

    if b"stco" in tables:
        s, _ = tables[b"stco"]
        n = struct.unpack(">I", moov[s + 4:s + 8])[0]
        chunks = struct.unpack(f">{n}I", moov[s + 8:s + 8 + 4 * n])
    else:
        s, _ = tables[b"co64"]
        n = struct.unpack(">I", moov[s + 4:s + 8])[0]
        chunks = struct.unpack(f">{n}Q", moov[s + 8:s + 8 + 8 * n])

    s, _ = tables[b"stsc"]
    n = struct.unpack(">I", moov[s + 4:s + 8])[0]
    stsc = [struct.unpack(">III", moov[s + 8 + 12 * i:s + 20 + 12 * i]) for i in range(n)]

    s, _ = tables[b"stts"]
    n = struct.unpack(">I", moov[s + 4:s + 8])[0]
    times, t = [], 0
    for i in range(n):
        cnt, delta = struct.unpack(">II", moov[s + 8 + 8 * i:s + 16 + 8 * i])
        for _ in range(cnt):
            times.append(t / timescale)
            t += delta

    offsets = []
    sample = 0
    for ci, chunk_off in enumerate(chunks):
        chunk_no = ci + 1
        per_chunk = next(spc for first, spc, _ in reversed(stsc) if first <= chunk_no)
        off = chunk_off
        for _ in range(per_chunk):
            if sample >= count:
                break
            offsets.append(off)
            off += sizes[sample]
            sample += 1
    return offsets, sizes, times, t / timescale


def _unescape(b):
    # Remove H.264 emulation-prevention bytes (00 00 03 -> 00 00).
    return b.replace(b"\x00\x00\x03", b"\x00\x00")


def _varint(b, i):
    v = shift = 0
    while True:
        c = b[i]
        i += 1
        v |= (c & 0x7F) << shift
        if not c & 0x80:
            return v, i
        shift += 7


def _decode(pb):
    out = {}
    i = 0
    while i < len(pb):
        key, i = _varint(pb, i)
        field, wt = key >> 3, key & 7
        if wt == 0:
            v, i = _varint(pb, i)
        elif wt == 1:
            v = struct.unpack("<d", pb[i:i + 8])[0]
            i += 8
        elif wt == 5:
            v = struct.unpack("<f", pb[i:i + 4])[0]
            i += 4
        elif wt == 2:
            ln, i = _varint(pb, i)
            i += ln
            continue
        else:
            break
        if field in FIELDS:
            name, kind = FIELDS[field]
            out[name] = bool(v) if kind == "bool" else v
    return out


def _sei_from_sample(data):
    """Return the decoded SeiMetadata from a length-prefixed sample, or None."""
    p = 0
    while p + 5 <= len(data):
        n = struct.unpack(">I", data[p:p + 4])[0]
        nal_type = data[p + 4] & 0x1F
        if nal_type in (1, 5):
            return None  # reached the picture itself
        if nal_type == 6:
            rbsp = _unescape(data[p + 5:p + 4 + n])
            # payload type 5 (user_data_unregistered), then size
            j = 0
            ptype = 0
            while rbsp[j] == 0xFF:
                ptype += 255
                j += 1
            ptype += rbsp[j]
            j += 1
            while rbsp[j] == 0xFF:
                j += 1
            j += 1
            if ptype == 5:
                # Tesla marker: a run of 0x42 followed by 0x69.
                while j < len(rbsp) and rbsp[j] == 0x42:
                    j += 1
                if j < len(rbsp) and rbsp[j] == 0x69:
                    pb = rbsp[j + 1:].rstrip(b"\x00")
                    if pb.endswith(b"\x80"):
                        pb = pb[:-1]
                    try:
                        return _decode(pb)
                    except (IndexError, struct.error):
                        return None
        p += 4 + n
    return None


def extract(path, step=1):
    """Return {"times": [...], "frames": [dict|None, ...], "duration": secs} for a clip.

    `step` reads only every Nth frame (e.g. 36 for ~1 sample per second).
    """
    with open(path, "rb") as f:
        offsets, sizes, times, duration = _sample_table(_read_moov(f))
        frames = []
        for off, size in zip(offsets[::step], sizes[::step]):
            f.seek(off)
            frames.append(_sei_from_sample(f.read(min(size, SAMPLE_PEEK))))
    return {"times": times[::step][:len(frames)], "frames": frames, "duration": duration}


if __name__ == "__main__":
    import json
    import sys

    r = extract(sys.argv[1])
    got = [x for x in r["frames"] if x]
    print(f"{len(r['frames'])} frames, {len(got)} with telemetry")
    for t, x in list(zip(r["times"], r["frames"]))[::max(1, len(got) // 8)]:
        print(f"{t:6.2f}s", json.dumps(x))
