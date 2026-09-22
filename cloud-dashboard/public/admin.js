let pin = sessionStorage.getItem('zyn-cloud-pin') || '';

async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}), 'X-Admin-Pin': pin };
  if (opts.body && !(opts.body instanceof FormData) && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(path, { ...opts, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function showPanel(ok) {
  document.getElementById('loginCard').hidden = ok;
  document.getElementById('panel').hidden = !ok;
  document.getElementById('btnSignOut').hidden = !ok;
  if (ok) {
    document.getElementById('loginErr').hidden = true;
    document.getElementById('loginErr').textContent = '';
    document.getElementById('pin').value = '';
  }
}

function activateTab(tabId) {
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tabId));
  document.querySelectorAll('.section').forEach((s) => {
    const on = s.dataset.section === tabId;
    s.classList.toggle('is-active', on);
    s.hidden = !on;
  });
}

document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    activateTab(btn.dataset.tab);
    if (btn.dataset.tab === 'jobs') loadJobs().catch(() => {});
  });
});

document.getElementById('btnSignOut').onclick = () => {
  pin = '';
  sessionStorage.removeItem('zyn-cloud-pin');
  showPanel(false);
  document.getElementById('status').textContent = '';
};

async function loadOverview() {
  const d = await api('/api/admin/overview');
  document.getElementById('statAlbums').textContent = d.albums;
  document.getElementById('statPhotos').textContent = d.photos;
  document.getElementById('statEmailed').textContent = d.emailed;
  document.getElementById('statFailed').textContent = d.failed;
  document.getElementById('statGallery').textContent = d.gallery ?? 0;
  document.getElementById('statReleases').textContent = d.releases;
}

let photoItems = [];
let photoFilter = 'all';
let previewIndex = 0;

async function loadPhotos() {
  const d = await api('/api/admin/photos');
  photoItems = d.photos || [];
  renderPhotos();
}

let jobItems = [];
let jobsPollTimer = null;

function statusPill(label, value) {
  const v = String(value || 'idle');
  return `<span class="pill ${v}">${label}: ${v}</span>`;
}

async function loadJobs() {
  const d = await api('/api/admin/booth-jobs');
  jobItems = d.jobs || [];
  renderJobs();
}

function renderJobs() {
  const host = document.getElementById('jobList');
  if (!host) return;
  host.innerHTML = '';
  if (!jobItems.length) {
    host.innerHTML = '<p class="meta">No booth AI jobs yet. Status appears when the kiosk starts generating.</p>';
    return;
  }
  for (const j of jobItems) {
    const row = document.createElement('div');
    row.className = 'row job-row';
    const thumb = j.photoUrl
      ? `<img src="${j.photoUrl}" alt="" />`
      : `<div style="width:120px;height:120px;border-radius:8px;background:#07140f;display:grid;place-items:center;color:#9cb3a8;font-size:0.75rem">AI pending</div>`;
    const when = j.updatedAt ? new Date(j.updatedAt).toLocaleString() : '';
    row.innerHTML = `
      ${thumb}
      <div>
        <p><strong>${j.canLabel || j.canId || 'Guest'}</strong> · <code>${j.id}</code></p>
        <p>${statusPill('AI', j.aiStatus)}${statusPill('Upload', j.uploadStatus)}${statusPill('Print', j.printStatus)}</p>
        <p class="meta">${when}${j.lastError ? ` · ${j.lastError}` : ''}</p>
      </div>`;
    host.appendChild(row);
  }
}

function startJobsPolling() {
  if (jobsPollTimer) return;
  jobsPollTimer = setInterval(() => {
    const section = document.querySelector('[data-section="jobs"]');
    if (section && !section.hidden) {
      loadJobs().catch(() => {});
    }
  }, 4000);
}

function filteredPhotos() {
  if (photoFilter === 'gallery') return photoItems.filter((p) => p.galleryPicked);
  if (photoFilter === 'inbox') return photoItems.filter((p) => !p.galleryPicked);
  return photoItems;
}

function renderPhotos() {
  const host = document.getElementById('photoList');
  host.innerHTML = '';
  const list = filteredPhotos();
  if (!list.length) {
    host.innerHTML = '<p class="meta">No photos in this view.</p>';
    return;
  }
  list.forEach((p, idx) => {
    const el = document.createElement('div');
    el.className = 'row';
    el.innerHTML = `
      <img src="${p.url}" alt="" data-preview="${idx}" />
      <p><strong>${p.canLabel || p.variant}</strong>
        ${p.galleryPicked ? ' · on gallery' : ''}<br/>
      ${p.guestEmail || 'no email'} · ${p.emailStatus || 'idle'}<br/>
      <span class="meta">${p.sessionSlug} · ${p.createdAt || ''}</span></p>
      <div class="actions">
        <button type="button" class="btn" data-gallery="${p.id}" data-on="${p.galleryPicked ? '1' : '0'}">
          ${p.galleryPicked ? 'Remove from gallery' : 'Send to gallery'}
        </button>
        <button type="button" class="btn ghost" data-email="${p.id}">Retry email</button>
        <button type="button" class="btn ghost" data-del="${p.id}">Delete</button>
      </div>`;
    host.appendChild(el);
  });
  host.querySelectorAll('[data-preview]').forEach((img) => {
    img.onclick = () => openPreview(Number(img.dataset.preview));
  });
  host.querySelectorAll('[data-gallery]').forEach((b) => {
    b.onclick = () => toggleGallery(b.dataset.gallery, b.dataset.on !== '1');
  });
  host.querySelectorAll('[data-email]').forEach((b) => {
    b.onclick = async () => {
      try {
        await api(`/api/admin/photos/${b.dataset.email}/email`, { method: 'POST', body: '{}' });
        await loadPhotos();
        await loadOverview();
      } catch (e) {
        alert(e.message);
      }
    };
  });
  host.querySelectorAll('[data-del]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('Delete this photo from the cloud?')) return;
      await api(`/api/admin/photos/${b.dataset.del}`, { method: 'DELETE' });
      await loadPhotos();
      await loadOverview();
    };
  });
}

