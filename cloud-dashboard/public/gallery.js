async function load() {
  const grid = document.getElementById('grid');
  const parts = location.pathname.split('/').filter(Boolean);
  const slug = parts[0] && parts[0] !== 'wall' ? parts[0] : '';
  try {
    if (slug && slug !== 'p') {
      const res = await fetch(`/api/sessions/${encodeURIComponent(slug)}`);
      const data = await res.json();
      const photos = (data.session?.photos || []).filter((p) => p.variant === 'ai' || p.variant === 'framed');
      if (!photos.length) {
        grid.innerHTML = '';
        grid.insertAdjacentHTML('afterend', '<p class="empty">No photos in this album yet.</p>');
        return;
      }
      grid.innerHTML = photos.map((p) => `<a href="${p.sharePath}"><img src="${p.url}" alt="" /></a>`).join('');
      return;
    }
    const res = await fetch('/api/wall');
    const data = await res.json();
    const photos = data.photos || [];
    if (!photos.length) {
      grid.insertAdjacentHTML('afterend', '<p class="empty">Waiting for kiosk uploads…</p>');
      return;
    }
    grid.innerHTML = photos.map((p) => `<a href="${p.sharePath}"><img src="${p.url}" alt="" /></a>`).join('');
  } catch (e) {
    grid.insertAdjacentHTML('afterend', `<p class="empty">${e.message || e}</p>`);
  }
}
load();
