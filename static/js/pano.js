// 360° view: projects the six live camera videos onto a sphere around the car
// (WebGL2), either as a drag-to-look-around view or a flat panorama strip.
//
// Camera model (Kannala-Brandt): a ray at angle th from a camera's optical axis
// lands f*(th + k1*th^3 + k2*th^5) image-widths from the image centre.
// Orientation is yaw (+ = right), pitch (+ = up), roll. Car frame: x right, y up, z forward.
import { CAMS, esc } from "./util.js";

// Measured on a 2026 Model 3 (HW4). Orientations come from grid lines painted on a garage
// floor, marked by hand in every camera, together with the direction the car travels in
// each camera's view while driving (optical flow). Lenses and the cameras' shared view of
// scenery come from bundle adjustment over ordinary drives. Positions (metres; x right,
// height, z forward from the rear axle) were placed on a 3D model of the car, the side
// repeaters checked against the car body they see. The Calibrate panel fits these to
// another car from its own drives, or adjusts them by hand (saved per browser).
const DEFAULT_CALIB = {
  front:          { yaw: -0.03,   pitch: -0.36,  roll: 0.74,  f: 1.2277, k1: 0.0647,  k2: 0.0679,  pos: [0.005, 1.287, 1.811] },
  left_pillar:    { yaw: -70.30,  pitch: -3.65,  roll: -1.07, f: 0.7271, k1: -0.0663, k2: -0.0300, pos: [-0.733, 1.257, 1.037] },
  right_pillar:   { yaw: 70.84,   pitch: -3.87,  roll: 0.53,  f: 0.7271, k1: -0.0663, k2: -0.0300, pos: [0.734, 1.223, 1.045] },
  left_repeater:  { yaw: -141.32, pitch: -2.25,  roll: 2.57,  f: 0.7206, k1: -0.1526, k2: 0.0326,  pos: [-0.896, 0.719, 2.493] },
  right_repeater: { yaw: 141.33,  pitch: -2.85,  roll: 0.32,  f: 0.7206, k1: -0.1526, k2: 0.0326,  pos: [0.897, 0.738, 2.469] },
  back:           { yaw: 180.48,  pitch: -32.39, roll: 1.37,  f: 0.3196, k1: 0.0144,  k2: -0.0094, pos: [-0.037, 0.859, -0.890] },
};
// The 360 view looks out from the middle of the car. Scenery is projected onto a
// "bowl": the road as a flat floor, then a wall at the focus distance. Things on the
// road or near that distance line up across camera seams; others show some doubling.
const EYE = [0, 1.25, 1.3];  // a Model 3; calibration.json can carry another car's
let eye = EYE;
const DEFAULT_FOCUS = 12;
// The rear fisheye sees the car itself around its frame (trunk lip at the top
// corners, bumper and plate bracket at the bottom), so only a circle in the middle
// is used (radius in image widths); its outer edge above the horizon is also mostly
// sky the calibration couldn't measure.
const MASKS = { back: { circle: 0.49, maxAngle: 72 } };
const ORDER = CAMS.map(([c]) => c);
const LABELS = Object.fromEntries(CAMS);
const FRONT_BOOST = 1.6;  // prefer the sharper front camera where views overlap

// A calibration.json made for this car (by the Calibrate panel, or tools/calibration)
// replaces the built-in values. Slider tweaks are saved per browser on top of whichever
// calibration they were made against, and dropped when that calibration changes.
let base = structuredClone(DEFAULT_CALIB), baseId = null, calibInfo = {};
let calib = structuredClone(DEFAULT_CALIB);
const STORE = "panoCalib4";   // { base: calibration.json id or null, cams }
const OLD_STORE = "panoCalib3";
function applyStored() {
  calib = structuredClone(base);
  try {
    const s = JSON.parse(localStorage.getItem(STORE) || "null") ?? { base: null, cams: JSON.parse(localStorage.getItem(OLD_STORE) || "{}") };
    if (s.base === baseId) for (const cam of ORDER) if (s.cams?.[cam]) calib[cam] = { ...calib[cam], ...s.cams[cam] };
  } catch {}
}
function loadCalibration() {
  return fetch("/api/calibration").then(r => r.json()).then(j => {
    calibInfo = j;
    base = structuredClone(DEFAULT_CALIB);
    eye = EYE;
    for (const cam of ORDER) if (j.cameras?.[cam]) base[cam] = { ...base[cam], ...j.cameras[cam] };
    if (Array.isArray(j.cameras?.eye) && j.cameras.eye.length === 3) eye = j.cameras.eye;
    baseId = j.id ?? null;
    applyStored();
    carPictures(j.vehicleId || "model_3_highland_hw4");  // early, before any video takes the connections
    if (P?.gl) loadCar();  // the car picture follows the car the calibration was made for
  }).catch(() => {});
}
applyStored();
loadCalibration();

