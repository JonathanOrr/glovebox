// The scrubbable timeline under the player: speed/pedal graph, brake and bump
// marks, the save point, and the playhead.
import { $ } from "./util.js";
import { state, toUnit } from "./state.js";
import { BUMP_MPS2, BUMP_MAX } from "./hud.js";

const totalDuration = cur => cur.segs.at(-1).start + cur.segs.at(-1).dur;

// seek(t) is called with seconds from the start of the event.
export function setupTimeline(cur, seek) {
  const c = $("#timeline");
  let dragging = false;
  const toT = e => {
    const r = c.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * totalDuration(cur);
  };
  c.onpointerdown = e => { dragging = true; c.setPointerCapture(e.pointerId); seek(toT(e)); };
  c.onpointermove = e => { if (dragging) seek(toT(e)); };
  c.onpointerup = () => { dragging = false; };
  new ResizeObserver(() => { cur.timelineDirty = true; }).observe(c);
  cur.timelineDirty = true;
}

// g: current playhead position in seconds from the start of the event.
export function drawTimeline(cur, g) {
  const c = $("#timeline");
  const dpr = window.devicePixelRatio || 1;
  const W = c.clientWidth, H = c.clientHeight;
  if (c.width !== W * dpr || c.height !== H * dpr) { c.width = W * dpr; c.height = H * dpr; cur.timelineDirty = true; }
  const total = totalDuration(cur);
  const X = t => t / total * W;
  if (cur.timelineDirty) {
    // cache the static background (speed graph etc.) in an offscreen canvas
    const bg = cur.tlBg || (cur.tlBg = document.createElement("canvas"));
    bg.width = c.width; bg.height = c.height;
    const b = bg.getContext("2d"); b.scale(dpr, dpr);
    b.fillStyle = "#1d2024"; b.fillRect(0, 0, W, H);
    let maxV = 1;
    cur.segs.forEach(s => s.tel && s.tel.d.forEach(r => { maxV = Math.max(maxV, Math.abs(r[s.tel.k.speed_mps])); }));
    const top = 6, bot = H - 4, Y = v => bot - v / maxV * (bot - top);
    cur.segs.forEach((s, i) => {
      if (i) { b.fillStyle = "#2c3036"; b.fillRect(X(s.start), 0, 1, H); }
      if (s.tel && !s.tel.t.length) {
        // Video but no car data (typically parked); say so rather than leave a hole.
        b.fillStyle = "rgba(255,255,255,.03)"; b.fillRect(X(s.start) + 1, 0, X(s.dur) - 1, H);
        if (X(s.dur) > 60) { b.fillStyle = "#555b63"; b.font = "10px system-ui"; b.textAlign = "center";
          b.fillText("no car data", X(s.start + s.dur / 2), H / 2 + 3); b.textAlign = "start"; }
      }
      if (!s.tel || !s.tel.t.length) return;
      const k = s.tel.k;
      // brake marks
      s.tel.t.forEach((t, j) => {
        const r = s.tel.d[j];
        if (r[k.brake]) { b.fillStyle = "rgba(255,77,79,.35)"; b.fillRect(X(s.start + t), 0, Math.max(1, W / total / 36 + .5), H); }
      });
      // bumps: strongest vertical jolt per pixel column, as ticks up from the bottom
      const cols = new Map();
      s.tel.t.forEach((t, j) => {
        const az = Math.abs(s.tel.d[j][k.accel_z] || 0);
        if (az < BUMP_MPS2) return;
        const px = Math.round(X(s.start + t));
        cols.set(px, Math.max(cols.get(px) || 0, az));
      });
      b.fillStyle = "#c678dd";
      cols.forEach((az, px) => {
        const h = 4 + (Math.min(az, BUMP_MAX) - BUMP_MPS2) / (BUMP_MAX - BUMP_MPS2) * (H * 0.45);
        b.fillRect(px, H - h, 1.5, h);
      });
      b.strokeStyle = "rgba(53,196,106,.55)"; b.lineWidth = 1; b.beginPath();
      s.tel.t.forEach((t, j) => { const y = bot - (s.tel.d[j][k.accel_pedal] || 0) / 100 * (bot - top) * 0.6; j ? b.lineTo(X(s.start + t), y) : b.moveTo(X(s.start + t), y); });
      b.stroke();
      b.strokeStyle = "#3e8bff"; b.lineWidth = 1.6; b.beginPath();
      s.tel.t.forEach((t, j) => { const y = Y(Math.abs(s.tel.d[j][k.speed_mps])); j ? b.lineTo(X(s.start + t), y) : b.moveTo(X(s.start + t), y); });
      b.stroke();
    });
    b.fillStyle = "#8b929a"; b.font = "10px system-ui";
    if (maxV > 1) b.fillText(`max ${Math.round(toUnit(maxV))} ${state.units}`, 4, 11);
    b.fillStyle = "rgba(29,32,36,.85)"; b.fillRect(W - 152, 0, 152, 15);
    b.fillStyle = "#3e8bff"; b.fillText("speed", W - 148, 11);
    b.fillStyle = "#35c46a"; b.fillText("accel", W - 114, 11);
    b.fillStyle = "#ff6b6d"; b.fillText("brake", W - 80, 11);
    b.fillStyle = "#c678dd"; b.fillText("bumps", W - 46, 11);
    if (cur.trigger) { b.fillStyle = "#ffb020"; b.fillRect(X(cur.trigger) - 1, 0, 2, H); }
    cur.timelineDirty = false;
  }
  const ctx = c.getContext("2d");
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(cur.tlBg, 0, 0);
  ctx.scale(dpr, dpr);
  ctx.fillStyle = "#fff"; ctx.fillRect(X(g) - 1, 0, 2, H);
}
