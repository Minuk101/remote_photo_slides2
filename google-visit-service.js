import path from 'node:path';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';

const ENDPOINT = 'https://places.googleapis.com/v1/places:searchNearby';
const OLD_CONFIG = process.env.OLD_GOOGLE_CONFIG || 'D:\\민욱\\remote_slides\\data\\locations\\google-places-config.json';
const OLD_CANDIDATE_CACHE = process.env.OLD_GOOGLE_CACHE || 'D:\\민욱\\remote_slides\\data\\locations\\google-places-cache.json';
const MONTHLY_LIMIT = process.env.GOOGLE_MONTHLY_LIMIT === undefined ? 4000 : Number(process.env.GOOGLE_MONTHLY_LIMIT);
const CLUSTER_SIZE = 0.0025;
const MAX_NEAREST_METERS = 350;
const SAME_PLACE_CACHE_METERS = 60;
const CACHE_SCHEMA = 6;
const NON_VISITOR_TYPES = new Set(['', 'building_materials_store', 'corporate_office', 'educational_institution', 'electrician', 'furniture_store', 'general_contractor', 'hardware_store', 'home_goods_store', 'home_improvement_store', 'manufacturer', 'point_of_interest', 'research_institute', 'school', 'secondary_school', 'service', 'storage', 'telecommunications_service_provider', 'wholesaler']);
const BANNED_NAMES = /주식회사|\(주\)|가구|초등학교|중학교|고등학교|공업고등학교|물류|창고|공장|본사|사무소/;
const LANDMARK_TYPES = new Set(['amusement_center', 'amusement_park', 'aquarium', 'art_gallery', 'art_museum', 'beach', 'botanical_garden', 'concert_hall', 'cultural_landmark', 'hiking_area', 'historical_landmark', 'historical_place', 'monument', 'museum', 'national_park', 'observation_deck', 'park', 'performing_arts_theater', 'shopping_mall', 'stadium', 'tourist_attraction', 'zoo']);
const PARENT_TYPES = new Set(['department_store', 'hypermarket', 'movie_theater', 'train_station', 'university']);
const STAY_TYPES = new Set(['hotel', 'lodging', 'resort_hotel']);
const MICRO_TYPES = new Set(['beauty_salon', 'convenience_store', 'hair_care', 'hair_salon', 'locksmith', 'supplier']);