async function toggleGallery(id, on) {
  await api(`/api/admin/photos/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ galleryPicked: on }),
  });
  await loadPhotos();
  await loadOverview();
  if (!document.getElementById('lightbox').hidden) {
    const list = filteredPhotos();
    const next = list.findIndex((p) => p.id === id);
    if (next >= 0) openPreview(next);
  }
}

function openPreview(idx) {
  const list = filteredPhotos();
  if (!list[idx]) return;
  previewIndex = idx;
  const p = list[idx];
  document.getElementById('lightboxImg').src = p.url;
  document.getElementById('lightboxCap').textContent =
    `${p.canLabel || p.variant} · ${p.sessionSlug || ''} · ${p.galleryPicked ? 'on gallery' : 'not on gallery'}`;
  document.getElementById('lightboxGallery').textContent = p.galleryPicked
    ? 'Remove from gallery'
    : 'Send to gallery';
  document.getElementById('lightbox').hidden = false;
}

function closePreview() {
  document.getElementById('lightbox').hidden = true;
  document.getElementById('lightboxImg').src = '';
}

async function loadSettings() {
  const d = await api('/api/admin/settings');
  const s = d.settings;
  document.getElementById('emailEnabled').checked = !!s.emailEnabled;
  document.getElementById('sendgridApiUrl').value = s.sendgridApiUrl || '';
  document.getElementById('emailFrom').value = s.emailFrom || '';
  document.getElementById('emailFromName').value = s.emailFromName || '';
  document.getElementById('emailSubject').value = s.emailSubject || '';
  document.getElementById('emailBody').value = s.emailBody || '';
  document.getElementById('keyHint').textContent = s.apiKeyConfigured ? '(saved — leave blank to keep)' : '';
  document.getElementById('publicBaseUrl').value = s.publicBaseUrl || '';
  document.getElementById('uploadToken').value = s.uploadToken || '';
  document.getElementById('displayToken').value = s.displayToken || '';
  document.getElementById('ttl').value = String(s.defaultTtlDays || 30);
  document.getElementById('displayIntervalMs').value = String(s.displayIntervalMs || 8000);
  document.getElementById('autoGalleryPickAi').checked = !!s.autoGalleryPickAi;
}

async function loadReleases() {
  const d = await api('/api/admin/booth-updates');
  const host = document.getElementById('releaseList');
  host.innerHTML = '';
  for (const r of d.releases || []) {
    const el = document.createElement('div');
    el.className = 'row';
    el.innerHTML = `
      <div></div>
      <p><strong>v${r.version}</strong> ${r.active ? '· ROLLED OUT' : ''}<br/>
      <span class="meta">${r.buildId} · ${Math.round((r.bytes || 0) / 1048576)} MB</span></p>
      <div>
        <button type="button" class="btn" data-roll="${r.id}">Roll out</button>
        <button type="button" class="btn ghost" data-delrel="${r.id}">Delete</button>
      </div>`;
    host.appendChild(el);
  }
  host.querySelectorAll('[data-roll]').forEach((b) => {
    b.onclick = async () => {
      await api(`/api/admin/booth-updates/${b.dataset.roll}/rollout`, { method: 'POST', body: '{}' });
      await loadReleases();
    };
  });
  host.querySelectorAll('[data-delrel]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('Delete this OTA package?')) return;
      await api(`/api/admin/booth-updates/${b.dataset.delrel}`, { method: 'DELETE' });
      await loadReleases();
    };
  });
}

async function boot() {
  try {
    await loadOverview();
    await loadSettings();
    await loadPhotos();
    await loadJobs();
    await loadReleases();
    showPanel(true);
    activateTab('overview');
    startJobsPolling();
    document.getElementById('status').textContent = 'Signed in';
  } catch (e) {
    pin = '';
    sessionStorage.removeItem('zyn-cloud-pin');
    showPanel(false);
    document.getElementById('loginErr').hidden = false;
    document.getElementById('loginErr').textContent = e.message;
  }
}

document.getElementById('loginForm').onsubmit = async (e) => {
  e.preventDefault();
  pin = document.getElementById('pin').value.trim();
  sessionStorage.setItem('zyn-cloud-pin', pin);
  document.getElementById('loginErr').hidden = true;
  await boot();
};

document.getElementById('btnRefreshPhotos').onclick = () => loadPhotos();
document.getElementById('btnRefreshJobs').onclick = () => loadJobs();
document.querySelectorAll('.photo-toolbar [data-filter]').forEach((btn) => {
  btn.onclick = () => {
    photoFilter = btn.dataset.filter;
    renderPhotos();
  };
});
document.getElementById('lightboxClose').onclick = closePreview;
document.getElementById('lightboxBackdrop').onclick = closePreview;
document.getElementById('lightboxPrev').onclick = () => {
  const list = filteredPhotos();
  if (!list.length) return;
  openPreview((previewIndex - 1 + list.length) % list.length);
};
document.getElementById('lightboxNext').onclick = () => {
  const list = filteredPhotos();
  if (!list.length) return;
  openPreview((previewIndex + 1) % list.length);
};
document.getElementById('lightboxGallery').onclick = async () => {
  const p = filteredPhotos()[previewIndex];
  if (!p) return;
  await toggleGallery(p.id, !p.galleryPicked);
};
document.addEventListener('keydown', (e) => {
  if (document.getElementById('lightbox').hidden) return;
  if (e.key === 'Escape') closePreview();
  if (e.key === 'ArrowLeft') document.getElementById('lightboxPrev').click();
  if (e.key === 'ArrowRight') document.getElementById('lightboxNext').click();
});
document.getElementById('btnSaveEmail').onclick = async () => {
  await api('/api/admin/settings', {
    method: 'PATCH',
    body: JSON.stringify({
      emailEnabled: document.getElementById('emailEnabled').checked,
      sendgridApiUrl: document.getElementById('sendgridApiUrl').value,
      sendgridApiKey: document.getElementById('sendgridApiKey').value,
      emailFrom: document.getElementById('emailFrom').value,
      emailFromName: document.getElementById('emailFromName').value,
      emailSubject: document.getElementById('emailSubject').value,
      emailBody: document.getElementById('emailBody').value,
    }),
  });
  document.getElementById('sendgridApiKey').value = '';
  await loadSettings();
  alert('Email settings saved');
};
document.getElementById('btnSaveSettings').onclick = async () => {
  await api('/api/admin/settings', {
    method: 'PATCH',
    body: JSON.stringify({
      publicBaseUrl: document.getElementById('publicBaseUrl').value,
      uploadToken: document.getElementById('uploadToken').value,
      displayToken: document.getElementById('displayToken').value,
      defaultTtlDays: Number(document.getElementById('ttl').value),
      displayIntervalMs: Number(document.getElementById('displayIntervalMs').value),
      autoGalleryPickAi: document.getElementById('autoGalleryPickAi').checked,
    }),
  });
  await loadSettings();
  alert('Settings saved');
};
document.getElementById('btnUploadOta').onclick = async () => {
  const file = document.getElementById('otaFile').files[0];
  if (!file) {
    alert('Choose a Folder zip');
    return;
  }
  const fd = new FormData();
  fd.append('package', file);
  fd.append('version', document.getElementById('otaVersion').value.trim());
  fd.append('buildId', document.getElementById('otaBuildId').value.trim());
  fd.append('notes', document.getElementById('otaNotes').value.trim());
  const progress = document.getElementById('otaProgress');
  progress.textContent = 'Uploading…';
  try {
    const data = await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/admin/booth-updates');
      xhr.setRequestHeader('X-Admin-Pin', pin);
      xhr.upload.onprogress = (ev) => {
        if (!ev.lengthComputable) return;
        const pct = Math.round((ev.loaded / ev.total) * 100);
        progress.textContent = `Uploading… ${pct}% (${Math.round(ev.loaded / 1048576)} / ${Math.round(ev.total / 1048576)} MB)`;
      };
      xhr.onload = () => {
        let body = {};
        try {
          body = JSON.parse(xhr.responseText || '{}');
        } catch {
          /* ignore */
        }
        if (xhr.status >= 200 && xhr.status < 300 && body.ok !== false) resolve(body);
        else reject(new Error(body.error || `HTTP ${xhr.status}`));
      };
      xhr.onerror = () => reject(new Error('Network error during OTA upload'));
      xhr.send(fd);
    });
    const rel = data.release;
    progress.textContent = rel
      ? `Uploaded v${rel.version} (${rel.buildId}). Roll out to make it live.`
      : 'Uploaded. Roll out to make it live.';
    if (rel?.version && !document.getElementById('otaVersion').value.trim()) {
      document.getElementById('otaVersion').value = rel.version;
    }
    if (rel?.buildId && !document.getElementById('otaBuildId').value.trim()) {
      document.getElementById('otaBuildId').value = rel.buildId;
    }
    await loadReleases();
  } catch (e) {
    progress.textContent = e.message;
  }
};
document.getElementById('btnClearRollout').onclick = async () => {
  await api('/api/admin/booth-updates/clear-rollout', { method: 'POST', body: '{}' });
  await loadReleases();
};

if (pin) boot();
