(async () => {
  const CONFIG = window.MAP_CONFIG;
  const CATEGORIES = CONFIG.categories;
  const FALLBACK_CAT = { label: 'Другое', icon: '📍', color: '#6b7280' };

  const $ = (id) => document.getElementById(id);
  const cat = (key) => CATEGORIES[key] || FALLBACK_CAT;
  const newId = () => 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const esc = (s = '') => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const round6 = (n) => +n.toFixed(6);

  // ================= storage =================
  // Remote = Supabase (shared for everyone), local = this browser only (demo mode).
  const SB = window.SUPABASE || {};
  const supa = SB.url && SB.anonKey && window.supabase ? window.supabase.createClient(SB.url, SB.anonKey) : null;

  const LOCAL_KEY = 'la-spots-v2';
  const hash = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 0).toString(36);
  const seedHash = hash(JSON.stringify(window.PLACES || []));

  const store = supa ? {
    remote: true,
    async load() {
      const { data, error } = await supa.from('places').select('id, data').order('created_at');
      if (error) throw error;
      return data.map((r) => ({ ...r.data, id: r.id }));
    },
    async upsert(p) {
      const { id, ...data } = p;
      const { error } = await supa.from('places').upsert({ id, data, updated_at: new Date().toISOString() });
      if (error) throw error;
    },
    async remove(id) {
      const { error } = await supa.from('places').delete().eq('id', id);
      if (error) throw error;
    },
    async replaceAll(list) {
      const del = await supa.from('places').delete().neq('id', '');
      if (del.error) throw del.error;
      if (!list.length) return;
      const { error } = await supa.from('places').insert(list.map(({ id, ...data }) => ({ id, data })));
      if (error) throw error;
    },
  } : {
    remote: false,
    async load() {
      try {
        const saved = JSON.parse(localStorage.getItem(LOCAL_KEY));
        // data.js changed since these local edits were made → data.js wins
        if (saved && saved.seed === seedHash) return saved.places;
      } catch (_) { /* ignore */ }
      return JSON.parse(JSON.stringify(window.PLACES || []));
    },
    save() {
      try { localStorage.setItem(LOCAL_KEY, JSON.stringify({ seed: seedHash, places })); } catch (_) { /* ignore */ }
    },
    async upsert() { this.save(); },
    async remove() { this.save(); },
    async replaceAll() { this.save(); },
  };

  async function persist(action) {
    try {
      await action();
      return true;
    } catch (err) {
      console.error(err);
      const denied = /row-level security|permission|JWT/i.test(err.message || '');
      alert(denied
        ? 'Нет прав на изменение. Проверь, что ты вошёл и что твой аккаунт добавлен в таблицу admins.'
        : 'Не удалось сохранить: ' + (err.message || err));
      places = await store.load().catch(() => places);
      render();
      return false;
    }
  }

  // ================= state =================
  let places = [];
  let editMode = false;
  let mode = 'idle'; // idle | addPoint | drawArea
  let selectedId = null;
  let draft = null;  // polygon being drawn: { coords: [[lat,lng]], placeId }
  const activeFilters = new Set(Object.keys(CATEGORIES));
  const layers = new Map();

  // ================= map =================
  document.title = CONFIG.title;
  $('brandTitle').textContent = CONFIG.title;

  const map = L.map('map', { zoomControl: false }).setView(CONFIG.center, CONFIG.zoom);
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);
  const draftLayer = L.layerGroup().addTo(map);

  map.on('click', (e) => {
    const ll = [round6(e.latlng.lat), round6(e.latlng.lng)];
    if (mode === 'addPoint') {
      setMode('idle');
      openForm(blankPlace({ type: 'point', lat: ll[0], lng: ll[1] }));
    } else if (mode === 'drawArea') {
      draft.coords.push(ll);
      renderDraft();
    } else {
      closePanel();
    }
  });

  function blankPlace(extra) {
    return { id: null, category: Object.keys(CATEGORIES)[0], title: '', description: '', photoTips: '', link: '', photos: [], ...extra };
  }

  // ================= rendering =================
  function render() {
    layers.forEach((l) => l.remove());
    layers.clear();
    for (const p of places) {
      if (CATEGORIES[p.category] && !activeFilters.has(p.category)) continue;
      if (draft && draft.placeId === p.id) continue; // being reshaped
      const layer = p.type === 'area' ? makeArea(p) : makeMarker(p);
      layer.addTo(map);
      layers.set(p.id, layer);
    }
    renderFilters();
  }

  function makeMarker(p) {
    const c = cat(p.category);
    const icon = L.divIcon({
      className: 'pin-wrap',
      html: `<div class="pin${p.id === selectedId ? ' selected' : ''}" style="--c:${c.color}"><span>${c.icon}</span></div>`,
      iconSize: [36, 44],
      iconAnchor: [18, 44],
    });
    const m = L.marker([p.lat, p.lng], { icon, draggable: editMode, riseOnHover: true });
    m.bindTooltip(esc(p.title), { direction: 'top', offset: [0, -44] });
    m.on('click', (e) => (mode === 'idle' ? openPlace(p.id) : map.fire('click', { latlng: e.latlng })));
    m.on('dragend', () => {
      const ll = m.getLatLng();
      p.lat = round6(ll.lat);
      p.lng = round6(ll.lng);
      persist(() => store.upsert(p));
    });
    return m;
  }

  function makeArea(p) {
    const c = cat(p.category);
    const selected = p.id === selectedId;
    const poly = L.polygon(p.coords, { color: c.color, weight: selected ? 4 : 2, fillOpacity: selected ? 0.35 : 0.2 });
    poly.bindTooltip(esc(p.title), { sticky: true });
    poly.on('click', (e) => {
      L.DomEvent.stopPropagation(e);
      if (mode === 'idle') openPlace(p.id);
      else map.fire('click', { latlng: e.latlng }); // let drawing/adding work on top of areas
    });
    return poly;
  }

  function renderFilters() {
    const counts = {};
    places.forEach((p) => { counts[p.category] = (counts[p.category] || 0) + 1; });
    $('filters').innerHTML = Object.entries(CATEGORIES).map(([key, c]) =>
      `<button class="chip${activeFilters.has(key) ? ' on' : ''}" data-key="${key}" style="--c:${c.color}">${c.icon} ${esc(c.label)} <b>${counts[key] || 0}</b></button>`
    ).join('');
  }
  $('filters').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    const key = chip.dataset.key;
    activeFilters.has(key) ? activeFilters.delete(key) : activeFilters.add(key);
    render();
  });

  function placeCenter(p) {
    return p.type === 'area' ? L.polygon(p.coords).getBounds().getCenter() : L.latLng(p.lat, p.lng);
  }

  // ================= panel: view =================
  function openPlace(id) {
    const p = places.find((x) => x.id === id);
    if (!p) return;
    selectedId = id;
    render();
    const c = cat(p.category);
    const center = placeCenter(p);
    const gmaps = `https://www.google.com/maps/search/?api=1&query=${center.lat},${center.lng}`;
    const isInsta = /instagram\.com/i.test(p.link || '');

    const header = p.photos && p.photos.length
      ? `<div class="gallery">${p.photos.map((src) => `<img src="${esc(src)}" alt="${esc(p.title)}" loading="lazy">`).join('')}</div>
         ${p.photos.length > 1 ? `<div class="gallery-count">📷 ${p.photos.length} фото — листай</div>` : ''}`
      : `<div class="cover" style="--c:${c.color}">${c.icon}</div>`;

    $('panelBody').innerHTML = `
      ${header}
      <div class="place">
        <span class="badge" style="--c:${c.color}">${c.icon} ${esc(c.label)}</span>
        <h2>${esc(p.title)}</h2>
        ${p.description ? `<p>${esc(p.description)}</p>` : ''}
        ${p.photoTips ? `<div class="tip"><h3>📸 Что снять для Instagram</h3><p>${esc(p.photoTips)}</p></div>` : ''}
        <div class="place-actions">
          <a class="btn" href="${gmaps}" target="_blank" rel="noopener">📍 Открыть в Google Maps</a>
          ${p.link ? `<a class="btn btn-ghost" href="${esc(p.link)}" target="_blank" rel="noopener">${isInsta ? '▶ Пример в Instagram' : '🔗 Ссылка'}</a>` : ''}
          ${editMode ? `<button class="btn btn-ghost" id="editPlaceBtn">✏️ Изменить</button>` : ''}
          ${editMode && p.type === 'area' ? `<button class="btn btn-ghost" id="reshapeBtn">⬠ Перерисовать</button>` : ''}
        </div>
      </div>`;
    $('panel').hidden = false;

    $('panelBody').querySelectorAll('.gallery img').forEach((img) =>
      img.addEventListener('click', () => { $('lightboxImg').src = img.src; $('lightbox').hidden = false; }));
    if (editMode) {
      $('editPlaceBtn').onclick = () => openForm(JSON.parse(JSON.stringify(p)));
      if (p.type === 'area') $('reshapeBtn').onclick = () => startDrawing(p);
    }
    if (!map.getBounds().contains(center)) map.panTo(center);
  }

  function closePanel() {
    $('panel').hidden = true;
    if (selectedId) { selectedId = null; render(); }
  }
  $('panelClose').onclick = closePanel;
  $('lightbox').onclick = () => { $('lightbox').hidden = true; };

  // ================= panel: edit form =================
  function openForm(p) {
    const isNew = !p.id;
    $('panelBody').innerHTML = `
      <form class="form" id="placeForm">
        <h2>${isNew ? (p.type === 'area' ? 'Новая область' : 'Новая точка') : 'Редактирование'}</h2>
        <label class="field"><span>Название</span>
          <input name="title" required value="${esc(p.title)}" placeholder="Например: Venice Beach">
        </label>
        <label class="field"><span>Категория</span>
          <select name="category">${Object.entries(CATEGORIES).map(([k, c]) =>
            `<option value="${k}"${k === p.category ? ' selected' : ''}>${c.icon} ${esc(c.label)}</option>`).join('')}
          </select>
        </label>
        <label class="field"><span>Описание места</span>
          <textarea name="description" placeholder="Что это за место, чем заняться, часы работы">${esc(p.description)}</textarea>
        </label>
        <label class="field"><span>Что снять для Instagram</span>
          <textarea name="photoTips" placeholder="Лучшее время, ракурс, идеи кадров">${esc(p.photoTips)}</textarea>
        </label>
        <label class="field"><span>Ссылка (например, пример в Instagram)</span>
          <input name="link" type="url" value="${esc(p.link)}" placeholder="https://www.instagram.com/reel/...">
        </label>
        <div class="form-actions">
          <button class="btn active" type="submit">Сохранить</button>
          <button class="btn btn-ghost" type="button" id="cancelBtn">Отмена</button>
          <span class="spacer"></span>
          ${isNew ? '' : '<button class="btn btn-danger" type="button" id="deleteBtn">Удалить</button>'}
        </div>
      </form>`;
    $('panel').hidden = false;
    $('placeForm').title.focus();

    $('placeForm').onsubmit = async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const data = {
        ...p,
        id: p.id || newId(),
        title: f.get('title').trim(),
        category: f.get('category'),
        description: f.get('description').trim(),
        photoTips: f.get('photoTips').trim(),
        link: f.get('link').trim(),
      };
      const i = places.findIndex((x) => x.id === data.id);
      i === -1 ? places.push(data) : (places[i] = data);
      activeFilters.add(data.category);
      e.target.querySelector('[type=submit]').disabled = true;
      if (await persist(() => store.upsert(data))) openPlace(data.id);
    };
    $('cancelBtn').onclick = () => (isNew ? closePanel() : openPlace(p.id));
    if (!isNew) {
      $('deleteBtn').onclick = async () => {
        if (!confirm(`Удалить «${p.title}»?`)) return;
        places = places.filter((x) => x.id !== p.id);
        closePanel();
        render();
        await persist(() => store.remove(p.id));
      };
    }
  }

  // ================= drawing areas =================
  function startDrawing(existing = null) {
    closePanel();
    draft = { coords: existing ? existing.coords.map((c) => [...c]) : [], placeId: existing ? existing.id : null };
    setMode('drawArea');
    render();
    renderDraft();
  }

  function renderDraft() {
    draftLayer.clearLayers();
    if (!draft) return;
    const pts = draft.coords;
    const style = { color: '#ec4899', weight: 2, dashArray: '6 6', interactive: false };
    if (pts.length >= 3) L.polygon(pts, { ...style, fillOpacity: 0.15 }).addTo(draftLayer);
    else if (pts.length === 2) L.polyline(pts, style).addTo(draftLayer);

    pts.forEach((pt, i) => {
      const v = L.marker(pt, {
        draggable: true,
        icon: L.divIcon({ className: '', html: `<div class="vertex${i === 0 ? ' first' : ''}"></div>`, iconSize: [14, 14], iconAnchor: [7, 7] }),
      }).addTo(draftLayer);
      v.on('drag', () => {
        const ll = v.getLatLng();
        pts[i] = [round6(ll.lat), round6(ll.lng)];
        draftLayer.eachLayer((l) => { if (l instanceof L.Polyline) l.setLatLngs(pts); });
      });
      v.on('dragend', renderDraft);
      // click on a vertex removes it; click on the first one closes the shape
      v.on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        if (i === 0 && pts.length >= 3) finishDrawing();
        else { pts.splice(i, 1); renderDraft(); }
      });
    });
    updateHint();
  }

  async function finishDrawing() {
    if (draft.coords.length < 3) return alert('Нужно минимум 3 точки.');
    const { coords, placeId } = draft;
    cancelDrawing();
    if (placeId) {
      const p = places.find((x) => x.id === placeId);
      p.coords = coords;
      render();
      openPlace(placeId);
      await persist(() => store.upsert(p));
    } else {
      openForm(blankPlace({ type: 'area', category: CATEGORIES.beach ? 'beach' : Object.keys(CATEGORIES)[0], coords }));
    }
  }

  function cancelDrawing() {
    draft = null;
    draftLayer.clearLayers();
    setMode('idle');
    render();
  }

  // ================= modes / hint =================
  function setMode(m) {
    mode = m;
    $('addPointBtn').classList.toggle('active', m === 'addPoint');
    $('addAreaBtn').classList.toggle('active', m === 'drawArea');
    map.getContainer().style.cursor = m === 'idle' ? '' : 'crosshair';
    m === 'drawArea' ? map.doubleClickZoom.disable() : map.doubleClickZoom.enable();
    updateHint();
  }

  function updateHint() {
    const actions = $('hintActions');
    actions.innerHTML = '';
    if (mode === 'addPoint') {
      $('hintText').textContent = 'Кликни на карте, куда поставить точку';
      actions.append(hintBtn('Отмена', () => setMode('idle')));
    } else if (mode === 'drawArea') {
      const n = draft ? draft.coords.length : 0;
      $('hintText').textContent = n < 3
        ? `Кликай по карте, обводя область (точек: ${n}, нужно ≥ 3)`
        : `Точек: ${n}. Тяни точки, чтобы поправить; клик по точке — удалить`;
      if (n) actions.append(hintBtn('↶', () => { draft.coords.pop(); renderDraft(); }));
      actions.append(hintBtn('Отмена', cancelDrawing));
      if (n >= 3) actions.append(hintBtn('Готово', finishDrawing, true));
    } else {
      $('hint').hidden = true;
      return;
    }
    $('hint').hidden = false;
  }

  function hintBtn(label, onClick, primary = false) {
    const b = document.createElement('button');
    b.className = 'btn' + (primary ? ' primary' : '');
    b.textContent = label;
    b.onclick = onClick;
    return b;
  }

  // ================= editor: login =================
  async function isAdmin() {
    if (!supa) return true; // demo mode: everyone can play with the editor locally
    const { data: { session } } = await supa.auth.getSession();
    if (!session) return false;
    const { data } = await supa.from('admins').select('user_id').eq('user_id', session.user.id).maybeSingle();
    return !!data;
  }

  function openLogin() {
    $('panelBody').innerHTML = `
      <form class="form" id="loginForm">
        <h2>Вход в редактор</h2>
        <p class="muted">Редактировать карту может только админ.</p>
        <label class="field"><span>Email</span><input name="email" type="email" required autocomplete="username"></label>
        <label class="field"><span>Пароль</span><input name="password" type="password" required autocomplete="current-password"></label>
        <p class="muted" id="loginError" hidden></p>
        <div class="form-actions"><button class="btn active" type="submit">Войти</button></div>
      </form>`;
    $('panel').hidden = false;
    $('loginForm').onsubmit = async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const { error } = await supa.auth.signInWithPassword({ email: f.get('email'), password: f.get('password') });
      const errEl = $('loginError');
      if (error) { errEl.textContent = '❌ Неверный email или пароль'; errEl.hidden = false; return; }
      if (!(await isAdmin())) { errEl.textContent = '❌ Этот аккаунт не админ (нет в таблице admins)'; errEl.hidden = false; return; }
      closePanel();
      setEditMode(true);
      await offerSeed();
    };
  }

  function setEditMode(on) {
    editMode = on;
    $('editToggle').classList.toggle('active', on);
    $('editbar').hidden = !on;
    if (!on && draft) cancelDrawing();
    if (!on) setMode('idle');
    render();
    if (selectedId && !$('panel').hidden) openPlace(selectedId);
  }

  $('editToggle').onclick = async () => {
    if (editMode) return setEditMode(false);
    if (await isAdmin()) setEditMode(true);
    else openLogin();
  };

  $('logoutBtn').hidden = !supa;
  $('logoutBtn').onclick = async () => {
    await supa.auth.signOut();
    setEditMode(false);
  };

  // ================= editor: toolbar =================
  $('addPointBtn').onclick = () => {
    if (draft) cancelDrawing();
    closePanel();
    setMode(mode === 'addPoint' ? 'idle' : 'addPoint');
  };
  $('addAreaBtn').onclick = () => (mode === 'drawArea' ? cancelDrawing() : startDrawing());

  $('exportBtn').onclick = () => {
    const content = `// Резервная копия мест (${new Date().toLocaleString('ru-RU')}).\nwindow.PLACES = ${JSON.stringify(places, null, 2)};\n`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([content], { type: 'text/javascript' }));
    a.download = 'data.js';
    a.click();
    URL.revokeObjectURL(a.href);
  };

  $('importInput').onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    let parsed;
    try {
      const text = await file.text();
      const m = text.match(/window\.PLACES\s*=\s*([\s\S]*?);?\s*$/);
      parsed = JSON.parse(m ? m[1] : text);
      if (!Array.isArray(parsed)) throw new Error('в файле нет списка мест');
    } catch (err) {
      return alert('Не получилось прочитать файл: ' + err.message);
    }
    if (!confirm(`Заменить все места на карте (${places.length}) на места из файла (${parsed.length})?`)) return;
    places = parsed;
    closePanel();
    render();
    await persist(() => store.replaceAll(places));
  };

  // Fresh database: offer the admin to upload the starter places from data.js
  async function offerSeed() {
    if (!store.remote || places.length || !(window.PLACES || []).length || !(await isAdmin())) return;
    if (!confirm(`База пустая. Загрузить стартовые места из data.js (${window.PLACES.length})?`)) return;
    places = JSON.parse(JSON.stringify(window.PLACES));
    render();
    await persist(() => store.replaceAll(places));
  }

  // ================= start =================
  $('modeBadge').hidden = store.remote;
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('lightbox').hidden) $('lightbox').hidden = true;
    else if (mode === 'drawArea') cancelDrawing();
    else if (mode === 'addPoint') setMode('idle');
    else closePanel();
  });

  try {
    places = await store.load();
  } catch (err) {
    console.error(err);
    alert('Не удалось загрузить места из базы: ' + (err.message || err));
  }
  await offerSeed();
  render();
  if (places.length) {
    map.fitBounds(L.featureGroup([...layers.values()]).getBounds(), { padding: [60, 60], maxZoom: 14 });
  }
})();
