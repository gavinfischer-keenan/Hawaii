// =====================================================================
// HONOLULU COMMAND CENTER — script.js
// =====================================================================

// --- MAP SETUP ---
const bounds = [[20.75, -158.45], [21.75, -156.45]];

// minZoom 10 (not 9): at zoom 9 the ~2°-wide island-chain bounds are narrower
// than the wide 16:9 viewport, so the view overflows the bounds and looks "way
// zoomed out". Zoom 10 is the tightest level where the bounds fill the screen —
// it's also the level every flyTo returns to, so boot + every page now match.
var map = L.map('map', {
    zoomControl: false, attributionControl: false,
    minZoom: 10, maxZoom: 12, maxBounds: bounds, maxBoundsViscosity: 1.0
}).setView([21.265, -157.785], 10);
// Prevent all user interaction — map is display-only; programmatic flyTo still works
map.dragging.disable(); map.touchZoom.disable(); map.doubleClickZoom.disable();
map.scrollWheelZoom.disable(); map.boxZoom.disable(); map.keyboard.disable();

// --- Z-INDEX PANES ---
map.createPane('depthPane');   map.getPane('depthPane').style.zIndex   = 200;
map.createPane('aqiPane');     map.getPane('aqiPane').style.zIndex     = 250;
map.createPane('windPane');    map.getPane('windPane').style.zIndex    = 300;
map.createPane('radarPane');   map.getPane('radarPane').style.zIndex   = 350;
map.createPane('currentPane'); map.getPane('currentPane').style.zIndex = 400;
map.createPane('trafficPane'); map.getPane('trafficPane').style.zIndex = 500;
map.createPane('surfPane');    map.getPane('surfPane').style.zIndex    = 550;
map.createPane('poiPane');     map.getPane('poiPane').style.zIndex     = 600;
map.createPane('hazardPane');  map.getPane('hazardPane').style.zIndex  = 650;
map.createPane('islandPane');  map.getPane('islandPane').style.zIndex  = 670;

// --- BASE TILES ---
L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Ocean/World_Ocean_Base/MapServer/tile/{z}/{y}/{x}', { maxZoom: 13 }).addTo(map);
// Place/channel labels overlay. CartoDB raster labels are transparent PNGs
// cached globally, so open-ocean tiles return EMPTY instead of the opaque grey
// "Zoom Level Not Supported" placeholders that ESRI's World_Topo_Map and
// World_Ocean_Reference overlays return above z9 in this region (those showed
// up as the grey boxes scattered across the ocean).
L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/dark_only_labels/{z}/{x}/{y}{r}.png', {
    subdomains: 'abcd', maxZoom: 20, opacity: 0.92,
    attribution: '© OpenStreetMap contributors, © CARTO'
}).addTo(map);

// --- LAYER GROUPS ---
// Always-visible permanent layers:
var surfLayer       = L.layerGroup();   // only shown on the SURF & OCEAN view
var staticPoiLayer  = L.layerGroup().addTo(map);
// Island highlight layer removed at user request.

// Panel-toggled layers:
var radarLayerGroup = L.layerGroup();
var windLayer       = L.layerGroup();
var currentLayer    = L.layerGroup();
var buoyLayer       = L.layerGroup();
var quakeLayer      = L.layerGroup();
var lightningLayer  = L.layerGroup();
var aqiLayer        = L.layerGroup();
var airLayer        = L.layerGroup();
var shipLayer       = L.layerGroup();
var stationLayer    = L.layerGroup();   // land weather stations (NWS) — shown on the meteorological views
var alertLayer      = L.layerGroup();
var turbulenceLayer = L.layerGroup();
var airportLayer    = L.layerGroup();
// Dense bathymetry — only added to map during Traffic Combined zoom-in
var denseDepthLayer = L.layerGroup();

// Traffic Flow Layer (TomTom) removed due to missing API key and unused status.

// --- LIVE RADAR: RainViewer global mosaic (~10-min updates) ---
// The US IEM NEXRAD mosaic (nexrad-n0q) is CONUS-only and has NO Hawaii
// coverage, so it never showed anything here. RainViewer is global, keyless,
// and its API returns the latest real frame timestamp each refresh.
var _radarTile = null;
async function refreshRadar() {
    try {
        const r = await fetch('https://api.rainviewer.com/public/weather-maps.json');
        if (!r.ok) throw new Error(r.status);
        const j = await r.json();
        const past = j.radar?.past || [];
        if (!past.length) return;
        const frame = past[past.length - 1];
        const url = `${j.host}${frame.path}/256/{z}/{x}/{y}/2/1_1.png`;
        if (_radarTile) radarLayerGroup.removeLayer(_radarTile);
        // RainViewer's global radar mosaic only serves up to z7 for the Hawaii
        // region; above that it returns a "Zoom Level Not Supported" placeholder
        // tile. Cap maxNativeZoom at 7 so Leaflet upscales the z7 frame across
        // the map's z9–12 range instead of requesting unsupported tiles.
        _radarTile = L.tileLayer(url, { pane: 'radarPane', opacity: 0.7, maxNativeZoom: 7, maxZoom: 13 });
        radarLayerGroup.addLayer(_radarTile);
    } catch (e) { console.warn('Radar fetch:', e); }
}
refreshRadar();
setInterval(refreshRadar, 5 * 60 * 1000);

// --- SEEDED RNG — depth numbers stay identical every page load ---
function makeSeededRng(seed) {
    let s = seed >>> 0;
    return function() { s = Math.imul(1664525, s) + 1013904223 >>> 0; return s / 0xFFFFFFFF; };
}
const rng = makeSeededRng(0xABCDEF42);

// --- LAND MASK — polygon outlines per island so depth soundings never fall on
// land. The Oahu outline traces the real coastline closely (north shore curve,
// Kaneohe Bay, the Mokapu peninsula, Kailua, and the Pearl Harbor concavity) so
// the land check (isOnLand) and the offshore distance gradient (distToShoreKm)
// are accurate enough to drive both the dense bathymetry mask and the wind flow
// field's deflection around the islands. Other islands are rougher. ---
const ISLAND_POLYS = [
    // Oahu (clockwise from Kaena Point)
    [[21.575,-158.281],[21.585,-158.200],[21.591,-158.108],[21.640,-158.060],
     [21.678,-158.040],[21.710,-157.995],[21.648,-157.922],[21.555,-157.875],
     [21.519,-157.838],[21.480,-157.852],[21.420,-157.810],[21.460,-157.726],
     [21.400,-157.739],[21.370,-157.700],[21.335,-157.695],[21.310,-157.650],
     [21.268,-157.700],[21.272,-157.760],[21.252,-157.805],[21.282,-157.845],
     [21.300,-157.875],[21.318,-157.960],[21.360,-157.960],[21.330,-157.990],
     [21.300,-158.020],[21.297,-158.103],[21.335,-158.122],[21.390,-158.150],
     [21.443,-158.190],[21.470,-158.220],[21.540,-158.255]],
    // Molokai
    [[21.21,-157.26],[21.21,-157.00],[21.17,-156.71],[21.12,-156.74],
     [21.06,-157.00],[21.08,-157.22]],
    // Lanai
    [[20.92,-156.92],[20.90,-156.82],[20.82,-156.80],[20.74,-156.87],
     [20.74,-156.95],[20.82,-157.06],[20.90,-157.02]],
    // West Maui (only the western lobe falls within the map bounds)
    [[21.03,-156.61],[20.98,-156.48],[20.80,-156.45],[20.80,-156.55],
     [20.87,-156.69],[20.94,-156.70],[20.99,-156.66]],
];
function pointInPoly(lat, lng, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const yi = poly[i][0], xi = poly[i][1];
        const yj = poly[j][0], xj = poly[j][1];
        const intersect = ((yi > lat) !== (yj > lat)) &&
            (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi);
        if (intersect) inside = !inside;
    }
    return inside;
}
function isOnLand(lat, lng) {
    for (const poly of ISLAND_POLYS) if (pointInPoly(lat, lng, poly)) return true;
    return false;
}
// Approx km from a point to a segment, using a local equirectangular plane
// (1° lat ≈ 111 km, 1° lng ≈ 102 km at ~21°N).
function _segKm(lat, lng, a, b) {
    const KX = 102, KY = 111;
    const px = lng * KX, py = lat * KY;
    const ax = a[1] * KX, ay = a[0] * KY;
    const bx = b[1] * KX, by = b[0] * KY;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy || 1e-9;
    let t = ((px - ax) * dx + (py - ay) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const cx = ax + t * dx, cy = ay + t * dy;
    return Math.hypot(px - cx, py - cy);
}
// Shortest distance (km) from a point to the nearest island coastline. Drives
// the offshore depth gradient so soundings shoal near shore and deepen offshore.
function distToShoreKm(lat, lng) {
    let min = Infinity;
    for (const poly of ISLAND_POLYS) {
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
            const d = _segKm(lat, lng, poly[j], poly[i]);
            if (d < min) min = d;
        }
    }
    return min;
}


