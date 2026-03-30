# GEO-SENTINEL v7.0 — Professional Surveying Tool

## Files
```
geo-sentinel-v7/
├── index.html        ← Open in browser (loads styles.css + script.js)
├── styles.css        ← All styling
├── script.js         ← All JavaScript (GPS, UTM, Camera, NTRIP, exports)
├── main.py           ← FastAPI backend — deploy to Render
├── requirements.txt  ← Python deps (Python 3.11)
├── runtime.txt       ← Forces Python 3.11 on Render
└── README.md
```

## Open Right Now (no server needed)
Just open `index.html` in Chrome/Edge/Firefox on phone or desktop.
**On phone: use HTTPS** (required for GPS and camera access).
Easiest way: push to GitHub Pages — it gives you free HTTPS.

---

## What's New in v7.0

### 1. Universal Accuracy — Localization Shift
- Field Mode → **LOCALIZE** button
- Stand on a known control point, enter its known coordinates
- App computes the GPS offset and applies it to ALL future picks
- Even a basic phone becomes accurate to your local grid
- Tap the green badge to clear the shift

### 2. Camera-Aided Picking
- Field Mode → **Toggle Camera**
- Live camera feed with red crosshair overlay
- Set lens-to-antenna offset (cm) for precise pointing
- Aim crosshair at nail/IPC/pillar, then press PICK POINT

### 3. CORS / NTRIP Client
- Field Mode → **NTRIP** button
- Enter: host, port, mountpoint, username, password
- Connects via backend proxy (browser can't open raw TCP)
- Shows ~40% accuracy boost indicator when active
- Without backend: simulation mode shows the calculation
- **NTRIP providers for Kenya:** KENET CORS, Trimble RTX, Leica SmartNet

### 4. Real-Time UTM Display (proj4.js)
- Easting (X) and Northing (Y) in metres updated live
- Updates during GPS capture AND on every map mouse move
- Auto-detects UTM zone from coordinates
- Displayed in Field Mode cards AND map HUD

### 5. Professional Export
- **Point Name** + **File Name** saved separately at naming modal
- CSV includes: Lat, Lon, Easting, Northing, UTM Zone, h, N, H, accuracy
- KML uses `<altitudeMode>clampToGround</altitudeMode>` + altitude=0
  → Pins stay **glued to terrain** in Google Earth, no floating/jumping
- LandXML uses Northing/Easting from proj4 calculation
- Export format toggle: CSV or KML

---

## Activate Real Backend (Render)

### Step 1 — Push to GitHub
```bash
cd geo-sentinel-v7
git init
git add main.py requirements.txt runtime.txt
git commit -m "GEO-SENTINEL v7 backend"
git remote add origin https://github.com/YOUR_NAME/geo-sentinel-backend.git
git push -u origin main
```

### Step 2 — Deploy on Render
- New → Web Service → connect repo
- Build: `pip install -r requirements.txt`
- Start: `uvicorn main:app --host 0.0.0.0 --port $PORT`
- Add env var: `GEE_SERVICE_ACCOUNT_KEY` = your GEE JSON key

### Step 3 — Update script.js line 11
```js
const API_BASE = 'https://YOUR-APP.onrender.com';
```

---

## GEE Service Account Key
Set as `GEE_SERVICE_ACCOUNT_KEY` in Render env vars:
```json
{
  "type": "service_account",
  "project_id": "geo-pulse-490615",
  "client_email": "geo-pulse@geo-pulse-490615.iam.gserviceaccount.com",
  ...paste full key here...
}
```

## What Works Without Backend
- GPS picking (30-sample Kalman average)
- Localization shift
- Camera-aided picking
- proj4 UTM coordinates
- A★ Golden Path (local algorithm)
- Upload CSV/KML → map + rover analysis
- CSV, KML, LandXML exports
- NOAA space weather (Kp + X-ray flux)
- All 4 tabs fully functional

## What Needs Backend
- Real EGM2008 geoid (uses approximation without it)
- Real GEE InSAR / Bathymetry / Erosion data
- NTRIP proxy connection
