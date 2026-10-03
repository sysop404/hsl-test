// Google encoded polyline decoder (used by the routing API for leg geometry).

/** Returns [[lat, lon], ...]. */
export function decodePolyline(str, precision = 5) {
  const factor = 10 ** precision;
  const out = [];
  let lat = 0;
  let lon = 0;
  let i = 0;
  while (i < str.length) {
    for (const which of [0, 1]) {
      let shift = 0;
      let result = 0;
      let byte;
      do {
        byte = str.charCodeAt(i++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (which === 0) lat += delta;
      else lon += delta;
    }
    out.push([lat / factor, lon / factor]);
  }
  return out;
}

/** Encoder, used by the mock data and tests. */
export function encodePolyline(points, precision = 5) {
  const factor = 10 ** precision;
  let out = '';
  let pLat = 0;
  let pLon = 0;
  for (const [la, lo] of points) {
    const lat = Math.round(la * factor);
    const lon = Math.round(lo * factor);
    out += encodeValue(lat - pLat) + encodeValue(lon - pLon);
    pLat = lat;
    pLon = lon;
  }
  return out;
}

function encodeValue(v) {
  let n = v < 0 ? ~(v << 1) : v << 1;
  let s = '';
  while (n >= 0x20) {
    s += String.fromCharCode((0x20 | (n & 0x1f)) + 63);
    n >>= 5;
  }
  return s + String.fromCharCode(n + 63);
}
