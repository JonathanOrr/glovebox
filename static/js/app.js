// Entry point: loads events, renders the sidebar list and filters, switches
// between the player and map views, and routes keyboard shortcuts.
import { $, esc, fmtSize, parseTs, fileUrl, evKey, placeName, category, CAT_ORDER } from "./util.js";
import { state, visibleEvents } from "./state.js";
import * as player from "./player.js";
import * as mapView from "./map.js";

async function loadEvents() {
  let data;
  try { data = await (await fetch("/api/events")).json(); }
  catch { data = { waiting: true, error: "The viewer has stopped. Start it again with the Start file." }; }
  if (data.error) {
    // No drive yet (or it was unplugged): say so, and look again every few seconds.
    $("#summary").textContent = "";
    $("#main").innerHTML = `<div class="empty"><div class="waiting">${esc(data.error)}</div></div>`;
    if (data.waiting) setTimeout(loadEvents, 3000);
    return;
  }
  state.events = data.events;
  renderList();
  $("#views").querySelectorAll("button").forEach(b => b.onclick = () => setView(b.dataset.v));
  const want = decodeURIComponent(location.hash.slice(1));
  if (want === "map") setView("map");
  else openEvent(state.events.find(e => evKey(e) === want) || visibleEvents()[0]);
}

export function renderList() {
  const { events } = state;
  const total = events.reduce((a, e) => a + e.size, 0);
  $("#summary").textContent = `${events.length} events · ${fmtSize(total)}`;
  const counts = {};
  events.forEach(e => { const c = category(e); counts[c] = (counts[c] || 0) + 1; });
  const cats = Object.keys(counts).sort((a, b) => (CAT_ORDER.indexOf(a) + 1 || 99) - (CAT_ORDER.indexOf(b) + 1 || 99));
  if (state.filter !== "all" && !counts[state.filter]) state.filter = "all";
  $("#filters").innerHTML = [["all", "All", events.length], ...cats.map(c => [c, c, counts[c]])]
    .map(([k, l, n]) => `<button data-f="${esc(k)}" class="${state.filter === k ? "on" : ""}">${esc(l)} ${n}</button>`).join("");
  $("#filters").querySelectorAll("button").forEach(b => b.onclick = () => { state.filter = b.dataset.f; renderList(); });

  const selectedEv = state.view === "map" ? mapView.focused() : player.currentEvent();
  $("#list").innerHTML = visibleEvents().map(e => {
    const d = parseTs(e.name);
    const sentry = e.source === "SentryClips";
    return `<div class="ev ${selectedEv === e ? "sel" : ""}" data-k="${esc(evKey(e))}">
      ${e.thumb ? `<img loading="lazy" src="${fileUrl(e, "thumb.png")}">` : `<div class="noimg"></div>`}
      <div style="min-width:0">
        <div class="t1">${d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}
          ${d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
          <span class="tag ${sentry ? "sentry" : ""}">${esc(category(e))}</span></div>
        <div class="t2">${esc(placeName(e) || "—")}</div>
        <div class="t3">${e.segments.length} min · ${fmtSize(e.size)}</div>
      </div></div>`;
  }).join("") || `<div class="empty" style="height:200px">No events</div>`;
  $("#list").querySelectorAll(".ev").forEach(el => {
    const ev = events.find(e => evKey(e) === el.dataset.k);
    el.onclick = () => state.view === "map" ? mapView.focusOnMap(ev) : openEvent(ev);
    el.onmouseenter = () => state.view === "map" && mapView.highlightTrail(ev, true);
    el.onmouseleave = () => state.view === "map" && mapView.highlightTrail(ev, false);
  });
  if (state.view === "map") mapView.refreshTrails();
}

// Open an event in the player (switching away from the map if needed).
// startAt is seconds from the event's first clip; omitted = just before the save point.
export function openEvent(ev, startAt) {
  if (state.view !== "player") return setView("player", ev, startAt);
  player.show(ev, startAt);
}

export function setView(v, ev, startAt) {
  state.view = v;
  $("#views").querySelectorAll("button").forEach(b => b.classList.toggle("on", b.dataset.v === v));
  if (v === "map") {
    player.stop();
    mapView.show();
  } else {
    const next = ev || mapView.focused() || state.lastEv || visibleEvents()[0];
    mapView.destroy();
    player.show(next, startAt);
  }
  renderList();
}

document.addEventListener("keydown", e => {
  if (e.target.tagName === "INPUT" || e.ctrlKey || e.metaKey || e.altKey) return;
  if (state.view === "map") return mapView.handleKey(e);
  const list = visibleEvents();
  const idx = list.indexOf(player.currentEvent());
  if (e.key === "ArrowDown" || e.key === "j") { e.preventDefault(); openEvent(list[Math.min(idx + 1, list.length - 1)]); }
  else if (e.key === "ArrowUp" || e.key === "k") { e.preventDefault(); openEvent(list[Math.max(idx - 1, 0)]); }
  else player.handleKey(e);
});

loadEvents();
