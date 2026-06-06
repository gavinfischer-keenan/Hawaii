import Database from 'better-sqlite3';
import { logger } from './lib/logger.js';
import path from 'path';
import fs from 'fs';

// Use a local database file in the project root
const dbPath = path.resolve(process.cwd(), 'telemetry.db');
const db = new Database(dbPath);

// Initialize tables
db.exec(`
  CREATE TABLE IF NOT EXISTS vessels (
    mmsi INTEGER PRIMARY KEY,
    name TEXT,
    type INTEGER,
    first_seen INTEGER,
    last_seen INTEGER,
    visit_count INTEGER DEFAULT 1,
    image_url TEXT
  );

  CREATE TABLE IF NOT EXISTS aircraft (
    icao24 TEXT PRIMARY KEY,
    callsign TEXT,
    first_seen INTEGER,
    last_seen INTEGER,
    visit_count INTEGER DEFAULT 1,
    image_url TEXT
  );
`);

logger.info(`Initialized SQLite DB at ${dbPath}`);

export interface DBVessel {
  mmsi: number;
  name: string;
  type: number | null;
  first_seen: number;
  last_seen: number;
  visit_count: number;
  image_url: string | null;
}

export interface DBAircraft {
  icao24: string;
  callsign: string;
  first_seen: number;
  last_seen: number;
  visit_count: number;
  image_url: string | null;
}

// Prepared statements for Vessels
const getVesselStmt = db.prepare('SELECT * FROM vessels WHERE mmsi = ?');
const insertVesselStmt = db.prepare('INSERT INTO vessels (mmsi, name, type, first_seen, last_seen, visit_count) VALUES (?, ?, ?, ?, ?, 1)');
const updateVesselSeenStmt = db.prepare('UPDATE vessels SET last_seen = ?, visit_count = visit_count + 1 WHERE mmsi = ?');
const updateVesselLastSeenOnlyStmt = db.prepare('UPDATE vessels SET last_seen = ? WHERE mmsi = ?');
const updateVesselImageStmt = db.prepare('UPDATE vessels SET image_url = ? WHERE mmsi = ?');

export function logVesselObservation(mmsi: number, name: string, type: number | null) {
  try {
    const existing = getVesselStmt.get(mmsi) as DBVessel | undefined;
    const now = Date.now();
    if (existing) {
      // If it's been more than 6 hours since last_seen, count as a new visit
      if (now - existing.last_seen > 6 * 60 * 60 * 1000) {
        updateVesselSeenStmt.run(now, mmsi);
      } else {
        updateVesselLastSeenOnlyStmt.run(now, mmsi);
      }
    } else {
      insertVesselStmt.run(mmsi, name, type, now, now);
      // Trigger async image fetch
      fetchVesselImage(mmsi, name);
    }
  } catch (err) {
    logger.error({ err, mmsi }, 'DB logVesselObservation error');
  }
}

export function getVesselMeta(mmsi: number): DBVessel | undefined {
  return getVesselStmt.get(mmsi) as DBVessel | undefined;
}

// Prepared statements for Aircraft
const getAircraftStmt = db.prepare('SELECT * FROM aircraft WHERE icao24 = ?');
const insertAircraftStmt = db.prepare('INSERT INTO aircraft (icao24, callsign, first_seen, last_seen, visit_count) VALUES (?, ?, ?, ?, 1)');
const updateAircraftSeenStmt = db.prepare('UPDATE aircraft SET last_seen = ?, visit_count = visit_count + 1 WHERE icao24 = ?');
const updateAircraftLastSeenOnlyStmt = db.prepare('UPDATE aircraft SET last_seen = ? WHERE icao24 = ?');
const updateAircraftImageStmt = db.prepare('UPDATE aircraft SET image_url = ? WHERE icao24 = ?');

export function logAircraftObservation(icao24: string, callsign: string) {
  try {
    const existing = getAircraftStmt.get(icao24) as DBAircraft | undefined;
    const now = Date.now();
    if (existing) {
      if (now - existing.last_seen > 6 * 60 * 60 * 1000) {
        updateAircraftSeenStmt.run(now, icao24);
      } else {
        updateAircraftLastSeenOnlyStmt.run(now, icao24);
      }
    } else {
      insertAircraftStmt.run(icao24, callsign, now, now);
      // Trigger async image fetch
      fetchAircraftImage(icao24, callsign);
    }
  } catch (err) {
    logger.error({ err, icao24 }, 'DB logAircraftObservation error');
  }
}

export function getAircraftMeta(icao24: string): DBAircraft | undefined {
  return getAircraftStmt.get(icao24) as DBAircraft | undefined;
}

// --- Background Image Fetchers ---

const activeVesselFetches = new Set<number>();
const activeAircraftFetches = new Set<string>();

function fetchVesselImage(mmsi: number, name: string) {
  if (!name || name.startsWith("MMSI ")) return;
  if (activeVesselFetches.has(mmsi)) return;
  activeVesselFetches.add(mmsi);

  // Delay the fetch slightly to stagger bursts during bulk initialization
  setTimeout(async () => {
    try {
      // Attempt to search Wikimedia Commons
      const searchUrl = `https://en.wikipedia.org/w/api.php?action=query&format=json&prop=pageimages&generator=search&gsrsearch=${encodeURIComponent(name + " ship")}&gsrlimit=1&pithumbsize=400`;
      const res = await fetch(searchUrl);
      const data = await res.json() as any;
      if (data.query?.pages) {
        const pages = Object.values(data.query.pages) as any[];
        if (pages.length > 0 && pages[0].thumbnail?.source) {
          updateVesselImageStmt.run(pages[0].thumbnail.source, mmsi);
          logger.info(`Found image for vessel ${name}`);
        }
      }
    } catch (err) {
      logger.warn({ err, name }, 'fetchVesselImage error');
    } finally {
      activeVesselFetches.delete(mmsi);
    }
  }, 1000 + Math.random() * 2000);
}

function fetchAircraftImage(icao24: string, callsign: string) {
  if (!callsign) return;
  if (activeAircraftFetches.has(icao24)) return;
  activeAircraftFetches.add(icao24);

  // Delay the fetch slightly to stagger bursts during bulk initialization
  setTimeout(async () => {
    try {
      const searchUrl = `https://en.wikipedia.org/w/api.php?action=query&format=json&prop=pageimages&generator=search&gsrsearch=${encodeURIComponent(callsign.trim() + " aircraft")}&gsrlimit=1&pithumbsize=400`;
      const res = await fetch(searchUrl);
      const data = await res.json() as any;
      if (data.query?.pages) {
        const pages = Object.values(data.query.pages) as any[];
        if (pages.length > 0 && pages[0].thumbnail?.source) {
          updateAircraftImageStmt.run(pages[0].thumbnail.source, icao24);
          logger.info(`Found image for aircraft ${callsign}`);
        }
      }
    } catch (err) {
      logger.warn({ err, callsign }, 'fetchAircraftImage error');
    } finally {
      activeAircraftFetches.delete(icao24);
    }
  }, 1000 + Math.random() * 2000);
}