const VERT = `#version 300 es
in vec2 aPos; out vec2 vUv;
void main() { vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;

const FRAG = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 outColor;
uniform sampler2D uTex0, uTex1, uTex2, uTex3, uTex4, uTex5;
uniform mat3 uRot[6];
uniform vec4 uLens[6];   // f, k1, image height/width, weight boost (0 = no video)
uniform vec4 uLens2[6];  // k2, image-circle radius (0 = none), max angle (radians), unused
uniform vec3 uPos[6];    // camera positions (metres, car frame)
uniform vec3 uEye;       // viewpoint
uniform float uFocus;    // bowl wall distance (metres)
uniform int uMode;       // 0 = look around, 1 = panorama strip, 2 = top down (straight down onto the road)
uniform float uDist;     // top down: metres from the middle of the car to the top of the view
uniform vec3 uView;      // yaw, pitch, vertical fov (radians)
uniform float uAspect;   // canvas width / height
// Top down: a picture of the car drawn over the road, and its front wheels turned by the steering.
uniform sampler2D uCar, uWheelL, uWheelR;
uniform vec4 uCarRect;   // the car picture's left, back, right and front edges (metres); none if right <= left
uniform vec4 uWheels;    // wheelbase, half the front track, left and right wheel angles (radians, + = right)
uniform float uWheelBox; // size of a wheel picture (metres)
uniform float uCenter;   // distance forward of the rear axle at the middle of the view

vec3 rayDir() {
  if (uMode == 1) {
    float span = min(3.14159, 6.28318 / uAspect);
    float yaw = (vUv.x - 0.5) * 6.28318 + uView.x;
    float pit = (vUv.y - 0.5) * span;
    return vec3(cos(pit) * sin(yaw), sin(pit), cos(pit) * cos(yaw));
  }
  float t = tan(uView.z * 0.5);
  vec3 d = normalize(vec3((vUv.x * 2.0 - 1.0) * t * uAspect, (vUv.y * 2.0 - 1.0) * t, 1.0));
  float cp = cos(uView.y), sp = sin(uView.y);
  d = vec3(d.x, d.y * cp + d.z * sp, -d.y * sp + d.z * cp);
  float cy = cos(uView.x), sy = sin(uView.x);
  return vec3(d.x * cy + d.z * sy, d.y, -d.x * sy + d.z * cy);
}

// Top down: the car's footprint (x right, z forward from the rear axle), drawn flat.
const vec2 CAR_LO = vec2(-0.93, -0.98), CAR_HI = vec2(0.93, 3.76);

// Where the view ray meets the bowl: the road if it hits within the focus distance,
// otherwise the wall.
vec3 bowlPoint(vec3 d) {
  if (d.y < -0.001) {
    float t = -uEye.y / d.y;
    if (length(d.xz * t) < uFocus) return uEye + d * t;
  }
  return uEye + d * uFocus;
}

// A picture over what's drawn so far: straight (not premultiplied) alpha, uv (0,0) = top left.
vec3 over(vec3 under, sampler2D tex, vec2 uv) {
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return under;
  vec4 c = texture(tex, uv);
  return mix(under, c.rgb, c.a);
}

// A front wheel's picture at the road point g: centred on its hub, turned by angle a (+ = right).
vec3 wheel(vec3 under, sampler2D tex, vec2 g, vec2 hub, float a) {
  vec2 d = g - hub;
  vec2 l = vec2(d.x * cos(a) - d.y * sin(a), d.x * sin(a) + d.y * cos(a));
  return over(under, tex, vec2(0.5 + l.x / uWheelBox, 0.5 - l.y / uWheelBox));
}

vec4 cam(sampler2D tex, mat3 R, vec4 L, vec4 L2, vec3 pos, vec3 P) {
  if (L.w <= 0.0) return vec4(0.0);
  vec3 c = normalize(P - pos) * R;        // ray from this camera, in camera coordinates
  float th = acos(clamp(c.z, -1.0, 1.0));
  if (th > L2.z) return vec4(0.0);
  float ph = atan(c.y, c.x);
  float t2 = th * th;
  float r = L.x * th * (1.0 + t2 * (L.y + L2.x * t2));
  vec2 uv = vec2(0.5 + r * cos(ph), 0.5 - r * sin(ph) / L.z);
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return vec4(0.0);
  // weight: distance to the image border (or fisheye circle), sharpened so seams stay narrow
  float edge = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y) * L.z);
  if (L2.y > 0.0) edge = min(edge, L2.y - r);
  if (edge <= 0.0) return vec4(0.0);
  edge *= L.w;
  float w = edge * edge * edge;
  return vec4(texture(tex, uv).rgb * w, w);
}

void main() {
  vec3 d = rayDir(), P;
  bool pic = uCarRect.z > uCarRect.x;
  vec2 g = vec2(0.0);
  if (uMode == 2) {
    // straight down, no perspective: each pixel is a point on the road, forward is up
    g = vec2((vUv.x - 0.5) * uAspect, vUv.y - 0.5) * 2.0 * uDist + vec2(0.0, uCenter);
    if (!pic && all(greaterThan(g, CAR_LO)) && all(lessThan(g, CAR_HI))) {
      bool bonnet = g.y > CAR_HI.y - 0.9;
      outColor = vec4(bonnet ? vec3(0.42, 0.44, 0.5) : vec3(0.3, 0.32, 0.36), 1.0); return;
    }
    P = vec3(g.x, 0.0, g.y);
  } else P = bowlPoint(d);
  vec4 s = cam(uTex0, uRot[0], uLens[0], uLens2[0], uPos[0], P) + cam(uTex1, uRot[1], uLens[1], uLens2[1], uPos[1], P)
         + cam(uTex2, uRot[2], uLens[2], uLens2[2], uPos[2], P) + cam(uTex3, uRot[3], uLens[3], uLens2[3], uPos[3], P)
         + cam(uTex4, uRot[4], uLens[4], uLens2[4], uPos[4], P) + cam(uTex5, uRot[5], uLens[5], uLens2[5], uPos[5], P);
  vec3 col = s.a > 0.0 ? s.rgb / s.a : vec3(0.07, 0.08, 0.1);
  if (uMode == 2 && pic) {
    col = wheel(col, uWheelL, g, vec2(-uWheels.y, uWheels.x), uWheels.z);
    col = wheel(col, uWheelR, g, vec2(uWheels.y, uWheels.x), uWheels.w);
    col = over(col, uCar, vec2((g.x - uCarRect.x) / (uCarRect.z - uCarRect.x), (uCarRect.w - g.y) / (uCarRect.w - uCarRect.y)));
  }
  outColor = vec4(col, 1.0);
}`;

