// The telemetry strip under the cameras: speed, gear, Autopilot, pedals,
// steering wheel, blinkers, G-force, mini-map and GPS position.
import { $ } from "./util.js";
import { state, toUnit, toggleUnits } from "./state.js";

const GEARS = ["P", "D", "R", "N"];
const AP_LABELS = ["", "Self-Driving", "Autosteer", "TACC"];

// Vertical acceleration (gravity removed): parked it's <0.12 m/s², normal driving
// stays under ~1.1; above this counts as a bump.
export const BUMP_MPS2 = 1.2, BUMP_MAX = 3;

// x: telemetry sample for the current frame, or null if there isn't one.
export function renderHud(cur, x) {
  const hud = $("#hud");
  if (!x) {
    const loading = cur.segs[cur.seg] && !cur.segs[cur.seg].tel;
    if (hud.dataset.state !== "none") { hud.innerHTML = `<div class="notel">${loading ? "Reading telemetry…" : "No telemetry in this clip (older firmware)"}</div>`; hud.dataset.state = "none"; }
    return;
  }
  if (hud.dataset.state !== "tel") {
    hud.dataset.state = "tel";
    hud.innerHTML = `
      <div class="speed"><div class="v" id="hSpeed">0</div><div class="u" id="hUnit" title="Click to switch units">${state.units}</div></div>
      <div class="status"><div class="gear" id="hGear">${GEARS.map(g => `<span data-g="${g}">${g}</span>`).join("")}</div><div class="ap" id="hAp">Autopilot off</div></div>
      <div class="pedals">
        <div class="pedal"><div class="bar"><i id="hAcc"></i></div><b id="hAccV">0%</b>Accel</div>
        <div class="pedal brake"><div class="bar"><i id="hBrk"></i></div><b id="hBrkV">—</b>Brake</div>
      </div>
      <div class="wheelbox">
        <span class="blinker" id="hBl">◀</span>
        <div style="text-align:center">
          <svg id="wheel" viewBox="-30 -30 60 60"><g id="wheelG" fill="none" stroke="#c9ced6" stroke-width="4">
            <circle r="25"/><path d="M-25 0 L-8 0 M8 0 L25 0 M0 8 L0 25" stroke-width="5"/><circle r="8" fill="#c9ced6" stroke="none"/>
            <path d="M-4 -25 L4 -25" stroke="${getComputedStyle(document.documentElement).getPropertyValue("--red")}" stroke-width="5"/></g></svg>
          <div class="deg" id="hDeg">0°</div>
        </div>
        <span class="blinker" id="hBr">▶</span>
      </div>
      <div class="gbox">
        <canvas id="gforce" width="84" height="64" title="G-force: dot = braking / accelerating / cornering; bar = vertical (bumps)"></canvas>
        <canvas id="minimap" width="120" height="64" title="GPS track for this event"></canvas>
        <div class="loc" id="hLoc"></div>
      </div>
      <div></div>`;
    $("#hUnit").onclick = () => { toggleUnits(); $("#hUnit").textContent = state.units; cur.timelineDirty = true; };
  }
  $("#hSpeed").textContent = Math.round(Math.abs(toUnit(x.speed_mps)));
  $("#hGear").querySelectorAll("span").forEach(s => s.classList.toggle("on", s.dataset.g === GEARS[x.gear]));
  const ap = $("#hAp");
  ap.textContent = x.autopilot ? AP_LABELS[x.autopilot] || "Autopilot" : "Autopilot off";
  ap.classList.toggle("on", !!x.autopilot);
  const acc = Math.max(0, Math.min(100, x.accel_pedal || 0));
  $("#hAcc").style.height = acc + "%";
  $("#hAccV").textContent = Math.round(acc) + "%";
  $("#hBrk").style.height = x.brake ? "100%" : "0";
  $("#hBrkV").textContent = x.brake ? "ON" : "—";
  $("#wheelG").setAttribute("transform", `rotate(${x.steering_angle || 0})`);
  $("#hDeg").textContent = Math.round(x.steering_angle || 0) + "°";
  const blinkOn = Math.floor(performance.now() / 350) % 2 === 0;
  $("#hBl").classList.toggle("on", !!x.blinker_left && blinkOn);
  $("#hBr").classList.toggle("on", !!x.blinker_right && blinkOn);
  drawG(x.accel_x || 0, x.accel_y || 0, x.accel_z || 0);
  drawMinimap(cur, x);
  if (x.lat && x.lon) {
    const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
    $("#hLoc").innerHTML = `${x.lat.toFixed(5)}, ${x.lon.toFixed(5)}<br>Heading ${Math.round(x.heading)}° ${dirs[Math.round(x.heading / 45) % 8]}<br>` +
      `<a href="https://www.google.com/maps?q=${x.lat},${x.lon}" target="_blank" rel="noopener">Open in Maps ↗</a>`;
  }
}

