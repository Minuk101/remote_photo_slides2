import http from 'node:http';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { VisitAnalysisService } from './analysis-engine.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, 'public');
const THUMBS = path.join(HERE, '.thumb-cache');
const PORT = Number(process.env.PORT || 8081);
const service = new VisitAnalysisService();
await mkdir(THUMBS, { recursive: true });
await service.load();
service.refresh().catch(error => console.error(error));

function json(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
  response.end(body);
}

async function thumbnail(visitId, index) {
  const source = service.photoFile(visitId, index);
  if (!source) return null;
  const info = await stat(source);
  const target = path.join(THUMBS, `${visitId}-${index}-${Math.trunc(info.mtimeMs)}.jpg`);
  try { await stat(target); } catch { await sharp(source).rotate().resize(420, 280, { fit: 'cover' }).jpeg({ quality: 78 }).toFile(target); }
  return target;
}

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    if (url.pathname === '/api/status') return json(response, 200, service.status());
    if (url.pathname === '/api/visits') return json(response, 200, { status: service.status(), visits: service.visits });
    if (url.pathname === '/api/refresh' && request.method === 'POST') {
      service.refresh({ force: true }).catch(error => console.error(error));
      return json(response, 202, { started: true });
    }
    const thumb = url.pathname.match(/^\/api\/visits\/([a-f0-9]+)\/photos\/(\d+)$/);
    if (thumb) {
      const file = await thumbnail(thumb[1], Number(thumb[2]));
      if (!file) return json(response, 404, { error: '사진을 찾을 수 없습니다.' });
      response.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=31536000, immutable' });
      return createReadStream(file).pipe(response);
    }
    const requested = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = path.resolve(PUBLIC, requested);
    if (!file.startsWith(PUBLIC)) return json(response, 403, { error: '접근할 수 없습니다.' });
    const body = await readFile(file);
    response.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    response.end(body);
  } catch (error) {
    if (error.code === 'ENOENT') return json(response, 404, { error: '찾을 수 없습니다.' });
    console.error(error); json(response, 500, { error: error.message });
  }
});

server.listen(PORT, '0.0.0.0', () => console.log(`방문 분석기: http://localhost:${PORT}`));