let P = null;  // { canvas, gl, prog, tex[], loc, videos, mode, view, overlay }

// Rotation matrix (column-major for WebGL) for yaw/pitch/roll in degrees.
function rotMatrix({ yaw, pitch, roll }) {
  const [y, p, r] = [yaw, pitch, roll].map(a => a * Math.PI / 180);
  const Ry = [[Math.cos(y), 0, Math.sin(y)], [0, 1, 0], [-Math.sin(y), 0, Math.cos(y)]];
  const Rp = [[1, 0, 0], [0, Math.cos(p), Math.sin(p)], [0, -Math.sin(p), Math.cos(p)]];
  const Rr = [[Math.cos(r), -Math.sin(r), 0], [Math.sin(r), Math.cos(r), 0], [0, 0, 1]];
  const mul = (A, B) => A.map((row, i) => B[0].map((_, j) => row.reduce((s, _, k) => s + A[i][k] * B[k][j], 0)));
  const R = mul(mul(Ry, Rp), Rr);
  return [R[0][0], R[1][0], R[2][0], R[0][1], R[1][1], R[2][1], R[0][2], R[1][2], R[2][2]];
}

// Horizontal field of view (degrees) implied by the lens, and the f that gives a wanted one.
const shape = (th, k1, k2) => th + k1 * th ** 3 + k2 * th ** 5;
const hfovOf = ({ f, k1, k2 = 0 }) => {
  let th = 0.5 / f;
  for (let i = 0; i < 20; i++) th -= (f * shape(th, k1, k2) - 0.5) / (f * (1 + 3 * k1 * th ** 2 + 5 * k2 * th ** 4));
  return 2 * th * 180 / Math.PI;
};
const fFor = (hfov, k1, k2 = 0) => 0.5 / shape(hfov * Math.PI / 360, k1, k2);