function drawG(ax, ay, az) {
  const c = $("#gforce"), g = c.getContext("2d"), r = 28, cx = 32, cy = 32;
  g.clearRect(0, 0, c.width, c.height);
  g.strokeStyle = "#343a42"; g.lineWidth = 1;
  [r, r / 2].forEach(rr => { g.beginPath(); g.arc(cx, cy, rr, 0, 7); g.stroke(); });
  g.beginPath(); g.moveTo(cx - r, cy); g.lineTo(cx + r, cy); g.moveTo(cx, cy - r); g.lineTo(cx, cy + r); g.stroke();
  // accel_x: lateral (+ when turning right), accel_y: longitudinal (- when speeding up).
  // Dot shows the acceleration direction: up = speeding up, right = turning right. Edge = 0.6 g.
  const s = r / (0.6 * 9.81);
  const px = Math.max(-r, Math.min(r, ax * s)), py = Math.max(-r, Math.min(r, ay * s));
  g.fillStyle = "#ffb020"; g.beginPath(); g.arc(cx + px, cy + py, 4, 0, 7); g.fill();
  g.fillStyle = "#8b929a"; g.font = "9px system-ui"; g.fillText((Math.hypot(ax, ay) / 9.81).toFixed(2) + "g", 3, 62);
  // Vertical bar: fills up or down from the centre line; edge = BUMP_MAX.
  const bx = 70, bw = 7, h = Math.max(-r, Math.min(r, -az / BUMP_MAX * r));
  g.fillStyle = "#2a2e33"; g.fillRect(bx, cy - r, bw, 2 * r);
  g.fillStyle = Math.abs(az) >= BUMP_MPS2 ? "#c678dd" : "#6b5a75";
  g.fillRect(bx, Math.min(cy, cy + h), bw, Math.abs(h));
  g.fillStyle = "#8b929a"; g.fillRect(bx - 2, cy, bw + 4, 1);
}

function drawMinimap(cur, x) {
  const c = $("#minimap"), g = c.getContext("2d"), W = c.width, H = c.height;
  if (cur.mapDirty !== false || !cur.track) {
    const pts = [];
    cur.segs.forEach(s => s.tel && s.tel.t.forEach((_, i) => {
      if (i % 18) return;
      const row = s.tel.d[i]; const la = row[s.tel.k.lat], lo = row[s.tel.k.lon];
      if (la && lo) pts.push([la, lo]);
    }));
    cur.track = pts;
    cur.mapDirty = cur.segs.some(s => !s.tel);
  }
  g.clearRect(0, 0, W, H);
  const pts = cur.track;
  if (pts.length < 2) return;
  let [minLa, maxLa, minLo, maxLo] = [90, -90, 180, -180];
  pts.forEach(([la, lo]) => { minLa = Math.min(minLa, la); maxLa = Math.max(maxLa, la); minLo = Math.min(minLo, lo); maxLo = Math.max(maxLo, lo); });
  const k = Math.cos(minLa * Math.PI / 180);
  const spanX = Math.max((maxLo - minLo) * k, 1e-4), spanY = Math.max(maxLa - minLa, 1e-4);
  const sc = Math.min((W - 10) / spanX, (H - 10) / spanY);
  const ox = (W - spanX * sc) / 2, oy = (H - spanY * sc) / 2;
  const P = (la, lo) => [ox + (lo - minLo) * k * sc, H - oy - (la - minLa) * sc];
  g.strokeStyle = "#4a5260"; g.lineWidth = 2; g.beginPath();
  pts.forEach(([la, lo], i) => { const [px, py] = P(la, lo); i ? g.lineTo(px, py) : g.moveTo(px, py); });
  g.stroke();
  if (x.lat) { const [px, py] = P(x.lat, x.lon); g.fillStyle = "#3e8bff"; g.beginPath(); g.arc(px, py, 4, 0, 7); g.fill(); }
}
