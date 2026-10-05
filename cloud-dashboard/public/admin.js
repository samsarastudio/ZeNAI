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
  document.getElementById('topbar').hidden = !ok;
  document.body.classList.toggle('is-login', !ok);
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
  document.getElementById('status').textContent = 'Signed out';
};

async function loadOverview() {
  const d = await api('/api/admin/overview');
  document.getElementById('statAlbums').textContent = d.albums;
  document.getElementById('statPhotos').textContent = d.photos;
  document.getElementById('statReleases').textContent = d.releases;
}

let photoItems = [];
let previewIndex = 0;
let photoDays = [];

function formatBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1048576) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / 1048576).toFixed(1)} MB`;
}

function renderPhotoDays() {
  const sel = document.getElementById('photoDaySelect');
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = '';
  if (!photoDays.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'No days with photos yet';
    sel.appendChild(opt);
    return;
  }
  for (const d of photoDays) {
    const opt = document.createElement('option');
    opt.value = d.day;
    opt.textContent = `${d.day} · ${d.photoCount} photo${d.photoCount === 1 ? '' : 's'} · ${formatBytes(d.bytes)}`;
    sel.appendChild(opt);
  }
  if (prev && photoDays.some((d) => d.day === prev)) sel.value = prev;
}

async function loadPhotoDays() {
  const d = await api('/api/admin/photos/days');
  photoDays = d.days || [];
  renderPhotoDays();
}

async function loadPhotos() {
  const d = await api('/api/admin/photos');
  photoItems = d.photos || [];
  renderPhotos();
  await loadPhotoDays().catch(() => {
    photoDays = [];
    renderPhotoDays();
  });
}

async function downloadPhotosZip(day) {
  const status = document.getElementById('photoZipStatus');
  const dayBtn = document.getElementById('btnDownloadDayZip');
  const allBtn = document.getElementById('btnDownloadAllZip');
  const label = day ? `day ${day}` : 'all photos';
  if (status) status.textContent = `Preparing zip for ${label}…`;
  if (dayBtn) dayBtn.disabled = true;
  if (allBtn) allBtn.disabled = true;
  try {
    const q = day ? `?day=${encodeURIComponent(day)}` : '';
    const res = await fetch(`/api/admin/photos/zip${q}`, {
      headers: { 'X-Admin-Pin': pin },
    });
    const type = res.headers.get('content-type') || '';
    if (!res.ok || type.includes('application/json')) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    const blob = await res.blob();
    const cd = res.headers.get('content-disposition') || '';
    const match = /filename="([^"]+)"/i.exec(cd);
    const filename = match?.[1] || `zyn-photos-${day || 'all'}.zip`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    if (status) status.textContent = `Downloaded ${filename} (${formatBytes(blob.size)}).`;
  } catch (e) {
    if (status) status.textContent = e.message || 'Download failed';
    alert(e.message || 'Download failed');
  } finally {
    if (dayBtn) dayBtn.disabled = false;
    if (allBtn) allBtn.disabled = false;
  }
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
      ? `<img class="job-thumb" src="${j.photoUrl}" alt="" />`
      : `<div class="job-thumb job-thumb-ph" aria-hidden="true">${j.aiStatus === 'done' ? 'Done' : 'Pending'}</div>`;
    const when = j.updatedAt ? new Date(j.updatedAt).toLocaleString() : '';
    row.innerHTML = `
      ${thumb}
      <div class="job-body">
        <p class="job-title"><strong>${j.canLabel || j.canId || 'Guest'}</strong></p>
        <p class="job-id"><code>${j.id}</code></p>
        <p class="job-pills">${statusPill('AI', j.aiStatus)}${statusPill('Upload', j.uploadStatus)}${statusPill('Print', j.printStatus)}</p>
        <p class="meta">${when}${j.lastError ? ` · ${j.lastError}` : ''}</p>
      </div>
      <div class="actions">
        <button type="button" class="btn danger sm" data-del-job="${j.id}" title="Delete job">
          <img src="/icons/trash.svg" alt="" /> Delete
        </button>
      </div>`;
    host.appendChild(row);
  }
  host.querySelectorAll('[data-del-job]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('Delete this AI job from the cloud list?')) return;
      try {
        await api(`/api/admin/booth-jobs/${encodeURIComponent(b.dataset.delJob)}`, { method: 'DELETE' });
        await loadJobs();
      } catch (e) {
        alert(e.message);
      }
    };
  });
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

function renderPhotos() {
  const host = document.getElementById('photoList');
  host.innerHTML = '';
  if (!photoItems.length) {
    host.innerHTML = '<p class="meta">No photos yet.</p>';
    return;
  }
  photoItems.forEach((p, idx) => {
    const el = document.createElement('div');
    el.className = 'row';
    el.innerHTML = `
      <img src="${p.url}" alt="" data-preview="${idx}" />
      <p><strong>${p.canLabel || p.variant}</strong><br/>
      <span class="meta">${p.sessionSlug} · ${p.createdAt || ''}</span></p>
      <div class="actions">
        <button type="button" class="btn ghost sm" data-preview-btn="${idx}">
          <img src="/icons/eye.svg" alt="" /> Preview
        </button>
        <button type="button" class="btn danger sm" data-del="${p.id}">
          <img src="/icons/trash.svg" alt="" /> Delete
        </button>
      </div>`;
    host.appendChild(el);
  });
  host.querySelectorAll('[data-preview]').forEach((img) => {
    img.onclick = () => openPreview(Number(img.dataset.preview));
  });
  host.querySelectorAll('[data-preview-btn]').forEach((b) => {
    b.onclick = () => openPreview(Number(b.dataset.previewBtn));
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

function openPreview(idx) {
  if (!photoItems[idx]) return;
  previewIndex = idx;
  const p = photoItems[idx];
  document.getElementById('lightboxImg').src = p.url;
  document.getElementById('lightboxCap').textContent =
    `${p.canLabel || p.variant} · ${p.sessionSlug || ''} · ${p.createdAt || ''}`;
  document.getElementById('lightbox').hidden = false;
}

function closePreview() {
  document.getElementById('lightbox').hidden = true;
  document.getElementById('lightboxImg').src = '';
}

async function loadSettings() {
  const d = await api('/api/admin/settings');
  const s = d.settings;
  document.getElementById('publicBaseUrl').value = s.publicBaseUrl || '';
  document.getElementById('uploadToken').value = s.uploadToken || '';
  document.getElementById('ttl').value = String(s.defaultTtlDays || 30);
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
      <div class="actions">
        <button type="button" class="btn sm" data-roll="${r.id}">Roll out</button>
        <button type="button" class="btn danger sm" data-delrel="${r.id}">
          <img src="/icons/trash.svg" alt="" /> Delete
        </button>
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
document.getElementById('btnDownloadDayZip').onclick = () => {
  const day = document.getElementById('photoDaySelect')?.value?.trim();
  if (!day) {
    alert('No event day selected');
    return;
  }
  downloadPhotosZip(day);
};
document.getElementById('btnDownloadAllZip').onclick = () => downloadPhotosZip('');
document.getElementById('btnRefreshJobs').onclick = () => loadJobs();
document.getElementById('lightboxClose').onclick = closePreview;
document.getElementById('lightboxBackdrop').onclick = closePreview;
document.getElementById('lightboxPrev').onclick = () => {
  if (!photoItems.length) return;
  openPreview((previewIndex - 1 + photoItems.length) % photoItems.length);
};
document.getElementById('lightboxNext').onclick = () => {
  if (!photoItems.length) return;
  openPreview((previewIndex + 1) % photoItems.length);
};
document.addEventListener('keydown', (e) => {
  if (document.getElementById('lightbox').hidden) return;
  if (e.key === 'Escape') closePreview();
  if (e.key === 'ArrowLeft') document.getElementById('lightboxPrev').click();
  if (e.key === 'ArrowRight') document.getElementById('lightboxNext').click();
});

document.getElementById('btnSaveSettings').onclick = async () => {
  await api('/api/admin/settings', {
    method: 'PATCH',
    body: JSON.stringify({
      publicBaseUrl: document.getElementById('publicBaseUrl').value,
      uploadToken: document.getElementById('uploadToken').value,
      defaultTtlDays: Number(document.getElementById('ttl').value),
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
