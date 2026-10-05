// Small geometry helpers on [lat, lon] / { lat, lon } points. Distances are in metres.

const R = 6371e3;
const toRad = (d) => (d * Math.PI) / 180;
const ll = (p) => (Array.isArray(p) ? { lat: p[0], lon: p[1] } : p);

/** Great-circle distance between two points. */
export function haversine(a, b) {
  a = ll(a);
  b = ll(b);
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Cumulative distance along a path: [0, d01, d01 + d12, ...]. */
export function cumulative(path) {
  const out = [0];
  for (let i = 1; i < path.length; i++) out.push(out[i - 1] + haversine(path[i - 1], path[i]));
  return out;
}

/**
 * Closest point on a path to p, as distance along the path (s) and distance off it (offset).
 * Uses a flat projection around p, which is exact enough at walking scales.
 * Only segments whose start lies within [sMin, sMax] are considered, so a path that doubles back
 * can't make the position jump to the other side.
 */
export function projectOnPath(path, p, { cum = cumulative(path), sMin = -Infinity, sMax = Infinity } = {}) {
  p = ll(p);
  const kx = Math.cos(toRad(p.lat)) * toRad(1) * R;
  const ky = toRad(1) * R;
  const xy = (q) => { q = ll(q); return [(q.lon - p.lon) * kx, (q.lat - p.lat) * ky]; };
  let best = { s: 0, offset: Infinity, index: 0 };
  if (path.length === 1) return { s: 0, offset: haversine(path[0], p), index: 0 };
  for (let i = 0; i < path.length - 1; i++) {
    if (cum[i + 1] < sMin || cum[i] > sMax) continue;
    const [ax, ay] = xy(path[i]);
    const [bx, by] = xy(path[i + 1]);
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.min(1, Math.max(0, -(ax * dx + ay * dy) / len2)) : 0;
    const off = Math.hypot(ax + t * dx, ay + t * dy);
    if (off < best.offset) best = { s: cum[i] + t * (cum[i + 1] - cum[i]), offset: off, index: i };
  }
  return best;
}

/** Index of the path vertex nearest to p. */
export function nearestIndex(path, p) {
  let bi = 0;
  let bd = Infinity;
  path.forEach((q, i) => {
    const d = haversine(q, p);
    if (d < bd) { bd = d; bi = i; }
  });
  return bi;
}
