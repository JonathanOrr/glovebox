// 360° view: projects the six live camera videos onto a sphere around the car
// (WebGL2), either as a drag-to-look-around view or a flat panorama strip.
//
// Camera model (Kannala-Brandt): a ray at angle th from a camera's optical axis
// lands f*(th + k1*th^3 + k2*th^5) image-widths from the image centre.
// Orientation is yaw (+ = right), pitch (+ = up), roll. Car frame: x right, y up, z forward.
import { CAMS } from "./util.js";

// Solved from this car's footage by bundle adjustment: scenery tracked within each
// camera as the car moves (motion from telemetry) plus scenery shared by
// neighbouring cameras. Positions (metres; x right, height, z forward from the rear
// axle) were placed on Tesla's Model 3 model and only refined a few cm.
// Orientation and lens are adjustable in the Calibrate panel (saved per browser).
const DEFAULT_CALIB = {
  front:          { yaw: -0.9,   pitch: -0.1,  roll: 1.3,  f: 1.2277, k1: 0.0647,  k2: 0.0679,  pos: [0.005, 1.287, 1.811] },
  left_pillar:    { yaw: -67.5,  pitch: -5.3,  roll: -0.4, f: 0.7104, k1: -0.0941, k2: -0.0300, pos: [-0.733, 1.257, 1.037] },
  right_pillar:   { yaw: 66.4,   pitch: -5.3,  roll: -0.3, f: 0.6819, k1: -0.0879, k2: -0.0156, pos: [0.734, 1.223, 1.045] },
  left_repeater:  { yaw: -142.6, pitch: -2.4,  roll: 1.3,  f: 0.7375, k1: -0.1500, k2: 0.0326,  pos: [-0.876, 0.719, 2.493] },
  right_repeater: { yaw: 143.4,  pitch: -2.5,  roll: 1.0,  f: 0.7278, k1: -0.1437, k2: 0.0084,  pos: [0.852, 0.738, 2.469] },
  back:           { yaw: 181.1,  pitch: -32.2, roll: 1.4,  f: 0.3196, k1: 0.0144,  k2: -0.0094, pos: [-0.037, 0.859, -0.890] },
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

// A calibration.json from tools/calibration (served by /api/calibration) replaces
// the built-in values. Slider tweaks are saved per browser on top of whichever
// calibration they were made against, and dropped when that calibration changes.
let base = structuredClone(DEFAULT_CALIB), baseId = null;
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
applyStored();
fetch("/api/calibration").then(r => r.json()).then(j => {
  if (!j.cameras) return;
  for (const cam of ORDER) if (j.cameras[cam]) base[cam] = { ...base[cam], ...j.cameras[cam] };
  if (Array.isArray(j.cameras.eye) && j.cameras.eye.length === 3) eye = j.cameras.eye;
  baseId = j.id;
  applyStored();
}).catch(() => {});

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
  if (uMode == 2) {
    // straight down, no perspective: each pixel is a point on the road, forward is up
    vec2 g = vec2((vUv.x - 0.5) * uAspect, vUv.y - 0.5) * 2.0 * uDist + vec2(0.0, 1.39);
    if (all(greaterThan(g, CAR_LO)) && all(lessThan(g, CAR_HI))) {
      bool bonnet = g.y > CAR_HI.y - 0.9;
      outColor = vec4(bonnet ? vec3(0.42, 0.44, 0.5) : vec3(0.3, 0.32, 0.36), 1.0); return;
    }
    P = vec3(g.x, 0.0, g.y);
  } else P = bowlPoint(d);
  vec4 s = cam(uTex0, uRot[0], uLens[0], uLens2[0], uPos[0], P) + cam(uTex1, uRot[1], uLens[1], uLens2[1], uPos[1], P)
         + cam(uTex2, uRot[2], uLens[2], uLens2[2], uPos[2], P) + cam(uTex3, uRot[3], uLens[3], uLens2[3], uPos[3], P)
         + cam(uTex4, uRot[4], uLens[4], uLens2[4], uPos[4], P) + cam(uTex5, uRot[5], uLens[5], uLens2[5], uPos[5], P);
  outColor = s.a > 0.0 ? vec4(s.rgb / s.a, 1.0) : vec4(0.07, 0.08, 0.1, 1.0);
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
        view: { yaw: 0, pitch: -5, fov: 90 }, top: 8, loc: { dist: loc("uDist"),  rot: loc("uRot"), lens: loc("uLens"), lens2: loc("uLens2"), pos: loc("uPos"), eye: loc("uEye"), focus: loc("uFocus"), mode: loc("uMode"), view: loc("uView"), aspect: loc("uAspect") } };
  P.focus = DEFAULT_FOCUS;
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

// Sliders for one camera's orientation and lens.
function renderCalib(cam) {
  const el = P.overlay.querySelector(".calib");
  const c = calib[cam];
  const rows = [["yaw", "Yaw", -200, 200, 0.5, c.yaw], ["pitch", "Pitch", -45, 45, 0.5, c.pitch], ["roll", "Roll", -30, 30, 0.5, c.roll],
                ["hfov", "Field of view", 30, 200, 1, hfovOf(c)], ["k1", "Distortion", -0.3, 0.5, 0.005, c.k1],
                ["k2", "Edge distortion", -0.1, 0.1, 0.002, c.k2 || 0]];
  el.innerHTML = `<div class="cams">${ORDER.map(k => `<button data-c="${k}" class="${k === cam ? "on" : ""}">${LABELS[k]}</button>`).join("")}</div>` +
    rows.map(([k, l, lo, hi, st, v]) => `<label>${l}<input type="range" data-k="${k}" min="${lo}" max="${hi}" step="${st}" value="${v}"><span>${(+v).toFixed(k[0] === "k" ? 3 : 1)}</span></label>`).join("") +
    `<div class="row"><button data-a="reset">Reset camera</button><button data-a="copy">Copy all</button></div>
     <div class="note">Distortion bends the image toward the edges (0 = fisheye, 0.33 ≈ normal lens). Line up distant scenery across seams.</div>`;
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
}

// Draw the current video frames. Called every animation frame while open.
export function render() {
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
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}

// A new segment loaded new video frames: re-upload even if currentTime matches.
export function invalidate() { if (P) P.loaded = {}; }

export const isOpen = () => !!P;

export function close() {
  if (!P) return;
  P.gl?.getExtension("WEBGL_lose_context")?.loseContext();
  P.canvas.remove(); P.overlay.remove();
  P = null;
}
