import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { createReadStream, watch } from 'node:fs';
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { VisitAnalysisService } from './analysis-engine.js';

// [안정성] 처리되지 않은 예외/거부가 서버 프로세스를 죽이지 않도록 가로채기만 합니다.
for (const sig of ["uncaughtException", "unhandledRejection"]) {
  process.on(sig, (error) => {
    console.error(`[안전 가드] ${sig} 무시하고 계속 유지:`, (error && (error.stack || error.message)) || error);
  });
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, 'public');
const DATA = path.join(HERE, 'data');
const CACHE = path.join(HERE, '.photo-cache');
const SETTINGS = path.join(DATA, 'settings.json');
const OLD_SETTINGS = process.env.OLD_SETTINGS_FILE || 'D:\\민욱\\remote_slides\\data\\settings.json';
const PHOTO_ROOT = path.resolve(process.env.PHOTO_ROOT || 'D:\\민욱\\사진');
const GPSLOGGER_DIR = path.resolve(process.env.GPSLOGGER_DIR || 'D:\\민욱\\타임라인\\GPSLogger');
const GOOGLE_GPX = path.resolve(process.env.GPX_PATH || 'D:\\민욱\\타임라인\\google_maps\\260723\\timeline_export_1784779939485.gpx');
const PORT = Number(process.env.PORT || 8080);
const ANALYSIS_QUIET_MS = Math.max(1_000, Number(process.env.ANALYSIS_QUIET_MS || 5 * 60_000));
const service = new VisitAnalysisService();
let settings = { selectedFolders: [] };
let manifest = { version: '', photos: [], files: new Map(), scannedAt: 0 };
let dirty = true;
let scanning = null;
let watchers = [];
let timelineWatchers = [];
let analysisTimer = null;
let analysisGeneration = 0;
const pendingPhotoFiles = new Set();
const autoAnalysis = { phase: 'idle', reason: null, lastChangeAt: null, scheduledFor: null, startedAt: null, completedAt: null, error: null };

await Promise.all([mkdir(DATA, { recursive: true }), mkdir(CACHE, { recursive: true })]);
await service.load();
await loadSettings();
configureWatchers();
configureTimelineWatchers();
if (!service.status().generatedAt || !service.hasFileInventory) scheduleAnalysis('초기 분석 상태 확인');

function safeRelative(value = '') {
  const absolute = path.resolve(PHOTO_ROOT, ...String(value).replaceAll('\\', '/').split('/').filter(Boolean));
  const relative = path.relative(PHOTO_ROOT, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative) || value.includes('\0')) throw new Error('사진 폴더 밖에는 접근할 수 없습니다.');
  return relative.split(path.sep).join('/');
}
function absolute(relative = '') { return path.resolve(PHOTO_ROOT, ...safeRelative(relative).split('/').filter(Boolean)); }
function idFor(relative) { return crypto.createHash('sha1').update(relative.toLocaleLowerCase('en-US')).digest('hex').slice(0, 20); }
function compare(a, b) { return a.localeCompare(b, 'ko-KR', { numeric: true }); }
function removeNestedFolders(folders) {
  const unique = [...new Set(folders.map(safeRelative))].sort((a, b) => a.length - b.length || compare(a, b));
  return unique.filter((folder, index) => !unique.some((parent, parentIndex) => parentIndex !== index && (parent === '' || folder.startsWith(`${parent}/`))));
}

