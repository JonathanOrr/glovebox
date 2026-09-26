// The map view: every event's GPS trail on a dark vector map (MapLibre +
// OpenFreeMap); click a trail to play the clip from that spot.
import { $, esc, parseTs, evKey, eventStart, placeName, category } from "./util.js";
import { state, visibleEvents } from "./state.js";
import { renderList, setView } from "./app.js";

const TRAIL_COLORS = ["#4aa3ff", "#ff7a59", "#35c46a", "#c678dd", "#ffb020", "#2ec4b6", "#ff5d8f", "#a3e635"];
// Speed colour ramp (km/h), green = slow → red = fast.
export const SPEED_STOPS = [[0, "#4ade80"], [40, "#a3e635"], [60, "#facc15"], [80, "#fb923c"], [100, "#ef4444"]];
const tracks = {};  // evKey -> [[lat, lon, t, speed_mps], ...]; kept across view switches

// GPS trail for an event (cached); [] if the clips have no GPS.
export async function fetchTrack(e) {
  if (!tracks[evKey(e)]) {
    try {
      const r = await fetch(`/api/track?source=${e.source}&event=${encodeURIComponent(e.name)}`);
      tracks[evKey(e)] = (await r.json()).points || [];
    } catch { tracks[evKey(e)] = []; }
  }
  return tracks[evKey(e)];
}

// One short line per pair of points so each can carry its own speed colour;
// skips across GPS gaps so we don't draw straight jumps.
export function trailSegments(pts, props = {}) {
  const out = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    if (b[2] - a[2] > 10) continue;
    out.push({ type: "Feature", properties: { ...props, kmh: (a[3] + b[3]) / 2 * 3.6 },
      geometry: { type: "LineString", coordinates: [[a[1], a[0]], [b[1], b[0]]] } });
  }
  return out;
}
export const speedColor = () => ["interpolate", ["linear"], ["get", "kmh"], ...SPEED_STOPS.flat()];
let mapState = null, mapLibReady = null;
let colorMode = "speed";
try { colorMode = localStorage.getItem("mapColor") || "speed"; } catch {}

export function loadMapLib() {
  const base = "https://cdn.jsdelivr.net/npm/maplibre-gl@5.24.0/dist/";
  return mapLibReady ||= new Promise((resolve, reject) => {
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = base + "maplibre-gl.css";
    document.head.appendChild(css);
    const js = document.createElement("script");
    js.src = base + "maplibre-gl.js";
    js.onload = resolve;
    js.onerror = () => { mapLibReady = null; reject(); };
    document.head.appendChild(js);
  });
}