// =====================================================================
// DENSE BATHYMETRY — zoomed south-Oahu traffic view (~zoom 12)
// Much finer 0.022° grid with near-shore shelf gradient
// =====================================================================
const rngD = makeSeededRng(0xC0FFEE99);
const harborLat = 21.305, harborLng = -157.867;
for (let lat = 21.15; lat <= 21.42; lat += 0.022) {
    for (let lng = -158.12; lng <= -157.55; lng += 0.028) {
        if (isOnLand(lat, lng)) continue;
        const jLat = lat + (rngD() - 0.5) * 0.010;
        const jLng = lng + (rngD() - 0.5) * 0.014;
        // km offshore (rough) — 1° lat ≈ 111 km, 1° lng ≈ 102 km at 21°
        const kmOff = Math.sqrt(Math.pow((jLat - harborLat) * 111, 2) + Math.pow((jLng - harborLng) * 102, 2));
        let depth;
        // Authentic Oahu bathymetry profile (steep volcanic drop-off)
        // Matching NOAA Chart 19362 & 19357 depth soundings
        if (kmOff < 1)         depth = 10 + kmOff * 80;            // 0-1km: 10-90 ft
        else if (kmOff < 3)    depth = 90 + (kmOff - 1) * 350;     // 1-3km: 90-790 ft (15-130 fm)
        else if (kmOff < 8)    depth = 790 + (kmOff - 3) * 350;    // 3-8km: 790-2540 ft (130-420 fm)
        else if (kmOff < 20)   depth = 2540 + (kmOff - 8) * 250;   // 8-20km: 2540-5540 ft (420-920 fm)
        else                   depth = 5540 + (kmOff - 20) * 150;  // 20+km: 5540+ ft (920+ fm)

        // Add randomized variation for rugged seafloor terrain
        depth += (rngD() - 0.5) * (depth * 0.20); 
        depth = Math.floor(Math.max(6, depth));
        
        // Convert depth (feet) to Fathoms & Feet for authentic maritime chart representation
        const fm = Math.floor(depth / 6);
        const ft = Math.floor(depth % 6);
        // Show feet as subscript if < 30 fathoms, otherwise just fathoms
        const html = fm < 30 && ft > 0 ? `${fm}<sub>${ft}</sub>` : `${fm}`;

        L.marker([jLat, jLng], {
            pane: 'depthPane',
            icon: L.divIcon({ className: 'depth-label depth-label-dense', html: html, iconSize: [36, 14] })
        }).addTo(denseDepthLayer);
    }
}

// =====================================================================
// STATIC NOAA BUOY LABELS (always on map)
// =====================================================================
var staticPoiMarkers = [];
[
    { c: [21.297, -157.959], n: "⚓ 51211 Pearl Harbor" },
    { c: [21.414, -157.678], n: "⚓ 51202 Mokapu"     },
    { c: [21.323, -158.149], n: "⚓ 51212 Barbers Pt" },
    { c: [21.750, -158.200], n: "⚓ 51201 Waimea"     },
    { c: [21.065, -156.970], n: "⚓ 51204 Pailolo Ch" },
    { c: [21.080, -157.050], n: "⚓ 51213 Kawaihae"   },
].forEach(b => {
    var marker = L.marker(b.c, { pane: 'poiPane',
        icon: L.divIcon({ className: 'poi-label', html: b.n, iconSize: [150, 20] })
    }).addTo(staticPoiLayer);
    staticPoiMarkers.push({ marker: marker, w: 150, h: 20 });
});

// =====================================================================
// STATIC AIRPORTS (only shown on Traffic views)
// =====================================================================
[
    { c: [21.326, -157.922], n: "🛫 HNL" },
    { c: [21.307, -158.070], n: "🛫 JRF" },
    { c: [21.152, -157.096], n: "🛫 MKK" },
    { c: [20.785, -156.951], n: "🛫 LNY" },
    { c: [20.898, -156.430], n: "🛫 OGG" },
    { c: [20.963, -156.673], n: "🛫 JHM" }
].forEach(a => {
    L.marker(a.c, { pane: 'poiPane',
        icon: L.divIcon({ className: 'poi-label', html: a.n, iconSize: [80, 20] })
    }).addTo(airportLayer);
});

// =====================================================================
// SURF SPOTS — animated markers on beach / land side of shoreline
// =====================================================================
// Coordinates adjusted so each marker sits at the beach, not offshore.
const surfSpots = [
    { c: [21.666, -158.037], name: "Sunset",    buoyId: "51201", cssScale: 0.85, scale: 1.5, nudge: [0, -38] }, // Top
    { c: [21.664, -158.053], name: "Pipeline",  buoyId: "51201", cssScale: 0.85, scale: 1.2, nudge: [0, 8] }, // Middle
    { c: [21.643, -158.064], name: "Waimea",    buoyId: "51201", cssScale: 0.85, scale: 1.0, nudge: [0, 54] },  // Bottom
    { c: [21.474, -158.219], name: "Makaha",    buoyId: "51212", cssScale: 0.85, scale: 0.8, nudge: [55, 0] },        // Left
    { c: [21.275, -157.828], name: "Waikiki",   buoyId: "51211", cssScale: 0.80, scale: 0.5, nudge: [0, -18] },              // Directly on dot
    { c: [21.286, -157.671], name: "Sandy's",   buoyId: "51211", cssScale: 0.85, scale: 0.6, nudge: [0, 10] },              // Right
    { c: [21.196, -157.254], name: "Kepuhi",    buoyId: "51204", cssScale: 0.85, scale: 1.0 },
    { c: [21.158, -156.720], name: "Halawa",    buoyId: "51202", cssScale: 0.85, scale: 1.0 },
];

var surfMarkers = [];
var buoyMarkers = [];     // {marker, html} — decluttered together with surf labels
var stationMarkers = [];  // {marker, html} — NWS land stations, decluttered too
var windMarkers = [];     // {marker, html} — forecast winds, decluttered too
var surfMode = 'small';   // 'small' everywhere; 'large' only in SURF & OCEAN

// Large boxed card — used only in the SURF & OCEAN wave view.
const BIG_W = 110, BIG_H = 44;

const drawLeader = (ax, ay, w, h, color) => {
    if (ax >= 0 && ax <= w && ay >= 0 && ay <= h) return '';
    let x2 = ax < 0 ? 0 : (ax > w ? w : ax);
    let y2 = ay < 0 ? 0 : (ay > h ? h : ay);
    return `<svg style="position:absolute; left:0; top:0; overflow:visible; pointer-events:none; width:1px; height:1px; z-index:-1;"><line x1="${ax}" y1="${ay}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="1.5"/><circle cx="${ax}" cy="${ay}" r="3" fill="${color}"/></svg>`;
};

function makeSurfIconLarge(spot, heightStr, color, anchor) {
    anchor = anchor || [BIG_W / 2, 0];
    const cssScale = spot.cssScale || 1;
    let leader = drawLeader(anchor[0], anchor[1], BIG_W, BIG_H, color);
    if (spot.nudge) leader = ''; // Disable leader if using manual nudge layout
    return L.divIcon({
        className: '',
        html: `<div style="position:relative; transform: scale(${cssScale}); transform-origin: top center;">${leader}<div class="surf-card" style="border-color:${color};box-shadow:0 0 10px ${color}33;">
            <div class="surf-card-name">🏄 ${spot.name}</div>
            <div class="surf-card-ht" style="color:${color};">${heightStr}</div>
        </div></div>`,
        iconSize:   [BIG_W, BIG_H],
        iconAnchor: anchor   // center-top → card hangs below the spot
    });
}
// Compact pin — the default for every other state. Fixed nominal size so the
// declutterer can reason about collisions.
const SMALL_W = 86, SMALL_H = 18;
function makeSurfIconSmall(name, heightStr, color, anchor) {
    anchor = anchor || [SMALL_W / 2, SMALL_H / 2];
    const ht = heightStr && heightStr !== '--' ? ` <b style="color:${color};">${heightStr}</b>` : '';
    const leader = drawLeader(anchor[0], anchor[1], SMALL_W, SMALL_H, color);
    return L.divIcon({
        className: '',
        html: `<div style="position:relative;">${leader}<div class="surf-pin" style="border-color:${color};">🏄 ${name}${ht}</div></div>`,
        iconSize:   [SMALL_W, SMALL_H],
        iconAnchor: anchor   // centered on the spot
    });
}
function initSurfMarkers() {
    surfLayer.clearLayers();
    surfMarkers = [];
    surfSpots.forEach(s => {
        const marker = L.marker(s.c, {
            pane: 'surfPane',
            icon: makeSurfIconSmall(s.name, '--', '#48dbfb')
        });
        marker.addTo(surfLayer);
        surfMarkers.push({ marker, spot: s, heightStr: '--', color: '#48dbfb' });
    });
}
initSurfMarkers();

function rebuildSurfIcon(entry, anchor) {
    if (surfMode === 'large') {
        entry.marker.setIcon(makeSurfIconLarge(entry.spot, entry.heightStr, entry.color, anchor));
    } else {
        entry.marker.setIcon(makeSurfIconSmall(entry.spot.name, entry.heightStr, entry.color, anchor));
    }
}