// videos: { cam: HTMLVideoElement }; container: element to overlay.
export function open(videos, container) {
  close();
  const canvas = document.createElement("canvas");
  canvas.className = "pano";
  const overlay = document.createElement("div");
  overlay.className = "pano-ui";
  overlay.innerHTML = `
    <div class="seg"><button data-m="0">Look around</button><button data-m="1">Panorama</button><button data-m="2">Top down</button></div>
    <label class="focus" title="Distance where camera seams line up best">Focus <input type="range" min="0" max="1" step="0.001"><span></span></label>
    <button data-a="calib">Calibrate</button>
    <div class="pano-hint">Drag to look around · scroll to zoom</div>
    <div class="calib" hidden></div>`;
  container.append(canvas, overlay);
  const gl = canvas.getContext("webgl2");
  if (!gl) { overlay.innerHTML = `<div class="pano-hint">360° view needs WebGL2, which isn't available here.</div>`; P = { canvas, overlay }; return; }

  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
  const prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  gl.useProgram(prog);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(prog, "aPos");
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  const tex = ORDER.map((_, i) => {
    const t = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + i);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.uniform1i(gl.getUniformLocation(prog, `uTex${i}`), i);
    return t;
  });
  const loc = n => gl.getUniformLocation(prog, n);
  P = { canvas, overlay, gl, prog, tex, videos, loaded: {}, lastTime: {}, mode: 0,
        view: { yaw: 0, pitch: -5, fov: 90 }, top: 8, loc: { dist: loc("uDist"),  rot: loc("uRot"), lens: loc("uLens"), lens2: loc("uLens2"), pos: loc("uPos"), eye: loc("uEye"), focus: loc("uFocus"), mode: loc("uMode"), view: loc("uView"), aspect: loc("uAspect"),
                carRect: loc("uCarRect"), center: loc("uCenter"), wheels: loc("uWheels"), wheelBox: loc("uWheelBox") } };
  ["uCar", "uWheelL", "uWheelR"].forEach((n, i) => gl.uniform1i(gl.getUniformLocation(prog, n), 6 + i));
  P.focus = DEFAULT_FOCUS;
  loadCar();
  try { P.mode = +(localStorage.getItem("panoMode") || 0); P.focus = +(localStorage.getItem("panoFocus") || DEFAULT_FOCUS); } catch {}

  overlay.querySelectorAll("[data-m]").forEach(b => b.onclick = () => {
    P.mode = +b.dataset.m;
    try { localStorage.setItem("panoMode", P.mode); } catch {}
    syncButtons();
  });
  overlay.querySelector("[data-a=calib]").onclick = () => {
    const c = overlay.querySelector(".calib");
    c.hidden = !c.hidden;
    overlay.querySelector("[data-a=calib]").classList.toggle("on", !c.hidden);
    if (!c.hidden) renderCalib(ORDER[1]);
  };
  // Focus distance slider on a log scale, 3-60 m.
  const fIn = overlay.querySelector(".focus input"), fOut = overlay.querySelector(".focus span");
  const toM = u => 3 * Math.pow(20, u), toU = m => Math.log(m / 3) / Math.log(20);
  fIn.value = toU(P.focus); fOut.textContent = `${Math.round(P.focus)} m`;
  fIn.oninput = () => {
    P.focus = toM(+fIn.value); fOut.textContent = `${Math.round(P.focus)} m`;
    try { localStorage.setItem("panoFocus", P.focus); } catch {}
  };
  syncButtons();

  // Drag to look around (or scroll the panorama); wheel zooms.
  let drag = null;
  canvas.onpointerdown = e => { drag = { x: e.clientX, y: e.clientY }; canvas.setPointerCapture(e.pointerId); };
  canvas.onpointermove = e => {
    if (!drag) return;
    if (P.mode === 2) return;
    const degPerPx = P.mode ? 360 / canvas.clientWidth : P.view.fov / canvas.clientHeight;
    P.view.yaw -= (e.clientX - drag.x) * degPerPx;
    if (!P.mode) P.view.pitch = Math.max(-80, Math.min(80, P.view.pitch + (e.clientY - drag.y) * degPerPx));
    drag = { x: e.clientX, y: e.clientY };
  };
  canvas.onpointerup = () => { drag = null; };
  canvas.onwheel = e => { e.preventDefault();
    if (P.mode === 2) P.top = Math.max(3, Math.min(30, P.top * Math.exp(e.deltaY * 0.001)));
    else if (!P.mode) P.view.fov = Math.max(30, Math.min(120, P.view.fov * Math.exp(e.deltaY * 0.001))); };
}