// Dark slate style in the spirit of Apple Maps' dark mode: flat muted land,
// navy water, purple-tinted towns, thin light roads, dark 3D buildings up close.
export function mapStyle() {
  const C = {
    land: "#2c3242", wood: "#2b3834", grass: "#2e3838", urban: "#383a58", water: "#131b30",
    road: "#474d66", roadMajor: "#5a6182", rail: "#3a3f52", building: "#2a2f3e", extrude: "#23252e",
    label: "#c3c8d6", labelDim: "#8a90a6", halo: "#1c2030", waterLabel: "#5d6f9c",
  };
  const w = (a, b) => ["interpolate", ["exponential", 1.6], ["zoom"], 8, a, 18, b];
  const road = (id, classes, color, width, minzoom = 0) => ({
    id, type: "line", source: "omt", "source-layer": "transportation", minzoom,
    filter: ["all", ["in", ["get", "class"], ["literal", classes]], ["!=", ["get", "brunnel"], "tunnel"]],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": color, "line-width": width },
  });
  return {
    version: 8,
    glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
    sources: { omt: { type: "vector", url: "https://tiles.openfreemap.org/planet" } },
    layers: [
      { id: "bg", type: "background", paint: { "background-color": C.land } },
      { id: "wood", type: "fill", source: "omt", "source-layer": "landcover",
        filter: ["in", ["get", "class"], ["literal", ["wood", "forest"]]], paint: { "fill-color": C.wood, "fill-opacity": 0.7 } },
      { id: "grass", type: "fill", source: "omt", "source-layer": "landcover",
        filter: ["in", ["get", "class"], ["literal", ["grass", "farmland", "scrub"]]], paint: { "fill-color": C.grass, "fill-opacity": 0.5 } },
      { id: "urban", type: "fill", source: "omt", "source-layer": "landuse",
        filter: ["in", ["get", "class"], ["literal", ["residential", "suburb", "neighbourhood", "commercial", "retail", "industrial"]]],
        paint: { "fill-color": C.urban, "fill-opacity": ["interpolate", ["linear"], ["zoom"], 6, 0.8, 14, 0.35] } },
      { id: "park", type: "fill", source: "omt", "source-layer": "park", paint: { "fill-color": C.wood, "fill-opacity": 0.6 } },
      { id: "water", type: "fill", source: "omt", "source-layer": "water", paint: { "fill-color": C.water } },
      { id: "waterway", type: "line", source: "omt", "source-layer": "waterway",
        paint: { "line-color": C.water, "line-width": w(0.5, 4) } },
      { id: "aeroway", type: "line", source: "omt", "source-layer": "aeroway", minzoom: 11,
        paint: { "line-color": C.road, "line-width": w(1, 30) } },
      { id: "building", type: "fill", source: "omt", "source-layer": "building", minzoom: 13, maxzoom: 15,
        paint: { "fill-color": C.building } },
      { id: "rail", type: "line", source: "omt", "source-layer": "transportation", minzoom: 11,
        filter: ["in", ["get", "class"], ["literal", ["rail", "transit"]]],
        paint: { "line-color": C.rail, "line-width": w(0.5, 2), "line-dasharray": [3, 3] } },
      road("road-minor", ["minor", "service", "track"], C.road, w(0.2, 5), 13),
      road("road-tertiary", ["tertiary", "secondary"], C.road, w(0.5, 9), 9),
      road("road-primary", ["primary", "trunk"], C.roadMajor, w(0.8, 14), 6),
      road("road-motorway", ["motorway"], C.roadMajor, w(1, 16), 4),
      { id: "building-3d", type: "fill-extrusion", source: "omt", "source-layer": "building", minzoom: 15,
        paint: {
          "fill-extrusion-color": C.extrude,
          "fill-extrusion-height": ["coalesce", ["get", "render_height"], 6],
          "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0],
          "fill-extrusion-opacity": 0.9,
        } },
      { id: "water-name", type: "symbol", source: "omt", "source-layer": "water_name",
        layout: { "text-field": ["get", "name:latin"], "text-font": ["Noto Sans Italic"], "text-size": 12 },
        paint: { "text-color": C.waterLabel, "text-halo-color": C.halo, "text-halo-width": 1 } },
      { id: "road-name", type: "symbol", source: "omt", "source-layer": "transportation_name", minzoom: 15,
        layout: { "symbol-placement": "line", "text-field": ["get", "name:latin"], "text-font": ["Noto Sans Regular"], "text-size": 11 },
        paint: { "text-color": C.labelDim, "text-halo-color": C.halo, "text-halo-width": 1.2 } },
      { id: "place", type: "symbol", source: "omt", "source-layer": "place",
        filter: ["in", ["get", "class"], ["literal", ["city", "town", "suburb", "village"]]],
        layout: {
          "text-field": ["get", "name:latin"], "text-font": ["Noto Sans Regular"],
          "text-size": ["match", ["get", "class"], "city", 15, "town", 13, 12],
        },
        paint: { "text-color": C.label, "text-halo-color": C.halo, "text-halo-width": 1.2 } },
    ],
  };
}

const eventLabel = e => {
  const d = parseTs(e.name);
  const when = d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) + " " +
    d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return `<b>${esc(when)}</b> · ${esc(category(e))}<br><span>${esc(placeName(e))}</span>`;
};
const trailColor = e => TRAIL_COLORS[state.events.indexOf(e) % TRAIL_COLORS.length];