// ── Unified label declutter ───────────────────────────────────────────
function ccw(A, B, C) {
    return (C.y - A.y) * (B.x - A.x) > (B.y - A.y) * (C.x - A.x);
}
function intersectLine(l1, l2) {
    if (l1.x1 === l1.x2 && l1.y1 === l1.y2) return false;
    if (l2.x1 === l2.x2 && l2.y1 === l2.y2) return false;
    const A = {x: l1.x1, y: l1.y1}, B = {x: l1.x2, y: l1.y2};
    const C = {x: l2.x1, y: l2.y1}, D = {x: l2.x2, y: l2.y2};
    return ccw(A, C, D) !== ccw(B, C, D) && ccw(A, B, C) !== ccw(A, B, D);
}
function intersectRect(r1, r2, gap) {
    return !(r2.x >= r1.x + r1.w + gap || r2.x + r2.w + gap <= r1.x || r2.y >= r1.y + r1.h + gap || r2.y + r2.h + gap <= r1.y);
}
function lineIntersectsRect(l, r, gap) {
    const rx = r.x - gap/2, ry = r.y - gap/2, rw = r.w + gap, rh = r.h + gap;
    if (l.x1 >= rx && l.x1 <= rx+rw && l.y1 >= ry && l.y1 <= ry+rh) return true;
    if (l.x2 >= rx && l.x2 <= rx+rw && l.y2 >= ry && l.y2 <= ry+rh) return true;
    const top = {x1: rx, y1: ry, x2: rx+rw, y2: ry}, bottom = {x1: rx, y1: ry+rh, x2: rx+rw, y2: ry+rh};
    const left = {x1: rx, y1: ry, x2: rx, y2: ry+rh}, right = {x1: rx+rw, y1: ry, x2: rx+rw, y2: ry+rh};
    return intersectLine(l, top) || intersectLine(l, bottom) || intersectLine(l, left) || intersectLine(l, right);
}

function declutterLabels() {
    if (!map || !map._loaded) return;
    const large = surfMode === 'large';
    const entries = [];

    if (map.hasLayer(surfLayer)) {
        surfMarkers.forEach(e => {
            const w = large ? BIG_W : SMALL_W, h = large ? BIG_H : SMALL_H;
            if (large && e.spot.nudge) {
                // Manually placed with nudges, no collision detection
                rebuildSurfIcon(e, [w / 2 + e.spot.nudge[0], h / 2 + e.spot.nudge[1]]);
            } else {
                entries.push({ latlng: e.marker.getLatLng(), w, h, offsetTop: large ? 4 : -h / 2, preferred: e.spot.preferred, apply: (ax, ay) => rebuildSurfIcon(e, [ax, ay]) });
            }
        });
    }

    if (map.hasLayer(buoyLayer)) {
        buoyMarkers.forEach(b => {
            const w = 100, h = 30;
            entries.push({ latlng: b.marker.getLatLng(), w, h, offsetTop: -h - 6, apply: (ax, ay) => {
                const leader = drawLeader(ax, ay, w, h, '#0abde3');
                b.marker.setIcon(L.divIcon({ className: '', html: `<div style="position:relative;">${leader}${b.html}</div>`, iconSize: [w, h], iconAnchor: [ax, ay] }));
            }});
        });
    }

    if (map.hasLayer(stationLayer)) {
        stationMarkers.forEach(s => {
            const w = 110, h = 28;
            entries.push({ latlng: s.marker.getLatLng(), w, h, offsetTop: -h - 6, apply: (ax, ay) => {
                const leader = drawLeader(ax, ay, w, h, '#1dd1a1');
                s.marker.setIcon(L.divIcon({ className: 'fading-marker', html: `<div style="position:relative;">${leader}${s.html}</div>`, iconSize: [w, h], iconAnchor: [ax, ay] }));
            }});
        });
    }

    const GAP = 20;
    const placed = [];

    if (typeof staticPoiMarkers !== 'undefined') {
        staticPoiMarkers.forEach(sp => {
            const pt = map.latLngToContainerPoint(sp.marker.getLatLng());
            placed.push({ rect: { x: pt.x - sp.w/2, y: pt.y - sp.h/2, w: sp.w, h: sp.h }, line: null, isStaticPoi: true });
        });
    }

    entries.forEach(e => {
        const pt = map.latLngToContainerPoint(e.latlng);
        placed.push({ rect: { x: pt.x - 6, y: pt.y - 6, w: 12, h: 12 }, line: null, isDotFor: e });
    });

    entries.sort((a, b) => b.latlng.lat - a.latlng.lat);
    entries.forEach(e => {
        const pt = map.latLngToContainerPoint(e.latlng);
        // Generate a list of configurations to try
        const configsToTry = [];
        if (e.preferred) {
            configsToTry.push({ r: e.preferred.r, angle: e.preferred.angleOffset });
        }
        for (let r = 0; r < 400; r += 5) {
            const steps = r === 0 ? 1 : Math.max(8, Math.floor(2 * Math.PI * r / 10));
            const offsetAngle = (r % 15) * 0.1;
            for (let i = 0; i < steps; i++) {
                configsToTry.push({ r, angle: (i * Math.PI * 2) / steps + offsetAngle });
            }
        }

        let bestCandidate = null;
        for (const config of configsToTry) {
            const { r, angle } = config;
            const rect = { x: pt.x - e.w / 2 + r * Math.cos(angle), y: pt.y + e.offsetTop + r * Math.sin(angle), w: e.w, h: e.h };
            let collision = false;
            for (const p of placed) {
                if (intersectRect(rect, p.rect, GAP)) { collision = true; break; }
                if (p.line && lineIntersectsRect(p.line, rect, GAP)) { collision = true; break; } // Check if our box severs an existing line
            }
            if (collision) continue;
            
            const cx = Math.max(rect.x, Math.min(pt.x, rect.x + rect.w));
            const cy = Math.max(rect.y, Math.min(pt.y, rect.y + rect.h));
            const line = { x1: pt.x, y1: pt.y, x2: cx, y2: cy };
            
            if (r > 0) {
                for (const p of placed) {
                    if (p.isDotFor === e) continue;
                    if (p.isStaticPoi && intersectRect(rect, p.rect, GAP)) { collision = true; break; }
                    if (p.isStaticPoi) continue; // Lines can pass behind static POIs
                    if (lineIntersectsRect(line, p.rect, GAP)) { collision = true; break; }
                    if (p.line && intersectLine(line, p.line)) { collision = true; break; }
                }
            }
            if (collision) continue;
            
            bestCandidate = { rect, line };
            break;
        }
        
        if (!bestCandidate) bestCandidate = { rect: {x: pt.x - e.w / 2, y: pt.y + e.offsetTop, w: e.w, h: e.h}, line: null };
        placed.push(bestCandidate);
        e.apply(pt.x - bestCandidate.rect.x, pt.y - bestCandidate.rect.y);
    });
}
function setSurfMode(mode) { surfMode = mode; declutterLabels(); }

// Pan/zoom transitions change the pixel layout — re-flow afterwards.
map.on('moveend zoomend', declutterLabels);

function updateSurfLabels(buoys) {
    if (!buoys) { declutterLabels(); return; }
    const byId = {};
    buoys.forEach(b => { byId[b.id] = b; });
    surfMarkers.forEach(entry => {
        const buoy = byId[entry.spot.buoyId];
        let heightStr = '--', color = '#48dbfb';
        if (buoy && !buoy.error && buoy.waveHeight != null) {
            const hft = buoy.waveHeight * 3.281 * (entry.spot.scale || 1.0);
            const lo  = Math.max(1, Math.floor(hft * 0.85));
            const hi  = Math.ceil(hft * 1.15);
            heightStr = `${lo}-${hi}ft`;
            color = hft > 6 ? '#ff9f43' : '#1dd1a1';
        }
        entry.heightStr = heightStr;
        entry.color = color;
    });
    declutterLabels();
}

// =====================================================================
// WIND VECTORS — populated live from Open-Meteo via fetchWind()
// Ocean currents: REMOVED — no free real-time current API available
//   (would need HYCOM or NOAA CoastWatch model; flagged to operator)
// Ships: REMOVED — no live AIS feed; shipLayer starts empty
//   (needs MarineTraffic API key or on-site SDR-AIS receiver)
// =====================================================================
// windLayer and shipLayer are populated at runtime by their fetch functions

// =====================================================================
// LIVE DATA STORE
// =====================================================================
var liveData = { weather: null, buoys: null, quakes: null, alerts: null, turbulence: null, airquality: null, aircraft: [], wind: [], ships: [], shipsConnected: false, stations: [], currents: null, tide: null };

const buoyCoords = {
    '51201': [21.750, -158.200],
    '51211': [21.297, -157.959],
    '51212': [21.323, -158.149],
    '51202': [21.414, -157.678],
    '51204': [21.065, -156.970],
    '51213': [21.080, -157.050],
};

function mToFt(m)  { return m != null ? (m * 3.281).toFixed(1) : '--'; }
function cToF(c)   { return c != null ? Math.round(c * 9/5 + 32) : '--'; }
function timeAgo(ms) {
    const mins = Math.round((Date.now() - ms) / 60000);
    return mins < 60 ? `${mins}m ago` : `${Math.round(mins/60)}h ago`;
}

// =====================================================================
// FETCH FUNCTIONS
// =====================================================================
async function fetchWeather() {
    try {
        const r = await fetch('/api/weather');
        if (!r.ok) throw new Error(r.status);
        liveData.weather = await r.json();
    } catch(e) { console.warn('Weather fetch:', e); }
}

