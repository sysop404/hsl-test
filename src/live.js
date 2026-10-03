// Live vehicle positions from HSL's high-frequency positioning (HFP) feed over MQTT.
// No API key needed: wss://mqtt.hsl.fi is open.

import { secToHfpStart } from './time.js';

export const HFP_URL = 'wss://mqtt.hsl.fi:443/';

/** HFP topic that matches the vehicle running this leg's trip. */
export function legTopic(leg) {
  if (!leg.transit || !leg.route?.id || !leg.trip) return null;
  const route = leg.route.id.replace(/^HSL:/, '');
  const dir = leg.trip.directionId === null || leg.trip.directionId === undefined ? '+' : String(Number(leg.trip.directionId) + 1);
  const start = leg.trip.startSec === null ? '+' : secToHfpStart(leg.trip.startSec);
  return `/hfp/v2/journey/ongoing/vp/+/+/+/${route}/${dir}/+/${start}/#`;
}

/** Parse an HFP vehicle-position message into { id, lat, lon, heading, speed, delaySec, line, start }. */
export function parseVp(topic, payload) {
  let msg;
  try {
    msg = JSON.parse(typeof payload === 'string' ? payload : new TextDecoder().decode(payload));
  } catch {
    return null;
  }
  const vp = msg.VP;
  if (!vp || vp.lat === null || vp.long === null || vp.lat === undefined) return null;
  const parts = topic.split('/');
  return {
    id: `${parts[7]}/${parts[8]}`, // operator/vehicle
    lat: vp.lat,
    lon: vp.long,
    heading: vp.hdg ?? null,
    speed: vp.spd ?? null,
    // HFP "dl" is seconds ahead of schedule; flip so positive means late.
    delaySec: typeof vp.dl === 'number' ? -vp.dl : null,
    line: vp.desi ?? '',
    start: vp.start ?? '',
    ts: vp.tst ? Date.parse(vp.tst) : Date.now(),
  };
}

/**
 * Tracks vehicles for a set of legs. onUpdate(legIndex, vehicle) is called per position.
 * Returns { setLegs(legs), close() }.
 */
export function createLiveTracker({ onUpdate, onStatus = () => {}, mqttLib = globalThis.mqtt }) {
  let client = null;
  let subs = new Map(); // topic -> legIndex[]

  function ensureClient() {
    if (client || !mqttLib) return client;
    client = mqttLib.connect(HFP_URL, { reconnectPeriod: 5000, connectTimeout: 10000 });
    client.on('connect', () => {
      onStatus('connected');
      for (const t of subs.keys()) client.subscribe(t);
    });
    client.on('reconnect', () => onStatus('reconnecting'));
    client.on('error', () => onStatus('error'));
    client.on('message', (topic, payload) => {
      const v = parseVp(topic, payload);
      if (!v) return;
      for (const [pattern, legIdx] of subs) {
        if (topicMatches(pattern, topic)) for (const i of legIdx) onUpdate(i, v);
      }
    });
    return client;
  }

  return {
    setLegs(legs) {
      const next = new Map();
      legs.forEach((leg, i) => {
        const t = legTopic(leg);
        if (!t) return;
        if (!next.has(t)) next.set(t, []);
        next.get(t).push(i);
      });
      const c = ensureClient();
      if (c) {
        for (const t of subs.keys()) if (!next.has(t)) c.unsubscribe(t);
        for (const t of next.keys()) if (!subs.has(t) && c.connected) c.subscribe(t);
      }
      subs = next;
      if (!c) onStatus('unavailable');
    },
    close() {
      client?.end(true);
      client = null;
      subs = new Map();
    },
  };
}

/** MQTT wildcard match (+ and #). */
export function topicMatches(pattern, topic) {
  const p = pattern.split('/');
  const t = topic.split('/');
  for (let i = 0; i < p.length; i++) {
    if (p[i] === '#') return true;
    if (i >= t.length) return false;
    if (p[i] !== '+' && p[i] !== t[i]) return false;
  }
  return p.length === t.length;
}
