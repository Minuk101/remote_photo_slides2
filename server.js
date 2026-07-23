import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { createReadStream, watch } from 'node:fs';
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { VisitAnalysisService } from './analysis-engine.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, 'public');
const DATA = path.join(HERE, 'data');
const CACHE = path.join(HERE, '.photo-cache');
const SETTINGS = path.join(DATA, 'settings.json');
const OLD_SETTINGS = process.env.OLD_SETTINGS_FILE || 'D:\\민욱\\remote_slides\\data\\settings.json';
const PHOTO_ROOT = path.resolve(process.env.PHOTO_ROOT || 'D:\\민욱\\사진');
const PORT = Number(process.env.PORT || 8081);
const service = new VisitAnalysisService();
let settings = { selectedFolders: [] };
let manifest = { version: '', photos: [], files: new Map(), scannedAt: 0 };
let dirty = true;
let scanning = null;
let watchers = [];

await Promise.all([mkdir(DATA, { recursive: true }), mkdir(CACHE, { recursive: true })]);
await service.load();
await loadSettings();
configureWatchers();
service.refresh().then(() => { dirty = true; }).catch(error => console.error('위치 분석 실패:', error.message));

function safeRelative(value = '') {
  const absolute = path.resolve(PHOTO_ROOT, ...String(value).replaceAll('\\', '/').split('/').filter(Boolean));
  const relative = path.relative(PHOTO_ROOT, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative) || value.includes('\0')) throw new Error('사진 폴더 밖에는 접근할 수 없습니다.');
  return relative.split(path.sep).join('/');
}
function absolute(relative = '') { return path.resolve(PHOTO_ROOT, ...safeRelative(relative).split('/').filter(Boolean)); }
function idFor(relative) { return crypto.createHash('sha1').update(relative.toLocaleLowerCase('en-US')).digest('hex').slice(0, 20); }
function compare(a, b) { return a.localeCompare(b, 'ko-KR', { numeric: true }); }

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
    try { watchers.push(watch(absolute(folder), { recursive: true }, () => { dirty = true; })); } catch {}
  }
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
    const version = crypto.createHash('sha1').update(files.map(file => `${file.relative}:${file.modifiedAt}:${file.size}`).join('\n')).digest('hex').slice(0, 16);
    manifest = {
      version, scannedAt: Date.now(), files: new Map(files.map(file => [file.id, file])),
      photos: files.map(file => ({
        id: file.id, name: path.basename(file.relative), group: file.relative.includes('/') ? file.relative.slice(0, file.relative.lastIndexOf('/')) : '',
        url: `/media/${file.id}?v=${file.modifiedAt}-${file.size}`, location: service.locationForFile(file.file)
      }))
    };
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
  const body = JSON.stringify(value); response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' }); response.end(body);
}
async function body(request) { const chunks = []; for await (const chunk of request) chunks.push(chunk); return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    if (request.method === 'GET' && url.pathname === '/api/config') return json(response, 200, { photoRoot: PHOTO_ROOT, selectedFolders: settings.selectedFolders, analysis: service.status() });
    if (request.method === 'GET' && url.pathname === '/api/folders') {
      const relative = safeRelative(url.searchParams.get('path') || '');
      const folders = (await readdir(absolute(relative), { withFileTypes: true })).filter(item => item.isDirectory()).map(item => ({ name: item.name, path: relative ? `${relative}/${item.name}` : item.name })).sort((a, b) => compare(a.name, b.name));
      return json(response, 200, { path: relative, folders });
    }
    if (request.method === 'PUT' && url.pathname === '/api/selection') {
      const value = await body(request); settings.selectedFolders = [...new Set((value.selectedFolders || []).map(safeRelative))]; await saveSettings(); configureWatchers(); dirty = true;
      return json(response, 200, { selectedFolders: settings.selectedFolders });
    }
    if (request.method === 'GET' && url.pathname === '/api/photos') {
      const value = await scan(url.searchParams.get('refresh') === '1'); cleanupCache().catch(() => {});
      return json(response, 200, { version: value.version, photos: value.photos, selectedFolders: settings.selectedFolders, analysis: service.status() });
    }
    const media = url.pathname.match(/^\/media\/([a-f0-9]+)$/);
    if (request.method === 'GET' && media) {
      await scan(); const file = manifest.files.get(media[1]); if (!file) return json(response, 404, { error: '사진을 찾을 수 없습니다.' });
      const target = await playbackFile(file); response.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=31536000, immutable' }); return createReadStream(target).pipe(response);
    }
    const requested = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = path.resolve(PUBLIC, requested); if (!file.startsWith(PUBLIC)) return json(response, 403, { error: '접근할 수 없습니다.' });
    const content = await readFile(file); response.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' }); response.end(content);
  } catch (error) { console.error(error); json(response, error.code === 'ENOENT' ? 404 : 500, { error: error.message }); }
});
server.listen(PORT, '0.0.0.0', () => console.log(`Remote Photo Slides 2: http://localhost:${PORT}`));
