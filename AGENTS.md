# Agent Notes - Zandbak Dashboard

## Project
- React/Vite dashboard for sandpit planning at schools.
- Local project path: `c:\Users\dbakkum\OneDrive - Bussola Groep BV\Documenten\VS code\Zandbakken\zandbak-dashboard`
- GitHub remote: `https://github.com/DaniBakkum/Zandbakken.git`
- Dev URL: `http://127.0.0.1:5173`
- Run commands:
  - `npm run dev -- --host 127.0.0.1`
  - `npm run lint`
  - `npm run build`

## Main Files
- `src/App.jsx`: all dashboard logic and UI.
- `src/App.css`: dashboard, map, filter, drawer, route button, and edit modal styling.
- `src/index.css`: global base styles.
- `src/data/locations.js`: fixed latitude/longitude index keyed by `School|Straatnaam|Plaats`.
- `public/planning-zandbakken.csv`: replaceable CSV source of truth.
- `vite.config.js`: includes a small devserver API for persisted row edits.
- `api/rows.js`: Vercel serverless API for persisted row edits in production.
- `vercel.json`: Vercel build settings for the Vite app.
- `data/planning-overrides.json`: server-side saved browser edits, created automatically after the first save.

## Data Model
- CSV delimiter is semicolon (`;`).
- CSV columns:
  - `School`
  - `Bestuur`
  - `Straatnaam`
  - `Plaats`
  - `m3 uit`
  - `m3 in`
  - `Materieel`
- `m3 uit` means sand to excavate.
- `m3 in` means sand to fill.
- `?`, `-`, and empty values are shown as `Onbekend` and are not parsed as numbers.
- Location keys must match exactly: `${School}|${Straatnaam}|${Plaats}`.
- If a CSV address changes, also update `src/data/locations.js` or the map marker will be missing.

## Current UX
- Desktop is used above `760px`; mobile is used at `760px` and below via `matchMedia('(max-width: 760px)')`.
- Desktop main view is a large Leaflet/OpenStreetMap map.
- Desktop location table is an expandable right-side panel opened with `Locaties (...)`.
- Mobile has a dedicated UI:
  - `Kaart` / `Locaties` segmented control.
  - Filters behind a compact `Filters` button.
  - Location list as touch-friendly cards instead of a wide table.
  - Map popups include a `Bewerken` button because mobile users cannot right-click.
- Filters are above the map:
  - Search
  - Bestuur dropdown
  - Plaats dropdown
  - Materieel compact multi-select dropdown
  - Status dropdown
- Map marker colors are based on `Materieel`:
  - `Mobiel`: blue
  - `Kraan`: orange
  - `Knijper`: purple
  - `Knikmops`: teal
  - `Onbekend`: gray
- There is no map legend by user request.
- Every popup and table row has a Google Maps route link.
- Route link text must stay white in normal, visited, hover, and active states.

## Editing Behavior
- Desktop: right-click a map marker to open the edit card.
- Mobile: tap a marker and use `Bewerken` in the popup, or use `Bewerken` on a location card.
- Editable fields:
  - School
  - Bestuur
  - Straatnaam
  - Plaats
  - `m3 uit`
  - `m3 in`
  - Materieel
  - Latitude
  - Longitude
- Materieel in the edit card is a dropdown.
- `Esc` closes the edit card.
- Clicking the overlay outside the edit card closes it.
- Local development saves are written to the Vite devserver via `PUT /api/rows`.
- Vercel production saves are handled by `api/rows.js`.
- The devserver persists saved rows in `data/planning-overrides.json`.
- On Vercel, `api/rows.js` uses Upstash Redis when either `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN` or Vercel KV-style `KV_REST_API_URL`/`KV_REST_API_TOKEN` are configured. Diagnostics also report `KV_URL`, `REDIS_URL`, and `KV_REST_API_READ_ONLY_TOKEN`.
- Without Upstash Redis, Vercel reads bundled fallback rows from `data/planning-overrides.json`; edits are kept in browser localStorage only.
- On load, the app reads `GET /api/rows`; if server rows exist, they override the CSV/fallback.
- Existing `localStorage` data under `zandbak-dashboard-rows` is used only as a fallback/migration source and is pushed to the server if no server rows exist yet.
- There is currently no export/write-back to the CSV itself.

## Important User Decisions Already Made
- KPI cards were removed.
- `?` values must not trigger `Gegevens controleren`.
- Status should only indicate missing address/location data; currently all 40 CSV rows have a matching location.
- Several addresses were corrected in the CSV and location index:
  - `de Piramide`: `Boschjesstraat 60`, Koog aan de Zaan
  - `De Spiegel`: `Gibraltar 2, 1503 BM`, Zaandam
  - `Delta`: `Beemdgras 40, 1567 HP`, Assendelft
  - `Delta`: `Kreekrijklaan 2, 1567 LP`, Assendelft
  - `Dynamica G&SB`: `De Zevenster 46, 1521 JS`, Wormerveer
  - `het koraal`: `Kreekrijklaan 2, 1567 LP`, Assendelft
  - `Theo Thijssen`: `Amfibieplein 41, 1525 PA`, West Knollendam

