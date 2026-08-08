import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { GoogleVisitService } from './google-visit-service.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(HERE, 'data');
const RESULT_FILE = path.join(DATA_DIR, 'visit-analysis.json');
const EXIF_CACHE_FILE = path.join(DATA_DIR, 'exif-metadata-cache.json');
const ADMIN_CACHE_FILE = path.join(DATA_DIR, 'admin-geocode-cache.json');
const EXIF_CACHE_SCHEMA = 1;
const PHOTO_ROOTS = (process.env.PHOTO_ROOTS || 'D:\\민욱\\사진\\2024|D:\\민욱\\사진\\2025|D:\\민욱\\사진\\2026').split('|').filter(Boolean).map(value => path.resolve(value));
const GOOGLE_GPX = process.env.GPX_PATH || 'D:\\민욱\\타임라인\\google_maps\\260723\\timeline_export_1784779939485.gpx';
const GPSLOGGER_DIR = process.env.GPSLOGGER_DIR || 'D:\\민욱\\타임라인\\GPSLogger';
const OLD_CACHE = process.env.OLD_LOCATION_CACHE || 'D:\\민욱\\remote_slides\\data\\locations\\photo-locations.json';
const REPORT_DIR = process.env.GEOTAG_REPORT_DIR || 'D:\\민욱\\타임라인\\google_maps\\260723';
const PRIVATE_PLACES = process.env.PRIVATE_PLACES_FILE || 'D:\\민욱\\remote_slides\\data\\locations\\private-places.json';

const MAX_PHOTO_GAP_MS = 90 * 60_000;
const MAX_VISIT_DISTANCE_KM = 1.5;
const BUILTIN_AREAS = [
  { name: '제주국제공항', minLatitude: 33.49, maxLatitude: 33.525, minLongitude: 126.455, maxLongitude: 126.515 },
  { name: '훈데르트힐즈', minLatitude: 33.489, maxLatitude: 33.497, minLongitude: 126.951, maxLongitude: 126.961 }
];

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

const POSITION_WEIGHTS = {
  'embedded-corrected': 8,
  embedded: 6,
  'gpslogger-gps': 5,
  'google-timeline': 3,
  'embedded-from-old-timeline': 2,
  'gpslogger-network': 1
};

function weightedMedian(items, getter) {
  const sorted = items.map(item => ({ value: getter(item), weight: POSITION_WEIGHTS[item.position.source] || 1 })).filter(item => Number.isFinite(item.value)).sort((a, b) => a.value - b.value);
  const half = sorted.reduce((sum, item) => sum + item.weight, 0) / 2;
  let total = 0;
  for (const item of sorted) { total += item.weight; if (total >= half) return item.value; }
  return sorted.at(-1)?.value ?? null;
}

function visitCenter(photos) {
  const preliminary = {
    latitude: weightedMedian(photos, photo => photo.position.latitude),
    longitude: weightedMedian(photos, photo => photo.position.longitude)
  };
  const distances = photos.map(photo => distanceKm(photo.position, preliminary) * 1000);
  const typicalDistance = median(distances) || 0;
  const cutoff = Math.max(80, Math.min(1000, typicalDistance * 3 + 30));
  const inliers = photos.filter(photo => distanceKm(photo.position, preliminary) * 1000 <= cutoff);
  const selected = inliers.length >= Math.max(2, Math.ceil(photos.length * 0.4)) ? inliers : photos;
  return {
    latitude: weightedMedian(selected, photo => photo.position.latitude),
    longitude: weightedMedian(selected, photo => photo.position.longitude),
    inlierCount: selected.length
  };
}

function normalizeFile(value) {
  return path.resolve(value || '').replaceAll('/', '\\').toLocaleLowerCase('en-US');
}

function analyzedFileId(file) {
  return crypto.createHash('sha1').update(normalizeFile(file)).digest('hex').slice(0, 20);
}

function applyBuiltinAreas(visits) {
  for (const visit of visits) {
    const area = BUILTIN_AREAS.find(candidate => (
      visit.latitude >= candidate.minLatitude && visit.latitude <= candidate.maxLatitude
      && visit.longitude >= candidate.minLongitude && visit.longitude <= candidate.maxLongitude
    ));
    if (!area) continue;
    visit.newLabel = area.name;
    visit.labelSource = 'builtin-area';
    visit.labelDistanceMeters = null;
  }
}