function syncButtons() {
  P.overlay.querySelectorAll("[data-m]").forEach(b => b.classList.toggle("on", +b.dataset.m === P.mode));
  P.overlay.querySelector(".pano-hint").textContent = ["Drag to look around · scroll to zoom", "Drag sideways to turn the panorama", "Scroll to zoom"][P.mode];
}

function saveCalib() { try { localStorage.setItem(STORE, JSON.stringify({ base: baseId, cams: calib })); } catch {} }

// The Calibrate panel: fitting the cameras to this car from its own drives (run by the
// server in the background), and sliders for one camera's orientation and lens.
function renderCalib(cam) {
  const el = P.overlay.querySelector(".calib");
  P.calibCam = cam;
  const c = calib[cam];
  const rows = [["yaw", "Yaw", -200, 200, 0.5, c.yaw], ["pitch", "Pitch", -45, 45, 0.5, c.pitch], ["roll", "Roll", -30, 30, 0.5, c.roll],
                ["hfov", "Field of view", 30, 200, 1, hfovOf(c)], ["k1", "Distortion", -0.3, 0.5, 0.005, c.k1],
                ["k2", "Edge distortion", -0.1, 0.1, 0.002, c.k2 || 0]];
  el.innerHTML = `<div class="fit"></div>
    <details class="hand" ${P.handOpen ? "open" : ""}><summary>Adjust by hand</summary>
    <div class="cams">${ORDER.map(k => `<button data-c="${k}" class="${k === cam ? "on" : ""}">${LABELS[k]}</button>`).join("")}</div>` +
    rows.map(([k, l, lo, hi, st, v]) => `<label>${l}<input type="range" data-k="${k}" min="${lo}" max="${hi}" step="${st}" value="${v}"><span>${(+v).toFixed(k[0] === "k" ? 3 : 1)}</span></label>`).join("") +
    `<div class="row"><button data-a="reset">Reset camera</button><button data-a="copy">Copy all</button></div>
     <div class="note">Distortion bends the image toward the edges (0 = fisheye, 0.33 ≈ normal lens). Line up distant scenery across seams.</div>
    </details>`;
  el.querySelector(".hand").ontoggle = e => { P.handOpen = e.target.open; };
  el.querySelectorAll("[data-c]").forEach(b => b.onclick = () => renderCalib(b.dataset.c));
  el.querySelectorAll("input").forEach(inp => inp.oninput = () => {
    const v = +inp.value, k = inp.dataset.k;
    if (k === "hfov") c.f = fFor(v, c.k1, c.k2);
    else if (k === "k1" || k === "k2") { const h = hfovOf(c); c[k] = v; c.f = fFor(h, c.k1, c.k2); }  // keep the FOV
    else c[k] = v;
    inp.nextElementSibling.textContent = v.toFixed(k[0] === "k" ? 3 : 1);
    saveCalib();
  });
  el.querySelector("[data-a=reset]").onclick = () => { calib[cam] = structuredClone(base[cam]); saveCalib(); renderCalib(cam); };
  el.querySelector("[data-a=copy]").onclick = () => navigator.clipboard?.writeText(JSON.stringify(calib, null, 1));
  renderFit();
  pollFit();
}

