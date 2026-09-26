// App-wide state shared by the event list, player and map.
import { category } from "./util.js";

export const state = {
  events: [],       // from /api/events
  filter: "all",    // selected category pill
  view: "player",   // "player" | "map"
  lastEv: null,     // last event opened in the player
  units: "km/h",    // "km/h" | "mph"
};
try { state.units = localStorage.getItem("units") || "km/h"; } catch {}

export const visibleEvents = () => state.events.filter(e => state.filter === "all" || category(e) === state.filter);
export const toUnit = mps => state.units === "mph" ? mps * 2.23694 : mps * 3.6;

export function toggleUnits() {
  state.units = state.units === "km/h" ? "mph" : "km/h";
  try { localStorage.setItem("units", state.units); } catch {}
}