async function readJson(file, fallback) { try { return JSON.parse(await readFile(file, 'utf8')); } catch { return fallback; } }
async function saveSettings() {
  const temp = `${SETTINGS}.tmp`;
  await writeFile(temp, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  await rename(temp, SETTINGS);
}
async function loadSettings() {
  const local = await readJson(SETTINGS, null);
  const source = local || await readJson(OLD_SETTINGS, { selectedFolders: [] });
  settings.selectedFolders = [...new Set((source.selectedFolders || []).map(safeRelative))];
  if (!local && settings.selectedFolders.length) await saveSettings();
}
function configureWatchers() {
  watchers.forEach(item => item.close()); watchers = [];
  for (const folder of settings.selectedFolders) {
    try {
      const watcher = watch(absolute(folder), { recursive: true }, (event, filename) => {
      dirty = true;
      if (!filename || /\.jpe?g$/i.test(String(filename))) scheduleAnalysis('새 사진 또는 사진 변경');
      });
      watcher.on('error', error => console.warn(`사진 폴더 감시 오류 (${folder}):`, error.message));
      watchers.push(watcher);
    } catch (error) { console.warn(`사진 폴더를 감시하지 못했습니다 (${folder}):`, error.message); }
  }
}
function configureTimelineWatchers() {
  timelineWatchers.forEach(item => item.close()); timelineWatchers = [];
  try {
    const watcher = watch(GPSLOGGER_DIR, { recursive: true }, (event, filename) => {
      if (!filename || /\.gpx$/i.test(String(filename))) scheduleAnalysis('GPSLogger 변경');
    });
    watcher.on('error', error => console.warn('GPSLogger 폴더 감시 오류:', error.message));
    timelineWatchers.push(watcher);
  } catch (error) { console.warn('GPSLogger 폴더를 감시하지 못했습니다:', error.message); }
  try {
    const watcher = watch(path.dirname(GOOGLE_GPX), (event, filename) => {
      if (!filename || String(filename).toLocaleLowerCase('en-US') === path.basename(GOOGLE_GPX).toLocaleLowerCase('en-US')) scheduleAnalysis('Google 타임라인 변경');
    });
    watcher.on('error', error => console.warn('Google 타임라인 감시 오류:', error.message));
    timelineWatchers.push(watcher);
  } catch (error) { console.warn('Google 타임라인을 감시하지 못했습니다:', error.message); }
}
function scheduleAnalysis(reason) {
  analysisGeneration++;
  autoAnalysis.phase = service.busy ? 'waiting-after-current' : 'waiting';
  autoAnalysis.reason = reason;
  autoAnalysis.lastChangeAt = Date.now();
  autoAnalysis.scheduledFor = Date.now() + ANALYSIS_QUIET_MS;
  autoAnalysis.error = null;
  if (analysisTimer) clearTimeout(analysisTimer);
  const generation = analysisGeneration;
  analysisTimer = setTimeout(() => runScheduledAnalysis(generation), ANALYSIS_QUIET_MS);
}
async function runScheduledAnalysis(generation) {
  analysisTimer = null;
  if (service.busy) { scheduleAnalysis(autoAnalysis.reason || '분석 중 추가 변경'); return; }
  autoAnalysis.phase = 'running'; autoAnalysis.startedAt = Date.now(); autoAnalysis.scheduledFor = null; autoAnalysis.error = null;
  try {
    await service.refresh({ force: true });
    dirty = true;
    for (const file of [...pendingPhotoFiles]) if (service.hasAnalyzedFile(file)) pendingPhotoFiles.delete(file);
    autoAnalysis.completedAt = Date.now();
    autoAnalysis.phase = analysisGeneration === generation ? 'idle' : 'waiting';
  } catch (error) {
    autoAnalysis.phase = 'error'; autoAnalysis.error = error.message;
    console.error('자동 위치 분석 실패:', error);
  }
  if ((analysisGeneration !== generation || pendingPhotoFiles.size) && !analysisTimer) scheduleAnalysis(autoAnalysis.reason || '분석 중 추가 변경');
}
async function walk(folder, found) {
  const entries = await readdir(absolute(folder), { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const relative = folder ? `${folder}/${entry.name}` : entry.name;
    if (entry.isDirectory()) await walk(relative, found);
    else if (entry.isFile() && /\.jpe?g$/i.test(entry.name)) {
      const file = absolute(relative), info = await stat(file).catch(() => null);
      if (info) found.set(relative.toLocaleLowerCase('en-US'), { id: idFor(relative), relative, file, size: info.size, modifiedAt: Math.trunc(info.mtimeMs) });
    }
  }
}
async function scan(force = false) {
  if (!force && !dirty && Date.now() - manifest.scannedAt < 10_000) return manifest;
  if (scanning) return scanning;
  scanning = (async () => {
    const found = new Map();
    for (const folder of settings.selectedFolders) await walk(folder, found);
    const files = [...found.values()].sort((a, b) => compare(a.relative, b.relative));
    const version = crypto.createHash('sha1').update(files.map(file => `${file.relative}:${file.modifiedAt}:${file.size}:${JSON.stringify(service.locationForFile(file.file))}`).join('\n')).digest('hex').slice(0, 16);
    manifest = {
      version, scannedAt: Date.now(), files: new Map(files.map(file => [file.id, file])),
      photos: files.map(file => ({
        id: file.id, name: path.basename(file.relative), group: file.relative.includes('/') ? file.relative.slice(0, file.relative.lastIndexOf('/')) : '',
        modifiedAt: file.modifiedAt, size: file.size,
        url: `/media/${file.id}?v=${file.modifiedAt}-${file.size}`, location: service.locationForFile(file.file)
      }))
    };
    if (service.hasFileInventory) {
      const newFiles = files.filter(file => !service.hasAnalyzedFile(file.file) && !pendingPhotoFiles.has(file.file));
      newFiles.forEach(file => pendingPhotoFiles.add(file.file));
      if (newFiles.length) scheduleAnalysis(`분석하지 않은 새 사진 ${newFiles.length}장 발견`);
    }
    dirty = false; return manifest;
  })().finally(() => { scanning = null; });
  return scanning;
}
async function playbackFile(file) {
  const target = path.join(CACHE, `${file.id}-${file.modifiedAt}-${file.size}.jpg`);
  try { await stat(target); return target; } catch {}
  const temp = `${target}.${process.pid}.tmp`;
  await sharp(file.file).rotate().resize(1920, 1080, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 88, mozjpeg: true }).toFile(temp);
  await rename(temp, target); return target;
}
async function cleanupCache() {
  const keep = new Set([...manifest.files.values()].map(file => `${file.id}-${file.modifiedAt}-${file.size}.jpg`));
  for (const item of await readdir(CACHE, { withFileTypes: true }).catch(() => [])) if (item.isFile() && !keep.has(item.name) && !item.name.endsWith('.tmp')) await unlink(path.join(CACHE, item.name)).catch(() => {});
}
function json(response, status, value) {
  try {
    if (!response || response.writableEnded || response.destroyed || !response.writable) return;
    const body = JSON.stringify(value);
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
    response.end(body);
  } catch (error) { /* 이미 닫힌 응답 등은 무시 */ }
}
async function body(request) { const chunks = []; for await (const chunk of request) chunks.push(chunk); return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

const server = http.createServer(async (request, response) => {
  request.on('error', () => {});
  response.on('error', () => {});
  try {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    if (request.method === 'GET' && url.pathname === '/api/config') {
      let rootAvailable = true; try { await stat(PHOTO_ROOT); } catch { rootAvailable = false; }
      return json(response, 200, { rootName: path.basename(PHOTO_ROOT), rootPath: PHOTO_ROOT, rootAvailable, selectedFolders: settings.selectedFolders });
    }
    if (request.method === 'GET' && url.pathname === '/api/location-status') return json(response, 200, { ...service.locationStatus(), autoAnalysis: { ...autoAnalysis, quietSeconds: Math.round(ANALYSIS_QUIET_MS / 1000) } });
    if (request.method === 'PUT' && url.pathname === '/api/google-places') {
      const value = await body(request); const googlePlaces = await service.setGooglePlacesApiKey(value.apiKey); return json(response, 200, { googlePlaces });
    }
    if (request.method === 'GET' && url.pathname === '/api/folders') {
      const relative = safeRelative(url.searchParams.get('path') || '');
      const folders = (await readdir(absolute(relative), { withFileTypes: true })).filter(item => item.isDirectory()).map(item => ({ name: item.name, path: relative ? `${relative}/${item.name}` : item.name })).sort((a, b) => compare(a.name, b.name));
      return json(response, 200, { currentPath: relative, folders });
    }
    if (request.method === 'PUT' && url.pathname === '/api/selection') {
      const value = await body(request); if (!Array.isArray(value.folders)) return json(response, 400, { error: '폴더 목록이 필요합니다.' });
      settings.selectedFolders = removeNestedFolders(value.folders); await saveSettings(); configureWatchers(); dirty = true;
      const current = await scan(true); return json(response, 200, { selectedFolders: settings.selectedFolders, photoCount: current.photos.length, version: current.version });
    }
    if (request.method === 'GET' && url.pathname === '/api/photos') {
      const value = await scan(); cleanupCache().catch(() => {});
      const knownVersion = url.searchParams.get('version');
      if (knownVersion && knownVersion === value.version) return json(response, 200, { unchanged: true, version: value.version });
      return json(response, 200, { unchanged: false, version: value.version, photos: value.photos });
    }
    const media = url.pathname.match(/^\/media\/([a-f0-9]+)$/);
    if (request.method === 'GET' && media) {
      await scan(); const file = manifest.files.get(media[1]); if (!file) return json(response, 404, { error: '사진을 찾을 수 없습니다.' });
      const target = await playbackFile(file); response.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=31536000, immutable' });
      const stream = createReadStream(target); stream.on('error', error => { console.warn('재생 이미지 읽기 오류:', error.message); response.destroy(error); }); return stream.pipe(response);
    }
    if (request.method === 'GET' && url.pathname.startsWith('/media/')) return json(response, 404, { error: '사진을 찾을 수 없습니다.' });
    const requested = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = path.resolve(PUBLIC, requested); if (!file.startsWith(PUBLIC)) return json(response, 403, { error: '접근할 수 없습니다.' });
    let content;
    try { content = await readFile(file); }
    catch { return json(response, 404, { error: '파일을 찾을 수 없습니다.' }); }
    response.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' }); response.end(content);
  } catch (error) { if (error.code !== 'ENOENT') console.error(error); json(response, error.code === 'ENOENT' ? 404 : 500, { error: error.message }); }
});
server.listen(PORT, '0.0.0.0', () => console.log(`Remote Photo Slides 2: http://localhost:${PORT}`));
server.on('error', error => { console.error('HTTP 서버 오류:', error); setTimeout(() => process.exit(1), 100); });
