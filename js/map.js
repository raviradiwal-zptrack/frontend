const ZivMap = (() => {
  let map, cluster, circleLayer;
  let initialized = false;
  let requestSeq = 0;              // guards against out-of-order responses
  const markerIndex = {};          // "doctor-12" -> Leaflet marker, for focusing from the list

  const state = {
    center: null,                  // { lat, lng }
    centerSource: null,            // 'gps' | 'picked'
    radiusKm: 3,
    status: 'all',                 // 'all' | 'rx' | 'nonrx' | 'potential' | 'chemist'
    q: '',
    picking: false,
    lastMyDoctorsResult: null
  };

  // Recent comments inside the pin pop-up (latest 2, newest first) — no screen change.
  const cmtStamp = (iso) => (iso ? new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' }).replace(/\b(am|pm)\b/, (x) => x.toUpperCase()) : '');
  const cmtHtml = (rows) => (rows && rows.length
    ? rows.map((c) => `<div class="pc-item"><div class="pc-text">${esc(c.comment_text)}</div><div class="pc-date">${esc(cmtStamp(c.visited_at))}</div></div>`).join('')
    : '<div class="pc-empty">No comments available</div>');
  const cmtCache = {};   // "doctor-12" -> rendered comments; Leaflet rebuilds a pop-up from its template on update, so keep the result here
  async function fillPopupComments(popup) {
    const el = popup && popup.getElement && popup.getElement().querySelector('.pop-cmts');
    if (!el) return;
    const kind = el.dataset.kind, id = el.dataset.id, key = kind + '-' + id;
    try {
      const rows = await Api.getRecentComments(kind, id, 2);
      cmtCache[key] = cmtHtml(rows);
    } catch (e) {
      cmtCache[key] = '<div class="pc-empty">Comments could not be loaded</div>';
      setTimeout(() => { delete cmtCache[key]; }, 0);   // do not remember a failure
    }
    const live = popup.getElement && popup.getElement() && popup.getElement().querySelector('.pop-cmts');
    if (live) { live.innerHTML = cmtCache[key]; popup._updateLayout && popup._updateLayout(); popup._updatePosition && popup._updatePosition(); }
  }
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  function fmtDistance(m) {
    const n = Number(m);
    return n < 1000 ? `${Math.round(n / 10) * 10} m` : `${(n / 1000).toFixed(1)} km`;
  }

  function distanceMeters(lat1, lng1, lat2, lng2) {
    const R = 6371000, toRad = (x) => (x * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  // Doctor pins are colored by prescribing status: purple = prescribing
  // (RX), amber = target (Non-RX, still being converted). Chemists are
  // always green.
  function pinIcon(kind, rating, rxStatus) {
    const color = kind === 'chemist' ? '#3FA34D' : (rxStatus === 'NON_RX' ? '#C98A1E' : rxStatus === 'POTENTIAL' ? '#2F6FDB' : '#4B1F7A');
    const size = Number(rating) >= 4 ? 30 : 24; // higher-rated doctors/chemists get a bigger pin
    return L.divIcon({
      className: '',
      html: `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${color};border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;color:#fff;font-size:${Math.round(size * 0.5)}px;">${kind === 'doctor' ? '⚕' : '💊'}</div>`,
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2]
    });
  }

  function init() {
    if (initialized) return;
    initialized = true;

    map = L.map('leaflet-map', { zoomControl: false }).setView([18.5204, 73.8567], 12); // default: Pune
    map.on('popupopen', (e) => fillPopupComments(e.popup));
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors',
      maxZoom: 19
    }).addTo(map);
    L.control.zoom({ position: 'bottomright' }).addTo(map);

    cluster = (typeof L.markerClusterGroup === 'function')
      ? L.markerClusterGroup({ maxClusterRadius: 45, showCoverageOnHover: false, chunkedLoading: true })
      : L.layerGroup();
    cluster.addTo(map);
    circleLayer = L.layerGroup().addTo(map);

    document.getElementById('map-locate-btn').addEventListener('click', locate);
    document.getElementById('map-pick-btn').addEventListener('click', () => setPicking(!state.picking));

    let searchTimer;
    document.getElementById('map-search-input').addEventListener('input', (e) => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { state.q = e.target.value.trim(); runSearch(); }, 400);
    });

    document.querySelectorAll('.map-chip[data-radius]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.radiusKm = Number(btn.dataset.radius);
        document.querySelectorAll('.map-chip[data-radius]').forEach((b) => b.classList.toggle('active', b === btn));
        runSearch();
      });
    });
    document.querySelectorAll('.map-chip[data-status]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.status = btn.dataset.status;
        document.querySelectorAll('.map-chip[data-status]').forEach((b) => b.classList.toggle('active', b === btn));
        // Status filtering is applied client-side against the last fetch —
        // no need to re-call the API for a filter change.
        if (state.lastMyDoctorsResult) renderMyDoctorsResult(state.lastMyDoctorsResult);
      });
    });

    map.on('click', (e) => {
      if (!state.picking) return;
      setCenter(e.latlng.lat, e.latlng.lng, 'picked');
      setPicking(false);
    });

    updateChrome();
  }

  function setPicking(on) {
    state.picking = on;
    document.getElementById('map-pick-btn').classList.toggle('active', on);
    document.getElementById('map-container').classList.toggle('picking', on);
    updateChrome();
  }

  // Shows the pick-location hint while picking, otherwise the colour legend.
  function updateChrome() {
    document.getElementById('map-hint').style.display = state.picking ? 'block' : 'none';
    document.getElementById('map-legend').style.display = state.picking ? 'none' : 'flex';
  }

  function setCenter(lat, lng, source) {
    state.center = { lat, lng };
    state.centerSource = source;
    runSearch();
  }

  function locate() {
    if (!navigator.geolocation) return showToast('Geolocation is not supported on this device');
    const btn = document.getElementById('map-locate-btn');
    btn.textContent = '…';
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        btn.textContent = '📍';
        setCenter(pos.coords.latitude, pos.coords.longitude, 'gps');
      },
      () => {
        btn.textContent = '📍';
        showToast('Could not get your location — check permission, or tap 🎯 to pick a spot on the map');
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  }

  function drawCenter() {
    circleLayer.clearLayers();
    const { lat, lng } = state.center;
    L.circle([lat, lng], {
      radius: state.radiusKm * 1000,
      color: '#3FA34D', weight: 2, fillColor: '#3FA34D', fillOpacity: 0.07, interactive: false
    }).addTo(circleLayer);
    L.marker([lat, lng], {
      icon: L.divIcon({ className: '', html: '<div class="you-are-here"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }),
      interactive: false, keyboard: false
    }).addTo(circleLayer);
  }

  async function runSearch() {
    if (!state.center) return;
    return runMyDoctorsSearch();
  }

  // ===== Your own doctors + chemists around a point =====
  async function runMyDoctorsSearch() {
    const seq = ++requestSeq;
    drawCenter();
    setSheetTitle('Searching…');

    try {
      const res = await Api.getNearby({
        lat: state.center.lat, lng: state.center.lng,
        radius_km: state.radiusKm, type: 'both', q: state.q, limit: 500
      });
      if (seq !== requestSeq) return;
      state.lastMyDoctorsResult = res;
      renderMyDoctorsResult(res);
    } catch (err) {
      if (seq !== requestSeq) return;
      setSheetTitle(err.message === 'offline' ? "You're offline — can't search the map" : 'Map search failed — try again');
    }
  }

  function applyStatusFilter(items) {
    if (state.status === 'rx') return items.filter((it) => it._kind === 'doctor' && it.rx_status !== 'NON_RX' && it.rx_status !== 'POTENTIAL');
    if (state.status === 'nonrx') return items.filter((it) => it._kind === 'doctor' && it.rx_status === 'NON_RX');
    if (state.status === 'potential') return items.filter((it) => it._kind === 'doctor' && it.rx_status === 'POTENTIAL');
    if (state.status === 'chemist') return items.filter((it) => it._kind === 'chemist');
    return items;
  }

  function renderMyDoctorsResult(res) {
    cluster.clearLayers();
    Object.keys(markerIndex).forEach((k) => delete markerIndex[k]);

    const allItems = [
      ...(res.doctors || []).map((d) => ({ ...d, _kind: 'doctor' })),
      ...(res.chemists || []).map((c) => ({ ...c, _kind: 'chemist' }))
    ].sort((a, b) => a.distance_m - b.distance_m);

    const items = applyStatusFilter(allItems);

    const markers = items.map((it) => {
      // doctors read "Dr. Name - Clinic" everywhere
      const name = it._kind === 'doctor' ? (it.hospital_name ? `${it.name} - ${it.hospital_name}` : it.name) : (it.display_name || it.store_name);
      const sub = it._kind === 'doctor'
        ? [it.speciality, it.locality].filter(Boolean).join(' · ')
        : (it.locality || '');
      const rxLine = it._kind === 'doctor'
        ? (it.rx_status === 'NON_RX'
            ? '<span style="color:#C98A1E;font-weight:700">Non-RX</span><br>'
            : it.rx_status === 'POTENTIAL'
              ? '<span style="color:#2F6FDB;font-weight:700">Potential</span><br>'
              : '<span style="color:#4B1F7A;font-weight:700">RX</span><br>')
        : '';
      const m = L.marker([it.lat, it.lng], { icon: pinIcon(it._kind, it.rating, it.rx_status) });
      m.bindPopup(() => `
        <b>${esc(name)}</b>${esc(sub)}<br>
        ${rxLine}
        ${fmtDistance(it.distance_m)} away<br>
        <div class="pop-cmts" data-kind="${it._kind}" data-id="${Number(it.id)}">${cmtCache[it._kind + '-' + it.id] || '<div class="pc-load">Loading comments…</div>'}</div>
        <a href="https://www.google.com/maps/dir/?api=1&destination=${it.lat},${it.lng}" target="_blank" rel="noopener">Navigate →</a>
        &nbsp;|&nbsp;
        <a href="#" onclick="openDetail('${it._kind}', ${Number(it.id)}); return false;">View profile</a>
      `);
      markerIndex[`${it._kind}-${it.id}`] = m;
      it._name = name; it._sub = sub;
      return m;
    });
    cluster.addLayers ? cluster.addLayers(markers) : markers.forEach((m) => cluster.addLayer(m));

    map.fitBounds(L.latLng(state.center.lat, state.center.lng).toBounds(state.radiusKm * 2000), { padding: [20, 20] });

    const nRx = allItems.filter((i) => i._kind === 'doctor' && i.rx_status !== 'NON_RX' && i.rx_status !== 'POTENTIAL').length;
    const nTarget = allItems.filter((i) => i._kind === 'doctor' && i.rx_status === 'NON_RX').length;
    const nPot = allItems.filter((i) => i._kind === 'doctor' && i.rx_status === 'POTENTIAL').length;
    const nChem = allItems.filter((i) => i._kind === 'chemist').length;
    const where = state.centerSource === 'picked' ? 'the selected spot' : 'you';
    setSheetTitle(`${nRx} RX · ${nTarget} Non-RX · ${nPot} Potential · ${nChem} chemist${nChem === 1 ? '' : 's'} <small>within ${state.radiusKm} km of ${where}</small>`);

    renderMyDoctorsList(items, res.truncated);
    expandSheet();
  }

  function renderMyDoctorsList(items, truncated) {
    const list = document.getElementById('map-sheet-list');
    if (!items.length) {
      list.innerHTML = `<div style="padding:18px 6px;text-align:center;color:var(--text-muted);font-size:13px">
        Nothing matches this filter in this radius. Try a bigger radius, a different filter, or another spot.</div>`;
      return;
    }
    const warn = truncated
      ? `<div style="background:#FFF4DC;color:#8A5A00;font-size:12px;font-weight:600;padding:8px 10px;border-radius:8px;margin-bottom:6px">
           Showing the nearest ${items.length} — pick a smaller radius to see everything close by.</div>`
      : '';
    list.innerHTML = warn + items.map((it) => {
      const dotColor = it._kind === 'chemist' ? '#3FA34D' : (it.rx_status === 'NON_RX' ? '#C98A1E' : it.rx_status === 'POTENTIAL' ? '#2F6FDB' : '#4B1F7A');
      const targetTag = it._kind === 'doctor' && it.rx_status === 'NON_RX'
        ? '<span style="color:#C98A1E;font-weight:700"> · Non-RX</span>'
        : (it._kind === 'doctor' && it.rx_status === 'POTENTIAL' ? '<span style="color:#2F6FDB;font-weight:700"> · Potential</span>' : '');
      return `
      <div class="nearby-row ${it._kind === 'doctor' ? (it.rx_status === 'RX' ? 'rx-bg' : it.rx_status === 'POTENTIAL' ? 'pot-bg' : 'nonrx-bg') : ''}" onclick="ZivMap.focusItem('${it._kind}', ${Number(it.id)})">
        <div class="nr-dot" style="background:${dotColor}">${it._kind === 'doctor' ? '⚕' : '💊'}</div>
        <div class="nr-body">
          <div class="nr-name">${esc(it._name)}</div>
          <div class="nr-sub">${esc(it._sub || it.locality || '')}${targetTag}${it._kind === 'doctor' && it.added_by_name ? ` · 👤 ${esc(it.added_by_name)}` : ''}</div>
        </div>
        <div class="nr-dist">${fmtDistance(it.distance_m)}</div>
        <a class="nr-go" href="https://www.google.com/maps/dir/?api=1&destination=${it.lat},${it.lng}" target="_blank" rel="noopener" onclick="event.stopPropagation()" title="Navigate">➤</a>
      </div>`;
    }).join('');
  }

  function setSheetTitle(html) { document.getElementById('map-sheet-title').innerHTML = html; }
  function expandSheet() { document.getElementById('map-sheet').classList.remove('collapsed'); }

  return {
    onShow() {
      init();
      setTimeout(() => map.invalidateSize(), 100);
      if (!state.center) locate();
      else if (state.dirty) { state.dirty = false; runSearch(); } // the search text was cleared while away
    },
    // Leaving the Map tab clears its search box
    clearSearch() {
      if (!state.q) return;
      state.q = '';
      const box = document.getElementById('map-search-input');
      if (box) box.value = '';
      state.dirty = true;
    },
    toggleSheet() { document.getElementById('map-sheet').classList.toggle('collapsed'); },
    focusItem(kind, id) {
      const m = markerIndex[`${kind}-${id}`];
      if (!m) return;
      document.getElementById('map-sheet').classList.add('collapsed');
      const show = () => { map.setView(m.getLatLng(), Math.max(map.getZoom(), 16)); m.openPopup(); };
      if (cluster.zoomToShowLayer) cluster.zoomToShowLayer(m, show); else show();
    }
  };
})();

window.ZivMap = ZivMap;
