# Reittiopas Plus

A browser-based HSL journey planner built on the open [Digitransit](https://digitransit.fi/en/developers/) APIs, adding what the official Reittiopas lacks:

- **Minimum transfer time** you choose (the `−`/`+` control under the search). It's sent to the router as transfer slack, so every suggested connection leaves at least that much time.
- **Day sweep**: one search per hour across a day, showing how long the trip takes if you time your departure, and how long on average if you just leave (waiting included). Tap an hour to see its routes.
- **Plan B**: "If I miss this…" under every vehicle shows the next best way on from that stop.
- **Live vehicles** on the map from HSL's real-time positioning feed.
- **Arrival timer**: press *Start trip* for a countdown while walking, waiting and riding, with the transfer time you have left, plan B ready, and the screen kept awake.
- **Settings saved in the browser** (localStorage): API key, transfer time, walking speed, max transfers, wheelchair, modes, avoided lines, saved places. *Copy settings link* moves them to another device (without the key).

No build step, no server: it's plain HTML, CSS and JavaScript modules. Leaflet and mqtt.js are vendored under `vendor/`.

## API key

1. Register at the [Digitransit API portal](https://portal-api.digitransit.fi/).
2. Subscribe to the developer product that includes the **Routing** and **Geocoding** APIs.
3. Copy the key from your **Profile** tab.
4. Open the app, press ⚙️ **Settings**, paste the key, **Save**.

The key is stored only in your browser and sent only to Digitransit. Never commit it. Type `demo` as the key to try the app with made-up data.

On iPhone, use Safari's *Share → Add to Home Screen*: otherwise Safari may clear saved settings after a week without visits.

## Run locally

```sh
npm start        # serves on http://localhost:8080
npm test         # unit tests (Node 20+)
```

## Hosting

`.github/workflows/pages.yml` runs the tests and publishes the site to GitHub Pages from the default branch. Enable it once under **Settings → Pages → Source: GitHub Actions**.

## Code map

| File | What it does |
|---|---|
| `src/api.js` | Digitransit routing (GraphQL `planConnection`) and geocoding client |
| `src/plan.js` | Builds request variables from settings, normalizes itineraries, transfer gaps |
| `src/sweep.js` | Hour-by-hour sweep and statistics |
| `src/planb.js` | Next best option after missing a leg |
| `src/timer.js` | Trip phase and countdown logic, live stop-time updates |
| `src/live.js` | HFP MQTT topics and vehicle messages (`wss://mqtt.hsl.fi`, no key) |
| `src/settings.js` | localStorage settings, export and import |
| `src/mock.js` | Fake backend for demo mode and tests |
| `src/app.js`, `src/map.js` | UI and Leaflet map |

Data © HSL / Digitransit (CC BY 4.0), map © OpenStreetMap contributors.
