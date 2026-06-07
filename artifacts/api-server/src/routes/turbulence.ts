import { Router } from "express";

const router = Router();

let cache: { data: unknown; expiresAt: number } | null = null;
const CACHE_MS = 10 * 60 * 1000;

router.get("/turbulence", async (req, res) => {
  try {
    if (cache && Date.now() < cache.expiresAt) {
      res.json(cache.data);
      return;
    }

    // Fetch FAA/AWC Aviation Weather polygons for SIGMETs and AIRMETs
    // We fetch hazard=turb to get turbulence boxes
    const r = await fetch("https://aviationweather.gov/api/data/polygon?format=geojson&hazard=turb", { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`AWC Turbulence ${r.status}`);

    const json = await r.json() as any;
    const turbulence = [];

    if (json.features) {
      for (const f of json.features) {
        // Filter for Hawaii region (rough bounds)
        // AWC polygon coords can be tricky, but we just pass the geometry
        turbulence.push({
          hazard: f.properties?.hazard || "Turbulence",
          severity: f.properties?.severity || "Mod",
          minAlt: f.properties?.minAlt || 0,
          maxAlt: f.properties?.maxAlt || 0,
          geometry: f.geometry
        });
      }
    }

    const data = { turbulence, fetchedAt: Date.now() };
    cache = { data, expiresAt: Date.now() + CACHE_MS };
    res.json(data);
  } catch (err) {
    req.log.error({ err }, "Failed to fetch turbulence");
    res.status(502).json({ error: "Failed to fetch turbulence", turbulence: [] });
  }
});

export default router;

