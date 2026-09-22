let items = [];
let index = 0;
let timer = null;
let intervalMs = 8000;
let settings = { apiBase: 'http://127.0.0.1:3040', token: 'zyn-display' };

const stage = document.getElementById('stage');
const settingsEl = document.getElementById('settings');
const form = document.getElementById('form');

function showCurrent() {
  if (!items.length) {
    stage.innerHTML = '<p class="empty">Waiting for curated photos…</p>';
    return;
  }
  const item = items[index % items.length];
  const src = settings.apiBase + item.imageUrl;
  stage.innerHTML = `<img src="${src}" alt="${item.canLabel || 'photo'}" />`;
}

async function pullFeed() {
  try {
    const url = `${settings.apiBase}/api/display/feed?token=${encodeURIComponent(settings.token)}`;
    const res = await fetch(url);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'feed failed');
    items = data.items || [];
    intervalMs = data.intervalMs || 8000;
    if (index >= items.length) index = 0;
    showCurrent();
  } catch (e) {
    stage.innerHTML = `<p class="empty">Cannot reach kiosk API at ${settings.apiBase}<br/>${e.message || e}</p>`;
  }
}

function start() {
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    if (!items.length) return;
    index = (index + 1) % items.length;
    showCurrent();
  }, intervalMs);
  void pullFeed();
  setInterval(() => void pullFeed(), 12000);
}

document.getElementById('gear').onclick = () => settingsEl.classList.add('open');
document.getElementById('close').onclick = () => settingsEl.classList.remove('open');
form.onsubmit = async (e) => {
  e.preventDefault();
  const fd = new FormData(form);
  settings = await window.displayApi.saveSettings({
    apiBase: fd.get('apiBase'),
    token: fd.get('token'),
  });
  settingsEl.classList.remove('open');
  start();
};

(async () => {
  settings = await window.displayApi.getSettings();
  form.apiBase.value = settings.apiBase || '';
  form.token.value = settings.token || '';
  start();
})();
