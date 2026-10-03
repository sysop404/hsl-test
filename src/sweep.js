// Departure-time sweep: how long A -> B takes across a day, hour by hour.

import { helsinkiToMs } from './time.js';

/**
 * Drop departures that are never worth taking: X is dominated when some Y leaves
 * no earlier and arrives no later. Walk-only trips are excluded (they have no fixed departure).
 */
export function usefulDepartures(itineraries) {
  const transit = dedupe(itineraries.filter((it) => it.legs.some((l) => l.transit)));
  return transit
    .filter((x) => !transit.some((y) => y !== x && y.start >= x.start && y.end <= x.end
      && (y.start > x.start || y.end < x.end || y.key < x.key)))
    .sort((a, b) => a.start - b.start);
}

function dedupe(list) {
  const seen = new Map();
  for (const it of list) if (!seen.has(it.key)) seen.set(it.key, it);
  return [...seen.values()];
}

/**
 * Per-hour statistics.
 * - rideAvg/rideMin/rideMax: door-to-door minutes if you leave exactly in time for a departure.
 * - showUpAvg: average minutes if you leave at a random moment in the hour (includes waiting).
 * - departures: number of useful departures in the hour.
 */
export function hourlyStats(itineraries, date, fromHour, toHour) {
  const deps = usefulDepartures(itineraries);
  const rows = [];
  for (let h = fromHour; h < toHour; h++) {
    const t0 = helsinkiToMs(date, h);
    const t1 = helsinkiToMs(date, h + 1);
    const inHour = deps.filter((d) => d.start >= t0 && d.start < t1);
    const durations = inHour.map((d) => (d.end - d.start) / 60000);
    let showUp = 0;
    let samples = 0;
    for (let t = t0; t < t1; t += 60000) {
      const next = deps.filter((d) => d.start >= t);
      if (!next.length) continue;
      const arrive = Math.min(...next.map((d) => d.end));
      showUp += (arrive - t) / 60000;
      samples++;
    }
    rows.push({
      hour: h,
      departures: inHour.length,
      rideAvg: durations.length ? avg(durations) : null,
      rideMin: durations.length ? Math.min(...durations) : null,
      rideMax: durations.length ? Math.max(...durations) : null,
      // Only trust the show-up number when the next hour was searched too (or data covers the hour fully).
      showUpAvg: samples === 60 ? showUp / samples : null,
    });
  }
  return rows;
}

const avg = (a) => a.reduce((s, x) => s + x, 0) / a.length;

/**
 * Runs the sweep: one search per hour (plus one extra so the last hour's waiting time is known).
 * plan(time) must return { itineraries }. onProgress(done, total).
 */
export async function runSweep({ plan, date, fromHour, toHour, concurrency = 2, delayMs = 250, onProgress = () => {} }) {
  const hours = [];
  for (let h = fromHour; h <= toHour; h++) hours.push(h);
  const all = [];
  let done = 0;
  let idx = 0;
  const errors = [];
  async function worker() {
    while (idx < hours.length) {
      const h = hours[idx++];
      try {
        const r = await plan(helsinkiToMs(date, h));
        all.push(...r.itineraries);
      } catch (e) {
        errors.push({ hour: h, error: e });
        if (e.status === 401 || e.status === 403 || e.status === 0) throw e;
      }
      onProgress(++done, hours.length);
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return { rows: hourlyStats(all, date, fromHour, toHour), errors, itineraries: all };
}