function monthKey() { const d = new Date(); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`; }
function korean(value = '') { return /[가-힣]/.test(value) && !/[ぁ-んァ-ヶ一-龯]/.test(value); }
function normalizedName(value = '') { return value.normalize('NFKC').toLowerCase().replace(/[^0-9a-z가-힣]/g, ''); }
function inferredTransitLandmark(candidate) {
  const match = String(candidate.name || '').match(/(?:순환버스|관광버스)\s+(.+?)\s*정류장$/);
  const name = match?.[1]?.trim();
  if (!name || name.length < 2) return null;
  return { ...candidate, id: `${candidate.id || candidate.name}:transit-landmark`, name, type: 'tourist_attraction', inferredFromTransit: true };
}
function clusterParts(latitude, longitude) { return [Math.floor((latitude + 90) / CLUSTER_SIZE), Math.floor((longitude + 180) / CLUSTER_SIZE)]; }
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
    this.oldClusters = {};
    this.usage = {};
    this.apiKey = process.env.GOOGLE_PLACES_API_KEY || '';
  }
  async load() {
    await mkdir(path.dirname(this.cacheFile), { recursive: true });
    try { const value = JSON.parse(await readFile(this.cacheFile, 'utf8')); this.cache = value.schema === CACHE_SCHEMA ? (value.cache || {}) : {}; this.usage = value.usage || {}; } catch {}
    try {
      const old = JSON.parse(await readFile(OLD_CANDIDATE_CACHE, 'utf8'));
      this.oldClusters = old.clusters || {};
      if (this.usage[monthKey()] === undefined && old.usage?.[monthKey()] !== undefined) this.usage[monthKey()] = Number(old.usage[monthKey()] || 0);
    } catch {}
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
  async save() { const temp = `${this.cacheFile}.tmp`; await writeFile(temp, `${JSON.stringify({ schema: CACHE_SCHEMA, cache: this.cache, usage: this.usage })}\n`); await rename(temp, this.cacheFile); }
  cacheValue(visit, value) {
    return {
      ...value,
      visitLatitude: visit.latitude,
      visitLongitude: visit.longitude
    };
  }
  nearbyCachedLabel(visit) {
    let best = null;
    for (const value of Object.values(this.cache)) {
      if (!value?.newLabel || value.labelSource === 'legacy-fallback') continue;
      const latitude = Number(value.visitLatitude);
      const longitude = Number(value.visitLongitude);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
      const distanceMeters = distanceKm(visit, { latitude, longitude }) * 1000;
      if (distanceMeters > SAME_PLACE_CACHE_METERS || (best && distanceMeters >= best.distanceMeters)) continue;
      best = { value, distanceMeters };
    }
    if (!best) return null;
    return {
      newLabel: best.value.newLabel,
      labelSource: 'google-visit-spatial-cache',
      labelDistanceMeters: best.value.labelDistanceMeters ?? null
    };
  }
  rememberResolvedVisits(visits = []) {
    const trustedSources = new Set(['builtin-area', 'google-visit', 'google-visit-cache', 'google-visit-spatial-cache', 'private']);
    for (const visit of visits) {
      if (!visit?.newLabel || !trustedSources.has(visit.labelSource)) continue;
      this.cache[visit.id] = this.cacheValue(visit, {
        newLabel: visit.newLabel,
        labelSource: 'learned-place',
        labelDistanceMeters: visit.labelDistanceMeters ?? null
      });
    }
  }
  privateName(visit, places) {
    return places.map(place => ({ place, km: distanceKm(visit, place) })).filter(x => x.km * 1000 <= Number(x.place.radiusMeters || 0)).sort((a, b) => a.km - b.km)[0]?.place?.name || null;
  }
  usable(candidate, visit) {
    const name = candidate.name || candidate.displayName?.text || '';
    const type = candidate.type || candidate.primaryType || '';
    const latitude = Number(candidate.latitude ?? candidate.location?.latitude);
    const longitude = Number(candidate.longitude ?? candidate.location?.longitude);
    if (!korean(name) || BANNED_NAMES.test(name) || NON_VISITOR_TYPES.has(type) || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
    return { ...candidate, name, type, latitude, longitude, distanceMeters: Math.round(distanceKm(visit, { latitude, longitude }) * 1000) };
  }
  selectCandidate(candidates, visit) {
    const nearby = candidates.filter(candidate => candidate.distanceMeters <= MAX_NEAREST_METERS).sort((a, b) => a.distanceMeters - b.distanceMeters);
    const nearest = nearby[0]; if (!nearest) return null;
    const oldName = normalizedName(visit.oldLabel || '');
    const oldCandidate = oldName ? nearby.find(candidate => normalizedName(candidate.name) === oldName) : null;
    const durationMs = Math.max(0, Number(visit.endTime || 0) - Number(visit.startTime || 0));
    const likelyStay = durationMs >= 2 * 60 * 60_000;
    const representativeCandidates = nearby.filter(candidate => LANDMARK_TYPES.has(candidate.type) || PARENT_TYPES.has(candidate.type) || (likelyStay && STAY_TYPES.has(candidate.type)));
    const nearestRepresentativeDistance = representativeCandidates[0]?.distanceMeters ?? nearest.distanceMeters;
    const oldCandidateIsRepresentative = oldCandidate && (LANDMARK_TYPES.has(oldCandidate.type) || PARENT_TYPES.has(oldCandidate.type) || (likelyStay && STAY_TYPES.has(oldCandidate.type)));
    for (const candidate of nearby) {
      const typeBonus = candidate.inferredFromTransit ? 280 : LANDMARK_TYPES.has(candidate.type) ? 320 : PARENT_TYPES.has(candidate.type) ? 210 : STAY_TYPES.has(candidate.type) ? (likelyStay ? 210 : -100) : MICRO_TYPES.has(candidate.type) ? -140 : 0;
      const popularityBonus = Number.isFinite(candidate.popularRank) ? Math.max(0, 120 - candidate.popularRank * 6) : 0;
      const ratingsBonus = Number.isFinite(candidate.ratings) ? Math.min(150, Math.log10(candidate.ratings + 1) * 50) : 0;
      const oldPlaceBonus = oldCandidate === candidate && oldCandidateIsRepresentative && candidate.distanceMeters <= Math.max(150, nearestRepresentativeDistance * 3) ? 180 : 0;
      candidate.representativeScore = typeBonus + popularityBonus + ratingsBonus + oldPlaceBonus - candidate.distanceMeters * 0.7;
    }
    return nearby.sort((a, b) => b.representativeScore - a.representativeScore || a.distanceMeters - b.distanceMeters)[0];
  }
  cachedCandidate(visit) {
    const [latPart, lonPart] = clusterParts(visit.latitude, visit.longitude);
    const candidates = [];
    for (let latOffset = -1; latOffset <= 1; latOffset++) for (let lonOffset = -1; lonOffset <= 1; lonOffset++) {
      const cluster = this.oldClusters[`${latPart + latOffset}:${lonPart + lonOffset}`];
      if (!cluster) continue;
      (cluster.distanceCandidates || []).forEach((candidate, rank) => candidates.push({ ...candidate, distanceRank: rank }));
      (cluster.popularCandidates || []).forEach((candidate, rank) => candidates.push({ ...candidate, popularRank: rank }));
    }
    const unique = new Map();
    for (const candidate of candidates) {
      const usable = this.usable(candidate, visit); if (!usable) continue;
      const key = usable.placeId || usable.id || `${usable.name}:${usable.latitude.toFixed(5)}:${usable.longitude.toFixed(5)}`;
      const existing = unique.get(key);
      if (!existing) unique.set(key, usable);
      else unique.set(key, {
        ...(usable.distanceMeters < existing.distanceMeters ? usable : existing),
        popularRank: Math.min(existing.popularRank ?? Infinity, usable.popularRank ?? Infinity),
        distanceRank: Math.min(existing.distanceRank ?? Infinity, usable.distanceRank ?? Infinity)
      });
    }
    return this.selectCandidate([...unique.values()], visit);
  }
  async search(visit) {
    const response = await fetch(ENDPOINT, {
      method: 'POST', signal: AbortSignal.timeout(20_000),
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': this.apiKey, 'X-Goog-FieldMask': 'places.id,places.displayName,places.location,places.primaryType,places.userRatingCount' },
      body: JSON.stringify({ languageCode: 'ko', maxResultCount: 20, rankPreference: 'POPULARITY', locationRestriction: { circle: { center: { latitude: visit.latitude, longitude: visit.longitude }, radius: Math.max(300, Math.min(800, visit.radiusMeters + 300)) } } })
    });
    if (!response.ok) throw new Error(`Google Places ${response.status}`);
    const body = await response.json();
    const candidates = (body.places || []).map((place, popularRank) => ({
      id: place.id, name: place.displayName?.text || '', type: place.primaryType || '', ratings: place.userRatingCount || 0,
      latitude: place.location?.latitude, longitude: place.location?.longitude, popularRank
    }));
    const expanded = [];
    for (const candidate of candidates) {
      expanded.push(candidate);
      const inferred = inferredTransitLandmark(candidate);
      if (inferred) expanded.push(inferred);
    }
    return this.selectCandidate(expanded.map(place => this.usable(place, visit)).filter(Boolean), visit);
  }
  async resolve(visits, privatePlaces) {
    // Visit IDs can change when GPS sources or clustering improve. Attach coordinates
    // to every still-matching cache entry first so nearby visits can reuse the label.
    for (const visit of visits) {
      const cached = this.cache[visit.id];
      if (cached) this.cache[visit.id] = this.cacheValue(visit, cached);
    }
    for (const visit of visits) {
      const privateName = this.privateName(visit, privatePlaces);
      if (privateName) { visit.newLabel = privateName; visit.labelSource = 'private'; continue; }
      const durationMs = Math.max(0, visit.endTime - visit.startTime);
      if (visit.photoCount <= 50 && visit.radiusMeters >= 600 && durationMs <= 20 * 60_000) {
        visit.newLabel = null; visit.labelSource = 'moving'; visit.labelDistanceMeters = null; continue;
      }
      const cached = this.cache[visit.id];
      if (cached?.newLabel && cached.labelSource !== 'legacy-fallback') { Object.assign(visit, cached); continue; }
      const nearbyCached = this.nearbyCachedLabel(visit);
      if (nearbyCached) {
        const value = this.cacheValue(visit, nearbyCached);
        Object.assign(visit, value); this.cache[visit.id] = value; continue;
      }
      const oldCandidate = this.cachedCandidate(visit);
      if (oldCandidate) {
        const value = this.cacheValue(visit, { newLabel: oldCandidate.name, labelSource: 'google-visit-cache', labelDistanceMeters: oldCandidate.distanceMeters });
        Object.assign(visit, value); this.cache[visit.id] = value; continue;
      }
      if (!this.apiKey || Number(this.usage[monthKey()] || 0) >= MONTHLY_LIMIT) {
        visit.newLabel = visit.oldLabel; visit.labelSource = 'legacy-fallback'; continue;
      }
      this.usage[monthKey()] = Number(this.usage[monthKey()] || 0) + 1;
      try {
        const place = await this.search(visit);
        const value = this.cacheValue(visit, place ? { newLabel: place.name, labelSource: 'google-visit', labelDistanceMeters: place.distanceMeters } : { newLabel: visit.oldLabel, labelSource: 'legacy-fallback' });
        Object.assign(visit, value); this.cache[visit.id] = value;
      } catch (error) { visit.newLabel = visit.oldLabel; visit.labelSource = 'legacy-fallback'; visit.labelError = error.message; }
      await this.save();
    }
    await this.save();
  }
}
