# Reittiopas Plus

A browser-based HSL journey planner built on the open [Digitransit](https://digitransit.fi/en/developers/) APIs, adding what the official Reittiopas lacks:

- **Minimum transfer time** you choose (the `−`/`+` control under the search). It's sent to the router as transfer slack, so every suggested connection leaves at least that much time.
- **Day sweep**: one search per hour across a day, showing how long the trip takes if you time your departure, and how long on average if you just leave (waiting included). Tap an hour to see its routes.
- **Plan B**: "If I miss this…" under every vehicle shows the next best way on from that stop.
- **Live vehicles** on the map from HSL's real-time positioning feed.
- **Earlier / later**: buttons above and below the route list page through earlier and later connections (for "arrive by" too), and the `−30 … +1 h` chips re-run the search from a shifted time.
- **Exercise mode** (🏃 under the search): walk part of the trip on purpose. *Near the destination* gets off the same vehicle early; *from the start* walks ahead and boards it a few stops later. You set the walking distance range (min–max, real street distance) and a separate exercise walking speed. The route's stops are checked against that range; if none fits, the nearest shorter and longer stops are offered. The exercise walk is drawn in pink on the map, with an estimate of calories burned from weight, height, distance and speed (Ludlow & Weyand 2016, set weight and height in Settings).
- **Arrival timer**: press *Start trip* for a countdown while walking, waiting and riding, with the transfer time you have left, plan B ready, and the screen kept awake.
  - Live times refresh every 30 s. A late vehicle doesn't change when you're told to leave: you're shown how many extra minutes you'll have at the stop. An early one moves the leave time earlier, with a banner and a vibration. Changed times show the old time struck through, and a transfer that has become too tight brings up plan B right away.
  - **Pace and ETA** (GPS, while the trip screen is open): your walking speed, when you'll reach the stop and whether you'll make it ("speed up to 6.3 km/h"). Each GPS fix is projected onto the walking route and the speed is a noise-aware fit over the last minute or two, combined with your usual pace. Finished walks are saved as your measured walking and exercise pace, which exercise mode can use for planning.
- **Settings saved in the browser** (localStorage): API key, transfer time, walking speed, max transfers, wheelchair, modes, avoided lines, saved places, exercise options, weight and height. *Copy settings link* moves them to another device (without the key). Measured pace is kept separately and stays on the device.

No build step, no server: it's plain HTML, CSS and JavaScript modules. Leaflet and mqtt.js are vendored under `vendor/`.

## API key

1. Register at the [Digitransit API portal](https://portal-api.digitransit.fi/).
2. Subscribe to the developer product that includes the **Routing** and **Geocoding** APIs.
3. Copy the key from your **Profile** tab.
4. Open the app, press ⚙️ **Settings**, paste the key, **Save**.

The key is stored only in your browser and sent only to Digitransit. Never commit it. Type `demo` as the key to try the app with made-up data (in demo trips the delays change every 45 s, so the late and early banners can be seen).

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
| `src/timer.js` | Trip phase and countdown logic, live stop-time updates, late/early notices |
| `src/exercise.js` | Exercise leave-off point selection and calorie estimate |
| `src/pace.js` | GPS pace and ETA along a walk, learned average pace |
| `src/geo.js` | Distances and projecting a point onto a path |
| `src/live.js` | HFP MQTT topics and vehicle messages (`wss://mqtt.hsl.fi`, no key) |
| `src/settings.js` | localStorage settings, export and import |
| `src/mock.js` | Fake backend for demo mode and tests |
| `src/app.js`, `src/map.js` | UI and Leaflet map |

Data © HSL / Digitransit (CC BY 4.0), map © OpenStreetMap contributors.
