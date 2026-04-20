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
- Each row can include an optional `revision` object for completed work:
  - `completed` (boolean)
  - `outgoingRaw` (string)
  - `incomingRaw` (string)
  - `equipment` (string)
  - `notes` (string)
  - `completedAt` (ISO timestamp or `null`)

## Current UX
- Desktop is used above `760px`; mobile is used at `760px` and below via `matchMedia('(max-width: 760px)')`.
- Desktop main view is a large Leaflet/OpenStreetMap map.
- Desktop location table is an expandable right-side panel opened with `Locaties (...)`.
- Mobile has a dedicated UI:
  - `Kaart` / `Locaties` segmented control.
  - Filters behind a compact `Filters` button.
  - Location list as touch-friendly cards instead of a wide table.
  - Map popups and location cards only show `Bewerken` when admin mode is active.
- Filters are above the map:
  - Materieel compact multi-select dropdown
  - Afronding dropdown (`Alle voortgang`, `Afgerond`, `Niet afgerond`)
- Map marker colors are based on `Materieel`:
  - `Mobiel`: blue
  - `Kraan`: orange
  - `Knijper`: purple
  - `Knikmops`: teal
  - `Onbekend`: gray
- Completed revisions show a green check badge on the map marker.
- There is no map legend by user request.
- Every popup and table row has a Google Maps route link.
- Route links use marker coordinates (`lat,lng`) when available so navigation matches the map marker position; address is only a fallback.
- Route link text must stay white in normal, visited, hover, and active states.
- Map includes a `Mijn locatie` control that uses browser geolocation, centers the map on the user, and displays a blue user-location marker with accuracy in meters.
- Popup and mobile cards include revision actions:
  - `Zandbak afronden` to save completed work
  - `Revisie aanpassen` after completion
  - `Opnieuw openzetten` to remove completed state

## Editing Behavior
- Desktop: right-click a map marker to open the edit card.
- Mobile: tap a marker and use `Bewerken` in the popup, or use `Bewerken` on a location card, only when admin mode is active.
- Admin mode is opened by clicking the top-right `Bron` pill and entering the password `Sturm1505!`.
- Clicking the `Bron` pill again logs out admin and immediately disables all edit entry points.
- Revision flow is available to all users (not admin-only) and opens via popup/location-card actions.
- Revision saves are sent directly to `/api/rows` and use localStorage fallback when server persistence fails.
- Admin can add schools via `School toevoegen` in the locations panel (desktop and mobile list header).
- Admin can remove schools via `School verwijderen` in the edit overlay.
- Added/removed schools are persisted immediately via `/api/rows` with the same localStorage fallback on server failure.
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
- Admin can start marker relocation from the edit overlay via `Bolletje verplaatsen`.
- During relocation, the edit overlay closes and the selected marker becomes draggable on the map.
- On drag end, latitude/longitude are updated and saved immediately through the existing `/api/rows` persistence flow.
- Address fields (`Straatnaam`, `Plaats`) are not auto-updated when a marker is moved; admin must edit them manually if needed.
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
- 2026-04-20: Simplified top filter bar to only two filters: `Materieel` and `Afronding` (revision completion state). Removed search, bestuur, plaats, and the old status filter from the UI and filtering logic. Verified with `npm run lint` and `npm run build`.
- 2026-04-20: Updated Google Maps route links to use row coordinates (`location.lat`, `location.lng`) instead of address text when available, so navigation matches marker positions after manual marker moves. Address-based destination remains as fallback for rows without coordinates. Verified with `npm run lint` and `npm run build`.
- 2026-04-20: Added admin school management actions. Admin users can now add new schools (`School toevoegen`) and remove existing schools (`School verwijderen`) directly from the dashboard UI. New and deleted rows are saved immediately through `/api/rows` with local fallback on save failure. Verified with `npm run lint` and `npm run build`.
- 2026-04-20: Added admin marker relocation flow. The edit overlay now includes `Bolletje verplaatsen`; starting relocation closes the overlay and enables dragging the selected map marker. On drop, coordinates are updated automatically and persisted immediately via `/api/rows` with local fallback on failure, while address fields remain unchanged for manual admin updates. Verified with `npm run lint` and `npm run build`.
- 2026-04-20: Added revision workflow for completed sandpit work in `src/App.jsx` and `src/App.css`. Users can now save `Zandbak afronden` details (`m3 uit`, `m3 in`, uitgevoerd materieel, optional opmerkingen), view these values in the marker popup, reopen completed items, and see a check badge on completed map markers. Revision data is stored per row in a `revision` object and persisted via existing `/api/rows` storage flow with local fallback. Verified with `npm run lint` and `npm run build`.
- 2026-04-20: Added password-gated admin edit mode via the top-right `Bron` pill in `src/App.jsx`. Editing is now hidden/blocked for regular users (popup button, mobile card button, and marker right-click), and only becomes available after entering admin password `Sturm1505!`; clicking the pill again logs out admin and closes active edit state. Added auth modal and source-pill/admin visual styles in `src/App.css`. Verified with `npm run lint` and `npm run build`.
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
- 2026-04-18: Added user geolocation support. The map now has a `Mijn locatie` button that requests browser location permission, centers the map on the user, and shows a blue location marker with accuracy. Verified with `npm run lint` and `npm run build`.