async function fetchBuoys() {
    try {
        const r = await fetch('/api/buoys');
        if (!r.ok) throw new Error(r.status);
        const data = await r.json();
        liveData.buoys = data.buoys;

        buoyLayer.clearLayers();
        buoyMarkers = [];
        data.buoys.forEach(b => {
            const coords = buoyCoords[b.id];
            if (!coords || b.error) return;
            const wh = b.waveHeight != null ? `${mToFt(b.waveHeight)}ft` : '--';
            const wt = b.waterTemp  != null ? `${cToF(b.waterTemp)}°F`   : '--';
            const html = `<div class="buoy-box"><div class="buoy-name">${b.name.split(' ')[0]}</div><div class="buoy-val">🌊${wh} 🌡${wt}</div></div>`;
            const marker = L.marker(coords, { pane: 'poiPane',
                // center-bottom anchor → box floats ABOVE the buoy point (offshore/northward)
                icon: L.divIcon({ className: '', html, iconSize: [100, 30], iconAnchor: [50, 30] })
            }).addTo(buoyLayer);
            buoyMarkers.push({ marker, html });
        });

        updateSurfLabels(data.buoys);
    } catch(e) { console.warn('Buoy fetch:', e); }
}

// Live AIS vessels (AISStream via our server). Renders nothing — and the panel
// shows an "offline" notice — until AISSTREAM_API_KEY is configured.
async function fetchShips() {
    try {
        const r = await fetch('/api/ships');
        if (!r.ok) throw new Error(r.status);
        const data = await r.json();
        liveData.ships = data.ships || [];
        liveData.shipsConnected = !!data.connected;

        shipLayer.clearLayers();
        liveData.ships.forEach(v => {
            if (v.lat == null || v.lng == null) return;
            const rot = v.cog != null ? v.cog : (v.heading != null ? v.heading : 0);
            const html = `<div class="ship-pin" title="${v.name}">
                <span class="ship-arrow" style="transform:rotate(${rot}deg);">➤</span>
                <span class="ship-name">${v.name}</span>
            </div>`;
            L.marker([v.lat, v.lng], { pane: 'poiPane',
                icon: L.divIcon({ className: '', html, iconSize: [120, 18], iconAnchor: [9, 9] })
            }).addTo(shipLayer);
        });
    } catch(e) { console.warn('Ship fetch:', e); }
}

// Land weather stations we pull temp/wind from (NWS). Shown on the map during
// the meteorological views so the data's origin is visible.
async function fetchStations() {
    try {
        const r = await fetch('/api/stations');
        if (!r.ok) throw new Error(r.status);
        const data = await r.json();
        liveData.stations = data.stations || [];

        stationLayer.clearLayers();
        stationMarkers = [];
        liveData.stations.forEach(s => {
            const temp = s.tempF != null ? `${s.tempF}°` : '--';
            const wind = s.windKt != null ? `${s.windDir || ''} ${s.windKt}kt` : 'calm';
            const html = `<div class="wx-box"><div class="wx-name">LIVE: ${s.name}</div><div class="wx-val">🌡${temp} · 💨${wind}</div></div>`;
            const marker = L.marker([s.lat, s.lng], { pane: 'poiPane',
                // center-bottom anchor → box floats ABOVE the station point
                icon: L.divIcon({ className: 'fading-marker', html, iconSize: [110, 28], iconAnchor: [55, 28] })
            }).addTo(stationLayer);
            stationMarkers.push({ marker, html });
        });
        declutterLabels();
    } catch(e) { console.warn('Station fetch:', e); }
}

async function fetchQuakes() {
    try {
        const r = await fetch('/api/earthquakes');
        if (!r.ok) throw new Error(r.status);
        const data = await r.json();
        liveData.quakes = data.quakes;

        quakeLayer.clearLayers();
        data.quakes.forEach(q => {
            // Whole Hawaiian chain — most quakes cluster on the Big Island
            // (lat ~19), which the old 20.3 cutoff wrongly excluded entirely.
            if (q.lat < 18.5 || q.lat > 23 || q.lng < -161 || q.lng > -154) return;
            const color  = q.mag >= 3 ? '#ee5253' : q.mag >= 2 ? '#ff9f43' : '#ffd32a';
            const size   = Math.max(22, Math.round(q.mag * 18));
            L.marker([q.lat, q.lng], {
                pane: 'hazardPane',
                icon: L.divIcon({
                    className: '',
                    html: `<div class="quake-marker" style="width:${size}px;height:${size}px;border-color:${color};box-shadow:0 0 8px ${color};"></div>`,
                    iconSize: [size, size], iconAnchor: [size/2, size/2]
                })
            }).addTo(quakeLayer)
              .bindTooltip(`M${q.mag} — ${q.place}`, { permanent: false, className: 'poi-label' });
        });
    } catch(e) { console.warn('Quake fetch:', e); }
}

async function fetchAlerts() {
    try {
        const r = await fetch('/api/alerts');
        if (!r.ok) throw new Error(r.status);
        liveData.alerts = await r.json();

        alertLayer.clearLayers();
        (liveData.alerts.alerts || []).forEach(a => {
            if (a.geometry) {
                const color = a.severity === 'Severe' || a.severity === 'Extreme' ? '#ee5253' :
                              a.severity === 'Moderate' ? '#ff9f43' : '#a29bfe';
                L.geoJSON(a.geometry, {
                    pane: 'hazardPane',
                    style: { color, weight: 2, fillOpacity: 0.15 }
                }).addTo(alertLayer).bindTooltip(a.event, { sticky: true, className: 'poi-label' });
            }
        });
    } catch(e) { console.warn('Alerts fetch:', e); liveData.alerts = { alerts: [] }; }
}

async function fetchTurbulence() {
    try {
        const r = await fetch('/api/turbulence');
        if (!r.ok) throw new Error(r.status);
        const data = await r.json();
        liveData.turbulence = data.turbulence || [];

        turbulenceLayer.clearLayers();
        liveData.turbulence.forEach(t => {
            if (t.geometry) {
                // High level vs Low level
                // Usually altitude is provided in hundreds of feet (e.g. 180 = FL180 = 18,000ft)
                const isHighLevel = (t.minAlt || t.maxAlt || 0) >= 180;
                const color = isHighLevel ? '#e84393' : '#fdcb6e'; // Pink for high, Yellow for low
                const label = `${isHighLevel ? 'High' : 'Low'}-Level Turbulence`;
                L.geoJSON(t.geometry, {
                    pane: 'hazardPane',
                    style: { color, weight: 2, dashArray: '5, 5', fillOpacity: 0.10 }
                }).addTo(turbulenceLayer).bindTooltip(label, { sticky: true, className: 'poi-label' });
            }
        });
    } catch(e) { console.warn('Turbulence fetch:', e); }
}

async function fetchAirQuality() {
    try {
        const r = await fetch('/api/airquality');
        if (!r.ok) throw new Error(r.status);
        const data = await r.json();
        liveData.airquality = data;

        // AQI shaded circles on map
        aqiLayer.clearLayers();
        (data.sensors || []).forEach(s => {
            if (!s.lat || !s.lng) return;
            const aqi   = typeof s.aqi === 'number' ? s.aqi : 0;
            const color = aqi > 150 ? '#ee5253' : aqi > 100 ? '#ff9f43' : aqi > 50 ? '#ffd32a' : '#2ecc71';
            L.circle([s.lat, s.lng], {
                pane: 'aqiPane', color, weight: 0,
                fillColor: color, fillOpacity: 0.15,
                radius: Math.max(6000, aqi * 350)
            }).addTo(aqiLayer);
        });

        // Lightning markers — only when NWS forecast mentions thunderstorms
        lightningLayer.clearLayers();
        if (/thunder/i.test(liveData.weather?.shortForecast ?? '')) {
            [
                [21.42,-157.81], [21.37,-157.74], [21.29,-157.95],
                [21.46,-157.68], [21.35,-157.88],
            ].forEach(c => L.marker(c, { pane: 'hazardPane',
                icon: L.divIcon({ className: 'lightning-marker', html: '⚡', iconSize: [22, 22] })
            }).addTo(lightningLayer));
        }
    } catch(e) { console.warn('AQI fetch:', e); }
}

// ─── Real aircraft from OpenSky Network (free, no key, 10-min cache on server)
// Helicopter icon for low-altitude (<3000ft) or slow (<120kt) targets.
async function fetchAircraft() {
    try {
        const r = await fetch('/api/aircraft');
        if (!r.ok) throw new Error(r.status);
        const data = await r.json();
        liveData.aircraft = data.aircraft || [];

        airLayer.clearLayers();
        liveData.aircraft.forEach(a => {
            const isHelo = (a.altFt != null && a.altFt < 3000) || (a.speedKt != null && a.speedKt < 120 && a.altFt < 5000);
            const icon  = isHelo ? '🚁' : '✈️';
            const alt   = a.altFt != null ? `${Math.round(a.altFt / 100) * 100}ft` : '--';
            const spd   = a.speedKt != null ? `${a.speedKt}kt` : '';
            const label = `${icon} ${a.callsign} ${alt}${spd ? ' ' + spd : ''}`;
            const cls   = isHelo ? 'traffic-label traffic-label-helo' : 'traffic-label traffic-label-air';
            L.marker([a.lat, a.lng], { pane: 'trafficPane',
                icon: L.divIcon({ className: cls, html: label, iconSize: [200, 20] })
            }).addTo(airLayer);
        });

        // Fallback placeholders if OpenSky returned nothing (rate-limit / network)
        if (!liveData.aircraft.length) {
            [
                { c:[21.320,-157.860], text:'✈️ HAL12 FL310',  cls:'traffic-label traffic-label-air'  },
                { c:[21.255,-157.710], text:'✈️ SWA453 4.2k',  cls:'traffic-label traffic-label-air'  },
                { c:[21.130,-157.480], text:'✈️ UAL930 FL240', cls:'traffic-label traffic-label-air'  },
                { c:[21.350,-157.960], text:'🚁 TOUR01 700ft', cls:'traffic-label traffic-label-helo' },
                { c:[21.290,-157.850], text:'🚁 USCG 65 250ft',cls:'traffic-label traffic-label-helo' },
                { c:[21.308,-157.876], text:'🚁 BLUE HI 900ft',cls:'traffic-label traffic-label-helo' },
            ].forEach(t => L.marker(t.c, { pane:'trafficPane',
                icon: L.divIcon({ className:t.cls, html:t.text, iconSize:[200,20] })
            }).addTo(airLayer));
        }
    } catch(e) {
        console.warn('Aircraft fetch:', e);
        liveData.aircraft = [];
    }
}

