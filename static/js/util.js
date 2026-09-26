// Small shared helpers: DOM lookup, formatting, and naming events.

export const $ = (s, r = document) => r.querySelector(s);
export const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
export const fmtSize = b => b > 1e9 ? (b / 1e9).toFixed(1) + " GB" : (b / 1e6).toFixed(0) + " MB";
export const fmtT = s => { s = Math.max(0, s); const m = Math.floor(s / 60); return m + ":" + String(Math.floor(s % 60)).padStart(2, "0"); };
// TeslaCam timestamps look like 2026-07-23_21-26-15 (local time).
export const parseTs = ts => { const [d, t] = ts.split("_"); return new Date(d + "T" + t.replace(/-/g, ":")); };
export const fileUrl = (ev, fn) => `/file/${ev.source}/${encodeURIComponent(ev.name)}/${encodeURIComponent(fn)}`;

// The six recorded cameras, in grid order (keys match the clip filenames).
export const CAMS = [
  ["left_pillar", "Left pillar"], ["front", "Front"], ["right_pillar", "Right pillar"],
  ["left_repeater", "Left repeater"], ["back", "Rear"], ["right_repeater", "Right repeater"],
];

export const evKey = e => e.source + "/" + e.name;
// When the event's first clip starts (from the server's clip layout).
export const eventStart = e => e.t0 ? new Date(e.t0) : parseTs(e.name);
export const placeName = e => [e.info.street, e.info.city].filter(Boolean).join(", ");

export function reasonLabel(r) {
  if (!r) return "";
  if (r.startsWith("sentry")) return "Sentry";
  if (r.includes("honk")) return "Honk";
  if (r.includes("voice")) return "Voice";
  if (r.includes("dashcam")) return "Saved";
  return r.replace(/_/g, " ");
}

export const CAT_ORDER = ["Saved", "Voice", "Honk", "Sentry"];
export const category = e => e.source === "SentryClips" ? "Sentry" : reasonLabel(e.info.reason) || "Saved";