async function reverseGeocodeNominatim(latitude, longitude) {
  const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${latitude}&lon=${longitude}&accept-language=ko&zoom=10`;
  const response = await fetch(url, { headers: { 'User-Agent': 'RemotePhotoSlides/2.0' } });
  if (!response.ok) throw new Error(`Nominatim ${response.status}`);
  const body = await response.json();
  const addr = body.address || {};
  return {
    city: addr.city || addr.town || addr.municipality || addr.county || addr.state || null,
    country: addr.country || null
  };
}

function adminCacheKey(latitude, longitude) {
  return `${Math.round(Number(latitude) / 0.02)}:${Math.round(Number(longitude) / 0.02)}`;
}

async function enrichVisitsWithCity(visits, knownVisits = []) {
  const adminCache = await readJson(ADMIN_CACHE_FILE, {});
  for (const visit of knownVisits) {
    if (visit.adminCity === undefined || visit.adminCountry === undefined) continue;
    adminCache[adminCacheKey(visit.latitude, visit.longitude)] = { city: visit.adminCity, country: visit.adminCountry };
  }
  for (const visit of visits) {
    if (visit.labelSource === 'moving') continue;
    if (visit.adminCity !== undefined && visit.adminCountry !== undefined) continue;
    const key = adminCacheKey(visit.latitude, visit.longitude);
    const cached = adminCache[key];
    if (cached) {
      visit.adminCity = cached.city;
      visit.adminCountry = cached.country;
      continue;
    }
    try {
      const geo = await reverseGeocodeNominatim(visit.latitude, visit.longitude);
      visit.adminCity = geo.city;
      visit.adminCountry = geo.country;
    } catch {
      visit.adminCity = null;
      visit.adminCountry = null;
    }
    adminCache[key] = { city: visit.adminCity, country: visit.adminCountry };
    await atomicJson(ADMIN_CACHE_FILE, adminCache);
    await new Promise(r => setTimeout(r, 1100));
  }
  await atomicJson(ADMIN_CACHE_FILE, adminCache);
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

function removeTrackSpikes(points) {
  if (points.length < 3) return points;
  const sorted = [...points].sort((a, b) => a.time - b.time);
  return sorted.filter((point, index) => {
    const before = sorted[index - 1], after = sorted[index + 1];
    if (!before || !after) return true;
    const beforeSeconds = (point.time - before.time) / 1000;
    const afterSeconds = (after.time - point.time) / 1000;
    if (beforeSeconds <= 0 || afterSeconds <= 0 || beforeSeconds > 10 * 60 || afterSeconds > 10 * 60) return true;
    const incomingSpeed = distanceKm(before, point) * 1000 / beforeSeconds;
    const outgoingSpeed = distanceKm(point, after) * 1000 / afterSeconds;
    const directSpeed = distanceKm(before, after) * 1000 / (beforeSeconds + afterSeconds);
    return !(incomingSpeed > 90 && outgoingSpeed > 90 && directSpeed < 50);
  });
}

async function loadTracks() {
  const google = await parseGpxFile(GOOGLE_GPX, 'google-timeline').catch(() => []);
  const loggerFiles = (await readdir(GPSLOGGER_DIR, { withFileTypes: true }).catch(() => []))
    .filter(item => item.isFile() && item.name.toLowerCase().endsWith('.gpx'))
    .map(item => path.join(GPSLOGGER_DIR, item.name));
  const gpsLogger = (await Promise.all(loggerFiles.map(async file => removeTrackSpikes(await parseGpxFile(file, 'gpslogger').catch(() => []))))).flat();
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
  const googleValue = estimateFrom(tracks.google, time, 30 * 60_000, 'google-timeline');
  if (loggerValue && googleValue && distanceKm(loggerValue, googleValue) > 1) return googleValue;
  return loggerValue || googleValue;
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
  if (!files.length) return Promise.resolve([]);
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

async function loadExifRows(files, changedFiles = []) {
  const saved = await readJson(EXIF_CACHE_FILE, {});
  const rowsByFile = saved.schema === EXIF_CACHE_SCHEMA && saved.rowsByFile && typeof saved.rowsByFile === 'object'
    ? saved.rowsByFile
    : {};
  const current = new Map(files.map(file => [normalizeFile(file), file]));
  const changed = new Set(changedFiles.map(normalizeFile));
  const targets = files.filter(file => !rowsByFile[normalizeFile(file)] || changed.has(normalizeFile(file)));
  const freshRows = await runExifTool(targets);
  for (const row of freshRows) rowsByFile[normalizeFile(row.SourceFile)] = row;
  for (const key of Object.keys(rowsByFile)) if (!current.has(key)) delete rowsByFile[key];
  await atomicJson(EXIF_CACHE_FILE, { schema: EXIF_CACHE_SCHEMA, rowsByFile });
  return {
    rows: files.map(file => rowsByFile[normalizeFile(file)]).filter(Boolean),
    scanned: targets.length,
    cached: Math.max(0, files.length - targets.length)
  };
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
  if (embedded && !assigned) return { ...embedded, source: 'embedded', method: 'embedded', timeDeltaSeconds: 0 };
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
    if (split) groups.push({ photos: [photo], center: { latitude: photo.position.latitude, longitude: photo.position.longitude, inlierCount: 1 } });
    else {
      current.photos.push(photo);
      current.center = visitCenter(current.photos);
    }
  }
  return groups.map((group, index) => {
    const distances = group.photos.map(photo => distanceKm(photo.position, group.center) * 1000).sort((a, b) => a - b);
    const labels = group.photos.map(photo => photo.oldLabel).filter(Boolean);
    const counts = new Map(labels.map(label => [label, (labels.filter(value => value === label).length)]));
    const oldLabel = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    const cityCounts = new Map(group.photos.map(photo => photo.oldCity).filter(Boolean).map(city => [city, group.photos.filter(photo => photo.oldCity === city).length]));
    const countryCounts = new Map(group.photos.map(photo => photo.oldCountry).filter(Boolean).map(country => [country, group.photos.filter(photo => photo.oldCountry === country).length]));
    const sources = Object.fromEntries([...new Set(group.photos.map(p => p.position.source))].map(source => [source, group.photos.filter(p => p.position.source === source).length]));
    return {
      id: crypto.createHash('sha1').update(`${group.photos[0].time}:${group.center.latitude}:${group.center.longitude}`).digest('hex').slice(0, 16),
      sequence: index + 1,
      startTime: group.photos[0].time,
      endTime: group.photos.at(-1).time,
      latitude: group.center.latitude,
      longitude: group.center.longitude,
      radiusMeters: Math.round(distances[Math.floor(distances.length * 0.95)] || 0),
      centerPointCount: group.center.inlierCount || group.photos.length,
      photoCount: group.photos.length,
      oldLabel,
      adminCity: [...cityCounts].sort((a, b) => b[1] - a[1])[0]?.[0],
      adminCountry: [...countryCounts].sort((a, b) => b[1] - a[1])[0]?.[0],
      sources,
      photos: group.photos.map(photo => ({ file: photo.file, name: path.basename(photo.file), time: photo.time, oldLabel: photo.oldLabel, source: photo.position.source, deltaSeconds: photo.position.timeDeltaSeconds }))
    };
  });
}

export class VisitAnalysisService {
  constructor() {
    this.result = null;
    this.locations = new Map();
    this.analyzedFiles = new Set();
    this.busy = false;
    this.error = null;
    this.google = new GoogleVisitService(DATA_DIR);
  }

  async load() {
    await mkdir(DATA_DIR, { recursive: true });
    this.result = await readJson(RESULT_FILE, null);
    this.rebuildLocationIndex();
    this.rebuildAnalyzedFileIndex();
    await this.google.load();
  }

  status() {
    return { busy: this.busy, error: this.error, generatedAt: this.result?.generatedAt || null, summary: this.result?.summary || null, google: this.google.status() };
  }

  locationStatus() {
    const summary = this.result?.summary;
    return {
      phase: this.busy ? '이동 기록 분석 중' : summary ? '위치 분석 완료' : '위치 분석 대기 중',
      total: summary?.photos || 0,
      checked: summary?.photos || 0,
      gps: summary?.locatedPhotos || 0,
      ready: summary?.locatedPhotos || 0,
      googlePlaces: this.google.status()
    };
  }

  async setGooglePlacesApiKey(apiKey) { return this.google.setApiKey(apiKey); }

  get visits() { return this.result?.visits || []; }

  get hasFileInventory() { return Array.isArray(this.result?.analyzedFileIds); }

  rebuildAnalyzedFileIndex() {
    this.analyzedFiles = new Set(this.result?.analyzedFileIds || []);
  }

  hasAnalyzedFile(file) { return this.analyzedFiles.has(analyzedFileId(file)); }

  rebuildLocationIndex() {
    this.locations.clear();
    for (const visit of this.visits) {
      if (visit.labelSource === 'moving') continue;
      const location = {
        landmark: visit.newLabel ?? visit.oldLabel ?? null,
        latitude: visit.latitude,
        longitude: visit.longitude,
        city: visit.adminCity ?? null,
        country: visit.adminCountry ?? null,
        landmarkDistanceMeters: null,
        landmarkSource: visit.labelSource?.startsWith('google-visit') ? 'google' : 'timeline',
        visitRadiusMeters: visit.radiusMeters
      };
      for (const photo of visit.photos) this.locations.set(normalizeFile(photo.file), location);
    }
  }

  photoFile(visitId, index) { return this.visits.find(v => v.id === visitId)?.photos?.[index]?.file || null; }

  locationForFile(file) {
    return this.locations.get(normalizeFile(file)) || null;
  }

  async refresh({ force = false, changedFiles = [] } = {}) {
    if (this.busy) return;
    if (!force && this.result) return;
    this.busy = true;
    this.error = null;
    try {
      const photoFiles = await listJpegs(PHOTO_ROOTS);
      const [tracks, exif, assignments, oldCache, privatePlaces] = await Promise.all([
        loadTracks(), loadExifRows(photoFiles, changedFiles), loadAssignments(), readJson(OLD_CACHE, {}), readJson(PRIVATE_PLACES, { places: [] })
      ]);
      const rows = exif.rows;
      const photos = rows.map(row => {
        const file = path.resolve(row.SourceFile);
        const time = photoTime(row);
        const old = oldCache[oldKeyFor(file)];
        return { file, time, oldLabel: labelOf(old), oldCity: old?.city || null, oldCountry: old?.country || null, position: time ? positionForPhoto(row, tracks, assignments) : null };
      }).filter(photo => photo.time);
      const visits = makeVisits(photos);
      const previousVisits = new Map(this.visits.map(visit => [visit.id, visit]));
      for (const visit of visits) {
        const previous = previousVisits.get(visit.id);
        if (!previous) continue;
        if (previous.adminCity !== undefined) visit.adminCity = previous.adminCity;
        if (previous.adminCountry !== undefined) visit.adminCountry = previous.adminCountry;
      }
      await this.google.resolve(visits, privatePlaces.places || []);
      applyBuiltinAreas(visits);
      await enrichVisitsWithCity(visits, this.visits);
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
          gpsLoggerFiles: tracks.loggerFiles,
          exifScanned: exif.scanned,
          exifCached: exif.cached
        },
        analyzedFileIds: rows.map(row => analyzedFileId(path.resolve(row.SourceFile))),
        visits
      };
      this.rebuildAnalyzedFileIndex();
      this.rebuildLocationIndex();
      await atomicJson(RESULT_FILE, this.result);
    } catch (error) {
      this.error = error.stack || error.message;
      throw error;
    } finally { this.busy = false; }
  }

  async refreshLabels() {
    if (!this.result || this.busy) return;
    this.busy = true; this.error = null;
    try {
      const privatePlaces = await readJson(PRIVATE_PLACES, { places: [] });
      for (const visit of this.visits) { delete visit.newLabel; delete visit.labelSource; delete visit.labelDistanceMeters; delete visit.labelError; }
      await this.google.resolve(this.visits, privatePlaces.places || []);
      applyBuiltinAreas(this.visits);
      await enrichVisitsWithCity(this.visits);
      this.result.generatedAt = Date.now();
      this.rebuildLocationIndex();
      await atomicJson(RESULT_FILE, this.result);
    } catch (error) { this.error = error.stack || error.message; throw error; }
    finally { this.busy = false; }
  }
}

export { distanceKm };
