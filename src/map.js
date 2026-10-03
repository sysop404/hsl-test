// Leaflet map: start/destination pins, the selected route, and live vehicles.

import { decodePolyline } from './polyline.js';

const MODE_COLORS = { BUS: '#007ac9', TRAM: '#00985f', SUBWAY: '#ff6319', RAIL: '#8c4799', FERRY: '#00b9e4', WALK: '#8a94a3' };

export function modeColor(mode) {
  return MODE_COLORS[mode] ?? MODE_COLORS.BUS;
}

export function createMap(el, { onPick }) {
  const L = globalThis.L;
  const map = L.map(el, { zoomControl: true }).setView([60.1699, 24.9384], 12);
  let tiles = null;
  const routeLayer = L.layerGroup().addTo(map);
  const pinLayer = L.layerGroup().addTo(map);
  const vehicles = new Map();

  function setTiles(apiKey) {
    if (tiles) map.removeLayer(tiles);
    const useHsl = apiKey && apiKey !== 'demo';
    tiles = useHsl
      ? L.tileLayer(`https://cdn.digitransit.fi/map/v3/hsl-map/{z}/{x}/{y}${L.Browser.retina ? '@2x' : ''}.png?digitransit-subscription-key=${encodeURIComponent(apiKey)}`, {
        maxZoom: 19,
        attribution: '© <a href="https://digitransit.fi/">Digitransit</a> © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      })
      : L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      });
    tiles.addTo(map);
  }

  map.on('click', (e) => {
    const { lat, lng } = e.latlng;
    const div = document.createElement('div');
    div.className = 'pick';
    const mk = (label, which) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.style.margin = '2px';
      b.onclick = () => { map.closePopup(); onPick(which, lat, lng); };
      return b;
    };
    div.append(mk('Start here', 'from'), mk('Go here', 'to'));
    L.popup().setLatLng(e.latlng).setContent(div).openOn(map);
  });

  function pin(p, color) {
    return L.circleMarker([p.lat, p.lon], { radius: 8, color: '#fff', weight: 2, fillColor: color, fillOpacity: 1 });
  }

  return {
    leaflet: map,
    setTiles,
    setPlaces(from, to) {
      pinLayer.clearLayers();
      const pts = [];
      if (from) { pin(from, '#11804a').addTo(pinLayer); pts.push([from.lat, from.lon]); }
      if (to) { pin(to, '#c0262d').addTo(pinLayer); pts.push([to.lat, to.lon]); }
      if (pts.length === 2) map.fitBounds(pts, { padding: [40, 40], maxZoom: 15 });
      else if (pts.length === 1) map.setView(pts[0], Math.max(map.getZoom(), 14));
    },
    drawItinerary(it, { fit = true } = {}) {
      routeLayer.clearLayers();
      if (!it) return;
      const all = [];
      for (const leg of it.legs) {
        const pts = leg.points ? decodePolyline(leg.points) : [[leg.from.lat, leg.from.lon], [leg.to.lat, leg.to.lon]];
        all.push(...pts);
        L.polyline(pts, {
          color: leg.route?.color ?? modeColor(leg.mode),
          weight: leg.transit ? 6 : 4,
          dashArray: leg.transit ? null : '4 8',
          opacity: 0.9,
        }).addTo(routeLayer);
        if (leg.transit) {
          L.circleMarker([leg.from.lat, leg.from.lon], { radius: 5, color: modeColor(leg.mode), fillColor: '#fff', fillOpacity: 1, weight: 3 })
            .bindTooltip(`${leg.route?.short ?? ''} ${leg.from.name}`).addTo(routeLayer);
        }
      }
      if (fit && all.length) map.fitBounds(all, { padding: [30, 30], maxZoom: 16 });
    },
    setVehicle(key, v, { mode, label, highlight }) {
      let m = vehicles.get(key);
      const html = `<div class="veh" style="background:${modeColor(mode)};${highlight ? '' : 'opacity:.55;'}">${label}</div>`;
      if (!m) {
        m = L.marker([v.lat, v.lon], { icon: L.divIcon({ html, className: '', iconSize: [26, 26], iconAnchor: [13, 13] }), zIndexOffset: 1000 }).addTo(map);
        vehicles.set(key, m);
      } else {
        m.setLatLng([v.lat, v.lon]);
      }
      return m;
    },
    clearVehicles() {
      for (const m of vehicles.values()) map.removeLayer(m);
      vehicles.clear();
    },
    invalidate() { setTimeout(() => map.invalidateSize(), 50); },
  };
}