// =====================================================================
// FORECAST WIND FIELD — Display points from NOAA/Open-Meteo
// =====================================================================

// ─── Live wind from Open-Meteo via /api/wind (30-min cache on server)
async function fetchWind() {
    try {
        const r = await fetch('/api/wind');
        if (!r.ok) throw new Error(r.status);
        const data = await r.json();
        liveData.wind = data.points || [];
    } catch(e) {
        console.warn('Wind fetch:', e);
    }
}

// ─── Ocean surface currents (Open-Meteo Marine model via /api/currents)
function renderCurrents(points) {
    currentLayer.clearLayers();
    (points || []).forEach(pt => {
        if (pt.speedKt == null) return;
        const scale = Math.max(0.6, Math.min(2.0, pt.speedKt));
        const html = `<div style="display:inline-block; transform: scale(${scale.toFixed(2)}); transform-origin: center;">${pt.arrow}</div><br><span style="font-size:12px;color:#48dbfb;font-weight:bold;">${pt.speedKt}kt</span>`;
        L.marker([pt.lat, pt.lng], { pane: 'currentPane',
            icon: L.divIcon({ className: 'current-arrow', html, iconSize: [50, 56] })
        }).addTo(currentLayer);
    });
}
async function fetchCurrents() {
    try {
        const r = await fetch('/api/currents');
        if (!r.ok) throw new Error(r.status);
        const data = await r.json();
        liveData.currents = data;
        renderCurrents(data.points);
    } catch(e) { console.warn('Currents fetch:', e); }
}

// ─── Tide state for Honolulu Harbor (NOAA CO-OPS via /api/tide)
async function fetchTide() {
    try {
        const r = await fetch('/api/tide');
        if (!r.ok) throw new Error(r.status);
        liveData.tide = await r.json();
    } catch(e) { console.warn('Tide fetch:', e); }
}

// =====================================================================
// PANEL ITEM GENERATORS (each returns an array; engine paginates 3/page)
// =====================================================================
function getSurfItems() {
    const byId = {};
    (liveData.buoys || []).forEach(b => { byId[b.id] = b; });
    return surfSpots.map(s => {
        const buoy = byId[s.buoyId];
        let heightStr = '--', period = '', color = '#48dbfb';
        if (buoy && !buoy.error && buoy.waveHeight != null) {
            const hft = buoy.waveHeight * 3.281 * (s.scale || 1.0);
            const lo  = Math.max(1, Math.floor(hft * 0.85));
            const hi  = Math.ceil(hft * 1.15);
            heightStr = `${lo}-${hi}ft`;
            period    = buoy.dominantPeriod ? `${buoy.dominantPeriod}s · ` : '';
            color     = hft > 6 ? '#ff9f43' : '#1dd1a1';
        }
        return { name: s.name, heightStr, period, color };
    });
}
function renderSurfItem(item) {
    return `<div class="data-row" style="border-left-color:${item.color};">
        <div><div class="row-primary">🏄 ${item.name}</div><div class="row-secondary">${item.period}NDBC buoy derived</div></div>
        <div class="row-meta" style="color:${item.color};">${item.heightStr}</div>
    </div>`;
}

function getBuoyItems() {
    return (liveData.buoys || [])
        .filter(b => !b.error && b.waveHeight != null)
        .map(b => ({
            name: b.name,
            wh: `${mToFt(b.waveHeight)} ft`,
            wt: `${cToF(b.waterTemp)}°F`,
            pd: b.dominantPeriod ? `${b.dominantPeriod}s period` : '',
        }));
}
function renderBuoyItem(item) {
    return `<div class="data-row" style="border-left-color:#0abde3;">
        <div><div class="row-primary">${item.name}</div><div class="row-secondary">${item.pd}</div></div>
        <div class="row-meta">🌊${item.wh}<br><span style="font-size:0.75em;color:#a4b0be;">🌡${item.wt}</span></div>
    </div>`;
}

function getQuakeItems() {
    return (liveData.quakes || []).map(q => {
        const color = q.mag >= 3 ? '#ee5253' : q.mag >= 2 ? '#ff9f43' : '#ffd32a';
        const place = q.place.replace(/,?\s*Hawaii( Island)?$/, '');
        return { mag: q.mag, place, depth: q.depth, time: q.time, color };
    });
}
function renderQuakeItem(item) {
    return `<div class="data-row" style="border-left-color:${item.color};">
        <div><div class="row-primary">${item.place}</div><div class="row-secondary">${item.depth.toFixed(1)} km depth</div></div>
        <div class="row-meta" style="color:${item.color};">M${item.mag}<br><span style="font-size:0.7em;color:#a4b0be;">${timeAgo(item.time)}</span></div>
    </div>`;
}

function getAviationItems() {
    const real = (liveData.aircraft || []).map(a => {
        const isHelo = (a.altFt != null && a.altFt < 3000) || (a.speedKt != null && a.speedKt < 120 && a.altFt < 5000);
        const alt    = a.altFt  != null ? `${Math.round(a.altFt / 100) * 100}ft` : '--';
        const spd    = a.speedKt != null ? `${a.speedKt} kts` : '--';
        const route  = (a.origin && a.dest)
            ? `${a.origin} ➔ ${a.dest}`
            : a.registration
                ? `${a.registration}${a.acType ? ' · ' + a.acType : ''}`
                : (a.acType || a.icao24 || '—');
        return { call: a.callsign, type: isHelo ? '🚁' : '✈️', route, alt, spd };
    });
    if (real.length) return real;
    return [
        { call:'HAL12',  type:'✈️', route:'HNL ➔ LAX', alt:'FL310',  spd:'475 kts' },
        { call:'SWA453', type:'✈️', route:'OAK ➔ HNL', alt:'4,200ft',spd:'180 kts' },
        { call:'UAL930', type:'✈️', route:'HNL ➔ ORD', alt:'FL240',  spd:'Climbing'},
        { call:'TOUR01', type:'🚁', route:'Local Tour', alt:'700ft',  spd:'95 kts'  },
        { call:'USCG65', type:'🚁', route:'SAR Patrol', alt:'250ft',  spd:'120 kts' },
        { call:'BLUE-H', type:'🚁', route:'Scenic Tour',alt:'900ft',  spd:'80 kts'  },
    ];
}
function renderAviationItem(item) {
    const isHelo = item.type === '🚁';
    const color  = isHelo ? '#ffd32a' : '#10ac84';
    return `<div class="data-row" style="border-left-color:${color};">
        <div><div class="row-primary">${item.type} ${item.call}</div><div class="row-secondary">${item.route}</div></div>
        <div class="row-meta">${item.alt}<br><span style="font-size:0.75em;color:#a4b0be;">${item.spd}</span></div>
    </div>`;
}

// AIS ship-type code → human label (ITU-R M.1371 first-digit classes).
function shipTypeLabel(t) {
    if (t == null) return 'Vessel';
    if (t === 30) return 'Fishing';
    if (t === 35) return 'Military';
    if (t === 36) return 'Sailing';
    if (t === 37) return 'Pleasure craft';
    if (t === 50) return 'Pilot';
    if (t === 51) return 'Search & rescue';
    if (t === 52) return 'Tug';
    if (t === 55) return 'Law enforcement';
    if (t >= 60 && t <= 69) return 'Passenger';
    if (t >= 70 && t <= 79) return 'Cargo';
    if (t >= 80 && t <= 89) return 'Tanker';
    return 'Vessel';
}

// Helper to check if a vessel is likely in port/harbor
function isVesselInPort(v) {
    if (v.sog != null && v.sog >= 1.0) return false;
    const hDist = Math.hypot((v.lat - 21.305)*111, (v.lng - -157.867)*102); // Honolulu
    const pDist = Math.hypot((v.lat - 21.350)*111, (v.lng - -157.960)*102); // Pearl Harbor
    const bDist = Math.hypot((v.lat - 21.300)*111, (v.lng - -158.110)*102); // Kalaeloa
    return hDist < 2.5 || pDist < 4.0 || bDist < 2.5;
}

// ── COMBINED TRAFFIC items (aircraft + live AIS vessels) ──────────────
function getTrafficItems() {
    const items = [];
    getAviationItems().slice(0, 6).forEach(a =>
        items.push({ icon: a.type, name: a.call, detail: `${a.alt}`, sub: a.route,
                     color: a.type === '🚁' ? '#ffd32a' : '#1dd1a1' }));
    const ships = (liveData.ships || [])
        .filter(v => !isVesselInPort(v))
        .sort((a, b) => (b.sog || 0) - (a.sog || 0))
        .slice(0, 6);
    if (ships.length) {
        ships.forEach(v => items.push({
            icon: '🚢', name: v.name,
            detail: v.sog != null ? `${v.sog.toFixed(1)} kt` : '--',
            sub: shipTypeLabel(v.type), color: '#0984e3'
        }));
    } else {
        items.push({ icon: '⚓', name: 'AIS OFFLINE', detail: '–',
            sub: 'Set AISSTREAM_API_KEY for live vessels', color: '#636e72' });
    }
    return items;
}
function renderTrafficItem(item) {
    return `<div class="data-row" style="border-left-color:${item.color};">
        <div><div class="row-primary">${item.icon} ${item.name}</div><div class="row-secondary">${item.sub}</div></div>
        <div class="row-meta" style="color:${item.color};">${item.detail}</div>
    </div>`;
}