export async function show() {
  history.replaceState(null, "", "#map");
  $("#main").innerHTML = `<div id="map"></div><div class="map-status" id="mapStatus">Loading map…</div>
    <div class="map-ctl" id="mapCtl">
      <div class="seg"><button data-c="speed">Speed</button><button data-c="trip">Trip</button></div>
      <div class="legend" id="mapLegend"></div>
    </div>`;
  try { await loadMapLib(); }
  catch { $("#main").innerHTML = `<div class="empty">Couldn't load the map library — it needs an internet connection.</div>`; return; }
  if (state.view !== "map") return;

  const prev = mapState;
  const map = new maplibregl.Map({
    container: "map", style: mapStyle(), attributionControl: { compact: true },
    center: prev?.saved?.center || [144.96, -37.81], zoom: prev?.saved?.zoom ?? 10,
    pitch: prev?.saved?.pitch || 0, bearing: prev?.saved?.bearing || 0, maxPitch: 70,
    // Rotate by horizontal drag distance everywhere; the default steers around the
    // map centre, which makes rotation crawl near the left/right edges.
    aroundCenter: false,
  });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
  const st = mapState = { map, focused: prev?.focused || null, hover: null, saved: prev?.saved, touched: !!prev?.saved, popup: null };
  const touch = () => st.touched = true;
  ["dragstart", "wheel", "pitchstart", "rotatestart"].forEach(t => map.on(t, e => e.originalEvent && touch()));
  map.on("moveend", () => st.saved = { center: map.getCenter(), zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing() });

  $("#mapCtl").querySelectorAll("[data-c]").forEach(b => b.onclick = () => {
    colorMode = b.dataset.c;
    try { localStorage.setItem("mapColor", colorMode); } catch {}
    applyTrailPaint();
  });

  await new Promise(r => map.once("load", r));
  if (st.map !== map) return;
  // tolerance 0: the trails are ~1 s pieces; default simplification drops the
  // shortest ones when zoomed out and the lines look dashed.
  map.addSource("trails", { type: "geojson", tolerance: 0, data: { type: "FeatureCollection", features: [] } });
  map.addSource("marks", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({ id: "trail-glow", type: "line", source: "trails", layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-width": ["interpolate", ["linear"], ["zoom"], 8, 6, 16, 16], "line-blur": 6, "line-opacity": 0 } });
  map.addLayer({ id: "trails", type: "line", source: "trails", layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-width": ["interpolate", ["linear"], ["zoom"], 8, 1.8, 16, 4.5] } });
  map.addLayer({ id: "marks", type: "circle", source: "marks",
    paint: {
      "circle-radius": ["case", ["get", "approx"], 8, 5],
      "circle-color": ["get", "color"], "circle-opacity": ["case", ["get", "approx"], 0.15, 1],
      "circle-stroke-color": ["case", ["get", "approx"], ["get", "color"], "#ffffff"], "circle-stroke-width": 1.5,
    } });
  applyTrailPaint();

  map.on("mousemove", "trails", e => setHover(state.events.find(ev => evKey(ev) === e.features[0].properties.key), e.lngLat));
  map.on("mousemove", "marks", e => setHover(state.events.find(ev => evKey(ev) === e.features[0].properties.key), e.lngLat));
  map.on("mouseleave", "trails", () => setHover(null));
  map.on("mouseleave", "marks", () => setHover(null));
  map.on("click", onMapClick);

  if (!st.saved) {
    // Rough initial view from each event's saved location until trails arrive.
    const b = new maplibregl.LngLatBounds();
    state.events.forEach(e => +e.info.est_lat && b.extend([+e.info.est_lon, +e.info.est_lat]));
    if (!b.isEmpty()) map.fitBounds(b, { padding: 60, maxZoom: 11, duration: 0 });
  }

  refreshTrails();
  const todo = state.events.filter(e => !tracks[evKey(e)]);
  let done = state.events.length - todo.length;
  const status = () => $("#mapStatus") && ($("#mapStatus").textContent = done < state.events.length ? `Reading GPS trails ${done}/${state.events.length}…` : "");
  status();
  const worker = async () => {
    while (todo.length) {
      await fetchTrack(todo.shift());
      done++;
      if (st.map !== map) return;
      refreshTrails();
      status();
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  if (st.map !== map) return;
  status();
  if (st.focused) focusOnMap(st.focused, !st.touched);
  else if (!st.touched) fitAll();
}

// Frame the area most drives are in: events within ~100 km of the median
// location (road trips far away are still one click away in the list).
function fitAll() {
  const evs = visibleEvents().filter(e => tracks[evKey(e)]?.length);
  if (!evs.length) return;
  const mid = a => a.sort((x, y) => x - y)[a.length >> 1];
  const lat = mid(evs.map(e => tracks[evKey(e)][0][0])), lon = mid(evs.map(e => tracks[evKey(e)][0][1]));
  const near = e => { const p = tracks[evKey(e)][0]; return Math.hypot(p[0] - lat, (p[1] - lon) * Math.cos(lat * Math.PI / 180)) < 0.9; };
  const b = new maplibregl.LngLatBounds();
  evs.filter(near).forEach(e => tracks[evKey(e)].forEach(p => b.extend([p[1], p[0]])));
  if (!b.isEmpty()) mapState.map.fitBounds(b, { padding: 40, duration: 0 });
}

// Rebuild the trail/marker sources from loaded tracks (visible events only).
export function refreshTrails() {
  const map = mapState?.map;
  if (!map?.getSource("trails")) return;
  const trails = [], marks = [];
  visibleEvents().forEach(e => {
    const pts = tracks[evKey(e)];
    if (!pts) return;
    const key = evKey(e), color = trailColor(e);
    if (!pts.length) {
      // No GPS in the video (e.g. older clips): fall back to the car's saved location.
      if (+e.info.est_lat) marks.push({ type: "Feature", properties: { key, color, approx: true },
        geometry: { type: "Point", coordinates: [+e.info.est_lon, +e.info.est_lat] } });
      return;
    }
    trails.push(...trailSegments(pts, { key, color }));
    if (e.info.timestamp) {
      const trig = (new Date(e.info.timestamp) - eventStart(e)) / 1000;
      const p = pts.reduce((x, y) => Math.abs(y[2] - trig) < Math.abs(x[2] - trig) ? y : x);
      marks.push({ type: "Feature", properties: { key, color, approx: false }, geometry: { type: "Point", coordinates: [p[1], p[0]] } });
    }
  });
  map.getSource("trails").setData({ type: "FeatureCollection", features: trails });
  map.getSource("marks").setData({ type: "FeatureCollection", features: marks });
}

// Colour (speed ramp or per-trip) and emphasis for the focused/hovered trail.
function applyTrailPaint() {
  const map = mapState?.map;
  $("#mapCtl")?.querySelectorAll("[data-c]").forEach(b => b.classList.toggle("on", b.dataset.c === colorMode));
  const legend = $("#mapLegend");
  if (legend) legend.innerHTML = colorMode === "speed"
    ? `<div class="ramp" style="background:linear-gradient(90deg,${SPEED_STOPS.map(s => s[1]).join(",")})"></div>
       <div class="ramp-l"><span>0</span><span>${state.units === "mph" ? "30" : "50"}</span><span>${state.units === "mph" ? "60+" : "100+"} ${state.units}</span></div>`
    : `<div class="ramp-l"><span>Each trip has its own colour</span></div>`;
  if (!map?.getLayer("trails")) return;
  const color = colorMode === "speed"
    ? speedColor()
    : ["get", "color"];
  const hl = [mapState.focused, mapState.hover].filter(Boolean).map(evKey);
  const isHl = ["in", ["get", "key"], ["literal", hl]];
  map.setPaintProperty("trails", "line-color", color);
  map.setPaintProperty("trails", "line-opacity", hl.length ? ["case", isHl, 1, 0.3] : 0.9);
  map.setPaintProperty("trails", "line-width", ["interpolate", ["linear"], ["zoom"],
    8, hl.length ? ["case", isHl, 3.5, 1.5] : 1.8, 16, hl.length ? ["case", isHl, 8, 3.5] : 4.5]);
  map.setPaintProperty("trail-glow", "line-color", colorMode === "speed" ? "#ffffff" : ["get", "color"]);
  map.setPaintProperty("trail-glow", "line-opacity", hl.length ? ["case", isHl, 0.35, 0] : 0);
  map.setPaintProperty("marks", "circle-opacity", hl.length ? ["case", isHl, ["case", ["get", "approx"], 0.25, 1], 0.2] : ["case", ["get", "approx"], 0.15, 1]);
  map.setPaintProperty("marks", "circle-stroke-opacity", hl.length ? ["case", isHl, 1, 0.3] : 1);
}

let hoverTip = null;
function setHover(e, lngLat) {
  if (!mapState?.map) return;
  mapState.map.getCanvas().style.cursor = e ? "pointer" : "";
  if (mapState.hover !== e) { mapState.hover = e; applyTrailPaint(); }
  if (!e) { hoverTip?.remove(); hoverTip = null; return; }
  if (!lngLat) return;
  hoverTip ||= new maplibregl.Popup({ closeButton: false, closeOnClick: false, className: "tip", offset: 12 });
  hoverTip.setLngLat(lngLat).setHTML(eventLabel(e)).addTo(mapState.map);
}

// Called from the sidebar list (hover in/out).
export function highlightTrail(e, on) {
  if (!mapState?.map) return;
  mapState.hover = on ? e : null;
  applyTrailPaint();
}

function popupRow(e, t) {
  const at = t === undefined ? "" : new Date(eventStart(e).getTime() + t * 1000)
    .toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return `<div class="pop-row"><i class="sw" style="background:${trailColor(e)}"></i>
    <div class="txt">${eventLabel(e)}${at ? `<br><span>Here at ${esc(at)}</span>` : ""}</div>
    <button data-k="${esc(evKey(e))}" data-t="${t === undefined ? "" : Math.max(0, t - 3).toFixed(1)}">▶ Play</button></div>`;
}

function openPopup(lngLat, html) {
  const st = mapState;
  st.popup?.remove();
  hoverTip?.remove(); hoverTip = null;
  st.popup = new maplibregl.Popup({ maxWidth: "360px", offset: 10 }).setLngLat(lngLat).setHTML(html).addTo(st.map);
  st.popup.getElement().querySelectorAll("button[data-k]").forEach(b => b.onclick = () => {
    const ev = state.events.find(e => evKey(e) === b.dataset.k);
    setView("player", ev, b.dataset.t === "" ? undefined : +b.dataset.t);
  });
}

export function focusOnMap(e, fit = true) {
  if (!e || !mapState) return;
  mapState.focused = e;
  applyTrailPaint();
  renderList();
  $(".ev.sel")?.scrollIntoView({ block: "nearest" });
  const map = mapState.map, pts = tracks[evKey(e)];
  if (!map || !pts) return;
  if (!pts.length) {
    if (!+e.info.est_lat) return;
    const ll = [+e.info.est_lon, +e.info.est_lat];
    if (fit) map.easeTo({ center: ll, zoom: Math.max(map.getZoom(), 15) });
    openPopup(ll, popupRow(e));
    return;
  }
  if (fit) {
    const b = new maplibregl.LngLatBounds();
    pts.forEach(p => b.extend([p[1], p[0]]));
    map.fitBounds(b, { padding: 80, maxZoom: 17 });
  }
  openPopup([pts[0][1], pts[0][0]], popupRow(e));
}

// Click anywhere near trails: list every visible clip that passes within a few pixels.
function onMapClick(ev) {
  const map = mapState.map;
  const click = ev.point;
  const hits = [];
  visibleEvents().forEach(e => {
    const pts = tracks[evKey(e)];
    if (!pts) return;
    if (!pts.length) {
      if (!+e.info.est_lat) return;
      const q = map.project([+e.info.est_lon, +e.info.est_lat]);
      const d = Math.hypot(q.x - click.x, q.y - click.y);
      if (d < 16) hits.push({ e, t: undefined, d });
      return;
    }
    let best = Infinity, bt = 0;
    for (const p of pts) {
      const q = map.project([p[1], p[0]]);
      const d = Math.hypot(q.x - click.x, q.y - click.y);
      if (d < best) { best = d; bt = p[2]; }
    }
    if (best < 16) hits.push({ e, t: bt, d: best });
  });
  if (!hits.length) { mapState.popup?.remove(); return; }
  hits.sort((a, b) => a.d - b.d);
  const shown = hits.slice(0, 8);
  openPopup(ev.lngLat,
    `<div class="pop-h">${hits.length === 1 ? "1 clip passes here" : `${hits.length} clips pass here`}</div>` +
    shown.map(h => popupRow(h.e, h.t)).join("") +
    (hits.length > shown.length ? `<div class="pop-h">+${hits.length - shown.length} more — zoom in</div>` : ""));
}

export const focused = () => mapState?.focused || null;

export function destroy() {
  hoverTip?.remove(); hoverTip = null;
  if (mapState?.map) { mapState.map.remove(); mapState.map = null; }
}

export function handleKey(e) {
  const list = visibleEvents();
  const i = list.indexOf(mapState?.focused);
  if (e.key === "ArrowDown" || e.key === "j") { e.preventDefault(); focusOnMap(list[Math.min(i + 1, list.length - 1)]); }
  else if (e.key === "ArrowUp" || e.key === "k") { e.preventDefault(); focusOnMap(list[Math.max(i - 1, 0)]); }
  else if (e.key === "Enter" && mapState?.focused) setView("player", mapState.focused);
}
