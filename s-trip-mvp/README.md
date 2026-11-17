# S Trip MVP (local test product)

Needs Node 18+. No npm install required.

1. Enable **Maps JavaScript API** on a Google Cloud project, create a key, and restrict it to `http://localhost:3000/*` (HTTP referrers). Billing must be on.
2. Seed demo data (optional): `node server.js --seed`
3. Run (macOS/Linux): `GOOGLE_MAPS_API_KEY=your_key AGENCY_TOKEN=choose-a-token node server.js`
   PowerShell: `$env:GOOGLE_MAPS_API_KEY="your_key"; $env:AGENCY_TOKEN="choose-a-token"; node server.js`
4. Public map: http://localhost:3000 · Agency dashboard: http://localhost:3000/agency.html (default token `demo-agency`).
   Optional `WEBHOOK_URL` receives a POST for every new incident.

Quick test: open two browser windows. In one, click the map, press Report incident. In the other, press "Watch this area" first, then confirm the report twice from different windows or profiles to see it become verified. Sensitive types (robbery, armed attack, protest) appear publicly only after a 20-minute hold with blurred location, or once verified. Kidnapping reports reach agencies only.

## MVP shortcuts to replace before real use
- JSON file storage (data/db.json) instead of PostgreSQL/PostGIS.
- Anonymous browser client ids and one shared agency token instead of real accounts.
- Live alerts use SSE and browser notifications (tab must be open), not FCM push.
- Hotspots use a ~1 km grid plus 1 km corridor segments, not H3.
- `data/corridor.json` waypoints are rough placeholders: replace them with your GPX survey points.
- No photos, no official-data import, no HTTPS, no CSP; get legal and Nigeria Data Protection Act review before any public pilot.
