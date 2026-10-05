// Walking pace from GPS: live speed and ETA along the walk you're on, and a learned average
// speed kept in the browser.
//
// How the live estimate works:
// 1. Each GPS fix is projected onto the planned walking path, giving "metres along the route" (s).
//    Sideways GPS noise disappears, and the s values can't wander off down another street.
//    Fixes with poor accuracy, or implying a jump faster than a sprint, are dropped.
// 2. Speed is the slope of a weighted least-squares line through (time, s), each fix weighted by
//    1 / accuracy² and faded out exponentially with age (time constant 60 s). Summing fix-to-fix distances would add the GPS jitter to
//    the distance and overstate speed; a fitted slope averages it out.
// 3. That slope has an uncertainty (from the scatter around the line). It is combined with your
//    learned average pace (the prior) by inverse-variance weighting, so a few noisy fixes lean on
//    your usual pace and a steady minute of good fixes trusts the live speed.
// 4. ETA = position on the fitted line now + remaining path ÷ combined speed.

import { decodePolyline } from './polyline.js';
import { cumulative, projectOnPath } from './geo.js';

// Older fixes fade out with this time constant (and are dropped after 3×). Tested on simulated
// walks with correlated GPS noise: 60 s gave the best ETA without being slow to follow a change of pace.
const TAU_MS = 60_000;
const MAX_ACCURACY_M = 40;
const MAX_SPEED_MS = 4; // faster than this between fixes is a GPS jump, not walking

/**
 * path: encoded polyline or [[lat, lon], ...] of the walk.
 * prior: { mean, sd } in m/s (see pacePrior()).
 */
export function createPaceTracker({ path, prior }) {
  const pts = typeof path === 'string' ? decodePolyline(path) : path;
  const cum = cumulative(pts);
  const length = cum[cum.length - 1] ?? 0;
  const fixes = []; // { t, s, acc, offset }

  function addFix({ lat, lon, accuracy = 20, t = Date.now() }) {
    if (!(accuracy <= MAX_ACCURACY_M) || !pts.length) return false;
    const last = fixes[fixes.length - 1];
    if (last && t <= last.t) return false;
    const range = last ? { sMin: last.s - 60, sMax: last.s + 250 } : {};
    const pr = projectOnPath(pts, { lat, lon }, { cum, ...range });
    if (last) {
      const dt = (t - last.t) / 1000;
      if (Math.abs(pr.s - last.s) - (accuracy + last.acc) > MAX_SPEED_MS * dt) return false;
    }
    fixes.push({ t, s: pr.s, acc: Math.max(3, accuracy), offset: pr.offset });
    return true;
  }

  /** Weighted least-squares fit of s against t, recent fixes counting most. */
  function fit() {
    const tEnd = fixes[fixes.length - 1]?.t;
    const win = fixes.filter((f) => f.t >= tEnd - 3 * TAU_MS);
    const wt = (f) => Math.exp(-(tEnd - f.t) / TAU_MS) / f.acc ** 2;
    if (win.length < 3 || tEnd - win[0].t < 10_000) return null;
    let sw = 0; let st = 0; let ss = 0;
    for (const f of win) { const w = wt(f); sw += w; st += w * (f.t - tEnd) / 1000; ss += w * f.s; }
    const tm = st / sw;
    const sm = ss / sw;
    let sxx = 0; let sxy = 0;
    for (const f of win) {
      const w = wt(f);
      const x = (f.t - tEnd) / 1000 - tm;
      sxx += w * x * x;
      sxy += w * x * (f.s - sm);
    }
    if (!sxx) return null;
    const slope = sxy / sxx;
    const res = win.map((f) => f.s - sm - slope * ((f.t - tEnd) / 1000 - tm));
    // Slope variance by the sandwich formula, which holds for any weights (these mix GPS precision
    // with age). GPS errors are also correlated from one fix to the next, so n fixes carry less
    // information than n independent ones: measure the lag-1 autocorrelation of the residuals and
    // widen by (1 + ρ) / (1 − ρ), the usual effective-sample-size correction for AR(1) noise.
    let meat = 0;
    let num = 0;
    let den = 0;
    win.forEach((f, i) => {
      const x = (f.t - tEnd) / 1000 - tm;
      meat += (wt(f) * x * res[i]) ** 2;
      den += res[i] ** 2;
      if (i) num += res[i] * res[i - 1];
    });
    const rho = den ? Math.min(0.95, Math.max(0, num / den)) : 0;
    const varSlope = (meat / sxx ** 2) * (win.length / Math.max(1, win.length - 2)) * ((1 + rho) / (1 - rho));
    return { slope, sd: Math.max(0.05, Math.sqrt(varSlope)), sNow: sm + slope * (0 - tm), tEnd, n: win.length };
  }

  return {
    length,
    get fixes() { return fixes.length; },
    addFix,

    /** { speed (m/s, combined), live (m/s), liveSd, s, remaining (m), eta (ms) } or null. */
    estimate() {
      const f = fit();
      if (!f) return null;
      const live = Math.max(0, f.slope);
      const wp = 1 / prior.sd ** 2;
      const wl = 1 / f.sd ** 2;
      const speed = Math.min(3, Math.max(0.3, (prior.mean * wp + live * wl) / (wp + wl)));
      const s = Math.min(length, Math.max(0, f.sNow));
      const remaining = Math.max(0, length - s);
      return {
        speed, live, liveSd: f.sd, s, remaining,
        eta: f.tEnd + (remaining / speed) * 1000,
        offRoute: fixes[fixes.length - 1].offset > Math.max(50, 2 * fixes[fixes.length - 1].acc),
      };
    },

    /**
     * Average speed over the whole walk for the learned pace, from the moment you started moving
     * to arrival (waits at lights included: that's what an ETA has to account for).
     * null when the walk was too short or too sparsely tracked to be worth learning from.
     */
    segmentSpeed() {
      if (fixes.length < 5) return null;
      const s0 = fixes[0].s;
      let a = 0;
      while (a + 1 < fixes.length && fixes[a + 1].s <= s0 + 20) a++;
      let b = fixes.findIndex((f) => f.s >= length - 20);
      if (b < 0) b = fixes.length - 1;
      const ds = fixes[b].s - fixes[a].s;
      const dt = (fixes[b].t - fixes[a].t) / 1000;
      if (ds < 150 || dt < 90) return null;
      return ds / dt;
    },
  };
}

