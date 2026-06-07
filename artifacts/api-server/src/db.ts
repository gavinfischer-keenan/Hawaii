
import { logger } from './lib/logger.js';

export interface DBVessel { mmsi: number; name: string; type: number | null; first_seen: number; last_seen: number; visit_count: number; image_url: string | null; }
export interface DBAircraft { icao24: string; callsign: string; first_seen: number; last_seen: number; visit_count: number; image_url: string | null; }

const vessels = new Map<number, DBVessel>();
const aircraft = new Map<string, DBAircraft>();

export function logVesselObservation(mmsi: number, name: string, type: number | null) {
  const existing = vessels.get(mmsi);
  const now = Date.now();
  if (existing) {
    if (now - existing.last_seen > 6 * 60 * 60 * 1000) existing.visit_count++;
    existing.last_seen = now;
  } else {
    vessels.set(mmsi, { mmsi, name, type, first_seen: now, last_seen: now, visit_count: 1, image_url: null });
  }
}

export function getVesselMeta(mmsi: number): DBVessel | undefined { return vessels.get(mmsi); }

export function logAircraftObservation(icao24: string, callsign: string) {
  const existing = aircraft.get(icao24);
  const now = Date.now();
  if (existing) {
    if (now - existing.last_seen > 6 * 60 * 60 * 1000) existing.visit_count++;
    existing.last_seen = now;
  } else {
    aircraft.set(icao24, { icao24, callsign, first_seen: now, last_seen: now, visit_count: 1, image_url: null });
  }
}

export function getAircraftMeta(icao24: string): DBAircraft | undefined { return aircraft.get(icao24); }

