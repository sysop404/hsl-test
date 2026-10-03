// User settings, kept in the browser's localStorage. Nothing here leaves the device
// except the API key, which is sent only to Digitransit.

const KEY = 'reittiopas-plus:settings:v1';

export const MODES = ['BUS', 'TRAM', 'SUBWAY', 'RAIL', 'FERRY'];

export const DEFAULTS = Object.freeze({
  apiKey: '',
  transferSlackMin: 3,
  walkSpeedKmh: 5,
  maxTransfers: null, // null = no limit
  wheelchair: false,
  modes: MODES.slice(),
  avoidLines: [], // short names, e.g. ["550", "M2"]
  places: [], // saved places: { name, lat, lon }
  sweepFromHour: 5,
  sweepToHour: 24,
});

function storage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function loadSettings(store = storage()) {
  let saved = {};
  try {
    saved = JSON.parse(store?.getItem(KEY) ?? '{}') ?? {};
  } catch {
    saved = {};
  }
  return sanitize({ ...DEFAULTS, ...saved });
}

export function saveSettings(settings, store = storage()) {
  try {
    store?.setItem(KEY, JSON.stringify(sanitize(settings)));
    return true;
  } catch {
    return false;
  }
}

export function sanitize(s) {
  const num = (v, lo, hi, d) => (Number.isFinite(+v) && v !== '' && v !== null ? Math.min(hi, Math.max(lo, +v)) : d);
  return {
    apiKey: String(s.apiKey ?? '').trim(),
    transferSlackMin: num(s.transferSlackMin, 0, 30, DEFAULTS.transferSlackMin),
    walkSpeedKmh: num(s.walkSpeedKmh, 2, 10, DEFAULTS.walkSpeedKmh),
    maxTransfers: s.maxTransfers === null || s.maxTransfers === '' || s.maxTransfers === undefined
      ? null : num(s.maxTransfers, 0, 6, null),
    wheelchair: !!s.wheelchair,
    modes: Array.isArray(s.modes) ? s.modes.filter((m) => MODES.includes(m)) : MODES.slice(),
    avoidLines: Array.isArray(s.avoidLines)
      ? [...new Set(s.avoidLines.map((x) => String(x).trim().toUpperCase()).filter(Boolean))] : [],
    places: Array.isArray(s.places)
      ? s.places.filter((p) => p && p.name && Number.isFinite(p.lat) && Number.isFinite(p.lon)) : [],
    sweepFromHour: num(s.sweepFromHour, 0, 23, DEFAULTS.sweepFromHour),
    sweepToHour: num(s.sweepToHour, 1, 28, DEFAULTS.sweepToHour),
  };
}

/** Settings as a shareable string, without the API key. */
export function exportSettings(settings) {
  const { apiKey, ...rest } = sanitize(settings);
  return base64url(JSON.stringify(rest));
}

/** Merge an exported string into current settings (keeps the current API key). */
export function importSettings(current, encoded) {
  const data = JSON.parse(unbase64url(encoded));
  return sanitize({ ...current, ...data, apiKey: current.apiKey });
}

function base64url(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unbase64url(s) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}
