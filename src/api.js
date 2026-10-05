// Digitransit API client. Every request carries the user's own subscription key.

import { PLAN_QUERY, ROUTES_QUERY, TRIP_TIMES_QUERY, buildPlanVariables, normalizePlanResponse, toLocation, walkQuery, withoutAvoided } from './plan.js';
import { joinPolylines } from './polyline.js';
import { compactDate } from './time.js';

export const ROUTING_URL = 'https://api.digitransit.fi/routing/v2/hsl/gtfs/v1';
export const GEOCODING_URL = 'https://api.digitransit.fi/geocoding/v1';

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export function createApi({ getKey, fetchImpl = (...a) => globalThis.fetch(...a) }) {
  const routeIdCache = new Map();

  function headers(extra = {}) {
    const key = getKey();
    if (!key) throw new ApiError('No API key set. Add your Digitransit key in Settings.', 0);
    return { 'digitransit-subscription-key': key, ...extra };
  }

  async function graphql(query, variables) {
    const res = await fetchImpl(ROUTING_URL, {
      method: 'POST',
      headers: headers({ 'Content-Type': 'application/json', 'Accept-Language': 'fi' }),
      body: JSON.stringify({ query, variables }),
    });
    if (res.status === 401 || res.status === 403) throw new ApiError('Digitransit rejected the API key (check it in Settings).', res.status);
    if (res.status === 429) throw new ApiError('Too many requests to Digitransit. Wait a moment and try again.', 429);
    if (!res.ok) throw new ApiError(`Routing API error ${res.status}`, res.status);
    const body = await res.json();
    if (body.errors?.length && !body.data) throw new ApiError(body.errors.map((e) => e.message).join('; '), 200);
    return body.data;
  }

  async function geocode(path, params) {
    const url = `${GEOCODING_URL}/${path}?${new URLSearchParams(params)}`;
    const res = await fetchImpl(url, { headers: headers() });
    if (res.status === 401 || res.status === 403) throw new ApiError('Digitransit rejected the API key (check it in Settings).', res.status);
    if (!res.ok) throw new ApiError(`Geocoding error ${res.status}`, res.status);
    const body = await res.json();
    return (body.features ?? []).map((f) => ({
      name: f.properties.label ?? f.properties.name,
      lat: f.geometry.coordinates[1],
      lon: f.geometry.coordinates[0],
    }));
  }

  /** Route gtfsIds for short names like "550". Cached for the session. */
  async function routeIds(shortNames) {
    const ids = [];
    for (const name of shortNames) {
      if (!routeIdCache.has(name)) {
        const data = await graphql(ROUTES_QUERY, { name });
        routeIdCache.set(name, (data.routes ?? []).filter((r) => (r.shortName ?? '').toUpperCase() === name).map((r) => r.gtfsId));
      }
      ids.push(...routeIdCache.get(name));
    }
    return ids;
  }

  return {
    graphql,

    async plan(settings, opts) {
      const avoidRouteIds = settings.avoidLines.length ? await routeIds(settings.avoidLines) : [];
      const data = await graphql(PLAN_QUERY, buildPlanVariables(settings, { ...opts, avoidRouteIds }));
      const out = normalizePlanResponse(data);
      out.itineraries = withoutAvoided(out.itineraries, settings.avoidLines);
      return out;
    },

    /**
     * Walking routes for [{ from, to }] pairs: [{ distance (m), points } | null] in the same order.
     * Batched into a few requests with aliases.
     */
    async walks(pairs, speedKmh, batch = 12) {
      const out = [];
      for (let k = 0; k < pairs.length; k += batch) {
        const chunk = pairs.slice(k, k + batch);
        const vars = { p: { street: { walk: { speed: +(speedKmh / 3.6).toFixed(3) } } } };
        // Coordinates rather than stop ids, so the walk starts at the stop pole, not anywhere in its station.
        const at = (p) => toLocation({ name: p.name, lat: p.lat, lon: p.lon });
        chunk.forEach((pair, i) => { vars[`o${i}`] = at(pair.from); vars[`d${i}`] = at(pair.to); });
        const data = await graphql(walkQuery(chunk.length), vars);
        chunk.forEach((_, i) => {
          const node = data?.[`w${i}`]?.edges?.[0]?.node;
          const legs = node?.legs ?? [];
          out.push(legs.length ? {
            distance: legs.reduce((s, l) => s + (l.distance ?? 0), 0),
            points: joinPolylines(legs.map((l) => l.legGeometry?.points ?? '')),
          } : null);
        });
      }
      return out;
    },

    autocomplete(text, focus) {
      const p = { text, lang: 'fi', size: '8' };
      if (focus) Object.assign(p, { 'focus.point.lat': focus.lat, 'focus.point.lon': focus.lon });
      return geocode('autocomplete', p);
    },

    async reverse(lat, lon) {
      const r = await geocode('reverse', { 'point.lat': lat, 'point.lon': lon, size: '1', lang: 'fi' });
      return r[0]?.name ?? null;
    },

    /** Live estimated times for one trip: { stopId: { dep, arr } } in epoch ms. */
    async tripTimes(tripId, serviceDate) {
      const data = await graphql(TRIP_TIMES_QUERY, { id: tripId, date: compactDate(serviceDate) });
      return (data.trip?.stoptimesForDate ?? []).map((s) => ({
        stopId: s.stop.gtfsId,
        arr: (s.serviceDay + s.realtimeArrival) * 1000,
        dep: (s.serviceDay + s.realtimeDeparture) * 1000,
        realtime: !!s.realtime,
      }));
    },
  };
}
