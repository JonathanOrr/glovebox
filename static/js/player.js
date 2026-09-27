// The player view: six cameras kept in sync, one-minute segments stitched into
// one timeline, telemetry loading, and deleting events.
import { $, fmtSize, fmtT, parseTs, fileUrl, evKey, eventStart, placeName, category, CAMS } from "./util.js";
import { state, visibleEvents } from "./state.js";
import { renderList, openEvent } from "./app.js";
import { renderHud } from "./hud.js";
import { setupTimeline, drawTimeline } from "./timeline.js";
import * as followMap from "./followmap.js";
import * as pano from "./pano.js";

const RATES = [0.5, 1, 2, 4];
let showFollow = true;
try { showFollow = localStorage.getItem("followMap") !== "off"; } catch {}

let cur = null;  // the open event's playback state, or null

export const currentEvent = () => cur?.ev || null;

export function show(ev, startAt) {
  stop();
  if (!ev) { $("#main").innerHTML = `<div class="empty">Select an event</div>`; renderList(); return; }
  const main = $("#main");
  main.innerHTML = "";
  main.appendChild($("#viewer").content.cloneNode(true));

  // The server lays the clips out on one timeline: start/dur in seconds from t0.
  const t0 = eventStart(ev);
  const segs = ev.segments.map(s => ({ ...s, tel: null }));
  history.replaceState(null, "", "#" + encodeURIComponent(evKey(ev)));
  cur = { ev, segs, t0, seg: -1, playing: false, rate: 1, videos: {}, raf: 0, solo: null };

  const d = parseTs(ev.name);
  $("#evTitle").textContent = d.toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  $("#evSub").textContent = [placeName(ev), category(ev), `${segs.length} min`, fmtSize(ev.size)].filter(Boolean).join(" · ");

  const stage = $("#stage");
  CAMS.forEach(([cam, label], i) => {
    const box = document.createElement("div");
    box.className = "cam";
    box.innerHTML = `<video muted playsinline preload="auto"></video><div class="label">${i + 1} · ${label}</div>` + (cam === "front" ? `<div class="clock" id="clock"></div>` : "");
    box.onclick = () => toggleSolo(cam);
    stage.appendChild(box);
    cur.videos[cam] = { el: box.querySelector("video"), box };
  });

  $("#delBtn").onclick = deleteCurrent;
  $("#mapBtn").onclick = toggleFollowMap;
  $("#panoBtn").onclick = togglePano;
  applyFollowMap(ev);
  $("#playBtn").onclick = togglePlay;
  $("#rates").innerHTML = RATES.map(r => `<button data-r="${r}" class="${r === 1 ? "on" : ""}">${r}×</button>`).join("");
  $("#rates").querySelectorAll("button").forEach(b => b.onclick = () => setRate(+b.dataset.r));
  setupTimeline(cur, seekGlobal);
  cur.raf = requestAnimationFrame(() => tick());
  renderList();
  $(".ev.sel")?.scrollIntoView({ block: "nearest" });

  // Default: start just before the moment the event was saved (usually ~1 min before the end).
  state.lastEv = ev;
  let from = 0;
  if (ev.info.timestamp) {
    const trig = (new Date(ev.info.timestamp) - t0) / 1000;
    if (trig > 0) { cur.trigger = trig; from = Math.max(0, trig - 20); }
  }
  seekGlobal(startAt ?? from);
  loadTelemetry(cur);
}

function applyFollowMap(ev) {
  $("#follow").hidden = !showFollow;
  $("#mapBtn").classList.toggle("on", showFollow);
  if (showFollow) followMap.init(ev, $("#follow"), seekGlobal);
  else followMap.destroy();
}

function togglePano() {
  if (!cur) return;
  if (pano.isOpen()) pano.close();
  else pano.open(Object.fromEntries(Object.entries(cur.videos).map(([c, v]) => [c, v.el])), $("#stage"));
  $("#panoBtn").classList.toggle("on", pano.isOpen());
}

function toggleFollowMap() {
  if (!cur) return;
  showFollow = !showFollow;
  try { localStorage.setItem("followMap", showFollow ? "on" : "off"); } catch {}
  applyFollowMap(cur.ev);
}

