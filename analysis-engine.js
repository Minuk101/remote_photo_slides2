import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { GoogleVisitService } from './google-visit-service.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(HERE, 'data');
const RESULT_FILE = path.join(DATA_DIR, 'visit-analysis.json');
const PHOTO_ROOTS = (process.env.PHOTO_ROOTS || 'D:\\민욱\\사진\\2025|D:\\민욱\\사진\\2026').split('|').filter(Boolean).map(value => path.resolve(value));
const GOOGLE_GPX = process.env.GPX_PATH || 'D:\\민욱\\타임라인\\google_maps\\260723\\timeline_export_1784779939485.gpx';
const GPSLOGGER_DIR = process.env.GPSLOGGER_DIR || 'D:\\민욱\\타임라인\\GPSLogger';
const OLD_CACHE = process.env.OLD_LOCATION_CACHE || 'D:\\민욱\\remote_slides\\data\\locations\\photo-locations.json';
const REPORT_DIR = process.env.GEOTAG_REPORT_DIR || 'D:\\민욱\\타임라인\\google_maps\\260723';
const PRIVATE_PLACES = process.env.PRIVATE_PLACES_FILE || 'D:\\민욱\\remote_slides\\data\\locations\\private-places.json';

const MAX_PHOTO_GAP_MS = 90 * 60_000;
const MAX_VISIT_DISTANCE_KM = 1.5;

function distanceKm(a, b) {
  if (!a || !b) return Infinity;
  const r = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * r;
  const dLon = (b.longitude - a.longitude) * r;
  const q = Math.sin(dLat / 2) ** 2 + Math.cos(a.latitude * r) * Math.cos(b.latitude * r) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(q), Math.sqrt(1 - q));
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function normalizeFile(value) {
  return path.resolve(value || '').replaceAll('/', '\\').toLocaleLowerCase('en-US');
}

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return fallback; }
}

async function atomicJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, 'utf8');
  await rename(temporary, file);
}

function parseTrackPoint(block, source, file) {
  const latitude = Number(block.match(/\blat="([^"]+)"/)?.[1]);
  const longitude = Number(block.match(/\blon="([^"]+)"/)?.[1]);
  const time = Date.parse(block.match(/<time>([^<]+)<\/time>/)?.[1] || '');
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || !Number.isFinite(time)) return null;
  const provider = block.match(/<src>([^<]+)<\/src>/)?.[1]?.toLowerCase() || source;
  const hdop = Number(block.match(/<hdop>([^<]+)<\/hdop>/)?.[1]);
  const speed = Number(block.match(/<speed>([^<]+)<\/speed>/)?.[1]);
  return { latitude, longitude, time, source, provider, hdop: Number.isFinite(hdop) ? hdop : null, speed: Number.isFinite(speed) ? speed : null, file };
}

async function parseGpxFile(file, source) {
  const xml = await readFile(file, 'utf8');
  return [...xml.matchAll(/<trkpt\b[\s\S]*?<\/trkpt>/gi)]
    .map(match => parseTrackPoint(match[0], source, path.basename(file)))
    .filter(Boolean);
}

async function loadTracks() {
  const google = await parseGpxFile(GOOGLE_GPX, 'google-timeline').catch(() => []);
  const loggerFiles = (await readdir(GPSLOGGER_DIR, { withFileTypes: true }).catch(() => []))
    .filter(item => item.isFile() && item.name.toLowerCase().endsWith('.gpx'))
    .map(item => path.join(GPSLOGGER_DIR, item.name));
  const gpsLogger = (await Promise.all(loggerFiles.map(file => parseGpxFile(file, 'gpslogger').catch(() => [])))).flat();
  const quality = point => point.source !== 'gpslogger' ? 1 : point.provider === 'gps' ? 3 : 2;
  const all = [...google, ...gpsLogger].sort((a, b) => a.time - b.time || quality(b) - quality(a));
  return { all, google, gpsLogger, gpsLoggerGps: gpsLogger.filter(point => point.provider === 'gps'), loggerFiles: loggerFiles.length };
}

function nearestIndex(points, time) {
  let low = 0, high = points.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (points[middle].time < time) low = middle + 1; else high = middle;
  }
  return low;
}

