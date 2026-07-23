let current = '', selected = [];
const $ = value => document.querySelector(value);
const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function renderSelected() {
  $('#count').textContent = `${selected.length}개`;
  $('#selected').innerHTML = selected.length ? selected.map(folder => `<div><span>${escape(folder || '전체')}</span><button data-remove="${escape(folder)}">삭제</button></div>`).join('') : '<p>선택한 폴더가 없습니다.</p>';
  document.querySelectorAll('[data-remove]').forEach(button => button.onclick = () => { selected = selected.filter(value => value !== button.dataset.remove); renderSelected(); });
}
function breadcrumbs() {
  const parts = current.split('/').filter(Boolean), items = [{ name: '사진', path: '' }]; let built = '';
  for (const part of parts) { built = built ? `${built}/${part}` : part; items.push({ name: part, path: built }); }
  $('#breadcrumbs').innerHTML = items.map(item => `<button data-path="${escape(item.path)}">${escape(item.name)}</button>`).join('<span>›</span>');
  document.querySelectorAll('[data-path]').forEach(button => button.onclick = () => loadFolders(button.dataset.path));
}
async function loadFolders(folder = '') {
  current = folder; breadcrumbs(); $('#folders').textContent = '불러오는 중…';
  const data = await fetch(`/api/folders?path=${encodeURIComponent(folder)}`).then(r => r.json());
  $('#folders').innerHTML = data.folders.length ? data.folders.map(item => `<button data-folder="${escape(item.path)}"><span>📁</span>${escape(item.name)}</button>`).join('') : '<p>하위 폴더가 없습니다.</p>';
  document.querySelectorAll('[data-folder]').forEach(button => button.onclick = () => loadFolders(button.dataset.folder));
}
async function start() {
  const config = await fetch('/api/config').then(r => r.json()); selected = [...config.selectedFolders];
  $('#status').textContent = 'PC 서버 연결됨'; $('#root').textContent = `${config.photoRoot} · 위치 분석 ${config.analysis.summary?.locatedPhotos?.toLocaleString() || 0}장`;
  renderSelected(); await loadFolders('');
}
$('#select').onclick = () => { if (!selected.includes(current)) selected.push(current); renderSelected(); };
$('#save').onclick = async () => { const button = $('#save'); button.disabled = true; await fetch('/api/selection', { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ selectedFolders: selected }) }); $('#message').textContent = '저장했습니다. 슬라이드쇼에 곧 반영됩니다.'; button.disabled = false; };
start().catch(error => { $('#status').textContent = error.message; });