// Stop playback and release the video files.
export function stop() {
  if (!cur) return;
  followMap.destroy();
  pano.close();
  cancelAnimationFrame(cur.raf);
  Object.values(cur.videos).forEach(v => { v.el.pause(); v.el.removeAttribute("src"); v.el.load(); });
  cur.dead = true;
  cur = null;
}

function master() {
  const s = cur.segs[cur.seg];
  const cam = s && (s.cameras.includes("front") ? "front" : s.cameras[0]);
  return cam ? cur.videos[cam].el : null;
}

// The six files of a minute end at the same instant but start up to half a second apart (each starts
// recording at its own keyframe), so the same file time is a different moment in each camera. A camera
// whose file is longer than the master's started earlier and is played that much further in.
// (Measured on 131 drives: the jolt of a bump shows up in each camera exactly this far apart.)
function camTime(cam, t) {
  const v = cur.videos[cam].el, m = master();
  const lag = m && v !== m && v.duration && m.duration ? v.duration - m.duration : 0;
  return Math.min(Math.max(0, t + lag), v.duration || Infinity);
}

function loadSegment(i, offset) {
  const s = cur.segs[i];
  cur.seg = i;
  return new Promise(resolve => {
    let pending = 0;
    const done = () => {
      if (--pending) return;
      CAMS.forEach(([cam]) => { const v = cur.videos[cam]; if (s.cameras.includes(cam) && v.el.duration) v.el.currentTime = camTime(cam, offset); });
      resolve();
    };
    CAMS.forEach(([cam]) => {
      const v = cur.videos[cam];
      if (s.cameras.includes(cam)) {
        v.box.classList.remove("missing");
        v.el.src = fileUrl(cur.ev, `${s.ts}-${cam}.mp4`);
        pano.invalidate();
        v.el.playbackRate = cur.rate;
        pending++;
        v.el.addEventListener("loadedmetadata", done, { once: true });
        v.el.addEventListener("error", done, { once: true });
      } else {
        v.box.classList.add("missing");
        v.el.removeAttribute("src");
      }
    });
    if (!pending) resolve();
    const m = master();
    if (m) m.onended = () => {
      if (cur.seg + 1 < cur.segs.length) loadSegment(cur.seg + 1, 0).then(() => { if (cur.playing) playAll(); });
      else { cur.playing = false; updatePlayBtn(); }
    };
  });
}

// Seek to t seconds from the start of the event, loading another segment if needed.
async function seekGlobal(t) {
  if (!cur) return;
  const segs = cur.segs;
  let i = segs.findIndex(s => t < s.start + s.dur);
  if (i < 0) { i = segs.length - 1; t = segs[i].start + segs[i].dur - 0.05; }
  const off = Math.max(0, t - segs[i].start);
  if (i !== cur.seg) {
    await loadSegment(i, off);
    if (cur.playing) playAll();
  } else {
    Object.entries(cur.videos).forEach(([cam, v]) => { if (v.el.src) v.el.currentTime = camTime(cam, off); });
  }
  tick(true);
}

function playAll() { Object.values(cur.videos).forEach(v => { if (v.el.src) v.el.play().catch(() => {}); }); }
function pauseAll() { Object.values(cur.videos).forEach(v => v.el.pause()); }
function togglePlay() {
  if (!cur) return;
  cur.playing = !cur.playing;
  cur.playing ? playAll() : pauseAll();
  updatePlayBtn();
}
function updatePlayBtn() { $("#playBtn").textContent = cur.playing ? "❚❚ Pause" : "▶ Play"; }
function setRate(r) {
  cur.rate = r;
  Object.values(cur.videos).forEach(v => v.el.playbackRate = r);
  $("#rates").querySelectorAll("button").forEach(b => b.classList.toggle("on", +b.dataset.r === r));
}
function step(frames) {
  if (cur.playing) togglePlay();
  seekGlobal(globalTime() + frames / 36);
}
function toggleSolo(cam) {
  cur.solo = cur.solo === cam ? null : cam;
  $("#stage").classList.toggle("solo", !!cur.solo);
  Object.entries(cur.videos).forEach(([c, v]) => v.box.classList.toggle("big", c === cur.solo));
}

function globalTime() {
  const m = master();
  return cur.segs[cur.seg].start + (m ? m.currentTime : 0);
}

