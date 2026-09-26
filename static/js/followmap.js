// The follow map beside the cameras: a small navigation-style map that keeps
// the car centred and turned to its heading while the video plays.
import { loadMapLib, mapStyle, fetchTrack, trailSegments, speedColor } from "./map.js";

let fm = null;  // { map, marker, follow, headingUp, track, last }

// seek(t) is called with seconds on the event timeline when the trail is clicked.
export async function init(ev, container, seek) {
  destroy();
  const st = fm = { map: null, marker: null, follow: true, headingUp: true, track: [], last: null };
  container.innerHTML = `<div class="fm-map"></div>
    <div class="fm-ctl">
      <button data-a="orient" title="Toggle heading-up / north-up">Heading up</button>
      <button data-a="recenter" hidden>Recenter</button>
    </div>`;
  const btn = a => container.querySelector(`[data-a=${a}]`);
  btn("orient").onclick = () => {
    st.headingUp = !st.headingUp;
    btn("orient").textContent = st.headingUp ? "Heading up" : "North up";
    if (!st.headingUp) st.map?.easeTo({ bearing: 0 });
    reframe();
  };
  btn("recenter").onclick = () => { st.follow = true; btn("recenter").hidden = true; reframe(); };

  try { await loadMapLib(); }
  catch { container.innerHTML = `<div class="empty">The map needs an internet connection.</div>`; return; }
  if (fm !== st) return;

  const start = +ev.info.est_lat ? [+ev.info.est_lon, +ev.info.est_lat] : [144.96, -37.81];
  const map = st.map = new maplibregl.Map({
    container: container.querySelector(".fm-map"), style: mapStyle(), attributionControl: { compact: true },
    center: start, zoom: 16.5, pitch: 50, maxPitch: 70, aroundCenter: false,
  });
  // Dragging or rotating by hand stops following until Recenter; zooming keeps following.
  const detach = e => { if (e.originalEvent) { st.follow = false; btn("recenter").hidden = false; } };
  ["dragstart", "rotatestart"].forEach(t => map.on(t, detach));

  const car = document.createElement("div");
  car.className = "fm-car";
  car.innerHTML = `<svg viewBox="-12 -12 24 24" width="26" height="26"><path d="M0 -10 L8 9 L0 4 L-8 9 Z" fill="#3e8bff" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
  st.marker = new maplibregl.Marker({ element: car, rotationAlignment: "map", pitchAlignment: "map" }).setLngLat(start).addTo(map);

  await new Promise(r => map.once("load", r));
  if (fm !== st) return;
  st.track = await fetchTrack(ev);
  if (fm !== st) return;
  map.addSource("trail", { type: "geojson", tolerance: 0, data: { type: "FeatureCollection", features: trailSegments(st.track) } });
  map.addLayer({ id: "trail", type: "line", source: "trail", layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": speedColor(), "line-width": ["interpolate", ["linear"], ["zoom"], 12, 3, 18, 9], "line-opacity": 0.85 } });
  map.on("mouseenter", "trail", () => map.getCanvas().style.cursor = "pointer");
  map.on("mouseleave", "trail", () => map.getCanvas().style.cursor = "");
  map.on("click", "trail", e => {
    // Jump the video to the nearest trail point.
    let best = null, bd = Infinity;
    for (const p of st.track) {
      const q = map.project([p[1], p[0]]), d = Math.hypot(q.x - e.point.x, q.y - e.point.y);
      if (d < bd) { bd = d; best = p; }
    }
    if (best) { st.follow = true; btn("recenter").hidden = true; seek(best[2]); }
  });
  reframe();
}

function reframe() {
  const st = fm;
  if (!st?.map || !st.last || !st.follow) return;
  // Top padding puts the car in the lower part of the view, showing more road ahead.
  const h = st.map.getContainer().clientHeight;
  st.map.jumpTo({ center: [st.last.lon, st.last.lat], bearing: st.headingUp ? st.last.heading : st.map.getBearing(),
    padding: { top: st.headingUp ? h * 0.4 : 0, bottom: 0, left: 0, right: 0 } });
}

// Called every frame with the current telemetry sample (or null).
export function update(x) {
  if (!fm?.marker || !x?.lat || !x?.lon) return;
  if (fm.last && fm.last.lat === x.lat && fm.last.lon === x.lon && fm.last.heading === x.heading) return;
  fm.last = { lat: x.lat, lon: x.lon, heading: x.heading || 0 };
  fm.marker.setLngLat([x.lon, x.lat]).setRotation(fm.last.heading);
  reframe();
}

export function resize() { fm?.map?.resize(); }

export function destroy() {
  fm?.map?.remove();
  fm = null;
}
