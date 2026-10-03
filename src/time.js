// Time helpers. All instants are epoch milliseconds; wall-clock values are Helsinki local time.

export const TZ = 'Europe/Helsinki';

const hmFormat = new Intl.DateTimeFormat('fi-FI', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const partsFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

/** "08:05" in Helsinki time. */
export function hhmm(ms) {
  return hmFormat.format(new Date(ms)).replace('.', ':');
}

/** Helsinki wall-clock parts for an instant. */
export function helsinkiParts(ms) {
  const p = Object.fromEntries(partsFormat.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { year: +p.year, month: +p.month, day: +p.day, hour: +p.hour, minute: +p.minute, second: +p.second };
}

/** "2026-10-03" for an instant, in Helsinki time. */
export function helsinkiDate(ms) {
  const p = helsinkiParts(ms);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** Offset of Helsinki from UTC in minutes at a given instant (120 or 180). */
export function helsinkiOffsetMinutes(ms) {
  const p = helsinkiParts(ms);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
}

/** Epoch ms for a Helsinki wall-clock time on a "YYYY-MM-DD" date. Hours may exceed 23. */
export function helsinkiToMs(date, hour, minute = 0) {
  const [y, m, d] = date.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, hour, minute) - 120 * 60000;
  // Correct with the real offset at that moment (handles summer time).
  const off = helsinkiOffsetMinutes(guess);
  return Date.UTC(y, m - 1, d, hour, minute) - off * 60000;
}

/** RFC 3339 string with Helsinki offset, as the routing API expects. */
export function toOffsetDateTime(ms) {
  const p = helsinkiParts(ms);
  const off = helsinkiOffsetMinutes(ms);
  const sign = off >= 0 ? '+' : '-';
  const a = Math.abs(off);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

/** "PT3M" style ISO duration from minutes. */
export function isoMinutes(min) {
  return `PT${Math.round(min * 60)}S`;
}

/** Human duration: "45 min", "1 h 05 min". */
export function fmtDuration(sec) {
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${pad(m % 60)} min`;
}

/** Countdown text: "4:05", "1:02:10", or "now". */
export function fmtCountdown(ms) {
  if (ms <= 0) return 'now';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`;
}

/** Seconds since midnight (possibly > 24h) to "HH:mm", wrapped to 24 h like HFP does. */
export function secToHfpStart(sec) {
  const m = Math.floor(sec / 60);
  return `${pad(Math.floor(m / 60) % 24)}:${pad(m % 60)}`;
}

/** "20261003" from "2026-10-03" */
export function compactDate(date) {
  return date.replaceAll('-', '');
}

function pad(n) {
  return String(n).padStart(2, '0');
}