## Dependencies
- `react`
- `react-dom`
- `leaflet`
- `react-leaflet`
- Vite and ESLint dev tooling.

## Cautions For Future Agents
- Update this `AGENTS.md` file after every project change. Add a concise entry to the changelog below with the date, what changed, and any verification performed.
- Do not live-geocode in the browser; use fixed coordinates in `src/data/locations.js`.
- Keep CSV replaceable and semicolon-delimited.
- If editing route links, preserve white text in Leaflet popups.
- If editing persistence, keep `/api/rows` compatible with the serialized row shape from `serializeRows()`.
- For Vercel deployment with central edit persistence, connect Upstash Redis. The current Vercel integration may expose `KV_REST_API_URL` and `KV_REST_API_TOKEN`; these are supported.
- If changing map/table behavior, run both `npm run lint` and `npm run build`.
- Keep commits focused and update this changelog before pushing project changes.

## Changelog
- 2026-04-18: Added `AGENTS.md` as project handoff documentation. Documented project structure, CSV/data rules, UX behavior, right-click edit flow, localStorage behavior, corrected addresses, dependencies, run commands, and future-agent cautions. Verified app was running at `http://127.0.0.1:5173` with HTTP `200 OK`.
- 2026-04-18: Added this changelog and the rule that every future project change must be recorded in `AGENTS.md`. No app code changed.
- 2026-04-18: Added persistent server-side edit storage. `vite.config.js` now exposes `GET /api/rows` and `PUT /api/rows`; browser edits save to `data/planning-overrides.json` and survive rebuilds. App still falls back to CSV/localStorage when no server data exists. Verified with `npm run lint`, `npm run build`, app HTTP `200`, API GET returning 40 rows, API PUT returning `ok: true`, and confirmed `data/planning-overrides.json` exists.
- 2026-04-18: Added a dedicated mobile UI selected by device viewport (`max-width: 760px`). Mobile users now get map/location tabs, a collapsible filter bar, touch-friendly location cards, edit buttons in map popups/cards, and pressed-state ARIA on mobile controls. Verified with `npm run lint`, `npm run build`, and app HTTP `200`.
- 2026-04-18: Prepared the project for GitHub publication to `https://github.com/DaniBakkum/Zandbakken.git`. Updated agent notes with remote information and removed the old no-git caution. Verification/push result is recorded in the assistant response for this step.
- 2026-04-18: Initialized local git repository, created initial commit, and attempted to push to GitHub. Shell push blocked on missing HTTPS credentials in the non-interactive environment. Added `.vite` to `.gitignore` after Vite generated a local cache during checks.
- 2026-04-18: Fixed ESLint configuration to ignore the local `.vite` cache directory. This prevents generated dependency cache files from breaking `npm run lint` after the devserver has run. Verified with `npm run lint`, `npm run build`, and app HTTP `200`.
- 2026-04-18: Made localStorage-to-server migration non-blocking so an unavailable/stale `/api/rows` endpoint cannot make the app show the generic CSV loading error. This was needed after a devserver was still running with an older Vite config. Restarted devserver and verified app HTTP `200`, CSV HTTP `200`, API HTTP `200` returning JSON, `npm run lint`, and `npm run build`.
- 2026-04-18: Prepared Vercel deployment support. Added `api/rows.js` as a production serverless API with Upstash Redis support and fallback to bundled `data/planning-overrides.json`, added `vercel.json`, and made failed server saves fall back to browser localStorage instead of losing edits. Verified with `npm run lint`, `npm run build`, and a direct Node handler test where `GET` returned 40 rows and `PUT` returned `ok: true, persisted: false` without Upstash env vars.
- 2026-04-18: Updated Vercel Redis env var support after Upstash integration setup. `api/rows.js` now accepts Vercel KV-style `KV_REST_API_URL` and `KV_REST_API_TOKEN` in addition to `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`. Verified with `npm run lint`, `npm run build`, and direct API handler fallback test returning 40 rows and `ok: true`.
- 2026-04-18: Added storage diagnostics to `/api/rows` responses. API responses now include booleans for detected Upstash/Vercel KV environment variables so Vercel deployment issues can be diagnosed when `persisted` is `false`. Verified with `npm run lint`, `npm run build`, and a direct API handler test showing storage booleans.
- 2026-04-18: Expanded Vercel storage diagnostics and Redis config detection for the exact Upstash integration variables visible in Vercel (`REDIS_URL`, `KV_URL`, `KV_REST_API_URL`, `KV_REST_API_TOKEN`, `KV_REST_API_READ_ONLY_TOKEN`). Added `hasWritableRestConfig` so production diagnostics show whether write-capable REST config is available. Verified with `npm run lint`, `npm run build`, and direct API handler diagnostics test.