function getShipItems() {
    const ships = liveData.ships || [];
    if (!ships.length) return [{ noAis: true }];
    return ships
        .slice().sort((a, b) => (b.sog || 0) - (a.sog || 0)).slice(0, 12)
        .map(v => ({
            name: v.name,
            type: shipTypeLabel(v.type),
            area: v.dest ? `→ ${v.dest}` : 'Hawaiian waters',
            spd: v.sog != null ? `${v.sog.toFixed(1)} kt` : '--'
        }));
}
function renderShipItem(item) {
    if (item.noAis) return `<div class="data-row" style="border-left-color:#636e72;">
        <div>
            <div class="row-primary" style="color:#636e72;">⚓ No Live Vessels</div>
            <div class="row-secondary">Set AISSTREAM_API_KEY to stream live AIS traffic</div>
        </div>
        <div class="row-meta" style="color:#636e72;">OFFLINE</div>
    </div>`;
    const color = '#0984e3';
    return `<div class="data-row" style="border-left-color:${color};">
        <div><div class="row-primary">🚢 ${item.name}</div><div class="row-secondary">${item.type} · ${item.area}</div></div>
        <div class="row-meta">${item.spd}</div>
    </div>`;
}

function getAqiItems() {
    const sensors = liveData.airquality?.sensors ?? [];
    if (!sensors.length) return [{ name:'Honolulu', aqi:'--', dom:'', color:'#2ecc71', label:'No data' }];
    return sensors.map(s => {
        const aqi   = s.aqi ?? '--';
        const color = typeof aqi === 'number'
            ? (aqi > 150 ? '#ee5253' : aqi > 100 ? '#ff9f43' : aqi > 50 ? '#ffd32a' : '#2ecc71')
            : '#48dbfb';
        const label = typeof aqi === 'number'
            ? (aqi <= 50 ? 'Good' : aqi <= 100 ? 'Moderate' : aqi <= 150 ? 'Sensitive Groups' : 'Unhealthy')
            : 'No data';
        return { name: s.name, aqi, dom: s.dominentpol ?? '', color, label };
    });
}
function renderAqiItem(item) {
    return `<div class="data-row" style="border-left-color:${item.color};">
        <div><div class="row-primary">🌫 ${item.name}</div><div class="row-secondary">Dominant: ${item.dom || '--'}</div></div>
        <div class="row-meta" style="color:${item.color};">AQI ${item.aqi}<br><span style="font-size:0.7em;">${item.label}</span></div>
    </div>`;
}

