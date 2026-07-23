import path from 'node:path';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';

const ENDPOINT = 'https://places.googleapis.com/v1/places:searchNearby';
const OLD_CONFIG = process.env.OLD_GOOGLE_CONFIG || 'D:\\민욱\\remote_slides\\data\\locations\\google-places-config.json';
const MONTHLY_LIMIT = process.env.GOOGLE_MONTHLY_LIMIT === undefined ? 4000 : Number(process.env.GOOGLE_MONTHLY_LIMIT);

function monthKey() { const d = new Date(); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`; }
function korean(value = '') { return /[가-힣]/.test(value) && !/[ぁ-んァ-ヶ一-龯]/.test(value); }
function distanceKm(a, b) {
  const r = Math.PI / 180, dLat = (b.latitude - a.latitude) * r, dLon = (b.longitude - a.longitude) * r;
  const q = Math.sin(dLat / 2) ** 2 + Math.cos(a.latitude * r) * Math.cos(b.latitude * r) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(q), Math.sqrt(1 - q));
}

export class GoogleVisitService {
  constructor(dataDir) {
    this.configFile = path.join(dataDir, 'google-places-config.json');
    this.cacheFile = path.join(dataDir, 'google-visit-cache.json');
    this.cache = {};
    this.usage = {};
    this.apiKey = process.env.GOOGLE_PLACES_API_KEY || '';
  }
  async load() {
    await mkdir(path.dirname(this.cacheFile), { recursive: true });
    try { const value = JSON.parse(await readFile(this.cacheFile, 'utf8')); this.cache = value.cache || {}; this.usage = value.usage || {}; } catch {}
    if (!this.apiKey) { try { this.apiKey = JSON.parse(await readFile(this.configFile, 'utf8')).apiKey || ''; } catch {} }
    if (!this.apiKey) { try { this.apiKey = JSON.parse(await readFile(OLD_CONFIG, 'utf8')).apiKey || ''; } catch {} }
  }
  status() { return { configured: Boolean(this.apiKey), configuredByEnvironment: Boolean(process.env.GOOGLE_PLACES_API_KEY), usedThisMonth: Number(this.usage[monthKey()] || 0), monthlyLimit: MONTHLY_LIMIT }; }
  async setApiKey(apiKey) {
    if (process.env.GOOGLE_PLACES_API_KEY) throw new Error('API 키가 환경 변수로 설정되어 있어 화면에서 바꿀 수 없습니다.');
    this.apiKey = typeof apiKey === 'string' ? apiKey.trim() : '';
    const temp = `${this.configFile}.tmp`;
    await writeFile(temp, `${JSON.stringify({ apiKey: this.apiKey }, null, 2)}\n`, 'utf8');
    await rename(temp, this.configFile);
    return this.status();
  }
  async save() { const temp = `${this.cacheFile}.tmp`; await writeFile(temp, `${JSON.stringify({ cache: this.cache, usage: this.usage })}\n`); await rename(temp, this.cacheFile); }
  privateName(visit, places) {
    return places.map(place => ({ place, km: distanceKm(visit, place) })).filter(x => x.km * 1000 <= Number(x.place.radiusMeters || 0)).sort((a, b) => a.km - b.km)[0]?.place?.name || null;
  }
  async search(visit) {
    const response = await fetch(ENDPOINT, {
      method: 'POST', signal: AbortSignal.timeout(20_000),
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': this.apiKey, 'X-Goog-FieldMask': 'places.id,places.displayName,places.location,places.primaryType,places.userRatingCount' },
      body: JSON.stringify({ languageCode: 'ko', maxResultCount: 20, rankPreference: 'POPULARITY', locationRestriction: { circle: { center: { latitude: visit.latitude, longitude: visit.longitude }, radius: Math.max(300, Math.min(800, visit.radiusMeters + 300)) } } })
    });
    if (!response.ok) throw new Error(`Google Places ${response.status}`);
    const body = await response.json();
    const candidates = (body.places || []).map(place => ({
      id: place.id, name: place.displayName?.text || '', type: place.primaryType || '', ratings: place.userRatingCount || 0,
      latitude: place.location?.latitude, longitude: place.location?.longitude
    })).filter(place => korean(place.name) && Number.isFinite(place.latitude));
    const banned = /주식회사|가구|초등학교|중학교|고등학교|공업고등학교|물류|창고/;
    const usable = candidates.filter(place => !banned.test(place.name)).map(place => ({ ...place, distanceMeters: Math.round(distanceKm(visit, place) * 1000) }));
    return usable.find(place => place.distanceMeters <= 40) || usable.filter(place => place.distanceMeters <= 350).sort((a, b) => (b.ratings || 0) - (a.ratings || 0))[0] || null;
  }
  async resolve(visits, privatePlaces) {
    for (const visit of visits) {
      const privateName = this.privateName(visit, privatePlaces);
      if (privateName) { visit.newLabel = privateName; visit.labelSource = 'private'; continue; }
      const cached = this.cache[visit.id];
      if (cached) { Object.assign(visit, cached); continue; }
      if (!this.apiKey || Number(this.usage[monthKey()] || 0) >= MONTHLY_LIMIT) {
        visit.newLabel = visit.oldLabel; visit.labelSource = 'old-majority'; continue;
      }
      this.usage[monthKey()] = Number(this.usage[monthKey()] || 0) + 1;
      try {
        const place = await this.search(visit);
        const value = place ? { newLabel: place.name, labelSource: 'google-visit', labelDistanceMeters: place.distanceMeters } : { newLabel: visit.oldLabel, labelSource: 'old-majority' };
        Object.assign(visit, value); this.cache[visit.id] = value;
      } catch (error) { visit.newLabel = visit.oldLabel; visit.labelSource = 'old-majority'; visit.labelError = error.message; }
      await this.save();
    }
  }
}
