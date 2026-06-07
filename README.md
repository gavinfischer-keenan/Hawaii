# Hawaii Telemetry & Command Center

**Version:** 1.1.5
**Architecture:** Node.js (Express) Backend API + Vanilla JS/Leaflet.js Frontend

## Overview
The Hawaii Telemetry Command Center is an autonomous, rotating dashboard designed for continuous, unattended display. It fuses real-time data from over 10 distinct government and scientific APIs into a unified geographical interface. 

The system operates via a state machine that automatically cycles through specific views (Meteorological, Ocean, Air Quality, Traffic, and Hazards), toggling map layers, zoom levels, and HUD elements based on the active state.

---

## Data Sources
All data is proxied, normalized, and cached by the local Node.js backend to prevent client-side rate limiting and CORS issues. Connection drops to external APIs are mitigated via strict 8-second timeout abort signals to ensure continuous system uptime.

*   **Aviation Traffic:** ADSB.fi (Live ADS-B telemetry)
*   **Maritime Traffic:** AISStream / ADSB.fi (Live AIS telemetry)
*   **Airport Status:** FAA NAS Status (Live delay/closure data)
*   **Meteorology (Weather, Radar, Alerts, Stations):** National Weather Service (`api.weather.gov`)
*   **Earthquakes / Seismic:** USGS Earthquake Hazards Program
*   **Ocean Buoys:** NOAA National Data Buoy Center (NDBC)
*   **Ocean Currents:** Open-Meteo Marine API
*   **Ocean Temperatures & Wave Models:** PacIOOS (ROMS & SWAN WMS layers)
*   **Tides:** NOAA CO-OPS
*   **Aviation Hazards / Turbulence:** Aviation Weather Center (AWC)
*   **Air Quality (AQI):** PurpleAir API
*   **Wind Vectors:** Open-Meteo

---

## Core UI States & Features (v1.1.4)

The dashboard automatically rotates through the following states:

### 1. Meteorological (Oahu View)
*   **Visuals:** NWS Doppler Radar overlay, localized wind vectors, and NWS land weather station markers.
*   **HUD:** A 7-day wrapping forecast box (top right) and a dedicated HNL Airport operational status box.
*   **Focus:** Immediate atmospheric conditions over Oahu.

### 2. Surf & Ocean (Oahu View)
*   **Visuals:** PacIOOS Significant Wave Height WMS overlay.
*   **HUD:** NDBC buoy cards showing wave heights, water temperatures, and periods. Includes NOAA tide charts and localized current speeds.
*   **Focus:** Marine conditions for vessels and surf tracking.

### 3. Air Quality (Oahu View)
*   **Visuals:** Real-time PurpleAir sensor markers color-coded to EPA standards.
*   **HUD:** AQI legend and sensor-specific readouts.
*   **Focus:** Particulate matter and localized air safety.

### 4. Traffic - Regional (Oahu View)
*   **Visuals:** Live rendering of all aircraft and vessels within the regional Oahu bounding box. 
*   **HUD:** Aircraft include altitude, speed, and origin/destination pairs. Vessels include speed and ship type.
*   **Focus:** Macro-level airspace and maritime awareness.

### 5. Traffic - Combined (Waikiki Zoom)
*   **Visuals:** A specialized, hyper-zoomed viewport locked from the Ala Wai Boat Harbor (left edge) to Diamond Head (right edge). Includes super-dense bathymetry overlays.
*   **HUD:** Real-time algorithmic tracker that specifically isolates and logs vessels moving within this tight coordinate box.
*   **Focus:** Micro-level monitoring of harbor exits and recreational zones.

### 6. Hazard Monitor (Hawaii Island Chain View)
*   **Visuals:** Zooms out to view the entire Hawaiian archipelago. Displays USGS seismic events, AWC turbulence polygons, NWS active weather alerts, and a PacIOOS ROMS ocean temperature underlay.
*   **HUD:** Consolidated hazard status legend, HNL airport status, and deep-ocean flight tracker (tracking flights originating from/destined for the mainland over the Pacific).
*   **Focus:** Macro-level threat assessment and tectonic activity.

---

## Out of Scope / Not Included
*   **Routing/Drive Times:** Real-time street-level traffic routing (e.g., Google Maps drive times) is not currently implemented.
*   **Interactive Input:** The UI is designed as a passive heads-up display (HUD); manual map panning/zooming will be overridden by the state machine's internal timers.
*   **Historical Data:** All visuals represent strictly *real-time* or *forecasted* data; historical playback is not supported.

---

## Release Notes

### v1.1.5 - Raspberry Pi Standalone Architecture Support
*   **Hardware Graceful Degradation (FPS Monitor):** Added an ongoing `requestAnimationFrame` loop that monitors client rendering FPS. If the FPS drops below 20 for 5 consecutive seconds (due to excessive SVG aircraft rendering or GPU constraints on a Raspberry Pi), the system automatically strips all GPU-heavy `backdrop-filter: blur(...)` elements to instantly restore performance without crashing the kiosk.
*   **Kiosk Auto-Flush:** Implemented a daily 24-hour automatic browser refresh to forcibly clear any creeping Chromium memory leaks during continuous 24/7 runtimes.
*   **Deployment Configurations:** Shipped with a `.env.example` template for secure local secret management and an `ecosystem.config.cjs` to enable robust background process management via PM2.
*   **API Resilience:** Rebuilt the Node.js backend to forcefully append `AbortSignal.timeout(8000)` to all 15+ external government/API data fetches, completely insulating the system against memory exhaustion from hanging remote sockets.