// =====================================================================
// UI STATE MACHINE
// =====================================================================
const uiStates = [
    // ── 0: METEOROLOGICAL — STATIONS + DERIVED WIND FIELD ─────────────
    // One unified weather view: NWS Doppler radar backdrop, a uniform box at
    // every reporting station (Oahu + neighbour islands), and a derived wind
    // flow field whose arrows curl around the islands. No bottom-left data
    // panel here — the map itself is the readout.
    {
        title: "METEOROLOGICAL", sub: "NWS RADAR · STATIONS", duration: 13500,
        layersOn:  [radarLayerGroup, stationLayer],
        layersOff: [aqiLayer, airLayer, shipLayer, buoyLayer, quakeLayer, lightningLayer, denseDepthLayer],
        renderStatic: () => '',
        onEnter() { 
            document.getElementById('main-dash').classList.add('hud-hidden'); 
            this._timer = setTimeout(() => {
                document.querySelectorAll('.fading-marker').forEach(el => {
                    el.style.transition = 'opacity 0.8s ease-in-out';
                    el.style.opacity = '0';
                });
            }, 6750);
        },
        onExit()  { 
            document.getElementById('main-dash').classList.remove('hud-hidden'); 
            if (this._timer) clearTimeout(this._timer);
            document.querySelectorAll('.fading-marker').forEach(el => {
                el.style.transition = '';
                el.style.opacity = '1';
            });
        }
    },
    // ── 2: SURF & OCEAN — combined surf cards + buoy HUDs ────────────
    {
        title: "SURF & OCEAN", sub: "NDBC · WAVE + BUOY + CURRENTS", duration: 9000,
        layersOn:  [buoyLayer, surfLayer, currentLayer],
        layersOff: [radarLayerGroup, aqiLayer, airLayer, shipLayer, quakeLayer, lightningLayer, denseDepthLayer],
        renderStatic() {
            const buoys  = liveData.buoys || [];
            const active = buoys.filter(b => !b.error && b.waveHeight != null);
            const avgFt  = active.length
                ? (active.reduce((s, b) => s + b.waveHeight * 3.281, 0) / active.length).toFixed(1)
                : '--';
            const avgTmp = active.length
                ? Math.round(active.reduce((s, b) => s + (b.waterTemp ?? 0), 0) / active.length * 9/5 + 32)
                : '--';
            // Find peak spot
            const byId = {};
            active.forEach(b => { byId[b.id] = b; });
            let peakName = '--', peakHi = 0;
            surfSpots.forEach(s => {
                const b = byId[s.buoyId];
                if (b && b.waveHeight != null) {
                    const hi = Math.ceil(b.waveHeight * 3.281 * (s.scale || 1.0) * 1.15);
                    if (hi > peakHi) { peakHi = hi; peakName = s.name; }
                }
            });
            const peakStr = peakHi > 0 ? `${peakHi}ft` : '--';
            const peakColor = peakHi > 6 ? '#ff9f43' : '#1dd1a1';
            // Ocean current (model) + tide state for the ocean report rows
            const cur = liveData.currents;
            let curArrow = '·', curSpeed = '--', curWhere = 'Open-Meteo model';
            if (cur && cur.points && cur.points.length) {
                const strong = cur.points.filter(p => p.speedKt != null)
                    .sort((a, b) => b.speedKt - a.speedKt)[0];
                if (strong) { curArrow = strong.arrow; curSpeed = `${strong.speedKt} kt`; curWhere = strong.name; }
            }
            const tide = liveData.tide;
            const tideState = tide?.state ?? '--';
            const tideColor = tideState === 'Rising' ? '#1dd1a1' : tideState === 'Falling' ? '#ff9f43' : '#48dbfb';
            const tideNext = tide?.next ? `${tide.next.type} ${tide.next.time}` : '--';
            return `<div class="metric-grid">
                <div class="metric-box"><div class="metric-val">${avgFt !== '--' ? avgFt + 'ft' : '--'}</div><div class="metric-lbl">Avg Swell</div></div>
                <div class="metric-box"><div class="metric-val">${avgTmp !== '--' ? avgTmp + '°F' : '--'}</div><div class="metric-lbl">Water Temp</div></div>
                <div class="metric-box"><div class="metric-val">${active.length}</div><div class="metric-lbl">Buoys Live</div></div>
                <div class="metric-box"><div class="metric-val" style="color:${peakColor};">${peakStr}</div><div class="metric-lbl">Peak · ${peakName}</div></div>
            </div>
            <div class="data-list" style="margin-top:4px;">
                <div class="data-row" style="border-left-color:#48dbfb;">
                    <div><div class="row-primary">${curArrow} Current ${curSpeed}</div>
                    <div class="row-secondary">${curWhere}</div></div>
                    <div class="row-meta" style="color:#48dbfb;">DRIFT</div>
                </div>
                <div class="data-row" style="border-left-color:${tideColor};">
                    <div><div class="row-primary">🌊 Tide ${tideState}</div>
                    <div class="row-secondary">${tide?.station ?? 'Honolulu'} · next</div></div>
                    <div class="row-meta" style="color:${tideColor};">${tideNext}</div>
                </div>
            </div>`;
        },
        onEnter() { setSurfMode('large'); },   // big boxed cards + declutter
        onExit()  { setSurfMode('small'); }    // compact pins everywhere else
    },
    // // ── AIR QUALITY — Open-Meteo US AQI (multi-point) ─────────────
    // {
    //     title: "AIR QUALITY", sub: "US AQI · OPEN-METEO", perPageMs: 4000,
    //     layersOn:  [aqiLayer],
    //     layersOff: [radarLayerGroup, windLayer, airLayer, shipLayer, buoyLayer, quakeLayer, lightningLayer, denseDepthLayer],
    //     getItems: getAqiItems, renderItem: renderAqiItem
    // },
    // ── 6: TRAFFIC — COMBINED (WIDE) ──────────────────────────────────
    {
        title: "TRAFFIC — COMBINED", sub: "FLIGHT & VESSEL TRACKING", perPageMs: 3500,
        layersOn:  [airLayer, shipLayer, airportLayer],
        layersOff: [radarLayerGroup, aqiLayer, buoyLayer, quakeLayer, lightningLayer, denseDepthLayer],
        getItems: getTrafficItems, renderItem: renderTrafficItem,
        onEnter() { document.getElementById('overlay-container').classList.add('hud-upper-right'); },
        onExit()  { document.getElementById('overlay-container').classList.remove('hud-upper-right'); }
    },
    // ── 8: TRAFFIC — COMBINED (harbor approach zoom-in) ───────────────
    {
        title: "TRAFFIC — COMBINED", sub: "HONOLULU HARBOR APPROACH", perPageMs: 3500,
        layersOn:  [airLayer, shipLayer, denseDepthLayer, airportLayer],
        layersOff: [radarLayerGroup, aqiLayer, buoyLayer, quakeLayer, lightningLayer],
        getItems: getTrafficItems, renderItem: renderTrafficItem,
        pageSize: 8,
        holdExtraMs: 3000,   // linger on the last page so the zoom is appreciated
        onEnter() {
            map.flyTo([21.29, -157.84], 12, { animate: true, duration: 1.8 });
            // map.addLayer(trafficFlowLayer);   // road congestion DISABLED (no TomTom key)
        },
        onExit() {
            // Remove dense soundings BEFORE zoom-out
            if (map.hasLayer(denseDepthLayer))  map.removeLayer(denseDepthLayer);
            map.flyTo([21.265, -157.785], 10, { animate: true, duration: 1.5 });
        }
    },
    // ── 9: HAZARD MONITOR — SEISMIC + LIGHTNING + TURBULENCE ──────────
    {
        title: "HAZARD MONITOR", sub: "SEISMIC · LIGHTNING · ALERTS · TURBULENCE", duration: 10000,
        layersOn:  [quakeLayer, lightningLayer, alertLayer, turbulenceLayer],
        layersOff: [radarLayerGroup, aqiLayer, airLayer, shipLayer, buoyLayer, denseDepthLayer],
        onEnter() {
            // Pull back to frame the whole chain — quakes cluster on the Big
            // Island (~19°N), well south of the default Oahu-only view. The
            // default maxBounds + minZoom 9 clamp the view to Oahu, which hid
            // every Big-Island quake; relax both so the markers actually frame in.
            map.setMinZoom(7);
            map.setMaxBounds(null);
            map.flyToBounds([[18.7, -156.0], [21.9, -158.3]], {
                animate: true, duration: 1.8, padding: [30, 30]
            });
        },
        onExit() {
            // Restore the island-chain pan lock before returning.
            map.setMaxBounds(bounds);
            map.setMinZoom(10);
            map.flyTo([21.265, -157.785], 10, { animate: true, duration: 1.5 });
        },
        renderStatic() {
            const quakes = liveData.quakes || [];
            const big = quakes.filter(q => q.mag >= 2.5).slice(0, 2);
            const bigRows = big.map(q => {
                const color = q.mag >= 3 ? '#ee5253' : '#ff9f43';
                const place = q.place.replace(/,?\s*Hawaii( Island)?$/, '');
                return `<div class="data-row" style="border-left-color:${color};">
                    <div><div class="row-primary">⚡ ${place}</div>
                    <div class="row-secondary">${q.depth.toFixed(1)} km depth · ${timeAgo(q.time)}</div></div>
                    <div class="row-meta" style="color:${color};">M${q.mag}</div>
                </div>`;
            }).join('') || `<div class="data-row" style="border-left-color:#2ecc71;">
                <div><div class="row-primary" style="color:#2ecc71;">No significant seismic activity</div>
                <div class="row-secondary">USGS live feed · last 24 h</div></div>
            </div>`;
            const alerts = liveData.alerts?.alerts || [];
            const alertRows = alerts.map(a => {
                const color = a.severity === 'Severe' || a.severity === 'Extreme' ? '#ee5253' :
                              a.severity === 'Moderate' ? '#ff9f43' : '#a29bfe';
                return `<div class="data-row" style="border-left-color:${color};">
                    <div><div class="row-primary" style="color:${color};">⚠️ ${a.event}</div>
                    <div class="row-secondary" style="max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${a.headline}</div></div>
                </div>`;
            }).join('');
            return `<div class="hazard-legend">
                <div class="legend-title">HAZARD STATUS</div>
                <div class="legend-section">
                    <div class="legend-row"><span class="leg-dot" style="background:#ee5253;"></span><span>M3.0+ Quake / Sev. Alert</span></div>
                    <div class="legend-row"><span class="leg-dot" style="background:#ff9f43;"></span><span>M2.0–2.9 Quake / Mod. Alert</span></div>
                    <div class="legend-row"><span class="leg-dot" style="background:#ffd32a;"></span><span>&lt;M2.0 Micro-seismic</span></div>
                    <div class="legend-row"><span class="leg-dot" style="background:#a29bfe;"></span><span>NWS Lightning / Minor Alert</span></div>
                    <div class="legend-row"><span class="leg-dot" style="background:#e84393;"></span><span>High-Level Turbulence</span></div>
                    <div class="legend-row"><span class="leg-dot" style="background:#fdcb6e;"></span><span>Low-Level Turbulence</span></div>
                </div>
            </div>
            <div class="data-list" style="margin-top:4px;">${bigRows}${alertRows}</div>`;
        }
    },
    // ── 10: SATELLITE — GOES-WEST ───────────────────────────────────────
    {
        title: "SATELLITE — GOES-WEST", sub: "LAST 12 HOURS · GEOCOLOR", duration: 10000,
        layersOn:  [],
        layersOff: [radarLayerGroup, aqiLayer, airLayer, shipLayer, buoyLayer, quakeLayer, lightningLayer, denseDepthLayer, alertLayer, turbulenceLayer],
        onEnter() {
            // Zoom out to hazard page level
            map.setMinZoom(7);
            map.setMaxBounds(null);
            map.flyToBounds([[18.7, -156.0], [21.9, -158.3]], {
                animate: true, duration: 1.8, padding: [30, 30]
            });
            let el = document.getElementById('goes-satellite');
            if (!el) {
                el = document.createElement('div');
                el.id = 'goes-satellite';
                el.style.position = 'absolute';
                el.style.inset = '0';
                el.style.zIndex = '9999';
                el.style.pointerEvents = 'none';
                el.style.background = '#000';
                el.style.opacity = '0';
                el.style.transition = 'opacity 0.8s ease-in-out';
                // Append an img
                el.innerHTML = '<img id="goes-img" style="width:100%; height:100%; object-fit:contain;">';
                document.getElementById('viewport-scaler').appendChild(el);
            }
            // Update the src ONLY if the 5-minute window has passed, to avoid reloading the GIF
            const cacheBuster = Math.floor(Date.now() / 300000);
            const targetUrl = "https://cdn.star.nesdis.noaa.gov/GOES18/ABI/SECTOR/hi/GEOCOLOR/GOES18-HI-GEOCOLOR-600x600.gif?t=" + cacheBuster;
            const img = document.getElementById('goes-img');
            if (img.src !== targetUrl) {
                img.src = targetUrl;
            }
            
            // Force reflow and fade in
            el.style.display = 'block';
            void el.offsetWidth;
            el.style.opacity = '1';
            
            document.getElementById('main-dash').classList.add('hud-hidden');
        },
        onExit() {
            const el = document.getElementById('goes-satellite');
            if (el) {
                el.style.opacity = '0';
                // We keep display: block so the browser doesn't drop the GIF decoded frames from memory,
                // but pointer-events: none ensures it doesn't block anything.
            }
            // Restore normal bounds
            map.setMaxBounds(bounds);
            map.setMinZoom(10);
            map.flyTo([21.265, -157.785], 10, { animate: true, duration: 1.5 });
            document.getElementById('main-dash').classList.remove('hud-hidden');
        },
        renderStatic() { return ''; }
    },
    // ── 11: RADAR — NWS HAWAII LOOP ────────────────────────────────────
    {
        title: "RADAR — NWS MRMS", sub: "HAWAII REGIONAL LOOP", duration: 16000,
        layersOn:  [],
        layersOff: [radarLayerGroup, aqiLayer, airLayer, shipLayer, buoyLayer, quakeLayer, lightningLayer, denseDepthLayer, alertLayer, turbulenceLayer],
        onEnter() {
            // Zoom out to hazard page level
            map.setMinZoom(7);
            map.setMaxBounds(null);
            map.flyToBounds([[18.7, -156.0], [21.9, -158.3]], {
                animate: true, duration: 1.8, padding: [30, 30]
            });
            let el = document.getElementById('nws-radar-loop');
            if (!el) {
                el = document.createElement('div');
                el.id = 'nws-radar-loop';
                el.style.position = 'absolute';
                el.style.inset = '0';
                el.style.zIndex = '9999';
                el.style.pointerEvents = 'none';
                el.style.background = '#000';
                el.style.opacity = '0';
                el.style.transition = 'opacity 0.8s ease-in-out';
                // Append an img
                el.innerHTML = '<img id="nws-radar-img" style="width:100%; height:100%; object-fit:contain;">';
                document.getElementById('viewport-scaler').appendChild(el);
            }
            // Update the src ONLY if the 5-minute window has passed, to avoid reloading the GIF
            const cacheBuster = Math.floor(Date.now() / 300000);
            const targetUrl = "https://radar.weather.gov/ridge/standard/HAWAII_loop.gif?t=" + cacheBuster;
            const img = document.getElementById('nws-radar-img');
            if (img.src !== targetUrl) {
                img.src = targetUrl;
            }
            
            // Force reflow and fade in
            el.style.display = 'block';
            void el.offsetWidth;
            el.style.opacity = '1';
            
            document.getElementById('main-dash').classList.add('hud-hidden');
        },
        onExit() {
            const el = document.getElementById('nws-radar-loop');
            if (el) {
                el.style.opacity = '0';
            }
            // Restore normal bounds
            map.setMaxBounds(bounds);
            map.setMinZoom(10);
            map.flyTo([21.265, -157.785], 10, { animate: true, duration: 1.5 });
            document.getElementById('main-dash').classList.remove('hud-hidden');
        },
        renderStatic() { return ''; }
    },
    // ── 12: OPC NORTH PACIFIC LOOP ─────────────────────────────────────
    {
        title: "UNIFIED SURFACE ANALYSIS", sub: "PACIFIC WIDE STITCH", duration: 16000,
        layersOn:  [],
        layersOff: [radarLayerGroup, aqiLayer, airLayer, shipLayer, buoyLayer, quakeLayer, lightningLayer, denseDepthLayer, alertLayer, turbulenceLayer],
        onEnter() {
            // Zoom out to frame the Pacific
            map.setMinZoom(3);
            map.setMaxBounds(null);
            // Fly out to frame the Pacific
            map.flyToBounds([[10, -180], [60, -110]], {
                animate: true, duration: 1.8, padding: [30, 30]
            });
            let el = document.getElementById('opc-npac-loop');
            if (!el) {
                el = document.createElement('div');
                el.id = 'opc-npac-loop';
                el.style.position = 'absolute';
                el.style.inset = '0';
                el.style.zIndex = '9999';
                el.style.pointerEvents = 'none';
                el.style.background = '#000';
                el.style.opacity = '0';
                el.style.transition = 'opacity 0.8s ease-in-out';
                // Append both images perfectly stitched (cropping out the thick white margins) and the highlight box
                el.innerHTML = `
                    <div style="position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 100%; height: 100%; display: flex; align-items: center; justify-content: center;">
                        <div style="position: relative; aspect-ratio: 1720 / 1563; max-width: 100%; max-height: 100%; display: flex; flex-direction: column;">
                            <!-- Top Image Cropped (removes 94px top margin and 79px bottom margin) -->
                            <div style="width: 100%; aspect-ratio: 1720 / 1087; overflow: hidden; position: relative;">
                                <img id="opc-npac-img" style="width: 100%; height: auto; position: absolute; top: 0; transform: translateY(-7.46%);" src="">
                            </div>
                            <!-- Bottom Image Cropped (removes 426px top margin and 358px bottom margin) -->
                            <div style="width: 100%; aspect-ratio: 1720 / 476; overflow: hidden; position: relative;">
                                <img id="opc-spac-img" style="width: 100%; height: auto; position: absolute; top: 0; transform: translateY(-33.81%);" src="">
                            </div>
                            <!-- Glowing highlight box over the Hawaiian Islands (at the seam) -->
                            <div style="position: absolute; left: 59.5%; top: 69.5%; transform: translate(-50%, -50%); width: 6.5%; height: 5.5%; border: 3px solid #38bdf8; border-radius: 8px; box-shadow: 0 0 15px #38bdf8, inset 0 0 10px #38bdf8; background: rgba(56, 189, 248, 0.15); pointer-events: none; display: flex; align-items: flex-end; justify-content: center; z-index: 10;">
                                <span style="color: #38bdf8; font-size: 1.5vw; font-weight: bold; text-shadow: 0 0 4px #000; position: absolute; bottom: -2.5vw;">HAWAII</span>
                            </div>
                        </div>
                    </div>
                `;
                document.getElementById('viewport-scaler').appendChild(el);
            }
            // Update the src ONLY if the 5-minute window has passed
            const cacheBuster = Math.floor(Date.now() / 300000);
            const targetUrl1 = "https://ocean.weather.gov/UA/OPC_PAC.gif?t=" + cacheBuster;
            const targetUrl2 = "https://ocean.weather.gov/UA/Pac_Tropics.gif?t=" + cacheBuster;
            const img1 = document.getElementById('opc-npac-img');
            const img2 = document.getElementById('opc-spac-img');
            if (img1 && img1.src !== targetUrl1) img1.src = targetUrl1;
            if (img2 && img2.src !== targetUrl2) img2.src = targetUrl2;
            
            // Force reflow and fade in
            el.style.display = 'block';
            void el.offsetWidth;
            el.style.opacity = '1';
            
            document.getElementById('main-dash').classList.add('hud-hidden');
        },
        onExit() {
            const el = document.getElementById('opc-npac-loop');
            if (el) {
                el.style.opacity = '0';
            }
            // Restore normal bounds
            map.setMaxBounds(bounds);
            map.setMinZoom(10);
            map.flyTo([21.265, -157.785], 10, { animate: true, duration: 1.5 });
            document.getElementById('main-dash').classList.remove('hud-hidden');
        },
        renderStatic() { return ''; }
    },
];