function estimateFrom(points, time, maxDeltaMs, source) {
  if (!points.length) return null;
  const index = nearestIndex(points, time);
  const before = points[index - 1];
  const after = points[index];
  const nearest = [before, after].filter(Boolean).sort((a, b) => Math.abs(a.time - time) - Math.abs(b.time - time))[0];
  if (!nearest || Math.abs(nearest.time - time) > maxDeltaMs) return null;
  if (before && after && before.time <= time && after.time >= time && after.time - before.time <= maxDeltaMs * 2) {
    const ratio = (time - before.time) / Math.max(1, after.time - before.time);
    const separation = distanceKm(before, after);
    if (separation < 30) return {
      latitude: before.latitude + (after.latitude - before.latitude) * ratio,
      longitude: before.longitude + (after.longitude - before.longitude) * ratio,
      timeDeltaSeconds: Math.round(Math.min(time - before.time, after.time - time) / 1000),
      source, method: 'interpolated', provider: before.provider === 'gps' || after.provider === 'gps' ? 'gps' : nearest.provider
    };
  }
  return { ...nearest, source, method: 'nearest', timeDeltaSeconds: Math.round(Math.abs(nearest.time - time) / 1000) };
}

function chooseTimelinePosition(tracks, time) {
  const loggerGpsValue = estimateFrom(tracks.gpsLoggerGps, time, 8 * 60_000, 'gpslogger-gps');
  if (loggerGpsValue) return loggerGpsValue;
  const loggerValue = estimateFrom(tracks.gpsLogger, time, 5 * 60_000, 'gpslogger-network');
  if (loggerValue) return loggerValue;
  return estimateFrom(tracks.google, time, 30 * 60_000, 'google-timeline');
}

async function listJpegs(roots) {
  const files = [];
  async function walk(folder) {
    const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const absolute = path.join(folder, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile() && /\.jpe?g$/i.test(entry.name)) files.push(absolute);
    }
  }
  for (const root of roots) await walk(root);
  return files;
}

function runExifTool(files) {
  return new Promise((resolve, reject) => {
    const args = ['-json', '-n', '-fast2', '-charset', 'filename=utf8', '-SourceFile', '-DateTimeOriginal', '-CreateDate', '-OffsetTimeOriginal', '-GPSLatitude', '-GPSLongitude', '-@', '-'];
    const child = spawn('exiftool', args, { windowsHide: true });
    const chunks = [], errors = [];
    child.stdout.on('data', chunk => chunks.push(chunk));
    child.stderr.on('data', chunk => errors.push(chunk));
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) return reject(new Error(Buffer.concat(errors).toString('utf8') || `ExifTool exited ${code}`));
      const output = Buffer.concat(chunks).toString('utf8');
      try { resolve(JSON.parse(output)); } catch (error) { reject(new Error(`ExifTool JSON을 읽지 못했습니다 (${output.length} bytes): ${error.message}`)); }
    });
    child.stdin.end(`${files.join('\n')}\n`, 'utf8');
  });
}

async function loadAssignments() {
  const files = (await readdir(REPORT_DIR, { withFileTypes: true }).catch(() => []))
    .filter(item => item.isFile() && /^geotag-report-.*\.json$/i.test(item.name));
  const map = new Map();
  for (const file of files) {
    const report = await readJson(path.join(REPORT_DIR, file.name), {});
    for (const item of report.assignments || []) map.set(normalizeFile(item.sourceFile), item);
  }
  return map;
}

function oldKeyFor(file) {
  for (const root of PHOTO_ROOTS) {
    const parent = path.dirname(root);
    const relative = path.relative(parent, file);
    if (!relative.startsWith('..')) return relative.split(path.sep).join('/');
  }
  return '';
}

function labelOf(value) { return value?.landmark || value?.city || value?.country || null; }