// Every frame: keep all cameras locked to the master, update HUD and timeline.
function tick(once) {
  if (!cur || cur.dead) return;
  const m = master();
  if (m) {
    Object.entries(cur.videos).forEach(([cam, v]) => {
      if (v.el === m || !v.el.src || v.el.readyState < 1) return;
      // Browsers let separate videos drift apart by several frames. Far off: jump. Otherwise speed the
      // camera up or slow it down a little so it catches up smoothly (a jump would stutter).
      const want = camTime(cam, m.currentTime);
      const drift = v.el.currentTime - want;
      if (Math.abs(drift) > 0.3 || m.paused) { if (Math.abs(drift) > 0.01) v.el.currentTime = want; }
      else v.el.playbackRate = cur.rate * (1 - Math.max(-0.2, Math.min(0.2, drift * 4)));
      if (cur.playing && v.el.paused && !m.paused) v.el.play().catch(() => {});
    });
    const g = globalTime();
    const total = cur.segs.at(-1).start + cur.segs.at(-1).dur;
    $("#timeLbl").textContent = `${fmtT(g)} / ${fmtT(total)}`;
    const wall = new Date(cur.t0.getTime() + g * 1000);
    $("#clock").textContent = wall.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    drawTimeline(cur, g);
    const x = sampleAt(cur.seg, m.currentTime);
    renderHud(cur, x);
    followMap.update(x);
    pano.render();
  }
  if (!once) cur.raf = requestAnimationFrame(() => tick());
}

async function loadTelemetry(c) {
  for (const s of c.segs) {
    if (c.dead) return;
    const cam = s.cameras.includes("front") ? "front" : s.cameras[0];
    try {
      const r = await fetch(`/api/telemetry?source=${c.ev.source}&event=${encodeURIComponent(c.ev.name)}&ts=${s.ts}&cam=${cam}`);
      const j = await r.json();
      if (j.t && j.t.length) {
        const k = Object.fromEntries(j.keys.map((n, i) => [n, i]));
        s.tel = { t: j.t, d: j.d, k };
      } else s.tel = { t: [], d: [], k: {} };
    } catch { s.tel = { t: [], d: [], k: {} }; }
    c.timelineDirty = true;
  }
}

// Telemetry row at time t within a segment, as {speed_mps, gear, ...}.
function sampleAt(segIdx, t) {
  const s = cur.segs[segIdx];
  if (!s || !s.tel || !s.tel.t.length) return null;
  const ts = s.tel.t;
  let lo = 0, hi = ts.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (ts[mid] <= t) lo = mid; else hi = mid - 1; }
  const row = s.tel.d[lo], k = s.tel.k;
  const o = {}; for (const n in k) o[n] = row[k[n]];
  return o;
}

async function deleteCurrent() {
  if (!cur) return;
  const ev = cur.ev;
  if (!confirm(`Permanently delete this event from the USB drive?\n\n${ev.source}/${ev.name}  (${fmtSize(ev.size)})`)) return;
  const idx = visibleEvents().indexOf(ev);
  stop();
  const res = await fetch("/api/delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source: ev.source, event: ev.name }) });
  const j = await res.json();
  if (!j.ok) { alert("Delete failed: " + (j.error || res.status)); return openEvent(ev); }
  state.events = state.events.filter(e => e !== ev);
  const next = visibleEvents();
  openEvent(next[Math.min(idx, next.length - 1)]);
}

export function handleKey(e) {
  if (!cur) return;
  if (e.key === " ") { e.preventDefault(); togglePlay(); }
  else if (e.key === "ArrowRight") { e.preventDefault(); seekGlobal(globalTime() + 5); }
  else if (e.key === "ArrowLeft") { e.preventDefault(); seekGlobal(globalTime() - 5); }
  else if (e.key === ".") step(1);
  else if (e.key === ",") step(-1);
  else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); deleteCurrent(); }
  else if (e.key >= "1" && e.key <= "6") toggleSolo(CAMS[+e.key - 1][0]);
  else if (e.key === "Escape" && cur.solo) toggleSolo(cur.solo);
  else if (e.key === "m") toggleFollowMap();
  else if (e.key === "v") togglePano();
}