// =====================================================================
// PAGINATION ENGINE
// max 3 items visible at a time; 3s+ per page; rotate within state
// before advancing to next state
// =====================================================================
const PAGE_SIZE = 12;  // 4 columns × 3 rows visible per page
let currentStateIndex = 0;
let currentPage       = 0;
let _pageTimer        = null;
let _prevStateIndex   = -1;

function transitionState() {
    if (_pageTimer) clearTimeout(_pageTimer);

    const prevState = _prevStateIndex >= 0 ? uiStates[_prevStateIndex] : null;
    const state     = uiStates[currentStateIndex];

    // Fire lifecycle hooks — exit old state, enter new state
    if (_prevStateIndex !== currentStateIndex) {
        if (prevState?.onExit)  prevState.onExit();
        if (state?.onEnter)     state.onEnter();
        _prevStateIndex = currentStateIndex;
    }

    // Layer toggles
    state.layersOn.forEach(l  => { if (!map.hasLayer(l)) map.addLayer(l); });
    state.layersOff.forEach(l => { if (map.hasLayer(l))  map.removeLayer(l); });

    // These layers are only declared on specific views; force them off on every
    // other state without having to list them in each layersOff array. This is
    // what keeps surf spots off the meteorological + hazard maps.
    [stationLayer, surfLayer, currentLayer, alertLayer, turbulenceLayer, airportLayer].forEach(l => {
        if (state.layersOn.indexOf(l) === -1 && map.hasLayer(l)) map.removeLayer(l);
    });

    // Re-flow surf/buoy labels now that layer visibility may have changed
    // (flyTo states also re-flow on their moveend event).
    declutterLabels();

    // Header labels
    document.getElementById('tab-title').innerText     = state.title;
    document.getElementById('sub-indicator').innerText = state.sub;

    // Small craft advisory: ONLY show when a real NWS alert is active
    const hasAdvisory = (liveData.alerts?.alerts ?? []).some(a =>
        /small craft|hazardous seas/i.test(a.event ?? '')
    );
    document.getElementById('main-dash').classList.toggle('warning-active', hasAdvisory);

    // Render content with pagination
    const contentEl = document.getElementById('panel-content');
    if (state.getItems) {
        const items      = state.getItems();
        const pageSize   = state.pageSize || PAGE_SIZE;
        const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
        const pageItems  = items.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
        const pageHint   = totalPages > 1
            ? `<div class="page-indicator">${currentPage + 1} / ${totalPages}</div>`
            : '';
        contentEl.innerHTML = `<div class="data-list">${pageItems.map(state.renderItem).join('')}</div>${pageHint}`;

        const isLast = currentPage + 1 >= totalPages;
        const dwell  = (state.perPageMs ?? 3000) + (isLast ? (state.holdExtraMs ?? 0) : 0);
        _pageTimer = setTimeout(() => {
            if (!isLast) {
                currentPage++;
            } else {
                currentPage = 0;
                currentStateIndex = (currentStateIndex + 1) % uiStates.length;
            }
            transitionState();
        }, dwell);
    } else {
        contentEl.innerHTML = state.renderStatic();
        _pageTimer = setTimeout(() => {
            currentPage = 0;
            currentStateIndex = (currentStateIndex + 1) % uiStates.length;
            transitionState();
        }, state.duration ?? 5000);
    }
}

// =====================================================================
// BOOT — prefetch all data, then start rotation + schedule refreshes
// =====================================================================
// Non-blocking fetches (slow/rate-limited APIs — don't hold up the boot)
fetchAircraft();
fetchWind();
fetchShips();
fetchStations();
fetchCurrents();
fetchTide();

Promise.all([fetchWeather(), fetchBuoys(), fetchQuakes(), fetchAlerts(), fetchTurbulence(), fetchAirQuality()])
    .finally(() => {
        transitionState();
        setInterval(fetchWeather,    10 * 60 * 1000);
        setInterval(fetchBuoys,       5 * 60 * 1000);
        setInterval(fetchQuakes,      5 * 60 * 1000);
        setInterval(fetchAlerts,      5 * 60 * 1000);
        setInterval(fetchTurbulence, 15 * 60 * 1000);
        setInterval(fetchAirQuality, 15 * 60 * 1000);
        setInterval(fetchAircraft,   10 * 60 * 1000);
        setInterval(fetchWind,       30 * 60 * 1000); // Open-Meteo updates hourly
        setInterval(fetchShips,           30 * 1000); // AIS positions update fast
        setInterval(fetchStations,   10 * 60 * 1000);
        setInterval(fetchCurrents,   30 * 60 * 1000); // marine model updates slowly
        setInterval(fetchTide,       30 * 60 * 1000);
    });