function photoTime(row) {
  const raw = row.DateTimeOriginal ?? row.CreateDate;
  if (Number.isFinite(Number(raw))) return Number(raw) * 1000;
  const match = String(raw || '').match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/);
  if (!match) return null;
  const offset = /^[-+]\d{2}:\d{2}$/.test(row.OffsetTimeOriginal || '') ? row.OffsetTimeOriginal : '+09:00';
  return Date.parse(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}${offset}`);
}

function positionForPhoto(row, tracks, assignments) {
  const time = photoTime(row);
  const embedded = Number.isFinite(row.GPSLatitude) && Number.isFinite(row.GPSLongitude)
    ? { latitude: row.GPSLatitude, longitude: row.GPSLongitude }
    : null;
  const assignment = assignments.get(normalizeFile(row.SourceFile));
  const assigned = assignment ? { latitude: Number(assignment.latitude), longitude: Number(assignment.longitude) } : null;
  const timeline = time ? chooseTimelinePosition(tracks, time) : null;
  if (embedded && assigned && distanceKm(embedded, assigned) > 0.1) return { ...embedded, source: 'embedded-corrected', method: 'manual-or-native', timeDeltaSeconds: 0 };
  if (timeline) return timeline;
  if (embedded) return { ...embedded, source: assigned ? 'embedded-from-old-timeline' : 'embedded', method: 'embedded', timeDeltaSeconds: 0 };
  return null;
}

function makeVisits(photos) {
  const located = photos.filter(photo => photo.position).sort((a, b) => a.time - b.time);
  const groups = [];
  for (const photo of located) {
    const current = groups.at(-1);
    const previous = current?.photos.at(-1);
    const split = !current || photo.time - previous.time > MAX_PHOTO_GAP_MS || distanceKm(photo.position, current.center) > MAX_VISIT_DISTANCE_KM;
    if (split) groups.push({ photos: [photo], center: { latitude: photo.position.latitude, longitude: photo.position.longitude } });
    else {
      current.photos.push(photo);
      current.center = {
        latitude: median(current.photos.map(item => item.position.latitude)),
        longitude: median(current.photos.map(item => item.position.longitude))
      };
    }
  }
  return groups.map((group, index) => {
    const distances = group.photos.map(photo => distanceKm(photo.position, group.center) * 1000).sort((a, b) => a - b);
    const labels = group.photos.map(photo => photo.oldLabel).filter(Boolean);
    const counts = new Map(labels.map(label => [label, (labels.filter(value => value === label).length)]));
    const oldLabel = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    const sources = Object.fromEntries([...new Set(group.photos.map(p => p.position.source))].map(source => [source, group.photos.filter(p => p.position.source === source).length]));
    return {
      id: crypto.createHash('sha1').update(`${group.photos[0].time}:${group.center.latitude}:${group.center.longitude}`).digest('hex').slice(0, 16),
      sequence: index + 1,
      startTime: group.photos[0].time,
      endTime: group.photos.at(-1).time,
      latitude: group.center.latitude,
      longitude: group.center.longitude,
      radiusMeters: Math.round(distances[Math.floor(distances.length * 0.95)] || 0),
      photoCount: group.photos.length,
      oldLabel,
      sources,
      photos: group.photos.map(photo => ({ file: photo.file, name: path.basename(photo.file), time: photo.time, oldLabel: photo.oldLabel, source: photo.position.source, deltaSeconds: photo.position.timeDeltaSeconds }))
    };
  });
}

export class VisitAnalysisService {
  constructor() {
    this.result = null;
    this.locations = new Map();
    this.busy = false;
    this.error = null;
    this.google = new GoogleVisitService(DATA_DIR);
  }

  async load() {
    await mkdir(DATA_DIR, { recursive: true });
    this.result = await readJson(RESULT_FILE, null);
    this.rebuildLocationIndex();
    await this.google.load();
  }

  status() {
    return { busy: this.busy, error: this.error, generatedAt: this.result?.generatedAt || null, summary: this.result?.summary || null, google: this.google.status() };
  }

  get visits() { return this.result?.visits || []; }

  rebuildLocationIndex() {
    this.locations.clear();
    for (const visit of this.visits) {
      const location = { name: visit.newLabel || visit.oldLabel || null, latitude: visit.latitude, longitude: visit.longitude, source: visit.labelSource, radiusMeters: visit.radiusMeters };
      for (const photo of visit.photos) this.locations.set(normalizeFile(photo.file), location);
    }
  }

  photoFile(visitId, index) { return this.visits.find(v => v.id === visitId)?.photos?.[index]?.file || null; }

  locationForFile(file) {
    return this.locations.get(normalizeFile(file)) || null;
  }

  async refresh({ force = false } = {}) {
    if (this.busy) return;
    if (!force && this.result) return;
    this.busy = true;
    this.error = null;
    try {
      const photoFiles = await listJpegs(PHOTO_ROOTS);
      const [tracks, rows, assignments, oldCache, privatePlaces] = await Promise.all([
        loadTracks(), runExifTool(photoFiles), loadAssignments(), readJson(OLD_CACHE, {}), readJson(PRIVATE_PLACES, { places: [] })
      ]);
      const photos = rows.map(row => {
        const file = path.resolve(row.SourceFile);
        const time = photoTime(row);
        const old = oldCache[oldKeyFor(file)];
        return { file, time, oldLabel: labelOf(old), position: time ? positionForPhoto(row, tracks, assignments) : null };
      }).filter(photo => photo.time);
      const visits = makeVisits(photos);
      await this.google.resolve(visits, privatePlaces.places || []);
      this.result = {
        schema: 1,
        generatedAt: Date.now(),
        config: { photoRoots: PHOTO_ROOTS, googleGpx: GOOGLE_GPX, gpsLoggerDir: GPSLOGGER_DIR },
        summary: {
          photos: photos.length,
          locatedPhotos: photos.filter(photo => photo.position).length,
          visits: visits.length,
          googleTrackPoints: tracks.google.length,
          gpsLoggerTrackPoints: tracks.gpsLogger.length,
          gpsLoggerFiles: tracks.loggerFiles
        },
        visits
      };
      this.rebuildLocationIndex();
      await atomicJson(RESULT_FILE, this.result);
    } catch (error) {
      this.error = error.stack || error.message;
      throw error;
    } finally { this.busy = false; }
  }
}

export { distanceKm };
