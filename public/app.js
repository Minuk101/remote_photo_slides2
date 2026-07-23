const visitsElement = document.querySelector('#visits');
const summaryElement = document.querySelector('#summary');
const template = document.querySelector('#card');
const format = new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short' });

function sourceText(sources) {
  const names = { 'gpslogger-gps': 'GPSLogger 위성', 'gpslogger-network': 'GPSLogger 네트워크', 'google-timeline': 'Google 타임라인', 'embedded-corrected': '교정된 사진 GPS', embedded: '사진 GPS', 'embedded-from-old-timeline': '기존 입력 GPS' };
  return Object.entries(sources || {}).map(([key, count]) => `${names[key] || key} ${count}장`).join(' · ');
}

async function load() {
  const response = await fetch('/api/visits');
  const data = await response.json();
  const s = data.status.summary;
  if (!s) {
    summaryElement.textContent = data.status.busy ? '첫 분석 중입니다. 사진이 많으면 몇 분 걸릴 수 있습니다.' : (data.status.error || '분석 결과가 없습니다.');
    setTimeout(load, 3000); return;
  }
  summaryElement.textContent = `사진 ${s.photos.toLocaleString()}장 · 위치 확인 ${s.locatedPhotos.toLocaleString()}장 · 방문 ${s.visits.toLocaleString()}곳 · GPSLogger ${s.gpsLoggerTrackPoints.toLocaleString()}점`;
  visitsElement.replaceChildren();
  for (const visit of data.visits.slice().reverse()) {
    const card = template.content.cloneNode(true);
    const article = card.querySelector('article');
    card.querySelector('img').src = `/api/visits/${visit.id}/photos/0`;
    card.querySelector('.time').textContent = `${format.format(visit.startTime)} — ${format.format(visit.endTime)}`;
    card.querySelector('h2').textContent = visit.newLabel || visit.oldLabel || '장소 미확인';
    card.querySelector('.old').textContent = visit.oldLabel || '기존 태그 없음';
    card.querySelector('.new').textContent = visit.newLabel || '새 태그 없음';
    card.querySelector('.details').textContent = `${visit.photoCount}장 · 반경 약 ${visit.radiusMeters}m · ${sourceText(visit.sources)}`;
    const list = card.querySelector('ul');
    visit.photos.forEach((photo, index) => {
      const item = document.createElement('li');
      item.innerHTML = `<img loading="lazy" src="/api/visits/${visit.id}/photos/${index}"><span></span>`;
      item.querySelector('span').textContent = photo.name;
      list.append(item);
    });
    if (visit.oldLabel !== visit.newLabel) article.classList.add('changed');
    visitsElement.append(card);
  }
}

document.querySelector('#refresh').addEventListener('click', async event => {
  event.currentTarget.disabled = true;
  await fetch('/api/refresh', { method: 'POST' });
  summaryElement.textContent = '다시 분석 중입니다…';
  setTimeout(() => { event.currentTarget.disabled = false; load(); }, 3000);
});
load().catch(error => { summaryElement.textContent = error.message; });