function renderFit() {
  const el = P?.overlay.querySelector(".fit");
  if (!el) return;
  const job = P.fit || {}, vehicles = job.vehicles || [];
  const made = calibInfo.cameras;
  const car = vehicles.find(v => v.name === made?.vehicle);
  let chosen = P.vehicle;
  try { chosen ??= localStorage.getItem("calibVehicle"); } catch {}
  chosen ??= car?.id ?? "model_3_highland_hw4";
  const date = made && calibInfo.date ? new Date(calibInfo.date).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "";
  const msg = job.running ? `Step ${job.step + 1} of ${job.steps}: ${esc(job.message)}…`
    : job.error ? `<span class="err">${esc(job.error)}</span>`
    : job.justDone ? "Done. The 360° view now uses the new calibration." : "";
  el.innerHTML = `<div class="fit-title">Fit to your car</div>
    <div class="note">${made ? `Calibrated for ${made.vehicle ? esc(made.vehicle) : "this car"}${date ? ` on ${date}` : ""}.`
                              : "Using the built-in calibration, measured on a 2026 Model 3. On one of those it probably fits already."}</div>
    <label class="car">Car <select ${job.running ? "disabled" : ""}>${vehicles.map(v =>
      `<option value="${esc(v.id)}" ${v.id === chosen ? "selected" : ""}>${esc(v.name)}</option>`).join("")}</select></label>
    <button data-a="fit" class="go" ${job.running || !vehicles.length ? "disabled" : ""}>${job.running ? "Calibrating…" : "Calibrate from my drives"}</button>
    ${msg ? `<div class="fit-msg">${msg}</div>` : ""}
    <div class="note">Uses daytime drives on the USB drive and takes about five minutes. You can keep watching meanwhile.</div>
    ${!job.running && (calibInfo.previous || made) ? `<div class="row">
      ${calibInfo.previous ? `<button data-a="undo">Undo last change</button>` : ""}
      ${made ? `<button data-a="builtin">Use built-in values</button>` : ""}</div>` : ""}`;
  const sel = el.querySelector("select");
  sel.onchange = () => { P.vehicle = sel.value; try { localStorage.setItem("calibVehicle", sel.value); } catch {} };
  el.querySelector("[data-a=fit]").onclick = async () => {
    const r = await (await fetch("/api/calibrate", { method: "POST", body: JSON.stringify({ vehicle: sel.value }) })).json();
    P.fit = { ...job, ...(r.error ? { error: r.error } : { running: true, step: 0, steps: 3, message: "Starting" }) };
    renderFit();
    pollFit();
  };
  const change = what => async () => {
    await fetch(`/api/calibration/${what}`, { method: "POST" });
    await loadCalibration();
    if (P) { P.fit = { vehicles }; renderCalib(P.calibCam); }
  };
  el.querySelector("[data-a=undo]")?.addEventListener("click", change("undo"));
  el.querySelector("[data-a=builtin]")?.addEventListener("click", change("reset"));
}

// Follow a calibration run on the server; when it finishes, switch to its result.
async function pollFit() {
  clearTimeout(P.fitTimer);
  let job;
  try { job = await (await fetch("/api/calibrate")).json(); } catch { return; }
  if (!P?.gl) return;
  const finished = P.fit?.running && !job.running;
  P.fit = { ...job, justDone: finished || (P.fit?.justDone && !job.running && !job.error) };
  if (finished) {
    await loadCalibration();
    if (!P) return;
    if (!P.overlay.querySelector(".calib").hidden) renderCalib(P.calibCam);
  } else renderFit();
  if (job.running) P.fitTimer = setTimeout(pollFit, 1500);
}

// Draw the current video frames. Called every animation frame while open.
// Top down: pictures of the car from above (static/cars, rendered from 3D models of each car; a plain
// box for a car without one). The car is whichever the calibration was made for.
const STEER_RATIO = { model_s_2021_hw4: 12.5, model_x_2021_hw4: 12.5, cybertruck_hw4: 12 };  // others about 10.5:1
// Fetched once per page and kept: while six videos stream they take all the browser's connections to
// the viewer, so fetching the pictures again on each opening could wait a long time.
let carIndex = null;
const carPics = {};  // vehicle id -> Promise of { meta, imgs: [body, left wheel, right wheel] } or null
function carPictures(id) {
  carIndex ??= fetch("/cars/index.json").then(r => r.ok ? r.json() : {}).catch(() => ({}));
  return carPics[id] ??= carIndex.then(index => {
    if (!index[id]) return null;
    const imgs = ["", "-wheel-left", "-wheel-right"].map(suffix => {
      const img = new Image();
      img.src = `/cars/${id}${suffix}.png`;
      return img.decode().then(() => img);
    });
    return Promise.all(imgs).then(imgs => ({ meta: index[id], imgs })).catch(() => null);
  });
}

