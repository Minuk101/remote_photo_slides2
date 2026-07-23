const INTERVAL = 10_000, PREFETCH = 8;
let photos = [], order = [], cursor = 0, active = 0, version = '', timer = null, generation = 0;
const layers = [
  { photo: document.querySelector('#photo-a'), bg: document.querySelector('#bg-a') },
  { photo: document.querySelector('#photo-b'), bg: document.querySelector('#bg-b') }
];
const empty = document.querySelector('#empty'), locationCard = document.querySelector('#location'), notice = document.querySelector('#notice');

function shuffle(values) { for (let i = values.length - 1; i > 0; i--) { const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1); [values[i], values[j]] = [values[j], values[i]]; } return values; }
function rebuild(keepCurrent = true) {
  const currentId = keepCurrent && order[cursor - 1]?.id;
  order = shuffle([...photos]); cursor = 0;
  if (currentId) { const index = order.findIndex(photo => photo.id === currentId); if (index >= 0) [order[0], order[index]] = [order[index], order[0]]; cursor = 1; }
}
function nextPhoto() { if (!order.length) return null; if (cursor >= order.length) rebuild(false); return order[cursor++]; }
function loadImage(url) { return new Promise((resolve, reject) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = reject; image.src = url; }); }
function prefetch() { for (let i = 0; i < Math.min(PREFETCH, order.length); i++) { const photo = order[(cursor + i) % order.length]; if (photo) { const image = new Image(); image.decoding = 'async'; image.src = photo.url; } } }
function showLocation(photo) {
  const value = photo.location;
  if (!value?.name) { locationCard.classList.remove('visible'); return; }
  locationCard.querySelector('strong').textContent = value.name;
  locationCard.querySelector('small').textContent = value.radiusMeters ? `이동 기록 기반 · 약 ${value.radiusMeters}m 범위` : '이동 기록 기반';
  locationCard.href = `https://www.google.com/maps/search/?api=1&query=${value.latitude},${value.longitude}`;
  locationCard.classList.add('visible');
}
async function advance() {
  const photo = nextPhoto(); if (!photo) return;
  const run = ++generation;
  try {
    const loaded = await loadImage(photo.url); if (run !== generation) return;
    const next = 1 - active, layer = layers[next];
    layer.photo.src = loaded.src; layer.bg.src = loaded.src;
    requestAnimationFrame(() => { layers[active].photo.classList.remove('visible'); layers[active].bg.classList.remove('visible'); layer.photo.classList.add('visible'); layer.bg.classList.add('visible'); active = next; });
    empty.hidden = true; showLocation(photo); prefetch();
  } catch { notice.textContent = '사진을 다시 불러오는 중…'; setTimeout(advance, 1000); }
}
async function refresh(force = false) {
  try {
    const data = await fetch(`/api/photos${force ? '?refresh=1' : ''}`, { cache: 'no-store' }).then(r => r.json());
    if (data.version !== version) { const oldIds = new Set(photos.map(p => p.id)); photos = data.photos; version = data.version; const added = photos.filter(p => !oldIds.has(p.id)); if (!order.length) rebuild(false); else if (added.length) order.splice(cursor, 0, ...shuffle(added)); }
    if (!photos.length) { empty.hidden = false; empty.querySelector('strong').textContent = '재생할 사진이 없습니다'; }
    notice.textContent = '';
  } catch { notice.textContent = 'PC 서버 연결을 기다리는 중…'; }
}
document.querySelector('#fullscreen').onclick = async () => { if (!document.fullscreenElement) await document.documentElement.requestFullscreen(); else await document.exitFullscreen(); };
document.addEventListener('fullscreenchange', () => { document.querySelector('#fullscreen').textContent = document.fullscreenElement ? '전체화면 종료' : '전체화면'; });
await refresh(true); await advance(); timer = setInterval(advance, INTERVAL); setInterval(() => refresh(false), 15_000);