// ---------- learned pace, saved in the browser ----------

const KEY = 'reittiopas-plus:pace:v1';
const EMPTY = () => ({ walk: { n: 0, mean: 0, var: 0 }, exercise: { n: 0, mean: 0, var: 0 } });

function storage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function loadPace(store = storage()) {
  try {
    const p = JSON.parse(store?.getItem(KEY) ?? 'null');
    const ok = (x) => x && Number.isFinite(x.n) && Number.isFinite(x.mean) && Number.isFinite(x.var);
    if (p && ok(p.walk) && ok(p.exercise)) return p;
  } catch { /* fall through */ }
  return EMPTY();
}

export function savePace(stats, store = storage()) {
  try { store?.setItem(KEY, JSON.stringify(stats)); return true; } catch { return false; }
}

export function resetPace(store = storage()) {
  try { store?.removeItem(KEY); } catch { /* ignore */ }
  return EMPTY();
}

/**
 * Adds one walk's average speed (m/s) to kind ('walk' | 'exercise').
 * Exponentially weighted mean and variance: a plain average for the first 10 walks, then each new
 * walk counts 10 %, so the number follows you if your pace changes. Implausible values, and once
 * there are 3+ walks anything more than 3 standard deviations off, are ignored.
 * Returns { stats, accepted }.
 */
export function recordPace(stats, kind, speed) {
  const cur = stats[kind];
  if (!(speed >= 0.5 && speed <= 2.8)) return { stats, accepted: false };
  const sd = Math.max(0.12, Math.sqrt(cur.var));
  if (cur.n >= 3 && Math.abs(speed - cur.mean) > 3 * sd) return { stats, accepted: false };
  let next;
  if (cur.n === 0) {
    next = { n: 1, mean: speed, var: 0 };
  } else {
    const a = cur.n < 10 ? 1 / (cur.n + 1) : 0.1;
    const d = speed - cur.mean;
    next = { n: cur.n + 1, mean: cur.mean + a * d, var: (1 - a) * (cur.var + a * d * d) };
  }
  return { stats: { ...stats, [kind]: next }, accepted: true };
}

/** Learned speed in km/h, or null before `min` walks have been recorded. */
export function learnedKmh(stat, min = 1) {
  return stat.n >= min ? stat.mean * 3.6 : null;
}

/** Prior for the live estimate: the learned pace once there are 2+ walks, else the given speed. */
export function pacePrior(stat, fallbackKmh) {
  if (stat.n >= 2) return { mean: stat.mean, sd: Math.min(0.5, Math.max(0.08, Math.sqrt(stat.var))) };
  return { mean: fallbackKmh / 3.6, sd: 0.3 };
}
