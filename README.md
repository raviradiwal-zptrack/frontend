# Zivanta Field Tracker — PWA Frontend

Installable mobile web app for MRs: search/filter doctors & chemists, view
profiles with the Instagram-style visit/comment feed, and a Leaflet map with
"find nearby from my location."

Deploys free on **Netlify**, straight from your Windows laptop via GitHub —
no AWS, no server to manage.

## 1. Point it at your deployed API
Open `js/api.js` and change the fallback, or simpler — add this one line
in `index.html` right before the `<script src="js/api.js">` tag:
```html
<script>window.ZIVANTA_API_BASE = "https://zivanta-tracker-api.onrender.com/api";</script>
```
(use your actual Render URL from the backend deployment)

## 2. Push to GitHub
```powershell
cd zivanta-pwa
git init
git add .
git commit -m "Zivanta tracker PWA"
```
Create an empty repo on GitHub, then push using the instructions it shows.

## 3. Deploy on Netlify
1. Sign up at [netlify.com](https://netlify.com) with your GitHub account.
2. **Add new site → Import an existing project** → pick your repo.
3. Build command: leave blank. Publish directory: `/` (this is a static
   site, no build step needed).
4. Deploy. Netlify gives you a free URL like `https://zivanta-tracker.netlify.app`
   with **HTTPS already on** — this is what solves the geolocation
   requirement automatically, no Certbot/Nginx needed.
5. Every future `git push` auto-redeploys.
6. Optional: under Site settings → Domain management, you can add a
   custom domain later (e.g. `tracker.zivantapharma.com`) for free —
   Netlify issues the SSL cert automatically.

## 4. Install on Android
Once live on Netlify, open the site in Chrome on an Android phone → menu
(⋮) → **"Add to Home screen" / "Install app."** It behaves like a native
app: full-screen, home-screen icon, app shell works offline.

## 5. Icons
`icons/icon-192.png` and `icons/icon-512.png` are placeholders (a purple "Z").
Swap them for your real Zivanta logo — same dimensions, same filenames.

## What's offline-capable vs not
- **Works offline**: app shell loads instantly (login screen, layout, CSS/JS).
- **Needs connection**: doctor/chemist lists, profiles, comments, map search
  — always hits the live API. If offline, the app shows a banner and a
  friendly error instead of failing silently. Note: on Render's free tier,
  if the API has been asleep, the *first* request after reconnecting may
  take 30-60 seconds — that's normal, not a bug.
- **Not built yet**: true offline data entry (queue a comment while offline,
  sync when back online) — worth adding later if MRs regularly work in
  no-signal areas.

## Nearby map (v1.4.0)
Open the Map tab and the app finds your GPS position and lists every doctor/chemist
within 3 km, nearest first. From there the MR can:
- switch the radius (1 / 2 / 3 / 5 km) and the type (Doctors / Chemists / Both)
- tap 🎯 then tap anywhere on the map to search around a different spot (e.g. planning tomorrow's area)
- filter by name, hospital or speciality
- tap a row to jump to that pin, or ➤ to start Google Maps navigation
Pins are clustered, so a few hundred doctors stay readable; zoom in to split clusters.
Only doctors with saved coordinates appear on the map.

## Map
Your own doctors and chemists around a point, colour-coded: purple = prescribing,
orange = target (not yet prescribing), green = chemist. Filter chips (All / Prescribing /
Target / Chemist), radius chips (1/2/3/5 km), a search box, a 📍 button for your live
location and a 🎯 button to pick any spot on the map. Tap a pin or a row to open the
profile or navigate. Adding a doctor or chemist captures your live location and fills in
city / locality / sub-locality from it. There is no Google lookup; the map is
OpenStreetMap and "Navigate" simply opens the Google Maps app.

## Auto-filled address (v1.7.0)
When adding a doctor or chemist, city/locality/sub-locality fill in
automatically once lat/lng are known (GPS capture, or manually typed coordinates) — via a free reverse-geocoding
lookup, never overwriting anything already typed by hand.

## Chemist naming (v1.7.0)
The retail store name (e.g. "Deshmukh Medical Store") is now the primary,
required field for a chemist — shown everywhere a chemist is listed. The
individual pharmacist/chemist's name is optional and secondary.

## Start Day / End Day (v1.8.0)
The home screen now opens with a Start Day panel: pick one or more
clusters (territories assigned by your admin, or every cluster if none
have been assigned yet) and tap Start Day — your current location is
captured. Once started, the panel shows "Day in progress" with an End Day
button; ending it captures location again and closes the day. A day can
only be started once and ended once per calendar date.

## Home page now shows today's coverage, not the full list (v1.8.0)
By default, the Doctors/Chemists list on the home screen shows only
doctors/chemists *you've personally logged a visit for today* — not the
entire database. Typing in the search box switches to searching every
doctor/chemist in the system, same as before; clearing the search
reverts to today's covered list.

## Navigation (v1.8.0)
The bottom nav is now Home / Map (renamed from List / Map). A 🏠 Home
icon is also on the Edit screen's top bar, the Detail screen's header,
and the Map screen's search row — reachable from anywhere. The app also
now uses the browser History API, so the Android/Chrome back button
navigates within the app (to whatever screen you were on before) instead
of exiting straight to the home screen.

## Seriousness rating (v1.9.0)
Every doctor — prescribing or target — can be given a 1-5 star rating for
how seriously they're engaging with the product. Set it from the Add/Edit
form; it shows as stars on list cards and the detail page.

## Flag instead of delete (v1.9.0)
MRs can no longer delete a doctor or chemist record, even via direct API
access — that was previously possible but never exposed in the UI, and
is now blocked server-side too. Instead, a "🚩 Flag listing as invalid"
button on the detail page lets an MR report a bad listing with a reason;
it shows as a banner on the record until an admin reviews it in the
admin portal and either deletes it or dismisses the flag.

## Commission payments (v1.9.0)
A doctor's detail page now has a dedicated "💰 Commission Payments"
section, separate from the visit/comment feed — a log of actual amounts
paid, with date and an optional photo or PDF as evidence. This is
financial record-keeping, not a conversational note.

## v2.0.0 — rating, accordions, samples, gifts, simplified Start Day

- **Rating replaces Priority everywhere** — doctors and chemists both now
  carry a 1-5 star rating (renamed from "seriousness"); the old A/B/C
  priority field is gone from the app entirely.
- **Live location auto-captured on first add** — adding a brand-new doctor
  or chemist silently grabs GPS right away (no button tap needed) and
  auto-fills city/locality/sub-locality from it.
- **Accordions** — Details, Gifting Details, Special Notes, Linked
  Chemists/Doctors, and Comments are now collapsible sections with an
  arrow toggle, instead of one long scroll.
- **Commission section is admin-only** — a regular MR login no longer
  sees it at all; log in as admin (same app, same login screen) to see
  and use it.
- **🎁 Samples**: a searchable product list with a quantity box next to
  each — select what you gave, it auto-generates the comment ("Samples
  given: X x10, Y x5") and posts it through the same mandatory
  selfie+location flow as any other visit.
- **🎁 Gifts**: a separate comment type — requires a photo (from the
  gallery, not a forced live selfie), no location needed. Comments are
  color-coded by the doctor's RX status *at the time they were logged* —
  amber while still a target, green-bordered once prescribing — so you
  can see at a glance how many visits happened before a doctor converted.
- **Chemists**: added a Rating (same 1-5 stars as doctors) and a Billing
  Category (Own / Distributor / Hybrid).
- **Chemist stock**: "Sold" is now an entry option alongside Supplied and
  Checked — enter what the chemist sold since your last visit.
- **Start Day simplified**: no more cluster selection — just tap Start
  Day / End Day, location and timestamp are captured either way.

## File map
- `index.html` — the single-page app shell (login, list, detail, edit, map views)
- `css/style.css` — all styling, Zivanta purple/green
- `js/api.js` — API client + JWT session handling
- `js/app-*.js` — split into modules (core, detail, capture, calls, home, reports, profile), loaded in that order; view routing, list/search/filter, detail + comment feed, forms
- `js/map.js` — Leaflet map, geolocation, nearby search
- `manifest.json` / `sw.js` — PWA installability + shell caching

## Full deployment order (both projects)
1. Neon → create DB, run `db/schema.sql`
2. Cloudinary → create account, grab keys
3. Backend → push to GitHub → deploy on Render → note the API URL
4. Frontend → set `ZIVANTA_API_BASE` to that URL → push to GitHub → deploy on Netlify
5. Open the Netlify URL on your phone → install to home screen → log in with the admin account you created in step 1
