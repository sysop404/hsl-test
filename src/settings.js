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
  // Exercise mode: walk part of the trip on purpose.
  exercise: Object.freeze({
    enabled: false,
    where: 'last', // 'last' = get off early near the destination, 'first' = board later near the origin
    minM: 800,
    maxM: 1500,
    speedKmh: 6, // only for the exercise walk; other walks use walkSpeedKmh
    useMeasured: true, // use the learned exercise pace once there are enough walks
  }),
  weightKg: null, // for the calorie estimate
  heightCm: null,
  trackPace: true, // GPS pace and ETA on walks during a trip
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
    exercise: sanitizeExercise(s.exercise),
    weightKg: s.weightKg === null || s.weightKg === '' || s.weightKg === undefined ? null : num(s.weightKg, 25, 250, null),
    heightCm: s.heightCm === null || s.heightCm === '' || s.heightCm === undefined ? null : num(s.heightCm, 100, 230, null),
    trackPace: s.trackPace === undefined ? DEFAULTS.trackPace : !!s.trackPace,
  };
}

function sanitizeExercise(e) {
  const d = DEFAULTS.exercise;
  e = e && typeof e === 'object' ? e : {};
  const num = (v, lo, hi, def) => (Number.isFinite(+v) && v !== '' && v !== null ? Math.min(hi, Math.max(lo, +v)) : def);
  const minM = Math.round(num(e.minM, 100, 10000, d.minM));
  const maxM = Math.round(num(e.maxM, 100, 15000, d.maxM));
  return {
    enabled: !!e.enabled,
    where: e.where === 'first' ? 'first' : 'last',
    minM: Math.min(minM, maxM),
    maxM: Math.max(minM, maxM),
    speedKmh: num(e.speedKmh, 2, 10, d.speedKmh),
    useMeasured: e.useMeasured === undefined ? d.useMeasured : !!e.useMeasured,
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