function loadCar() {
  const want = calibInfo.vehicleId || "model_3_highland_hw4";
  if (P.car?.id === want) return;
  P.car = { id: want };
  carPictures(want).then(pics => {
    if (!pics || !P?.gl || P.car.id !== want) return;
    const { gl } = P;
    pics.imgs.forEach((img, i) => {
      const t = gl.createTexture();
      gl.activeTexture(gl.TEXTURE6 + i);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    });
    P.car.meta = pics.meta;
  });
}

// Road-wheel angles (radians, + = right) for a steering wheel angle in degrees: the inner wheel turns
// more than the outer one, both pointing about the same centre of the turn (Ackermann).
function wheelAngles(steer, m) {
  const d = steer / (STEER_RATIO[P.car.id] || 10.5) * Math.PI / 180;
  if (Math.abs(d) < 1e-4) return [d, d];
  const R = m.wheelbase / Math.tan(d);  // turning radius at the middle of the rear axle, + = right
  return [Math.atan(m.wheelbase / (R + m.track / 2)), Math.atan(m.wheelbase / (R - m.track / 2))];
}

export function render(steer = 0) {
  if (!P?.gl) return;
  const { gl, canvas } = P;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const W = Math.round(canvas.clientWidth * dpr), H = Math.round(canvas.clientHeight * dpr);
  if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
  gl.viewport(0, 0, W, H);
  const rots = [], lens = [], lens2 = [], pos = [];
  ORDER.forEach((cam, i) => {
    const v = P.videos[cam];
    const ok = v && v.getAttribute("src") && v.readyState >= 2 && v.videoWidth;
    if (ok && (P.lastTime[cam] !== v.currentTime || !P.loaded[cam])) {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, v);
      P.lastTime[cam] = v.currentTime; P.loaded[cam] = true;
    }
    const c = calib[cam];
    rots.push(...rotMatrix(c));
    lens.push(c.f, c.k1, ok ? v.videoHeight / v.videoWidth : 1, ok ? (cam === "front" ? FRONT_BOOST : 1) : 0);
    const m = "mask" in c ? c.mask : MASKS[cam];  // calibration.json may set or clear it (null)
    lens2.push(c.k2 || 0, m?.circle || 0, (m?.maxAngle || 100) * Math.PI / 180, 0);
    pos.push(...(c.pos || DEFAULT_CALIB[cam].pos));
  });
  gl.uniformMatrix3fv(P.loc.rot, false, new Float32Array(rots));
  gl.uniform4fv(P.loc.lens, new Float32Array(lens));
  gl.uniform4fv(P.loc.lens2, new Float32Array(lens2));
  gl.uniform3fv(P.loc.pos, new Float32Array(pos));
  gl.uniform3f(P.loc.eye, ...eye);
  gl.uniform1f(P.loc.focus, P.focus);
  gl.uniform1i(P.loc.mode, P.mode);
  gl.uniform3f(P.loc.view, P.view.yaw * Math.PI / 180, P.view.pitch * Math.PI / 180, P.view.fov * Math.PI / 180);
  gl.uniform1f(P.loc.dist, P.top);
  gl.uniform1f(P.loc.aspect, W / H);
  const m = P.car?.meta;
  gl.uniform4f(P.loc.carRect, ...(m ? [m.left, m.back, m.right, m.front] : [0, 0, 0, 0]));
  gl.uniform1f(P.loc.center, m ? (m.back + m.front) / 2 : 1.39);
  if (m) {
    gl.uniform4f(P.loc.wheels, m.wheelbase, m.track / 2, ...wheelAngles(steer, m));
    gl.uniform1f(P.loc.wheelBox, m.wheelBox);
  }
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}

// A new segment loaded new video frames: re-upload even if currentTime matches.
export function invalidate() { if (P) P.loaded = {}; }

export const isOpen = () => !!P;

export function close() {
  if (!P) return;
  clearTimeout(P.fitTimer);
  P.gl?.getExtension("WEBGL_lose_context")?.loseContext();
  P.canvas.remove(); P.overlay.remove();
  P = null;
}
