// ===== State =====
let state = {
  activeTab: 'doctor',       // 'doctor' | 'chemist'
  filters: { q: '', rating: '', rx_status: '', core_status: '' },
  currentEntity: null,       // { type, id } for detail view
  listCache: { doctor: [], chemist: [] }
};
let currentTop = 'list';        // which bottom tab (list | map | reports) is showing
let needsListReload = false;

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2200);
}

// If the phone closes the app while the camera is open (it can happen on phones with
// little free memory), bring the MR back to the same doctor / chemist with what they had
// typed — instead of the Home screen with everything lost.
const RESUME_KEY = 'zv_resume', RESUME_MINUTES = 5;
function rememberResume() {
  try {
    if (!state.currentEntity) return;
    const val = (id) => { const el = document.getElementById(id); return el ? el.value : ''; };
    localStorage.setItem(RESUME_KEY, JSON.stringify({ type: state.currentEntity.type, id: state.currentEntity.id, comment: val('comment-input'), gift: val('gift-text'), at: Date.now() }));
  } catch (e) { /* storage unavailable — nothing to restore, nothing lost */ }
}
function clearResume() { try { localStorage.removeItem(RESUME_KEY); } catch (e) {} }
async function resumeAfterCamera() {
  let r = null;
  try { r = JSON.parse(localStorage.getItem(RESUME_KEY) || 'null'); } catch (e) { r = null; }
  clearResume();
  if (!r || !r.id || !['doctor', 'chemist'].includes(r.type) || Date.now() - r.at > RESUME_MINUTES * 60000) return false;
  await openDetail(r.type, r.id);
  const put = (id, v) => { const el = document.getElementById(id); if (el && v) el.value = v; };
  put('comment-input', r.comment); put('gift-text', r.gift);
  showToast('Welcome back — please take the photo again');
  return true;
}
// Take a selfie: the in-app camera (or, for people the admin authorizes, the gallery)
async function startSelfie() {
  const shot = await openSelfieSheet();
  if (shot) await acceptSelfie(shot);
}
function startGiftPhoto(inputId) { rememberResume(); document.getElementById(inputId).click(); }
document.addEventListener('visibilitychange', () => {
  // the camera came back with the page still alive (or was cancelled): nothing to restore
  if (document.visibilityState === 'visible') setTimeout(clearResume, 4000);
});

// Cloudinary can hand back a small copy of a photo — much lighter for the comment list,
// especially for photos uploaded before photos were shrunk on upload.
function thumbUrl(url, w) {
  return typeof url === 'string' && url.includes('/image/upload/') && !/\/upload\/[a-z]_/.test(url)
    ? url.replace('/image/upload/', `/image/upload/w_${w},c_limit,q_auto,f_auto/`) : url;
}

// "Dr. Anil Deshpande - Sahyadri Hospital": how a doctor is named in every list,
// search result, report and profile title (just the name if no clinic is set).
function docLabel(d) {
  if (!d) return '';
  return d.hospital_name ? `${d.name} - ${d.hospital_name}` : d.name;
}

// A search belongs to the tab it was typed in: changing tab clears it.
function clearHomeSearch(reloadNow) {
  const had = !!state.filters.q;
  state.filters.q = '';
  clearTimeout(searchDebounce);
  const input = document.getElementById('home-search-input');
  if (input) input.value = '';
  if (had) { if (reloadNow) loadList(); else needsListReload = true; }
}
function trackTab(name) {
  if (!['list', 'map', 'reports'].includes(name)) return; // detail / edit screens are not tabs
  if (name !== currentTop) {
    if (currentTop === 'list') clearHomeSearch(false);
    if (currentTop === 'map' && window.ZivMap && window.ZivMap.clearSearch) window.ZivMap.clearSearch();
    currentTop = name;
  }
  if (name === 'list' && needsListReload) { needsListReload = false; loadList(); }
}

// `showView` both renders a view AND records it in browser history, so the
// Android/Chrome back button navigates within the app (to whatever view was
// shown before) instead of exiting straight to the home screen — the app
// had no history entries before this, so every back-press closed it.
// Pass replace=true for transitions that shouldn't be a back-target (e.g.
// the login screen, once signed in).
function showView(name, replace, entity) {
  try {
    const prev = history.state || {};
    const sameEntity = !entity || (prev.entity && prev.entity.type === entity.type && String(prev.entity.id) === String(entity.id));
    // remember where the page was scrolled on the screen we are leaving, so Back can return to the exact spot
    if (!replace) history.replaceState(Object.assign({}, prev, { scrollY: window.scrollY || 0 }), '', location.hash);
    if (replace) {
      history.replaceState({ view: name, idx: prev.idx || 0, entity: entity || null }, '', `#${name}`);
    } else if (prev.view !== name || !sameEntity) {
      history.pushState({ view: name, idx: (prev.idx || 0) + 1, entity: entity || null }, '', `#${name}`);
    }
  } catch (err) { /* history API unavailable here: render-only fallback below */ }
  renderView(name);
  if (!replace) { try { window.scrollTo(0, 0); } catch (e) { /* ignore */ } }
}

// ← button: go back to the screen the person was really on (Home, Map, Reports → Coverage, a doctor…),
// not always Home. If there is nothing behind us (app just opened), fall back to the last tab.
function goBack(fallback) {
  const st = history.state;
  if (st && st.idx > 0) { try { history.back(); return; } catch (e) { /* fall through */ } }
  showView(fallback || currentTop || 'list');
}

// ----- a refresh keeps you on the same page (kept per browser tab; cleared when you sign out) -----
const navStore = () => { try { return typeof sessionStorage !== 'undefined' ? sessionStorage : null; } catch (e) { return null; } };
function saveNav(name) {
  const st = navStore();
  if (!st || !['list', 'map', 'reports', 'profile', 'detail', 'edit'].includes(name)) return;
  try {
    st.setItem('zv_nav', JSON.stringify({
      view: name, tab: state.activeTab, entity: state.currentEntity || null,
      edit: name === 'edit' && state.editing ? { type: state.editing.type, id: state.editing.id || null } : null,
      home: { sort: state.sort, locality: state.locality, staff: state.staff }
    }));
  } catch (e) { /* storage unavailable: refresh simply goes Home */ }
}
function readNav() { const st = navStore(); try { return st ? JSON.parse(st.getItem('zv_nav') || 'null') : null; } catch (e) { return null; } }
function clearNav() { const st = navStore(); try { if (st) st.removeItem('zv_nav'); } catch (e) { /* nothing to clear */ } }
function refreshNavHome() { const n = readNav(); if (n && n.view === 'list') saveNav('list'); }
function applyHomeNav(nav) {
  if (!nav || !nav.home) return;
  if (nav.home.sort) state.sort = nav.home.sort;
  state.locality = nav.home.locality || '';
  if (nav.home.staff && isStaffRole()) {
    state.staff = { mr: nav.home.staff.mr || '', when: nav.home.staff.when || 'today', from: nav.home.staff.from || '', to: nav.home.staff.to || '' };
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
    set('adm-when', state.staff.when); set('adm-from', state.staff.from); set('adm-to', state.staff.to);
    const custom = state.staff.when === 'custom';
    ['adm-from', 'adm-to'].forEach(id => { const el = document.getElementById(id); if (el) el.style.display = custom ? '' : 'none'; });
  }
  const sortEl = document.getElementById('list-sort'); if (sortEl) sortEl.value = state.sort;
}
function restoreNav(nav) {
  if (!nav) return;
  try { if (localStorage.getItem('zv_resume')) return; } catch (e) { /* ignore */ }   // coming back from the phone's camera app takes priority
  if (nav.edit) return openEdit(nav.edit.type, nav.edit.id);
  if (nav.view === 'detail' && nav.entity) return openDetail(nav.entity.type, nav.entity.id);
  if (nav.view === 'map' || nav.view === 'reports') return showView(nav.view);
  if (nav.view === 'profile') return openProfile();
}

function renderView(name, fromBack) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById(`view-${name}`).classList.add('active');
  document.querySelectorAll('.top-nav button').forEach(b => b.classList.remove('active'));
  const navBtn = document.querySelector(`.top-nav button[data-view="${name}"]`);
  if (navBtn) navBtn.classList.add('active');
  const tabsOn = ['list', 'map', 'reports'].includes(name);
  document.getElementById('main-tabs').style.display = tabsOn ? 'flex' : 'none';
  if (document.body && document.body.classList) document.body.classList.toggle('has-tabs', tabsOn); // headers sit under the tabs only while the tabs are visible
  trackTab(name);
  saveNav(name);
  if (name === 'map' && window.ZivMap) window.ZivMap.onShow();
  if (name === 'reports') { if (fromBack && reportState.from) { /* keep the list, filters and Coverage tab exactly as they were */ } else initReports(); }
  if (name === 'list') { loadWall(); updateHomePageUi(); }   // coming back Home refreshes the Wall (ticks, new reminders)
}

// Back button pressed: re-render whatever view browser history says we
// should be on. If there's no app state at all (e.g. the user somehow
// landed here directly), fall back to Home rather than a blank screen.
window.addEventListener('popstate', (e) => {
  const st = e.state || {};
  const ent = st.entity, cur = state.currentEntity;
  if (reloadDetailOnPop && st.view === 'detail') { const r = reloadDetailOnPop; reloadDetailOnPop = null; openDetail(r.type, r.id, { noHistory: true }); }   // show the saved changes
  else if (st.view === 'detail' && ent && (!cur || cur.type !== ent.type || String(cur.id) !== String(ent.id))) {
    openDetail(ent.type, ent.id, { noHistory: true });   // Back to a different record than the one on screen
  } else {
    renderView(st.view || 'list', true);
  }
  const y = st.scrollY || 0;
  const goY = () => { try { window.scrollTo(0, y); } catch (err) { /* ignore */ } };
  requestAnimationFrame(goY); setTimeout(goY, 250); setTimeout(goY, 700);   // again after the lists finish drawing
});

// ===== Auth =====
async function handleLogin(e) {
  e.preventDefault();
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;
  const errBox = document.getElementById('login-error');
  errBox.style.display = 'none';

  try {
    const { token, user } = await Api.login(username, password);
    Api.setSession(token, user);
    boot();
  } catch (err) {
    errBox.textContent = err.message === 'offline' ? "You're offline — connect and try again." : 'Invalid username or password.';
    errBox.style.display = 'block';
  }
}

function logout() {
  Api.clearSession();
  clearNav();   // the next person to sign in starts on Home
  location.reload();
}

// ===== List view =====
// "Deshmukh Medical Store - Dr. Anil Deshpande": the server builds it; fall back to what we have
const chemLabel = (c) => (c && (c.display_name || c.store_name || c.chemist_name)) || '';
// Rx doctors are purple, Non-Rx doctors are amber — from the SAVED status only (not Core, not rating)
// Rx status: RX (prescribing, purple) | NON_RX (not prescribing, amber) | POTENTIAL (not yet, but may start after follow-ups, blue)
const COMMISSION_TYPES = [['ADVANCE_BILL', 'Advance — on bill basis'], ['ADVANCE_LUMPSUM', 'Advance — lumpsum'], ['MONTHLY', 'Monthly basis'], ['NONE', 'No commission']];
const commissionTypeLabel = (k) => (COMMISSION_TYPES.find(x => x[0] === k) || [k, k || ''])[1];
const rxLabel = (s) => (s === 'RX' ? 'RX' : s === 'POTENTIAL' ? 'Potential' : 'Non-RX');
const rxBg = (d) => (d && d.rx_status === 'RX' ? 'rx-bg' : d && d.rx_status === 'POTENTIAL' ? 'pot-bg' : 'nonrx-bg');
// "Dr." is never doubled; a new doctor gets "Dr." in front
function normalizeDoctorNameClient(raw, addPrefix) {
  const t = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
  const m = t.match(/^(?:dr\b\.?\s*)+/i), rest = (m ? t.slice(m[0].length) : t).trim();
  if (!rest) return '';
  return m || addPrefix ? `Dr. ${rest}` : rest;
}
function onDoctorNameInput(el) {            // while typing, only a doubled prefix is fixed
  const t = el.value;
  if (/^\s*dr\b\.?\s*dr\b/i.test(t)) el.value = t.replace(/^(?:\s*dr\b\.?\s*)+/i, 'Dr. ');
}
function onDoctorNameBlur(el) {             // leaving the box: a new doctor always has "Dr."
  const v = normalizeDoctorNameClient(el.value, !state.editing.id);
  el.value = v || (state.editing.id ? '' : 'Dr. ');
}
// an optional Indian mobile number -> { value } (10 digits or null) or { error }
function normalizeMobileClient(v) {
  if (v == null || String(v).trim() === '') return { value: null };
  let d = String(v).trim().replace(/[\s\-().]/g, '');
  if (/^\+91/.test(d)) d = d.slice(3); else if (/^0091/.test(d)) d = d.slice(4); else if (/^91\d{10}$/.test(d)) d = d.slice(2); else if (/^0\d{10}$/.test(d)) d = d.slice(1);
  return /^[6-9]\d{9}$/.test(d) ? { value: d } : { error: 'Enter a valid 10-digit Indian mobile number' };
}
function mobileField(e) {
  const m = e.mobile_number;
  return `<div class="info-item"><div class="label">Mobile Number</div><div class="value">${m ? `<a href="tel:+91${repEsc(m)}">${repEsc(m.slice(0, 5) + ' ' + m.slice(5))}</a>` : '—'}</div></div>`;
}

// Is a verification selfie mandatory for THIS person? (the admin sets it per user; the server enforces it)
const selfieRequired = () => !(Api.user && Api.user.selfie_mandatory === false);
const galleryAllowed = () => !!(Api.user && (Api.user.role === 'admin' || Api.user.gallery_upload_allowed)); // the Admin may use the camera or the gallery in every place

// The MR who ADDED a doctor — shown in a corner wherever the doctor appears (set by the server when the doctor is created)
const ownerName = (e) => (e && e.added_by_name) || '';
const ownerTag = (e) => (ownerName(e) ? `<span class="owner-tag" title="Added by ${repEsc(ownerName(e))}">👤 ${repEsc(ownerName(e))}</span>` : '');

function badgeHtml(entity, type) {
  const parts = [];
  if (type === 'doctor') {
    parts.push(`<span class="badge ${entity.rx_status === 'RX' ? 'badge-rx' : entity.rx_status === 'POTENTIAL' ? 'badge-pot' : 'badge-nonrx'}">${rxLabel(entity.rx_status)}</span>`);
    if (entity.core_status) parts.push(`<span class="badge badge-priority-B">${entity.core_status === 'CORE' ? 'Core' : 'Non-Core'}</span>`);
    if (entity.rating) parts.push(`<span class="badge badge-priority-B">${starDisplay(entity.rating)}</span>`);
  }
  if (entity.flagged_invalid) parts.push(`<span class="badge" style="background:#FDECEA;color:#C0392B">🚩 Flagged</span>`);
  return parts.join('');
}

function initials(name) {
  return (name || '?').split(' ').filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase();
}

function renderList(items, type, isTodayDefault) {
  const listEl = document.getElementById('list-items');
  if (!items.length) {
    const label = type === 'doctor' ? 'doctors' : 'chemists';
    listEl.innerHTML = isTodayDefault
      ? `<div class="empty-state"><div class="icon">📋</div>No ${label} covered yet today.<br><br>Search above to find any ${label} in the system, or visit one from the Map.</div>`
      : `<div class="empty-state"><div class="icon">🔍</div>No ${label} match this search.</div>`;
    return;
  }
  listEl.innerHTML = items.map(item => {
    const name = type === 'doctor' ? docLabel(item) : chemLabel(item);
    const sub = type === 'doctor'
      ? [item.speciality, item.locality].filter(Boolean).join(' · ')
      : [item.chemist_name && item.chemist_name !== item.store_name ? item.chemist_name : '', item.locality].filter(Boolean).join(' · ');
    const photo = null; // (the old per-record photo field is no longer used)
    return `
      <div class="card ${type === 'doctor' ? rxBg(item) : ''}${type === 'doctor' && ownerName(item) ? ' has-owner' : ''}" onclick="openDetail('${type}', ${item.id})">
        <div class="card-thumb">${photo ? `<img src="${photo}" alt="">` : initials(type === 'doctor' ? item.name : name)}</div>
        <div class="card-body">
          <p class="card-title">${name}</p>
          <p class="card-sub">${sub || '&nbsp;'}</p>
          <p class="card-last${item.last_call_at ? '' : ' never'}">${item.last_call_at ? `Last call: ${fmtStamp(item.last_call_at)}${item.last_call_by ? ' · ' + repEsc(item.last_call_by) : ''}` : 'Never called'}</p>
          <div class="badge-row">${badgeHtml(item, type)}</div>
          ${item.called_by ? `<div class="called-by">📞 ${repEsc(item.called_by)}${item.call_count > 1 ? ` · ${item.call_count} calls` : ''}</div>` : ''}
        </div>
        ${type === 'doctor' ? ownerTag(item) : ''}
      </div>`;
  }).join('');
}

const HOME_PAGE = 50;
let listSeq = 0;   // answers that arrive late (after the sort or tab changed) are ignored
// Sorting and the locality filter are done by the DATABASE over every match, then cut into pages of 50 ("Load more" fetches the next page of the same order).
async function loadList(more) {
  const listEl = document.getElementById('list-items');
  const type = state.activeTab;
  if (!more) listEl.innerHTML = `<div class="loading-row">Loading…</div>`;
  const seq = ++listSeq;
  const searching = !!state.filters.q;
  const params = { q: state.filters.q, rating: state.filters.rating, sort: state.sort, locality: state.locality, limit: HOME_PAGE, offset: more ? (state.listCache[type] || []).length : 0 };
  if (type === 'doctor') {
    params.rx_status = state.filters.rx_status;
    params.core_status = state.filters.core_status;
  }
  // Home page shows only what this MR has covered today by default — a
  // search query switches to searching the full database instead, so a
  // doctor/chemist not yet visited today can still be found.
  const staff = isStaffRole();
  const scoped = staff ? (!searching || staffFiltered()) : !searching;   // an MR: today's own calls; staff: everyone's, for the chosen MR and dates
  if (scoped) {
    params.visited_today = 'true';
    if (staff) { const [from, to] = staffRange(); params.visit_from = from; params.visit_to = to; if (state.staff.mr) params.mr_id = state.staff.mr; }
  }
  initStaffFilters();

  const scopeLabel = document.getElementById('list-scope-label');
  if (scopeLabel) {
    const noun = type === 'doctor' ? 'doctors' : 'chemists';
    const mrName = (() => { const o = document.getElementById('adm-mr'); return state.staff.mr && o && o.options ? ((o.options[o.selectedIndex] || {}).text || 'one MR') : 'all MRs'; })();
    scopeLabel.textContent = staff && scoped
      ? `Showing ${noun} called ${staffWhenText()} by ${mrName}`
      : searching ? `Searching all ${noun}` : `Showing today's covered ${noun}`;
  }

  try {
    const page = type === 'doctor' ? await Api.getDoctors(params) : await Api.getChemists(params);
    if (seq !== listSeq) return;
    const items = more ? (state.listCache[type] || []).concat(page) : page;
    state.listCache[type] = items;
    state.listHasMore = page.length >= HOME_PAGE;
    if (!more) loadLocalityOptions(type);
    renderList(items, type, scoped);
    updateListMore();
  } catch (err) {
    if (seq !== listSeq) return;
    if (more) { showToast(err.message === 'offline' ? "You're offline" : 'Could not load more'); return; }
    listEl.innerHTML = `<div class="empty-state">Couldn't load data. ${err.message === 'offline' ? "You're offline." : ''}</div>`;
  }
}

// ----- sort and filter on the Home lists (applied to what was loaded; the search box and chips above still filter on the server) -----
state.sort = 'name_asc'; state.locality = '';
// ----- Admin / Super User: see every MR's calls (or one MR's) for a day or a range, instead of only your own -----
state.staff = { mr: '', when: 'today', from: '', to: '' };
function staffRange() {
  const st = state.staff, today = istDate(0);
  if (st.when === 'yesterday') return [istDate(-1), istDate(-1)];
  if (st.when === '7d') return [istDate(-6), today];
  if (st.when === 'month') return [today.slice(0, 8) + '01', today];
  if (st.when === 'custom') return [st.from || today, st.to || st.from || today];
  return [today, today];
}
const staffWhenText = () => ({ today: 'today', yesterday: 'yesterday', '7d': 'in the last 7 days', month: 'this month', custom: 'in the chosen dates' }[state.staff.when] || 'today');
const staffFiltered = () => isStaffRole() && (!!state.staff.mr || state.staff.when !== 'today');
let staffMrsLoaded = false;
async function initStaffFilters() {
  const box = document.getElementById('staff-call-filters');
  if (!box) return;
  box.style.display = isStaffRole() ? 'flex' : 'none';
  if (!isStaffRole() || staffMrsLoaded) return;
  staffMrsLoaded = true;
  try {
    const f = await Api.getReportFilters();
    const sel = document.getElementById('adm-mr');
    sel.innerHTML = `<option value="">All MRs</option>` + (f.mrs || []).filter(u => u.active !== false).map(u => `<option value="${u.id}"${String(u.id) === String(state.staff.mr) ? ' selected' : ''}>${repEsc(u.full_name)}</option>`).join('');
  } catch (e) { staffMrsLoaded = false; /* the filters still work for "All MRs" */ }
}
function setStaffFilter(key, value) {
  state.staff[key] = value;
  if (key === 'when') {
    const custom = value === 'custom';
    document.getElementById('adm-from').style.display = custom ? '' : 'none';
    document.getElementById('adm-to').style.display = custom ? '' : 'none';
  }
  refreshNavHome();
  loadList();
}

function updateListMore() {
  const btn = document.getElementById('list-more');
  if (btn) btn.style.display = state.listHasMore && (state.listCache[state.activeTab] || []).length ? 'block' : 'none';
}
const localityCache = {};
async function loadLocalityOptions(type) {
  const sel = document.getElementById('list-locality');
  if (!sel) return;
  try { if (!localityCache[type]) localityCache[type] = await Api.getLocalities(type); } catch (e) { if (!localityCache[type]) return; }
  if (type !== state.activeTab) return;
  const names = localityCache[type];
  if (state.locality && !names.includes(state.locality)) state.locality = '';
  sel.innerHTML = `<option value="">All localities</option>` + names.map(n => `<option value="${repEsc(n)}"${n === state.locality ? ' selected' : ''}>${repEsc(n)}</option>`).join('');
}
function rerenderList() {
  const type = state.activeTab;
  renderList(state.listCache[type] || [], type, !state.filters.q);
}
function setListSort(v) { state.sort = v; loadList(); }          // a new order starts again at page 1
function setListLocality(v) { state.locality = v; loadList(); }

function setTab(tab) {
  if (state.activeTab !== tab) { clearHomeSearch(false); state.locality = ''; } // a new tab starts with no search or locality filter
  state.activeTab = tab;
  refreshNavHome();
  document.querySelectorAll('.tab-toggle button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.getElementById('filter-rx-row').style.display = tab === 'doctor' ? 'flex' : 'none';
  loadList();
}

function setFilter(key, value) {
  state.filters[key] = state.filters[key] === value ? '' : value;
  document.querySelectorAll(`.chip[data-key="${key}"]`).forEach(c => {
    c.classList.toggle('active', c.dataset.value === state.filters[key]);
  });
  loadList();
}

let searchDebounce;
function onSearchInput(e) {
  clearTimeout(searchDebounce);
  state.filters.q = e.target.value;
  searchDebounce = setTimeout(loadList, 350);
}

// ===== Detail view =====
async function openDetail(type, id, opts) {
  opts = opts || {};
  state.currentEntity = { type, id };
  callKind = 'visit';                              // a new record opens on a normal visit
  feedTools = { q: '', show: 'all', sort: 'new', days: '' };
  if (opts.noHistory) renderView('detail', true);
  else showView('detail', !!opts.replace, { type, id });
  document.getElementById('detail-root').innerHTML = `<div class="loading-row">Loading…</div>`;

  try {
    const entity = type === 'doctor' ? await Api.getDoctor(id) : await Api.getChemist(id);
    state.currentEntity.name = type === 'doctor' ? docLabel(entity) : chemLabel(entity);
    state.currentEntity.address = [entity.locality, entity.city].filter(Boolean).join(', ') || entity.address || '';
    renderDetail(entity, type);
    loadFeed(type, id);
    loadEntityReminders();           // my reminders for this doctor / chemist
  } catch (err) {
    document.getElementById('detail-root').innerHTML = `<div class="empty-state">Couldn't load this record.</div>`;
  }
}

function field(label, value) {
  if (!value) return '';
  return `<div class="info-item"><div class="label">${label}</div><div class="value">${value}</div></div>`;
}

function accordion(id, title, bodyHtml, openByDefault) {
  return `
    <div class="accordion">
      <div class="accordion-header" onclick="toggleAccordion('${id}')">
        <h3>${title}</h3>
        <span class="accordion-arrow${openByDefault ? ' open' : ''}" id="${id}-arrow">▼</span>
      </div>
      <div class="accordion-body${openByDefault ? ' open' : ''}" id="${id}">${bodyHtml}</div>
    </div>`;
}

function toggleAccordion(id) {
  const body = document.getElementById(id);
  const arrow = document.getElementById(`${id}-arrow`);
  const isOpen = body.classList.toggle('open');
  if (arrow) arrow.classList.toggle('open', isOpen);
}

// Date added, how long since the last visit, and visits in the last 30 / 60 / 90 days (a visit = a call: comments or samples; one per day)
function visitFactsHtml(e) {
  const n = e.days_since_visit;
  const last = e.last_visit_at ? `${fmtStamp(e.last_visit_at)} <span class="vf-sub">· ${n === 0 ? 'today' : n === 1 ? 'yesterday' : `${n} days ago`}</span>` : 'Never visited';
  return `<div class="visit-facts">
    <div class="vf-cell"><span class="vf-l">Added</span><b>${e.created_at ? fmtStamp(e.created_at) : '—'}</b></div>
    <div class="vf-cell"><span class="vf-l">Last visit</span><b>${last}</b></div>
    <div class="vf-cell vf-wide"><span class="vf-l">Visits</span><b>${Number(e.visits_30 || 0)}</b> in 30 days · <b>${Number(e.visits_60 || 0)}</b> in 60 · <b>${Number(e.visits_90 || 0)}</b> in 90</div>
  </div>`;
}

function renderDetail(e, type) {
  if (state.currentEntity) state.currentEntity.rec = e;     // the loaded record: the call rules below read it
  if (type === 'doctor') (state.linked ||= { chemist: [], doctor: [] }).chemist = e.attached_chemists || [];
  const name = type === 'doctor' ? e.name : e.store_name;
  const photo = null; // (the old per-record photo field is no longer used)
  const title = type === 'doctor' ? docLabel(e) : chemLabel(e);
  state.currentLabel = title;       // used to describe a call saved offline
  const sub = type === 'doctor' ? [e.qualification, e.speciality].filter(Boolean).join(' · ') : (e.chemist_name || '');
  const mapUrl = (e.lat && e.lng ? `https://www.google.com/maps/search/?api=1&query=${e.lat},${e.lng}` : null);
  const isAdmin = isAdminRole();

  let accordions = '';
  if (type === 'doctor') {
    const detailsBody = `
      <div class="info-grid">
        ${field('Hospital / Clinic', e.hospital_name)}
        ${mobileField(e)}
        ${field('City', e.city)}
        ${field('Locality', e.locality)}
        ${field('RX Status', rxLabel(e.rx_status))}
        ${field('Core Status', e.core_status)}
        ${field('Monthly Sales', e.monthly_sales_generation ? `₹${Number(e.monthly_sales_generation).toLocaleString('en-IN')}` : '')}
        ${field('Birthday', e.birthday_date)}
        ${field('Anniversary', e.anniversary_date)}
        ${field('Rating', starDisplay(e.rating))}
      </div>
      ${e.address ? `<p class="notes-text" style="margin-top:10px">${e.address}</p>` : ''}
      ${e.prescription_details ? `<p class="notes-text" style="margin-top:10px"><b>Prescription:</b> ${e.prescription_details}</p>` : ''}
      ${e.commission_type ? `<p class="notes-text" style="margin-top:10px"><b>Commission type:</b> ${repEsc(commissionTypeLabel(e.commission_type))}</p>` : ''}
      ${e.doctor_commission_details ? `<p class="notes-text" style="margin-top:10px"><b>Commission notes:</b> ${e.doctor_commission_details}</p>` : ''}
    `;
    accordions += accordion('acc-details', 'Doctor Details', detailsBody);

    if (e.special_notes) accordions += accordion('acc-notes', 'Special Notes', `<p class="notes-text">${e.special_notes}</p>`);

    accordions += accordion('acc-mrday', 'MR Day', renderMrDaySection(e));

    accordions += accordion('acc-products', 'Products', renderDoctorProductsSection(e));

    accordions += accordion('acc-linked', 'Linked Chemists', `
      <div id="linked-list">${renderLinkedChemists(e.attached_chemists || [])}</div>
      <button class="action-btn secondary" style="margin-top:8px;width:100%" onclick="toggleLinkForm()">+ Link to a Chemist</button>
      <div id="link-form-box"></div>
    `);

    accordions += accordion('acc-samples', 'Samples', renderSamplesSection());

    accordions += accordion('acc-gifts', 'Gifts', renderGiftsSection(e));

    // Every MR can log commission paid to a doctor (with a screenshot of the payment) and fix their own entries; the Admin can change any.
    // The commission TYPE and the notes about it are edited with the doctor's details (✏️ Edit).
    accordions += accordion('acc-commission', 'Commission', `
      <div class="comm-line"><span>Type: <b>${e.commission_type ? repEsc(commissionTypeLabel(e.commission_type)) : 'not set'}</b></span><button type="button" class="link-btn" onclick="openEdit('doctor', ${e.id})">✏️ Edit type / details</button></div>
      ${e.doctor_commission_details ? `<div class="notes-text" style="margin:0 0 8px">${repEsc(e.doctor_commission_details)}</div>` : ''}
      <div id="commission-list"><div class="loading-row" style="padding:10px 0">Loading…</div></div>
      <button class="action-btn secondary" style="margin-top:8px;width:100%" onclick="toggleCommissionForm()">+ Log a payment (with screenshot)</button>
      <div id="commission-form-box"></div>
    `);
  } else {
    const detailsBody = `
      <div class="info-grid">
        ${mobileField(e)}
        ${field('City', e.city)}
        ${field('Locality', e.locality)}
        ${field('Rating', starDisplay(e.rating))}
        ${field('Billing Category', e.billing_category ? e.billing_category.charAt(0).toUpperCase() + e.billing_category.slice(1) : '')}
      </div>
      ${e.address ? `<p class="notes-text" style="margin-top:10px">${e.address}</p>` : ''}
    `;
    accordions += accordion('acc-details', 'Chemist Details', detailsBody);

    if (e.return_requests) accordions += accordion('acc-returns', 'Return Requests', `<p class="notes-text">${e.return_requests}</p>`);
    if (e.scheme_commission_details) accordions += accordion('acc-scheme', 'Scheme / Commission', `<p class="notes-text">${e.scheme_commission_details}</p>`);

    accordions += accordion('acc-linked', 'Linked Doctors', `
      <div id="linked-list">${renderLinkedDoctors(e.attached_doctors || [])}</div>
      <button class="action-btn secondary" style="margin-top:8px;width:100%" onclick="toggleLinkForm()">+ Link a doctor</button>
      <div id="link-form-box"></div>
    `);

    accordions += accordion('acc-stock', 'Stock', `
      <div id="stock-list">${renderStockTable(e.stock || [])}</div>
      <button class="action-btn secondary" style="margin-top:8px;width:100%" onclick="toggleStockForm()">+ Count stock on shelf</button>
      <div id="stock-form-box"></div>
      <div id="stock-history"></div>
    `);

    accordions += accordion('acc-payments', 'Payments', `
      <div id="payment-summary"></div>
      <div id="payment-list"><div class="loading-row" style="padding:10px 0">Loading…</div></div>
      <button class="action-btn secondary" style="margin-top:8px;width:100%" onclick="togglePaymentForm()">+ Record payment</button>
      <div id="payment-form-box"></div>
    `);
  }

  document.getElementById('detail-root').innerHTML = `
    <div class="detail-header ${type === 'doctor' ? (e.rx_status === 'RX' ? 'rx-bg-h' : e.rx_status === 'POTENTIAL' ? 'pot-bg-h' : 'nonrx-bg-h') : ''}">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <button class="back-btn" onclick="goBack()">←</button>
        <button type="button" class="owner-tag owner-tag-h owner-btn" onclick="openOwnerSheet('${type}', ${e.id})" title="Tap to change the owner">👤 Owner: ${repEsc(ownerName(e) || 'none')} ✎</button>
        <button class="back-btn" onclick="showView('list')" title="Home">🏠</button>
      </div>
      <div class="detail-photo-row">
        <div class="detail-avatar">${photo ? `<img src="${photo}" alt="">` : initials(name)}</div>
        <div>
          <h2>${repEsc(title)}</h2>
          <div class="sub">${sub}</div>
        </div>
      </div>
    </div>
    ${e.flagged_invalid ? `
      <div class="info-section" style="background:#FDECEA;border:1px solid #F5C6CB">
        <h3 style="color:#C0392B">🚩 Flagged as invalid</h3>
        <p class="notes-text">${e.flag_reason || 'No reason given.'}</p>
        <p style="font-size:11px;color:var(--text-muted);margin-top:4px">An admin needs to review this before it's removed — it's still visible until then.</p>
      </div>
    ` : ''}
    <div class="detail-actions">
      ${mapUrl ? `<a class="action-btn primary" href="${mapUrl}" target="_blank">📍 Navigate</a>` : ''}
      <button class="action-btn secondary" onclick="openEdit('${type}', ${e.id})">✏️ Edit</button>
    </div>
    ${!e.flagged_invalid ? `
      <div style="padding:0 16px 12px">
        <button class="action-btn secondary" style="width:100%;color:#C0392B" onclick="flagAsInvalid('${type}', ${e.id})">🚩 Flag listing as invalid / incorrect</button>
      </div>
    ` : ''}
    ${visitFactsHtml(e)}
    ${reminderBlockHtml()}
    ${accordions}
    ${accordion('acc-comments', 'Comments', `
      <div class="comment-composer">
        <div id="comment-composer-body"></div>
      </div>
      <div class="tools-row" style="padding:0 0 8px">
        <input type="text" id="feed-q" placeholder="Filter comments…" oninput="setFeedFilter('q', this.value)">
        <select id="feed-show" onchange="setFeedFilter('show', this.value)" aria-label="Show">
          <option value="all">All</option><option value="comments">Visits</option><option value="samples">Samples</option><option value="gifts">Gifts</option>${type === 'chemist' ? '<option value="stock">Stock counts</option>' : ''}<option value="payments">Payments</option>
        </select>
        <select id="feed-days" onchange="setFeedFilter('days', this.value)" aria-label="Period"><option value="">All time</option><option value="30">Last 30 days</option><option value="60">Last 60 days</option><option value="90">Last 90 days</option></select>
        <select id="feed-sort" onchange="setFeedFilter('sort', this.value)" aria-label="Sort"><option value="new">Newest first</option><option value="old">Oldest first</option></select>
      </div>
      <div id="feed-list"><div class="loading-row">Loading…</div></div>
      <button type="button" class="more-btn" id="feed-more" style="display:none" onclick="showMoreFeed()">More</button>
    `, true)}
  `;
  pendingSelfie = null;
  pendingGiftFile = null;
  renderCommentComposerBody();
}

function productChip(p) {
  return `<span class="badge badge-priority-B" style="margin:2px 4px 2px 0">${p.name}</span>`;
}

// One linked person, with an Unlink button. `kind` is what the OTHER side is ('chemist' or 'doctor').
function linkedRowHtml(kind, o) {
  const label = kind === 'doctor' ? docLabel(o) : chemLabel(o);
  const sub = kind === 'doctor' ? (o.speciality || '') : (o.chemist_name && o.chemist_name !== o.store_name ? o.chemist_name : '');
  return `
    <div class="info-item full ${kind === 'doctor' ? rxBg(o) : ''}" id="linked-${kind}-${o.id}" style="margin-bottom:10px;padding-bottom:10px;border-bottom:1px solid var(--border)">
      <div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start">
        <div>
          <div class="value" style="cursor:pointer" onclick="openDetail('${kind}',${o.id})">${repEsc(label)} →</div>
          ${sub ? `<div class="label">${repEsc(sub)}</div>` : ''}
          ${kind === 'doctor' && ownerName(o) ? `<div class="label">👤 Added by ${repEsc(ownerName(o))}</div>` : ''}
        </div>
        <button type="button" class="link-btn danger" id="unlink-${kind}-${o.id}" onclick="unlinkFrom('${kind}',${o.id})">Unlink</button>
      </div>
    </div>`;
}
function renderLinkedChemists(chemists) {
  (state.linked ||= { chemist: [], doctor: [] }).chemist = chemists;
  if (!chemists.length) return `<div style="color:var(--text-muted);font-size:13px;padding:6px 0">No chemists linked yet.</div>`;
  return chemists.map(c => linkedRowHtml('chemist', c)).join('');
}
function renderLinkedDoctors(doctors) {
  (state.linked ||= { chemist: [], doctor: [] }).doctor = doctors;
  if (!doctors.length) return `<div style="color:var(--text-muted);font-size:13px;padding:6px 0">No doctors linked yet.</div>`;
  return doctors.map(d => linkedRowHtml('doctor', d)).join('');
}

function renderStockTable(stock) {
  if (!stock.length) return `<div style="color:var(--text-muted);font-size:13px;padding:6px 0">No stock logged yet.</div>`;
  const rangeGroups = {};
  stock.forEach(s => { (rangeGroups[s.product_range || 'Other'] ||= []).push(s); });
  return Object.entries(rangeGroups).map(([range, items]) => `
    <div style="margin-bottom:10px">
      <div style="font-size:11px;font-weight:700;color:var(--purple);text-transform:uppercase;margin-bottom:6px">${range}</div>
      ${items.map(s => `
        <div class="info-item full" style="margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid var(--border)">
          <div class="value">${s.product_name}</div>
          <div style="display:flex;gap:16px;margin-top:4px;flex-wrap:wrap">
            <div><span style="font-size:11px;color:var(--text-muted)">Available: </span><b style="color:${s.quantity_available <= 5 ? 'var(--danger,#C0392B)' : 'var(--text)'}">${s.quantity_available} ${s.unit || ''}</b></div>
            <div><span style="font-size:11px;color:var(--text-muted)">Total Supplied: </span><b>${s.quantity_supplied_total} ${s.unit || ''}</b></div>
          </div>
          <div style="font-size:11px;color:var(--text-muted);margin-top:3px">
            ${s.last_supplied_at ? `Last supplied ${timeAgo(s.last_supplied_at)}` : ''}
            ${s.last_checked_at ? ` · Last checked ${timeAgo(s.last_checked_at)}` : ''}
          </div>
        </div>`).join('')}
    </div>`).join('');
}

// ===== Linking (doctor <-> chemist <-> product) =====
let productsCache = null;
async function ensureProductsCache() {
  if (!productsCache) productsCache = await Api.getProducts({ active: 'true' });
  return productsCache;
}

let linkChoices = [], linkPick = null;
const linkLabelOf = (o) => (state.currentEntity.type === 'doctor' ? chemLabel(o) : docLabel(o));

async function toggleLinkForm() {
  const box = document.getElementById('link-form-box');
  if (box.innerHTML) { box.innerHTML = ''; return; }
  const { type } = state.currentEntity;
  const otherType = type === 'doctor' ? 'chemist' : 'doctor';
  box.innerHTML = `<div class="loading-row">Loading…</div>`;
  try {
    const others = await (type === 'doctor' ? Api.getChemists({ limit: 500, include_dummy: 1 }) : Api.getDoctors({ limit: 500 }));
    const already = new Set(((state.linked || {})[otherType] || []).map(o => o.id));
    linkChoices = others.filter(o => !already.has(o.id)); // people already linked are not offered again
    linkPick = null;
    box.innerHTML = `
      <div class="comment-composer" style="margin-top:10px">
        <div class="form-field">
          <label>${otherType === 'doctor' ? 'Find a doctor' : 'Find a chemist'}</label>
          <input type="text" id="link-search" autocomplete="off" oninput="renderLinkOptions(this.value)">
          <div class="link-options" id="link-options"></div>
        </div>
        <div class="composer-actions"><button class="btn-post" id="link-save" onclick="submitLink()" disabled>Link</button></div>
      </div>`;
    renderLinkOptions('');
  } catch (err) {
    box.innerHTML = `<div style="color:var(--danger,#C0392B);font-size:13px;padding:8px 0">Couldn't load — ${err.message === 'offline' ? "you're offline" : 'try again'}.</div>`;
  }
}

function renderLinkOptions(q) {
  const el = document.getElementById('link-options');
  if (!el) return;
  const needle = (q || '').trim().toLowerCase(), isDoc = state.currentEntity.type === 'doctor';
  const list = linkChoices.filter(o => !needle || linkLabelOf(o).toLowerCase().includes(needle) || String(o.locality || '').toLowerCase().includes(needle)).slice(0, 30);
  el.innerHTML = list.length
    ? list.map(o => `<div class="link-opt${linkPick === o.id ? ' on' : ''} ${isDoc ? '' : rxBg(o)}" onclick="pickLink(${o.id})">${repEsc(linkLabelOf(o))}<small>${repEsc([isDoc ? (o.chemist_name && o.chemist_name !== o.store_name ? o.chemist_name : '') : o.speciality, o.locality, !isDoc && ownerName(o) ? `👤 ${ownerName(o)}` : ''].filter(Boolean).join(' · '))}</small></div>`).join('')
    : `<div class="empty-note" style="padding:10px">Nobody found.</div>`;
}

function pickLink(id) {
  linkPick = id;
  renderLinkOptions((document.getElementById('link-search') || {}).value);
  const o = linkChoices.find(x => x.id === id), btn = document.getElementById('link-save');
  if (btn && o) { btn.disabled = false; btn.textContent = `Link ${linkLabelOf(o)}`; }
}

// Re-reads just the linked list (one request) instead of reloading the whole page
async function refreshLinked() {
  const { type, id } = state.currentEntity;
  const e = type === 'doctor' ? await Api.getDoctor(id) : await Api.getChemist(id);
  const box = document.getElementById('linked-list');
  if (box) box.innerHTML = type === 'doctor' ? renderLinkedChemists(e.attached_chemists || []) : renderLinkedDoctors(e.attached_doctors || []);
  if (state.currentEntity && state.currentEntity.rec) { state.currentEntity.rec.attached_chemists = e.attached_chemists; state.currentEntity.rec.attached_doctors = e.attached_doctors; }
  renderCommentComposerBody();      // the 'link a chemist first' notice goes away once one is linked
}

async function submitLink() {
  const { type, id } = state.currentEntity;
  const o = linkChoices.find(x => x.id === linkPick);
  if (!o) return showToast('Choose who to link first');
  const btn = document.getElementById('link-save'), label = linkLabelOf(o);
  btn.disabled = true; btn.textContent = 'Linking…'; // shows at once — the server can take a few seconds to wake up
  const doctor_id = type === 'doctor' ? id : o.id, chemist_id = type === 'doctor' ? o.id : id;
  try {
    const res = await Api.linkDoctorChemist({ doctor_id, chemist_id });
    showToast(res && res.created === false ? `${label} was already linked` : `${label} linked`);
    document.getElementById('link-form-box').innerHTML = '';
    await refreshLinked();
  } catch (err) {
    showToast(err.message === 'offline' ? "You're offline — couldn't link." : (err.message || 'Could not link'));
    btn.disabled = false; btn.textContent = `Link ${label}`;
  }
}

async function unlinkFrom(kind, otherId) {
  const { type, id } = state.currentEntity;
  const o = ((state.linked || {})[kind] || []).find(x => x.id === otherId);
  const label = o ? (kind === 'doctor' ? docLabel(o) : chemLabel(o)) : 'this one';
  if (!confirm(`Unlink ${label}?`)) return;
  const btn = document.getElementById(`unlink-${kind}-${otherId}`);
  if (btn) { btn.disabled = true; btn.textContent = 'Unlinking…'; }
  const doctor_id = type === 'doctor' ? id : otherId, chemist_id = type === 'doctor' ? otherId : id;
  try {
    await Api.unlinkDoctorChemist(doctor_id, chemist_id);
    showToast(`${label} unlinked`);
    await refreshLinked();
  } catch (err) {
    showToast(err.message === 'offline' ? "You're offline — couldn't unlink." : (err.message || 'Could not unlink'));
    if (btn) { btn.disabled = false; btn.textContent = 'Unlink'; }
  }
}

// ===== A product list you tick, with a quantity for each ticked product =====
// Used by the chemist stock form and the doctor's product list.
function productPickerHtml(prefix, products) {
  return `
    <input type="text" class="pc-search" id="${prefix}-search" placeholder="Search products…" oninput="pcFilter('${prefix}', this.value)">
    <div class="pc-list" id="${prefix}-list">
      ${products.map(p => `
        <label class="pc-row" data-name="${repEsc((p.name + ' ' + (p.range || '')).toLowerCase())}">
          <input type="checkbox" class="${prefix}-check" value="${p.id}" onchange="pcToggle(this, '${prefix}')">
          <span class="pc-name">${repEsc(p.name)}${p.range ? `<small>${repEsc(p.range)}</small>` : ''}</span>
          <input type="number" class="pc-qty ${prefix}-qty" data-product="${p.id}" min="0" inputmode="numeric" disabled>
        </label>`).join('')}
    </div>
    <div class="pc-count" id="${prefix}-count"></div>`;
}
function pcFilter(prefix, q) {
  const needle = (q || '').trim().toLowerCase();
  document.querySelectorAll(`#${prefix}-list .pc-row`).forEach(r => { r.style.display = !needle || (r.dataset.name || '').includes(needle) ? '' : 'none'; });
}
function pcToggle(cb, prefix) {
  const qty = document.querySelector(`.${prefix}-qty[data-product="${cb.value}"]`);
  if (qty) { qty.disabled = !cb.checked; if (cb.checked) qty.focus(); else qty.value = ''; }
  const n = document.querySelectorAll(`.${prefix}-check:checked`).length, el = document.getElementById(`${prefix}-count`);
  if (el) el.textContent = n ? `${n} selected` : '';
}
// -> { items: [{ product_id, quantity }] } or { error }
function pcRead(prefix, { qtyRequired }) {
  const items = [];
  for (const cb of document.querySelectorAll(`.${prefix}-check:checked`)) {
    const q = document.querySelector(`.${prefix}-qty[data-product="${cb.value}"]`);
    const val = q ? String(q.value).trim() : '';
    if (qtyRequired && val === '') return { error: 'Enter a quantity for every ticked product' };
    if (val !== '' && !/^\d+$/.test(val)) return { error: 'Quantities must be whole numbers' };
    items.push({ product_id: Number(cb.value), quantity: val === '' ? null : Number(val) });
  }
  return items.length ? { items } : { error: 'Tick at least one product' };
}

// ===== Chemist stock: an MR records ONE thing — what is Counted on shelf (new deliveries are recorded by the admin) =====
let stockEvidence = null;   // { file, source: 'camera' | 'gallery', uploadedUrl }
async function toggleStockForm() {
  const box = document.getElementById('stock-form-box');
  if (box.innerHTML) { box.innerHTML = ''; stockEvidence = null; return; }

  box.innerHTML = `<div class="loading-row">Loading…</div>`;
  try {
    const products = await ensureProductsCache();
    stockEvidence = null;
    box.innerHTML = `
      <div class="comment-composer" style="margin-top:10px">
        <div class="form-field"><label style="font-size:15px;font-weight:800">Counted on shelf</label></div>
        <div class="form-field"><label>Products</label>${productPickerHtml('stk', products)}</div>
        <div class="form-field"><label>Notes (optional)</label><textarea id="stock-notes"></textarea></div>
        <div class="form-field"><label>Photo or selfie (optional)</label>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button type="button" class="action-btn secondary" onclick="document.getElementById('stock-file-cam').click()">📷 Take photo</button>
            <button type="button" class="action-btn secondary" onclick="document.getElementById('stock-file-gal').click()">🖼 Choose photo</button>
          </div>
          <input type="file" id="stock-file-cam" accept="image/*" capture="environment" style="display:none" onchange="onStockPhoto(event, 'camera')">
          <input type="file" id="stock-file-gal" accept="image/*" style="display:none" onchange="onStockPhoto(event, 'gallery')">
          <div id="stock-evidence-note" style="font-size:12px;margin-top:6px"></div>
        </div>
        <div class="composer-actions">
          <button class="btn-post" id="stock-save" onclick="submitStock()">Save count</button>
        </div>
      </div>`;
  } catch (err) {
    box.innerHTML = `<div style="color:var(--danger,#C0392B);font-size:13px;padding:8px 0">Couldn't load products.</div>`;
  }
}

function onStockPhoto(event, source) {
  const file = event.target.files && event.target.files[0];
  event.target.value = '';
  const note = document.getElementById('stock-evidence-note');
  if (!file) return;
  if (file.type && !/^image\//i.test(file.type)) { note.style.color = 'var(--danger)'; note.textContent = 'That file is not a picture.'; return; }
  stockEvidence = { file, source, uploadedUrl: null };
  note.style.color = 'var(--green)';
  note.innerHTML = `✅ Photo attached <button type="button" class="link-btn danger" onclick="clearStockPhoto()">Remove</button>`;
}
function clearStockPhoto() { stockEvidence = null; const n = document.getElementById('stock-evidence-note'); if (n) n.textContent = ''; }

async function submitStock() {
  const { id } = state.currentEntity;
  const notes = document.getElementById('stock-notes').value.trim();
  const read = pcRead('stk', { qtyRequired: true });
  if (read.error) return showToast(read.error);

  const btn = document.getElementById('stock-save');
  btn.disabled = true; btn.textContent = stockEvidence ? 'Uploading photo…' : 'Saving…';
  try {
    const body = { entry_type: 'check', items: read.items, notes: notes || null };   // 'check' = Counted on shelf (the only option)
    if (stockEvidence) {
      if (!stockEvidence.uploadedUrl) stockEvidence.uploadedUrl = await Api.uploadPhoto(stockEvidence.file, { timeoutMs: UPLOAD_TIMEOUT_MS }); // kept, so a retry does not upload again
      body.evidence_url = stockEvidence.uploadedUrl; body.photo_source = stockEvidence.source;
      btn.textContent = 'Saving…';
    }
    const res = await Api.logStockBatch(id, body);
    showToast(`Stock count saved (${res.logged} product${res.logged === 1 ? '' : 's'})`);
    document.getElementById('stock-form-box').innerHTML = '';
    stockEvidence = null;
    const [e, events] = await Promise.all([Api.getChemist(id), Api.getStockEvents(id).catch(() => [])]);
    const list = document.getElementById('stock-list');
    if (list) list.innerHTML = renderStockTable(e.stock || []);
    feedState.stockEvents = events;       // it shows under Stock AND in Comments
    renderStockHistory(events);
    renderFeed();
  } catch (err) {
    showToast(err.message === 'offline' ? "You're offline — nothing was saved. Tap Retry." : err.message === 'timeout' ? 'The photo upload is taking too long. Your count is kept — tap Retry.' : (err.message || 'Stock update failed'));
    btn.disabled = false; btn.textContent = 'Retry';
  }
}

function timeAgo(iso) { return fmtStamp(iso); }     // (kept by name for the places that call it) always the EXACT date and time, never a relative time

// ===== Comments: the whole history of this doctor / chemist =====
// Visits, samples and gifts — plus commission payments when an admin is
// looking — newest first. The latest 3 show; "More" reveals older ones.
const FEED_FIRST = 3, FEED_STEP = 10;
let feedState = { visits: [], payments: [], chemPayments: [], stockEvents: [], shown: FEED_FIRST };
let feedTools = { q: '', show: 'all', sort: 'new', days: '' };

function fmtDayYear(d) {
  const x = new Date(String(d).length === 10 ? `${d}T12:00:00` : d);
  return x.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
}

// Samples saved before structured lines existed only have the text
// "Samples given: A x10, B x5" — read the lines back out of that.
function sampleLines(v) {
  if (v.samples && v.samples.length) return v.samples;
  const text = String(v.comment_text || '').replace(/^.*?Samples given:\s*/i, '');
  return text.split(',').map(p => p.trim().match(/^(.*?)\s*x\s*(\d+)$/i)).filter(Boolean).map(m => ({ product: m[1], quantity: Number(m[2]) }));
}

function feedCardHtml(v) {
  const mapLink = v.lat && v.lng ? `https://www.google.com/maps/search/?api=1&query=${v.lat},${v.lng}` : null;
  // Coloured by the doctor's RX status AT THE TIME this was logged (not their
  // current status) — shows how many visits happened while still a target.
  const rxClass = v.doctor_rx_status_at_time === 'NON_RX' ? 'rx-target' : (v.doctor_rx_status_at_time === 'POTENTIAL' ? 'rx-potential' : (v.doctor_rx_status_at_time === 'RX' ? 'rx-prescribing' : ''));
  const categoryBadge = v.category === 'gift' ? '<span class="gift-badge">Gift</span>'
    : v.category === 'samples' ? '<span class="samples-badge">Samples</span>' : '';
  const mgrBadge = v.is_manager_call ? `<span class="mgr-badge">🧑‍💼 Manager call${v.manager_name ? ' with ' + repEsc(v.manager_name) : ''}</span>` : '';
  const lines = v.category === 'samples' ? sampleLines(v) : [];
  const text = lines.length ? lines.map(s => `${repEsc(s.product)} × ${s.quantity}`).join(', ') : (v.comment_text ? repEsc(v.comment_text) : '');
  return `
  <div class="comment-item ${rxClass}" id="visit-${v.id}">
    <div class="comment-head">
      <span class="comment-author">${repEsc(v.author_name)}</span>
      <span class="comment-time">${timeAgo(v.visited_at)}</span>
    </div>
    ${categoryBadge || mgrBadge ? `<div style="margin-bottom:5px">${categoryBadge}${mgrBadge}</div>` : ''}
    ${text ? `<div class="comment-text">${text}</div>` : ''}
    ${v.photo_url ? `<a href="${repEsc(v.photo_url)}" target="_blank" rel="noopener"><img class="comment-photo" loading="lazy" src="${repEsc(thumbUrl(v.photo_url, 640))}" alt="${v.category === 'gift' ? 'Gift photo' : 'Verification selfie'}"></a>` : ''}
    <div class="badge-row" style="margin-top:7px">
      ${v.is_first_visit ? `<span class="badge badge-rx">📍 First visit — verified</span>` : (mapLink ? `<span class="badge badge-rx">📍 Location verified</span>` : '')}
      ${mapLink ? `<a href="${mapLink}" target="_blank" rel="noopener" class="badge badge-priority-B" style="text-decoration:none">🗺️ View exact location</a>` : ''}
    </div>
    <button class="reply-toggle" onclick="toggleReplyThread(${v.id})" style="margin-top:8px;background:none;border:none;color:var(--purple);font-weight:700;font-size:12px;padding:0">
      ${v.reply_count > 0 ? `${v.reply_count} repl${v.reply_count === 1 ? 'y' : 'ies'}` : 'Reply'}
    </button>
    ${isAdminRole() ? `<button type="button" class="link-btn danger" style="margin-left:10px" onclick="deleteComment(${v.id})">Delete</button>` : ''}
    <div id="reply-thread-${v.id}"></div>
  </div>`;
}

// Admin only: remove any comment (its photo and replies go with it)
async function deleteComment(visitId) {
  const v = feedState.visits.find(x => x.id === visitId);
  const what = v ? (v.category === 'gift' ? 'gift' : v.category === 'samples' ? 'samples entry' : 'comment') : 'comment';
  if (!confirm(`Delete this ${what}${v ? ` by ${v.author_name}` : ''}? Its photo and replies are deleted too.`)) return;
  try {
    await Api.deleteVisit(visitId);
    showToast(`${what[0].toUpperCase()}${what.slice(1)} deleted`);
    await loadFeed(state.currentEntity.type, state.currentEntity.id);
  } catch (err) {
    showToast(err.message === 'offline' ? "You're offline — couldn't delete." : (err.message || 'Could not delete'));
  }
}

function commissionCardHtml(p) {
  return `
  <div class="comment-item commission-item">
    <div class="comment-head">
      <span class="comment-author">Commission paid</span>
      <span class="comment-time">${fmtDayYear(p.payment_date)}</span>
    </div>
    <div class="comment-text"><b>₹${Number(p.amount).toLocaleString('en-IN')}</b>${p.notes ? ` — ${repEsc(p.notes)}` : ''}</div>
    ${p.evidence_url ? `<a href="${repEsc(p.evidence_url)}" target="_blank" rel="noopener" style="display:inline-block;margin-top:6px;font-size:12px;color:var(--purple);font-weight:700">${p.evidence_type === 'pdf' ? 'View PDF' : 'View evidence'}</a>` : ''}
    <div style="font-size:11px;color:var(--text-muted);margin-top:4px">Logged by ${repEsc(p.logged_by_name || 'Unknown')} · ${fmtStamp(p.created_at)}</div>
  </div>`;
}

const feedGroup = (i) => i.kind === 'visit' ? (i.v.category === 'samples' ? 'samples' : i.v.category === 'gift' ? 'gifts' : 'comments') : i.kind === 'stock' ? 'stock' : 'payments';
function feedText(i) {
  if (i.kind === 'visit') return [i.v.comment_text, i.v.author_name, i.v.category, ...(i.v.samples || []).map(s => s.product || s.product_name)].join(' ');
  if (i.kind === 'stock') return ['stock', i.e.kind, i.e.notes, i.e.author_name, ...(i.e.items || []).map(x => x.product_name)].join(' ');
  return ['payment', i.p.mode, i.p.notes, i.p.reference, i.p.amount, i.p.logged_by_name].join(' ');
}
function feedItems() {
  const items = feedState.visits.map(v => ({ kind: 'visit', at: new Date(v.visited_at).getTime(), v }));
  feedState.payments.forEach(p => items.push({ kind: 'commission', at: new Date(`${String(p.payment_date).slice(0, 10)}T12:00:00`).getTime(), p }));
  (feedState.chemPayments || []).forEach(p => items.push({ kind: 'cpayment', at: new Date(`${String(p.payment_date).slice(0, 10)}T12:00:00`).getTime(), p }));
  (feedState.stockEvents || []).forEach(e => items.push({ kind: 'stock', at: new Date(e.created_at).getTime(), e }));
  const q = feedTools.q.trim().toLowerCase();
  const since = feedTools.days ? Date.now() - Number(feedTools.days) * 86400000 : 0;      // "last 30 / 60 / 90 days"
  const kept = items.filter(i => (feedTools.show === 'all' || feedGroup(i) === feedTools.show) && (!q || feedText(i).toLowerCase().includes(q)) && (!since || i.at >= since));
  return kept.sort((a, b) => feedTools.sort === 'old' ? a.at - b.at : b.at - a.at);
}
function setFeedFilter(key, value) { feedTools[key] = value; feedState.shown = FEED_FIRST; renderFeed(); }

// A stock count or delivery, as a comment
const fmtStamp = (iso) => (iso ? new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' }).replace(/\b(am|pm)\b/, (x) => x.toUpperCase()) : '—');   // 22 Oct 2026, 3:42 PM
function stockCardHtml(ev) {
  const items = (ev.items || []).map(i => `${repEsc(i.product_name)} × ${Number(i.quantity).toLocaleString('en-IN')}`).join(', ');
  return `
  <div class="comment-item stock-item">
    <div class="comment-head">
      <span class="comment-author">${ev.kind === 'delivery' ? 'Stock delivered' : 'Stock counted on shelf'} · ${repEsc(ev.author_name || '—')}</span>
      <span class="comment-time">${fmtStamp(ev.created_at)}</span>
    </div>
    <div class="comment-text">${items || '—'}</div>
    ${ev.notes ? `<div class="comment-text" style="color:var(--text-muted)">${repEsc(ev.notes)}</div>` : ''}
    ${ev.evidence_url ? `<a href="${repEsc(ev.evidence_url)}" target="_blank" rel="noopener" style="display:inline-block;margin-top:6px;font-size:12px;color:var(--purple);font-weight:700">View photo${ev.photo_source === 'gallery' ? ' (from gallery)' : ''}</a>` : ''}
  </div>`;
}
// The same counts, listed under the Stock section
function renderStockHistory(events) {
  const box = document.getElementById('stock-history');
  if (!box) return;
  box.innerHTML = events.length
    ? `<div class="sh-title" style="margin-top:12px">Stock counts</div>` + events.map(stockCardHtml).join('')
    : `<div class="empty-note" style="margin-top:10px">No stock counts recorded yet.</div>`;
}

function renderFeed() {
  const list = document.getElementById('feed-list');
  if (!list) return;
  const items = feedItems(), shown = items.slice(0, feedState.shown);
  list.innerHTML = items.length
    ? shown.map(i => i.kind === 'visit' ? feedCardHtml(i.v) : i.kind === 'stock' ? stockCardHtml(i.e) : i.kind === 'cpayment' ? paymentCardHtml(i.p) : commissionCardHtml(i.p)).join('')
    : `<div class="empty-state" style="padding:24px">${feedTools.q || feedTools.show !== 'all' ? 'Nothing matches this filter.' : 'No comments yet.'}</div>`;
  const more = document.getElementById('feed-more'), left = items.length - shown.length;
  if (more) { more.style.display = left > 0 ? 'block' : 'none'; more.textContent = `More (${left} older)`; }
}

function showMoreFeed() { feedState.shown += FEED_STEP; renderFeed(); }

function renderGiftList(visits) {
  const el = document.getElementById('gift-list');
  if (!el) return;
  const gifts = visits.filter(v => v.category === 'gift');
  el.innerHTML = gifts.length ? gifts.map(feedCardHtml).join('') : `<div class="empty-note">No gifts recorded yet.</div>`;
}

// Everything ever given to this doctor as samples, with running totals
function renderSamplesHistory(visits) {
  const box = document.getElementById('samples-history');
  if (!box) return;
  const rows = visits.filter(v => v.category === 'samples');
  if (!rows.length) { box.innerHTML = `<div class="sh-title">Samples given</div><div class="empty-note">No samples given yet.</div>`; return; }
  const totals = {};
  rows.forEach(v => sampleLines(v).forEach(s => { totals[s.product] = (totals[s.product] || 0) + Number(s.quantity); }));
  box.innerHTML = `
    <div class="sh-title">Samples given</div>
    <div class="sh-totals">${Object.entries(totals).sort((a, b) => b[1] - a[1]).map(([p, q]) => `<span class="sh-pill">${repEsc(p)} × ${q}</span>`).join('')}</div>
    ${rows.map(v => `<div class="sh-row"><div class="sh-head"><b>${fmtStamp(v.visited_at)}</b> · ${repEsc(v.author_name)}</div><div>${sampleLines(v).map(s => `${repEsc(s.product)} × ${s.quantity}`).join(', ')}</div></div>`).join('')}`;
}

async function loadFeed(type, id) {
  try {
    const wantPay = type === 'doctor';   // everyone sees the commission paid (read-only)
    const [visits, payments, chemPayments, stockEvents] = await Promise.all([
      Api.getVisits(type, id),
      wantPay ? Api.getCommissionPayments(id).catch(() => []) : Promise.resolve([]),
      type === 'chemist' ? Api.getChemistPayments(id).catch(() => []) : Promise.resolve([]), // payments received show in the history for everyone
      type === 'chemist' ? Api.getStockEvents(id).catch(() => []) : Promise.resolve([])       // stock counts show as comments too
    ]);
    feedState = { visits, payments, chemPayments, stockEvents, shown: FEED_FIRST };
    renderFeed();
    renderSamplesHistory(visits);
    renderGiftList(visits);
    if (wantPay) renderCommissionList(payments);
    if (type === 'chemist') { renderPaymentList(chemPayments); renderStockHistory(stockEvents); }
  } catch (err) {
    // silent — offline handled elsewhere
  }
}

// ===== Payments received from a chemist =====
const PAY_MODES = { cash: 'Cash', upi: 'UPI', cheque: 'Cheque', bank_transfer: 'Bank transfer', other: 'Other' };
const rupees = (n) => '₹' + Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });

function paymentCardHtml(p) {
  return `
  <div class="comment-item payment-item">
    <div class="comment-head">
      <span class="comment-author">Payment received</span>
      <span class="comment-time">${fmtDayYear(p.payment_date)}</span>
    </div>
    <div class="comment-text"><b>${rupees(p.amount)}</b> · ${repEsc(PAY_MODES[p.mode] || p.mode)}${p.reference ? ` · ${repEsc(p.reference)}` : ''}${p.notes ? ` — ${repEsc(p.notes)}` : ''}</div>
    ${p.evidence_url ? `<a href="${repEsc(p.evidence_url)}" target="_blank" rel="noopener" style="display:inline-block;margin-top:6px;font-size:12px;color:var(--purple);font-weight:700">${p.evidence_type === 'pdf' ? 'View PDF' : 'View photo'}</a>` : ''}
    <div style="font-size:11px;color:var(--text-muted);margin-top:4px">Recorded by ${repEsc(p.logged_by_name || 'Unknown')} · ${fmtStamp(p.created_at)}</div>
  </div>`;
}

function renderPaymentList(payments) {
  const box = document.getElementById('payment-list'), sum = document.getElementById('payment-summary');
  if (!box) return;
  state.chemPayments = payments;
  const month = istDate(0).slice(0, 7), admin = isAdminRole();
  const total = payments.reduce((n, p) => n + Number(p.amount), 0);
  const thisMonth = payments.filter(p => String(p.payment_date).startsWith(month)).reduce((n, p) => n + Number(p.amount), 0);
  if (sum) sum.innerHTML = payments.length ? `<div class="pay-summary">Received ${rupees(total)} in ${payments.length} payment${payments.length === 1 ? '' : 's'} · This month ${rupees(thisMonth)}</div>` : '';
  box.innerHTML = payments.length ? payments.map(p => `
    <div class="pay-row">
      <div style="display:flex;justify-content:space-between;gap:8px;align-items:baseline">
        <span class="amt">${rupees(p.amount)}</span><span style="font-size:12.5px">${fmtDayYear(p.payment_date)}</span>
      </div>
      <div class="meta">${repEsc(PAY_MODES[p.mode] || p.mode)}${p.reference ? ` · ${repEsc(p.reference)}` : ''}${p.notes ? ` — ${repEsc(p.notes)}` : ''}</div>
      ${p.evidence_url ? `<a href="${repEsc(p.evidence_url)}" target="_blank" rel="noopener" style="font-size:12px;color:var(--purple);font-weight:700">${p.evidence_type === 'pdf' ? 'View PDF' : 'View photo'}</a>` : ''}
      <div class="meta">Recorded by ${repEsc(p.logged_by_name || 'Unknown')}${admin ? ` · <button type="button" class="link-btn danger" onclick="deletePayment(${p.id})">Delete</button>` : ''}</div>
    </div>`).join('') : `<div class="empty-note">No payments recorded yet.</div>`;
}

let cpayEvidence = null;   // { file, source }
function onCpayFile(event, source) {
  const file = event.target.files && event.target.files[0];
  event.target.value = '';
  const note = document.getElementById('cpay-evidence-note');
  if (!file) return;
  if (file.type && !/^(image\/|application\/pdf)/i.test(file.type)) { note.style.color = 'var(--danger)'; note.textContent = 'Choose a photo or a PDF.'; return; }
  cpayEvidence = { file, source };
  note.style.color = 'var(--green)';
  note.innerHTML = `✅ ${source === 'camera' ? 'Photo' : 'File'} attached <button type="button" class="link-btn danger" onclick="clearCpayFile()">Remove</button>`;
}
function clearCpayFile() { cpayEvidence = null; const n = document.getElementById('cpay-evidence-note'); if (n) n.textContent = ''; }

function togglePaymentForm() {
  const box = document.getElementById('payment-form-box');
  if (box.innerHTML) { box.innerHTML = ''; cpayEvidence = null; return; }
  cpayEvidence = null;
  box.innerHTML = `
    <div class="comment-composer" style="margin-top:10px">
      <div class="form-row">
        <div class="form-field"><label>Amount (₹) *</label><input type="number" id="cpay-amount" min="0" step="any" inputmode="decimal"></div>
        <div class="form-field"><label>Date</label><input type="date" id="cpay-date" value="${istDate(0)}" max="${istDate(0)}"></div>
      </div>
      <div class="form-field"><label>Paid by</label>
        <select id="cpay-mode">${Object.entries(PAY_MODES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
      </div>
      <div class="form-field"><label>Reference (cheque no., UPI / bank reference)</label><input type="text" id="cpay-ref" maxlength="100"></div>
      <div class="form-field"><label>Notes</label><textarea id="cpay-notes"></textarea></div>
      <div class="form-field"><label>Receipt or cheque photo (optional)</label>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button type="button" class="action-btn secondary" onclick="document.getElementById('cpay-file-cam').click()">📷 Take photo</button>
          <button type="button" class="action-btn secondary" onclick="document.getElementById('cpay-file-gal').click()">🖼 Choose from gallery</button>
        </div>
        <input type="file" id="cpay-file-cam" accept="image/*" capture="environment" style="display:none" onchange="onCpayFile(event, 'camera')">
        <input type="file" id="cpay-file-gal" accept="image/*,application/pdf" style="display:none" onchange="onCpayFile(event, 'gallery')">
        <div id="cpay-evidence-note" style="font-size:12px;margin-top:6px"></div>
      </div>
      <div class="composer-actions"><button class="btn-post" id="cpay-save" onclick="savePayment()">Save payment</button></div>
    </div>`;
}

async function savePayment() {
  const { id } = state.currentEntity;
  const amount = document.getElementById('cpay-amount').value.trim(), payment_date = document.getElementById('cpay-date').value;
  if (!amount || !(Number(amount) > 0)) return showToast('Enter the amount received');
  if (!payment_date) return showToast('Choose the payment date');
  const btn = document.getElementById('cpay-save'), file = cpayEvidence ? cpayEvidence.file : null;
  btn.disabled = true; btn.textContent = file ? 'Uploading…' : 'Saving…';
  try {
    const body = { amount: Number(amount), payment_date, mode: document.getElementById('cpay-mode').value, reference: document.getElementById('cpay-ref').value.trim() || null, notes: document.getElementById('cpay-notes').value.trim() || null };
    if (file) { const up = await Api.uploadEvidence(file); body.evidence_url = up.url; body.evidence_type = up.type; } // the photo is optional
    await Api.addChemistPayment(id, body);
    showToast(`Payment of ${rupees(amount)} recorded`);
    document.getElementById('payment-form-box').innerHTML = '';
    cpayEvidence = null;
    const list = await Api.getChemistPayments(id);
    feedState.chemPayments = list;
    renderPaymentList(list);
    renderFeed();
  } catch (err) {
    showToast(err.message === 'offline' ? "You're offline — payment not saved." : (err.message || 'Could not save the payment'));
    btn.disabled = false; btn.textContent = 'Save payment';
  }
}

async function deletePayment(paymentId) {
  const p = (state.chemPayments || []).find(x => x.id === paymentId);
  if (!p || !confirm(`Delete the payment of ${rupees(p.amount)} on ${fmtDayYear(p.payment_date)}?`)) return;
  try {
    await Api.deleteChemistPayment(state.currentEntity.id, paymentId);
    showToast('Payment deleted');
    const list = await Api.getChemistPayments(state.currentEntity.id);
    feedState.chemPayments = list;
    renderPaymentList(list);
    renderFeed();
  } catch (err) { showToast(err.message || 'Could not delete'); }
}

let openThreads = new Set();
let samplesShot = null;
let pendingSelfie = null; // { blob, previewUrl, lat, lng } — reset per detail view / after posting

async function toggleReplyThread(visitId) {
  const box = document.getElementById(`reply-thread-${visitId}`);
  if (openThreads.has(visitId)) {
    openThreads.delete(visitId);
    box.innerHTML = '';
    return;
  }
  openThreads.add(visitId);
  box.innerHTML = `<div class="loading-row" style="padding:10px 0">Loading…</div>`;
  try {
    const replies = await Api.getReplies(visitId);
    renderReplyThread(visitId, replies);
  } catch (err) {
    box.innerHTML = `<div style="font-size:12px;color:var(--text-muted);padding:6px 0">Couldn't load replies.</div>`;
  }
}

function renderReplyThread(visitId, replies) {
  const box = document.getElementById(`reply-thread-${visitId}`);
  const list = replies.map(r => `
    <div style="background:${r.author_role !== 'mr' ? 'var(--purple-tint)' : 'var(--bg)'};border-radius:8px;padding:8px 10px;margin-top:6px">
      <div style="display:flex;justify-content:space-between;font-size:11.5px;margin-bottom:2px">
        <span style="font-weight:700;color:${r.author_role !== 'mr' ? 'var(--purple)' : 'var(--text)'}">${r.author_name}${r.author_role === 'admin' ? ' (Admin)' : r.author_role === 'super' ? ' (Super User)' : ''}</span>
        <span style="color:var(--text-muted)">${timeAgo(r.created_at)}</span>
      </div>
      <div style="font-size:13px">${r.message}</div>
    </div>`).join('');

  box.innerHTML = `
    <div style="margin-top:8px;border-top:1px solid var(--border);padding-top:8px">
      ${list || `<div style="font-size:12px;color:var(--text-muted)">No replies yet.</div>`}
      <div style="display:flex;gap:6px;margin-top:8px">
        <input type="text" id="reply-input-${visitId}" placeholder="Write a reply…" style="flex:1;padding:8px 10px;border-radius:8px;border:1px solid var(--border);font-size:13px">
        <button onclick="submitReply(${visitId})" style="background:var(--purple);color:#fff;border:none;border-radius:8px;padding:0 14px;font-weight:700;font-size:12.5px">Send</button>
      </div>
    </div>`;
}

async function submitReply(visitId) {
  const input = document.getElementById(`reply-input-${visitId}`);
  const message = input.value.trim();
  if (!message) return;
  try {
    await Api.addReply(visitId, message);
    const replies = await Api.getReplies(visitId);
    renderReplyThread(visitId, replies);
    // reflect new count on the toggle button without a full feed reload
    const btn = document.querySelector(`#visit-${visitId} .reply-toggle`);
    if (btn) btn.innerHTML = `💬 ${replies.length} repl${replies.length === 1 ? 'y' : 'ies'}`;
  } catch (err) {
    toast(err.message === 'offline' ? "You're offline — reply not sent." : 'Could not send reply');
  }
}

// ===== Mandatory selfie + geotag capture =====

// ===== Selfie: an in-app camera that is light on memory, the phone camera as a fallback, and the gallery for
// people the admin authorizes. Whether a selfie is needed at all is the admin's per-person setting. =====
const SELFIE_MAX_DIM = 800;                    // plenty to recognise a face; a fraction of a camera photo's memory
const GALLERY_MAX_BYTES = 25 * 1024 * 1024;
const UPLOAD_TIMEOUT_MS = 60000;
let liveStream = null;

// getUserMedia / upload errors -> a clear sentence and what the person can do about it
function cameraProblem(err) {
  const n = err && err.name;
  if (n === 'NotAllowedError' || n === 'PermissionDeniedError' || n === 'SecurityError') return { text: 'Camera permission is blocked. Allow the camera for this site in your browser settings, then try again — or use the phone\'s camera app.', retry: true };
  if (n === 'NotFoundError' || n === 'DevicesNotFoundError') return { text: 'No camera was found. Use the phone\'s camera app instead.', retry: false };
  if (n === 'NotReadableError' || n === 'TrackStartError' || n === 'AbortError') return { text: 'The camera could not start — another app may be using it, or the phone is low on memory. Close other apps and try again, or use the phone\'s camera app.', retry: true };
  if (n === 'TimeoutError') return { text: 'The camera is taking too long to start. Try again, or use the phone\'s camera app.', retry: true };
  if (n === 'NotSupportedError' || n === 'OverconstrainedError' || n === 'TypeError') return { text: 'This phone\'s browser cannot open the camera here. Use the phone\'s camera app instead.', retry: false };
  return { text: 'The camera could not be opened. Try again, or use the phone\'s camera app.', retry: true };
}
function uploadProblem(err) {
  const m = err && err.message, st = err && err.status;
  if (m === 'offline') return "No internet connection. Your selfie is kept — tap Retry when you're back online.";
  if (m === 'timeout') return 'The upload is taking too long (weak signal?). Your selfie is kept — tap Retry.';
  if (st === 413) return 'That photo is too large to upload. Please take it again.';
  if (st >= 500) return 'The server had a problem. Your selfie is kept — tap Retry in a moment.';
  if (m === 'encode_failed' || (err && err.name === 'QuotaExceededError')) return 'Your phone is low on memory or storage. Close other apps, free some space and try again.';
  if (m === 'location') return "Couldn't get your location. Turn on GPS / location permission and tap Retry.";
  return m || 'Could not save. Please try again.';
}

function stopLiveCamera() {                      // release the camera at once: it holds a lot of memory
  if (liveStream) { liveStream.getTracks().forEach(t => { try { t.stop(); } catch (e) { /* already stopped */ } }); liveStream = null; }
  const v = document.getElementById('ss-video');
  if (v) { try { v.pause(); } catch (e) { /* not playing */ } v.srcObject = null; }
}
async function startLiveCamera(video) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { const e = new Error('unsupported'); e.name = 'NotSupportedError'; throw e; }
  stopLiveCamera();
  const ask = navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 15, max: 24 } } });
  const timeout = new Promise((_, rej) => setTimeout(() => { const e = new Error('timeout'); e.name = 'TimeoutError'; rej(e); }, 12000));
  liveStream = await Promise.race([ask, timeout]);
  video.srcObject = liveStream;
  await video.play();
}
// one frame from the live video, straight onto a SMALL canvas (never the sensor's full size)
function grabFrame(video) {
  const fit = Api.fitDimensions(video.videoWidth || 640, video.videoHeight || 480, SELFIE_MAX_DIM);
  const canvas = document.createElement('canvas');
  canvas.width = fit.width; canvas.height = fit.height;
  canvas.getContext('2d').drawImage(video, 0, 0, fit.width, fit.height);
  return { source: canvas, width: fit.width, height: fit.height };
}
function releaseFrame(frame) {                    // never keep two large copies of the same picture
  if (!frame || !frame.source) return;
  if (frame.source.close) frame.source.close(); else { try { frame.source.width = 0; frame.source.height = 0; } catch (e) { /* nothing to free */ } }
}
// a picture chosen from the phone's camera app or gallery: checked, then decoded already small
async function readPickedPhoto(file) {
  if (!file) throw new Error('No photo was chosen.');
  if (file.type && !/^image\//i.test(file.type)) throw new Error('That file is not a picture. Please choose a photo.');
  if (!file.size) throw new Error('That photo is empty. Please choose another.');
  if (file.size > GALLERY_MAX_BYTES) throw new Error('That photo is too large (over 25 MB). Please choose a smaller one.');
  try { return await Api.loadScaled(file, SELFIE_MAX_DIM); } catch (e) { throw new Error("Couldn't read that photo. Please choose another or take a new one."); }
}

// The capture sheet. Resolves { frame, source: 'camera' | 'gallery' }, or null if the person cancels.
// opts.gallery: true = always offer "Choose from gallery" (samples); omitted = only when the admin allowed it for this person (comments)
function openSelfieSheet(opts = {}) {
  return new Promise((resolve) => {
    let done = false;
    const gallery = opts.gallery !== undefined ? !!opts.gallery : galleryAllowed();
    const finish = (val) => { if (done) return; done = true; stopLiveCamera(); const el = document.getElementById('selfie-sheet'); if (el && el.remove) el.remove(); resolve(val); };
    const sheet = document.createElement('div');
    sheet.id = 'selfie-sheet'; sheet.className = 'selfie-sheet';
    sheet.innerHTML = `
      <div class="ss-box">
        <video id="ss-video" playsinline muted autoplay></video>
        <div id="ss-msg" class="ss-msg"></div>
        <div class="ss-actions">
          <button type="button" class="action-btn primary" id="ss-shoot" disabled>📸 Take photo</button>
          <button type="button" class="action-btn secondary" id="ss-retry" style="display:none">Try again</button>
          <button type="button" class="action-btn secondary" id="ss-phone" style="display:none">Use the phone's camera app</button>
          ${gallery ? '<button type="button" class="action-btn secondary" id="ss-gallery">🖼 Choose from gallery</button>' : ''}
          <button type="button" class="action-btn secondary" id="ss-cancel">Cancel</button>
        </div>
        <input type="file" accept="image/*" capture="user" id="ss-file-camera" style="display:none">
        ${gallery ? '<input type="file" accept="image/*" id="ss-file-gallery" style="display:none">' : ''}
      </div>`;
    document.body.appendChild(sheet);

    const $s = (id) => document.getElementById(id);
    const say = (text, bad) => { const m = $s('ss-msg'); if (m) { m.textContent = text; m.style.color = bad ? '#C0392B' : ''; } };
    const handleFile = async (input, source) => {
      const file = input.files && input.files[0];
      clearResume();
      if (!file) return;
      say('Preparing the photo…');
      try { finish({ frame: await readPickedPhoto(file), source }); }
      catch (e) { say(e.message, true); }
      input.value = '';
    };
    const start = async () => {
      say('Starting the camera…'); $s('ss-shoot').disabled = true; $s('ss-retry').style.display = 'none'; $s('ss-phone').style.display = 'none';
      try { await startLiveCamera($s('ss-video')); if (done) { stopLiveCamera(); return; } say('Centre your face, then tap Take photo'); $s('ss-shoot').disabled = false; }
      catch (err) {
        stopLiveCamera();
        const p = cameraProblem(err);
        say(p.text, true);
        $s('ss-retry').style.display = p.retry ? '' : 'none';
        $s('ss-phone').style.display = '';
      }
    };
    $s('ss-shoot').onclick = () => { try { const frame = grabFrame($s('ss-video')); finish({ frame, source: 'camera' }); } catch (e) { say('Could not take the photo — the phone may be low on memory. Close other apps and try again.', true); } };
    $s('ss-retry').onclick = start;
    $s('ss-cancel').onclick = () => finish(null);
    $s('ss-phone').onclick = () => { rememberResume(); stopLiveCamera(); $s('ss-file-camera').click(); };
    $s('ss-file-camera').onchange = (e) => handleFile(e.target, 'camera');
    if (gallery) {
      $s('ss-gallery').onclick = () => { rememberResume(); stopLiveCamera(); $s('ss-file-gallery').click(); };
      $s('ss-file-gallery').onchange = (e) => handleFile(e.target, 'gallery');
    }
    start();
  });
}

function formatWatermarkTimestamp(d) {
  return d.toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// Draws the picture onto a canvas with a burned-in bottom bar: doctor/chemist, address, date & time and GPS.
// A picture chosen from the gallery says so ("Gallery photo") — it never claims to be a live capture.
// Returns a Promise<Blob> (JPEG); rejects if the phone cannot encode it (low memory).
function drawWatermarkedSelfie(source, srcWidth, srcHeight, lat, lng, label) {
  return new Promise((resolve, reject) => {
    const canvas = document.createElement('canvas');
    const fit = Api.fitDimensions(srcWidth, srcHeight, SELFIE_MAX_DIM);
    canvas.width = fit.width;
    canvas.height = fit.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);

    const { name, address } = state.currentEntity;
    const lines = [
      name || 'Unknown location',
      address || '',
      label ? `${label} · uploaded ${formatWatermarkTimestamp(new Date())}` : formatWatermarkTimestamp(new Date()),
      `Lat: ${lat.toFixed(6)}, Lng: ${lng.toFixed(6)}`
    ].filter(Boolean);

    const fontSize = Math.max(14, Math.round(canvas.width * 0.032));
    const lineHeight = fontSize * 1.35;
    const padding = fontSize * 0.8;
    const barHeight = lines.length * lineHeight + padding * 2;
    ctx.fillStyle = 'rgba(0,0,0,0.62)';
    ctx.fillRect(0, canvas.height - barHeight, canvas.width, barHeight);
    ctx.fillStyle = '#ffffff';
    ctx.textBaseline = 'top';
    lines.forEach((line, i) => {
      ctx.font = i === 0 ? `bold ${fontSize}px -apple-system, Roboto, Arial, sans-serif` : `${fontSize * 0.85}px -apple-system, Roboto, Arial, sans-serif`;
      ctx.fillText(line, padding, canvas.height - barHeight + padding + i * lineHeight);
    });

    canvas.toBlob((blob) => {
      canvas.width = 0; canvas.height = 0;        // free the canvas straight away
      blob ? resolve(blob) : reject(new Error('encode_failed'));
    }, 'image/jpeg', 0.7);
  });
}

// The picture was taken / chosen: read the location, burn in the details, show the preview
async function acceptSelfie(shot) {
  const statusEl = document.getElementById('selfie-status');
  statusEl.style.color = 'var(--text-muted)';
  statusEl.textContent = '📍 Capturing your location…';
  const loc = await captureGeolocation();
  if (!loc) {
    releaseFrame(shot.frame);
    statusEl.style.color = 'var(--danger)';
    statusEl.textContent = "⚠ Couldn't get your location. Enable GPS/location permission and try again.";
    return;
  }
  statusEl.textContent = '🖼 Processing selfie…';
  try {
    const blob = await drawWatermarkedSelfie(shot.frame.source, shot.frame.width, shot.frame.height, loc.lat, loc.lng, shot.source === 'gallery' ? 'Gallery photo' : '');
    releaseFrame(shot.frame);
    pendingSelfie = { blob, previewUrl: URL.createObjectURL(blob), lat: loc.lat, lng: loc.lng, source: shot.source, uploadedUrl: null };
    renderSelfiePreview();
  } catch (err) {
    releaseFrame(shot.frame);
    statusEl.style.color = 'var(--danger)';
    statusEl.textContent = '⚠ ' + uploadProblem(err);
  }
}

const selfieButtonHtml = () => `<button type="button" class="action-btn ${selfieRequired() ? 'primary' : 'secondary'}" style="width:100%" onclick="startSelfie()">${selfieRequired() ? 'Take verification selfie' : 'Add a selfie (optional)'}</button>`;

function renderSelfiePreview() {
  const area = document.getElementById('selfie-capture-area');
  const statusEl = document.getElementById('selfie-status');
  const postBtn = document.getElementById('btn-post-comment');

  area.innerHTML = `
    <img src="${pendingSelfie.previewUrl}" style="width:100%;border-radius:10px;display:block">
    <button type="button" class="action-btn secondary" style="width:100%;margin-top:8px" onclick="retakeSelfie()">🔄 Retake</button>
  `;
  statusEl.style.color = 'var(--green)';
  statusEl.textContent = pendingSelfie.source === 'gallery'
    ? `🖼 Gallery photo (not a live capture) · location noted (${pendingSelfie.lat.toFixed(5)}, ${pendingSelfie.lng.toFixed(5)})`
    : `✅ Location verified (${pendingSelfie.lat.toFixed(5)}, ${pendingSelfie.lng.toFixed(5)})`;
  postBtn.disabled = false;
  postBtn.style.opacity = '1';
}

function retakeSelfie() {
  if (pendingSelfie && pendingSelfie.previewUrl) URL.revokeObjectURL(pendingSelfie.previewUrl);
  pendingSelfie = null;
  const area = document.getElementById('selfie-capture-area');
  area.innerHTML = selfieButtonHtml();
  document.getElementById('selfie-status').textContent = '';
  const postBtn = document.getElementById('btn-post-comment');
  postBtn.textContent = 'Post';
  postBtn.disabled = selfieRequired();            // a person whose selfie is switched off can post without one
  postBtn.style.opacity = selfieRequired() ? '0.4' : '1';
}

// ===== Seriousness rating (1-5 stars) =====
function starDisplay(rating) {
  if (!rating) return '';
  return '★'.repeat(rating) + '☆'.repeat(5 - rating);
}

// ===== Flag as invalid (MR can flag; only an admin can actually delete) =====
async function flagAsInvalid(type, id) {
  const reason = prompt('Why is this listing invalid or incorrect? (e.g. wrong address, doctor no longer practices here, duplicate entry)');
  if (reason === null) return; // cancelled
  try {
    type === 'doctor' ? await Api.flagDoctor(id, reason) : await Api.flagChemist(id, reason);
    showToast('Flagged — an admin will review this for removal');
    openDetail(type, id);
  } catch (err) {
    showToast(err.message === 'offline' ? "You're offline — couldn't flag." : (err.message || 'Could not flag'));
  }
}

// ===== Commission payments (separate ledger, with evidence upload) =====
async function loadCommissionPayments(doctorId) {
  const box = document.getElementById('commission-list');
  if (!box) return;
  try {
    const payments = await Api.getCommissionPayments(doctorId);
    feedState.payments = payments;   // the Comments history shows them too
    renderFeed();
    renderCommissionList(payments);
  } catch (err) {
    box.innerHTML = `<div style="font-size:12.5px;color:var(--text-muted)">Couldn't load payment history.</div>`;
  }
}

function renderCommissionList(payments) {
  const box = document.getElementById('commission-list');
  if (!box) return;
  if (!payments.length) {
    box.innerHTML = `<div style="font-size:12.5px;color:var(--text-muted);padding:6px 0">No commission payments logged yet.</div>`;
    return;
  }
  box.innerHTML = payments.map(p => `
    <div class="info-item full" style="margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid var(--border)">
      <div style="display:flex;justify-content:space-between">
        <div class="value">₹${Number(p.amount).toLocaleString('en-IN')}</div>
        <div class="label">${new Date(p.payment_date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}</div>
      </div>
      ${p.notes ? `<div style="font-size:12.5px;margin-top:3px">${repEsc(p.notes)}</div>` : ''}
      ${p.evidence_url ? `<a href="${repEsc(p.evidence_url)}" target="_blank" style="display:inline-block;margin-top:6px;font-size:12px;color:var(--purple);font-weight:700">${p.evidence_type === 'pdf' ? '📄 View evidence (PDF)' : '🖼 View evidence'}</a>` : ''}
      <div style="font-size:11px;color:var(--text-muted);margin-top:4px">Logged by ${repEsc(p.logged_by_name || 'Unknown')} · ${fmtStamp(p.created_at)}</div>
      ${canEditPayment(p) ? `<div style="margin-top:6px"><button type="button" class="link-btn" onclick="toggleCommissionForm(${p.id})">Edit</button> <button type="button" class="link-btn danger" onclick="deleteCommissionPayment(${p.id})">Delete</button></div>` : ''}
    </div>`).join('');
}

// ----- Log, edit and delete a commission payment (everyone logs; the Admin or the person who logged it edits / deletes). Evidence can be a photo taken now, a picture from the gallery, or a PDF. -----
let cpEvidence = null;   // { file, source: 'camera' | 'gallery' }
let cpEditing = null;    // { id, removeEvidence } while editing an existing payment
function onCpEvidence(event, source) {
  const file = event.target.files && event.target.files[0];
  event.target.value = '';
  const note = document.getElementById('cp-evidence-note');
  if (!file) return;
  if (file.type && !/^(image\/|application\/pdf)/i.test(file.type)) { note.style.color = 'var(--danger)'; note.textContent = 'Choose a photo or a PDF.'; return; }
  cpEvidence = { file, source };
  if (cpEditing) cpEditing.removeEvidence = false;
  note.style.color = 'var(--green)';
  note.innerHTML = `✅ ${source === 'camera' ? 'Photo' : 'File'} attached <button type="button" class="link-btn danger" onclick="clearCpEvidence()">Remove</button>`;
}
function clearCpEvidence() { cpEvidence = null; const n = document.getElementById('cp-evidence-note'); if (n) n.textContent = ''; }
function removeCpExisting() { if (cpEditing) cpEditing.removeEvidence = true; const n = document.getElementById('cp-existing'); if (n) n.textContent = 'The current evidence will be removed when you save.'; }

const canEditPayment = (p) => isAdminRole() || (!!Api.user && !!p && p.logged_by === Api.user.id);   // the Admin: any entry; everyone else: the ones they logged
function toggleCommissionForm(paymentId) {
  const box = document.getElementById('commission-form-box');
  if (!box) return;
  if (box.innerHTML && !paymentId) { box.innerHTML = ''; cpEvidence = null; cpEditing = null; return; }
  const existing = paymentId ? (feedState.payments || []).find(x => x.id === paymentId) : null;
  if (paymentId && (!existing || !canEditPayment(existing))) return;
  cpEvidence = null;
  cpEditing = existing ? { id: existing.id, removeEvidence: false } : null;
  const day = existing ? String(existing.payment_date).slice(0, 10) : istDate(0);
  box.innerHTML = `
    <div class="comment-composer" style="margin-top:10px">
      <div style="font-weight:800;margin-bottom:6px">${existing ? 'Edit payment' : 'Log a payment'}</div>
      <div class="form-row">
        <div class="form-field"><label>Amount (₹)</label><input type="number" id="cp-amount" min="0" step="any" inputmode="decimal" value="${existing ? repEsc(existing.amount) : ''}"></div>
        <div class="form-field"><label>Date</label><input type="date" id="cp-date" value="${day}"></div>
      </div>
      <div class="form-field">
        <label>Evidence (optional)</label>
        ${existing && existing.evidence_url ? `<div id="cp-existing" style="font-size:12.5px;margin-bottom:6px">Current evidence: <a href="${repEsc(existing.evidence_url)}" target="_blank" rel="noopener">view</a> <button type="button" class="link-btn danger" onclick="removeCpExisting()">Remove it</button></div>` : ''}
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button type="button" class="action-btn secondary" onclick="document.getElementById('cp-file-cam').click()">📷 Take photo</button>
          <button type="button" class="action-btn secondary" onclick="document.getElementById('cp-file-gal').click()">🖼 Choose from gallery</button>
        </div>
        <input type="file" id="cp-file-cam" accept="image/*" capture="environment" style="display:none" onchange="onCpEvidence(event, 'camera')">
        <input type="file" id="cp-file-gal" accept="image/*,application/pdf" style="display:none" onchange="onCpEvidence(event, 'gallery')">
        <div id="cp-evidence-note" style="font-size:12px;margin-top:6px"></div>
      </div>
      <div class="form-field"><label>Notes (optional)</label><textarea id="cp-notes">${existing ? repEsc(existing.notes || '') : ''}</textarea></div>
      <div class="composer-actions">
        <button class="btn-post" id="cp-submit-btn" onclick="submitCommissionPayment()">${existing ? 'Save changes' : 'Save Payment'}</button>
      </div>
    </div>`;
  box.scrollIntoView && box.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function submitCommissionPayment() {
  const { id } = state.currentEntity;
  const amount = document.getElementById('cp-amount').value;
  const payment_date = document.getElementById('cp-date').value;
  const notes = document.getElementById('cp-notes').value.trim();
  const btn = document.getElementById('cp-submit-btn');

  if (!amount || isNaN(Number(amount)) || Number(amount) < 0) return showToast('Enter a valid amount');
  if (!payment_date) return showToast('Pick a date');

  const label = cpEditing ? 'Save changes' : 'Save Payment';
  btn.textContent = cpEvidence ? 'Uploading…' : 'Saving…';
  btn.disabled = true;

  try {
    const body = { amount: Number(amount), payment_date, notes: notes || null };
    if (cpEvidence) {
      const result = await Api.uploadEvidence(cpEvidence.file);
      body.evidence_url = result.url; body.evidence_type = result.type;
    } else if (cpEditing && cpEditing.removeEvidence) {
      body.evidence_url = null; body.evidence_type = null;
    }
    if (cpEditing) await Api.updateCommissionPayment(id, cpEditing.id, body);
    else await Api.addCommissionPayment(id, body);
    const wasEditing = !!cpEditing;
    document.getElementById('commission-form-box').innerHTML = '';
    cpEvidence = null; cpEditing = null;
    loadCommissionPayments(id);
    showToast(wasEditing ? 'Payment updated' : 'Payment logged');
  } catch (err) {
    showToast(err.message === 'offline' ? "You're offline — couldn't save." : (err.message || 'Could not save payment'));
  } finally {
    btn.textContent = label;
    btn.disabled = false;
  }
}

async function deleteCommissionPayment(paymentId) {
  const own = (feedState.payments || []).find(x => x.id === paymentId);
  if (!canEditPayment(own)) return;
  if (!confirm('Delete this commission payment? This cannot be undone.')) return;
  try {
    await Api.deleteCommissionPayment(state.currentEntity.id, paymentId);
    showToast('Payment deleted');
    loadCommissionPayments(state.currentEntity.id);
  } catch (err) {
    showToast(err.message || 'Could not delete');
  }
}

// ===== Samples (generates a structured Instagram-style comment) =====
let pendingGiftFile = null;

// The sample form, then the full history of samples given to this doctor
function renderSamplesSection() {
  return `<div id="samples-area">${renderSamplesForm()}</div><div id="samples-history"></div>`;
}

// ----- my own sample stock: what the Admin issued to me, minus what I have given to doctors -----
let mySampleStock = null;   // { product_id: { balance, issued, given, ... } } — null when it could not be loaded
async function loadMySampleStock() {
  try { const rows = await Api.getMySampleStock(); mySampleStock = {}; rows.forEach(r => { mySampleStock[r.product_id] = r; }); }
  catch (e) { mySampleStock = null; }   // never blocks logging samples
  decorateSampleStock();
}
function decorateSampleStock() {
  if (!mySampleStock) return;
  document.querySelectorAll('.left-tag').forEach(tag => {
    const r = mySampleStock[tag.dataset.product];
    tag.textContent = r ? ` · ${r.balance} left` : '';
    tag.style.color = r && r.balance <= 0 ? '#C0392B' : 'var(--text-muted)';
    tag.style.fontWeight = r && r.balance <= 0 ? '700' : '400';
  });
}

function renderSamplesForm() {
  ensureProductsCache().then(products => {
    const box = document.getElementById('samples-area');
    if (!box) return;
    box.innerHTML = `
      <input type="text" id="samples-search" placeholder="Search products…" oninput="filterSamplesList(this.value)" style="width:100%;padding:9px 11px;border-radius:8px;border:1px solid var(--border);margin-bottom:8px">
      <div id="samples-product-list" style="max-height:220px;overflow-y:auto">
        ${products.filter(p => p.sample_available !== false).map(p => `
          <div class="sample-product-row" data-name="${p.name.toLowerCase()}">
            <label><input type="checkbox" class="sample-check" value="${p.id}" data-name="${p.name}"> ${p.name}<span class="left-tag" data-product="${p.id}" style="font-size:12px"></span></label>
            <input type="number" min="0" placeholder="Qty" class="sample-qty" data-product="${p.id}">
          </div>`).join('')}
      </div>
      <button class="btn-post" style="width:100%;margin-top:10px" onclick="submitSamples()">Log samples</button>
    `;
    loadMySampleStock();   // shows "· 40 left" beside each product the Admin has issued to me
  });
  return `<div class="loading-row" style="padding:10px 0">Loading products…</div>`;
}

function filterSamplesList(q) {
  q = q.toLowerCase();
  document.querySelectorAll('#samples-product-list .sample-product-row').forEach(row => {
    row.style.display = row.dataset.name.includes(q) ? 'flex' : 'none';
  });
}

async function submitSamples() {
  if (blockCall()) return;
  const rows = Array.from(document.querySelectorAll('.sample-check:checked'));
  if (!rows.length) return showToast('Select at least one product');

  const parts = [];
  const sampleLines = []; // sent as structured data too, so reports can filter/total by product
  for (const cb of rows) {
    const qtyInput = document.querySelector(`.sample-qty[data-product="${cb.value}"]`);
    const qty = qtyInput?.value;
    if (!qty || Number(qty) <= 0) return showToast(`Enter a quantity for ${cb.dataset.name}`);
    parts.push(`${cb.dataset.name} x${qty}`);
    sampleLines.push({ product_id: Number(cb.value), quantity: Number(qty) });
  }
  // the stock the Admin issued to me: a warning (never a block) when I am giving more than I have left
  const over = sampleLines.filter(l => mySampleStock && mySampleStock[l.product_id] && l.quantity > mySampleStock[l.product_id].balance);
  if (over.length) {
    const names = Object.fromEntries(rows.map(cb => [Number(cb.value), cb.dataset.name]));
    const msg = over.map(l => `${names[l.product_id]}: you have ${Math.max(mySampleStock[l.product_id].balance, 0)} left, you are giving ${l.quantity}`).join('\n');
    if (!confirm(`${msg}\n\nRecord it anyway?`)) return;
  }
  const commentText = `🎁 Samples given: ${parts.join(', ')}`;

  showToast('📍 Capturing your location…');
  const loc = await captureGeolocation();
  if (!loc) return showToast("Couldn't get your location — enable GPS and try again");

  const { type, id } = state.currentEntity;
  try {
    let photo_url = null, photo_source = null;
    if (selfieRequired()) {
      // a selfie already taken for THIS entry is kept if the upload failed, so a retry does not ask for it again
      if (!samplesShot || samplesShot.entity !== `${type}:${id}`) {
        const shot = await openSelfieSheet({ gallery: true });   // samples: the camera AND the gallery are both offered
        if (!shot) return showToast('Samples not saved — a verification selfie is required');
        showToast('Preparing selfie…');
        const blob = await drawWatermarkedSelfie(shot.frame.source, shot.frame.width, shot.frame.height, loc.lat, loc.lng, shot.source === 'gallery' ? 'Gallery photo' : '');
        releaseFrame(shot.frame);
        samplesShot = { entity: `${type}:${id}`, blob, source: shot.source, uploadedUrl: null };
      }
      if (!samplesShot.uploadedUrl) {
        showToast('Uploading verification selfie…');
        samplesShot.uploadedUrl = await Api.uploadPhoto(new File([samplesShot.blob], `selfie-${Date.now()}.jpg`, { type: 'image/jpeg' }), { skipCompress: true, timeoutMs: UPLOAD_TIMEOUT_MS });
      }
      photo_url = samplesShot.uploadedUrl; photo_source = samplesShot.source;
    }
    const savedVisit = await Api.addVisit({ entity_type: type, entity_id: id, comment_text: commentText, photo_url, photo_source, lat: loc.lat, lng: loc.lng, category: 'samples', samples: sampleLines });
    samplesShot = null;
    showToast('Samples logged' + locationNote(savedVisit, state.currentLabel));
    loadHomeCards();
    loadFeed(type, id);
    loadMySampleStock();   // my balance has gone down by what I just gave
    document.querySelectorAll('.sample-check:checked').forEach(c => c.checked = false);
    document.querySelectorAll('.sample-qty').forEach(i => i.value = '');
  } catch (err) {
    if (isNetworkError(err)) {
      // no signal: keep the samples entry (with its selfie) on the phone; it uploads by itself later. The stock goes down when it uploads.
      await saveCallOffline({ label: state.currentLabel || '', blob: samplesShot && !samplesShot.uploadedUrl ? samplesShot.blob : null,
        payload: { entity_type: type, entity_id: id, comment_text: commentText, photo_url: samplesShot ? samplesShot.uploadedUrl || null : null, photo_source: samplesShot ? samplesShot.source : null, lat: loc.lat, lng: loc.lng, category: 'samples', samples: sampleLines } });
      samplesShot = null;
      document.querySelectorAll('.sample-check:checked').forEach(c => c.checked = false);
      document.querySelectorAll('.sample-qty').forEach(i => i.value = '');
      return;
    }
    showToast(uploadProblem(err) + (samplesShot ? ' Press Save again to retry.' : ''));
  }
}

// ===== Call rules: a mobile number is needed (and RX doctors need a linked chemist) before a comment / samples / gift =====
function callBlocker() {
  const ce = state.currentEntity, e = ce && ce.rec;
  if (!e || isAdminRole()) return null;
  if (!String(e.mobile_number || '').trim()) return { code: 'mobile', text: `Add this ${ce.type}'s mobile number first (Edit), then add your comment.` };
  if (ce.type === 'doctor' && e.rx_status === 'RX' && !((state.linked && state.linked.chemist) || []).length) return { code: 'chemist', text: 'This is an RX doctor: link a chemist first, then add your comment. No chemist? Use “Doctor Billing Chemist”.' };
  return null;
}
function blockCall() { const b = callBlocker(); if (!b) return false; showToast(b.text); return true; }
function callBlockerHtml(b) {
  const { type, id } = state.currentEntity;
  return `<div class="call-block"><b>⚠ Complete this record first</b><div>${repEsc(b.text)}</div>
    ${b.code === 'mobile'
      ? `<button type="button" class="action-btn primary" onclick="openEdit('${type}', ${id})">✏️ Add mobile number</button>`
      : `<button type="button" class="action-btn primary" onclick="useBillingChemist()">Use “Doctor Billing Chemist”</button>
         <button type="button" class="action-btn secondary" onclick="goLinkChemist()">Link a chemist</button>`}
  </div>`;
}
function goLinkChemist() {
  const body = document.getElementById('acc-linked');
  if (body && !body.classList.contains('open')) toggleAccordion('acc-linked');
  const box = document.getElementById('link-form-box');
  if (box && !box.innerHTML) toggleLinkForm();
  if (body && body.scrollIntoView) body.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
async function useBillingChemist() {
  const { id } = state.currentEntity;
  try {
    const list = await Api.getChemists({ q: 'Doctor Billing Chemist', include_dummy: 1, limit: 5 });
    const d = (list || []).find(c => c.is_dummy);
    if (!d) return showToast('“Doctor Billing Chemist” is not set up yet — ask the admin to run the database upgrade.');
    await Api.linkDoctorChemist({ doctor_id: id, chemist_id: d.id });
    showToast('Linked to Doctor Billing Chemist');
    await refreshLinked();
  } catch (err) { showToast(err.message === 'offline' ? "You're offline — couldn't link." : (err.message || 'Could not link')); }
}

// ===== Comments composer (visit note + verification selfie) =====
function renderCommentComposerBody() {
  const box = document.getElementById('comment-composer-body');
  if (!box) return;
  const blocked = callBlocker();
  if (blocked) { box.innerHTML = callBlockerHtml(blocked); pendingSelfie = null; return; }
  const needed = selfieRequired();
  const _ce = state.currentEntity, canMgr = !!(_ce && _ce.type === 'doctor' && _ce.rec && _ce.rec.rx_status === 'RX');   // manager calls are for RX doctors only
  if (!canMgr) callKind = 'visit';
  box.innerHTML = `
    <div class="call-kind" id="call-kind" role="tablist" style="display:${canMgr ? 'flex' : 'none'}">
      <button type="button" class="ck${callKind === 'visit' ? ' active' : ''}" data-k="visit" onclick="setCallKind('visit')">Visit</button>
      <button type="button" class="ck${callKind === 'manager' ? ' active' : ''}" data-k="manager" onclick="setCallKind('manager')">🧑‍💼 Manager call</button>
    </div>
    <div id="mgr-pick" class="mgr-pick" style="display:${callKind === 'manager' ? 'block' : 'none'}"><label class="field-label" for="mgr-select">Manager with you</label><select id="mgr-select"><option value="">Loading…</option></select></div>
    <div id="selfie-capture-area">${selfieButtonHtml()}</div>
    <div id="selfie-status" style="font-size:12px;margin-top:6px"></div>
    <label class="field-label" for="comment-input">Comment</label>
    <textarea id="comment-input"></textarea>
    <div class="composer-actions">
      <button class="btn-post" id="btn-post-comment" onclick="postComment()" ${needed ? 'disabled style="opacity:0.4"' : ''}>${callKind === 'manager' ? 'Post manager call' : 'Post'}</button>
    </div>
  `;
  pendingSelfie = null;
  if (callKind === 'manager') fillManagerSelect();
}

// ----- Manager call: the same call as a normal visit, made together with a manager. It counts as a visit and feeds the manager-coverage numbers. -----
let callKind = 'visit', teamCache = null;
async function loadTeam() {
  if (teamCache) return teamCache;
  try { teamCache = await Api.getTeam(); } catch (e) { return { managers: [], mrs: [], everyone: [], me: Api.user ? Api.user.id : null }; }   // not cached: tried again next time
  return teamCache;
}
async function fillManagerSelect() {
  const sel = document.getElementById('mgr-select');
  if (!sel) return;
  const t = await loadTeam();
  const keep = sel.value;
  sel.innerHTML = (t.managers.length > 1 ? '<option value="">Choose the manager…</option>' : '') + t.managers.map(m => `<option value="${m.id}">${repEsc(m.full_name)}</option>`).join('');
  if (keep) sel.value = keep;
}
function setCallKind(k) {
  callKind = k === 'manager' ? 'manager' : 'visit';
  document.querySelectorAll('#call-kind .ck').forEach(b => b.classList.toggle('active', b.dataset.k === callKind));
  const pick = document.getElementById('mgr-pick'); if (pick) pick.style.display = callKind === 'manager' ? 'block' : 'none';
  const btn = document.getElementById('btn-post-comment'); if (btn && !btn.disabled) btn.textContent = callKind === 'manager' ? 'Post manager call' : 'Post';
  else if (btn) btn.textContent = callKind === 'manager' ? 'Post manager call' : 'Post';
  if (callKind === 'manager') fillManagerSelect();
}
function managerFields() {
  if (callKind !== 'manager') return {};
  const sel = document.getElementById('mgr-select');
  return { is_manager_call: true, manager_id: sel && sel.value ? Number(sel.value) : null };
}


// ===== Gifts: a short note + a photo (taken now, or picked from the gallery) =====
function renderGiftsSection(e) {
  return `
    ${e.gifting_details ? `<p class="notes-text" style="margin-bottom:10px"><b>Gifting notes:</b> ${repEsc(e.gifting_details)}</p>` : ''}
    <div class="comment-composer">
      <label class="field-label" for="gift-text">Gift details</label>
      <textarea id="gift-text"></textarea>
      <input type="file" accept="image/*" capture="environment" id="gift-cam" style="display:none" onchange="onGiftFileSelected(event)">
      <input type="file" accept="image/*" id="gift-gallery" style="display:none" onchange="onGiftFileSelected(event)">
      <div style="display:flex;gap:8px;margin:8px 0">
        <button type="button" class="action-btn secondary" style="flex:1" onclick="startGiftPhoto('gift-cam')">Take photo</button>
        <button type="button" class="action-btn secondary" style="flex:1" onclick="startGiftPhoto('gift-gallery')">From gallery</button>
      </div>
      <div id="gift-preview"></div>
      <div class="composer-actions">
        <button class="btn-post" id="btn-post-gift" onclick="postGift()" disabled style="opacity:0.4">Post gift</button>
      </div>
    </div>
    <div id="gift-list"><div class="loading-row">Loading…</div></div>`;
}

function setGiftPostEnabled(on) {
  const btn = document.getElementById('btn-post-gift');
  if (btn) { btn.disabled = !on; btn.style.opacity = on ? '1' : '0.4'; }
}

function onGiftFileSelected(event) {
  clearResume();
  const file = event.target.files[0];
  event.target.value = ''; // lets the same photo be picked again
  if (!file) return;
  pendingGiftFile = file;
  document.getElementById('gift-preview').innerHTML = `
    <img src="${URL.createObjectURL(file)}" alt="Gift photo" style="width:100%;max-height:220px;object-fit:cover;border-radius:10px;display:block">
    <button type="button" class="action-btn secondary" style="width:100%;margin-top:6px" onclick="clearGiftPhoto()">Remove photo</button>`;
  setGiftPostEnabled(true);
}

function clearGiftPhoto() {
  pendingGiftFile = null;
  const prev = document.getElementById('gift-preview');
  if (prev) prev.innerHTML = '';
  setGiftPostEnabled(false);
}

async function postGift() {
  if (blockCall()) return;
  if (!pendingGiftFile) return showToast('Please add a gift photo first');
  const { type, id } = state.currentEntity;
  const text = document.getElementById('gift-text').value.trim();
  const btn = document.getElementById('btn-post-gift');
  btn.textContent = 'Saving…'; btn.disabled = true;
  try {
    const photo_url = await Api.uploadPhoto(pendingGiftFile); // shrunk before upload
    await Api.addVisit({ entity_type: type, entity_id: id, comment_text: text || 'Gift given', photo_url, category: 'gift' });
    loadHomeCards();
    document.getElementById('gift-text').value = '';
    clearGiftPhoto();
    showToast('Gift saved');
    loadFeed(type, id);
  } catch (err) {
    if (isNetworkError(err)) {
      // no signal: the gift photo is kept on the phone and uploaded later
      let blob = pendingGiftFile;
      try { blob = await Api.compressImage(pendingGiftFile); } catch (e) { /* keep the original photo */ }
      await saveCallOffline({ label: state.currentLabel || '', blob, payload: { entity_type: type, entity_id: id, comment_text: text || 'Gift given', category: 'gift' } });
      document.getElementById('gift-text').value = '';
      clearGiftPhoto();
    } else {
      showToast(err.message || 'Could not save the gift');
      setGiftPostEnabled(true);
    }
  } finally {
    btn.textContent = 'Post gift';
  }
}

// ----- the call-location notice: a call saved far from the doctor's / chemist's saved location is still saved, but the MR is told -----
const fmtDist = (m) => (m == null ? '' : m < 1000 ? `${m} m` : `${(m / 1000).toFixed(1)} km`);
const locationNote = (saved, name) => (saved && saved.location_status === 'far' ? ` — note: you were about ${fmtDist(saved.distance_m)} from the saved location${name ? ' of ' + name : ''}` : '');

// ----- offline: a call saved on the phone while there is no signal -----
const isNetworkError = (err) => !!err && (err.message === 'offline' || err.message === 'timeout');
async function saveCallOffline({ payload, blob, label }) {
  await Api.queueVisit({ payload, blob, label });
  const n = await Api.outboxCount();
  showToast(`Saved on this phone — it uploads by itself when you are online (${n} waiting)`);
  updateOutboxBar();
}

let postInFlight = false;
async function postComment() {
  if (blockCall()) return;
  const needed = selfieRequired();
  if (!pendingSelfie && needed) {
    showToast('Please take a verification selfie first');
    return;
  }
  if (callKind === 'manager') {
    const t = await loadTeam(), sel = document.getElementById('mgr-select');
    if (t.managers.length && (!sel || !sel.value)) return showToast('Choose which manager made this call with you');
  }
  if (postInFlight) return;                       // a double tap never sends it twice
  postInFlight = true;

  const input = document.getElementById('comment-input');
  const text = input.value.trim();
  const { type, id } = state.currentEntity;
  const btn = document.getElementById('btn-post-comment');
  const statusEl = document.getElementById('selfie-status');
  btn.textContent = 'Uploading…';
  btn.disabled = true;

  let lat, lng, photo_url = null, photo_source = null;
  try {
    if (pendingSelfie) {
      ({ lat, lng } = pendingSelfie);
      if (!pendingSelfie.uploadedUrl) {            // uploaded once: a retry reuses it (and the server ignores a repeat)
        const selfieFile = new File([pendingSelfie.blob], `selfie-${Date.now()}.jpg`, { type: 'image/jpeg' });
        pendingSelfie.uploadedUrl = await Api.uploadPhoto(selfieFile, { skipCompress: true, timeoutMs: UPLOAD_TIMEOUT_MS });
      }
      photo_url = pendingSelfie.uploadedUrl;
      photo_source = pendingSelfie.source;
    } else {                                       // selfie switched off for this person: the location is still needed
      const loc = await captureGeolocation();
      if (!loc) throw new Error('location');
      ({ lat, lng } = loc);
    }
    btn.textContent = 'Saving…';
    const saved = await Api.addVisit({ entity_type: type, entity_id: id, comment_text: text || null, photo_url, photo_source, lat, lng, category: 'visit', ...managerFields() });
    input.value = '';
    if (pendingSelfie) URL.revokeObjectURL(pendingSelfie.previewUrl);
    pendingSelfie = null;
    retakeSelfie();
    loadFeed(type, id);
    loadHomeCards();     // today's plan moves on
    showToast((callKind === 'manager' ? 'Manager call logged — ' : 'Visit logged — ') + (photo_url ? 'location & selfie verified' : 'location verified') + locationNote(saved, state.currentLabel));
  } catch (err) {
    if (isNetworkError(err) && lat != null && lng != null && (pendingSelfie || !selfieRequired())) {
      // no signal: keep the call (with its selfie) on the phone; it uploads by itself later
      await saveCallOffline({ label: state.currentLabel || '', blob: pendingSelfie && !pendingSelfie.uploadedUrl ? pendingSelfie.blob : null,
        payload: { entity_type: type, entity_id: id, comment_text: text || null, photo_url: pendingSelfie ? pendingSelfie.uploadedUrl || null : null, photo_source: pendingSelfie ? pendingSelfie.source : photo_source, lat, lng, category: 'visit', ...managerFields() } });
      input.value = '';
      if (pendingSelfie) URL.revokeObjectURL(pendingSelfie.previewUrl);
      pendingSelfie = null;
      retakeSelfie();
      btn.textContent = 'Post'; btn.disabled = false;
      return;
    }
    const msg = uploadProblem(err);
    showToast(msg);
    if (statusEl) { statusEl.style.color = 'var(--danger)'; statusEl.textContent = '⚠ ' + msg; }
    btn.textContent = 'Retry';                     // the selfie is kept: nothing to take again
    btn.disabled = false;
  } finally {
    postInFlight = false;
  }
}

// ===== MR Day: which weekdays (Mon–Sat) and hours this doctor takes MR calls =====
// No schedule saved = the default: all six days, any time.
const MR_DAYS = [['mon', 'Mon', 'Monday'], ['tue', 'Tue', 'Tuesday'], ['wed', 'Wed', 'Wednesday'], ['thu', 'Thu', 'Thursday'], ['fri', 'Fri', 'Friday'], ['sat', 'Sat', 'Saturday']];

function normalizeMrDays(md) {
  const out = {};
  MR_DAYS.forEach(([k]) => {
    const d = md && md[k];
    out[k] = d ? { available: d.available !== false, from: d.from || null, to: d.to || null } : { available: true, from: null, to: null };
  });
  return out;
}

function mrDaySummary(md) {
  const days = normalizeMrDays(md), groups = new Map(), off = [];
  MR_DAYS.forEach(([k, short], i) => {
    const d = days[k];
    if (!d.available) { off.push(short); return; }
    const label = d.from && d.to ? `${d.from}–${d.to}` : 'any time';
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(i);
  });
  if (!groups.size) return 'Not available on any day';
  const range = (idx) => {            // [0,1,2,3,4,5] -> "Mon–Sat", [0,2] -> "Mon, Wed"
    const parts = []; let i = 0;
    while (i < idx.length) {
      let j = i;
      while (j + 1 < idx.length && idx[j + 1] === idx[j] + 1) j++;
      parts.push(j - i >= 2 ? `${MR_DAYS[idx[i]][1]}–${MR_DAYS[idx[j]][1]}` : idx.slice(i, j + 1).map(x => MR_DAYS[x][1]).join(', '));
      i = j + 1;
    }
    return parts.join(', ');
  };
  const text = [...groups.entries()].map(([label, idx]) => `${range(idx)} · ${label}`).join('  |  ');
  return off.length ? `${text}  (not ${off.join(', ')})` : text;
}

function renderMrDaySection(e) {
  const days = normalizeMrDays(e.mr_days);
  return `
    <div class="mrday-summary" id="mrday-summary">${repEsc(mrDaySummary(e.mr_days))}</div>
    <div class="mrday-grid">
      ${MR_DAYS.map(([k, , full]) => {
        const d = days[k], anyTime = !(d.from && d.to), timesOff = !d.available || anyTime;
        return `
        <div class="mrday-row">
          <label class="mrday-day"><input type="checkbox" id="mrd-${k}-on" ${d.available ? 'checked' : ''} onchange="mrDayToggle('${k}')"> ${full}</label>
          <div class="mrday-times">
            <label class="mrday-any"><input type="checkbox" id="mrd-${k}-any" ${anyTime ? 'checked' : ''} ${d.available ? '' : 'disabled'} onchange="mrDayToggle('${k}')"> Any time</label>
            <input type="time" id="mrd-${k}-from" value="${d.from || ''}" ${timesOff ? 'disabled' : ''}>
            <span>to</span>
            <input type="time" id="mrd-${k}-to" value="${d.to || ''}" ${timesOff ? 'disabled' : ''}>
          </div>
        </div>`;
      }).join('')}
    </div>
    <div style="display:flex;gap:8px;margin-top:10px">
      <button type="button" class="btn-post" id="mrd-save" onclick="saveMrDays()">Save</button>
      <button type="button" class="action-btn secondary" onclick="resetMrDays()">Reset to all days</button>
    </div>`;
}

function mrDayToggle(k) {
  const on = document.getElementById(`mrd-${k}-on`).checked;
  const any = document.getElementById(`mrd-${k}-any`), from = document.getElementById(`mrd-${k}-from`), to = document.getElementById(`mrd-${k}-to`);
  any.disabled = !on;
  const timesOff = !on || any.checked;
  from.disabled = timesOff; to.disabled = timesOff;
  if (on && !any.checked && !from.value && !to.value) { from.value = '10:00'; to.value = '13:00'; } // a sensible starting range
}

function readMrDays() {
  const out = {};
  MR_DAYS.forEach(([k]) => {
    const available = document.getElementById(`mrd-${k}-on`).checked;
    const any = document.getElementById(`mrd-${k}-any`).checked;
    out[k] = available && !any
      ? { available: true, from: document.getElementById(`mrd-${k}-from`).value || null, to: document.getElementById(`mrd-${k}-to`).value || null }
      : { available, from: null, to: null };
  });
  return out;
}

async function saveMrDays() {
  const days = readMrDays();
  for (const [k, , full] of MR_DAYS) {
    const d = days[k];
    if (d.available && (d.from || d.to)) {
      if (!d.from || !d.to) return showToast(`${full}: set both a start and an end time`);
      if (d.from >= d.to) return showToast(`${full}: the start time must be before the end time`);
    }
  }
  const allDefault = MR_DAYS.every(([k]) => days[k].available && !days[k].from);
  const btn = document.getElementById('mrd-save');
  btn.disabled = true;
  try {
    const saved = await Api.updateDoctor(state.currentEntity.id, { mr_days: allDefault ? null : days });
    document.getElementById('mrday-summary').textContent = mrDaySummary(saved.mr_days);
    showToast('MR Day saved');
  } catch (err) {
    showToast(err.message === 'offline' ? "You're offline — couldn't save." : (err.message || 'Could not save'));
  } finally { btn.disabled = false; }
}

async function resetMrDays() {
  try {
    const saved = await Api.updateDoctor(state.currentEntity.id, { mr_days: null });
    const body = document.getElementById('acc-mrday');
    if (body) body.innerHTML = renderMrDaySection(saved);
    showToast('Reset to all days');
  } catch (err) { showToast(err.message || 'Could not reset'); }
}

// ===== Products this doctor prescribes =====
// Any MR ticks products and enters how many a month the doctor prescribes; only an admin edits or removes.
function renderDoctorProductsSection(e) {
  return `
    <div id="dp-list">${renderDoctorProductsList(e.prescribed_products || [])}</div>
    <button class="action-btn secondary" style="margin-top:8px;width:100%" onclick="toggleDoctorProductForm()">+ Add products</button>
    <div id="dp-form-box"></div>`;
}

function renderDoctorProductsList(list) {
  state.doctorProducts = list;
  if (!list.length) return `<div class="empty-note">No products added yet.</div>`;
  const admin = isAdminRole();
  return list.map(p => `
    <div class="info-item full" style="margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid var(--border)">
      <div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start">
        <div>
          <div class="value">${repEsc(p.name)}${p.quantity ? ` <span style="font-weight:600;color:var(--purple)">· ${Number(p.quantity).toLocaleString('en-IN')} a month</span>` : ''}</div>
          ${p.range ? `<div style="font-size:11px;color:var(--text-muted)">${repEsc(p.range)}</div>` : ''}
        </div>
        ${admin ? `<div style="white-space:nowrap"><button type="button" class="link-btn" onclick="editDoctorProduct(${p.id})">Edit</button><button type="button" class="link-btn danger" onclick="removeDoctorProduct(${p.id})">Remove</button></div>` : ''}
      </div>
      ${p.notes ? `<div style="font-size:12.5px;margin-top:3px">${repEsc(p.notes)}</div>` : ''}
      <div style="font-size:11px;color:var(--text-muted);margin-top:3px">Added by ${repEsc(p.added_by_name || '—')}${p.added_at ? ' · ' + fmtDayYear(p.added_at) : ''}</div>
    </div>`).join('');
}

async function refreshDoctorProducts() {
  const doc = await Api.getDoctor(state.currentEntity.id);
  const box = document.getElementById('dp-list');
  if (box) box.innerHTML = renderDoctorProductsList(doc.prescribed_products || []);
}

async function toggleDoctorProductForm() {
  const box = document.getElementById('dp-form-box');
  if (box.innerHTML) { box.innerHTML = ''; return; }
  box.innerHTML = `<div class="loading-row">Loading…</div>`;
  try {
    const products = await ensureProductsCache();
    const have = new Set((state.doctorProducts || []).map(p => p.product_id));
    const options = products.filter(p => !have.has(p.id)); // what the doctor already prescribes is not offered again
    box.innerHTML = options.length ? `
      <div class="comment-composer" style="margin-top:10px">
        ${productPickerHtml('dpp', options)}
        <div class="composer-actions"><button class="btn-post" id="dp-save" onclick="submitDoctorProduct()">Add selected</button></div>
      </div>` : `<div class="empty-note">Every product is already in this list.</div>`;
  } catch (err) {
    box.innerHTML = `<div class="empty-note">Couldn't load products.</div>`;
  }
}

async function submitDoctorProduct() {
  const read = pcRead('dpp', { qtyRequired: false });
  if (read.error) return showToast(read.error);
  const btn = document.getElementById('dp-save');
  btn.disabled = true; btn.textContent = 'Adding…';
  try {
    const res = await Api.addDoctorProducts(state.currentEntity.id, read.items);
    const n = res.added.length;
    showToast(`${n} product${n === 1 ? '' : 's'} added${res.skipped.length ? ` (${res.skipped.length} already there)` : ''}`);
    document.getElementById('dp-form-box').innerHTML = '';
    await refreshDoctorProducts();
  } catch (err) {
    showToast(err.message === 'offline' ? "You're offline — couldn't save." : (err.message || 'Could not add the products'));
    btn.disabled = false; btn.textContent = 'Add selected';
  }
}

async function editDoctorProduct(linkId) {
  const p = (state.doctorProducts || []).find(x => x.id === linkId);
  if (!p) return;
  const qty = prompt(`How many a month? (${p.name})`, p.quantity || '');
  if (qty === null) return;
  const note = prompt(`Note for ${p.name}`, p.notes || '');
  if (note === null) return;
  try { await Api.updateDoctorProduct(state.currentEntity.id, linkId, { quantity: qty.trim() === '' ? null : qty.trim(), notes: note }); await refreshDoctorProducts(); showToast('Saved'); }
  catch (err) { showToast(err.message || 'Could not save'); }
}

async function removeDoctorProduct(linkId) {
  const p = (state.doctorProducts || []).find(x => x.id === linkId);
  if (!p || !confirm(`Remove ${p.name} from this doctor's products?`)) return;
  try { await Api.removeDoctorProduct(state.currentEntity.id, linkId); await refreshDoctorProducts(); showToast('Removed'); }
  catch (err) { showToast(err.message || 'Could not remove'); }
}

// ===== Add / Edit form =====
function openAdd() {
  openEdit(state.activeTab, null);
}

// ===== The Wall (page 1 of the Home): the message, scheduled calls, reminders, birthdays =====
let wall = { range: 'today', scope: null, mrId: '', data: null, error: null };
let homePage = 0;
const wallStaff = () => !!Api.user && ['admin', 'super'].includes(Api.user.role);
const wallDay = (ymd) => {
  if (!ymd) return '';
  const t = istDate(0), tm = istDate(1);
  if (ymd === t) return 'today'; if (ymd === tm) return 'tomorrow';
  return new Date(ymd + 'T12:00:00Z').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
};
// An MR starts on "My Agenda"; the Admin and Super Users start on the whole team. The choice is remembered for the session.
function wallScope() {
  if (!wall.scope) { let s = null; try { const st = navStore(); s = st ? st.getItem('zv_wall_scope') : null; } catch (e) { s = null; } wall.scope = s === 'mine' || s === 'team' ? s : (wallStaff() ? 'team' : 'mine'); }
  return wall.scope;
}
async function loadWall() {
  const root = document.getElementById('wall-root');
  if (!root || !Api.isLoggedIn()) return;
  const scope = wallScope();
  try {
    const data = await Api.getWall(wall.range, { scope, mr_id: scope === 'team' ? wall.mrId : '' });
    if (!data || !Array.isArray(data.calls) || !data.reminders || !Array.isArray(data.occasions)) throw new Error("Couldn't load");
    wall.data = data; wall.error = null;
  } catch (e) { wall.error = e.message === 'offline' ? "You're offline" : (e.message || "Couldn't load"); }
  try { renderWall(); } catch (e) { /* the Wall must never break the Home page */ }
}
const WALL_RANGES = [['today', 'Today'], ['two', 'Today & Tomorrow'], ['week', 'This Week'], ['month', 'This Month']];
function setWallRange(r) { wall.range = WALL_RANGES.some(x => x[0] === r) ? r : 'today'; loadWall(); }
function setWallScope(sc) { wall.scope = sc === 'team' ? 'team' : 'mine'; if (wall.scope === 'mine') wall.mrId = ''; try { const st = navStore(); if (st) st.setItem('zv_wall_scope', wall.scope); } catch (e) { /* session only */ } loadWall(); }
function setWallMr(id) { wall.mrId = id || ''; loadWall(); }
const wallWho = (name) => (name ? `<span class="wall-who">👤 ${repEsc(name)}</span>` : '');
const wallAssign = (kind, id) => `<button type="button" class="link-btn" onclick="openAssignSheet('${kind}', ${Number(id)})">Assign</button>`;
function renderWall() {
  const root = document.getElementById('wall-root');
  if (!root) return;
  const d = wall.data;
  if (!d) { root.innerHTML = `<div class="wall"><div class="wall-empty">${repEsc(wall.error || 'Loading…')} <button type="button" class="link-btn" onclick="loadWall()">Try again</button></div></div>`; return; }
  const scope = d.scope || wallScope(), team = scope === 'team', isAdmin = !!Api.user && Api.user.role === 'admin', me = Api.user ? Api.user.id : null;
  const multi = d.dates.length > 1;
  const msg = d.message ? `<div class="wall-msg">💬 ${repEsc(d.message.message)}</div>` : '';
  const bday = d.self_birthday_today ? `<div class="wall-msg">🎉 Happy birthday, ${repEsc((Api.user && Api.user.full_name || '').split(' ')[0])}!</div>` : '';
  const callRows = d.calls.map(g => g.doctors.length ? `${multi ? `<div class="wall-day">${repEsc(wallDay(g.date))}</div>` : ''}${g.doctors.map(x => `<div class="wall-row${x.done ? ' done' : ''}"><div class="wr-main" onclick="openDetail('doctor', ${x.id})"><div class="wr-t">${x.done ? '✅ ' : ''}${repEsc(x.name)} — ${repEsc(x.city || x.locality || '')}</div><div class="wr-s">MR call day ${repEsc(wallDay(g.date))}${x.from ? ` · ${repEsc(x.from)}–${repEsc(x.to)}` : ''}${x.locality && x.city ? ' · ' + repEsc(x.locality) : ''}${team ? ' · ' + wallWho(x.owner_name) : ''}</div></div>${team && isAdmin ? wallAssign('doctor', x.id) : ''}</div>`).join('')}` : '').join('');
  const remRow = (r, late) => {
    const mine = r.mr_id === undefined || r.mr_id === me;                          // a reminder is ticked / edited by the MR who holds it (and by the Admin)
    return `<div class="wall-row">${mine || isAdmin ? `<button type="button" class="wr-chk" onclick="completeWallReminder(${r.id})" title="Mark completed">✓</button>` : ''}
      <div class="wr-main"${mine || isAdmin ? ` onclick="editWallReminder(${r.id})"` : ''}><div class="wr-t">${repEsc(r.purpose)}</div><div class="wr-s${late ? ' late' : ''}">${repEsc(r.name)} · ${repEsc(r.time)} · ${late ? 'overdue since ' : ''}${repEsc(wallDay(r.date))}${team ? ' · ' + wallWho(r.mr_name) : ''}</div></div>${team && isAdmin ? wallAssign('reminder', r.id) : ''}</div>`;
  };
  const taskRow = (t) => {
    const mine = t.mr_id === me, done = t.status === 'done';                       // an MR ticks his own tasks; the Admin can tick anybody's
    return `<div class="wall-row${done ? ' done' : ''}">${mine || isAdmin ? `<button type="button" class="wr-chk${done ? ' on' : ''}" onclick="setWallTask(${t.id}, '${done ? 'open' : 'done'}')" title="${done ? 'Mark as not done' : 'Mark completed'}">${done ? '↺' : '✓'}</button>` : ''}
      <div class="wr-main"><div class="wr-t">${repEsc(t.title)}</div><div class="wr-s">${done ? 'Completed ' + repEsc(fmtStamp(t.completed_at)) : 'Given ' + repEsc(fmtStamp(t.created_at))}${team ? ' · ' + wallWho(t.mr_name) : ''}</div></div></div>`;
  };
  const taskList = d.tasks || [], taskHtml = taskList.map(taskRow).join('');
  const rem = d.reminders.overdue.map(r => remRow(r, true)).join('') + d.reminders.items.map(r => remRow(r, false)).join('');
  const occ = (list) => list.map(o => {
    const icon = o.kind === 'birthday' ? '🎂' : '💍', who = o.who === 'team' ? `${repEsc(o.name)} <span style="color:var(--text-muted);font-weight:400">(team)</span>` : repEsc(o.name);
    const digits = String(o.mobile_number || '').replace(/\D/g, '').slice(-10);
    const reach = o.who === 'doctor' && digits.length === 10 ? ` <a href="tel:+91${digits}" style="text-decoration:none">📞</a> <a href="https://wa.me/91${digits}" target="_blank" rel="noopener" style="text-decoration:none">💬</a>` : '';
    return `<div class="wall-row"><div class="wr-main"${o.who === 'doctor' ? ` onclick="openDetail('doctor', ${o.id})"` : ''}><div class="wr-t" style="font-weight:600;font-size:13.5px">${icon} ${who} — ${o.kind} ${repEsc(wallDay(o.date))}${reach}${team && o.who === 'doctor' ? ' ' + wallWho(o.owner_name) : ''}</div></div>${team && isAdmin && o.who === 'doctor' ? wallAssign('doctor', o.id) : ''}</div>`;
  }).join('');
  const todayOcc = d.occasions.filter(o => o.days_until === 0), laterOcc = d.occasions.filter(o => o.days_until > 0);
  const occHtml = multi ? occ(d.occasions) : `${occ(todayOcc)}${laterOcc.length ? `<div class="wall-day">Later this week</div>${occ(laterOcc)}` : ''}`;
  const empty = !callRows && !rem && !taskHtml && !d.occasions.length;
  const rangeLabel = (WALL_RANGES.find(x => x[0] === d.range) || WALL_RANGES[0])[1].toLowerCase();
  const filter = team && (d.team || []).length ? `<select class="wall-team" onchange="setWallMr(this.value)" aria-label="Team member"><option value="">All team members</option>${d.team.map(u => `<option value="${u.id}"${String(d.mr_id) === String(u.id) ? ' selected' : ''}>${repEsc(u.full_name)}</option>`).join('')}</select>` : '';
  root.innerHTML = `<div class="wall">${msg}${bday}
    <div class="wall-range wall-scope"><button type="button" class="${team ? '' : 'on'}" onclick="setWallScope('mine')">My Agenda</button><button type="button" class="${team ? 'on' : ''}" onclick="setWallScope('team')">Team Agenda</button>${filter}</div>
    <div class="wall-range">${WALL_RANGES.map(([k, label]) => `<button type="button" class="${d.range === k ? 'on' : ''}" onclick="setWallRange('${k}')">${repEsc(label)}</button>`).join('')}</div>
    ${wall.error ? `<div class="wall-empty">${repEsc(wall.error)} — showing what was loaded earlier</div>` : ''}
    ${taskHtml ? `<h4>📝 To-do <span class="wall-count">${taskList.filter(t => t.status === 'open').length} open</span></h4>${taskHtml}` : ''}
    ${callRows ? `<h4>📅 Scheduled calls</h4>${callRows}` : ''}
    ${rem ? `<h4>⏰ Reminders</h4>${rem}` : ''}
    ${occHtml ? `<h4>🎂 Birthdays &amp; anniversaries</h4>${occHtml}` : ''}
    ${empty ? `<div class="wall-empty">Nothing scheduled ${d.range === 'today' ? 'today' : rangeLabel === 'today & tomorrow' ? 'for today and tomorrow' : rangeLabel === 'this week' ? 'for the rest of this week' : 'for the rest of this month'}${team ? ' for the team' : ''}. Enjoy a calm day 🙂</div>` : ''}</div>`;
}

// ----- the Admin gives an item to another MR -----
function openAssignSheet(kind, id) {
  const d = wall.data; if (!d || !wallStaff()) return;
  let label = '', current = null, explain = '';
  if (kind === 'reminder') {
    const r = [...d.reminders.overdue, ...d.reminders.items].find(x => x.id === id); if (!r) return;
    label = `${r.purpose} — ${r.name}`; current = r.mr_id; explain = 'Give this reminder to:';
  } else {
    let x = null;
    for (const g of d.calls) { x = g.doctors.find(y => y.id === id); if (x) break; }
    if (!x) x = d.occasions.find(o => o.who === 'doctor' && o.id === id);
    if (!x) return;
    label = x.name; current = x.owner_id;
    explain = `This changes the owner of ${x.name}. Their call days, birthday and anniversary, and their open reminders, move to the MR you choose.`;
  }
  openSheet('Assign to…', `<div style="font-size:13px;color:var(--text-muted);margin-bottom:8px"><b>${repEsc(label)}</b><br>${repEsc(explain)}</div>
    ${(d.team || []).map(u => `<div class="sh-row"><div class="sh-main"><div class="sh-name">${repEsc(u.full_name)}</div></div>${u.id === current ? '<span class="rp-tag">current ✓</span>' : `<button type="button" class="action-btn secondary" style="padding:6px 12px" onclick="doAssign('${kind}', ${id}, ${u.id})">Assign</button>`}</div>`).join('')}`);
}
async function doAssign(kind, id, userId) {
  const u = ((wall.data && wall.data.team) || []).find(x => x.id === userId);
  try {
    if (kind === 'reminder') await Api.updateReminder(id, { user_id: userId });
    else await Api.assignDoctorOwner(id, userId);
    closeSheet(); showToast(`Assigned to ${u ? u.full_name : 'the MR'}`); loadWall();
  } catch (e) { showToast(e.message === 'offline' ? "You're offline — it needs a signal" : (e.message || 'Could not assign it')); }
}

// ----- the two Home pages: swipe sideways (or tap the labels) -----
function updateHomePageUi() {
  document.querySelectorAll('#home-pagenav button').forEach(b => b.classList.toggle('on', Number(b.dataset.page) === homePage));
  const v = document.getElementById('view-list'); if (v && v.classList) v.classList.toggle('on-wall', homePage === 0);
}
function rememberHomePage(n) { try { const st = navStore(); if (st) st.setItem('zv_home_page', String(n)); } catch (e) { /* not kept across a refresh */ } }
function goHomePage(n, instant) {
  const p = document.getElementById('home-pager');
  homePage = n; updateHomePageUi(); rememberHomePage(n);
  if (p && p.scrollTo) p.scrollTo({ left: n * (p.clientWidth || 0), behavior: instant ? 'auto' : 'smooth' });
}
function onHomePagerScroll() {
  const p = document.getElementById('home-pager'); if (!p) return;
  const n = Math.round(p.scrollLeft / (p.clientWidth || 1));
  if (n !== homePage && (n === 0 || n === 1)) { homePage = n; updateHomePageUi(); rememberHomePage(n); }
}
function initHomePager() {
  const p = document.getElementById('home-pager');
  if (p && p.addEventListener) p.addEventListener('scroll', onHomePagerScroll, { passive: true });
  let n = 0; try { const st = navStore(); n = st ? Number(st.getItem('zv_home_page') || 0) : 0; } catch (e) { n = 0; }
  setTimeout(() => goHomePage(n === 1 ? 1 : 0, true), 0);
}

// ===== Visit reminders: set on a doctor / chemist, shown on the Wall =====
let remTarget = null;   // { type, id, label, rem }
function reminderBlockHtml() {
  return `<div class="rem-block"><button type="button" class="action-btn secondary" style="width:100%" onclick="openReminderSheet()">⏰ Set reminder</button><div id="reminders-list"></div></div>`;
}
async function loadEntityReminders() {
  const box = document.getElementById('reminders-list'), ce = state.currentEntity;
  if (!box || !ce) return;
  let rows = [];
  try { rows = await Api.getEntityReminders(ce.type, ce.id); } catch (e) { return; }
  if (!Array.isArray(rows)) return;          // an unexpected answer must never break the profile page
  state.entityReminders = rows;
  box.innerHTML = rows.map(r => `<div class="rem-item${r.status === 'done' ? ' done' : ''}"><div style="flex:1;min-width:0">⏰ ${repEsc(wallDay(r.date))}, ${repEsc(r.time)} — ${repEsc(r.purpose)}</div>
      ${r.status === 'done' ? `<button type="button" class="link-btn" onclick="reopenReminder(${r.id})">Reopen</button>` : `<button type="button" class="link-btn" onclick="editEntityReminder(${r.id})">Edit</button><button type="button" class="link-btn" onclick="completeEntityReminder(${r.id})">✓ Done</button>`}</div>`).join('');
}
function openReminderSheet(rem, target) {
  const ce = target || state.currentEntity; if (!ce) return;
  remTarget = { type: ce.type, id: ce.id, label: target ? target.label : (state.currentLabel || ''), rem: rem || null };
  const today = istDate(0), date = rem ? rem.date : today, oldDate = rem && rem.date < today;
  openSheet(rem ? 'Edit reminder' : 'Set reminder', `
    <div style="font-size:13px;color:var(--text-muted);margin-bottom:8px">${repEsc(remTarget.label)}</div>
    <div class="form-field"><label>Task / purpose</label><input type="text" id="rem-purpose" maxlength="200" placeholder="e.g. Take the new brochure" value="${rem ? repEsc(rem.purpose) : ''}"></div>
    <div class="form-row"><div class="form-field"><label>Date</label><input type="date" id="rem-date" ${oldDate ? '' : `min="${today}"`} value="${repEsc(date)}"></div>
    <div class="form-field"><label>Time</label><input type="time" id="rem-time" value="${rem ? repEsc(rem.time) : '09:00'}"></div></div>
    <button type="button" class="action-btn primary" style="width:100%" id="rem-save" onclick="saveReminder()">${rem ? 'Save changes' : 'Save reminder'}</button>
    ${rem && rem.status !== 'done' ? `<button type="button" class="action-btn secondary" style="width:100%;margin-top:8px" onclick="completeReminderFromSheet()">✓ Mark completed</button>` : ''}`);
}
async function saveReminder() {
  const t = remTarget; if (!t) return;
  const purpose = document.getElementById('rem-purpose').value.trim(), remind_date = document.getElementById('rem-date').value, remind_time = document.getElementById('rem-time').value;
  if (!purpose) return showToast('Say what the reminder is for');
  if (!remind_date) return showToast('Pick a date');
  if (!remind_time) return showToast('Pick a time');
  const btn = document.getElementById('rem-save'); if (btn) { btn.disabled = true; }
  try {
    if (t.rem) await Api.updateReminder(t.rem.id, { purpose, remind_date, remind_time });
    else await Api.addReminder({ entity_type: t.type, entity_id: t.id, purpose, remind_date, remind_time });
    closeSheet(); showToast(t.rem ? 'Reminder updated' : 'Reminder set');
    loadWall(); loadEntityReminders();
  } catch (e) {
    showToast(e.message === 'offline' ? "You're offline — reminders need a signal" : (e.message || 'Could not save the reminder'));
    if (btn) btn.disabled = false;
  }
}
async function setReminderStatus(id, status) {
  try { await Api.updateReminder(id, { status }); showToast(status === 'done' ? 'Done ✓' : 'Reopened'); loadWall(); loadEntityReminders(); }
  catch (e) { showToast(e.message === 'offline' ? "You're offline — it needs a signal" : (e.message || 'Could not update it')); }
}
async function setWallTask(id, status) {
  try { await Api.updateTask(id, { status }); showToast(status === 'done' ? 'Task completed ✓' : 'Task reopened'); loadWall(); }
  catch (e) { showToast(e.message === 'offline' ? "You're offline — it needs a signal" : (e.message || 'Could not update the task')); }
}
const completeWallReminder = (id) => setReminderStatus(id, 'done');
const completeEntityReminder = (id) => setReminderStatus(id, 'done');
const reopenReminder = (id) => setReminderStatus(id, 'open');
function completeReminderFromSheet() { const t = remTarget; if (t && t.rem) { closeSheet(); setReminderStatus(t.rem.id, 'done'); } }
function editWallReminder(id) {
  const all = wall.data ? [...wall.data.reminders.overdue, ...wall.data.reminders.items] : [], r = all.find(x => x.id === id); if (!r) return;
  openReminderSheet({ id: r.id, date: r.date, time: r.time, purpose: r.purpose, status: 'open' }, { type: r.entity_type, id: r.entity_id, label: r.name });
}
function editEntityReminder(id) { const r = (state.entityReminders || []).find(x => x.id === id); if (r) openReminderSheet(r); }

// ===== A sheet that slides up (used by the Home cards and the offline bar) =====
function openSheet(title, bodyHtml) {
  closeSheet();
  const el = document.createElement('div');
  el.id = 'zv-sheet'; el.className = 'zv-sheet';
  el.innerHTML = `<div class="zv-sheet-card"><div class="zv-sheet-head"><b>${repEsc(title)}</b><button type="button" class="link-btn" onclick="closeSheet()">Close</button></div><div id="zv-sheet-body">${bodyHtml}</div></div>`;
  document.body.appendChild(el);
}
function closeSheet() { const el = document.getElementById('zv-sheet'); if (el && el.remove) el.remove(); }
function setSheetBody(html) { const b = document.getElementById('zv-sheet-body'); if (b) b.innerHTML = html; }

// ===== Home cards: today's plan, reminders, my month =====
let homeCards = { plan: null, reminders: null, month: null };
async function loadHomeCards() {
  try {
    const box = document.getElementById('home-cards');
    if (!box || !Api.isLoggedIn()) return;
    const [reminders, plan, month] = await Promise.all([Api.getReminders().catch(() => null), Api.getPlan().catch(() => null), Api.getMyTargets().catch(() => null)]);
    homeCards = { plan, reminders, month };
    renderHomeCards();
  } catch (e) { /* the cards are a bonus: they must never get in the way of saving a call */ }
}
function renderHomeCards() {
  const box = document.getElementById('home-cards');
  if (!box) return;
  const { plan, reminders: rem, month } = homeCards;
  const dueN = rem ? (rem.due.doctors || 0) + (rem.due.chemists || 0) : 0;
  box.innerHTML = `
    <button type="button" class="hc-tile" onclick="openPlanSheet()"><div class="hc-n">${plan ? `${plan.done}/${plan.planned}` : '—'}</div><div class="hc-l">📅 Today's plan</div></button>
    <button type="button" class="hc-tile" onclick="openRemindersSheet()"><div class="hc-n">${rem ? rem.events.length : '—'}</div><div class="hc-l">🔔 Reminders${dueN ? ` · ${dueN} due` : ''}</div></button>
    <button type="button" class="hc-tile" onclick="openMonthSheet()"><div class="hc-n">${month && month.overall_pct !== null && month.overall_pct !== undefined ? month.overall_pct + '%' : '—'}</div><div class="hc-l">🎯 My month</div></button>`;
}

// ----- today's plan -----
async function openPlanSheet() {
  openSheet("Today's plan", '<div class="loading-row">Loading…</div>');
  try { renderPlanSheet(await Api.getPlan()); } catch (e) { setSheetBody(`<div class="empty-note">Couldn't load the plan — ${repEsc(e.message)}</div>`); }
}
function renderPlanSheet(p) {
  homeCards.plan = p; renderHomeCards();
  setSheetBody(`
    <div style="font-size:13px;color:var(--text-muted);margin-bottom:8px"><b>${p.done}</b> of <b>${p.planned}</b> done today. A call counts as done when you log a comment or samples for it.</div>
    <button type="button" class="action-btn secondary" style="width:100%;margin-bottom:6px" onclick="openDueSheet()">+ Add from the "due for a call" list</button>
    ${p.rows.length ? p.rows.map(r => `<div class="sh-row"><div class="sh-main"><div class="sh-name">${r.done ? '✅ ' : '⬜ '}<a href="#" onclick="planOpen('${r.entity_type}', ${r.entity_id}); return false">${repEsc(r.name)}</a></div><div class="sh-sub">${repEsc(r.locality || '')}${r.done ? ' · done' : ''}</div></div>${r.done ? '' : `<button type="button" class="link-btn danger" onclick="planRemove(${r.id})">Remove</button>`}</div>`).join('') : `<div class="empty-note" style="padding:14px 0">Nothing planned for today yet.</div>`}`);
}
function planOpen(type, id) { closeSheet(); openDetail(type, id); }
async function planRemove(id) { try { await Api.removeFromPlan(id); renderPlanSheet(await Api.getPlan()); } catch (e) { showToast(e.message || 'Could not remove it'); } }

// ----- the "due for a call" list -----
let dueState = { type: 'doctor', near: false, q: '', pos: null, rows: [] };
function openDueSheet(type) {
  if (type) dueState.type = type;
  openSheet('Due for a call', '<div class="loading-row">Loading…</div>');
  loadDue();
}
async function loadDue() {
  try {
    const r = await Api.getDue({ type: dueState.type, sort: dueState.near && dueState.pos ? 'near' : 'overdue', lat: dueState.pos ? dueState.pos.lat : '', lng: dueState.pos ? dueState.pos.lng : '', q: dueState.q, limit: 40 });
    dueState.rows = r.rows;
  } catch (e) { dueState.rows = []; dueState.error = e.message; }
  renderDueSheet();
}
function renderDueSheet() {
  const d = dueState, tab = (t, label) => `<button type="button" class="${d.type === t ? 'on' : ''}" onclick="dueSetType('${t}')">${label}</button>`;
  const rows = d.rows.map(r => {
    const last = r.days_since == null ? 'never called' : `${r.days_since} days since the last call`;
    return `<div class="sh-row"><div class="sh-main"><div class="sh-name">${repEsc(r.name)}</div><div class="sh-sub">${repEsc(r.locality || '')} · ${last} (due every ${r.target_days} days)${r.distance_m != null ? ' · ' + fmtDist(r.distance_m) + ' away' : ''}</div></div>
      ${r.in_plan ? '<span class="rp-tag">In plan ✓</span>' : `<button type="button" class="action-btn secondary" style="padding:6px 12px" onclick="dueAdd('${d.type}', ${r.id})">+ Add</button>`}</div>`;
  }).join('');
  setSheetBody(`
    <div class="sh-tabs">${tab('doctor', 'Doctors')}${tab('chemist', 'Chemists')}<button type="button" class="${d.near ? 'on' : ''}" onclick="dueToggleNear()">📍 Nearest first</button></div>
    <input type="text" id="due-q" placeholder="Search a name…" value="${repEsc(d.q)}" oninput="dueSearch(this.value)" style="width:100%;margin-bottom:6px;padding:9px 10px;border:1px solid var(--border);border-radius:10px">
    ${d.rows.length ? `<button type="button" class="link-btn" onclick="dueAddTop()">Add the first 10 to today's plan</button>` : ''}
    ${rows || `<div class="empty-note" style="padding:14px 0">${d.error ? repEsc(d.error) : 'Nobody is due — everyone has had a call recently.'}</div>`}`);
}
function dueSetType(t) { dueState.type = t; loadDue(); }
let dueTimer;
function dueSearch(v) { dueState.q = v; clearTimeout(dueTimer); dueTimer = setTimeout(loadDue, 300); }
async function dueToggleNear() {
  if (dueState.near) { dueState.near = false; return loadDue(); }
  showToast('📍 Finding where you are…');
  const loc = await captureGeolocation();
  if (!loc) return showToast("Couldn't get your location — enable GPS and try again");
  dueState.pos = { lat: loc.lat, lng: loc.lng }; dueState.near = true; loadDue();
}
async function dueAdd(type, id) {
  try { await Api.addToPlan([{ entity_type: type, entity_id: id }]); showToast('Added to today\'s plan'); loadDue(); loadHomeCards(); } catch (e) { showToast(e.message || 'Could not add it'); }
}
async function dueAddTop() {
  const items = dueState.rows.filter(r => !r.in_plan).slice(0, 10).map(r => ({ entity_type: dueState.type, entity_id: r.id }));
  if (!items.length) return showToast('They are all in your plan already');
  try { const r = await Api.addToPlan(items); showToast(`Added ${r.added} to today's plan`); loadDue(); loadHomeCards(); } catch (e) { showToast(e.message || 'Could not add them'); }
}

// ----- reminders -----
async function openRemindersSheet() {
  openSheet('Reminders', '<div class="loading-row">Loading…</div>');
  let rem = homeCards.reminders;
  try { rem = await Api.getReminders(); homeCards.reminders = rem; renderHomeCards(); } catch (e) { /* show what we have */ }
  if (!rem) return setSheetBody('<div class="empty-note">No reminders could be loaded.</div>');
  const when = (d) => (d === 0 ? 'today' : d === 1 ? 'tomorrow' : `in ${d} days`);
  const digits = (n) => String(n || '').replace(/\D/g, '').slice(-10);
  const ev = rem.events.map(x => `<div class="sh-row"><div class="sh-main"><div class="sh-name">${x.kind === 'birthday' ? '🎂' : '💍'} ${repEsc(x.name)}</div><div class="sh-sub">${x.kind === 'birthday' ? 'Birthday' : 'Anniversary'} ${when(x.days_until)} · ${repEsc(x.locality || '')}</div></div>
      <div style="white-space:nowrap">${digits(x.mobile_number).length === 10 ? `<a class="link-btn" href="tel:+91${digits(x.mobile_number)}">📞 Call</a> <a class="link-btn" href="https://wa.me/91${digits(x.mobile_number)}" target="_blank" rel="noopener">WhatsApp</a>` : ''} <button type="button" class="link-btn" onclick="planOpen('doctor', ${x.doctor_id})">Open</button></div></div>`).join('');
  setSheetBody(`
    <div style="font-size:13px;color:var(--text-muted);margin-bottom:6px">A greeting call or message is a good reason to be in touch.</div>
    ${ev || '<div class="empty-note" style="padding:10px 0">No birthdays or anniversaries in the next 7 days.</div>'}
    <div style="margin-top:14px;font-weight:800">Due for a call</div>
    <div class="sh-row"><div class="sh-main"><div class="sh-name">${rem.due.doctors} doctor${rem.due.doctors === 1 ? '' : 's'}</div></div><button type="button" class="action-btn secondary" style="padding:6px 12px" onclick="openDueSheet('doctor')">See them</button></div>
    <div class="sh-row"><div class="sh-main"><div class="sh-name">${rem.due.chemists} chemist${rem.due.chemists === 1 ? '' : 's'}</div></div><button type="button" class="action-btn secondary" style="padding:6px 12px" onclick="openDueSheet('chemist')">See them</button></div>`);
}

// ----- my month: targets and progress -----
async function openMonthSheet() {
  openSheet('My month', '<div class="loading-row">Loading…</div>');
  let m = homeCards.month;
  try { m = await Api.getMyTargets(); homeCards.month = m; renderHomeCards(); } catch (e) { /* show what we have */ }
  if (!m) return setSheetBody('<div class="empty-note">Could not load your month.</div>');
  const rows = (m.metrics || []).map(k => {
    const t = (m.targets || {})[k.key], a = ((m.actual || {})[k.key]) || 0;
    if (!(t > 0)) return `<div class="sh-row"><div class="sh-main"><div class="sh-name">${repEsc(k.label)}</div></div><div>${a}</div></div>`;
    const p = m.pct[k.key], good = p >= m.pace_pct;
    return `<div style="padding:8px 0;border-bottom:1px solid var(--border)"><div style="display:flex;justify-content:space-between"><b>${repEsc(k.label)}</b><span><b>${a}</b> / ${t} · ${p}%</span></div><div class="sh-bar"><div style="width:${Math.min(100, p)}%;background:${good ? '#2E7D3A' : '#C0392B'}"></div></div></div>`;
  }).join('');
  const has = m.overall_pct !== null && m.overall_pct !== undefined;
  setSheetBody(`
    ${has ? `<div style="font-size:26px;font-weight:800;color:var(--purple)">${m.overall_pct}%</div><div style="font-size:13px;color:var(--text-muted);margin-bottom:6px">${m.on_track ? '✅ On track' : '⚠ Behind'} — about ${m.pace_pct}% of the month's working days have passed.</div>` : `<div class="empty-note" style="padding:10px 0">No targets are set for you this month. Your Admin sets them in the portal. Here is what you have done:</div>`}
    ${rows}`);
}

// ===== Offline: calls waiting on this phone =====
async function updateOutboxBar() {
  const bar = document.getElementById('outbox-bar');
  if (!bar) return;
  const items = await Api.outboxItems(), failed = items.filter(i => i.status === 'failed').length;
  if (!items.length) { bar.style.display = 'none'; return; }
  bar.style.display = ''; bar.className = 'outbox-bar' + (failed ? ' failed' : '');
  bar.textContent = failed ? `⚠ ${failed} call${failed === 1 ? '' : 's'} could not be uploaded — tap to review` : `📤 ${items.length} call${items.length === 1 ? '' : 's'} waiting to upload — tap to review`;
}
async function openOutboxSheet() {
  openSheet('Waiting to upload', '<div class="loading-row">Loading…</div>');
  renderOutboxSheet();
}
async function renderOutboxSheet() {
  const items = await Api.outboxItems();
  const kind = (p) => (p.category === 'samples' ? 'Samples' : p.category === 'gift' ? 'Gift' : 'Visit');
  setSheetBody(`
    <div style="font-size:13px;color:var(--text-muted);margin-bottom:8px">These were saved on this phone while there was no signal. They upload by themselves when you are online; each is saved once, with the time you made the call.</div>
    ${items.length ? `<button type="button" class="action-btn secondary" style="width:100%;margin-bottom:6px" onclick="outboxSyncNow()">Upload now</button>` : ''}
    ${items.map(i => `<div class="sh-row"><div class="sh-main"><div class="sh-name">${repEsc(kind(i.payload))} — ${repEsc(i.label || 'record')}</div>
        <div class="sh-sub">${new Date(i.createdAt).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })}${i.blob ? ' · with photo' : ''}${i.status === 'failed' ? ` · <span style="color:var(--danger,#C0392B)">not accepted: ${repEsc(i.error || '')}</span>` : ' · waiting'}</div></div>
        <div style="white-space:nowrap">${i.status === 'failed' ? `<button type="button" class="link-btn" onclick="outboxRetry('${i.id}')">Retry</button> ` : ''}<button type="button" class="link-btn danger" onclick="outboxDiscard('${i.id}')">Discard</button></div></div>`).join('') || '<div class="empty-note" style="padding:14px 0">Nothing is waiting. ✅</div>'}`);
}
async function outboxSyncNow() {
  if (!navigator.onLine) return showToast("You're offline — it will upload when the signal is back");
  const r = await Api.syncOutbox();
  showToast(r.done ? `${r.done} call${r.done === 1 ? '' : 's'} uploaded` : r.left ? 'Could not upload yet — will try again' : 'Nothing to upload');
  renderOutboxSheet();
}
async function outboxRetry(id) { await Api.retryOutboxItem(id); outboxSyncNow(); }
async function outboxDiscard(id) {
  if (!confirm('Discard this call? It will NOT be saved to the doctor / chemist.')) return;
  await Api.discardOutboxItem(id); renderOutboxSheet();
}
Api.onSlow = (on) => { const b = document.getElementById('slow-banner'); if (b) b.style.display = on ? '' : 'none'; };
let lastCacheToast = 0;
Api.onCacheServed = () => { if (Date.now() - lastCacheToast > 30000) { lastCacheToast = Date.now(); showToast("📴 Showing saved data — you're offline"); } };
Api.onOutboxChange = (info) => {
  updateOutboxBar();
  if (info && info.done) {
    showToast(`${info.done} saved call${info.done === 1 ? '' : 's'} uploaded`);
    loadHomeCards();
    if (state.currentEntity && document.getElementById('view-detail').classList.contains('active')) loadFeed(state.currentEntity.type, state.currentEntity.id);
  }
};

// ===== Qualification and speciality: short lists of the common ones, searchable; "Other" lets the MR type anything else =====
const QUALIFICATIONS = ['MBBS', 'MBBS, MD', 'MBBS, MS', 'MBBS, DNB', 'MBBS, DM', 'MBBS, MCh', 'MBBS, D.Ortho', 'MBBS, DGO', 'MBBS, DCH',
  'MBBS, Diploma', 'BDS', 'BDS, MDS', 'BAMS', 'BHMS', 'BPT', 'MPT', 'Other'];
const SPECIALITIES = ['General Physician', 'Consulting Physician', 'Orthopaedic Surgeon', 'Rheumatologist', 'Neurologist', 'Diabetologist', 'Pain Management',
  'Physiotherapist', 'Paediatrician', 'Gynaecologist', 'Dermatologist', 'ENT Specialist', 'Ophthalmologist', 'Cardiologist', 'General Surgeon', 'Dentist',
  'Ayurvedic Practitioner', 'Homoeopathic Practitioner', 'Other'];
const comboLists = { qualification: QUALIFICATIONS, speciality: SPECIALITIES };
const comboMatches = {};
function comboHtml(key, label, value, required) {
  const list = comboLists[key], known = !value || list.includes(value) && value !== 'Other';
  return `
    <div class="form-field combo" id="combo-${key}">
      <label>${label}${required ? ' *' : ''}</label>
      <input type="text" id="f-${key}-search" autocomplete="off" placeholder="Search or select…" value="${repEsc(known ? (value || '') : 'Other')}" onfocus="comboFilter('${key}')" oninput="comboFilter('${key}')">
      <div class="combo-list" id="f-${key}-list" style="display:none"></div>
      <input type="text" id="f-${key}-other" class="combo-other" style="display:${known ? 'none' : ''}" placeholder="Type the ${label.toLowerCase()}" value="${repEsc(known ? '' : value)}" oninput="comboOtherInput('${key}')">
      <input type="hidden" id="f-${key}" value="${repEsc(value || '')}">
    </div>`;
}
function comboFilter(key) {
  const q = String(document.getElementById(`f-${key}-search`).value || '').trim().toLowerCase();
  const all = comboLists[key];
  const hits = all.filter(o => o !== 'Other' && (!q || o.toLowerCase().includes(q)));
  hits.push('Other');                                   // always there, so a missing one can be typed
  comboMatches[key] = hits;
  const box = document.getElementById(`f-${key}-list`);
  box.innerHTML = hits.map((o, i) => `<div class="combo-opt${document.getElementById(`f-${key}`).value === o ? ' on' : ''}" data-act="combo" data-key="${key}" data-i="${i}">${repEsc(o)}</div>`).join('');
  box.style.display = '';
}
function comboPick(key, i) {
  const opt = (comboMatches[key] || [])[i];
  if (opt === undefined) return;
  const search = document.getElementById(`f-${key}-search`), other = document.getElementById(`f-${key}-other`), hidden = document.getElementById(`f-${key}`);
  search.value = opt;
  if (opt === 'Other') { other.style.display = ''; hidden.value = String(other.value || '').trim(); if (other.focus) other.focus(); }
  else { other.style.display = 'none'; other.value = ''; hidden.value = opt; }
  document.getElementById(`f-${key}-list`).style.display = 'none';
}
function comboOtherInput(key) { document.getElementById(`f-${key}`).value = String(document.getElementById(`f-${key}-other`).value || '').trim(); }
// typed text that is exactly one of the options counts as picking it
function comboResolve(key) {
  const hidden = document.getElementById(`f-${key}`), search = document.getElementById(`f-${key}-search`);
  if (!hidden || hidden.value) return;
  const t = String(search.value || '').trim().toLowerCase(), hit = comboLists[key].find(o => o !== 'Other' && o.toLowerCase() === t);
  if (hit) hidden.value = hit;
}

let editFromDetail = false, reloadDetailOnPop = null;
async function openEdit(type, id, prefill) {
  state.editing = { type, id };
  editFromDetail = !!(id && history.state && history.state.view === 'detail');   // so Save can return to that same record page
  showView('edit');
  const isDoctor = type === 'doctor';
  const isNew = !id;
  document.getElementById('edit-title').textContent = id ? `Edit ${isDoctor ? 'Doctor' : 'Chemist'}` : `Add ${isDoctor ? 'Doctor' : 'Chemist'}`;

  // The record is loaded from the server, so it is complete whichever way it was opened: from the Home list, the map, a search,
  // a linked doctor / chemist, or after a refresh. (It used to be looked up in the Home list, which came up blank for anything not in it.)
  let existing = prefill || {};
  if (id) {
    document.getElementById('edit-form-fields').innerHTML = `<div class="loading-row">Loading…</div>`;
    try {
      existing = await (isDoctor ? Api.getDoctor(id) : Api.getChemist(id));
    } catch (err) {
      const cached = (state.listCache[type] || []).find(x => x.id === id);
      if (!cached) { showToast("Couldn't load this record — check your connection and try again"); openDetail(type, id); return; }
      existing = cached;
    }
  }
  state.editing = { type, id, existing };
  const v = (x) => repEsc(x == null ? '' : x);
  const ratingSelect = `
    <div class="form-field">
      <label>Rating${isDoctor ? ' (how committed is this doctor, prescribing or target?)' : ''}</label>
      <select id="f-rating">
        <option value="">Not rated</option>
        ${[1,2,3,4,5].map(n => `<option value="${n}" ${Number(existing.rating)===n?'selected':''}>${'★'.repeat(n)}${'☆'.repeat(5-n)} (${n})</option>`).join('')}
      </select>
    </div>`;

  // A NEW record asks only for what is needed to create it. Everything else is filled in later with Edit
  // (a new doctor starts as Non-Rx, Core, with no rating).
  const doctorTop = `
    <div class="form-field"><label>Doctor Name *</label><input id="f-name" value="${v(existing.name || (isNew ? 'Dr. ' : ''))}" oninput="onDoctorNameInput(this)" onblur="onDoctorNameBlur(this)" autocomplete="off"></div>
    ${comboHtml('qualification', 'Qualification', existing.qualification || '', true)}
    ${comboHtml('speciality', 'Speciality', existing.speciality || '', true)}`;
  const doctorMid = isNew ? `
    <div class="form-field"><label>Hospital / Clinic Name</label><input id="f-hospital_name" value="${v(existing.hospital_name)}"></div>
    <div class="form-field"><label>Mobile Number *</label><input type="tel" id="f-mobile_number" inputmode="tel" maxlength="20" placeholder="10-digit mobile number" required></div>` : `
    <div class="form-field"><label>Hospital / Clinic Name</label><input id="f-hospital_name" value="${v(existing.hospital_name)}"></div>
    <div class="form-field"><label>Mobile Number</label><input type="tel" id="f-mobile_number" inputmode="tel" maxlength="20" value="${v(existing.mobile_number)}"></div>
    <div class="form-row">
      <div class="form-field"><label>RX Status</label>
        <select id="f-rx_status"><option value="RX" ${existing.rx_status==='RX'?'selected':''}>RX</option><option value="NON_RX" ${existing.rx_status!=='RX' && existing.rx_status!=='POTENTIAL'?'selected':''}>Non-RX</option><option value="POTENTIAL" ${existing.rx_status==='POTENTIAL'?'selected':''}>Potential</option></select>
      </div>
      <div class="form-field"><label>Core Status</label>
        <select id="f-core_status"><option value="CORE" ${existing.core_status!=='NON_CORE'?'selected':''}>Core</option><option value="NON_CORE" ${existing.core_status==='NON_CORE'?'selected':''}>Non-Core</option></select>
      </div>
    </div>
    ${ratingSelect}
    <div class="form-row">
      <div class="form-field"><label>Birthday</label><input type="date" id="f-birthday_date" value="${existing.birthday_date ? existing.birthday_date.slice(0,10) : ''}"></div>
      <div class="form-field"><label>Anniversary</label><input type="date" id="f-anniversary_date" value="${existing.anniversary_date ? existing.anniversary_date.slice(0,10) : ''}"></div>
    </div>



    <div class="form-field"><label>Commission Type</label>
      <select id="f-commission_type"><option value="">Not set</option>${COMMISSION_TYPES.map(([k, t]) => `<option value="${k}" ${existing.commission_type === k ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
    <div class="form-field"><label>Doctor Commission Details</label><textarea id="f-doctor_commission_details">${v(existing.doctor_commission_details)}</textarea></div>`;

  const chemistTop = `
    <div class="form-field"><label>Chemist Store Name *</label><input id="f-store_name" value="${v(existing.store_name)}" placeholder="e.g. Deshmukh Medical Store"></div>`;
  const chemistMid = isNew ? `
    <div class="form-field"><label>Mobile Number *</label><input type="tel" id="f-mobile_number" inputmode="tel" maxlength="20" placeholder="10-digit mobile number" required></div>` : `
    <div class="form-field"><label>Pharmacist / Chemist Name (optional)</label><input id="f-chemist_name" value="${v(existing.chemist_name)}"></div>
    <div class="form-field"><label>Mobile Number</label><input type="tel" id="f-mobile_number" inputmode="tel" maxlength="20" value="${v(existing.mobile_number)}"></div>
    <div class="form-row">
      ${ratingSelect}
      <div class="form-field">
        <label>Billing Category</label>
        <select id="f-billing_category">
          <option value="">Not set</option>
          <option value="own" ${existing.billing_category==='own'?'selected':''}>Own Billing</option>
          <option value="distributor" ${existing.billing_category==='distributor'?'selected':''}>Distributor Billing</option>
          <option value="hybrid" ${existing.billing_category==='hybrid'?'selected':''}>Hybrid</option>
        </select>
      </div>
    </div>

`;

  document.getElementById('edit-form-fields').innerHTML = `
    ${isDoctor ? doctorTop : chemistTop}
    ${isDoctor ? doctorMid : chemistMid}
    <div class="form-row">
      <div class="form-field"><label>City</label><input id="f-city" list="city-list" value="${v(existing.city)}" oninput="markManual(this)" autocomplete="off"><datalist id="city-list"></datalist></div>
      <div class="form-field combo" id="combo-locality"><label>Locality (neighbourhood)</label><input id="f-locality" value="${v(existing.locality)}" placeholder="Search and choose a locality" oninput="markManual(this); localityFilter()" onfocus="localityFilter()" onblur="localityBlur()" autocomplete="off"><div class="combo-list" id="f-locality-list" style="display:none"></div></div>
    </div>
    <div class="chips-row" id="locality-chips"></div>
    <div class="field-hint" id="loc-hint"></div>
    <div class="form-field"><label>Address</label><textarea id="f-address">${v(existing.address)}</textarea></div>
    <div class="form-row">
      <div class="form-field"><label>Latitude</label><input type="number" step="any" id="f-lat" value="${v(existing.lat)}"></div>
      <div class="form-field"><label>Longitude</label><input type="number" step="any" id="f-lng" value="${v(existing.lng)}"></div>
    </div>
    <button type="button" class="action-btn secondary" style="margin-bottom:12px" onclick="useMyLocationForForm()">📍 Use My Current Location</button>
    ${isNew ? '' : `<div class="form-field"><label>Special Notes</label><textarea id="f-special_notes">${v(existing.special_notes)}</textarea></div>`}
    ${isNew ? `<div style="font-size:12px;color:var(--text-muted);margin-top:8px">📍 After saving, you'll log your first visit${selfieRequired() ? ' with a verification selfie — same as every visit going forward' : ''}. Other details can be added later with Edit.</div>` : ''}
  `;

  // the localities and cities already used, offered while typing (a pick-list, never forced)
  loadKnownAreas();

  // Manual lat/lng entry also triggers the city / cluster look-up, once both are present.
  const latEl = document.getElementById('f-lat'), lngEl = document.getElementById('f-lng');
  const tryAutoFillFromInputs = () => {
    const lat = parseFloat(latEl.value), lng = parseFloat(lngEl.value);
    if (!Number.isNaN(lat) && !Number.isNaN(lng)) autoFillAddressFromLocation(lat, lng);
  };
  if (latEl) latEl.addEventListener('change', tryAutoFillFromInputs);
  if (lngEl) lngEl.addEventListener('change', tryAutoFillFromInputs);

  if (existing.lat && existing.lng) {
    autoFillAddressFromLocation(existing.lat, existing.lng);
  } else if (isNew) {
    // Brand-new record — silently grab the MR's current location so the city and locality are
    // suggested from where the doctor/chemist actually is.
    captureGeolocation().then((loc) => {
      if (!loc) return;
      const latInput = document.getElementById('f-lat'), lngInput = document.getElementById('f-lng');
      if (latInput && !latInput.value) latInput.value = loc.lat.toFixed(6);
      if (lngInput && !lngInput.value) lngInput.value = loc.lng.toFixed(6);
      autoFillAddressFromLocation(loc.lat, loc.lng);
    });
  }
}

function captureGeolocation(timeoutMs = 8000) {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    const timer = setTimeout(() => resolve(null), timeoutMs);
    navigator.geolocation.getCurrentPosition(
      (pos) => { clearTimeout(timer); resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }); },
      () => { clearTimeout(timer); resolve(null); },
      { enableHighAccuracy: true, timeout: timeoutMs }
    );
  });
}

async function useMyLocationForForm() {
  if (!navigator.geolocation) return showToast('Geolocation not supported');
  navigator.geolocation.getCurrentPosition(pos => {
    const lat = pos.coords.latitude, lng = pos.coords.longitude;
    document.getElementById('f-lat').value = lat.toFixed(6);
    document.getElementById('f-lng').value = lng.toFixed(6);
    showToast('Location captured');
    autoFillAddressFromLocation(lat, lng);
  }, () => showToast('Could not get location'));
}

// ----- City and locality: filled from the location, always reviewable, never overwriting a manual correction -----
// markManual: the MR typed or picked this value, so it is theirs — nothing automatic will replace it again.
function markManual(el) { if (el && el.dataset) { el.dataset.manual = '1'; el.dataset.auto = ''; } }
// automatic filling is allowed only into an EMPTY box, or one we filled ourselves earlier — and never after a manual correction
function canFill(el) { return !!el && !(el.dataset && el.dataset.manual) && (!String(el.value || '').trim() || (el.dataset && el.dataset.auto === '1')); }
function useLocality(name) {
  const el = document.getElementById('f-locality');
  if (!el) return;
  el.value = name; markManual(el);
  showToast(`Locality set to ${name}`);
}
// ===== Locality: a searchable list, and ONLY that list (the Admin keeps it in Working clusters), so the spelling is always right =====
let localityNames = [];
const locNorm = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const localityMatch = (v) => { const n = locNorm(v); return n ? (localityNames.find(x => locNorm(x) === n) || null) : null; };
async function loadLocalityNames() { try { const l = await Api.getLocalityNames(); if (Array.isArray(l)) localityNames = l; } catch (e) { /* the saved copy (or the server's own check) still applies */ } }
let localityMatches = [];
// An option is chosen by a TAP. Touching the list to scroll through it (or a finger that moves) must not pick anything.
let comboTouch = null;
document.addEventListener('pointerdown', (e) => {
  const o = e.target.closest && e.target.closest('.combo-opt[data-act]');
  comboTouch = o ? { o, x: e.clientX, y: e.clientY, t: Date.now(), active: true } : null;
});
document.addEventListener('pointermove', (e) => { if (comboTouch && (Math.abs(e.clientX - comboTouch.x) > 8 || Math.abs(e.clientY - comboTouch.y) > 8)) comboTouch.moved = true; });
document.addEventListener('pointercancel', () => { comboTouch = null; });               // the browser took the gesture over to scroll the list
document.addEventListener('pointerup', (e) => {
  const d = comboTouch; comboTouch = null;
  if (!d || d.moved || Date.now() - d.t > 800) return;
  const o = e.target.closest && e.target.closest('.combo-opt[data-act]');
  if (o !== d.o) return;
  if (o.dataset.act === 'loc') localityPick(Number(o.dataset.i)); else comboPick(o.dataset.key, Number(o.dataset.i));
});
function localityFilter() {
  const el = document.getElementById('f-locality'), box = document.getElementById('f-locality-list');
  if (!el || !box) return;
  const q = locNorm(el.value);
  localityMatches = localityNames.filter(n => !q || locNorm(n).includes(q)).slice(0, 80);
  box.innerHTML = localityMatches.length ? localityMatches.map((n, i) => `<div class="combo-opt${localityMatch(el.value) === n ? ' on' : ''}" data-act="loc" data-i="${i}">${repEsc(n)}</div>`).join('')
    : `<div class="combo-opt" style="color:var(--text-muted)">${localityNames.length ? 'No locality matches — choose one from the list' : 'The list is not set up yet'}</div>`;
  box.style.display = '';
}
function localityPick(i) {
  const el = document.getElementById('f-locality'), n = localityMatches[i];
  if (!el || n === undefined) return;
  el.value = n; markManual(el); el.style.borderColor = '';
  document.getElementById('f-locality-list').style.display = 'none';
}
function localityBlur() {
  const el = document.getElementById('f-locality'), box = document.getElementById('f-locality-list');
  if (box) setTimeout(() => { if (comboTouch && comboTouch.active) return; box.style.display = 'none'; }, 250);   // not while a finger is scrolling the list
  if (el && localityNames.length && el.value.trim()) { const m = localityMatch(el.value); if (m) { el.value = m; el.style.borderColor = ''; } else el.style.borderColor = '#C0392B'; }
}
// Before saving: what is in the box must be one of the list (rewritten to the list's own spelling). An empty box is allowed, as before.
function localityCheck() {
  const el = document.getElementById('f-locality');
  if (!el || !localityNames.length || !el.value.trim()) return { ok: true };
  const m = localityMatch(el.value);
  if (!m) { el.style.borderColor = '#C0392B'; return { ok: false, message: 'Choose the locality from the list — it cannot be typed freely.' }; }
  el.value = m; el.style.borderColor = '';
  return { ok: true };
}

async function loadKnownAreas() {
  try {
    const k = await Api.getKnownAreas();
    const fill = (id, list) => { const dl = document.getElementById(id); if (dl) dl.innerHTML = (list || []).map(n => `<option value="${repEsc(n)}"></option>`).join(''); };
    fill('city-list', k.cities);                  // cities stay a free list; the LOCALITY comes from the Admin's list only
  } catch (e) { /* the pick-lists are a convenience: typing always works */ }
}

// Fills the city and locality from lat/lng via reverse geocoding —
// only into fields that are still empty, so it never overwrites something
// the MR already typed by hand.
async function autoFillAddressFromLocation(lat, lng) {
  const cityEl = document.getElementById('f-city'), locEl = document.getElementById('f-locality');
  if (!cityEl && !locEl) return;
  const hint = document.getElementById('loc-hint');
  const say = (text, warn) => { if (hint) { hint.textContent = text; hint.className = 'field-hint' + (warn ? ' warn' : ''); } };
  try {
    const res = await Api.reverseGeocode(lat, lng);
    let filled = false;
    if (cityEl && res.city && canFill(cityEl)) { cityEl.value = res.city; cityEl.dataset.auto = '1'; filled = true; }
    const gpsLoc = localityNames.length ? localityMatch(res.locality) : res.locality;      // only a locality that is ON the list is filled in
    if (locEl && gpsLoc && canFill(locEl)) { locEl.value = gpsLoc; locEl.dataset.auto = '1'; filled = true; }
    // other names found nearby (only those on the list), to correct the locality in one tap
    const chips = [...new Set([res.locality, ...(res.suggestions || [])].map(c => (localityNames.length ? localityMatch(c) : c)).filter(Boolean))];
    const box = document.getElementById('locality-chips');
    if (box) box.innerHTML = chips.length ? `<span class="lbl">Nearby areas:</span>` + chips.map(c => `<button type="button" class="area-chip" onclick="useLocality(this.textContent)">${repEsc(c)}</button>`).join('') : '';
    if (locEl && !String(locEl.value || '').trim()) say("The location doesn't match a locality on the list — search and choose one — choose one from the list or type it.", true);
    else if (filled) say('City and locality were filled from the location — please check them and correct if needed.');
  } catch (err) {
    if (locEl && !String(locEl.value || '').trim()) say("Couldn't detect the area automatically — type the city and locality, or pick from the list.", true);
  }
}

let saveInFlight = false;   // a second tap while the first save is still going does nothing
async function saveEdit() {
  if (saveInFlight) return;
  const { type, id } = state.editing;
  const isDoctor = type === 'doctor';
  const ids = isDoctor
    ? ['name','qualification','speciality','hospital_name','mobile_number','address','lat','lng','city','locality','rx_status','core_status','rating','birthday_date','anniversary_date','doctor_commission_details','commission_type','special_notes']
    : ['store_name','chemist_name','mobile_number','address','lat','lng','city','locality','rating','billing_category','special_notes'];

  if (isDoctor) { comboResolve('qualification'); comboResolve('speciality'); }
  const loc = localityCheck();                                   // the locality must be one of the list
  if (!loc.ok) return showToast(loc.message);
  const payload = {};
  ids.forEach(key => {
    const el = document.getElementById(`f-${key}`);
    if (!el) return;
    let v = el.value.trim();
    if (v === '') return;
    if (['lat','lng','monthly_sales_generation','rating'].includes(key)) v = Number(v);
    payload[key] = v;
  });

  if (isDoctor && payload.name !== undefined) {
    payload.name = normalizeDoctorNameClient(payload.name, !id); // one "Dr." only
    if (!payload.name) delete payload.name;
  }
  const nameField = isDoctor ? payload.name : payload.store_name;
  if (!nameField) return showToast(isDoctor ? 'Doctor name is required' : 'Chemist store name is required');
  if (isDoctor && !id) {                          // a NEW doctor must have both chosen
    if (!payload.qualification) return showToast("Select the doctor's qualification");
    if (!payload.speciality) return showToast("Select the doctor's speciality");
  }

  // the mobile number: REQUIRED for a new record; on an old one it stays optional (an emptied box clears it)
  const mobEl = document.getElementById('f-mobile_number');
  if (mobEl) {
    const m = normalizeMobileClient(mobEl.value);
    if (m.error) return showToast(m.error);
    if (!id && !m.value) return showToast('Mobile number is required');
    const had = id && ((state.editing && state.editing.existing) || {}).mobile_number;
    if (m.value) payload.mobile_number = m.value; else if (had) payload.mobile_number = null; else delete payload.mobile_number;
  }

  saveInFlight = true;
  const saveBtn = document.querySelector('#view-edit .action-btn.primary');
  if (saveBtn) { saveBtn.textContent = 'Saving…'; saveBtn.disabled = true; }

  try {
    if (id) {
      isDoctor ? await Api.updateDoctor(id, payload) : await Api.updateChemist(id, payload);
      showToast('Saved');
      if (editFromDetail && history.state && history.state.idx > 0) { reloadDetailOnPop = { type, id }; editFromDetail = false; history.back(); }   // back to the record page, no duplicate entry
      else openDetail(type, id, { replace: true });
    } else {
      // Is it already in the list? (the same name and locality / clinic) — offer to open that one instead of adding a copy.
      // If this check fails for any reason the save simply goes ahead.
      const existing = await findExisting(type, payload);
      if (existing.length && confirm(similarMessage(type, existing))) { openDetail(type, existing[0].id, { replace: true }); return; }
      const created = isDoctor ? await Api.createDoctor(payload) : await Api.createChemist(payload);
      showToast('Added — now log your first visit below');
      openDetail(type, created.id, { replace: true });
    }
  } catch (err) {
    showToast(err.message === 'offline' ? "You're offline — couldn't save." : (err.message || 'Save failed'));
  } finally {
    if (saveBtn) { saveBtn.textContent = 'Save'; saveBtn.disabled = false; }
    saveInFlight = false;
  }
}

async function findExisting(type, payload) {
  try { const r = await Api.findSimilar(type, payload); return Array.isArray(r) ? r : []; } catch (e) { return []; }
}
function similarMessage(type, list) {
  const noun = type === 'doctor' ? 'doctor' : 'chemist';
  const lines = list.slice(0, 3).map(x => `• ${type === 'doctor' ? x.name : (x.display_name || x.store_name)}${x.hospital_name ? ' – ' + x.hospital_name : ''}${x.locality ? ' · ' + x.locality : ''}${x.added_by_name ? ' (added by ' + x.added_by_name + ')' : ''}`);
  return `This ${noun} may already be in the list:\n${lines.join('\n')}\n\nOK = open the one in the list\nCancel = add this as a new ${noun} anyway`;
}


// ===== Reports: my past visits =====
const IST_MS = 5.5 * 3600 * 1000;
const reportState = { range: 'today', from: null, to: null, type: '', mr: '', rows: [], total: 0, loading: false };
const STOCK_WORDS = { supply: 'delivered', sold: 'sold (an old entry)', check: 'counted' }; // 'sold' can no longer be recorded; old entries keep their wording
const repEsc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function istDate(offsetDays = 0) {
  return new Date(Date.now() + IST_MS + offsetDays * 86400000).toISOString().slice(0, 10);
}
function monthRange(monthsBack) {
  const d = new Date(Date.now() + IST_MS);
  const y = d.getUTCFullYear(), m = d.getUTCMonth() - monthsBack;
  return [new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10), new Date(Date.UTC(y, m + 1, 0)).toISOString().slice(0, 10)];
}
function reportRangeDates(r) {
  if (r === 'today') return [istDate(0), istDate(0)];
  if (r === 'yesterday') return [istDate(-1), istDate(-1)];
  if (r === 'week') return [istDate(-6), istDate(0)];
  if (r === 'month') return [monthRange(0)[0], istDate(0)];
  if (r === 'lastmonth') return monthRange(1);
  return [reportState.from, reportState.to];
}

let reportMrLoaded = false;
async function initReportMrFilter() {
  const row = document.getElementById('rp-mr-row'), sel = document.getElementById('rp-mr');
  if (!row || !sel) return;
  const staff = isStaffRole();
  row.style.display = staff ? '' : 'none';
  const h = document.querySelector('#view-reports h1'), sub = document.querySelector('#view-reports .sub');
  if (h) h.textContent = staff ? 'Team Visits' : 'My Visits';
  if (sub) sub.innerHTML = staff ? 'Every MR&#39;s doctor &amp; chemist visits' : 'Your past doctor &amp; chemist visits';
  if (!staff || reportMrLoaded) return;
  try { const f = await Api.getReportFilters(); sel.innerHTML = '<option value="">All MRs</option>' + (f.mrs || []).map(m => `<option value="${m.id}">${repEsc(m.full_name)}</option>`).join(''); reportMrLoaded = true; } catch (e) { /* the list still works for all MRs */ }
}
function setReportMr(id) { reportState.mr = id || ''; loadReports(true); }
function initReports() {
  initReportMrFilter();
  if (!reportState.from) setReportRange('today'); else loadReports(true);
}

function setReportRange(r) {
  reportState.range = r;
  document.querySelectorAll('#rp-range-chips .chip').forEach(b => b.classList.toggle('active', b.dataset.range === r));
  document.getElementById('rp-custom').style.display = r === 'custom' ? 'flex' : 'none';
  if (r === 'custom') {
    document.getElementById('rp-from').value = reportState.from || istDate(-6);
    document.getElementById('rp-to').value = reportState.to || istDate(0);
    return; // wait for "Go"
  }
  [reportState.from, reportState.to] = reportRangeDates(r);
  loadReports(true);
}

function applyCustomRange() {
  const from = document.getElementById('rp-from').value, to = document.getElementById('rp-to').value;
  if (!from || !to) return showToast('Pick both a start and an end date');
  if (from > to) return showToast('The start date must be before the end date');
  reportState.from = from; reportState.to = to;
  loadReports(true);
}

function setReportType(t) {
  reportState.type = t;
  document.querySelectorAll('#rp-type-chips .chip').forEach(b => b.classList.toggle('active', b.dataset.type === t));
  loadReports(true);
}

async function loadReports(reset) {
  if (reportState.loading) return;
  reportState.loading = true;
  const list = document.getElementById('rp-list');
  if (reset) { reportState.rows = []; list.innerHTML = `<div class="loading-row">Loading…</div>`; }
  try {
    const res = await Api.getVisitReport({
      from: reportState.from, to: reportState.to, entity_type: reportState.type, user_id: isStaffRole() ? (reportState.mr || undefined) : undefined,   // the Admin sees every MR (or one)
      sort: reportTools.sort, limit: 50, offset: reportState.rows.length
    });
    reportState.rows = reportState.rows.concat(res.rows);
    reportState.total = res.total;
    renderReports(res.summary);
  } catch (err) {
    list.innerHTML = `<div class="empty-state">Couldn't load your visits. ${err.message === 'offline' ? "You're offline." : ''}</div>`;
  } finally {
    reportState.loading = false;
  }
}

function reportDayLabel(iso) {
  return new Date(iso).toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
}

function reportCardHtml(v) {
  const time = fmtStamp(v.visited_at);
  const area = v.area || '';
  const who = isStaffRole() && v.mr_name ? `<span class="wall-who">👤 ${repEsc(v.mr_name)}</span>` : '';
  const status = v.entity_type === 'doctor'
    ? (v.doctor_rx_status_at_time === 'NON_RX' ? 'target' : v.doctor_rx_status_at_time === 'POTENTIAL' ? 'potential' : v.doctor_rx_status_at_time === 'RX' ? 'prescribing' : '')
    : '';
  const badges = [
    v.entity_type === 'doctor' ? '⚕ Doctor' : '💊 Chemist',
    v.category === 'samples' ? '📦 Samples' : v.category === 'gift' ? '🎁 Gift' : '',
    v.is_first_visit ? '📍 First visit' : '',
    status === 'target' ? 'Non-RX at the time' : status === 'potential' ? 'Potential at the time' : status === 'prescribing' ? 'RX at the time' : ''
  ].filter(Boolean).map(b => `<span class="badge badge-priority-B">${b}</span>`).join('');
  const samples = (v.samples || []).map(s => `${repEsc(s.product)} ×${s.quantity}`).join(', ');
  const stock = (v.stock_updates || []).map(s => `${repEsc(s.product)} — ${STOCK_WORDS[s.type] || s.type} ${s.quantity}`).join('<br>');
  const maps = v.lat != null && v.lng != null ? `https://www.google.com/maps/search/?api=1&query=${v.lat},${v.lng}` : null;
  const note = v.comment_text && v.category !== 'samples' ? repEsc(v.comment_text) : '';
  return `
    <div class="rp-card ${status}">
      <div class="rp-head">
        <div class="rp-name" onclick="openDetail('${v.entity_type}', ${Number(v.entity_id)})">${repEsc(v.entity_name || 'Deleted record')}</div>
        <div class="rp-time">${time}</div>
      </div>
      ${area || who ? `<div class="rp-sub">${repEsc(area)}${area && who ? ' · ' : ''}${who}</div>` : ''}
      <div class="badge-row" style="margin-top:6px">${badges}</div>
      ${samples ? `<div class="rp-line"><b>Samples:</b> ${samples}</div>` : ''}
      ${stock ? `<div class="rp-line"><b>Stock:</b><br>${stock}</div>` : ''}
      ${note ? `<div class="rp-line">${note}</div>` : ''}
      <div class="rp-links">
        ${maps ? `<a href="${maps}" target="_blank" rel="noopener">📍 Location</a>` : ''}
        ${v.photo_url ? `<a href="${repEsc(v.photo_url)}" target="_blank" rel="noopener">${v.category === 'gift' ? '🖼 Gift photo' : '📷 Selfie'}</a>` : ''}
      </div>
    </div>`;
}

const reportTools = { q: '', sort: 'new' };
// the text box filters what is loaded; the ORDER is chosen by the server for the whole period, so changing it starts again at page 1
function setReportTools(key, value) { reportTools[key] = value; if (key === 'sort') loadReports(true); else renderReports(reportState.summary || {}); }
function visibleReportRows() {
  const q = reportTools.q.trim().toLowerCase();
  const rows = reportState.rows.filter(v => !q || [v.entity_name, v.comment_text, v.area, v.category, v.author_name].join(' ').toLowerCase().includes(q));
  return rows;   // already in the server's order
}

function renderReports(summary) {
  reportState.summary = summary;
  const list = document.getElementById('rp-list');
  const units = (summary.samples_by_product || []).reduce((n, p) => n + p.quantity, 0);
  document.getElementById('rp-summary').innerHTML = summary.total
    ? [`${summary.total} visit${summary.total === 1 ? '' : 's'}`, `${summary.unique_doctors} doctor${summary.unique_doctors === 1 ? '' : 's'}`,
       `${summary.unique_chemists} chemist${summary.unique_chemists === 1 ? '' : 's'}`, units ? `${units} samples given` : '']
        .filter(Boolean).map(t => `<span class="rp-pill">${t}</span>`).join('')
    : '';

  if (!reportState.rows.length) {
    list.innerHTML = `<div class="empty-state"><div class="icon">📊</div>No visits in this period.</div>`;
    document.getElementById('rp-more').style.display = 'none';
    return;
  }
  let html = '', lastDay = '';
  const rows = visibleReportRows();
  if (!rows.length) html = `<div class="empty-state"><div class="icon">🔍</div>No visits match this filter.</div>`;
  for (const v of rows) {
    const day = reportDayLabel(v.visited_at);
    if (reportTools.sort !== 'name' && day !== lastDay) { html += `<div class="rp-day">${day}</div>`; lastDay = day; } // day headings only make sense in date order
    html += reportCardHtml(v);
  }
  list.innerHTML = html;
  const more = document.getElementById('rp-more');
  more.style.display = reportState.rows.length < reportState.total ? 'block' : 'none';
  more.textContent = `Load more (${reportState.total - reportState.rows.length} left)`;
}

// ===== Coverage (Reports tab): which of MY doctors need attention =====
const covState = { scope: 'mine', sort: 'priority', filter: 'attention', rows: [], total: 0, summary: null, byRx: [], loading: false, loaded: false, seq: 0 };
function setReportTab(tab) {
  document.querySelectorAll('#rp-tabs .seg').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.getElementById('rp-visits-pane').style.display = tab === 'visits' ? '' : 'none';
  document.getElementById('rp-cov-pane').style.display = tab === 'coverage' ? '' : 'none';
  if (tab === 'coverage') loadMyCoverage(true);
}
const COV_FOCUS = ['never', 'rx_due', 'pot_due', 'no_mobile', 'rx_no_chemist', 'mgr_due'];
const COV_TITLES = { never: 'Doctors never called', rx_due: 'RX doctors due for a call', pot_due: 'Potential doctors due for a follow-up', no_mobile: 'Doctors with no mobile number', rx_no_chemist: 'RX doctors with no chemist linked', mgr_due: 'RX doctors due a manager call' };
// "My doctors" = the ones I added or have called. "Whole team" = every doctor: any MR may call any doctor, and a call by anyone counts.
function setCovScope(s) {
  covState.scope = s === 'all' ? 'all' : 'mine';
  document.querySelectorAll('#cov-scope button').forEach(b => b.classList.toggle('on', b.dataset.s === covState.scope));
  loadMyCoverage(true);
}
function setCovSort(v) {
  covState.sort = v || 'priority';
  // "least / most visited / recently called" are about every doctor, so leave the attention-only view
  if (['least', 'most', 'recent', 'manager'].includes(covState.sort) && covState.filter === 'attention') { covState.filter = 'all'; document.querySelectorAll('#cov-chips .chip').forEach(b => b.classList.toggle('active', b.dataset.f === 'all')); }
  loadMyCoverage(true);
}
function setCovFilter(f) {
  if (covState.filter === f && COV_FOCUS.includes(f)) f = 'all';      // tap a number box again to clear it
  covState.filter = f;
  document.querySelectorAll('#cov-chips .chip').forEach(b => b.classList.toggle('active', b.dataset.f === f));
  loadMyCoverage(true);
}
async function loadMyCoverage(reset) {
  const seq = ++covState.seq, list = document.getElementById('cov-list');
  if (reset) { covState.rows = []; list.innerHTML = `<div class="loading-row">Loading…</div>`; }
  const f = covState.filter;
  try {
    const res = await Api.getMyCoverage({
      type: 'doctor', sort: covState.sort || 'priority', limit: HOME_PAGE, offset: covState.rows.length,
      attention: f === 'attention' ? '1' : '', rx_status: ['RX', 'POTENTIAL', 'NON_RX'].includes(f) ? f : '',
      focus: COV_FOCUS.includes(f) ? f : '', scope: covState.scope === 'all' ? 'all' : ''
    });
    if (seq !== covState.seq) return;                       // an older answer arriving late is ignored
    covState.rows = covState.rows.concat(res.rows || []); covState.total = res.total || 0; covState.summary = res.summary; covState.byRx = res.by_rx || []; covState.period = res.period_days; covState.threshold = res.frequent_threshold || 4; covState.mgrDays = (res.summary && res.summary.mgr_days) || 60; covState.loaded = true;
    renderMyCoverage();
  } catch (err) {
    if (seq !== covState.seq) return;
    list.innerHTML = `<div class="empty-state">Couldn't load coverage — ${repEsc(err.message === 'offline' ? "you're offline" : err.message)}</div>`;
  }
}
function covCardHtml(r) {
  const days = r.days_since, last = r.last_visit_at ? `${fmtStamp(r.last_visit_at)} · ${days === 0 ? 'today' : days === 1 ? 'yesterday' : days + ' days ago'}` : 'Never called';
  const mgrLine = r.is_major ? `<div class="cov-mgr${r.mgr_due ? ' due' : ''}">🧑‍💼 ${r.last_mgr_at ? `Manager call: ${fmtDayYear(r.last_mgr_at)} · ${r.mgr_days_since === 0 ? 'today' : r.mgr_days_since + ' days ago'}${r.last_mgr_name ? ' · ' + repEsc(r.last_mgr_name) : ''}` : 'No manager call yet'}${r.mgr_due ? ' — due' : ''}<br><span class="cov-mgr2">${r.mgr_period || 0} in ${covState.period || 90} days · ${r.mgr_total || 0} in total${(r.mgr_recent || []).length > 1 ? ' · earlier: ' + r.mgr_recent.slice(1).map(m => fmtDayYear(m.at) + (m.manager ? ' (' + repEsc(m.manager) + ')' : '')).join(', ') : ''}</span></div>` : '';
  const myName = Api.user ? Api.user.full_name : '';
  const byOther = r.last_mr && r.last_mr !== myName ? ` · by ${repEsc(r.last_mr)}` : '';
  const ownerLn = covState.scope === 'all' && r.added_by_name ? ` · 👤 ${repEsc(r.added_by_name)}` : '';
  const often = Number(r.period_visits) >= (covState.threshold || 4) ? '<span class="cov-often">🔁 Called often</span>' : '';
  const gaps = [often, !r.has_mobile ? '<span class="cov-gap">📵 No mobile</span>' : '', r.rx_status === 'RX' && !r.chem_links ? '<span class="cov-gap">🔗 No chemist linked</span>' : ''].join('');
  return `<div class="cov-card ${rxBg(r)}" onclick="openDetail('doctor', ${Number(r.id)})">
    <div class="cov-top"><b>${repEsc(r.name)}</b><span class="badge ${r.rx_status === 'RX' ? 'badge-rx' : r.rx_status === 'POTENTIAL' ? 'badge-pot' : 'badge-nonrx'}">${rxLabel(r.rx_status)}</span></div>
    <div class="cov-sub">${repEsc([r.detail, r.locality].filter(Boolean).join(' · '))}${r.rating ? ' · ' + '★'.repeat(r.rating) : ''}${ownerLn}</div>
    ${r.attention ? `<div class="cov-why">⚠ ${repEsc(r.attention)}</div>` : '<div class="cov-ok">✓ On track</div>'}
    <div class="cov-meta">Last call: ${repEsc(last)}${byOther} · ${Number(r.period_visits)} call${Number(r.period_visits) === 1 ? '' : 's'} in ${covState.period || 30} days</div>
    ${mgrLine}
    ${gaps ? `<div class="cov-gaps">${gaps}</div>` : ''}</div>`;
}
function renderMyCoverage() {
  const s = covState.summary || {}, rx = covState.byRx.find(x => x.rx_status === 'RX') || { total: 0, attention: 0 }, pot = covState.byRx.find(x => x.rx_status === 'POTENTIAL') || { total: 0, attention: 0 };
  const tile = (n, l, cls, f) => `<div class="cov-tile click ${cls || ''}${covState.filter === f ? ' sel' : ''}" role="button" onclick="setCovFilter('${f}')"><div class="n">${n}</div><div class="l">${l}</div></div>`;
  document.getElementById('cov-tiles').innerHTML = tile(s.attention || 0, 'need attention', (s.attention ? 'bad' : 'ok'), 'attention') + tile(s.never || 0, 'never called', s.never ? 'bad' : '', 'never')
    + tile(`${rx.attention}/${rx.total}`, 'RX doctors to call', rx.attention ? 'warn' : 'ok', 'rx_due') + tile(`${pot.attention}/${pot.total}`, 'Potential follow-ups', pot.attention ? 'warn' : 'ok', 'pot_due')
    + tile(s.no_mobile || 0, 'no mobile number', s.no_mobile ? 'warn' : 'ok', 'no_mobile') + tile(s.rx_no_chemist || 0, 'RX without chemist', s.rx_no_chemist ? 'warn' : 'ok', 'rx_no_chemist');
  const ft = document.getElementById('cov-focus');
  if (ft) ft.innerHTML = COV_TITLES[covState.filter] ? `<b>${COV_TITLES[covState.filter]}</b> (${covState.total}) · <a href="#" onclick="setCovFilter('${covState.filter}');return false">clear</a>` : `${covState.total} doctor${covState.total === 1 ? '' : 's'}`;
  const mc = document.getElementById('cov-mgr-chip'); if (mc) mc.textContent = `🧑‍💼 Manager due${s.mgr_due ? ' (' + s.mgr_due + ')' : ''}`;
  const so = document.getElementById('cov-sort'); if (so && so.value !== covState.sort) so.value = covState.sort;
  const list = document.getElementById('cov-list');
  list.innerHTML = covState.rows.length ? covState.rows.map(covCardHtml).join('')
    : `<div class="empty-state"><div class="icon">${covState.filter === 'attention' ? '🎉' : '📋'}</div>${covState.filter === 'attention' ? 'Nobody needs attention right now. Well done!' : 'No doctors in this view.'}</div>`;
  const more = document.getElementById('cov-more');
  more.style.display = covState.rows.length < covState.total ? 'block' : 'none';
  more.textContent = `Load more (${covState.total - covState.rows.length} left)`;
}
// ===== end reports =====

// ===== Start Day / End Day =====
function fmtTime(iso) {
  return new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
}

async function loadWorkdayPanel() {
  const panel = document.getElementById('workday-panel');
  panel.innerHTML = `<div class="workday-panel loading-row" style="margin:12px 16px">Loading…</div>`;
  try {
    const wd = await Api.getWorkdayToday();
    renderWorkdayPanel(wd);
  } catch (err) {
    panel.innerHTML = ''; // fail quiet — don't block the rest of Home over this
  }
}

function fmtDateShort(iso) {
  return new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
}

// ===== Area picker: compact searchable dropdown, pick one or more =====
const areaPicker = { areas: [], selected: new Set(), query: '' };

function areaSummaryText() {
  const names = areaPicker.areas.filter(a => areaPicker.selected.has(a.id)).map(a => a.name);
  if (!names.length) return 'Select your working cluster';
  return names.length <= 2 ? names.join(', ') : `${names.length} clusters selected`;
}

function toggleAreaPicker(force) {
  const panel = document.getElementById('area-panel');
  if (!panel) return;
  const open = force !== undefined ? force : panel.style.display === 'none';
  panel.style.display = open ? 'block' : 'none';
  if (open) {
    const search = document.getElementById('area-search');
    if (search) { search.value = ''; areaPicker.query = ''; renderAreaOptions(); search.focus(); }
  }
}

function renderAreaOptions() {
  const box = document.getElementById('area-options');
  if (!box) return;
  const q = areaPicker.query.toLowerCase();
  const list = areaPicker.areas.filter(a => `${a.name} ${a.city_name || ''}`.toLowerCase().includes(q));
  box.innerHTML = list.length
    ? list.map(a => `<label class="area-option"><input type="checkbox" ${areaPicker.selected.has(a.id) ? 'checked' : ''} onchange="toggleArea(${a.id})"> ${repEsc(a.name)}${a.city_name ? ` <span style="color:var(--text-muted);font-size:12px">· ${repEsc(a.city_name)}</span>` : ''}</label>`).join('')
    : `<div class="area-empty">${areaPicker.areas.length ? 'No match' : 'No clusters set up yet'}</div>`;
}

function filterAreas(q) { areaPicker.query = q; renderAreaOptions(); }

function toggleArea(id) {
  areaPicker.selected.has(id) ? areaPicker.selected.delete(id) : areaPicker.selected.add(id);
  const el = document.getElementById('area-summary');
  if (el) el.textContent = areaSummaryText();
}

// tap anywhere outside the dropdown closes it
document.addEventListener('click', (e) => {
  const picker = document.getElementById('area-picker');
  if (picker && !picker.contains(e.target)) toggleAreaPicker(false);
});

// What kind of day is it? The MR must pick one when they start (and can fix it later).
const DAY_TYPES = {
  field_work: 'Field work',
  team_meeting: 'Team meeting',
  team_bonding: 'Team bonding activity',
  training: 'Training',
  other: 'Other'
};
// days saved earlier as Office work / Travel keep their names, but are no longer offered
const dayTypeLabel = (t) => DAY_TYPES[t] || ({ office_work: 'Office work', travel: 'Travel' })[t] || DAY_TYPES.field_work;

// How the MR feels today: 5 great .. 1 unwell. Optional; the admin sees it (and who is unwell) on Home.
const MOODS = [
  { v: 5, face: '😄', label: 'Great' },
  { v: 4, face: '🙂', label: 'Good' },
  { v: 3, face: '😐', label: 'Okay' },
  { v: 2, face: '😕', label: 'Not great' },
  { v: 1, face: '🤒', label: 'Unwell' }
];
const moodOf = (v) => MOODS.find(m => m.v === Number(v)) || null;
const moodOptions = (selected) => `<option value="">Feeling: not set</option>` + MOODS.map(m => `<option value="${m.v}"${m.v === Number(selected) ? ' selected' : ''}>${m.face} ${m.label}</option>`).join('');
let pickedMood = null;
function pickMood(v) {
  pickedMood = pickedMood === v ? null : v; // tap again to un-pick
  document.querySelectorAll('.mood-btn').forEach(b => b.classList.toggle('on', Number(b.dataset.mood) === pickedMood));
}
const moodRowHtml = () => `
  <div class="mood-row">
    <div class="mood-label">How are you feeling today? <span>(optional)</span></div>
    <div class="mood-faces">${MOODS.map(m => `<button type="button" class="mood-btn" data-mood="${m.v}" onclick="pickMood(${m.v})"><span>${m.face}</span><small>${m.label}</small></button>`).join('')}</div>
    <input type="text" id="mood-note" class="day-note" maxlength="300" placeholder="Message (optional)">
  </div>`;
const dayTypeOptions = (selected, withBlank) =>
  (withBlank ? `<option value="">Select today's work…</option>` : '') +
  Object.entries(DAY_TYPES).map(([k, v]) => `<option value="${k}"${k === selected ? ' selected' : ''}>${v}</option>`).join('');

function renderWorkdayPanel(wd) {
  const panel = document.getElementById('workday-panel');

  if (!wd || wd.status === 'not_started') {
    panel.innerHTML = `
      <div class="workday-bar stack">
        <div class="workday-row">
          <select id="day-type" class="daytype-select" onchange="onDayTypeChange()">${dayTypeOptions('', true)}</select>
          <button class="workday-bar-btn start" onclick="startWorkdayAction()">▶ Start Day</button>
        </div>
        ${moodRowHtml()}
 <div class="area-picker" id="area-picker" style="display:none">
          <div class="mood-label" style="margin-bottom:4px">Working cluster today <span style="color:#C0392B">*</span></div>
          <button type="button" class="area-trigger" onclick="toggleAreaPicker()">
            <span id="area-summary">${areaSummaryText()}</span><span class="area-caret">▾</span>
          </button>
          <div class="area-panel" id="area-panel" style="display:none">
            <input type="text" id="area-search" class="area-search" placeholder="Search cluster…" oninput="filterAreas(this.value)">
            <div id="area-options" class="area-options"></div>
          </div>
        </div>
        <input type="text" id="day-note" class="day-note" maxlength="200" style="display:none" placeholder="What is it?">
        <button type="button" class="link-btn" style="align-self:flex-start" onclick="openDayEditor()">Edit earlier days</button>
      </div>`;
    if (areaPicker.areas.length) {
      renderAreaOptions();
    } else {
      Api.getClusters().then(areas => {
        areaPicker.areas = areas;
        renderAreaOptions();
        const el = document.getElementById('area-summary');
        if (el) el.textContent = areaSummaryText();
      }).catch(() => { /* picker just shows "No areas set up yet" */ });
    }
    return;
  }

  const areaNames = (wd.clusters || []).map(c => c.name).filter(Boolean).join(', ');
  const areaText = areaNames ? ` · ${areaNames}` : '';
  const face = moodOf(wd.mood);
  const type = `<b>${dayTypeLabel(wd.day_type)}</b>${wd.day_note ? ` (${repEsc(wd.day_note)})` : ''}${face ? `<span class="mood-chip" title="${face.label}">${face.face}</span>` : ''}`;
  if (wd.status === 'open') {
    panel.innerHTML = `
      <div class="workday-bar open stack">
        <div class="workday-row">
          <span class="workday-bar-label">✅ ${type}<br><span class="workday-sub">Started ${fmtTime(wd.started_at)}, ${fmtDateShort(wd.started_at)}${areaText}</span></span>
          <button class="workday-bar-btn end" onclick="endWorkdayAction()">⏹ End Day</button>
        </div>
        <button type="button" class="link-btn" style="align-self:flex-start" onclick="openDayEditor()">Change day type / feeling</button>
      </div>`;
  } else {
    panel.innerHTML = `
      <div class="workday-bar closed stack">
        <span class="workday-bar-label">🏁 ${type}<br><span class="workday-sub">${fmtTime(wd.started_at)} – ${fmtTime(wd.ended_at)}, ${fmtDateShort(wd.started_at)}${areaText}</span></span>
        <button type="button" class="link-btn" style="align-self:flex-start" onclick="openDayEditor()">Change day type / feeling</button>
      </div>`;
  }
}

// Areas only matter for field work; "Other" gets a short description.
function onDayTypeChange() {
  const t = document.getElementById('day-type').value;
  const picker = document.getElementById('area-picker'), note = document.getElementById('day-note');
  if (picker) picker.style.display = t === 'field_work' ? '' : 'none';
  if (note) note.style.display = t === 'other' ? '' : 'none';
}

async function startWorkdayAction() {
  const sel = document.getElementById('day-type');
  const day_type = sel ? sel.value : '';
  if (!day_type) return showToast("Select today's work first");
  const noteEl = document.getElementById('day-note');
  const day_note = day_type === 'other' && noteEl ? noteEl.value.trim() : '';
  const moodNoteEl = document.getElementById('mood-note');
  const mood_note = moodNoteEl ? moodNoteEl.value.trim() : '';
  // a field day needs the cluster the MR is working in (it describes the DAY, never a doctor's or chemist's location)
  if (day_type === 'field_work' && areaPicker.areas.length && !areaPicker.selected.size) return showToast('Select the cluster you are working in today');

  showToast('📍 Capturing your location…');
  const loc = await captureGeolocation();
  if (!loc) return showToast("Couldn't get your location — enable GPS and try again");

  try {
    await Api.startWorkday(day_type === 'field_work' ? Array.from(areaPicker.selected) : [], loc.lat, loc.lng, day_type, day_note || null, pickedMood, mood_note || null);
    areaPicker.selected = new Set();
    pickedMood = null;
    showToast('Day started — have a good day!');
    loadWorkdayPanel();
  } catch (err) {
    showToast(err.message === 'offline' ? "You're offline — couldn't start the day." : (err.message || 'Could not start the day'));
  }
}

async function endWorkdayAction() {
  if (!confirm('End your day now? This records your current location as your end-of-day check-out.')) return;
  showToast('📍 Capturing your location…');
  const loc = await captureGeolocation();
  if (!loc) return showToast("Couldn't get your location — enable GPS and try again");

  try {
    await Api.endWorkday(loc.lat, loc.lng);
    showToast('Day closed — see you tomorrow!');
    loadWorkdayPanel();
  } catch (err) {
    showToast(err.message === 'offline' ? "You're offline — couldn't end the day." : (err.message || 'Could not end the day'));
  }
}

// ----- fix the type of today, or of any of the last 7 days -----
function dayRowLabel(ymd) {
  if (ymd === istDate(0)) return 'Today';
  if (ymd === istDate(-1)) return 'Yesterday';
  return new Date(`${ymd}T12:00:00`).toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short' });
}

let dayEditorRows = [];
async function openDayEditor() {
  const box = document.getElementById('day-editor');
  if (!box) return;
  if (box.innerHTML) { box.innerHTML = ''; return; }
  box.innerHTML = `<div class="day-editor"><div class="loading-row">Loading…</div></div>`;
  try {
    const days = await Api.getRecentWorkdays();
    dayEditorRows = days;
    box.innerHTML = `
      <div class="day-editor">
        ${days.length ? days.map(d => `
          <div class="day-row">
            <div><b>${dayRowLabel(d.work_date)}</b><div class="workday-sub">${d.doctor_calls} doctor · ${d.chemist_calls} chemist calls</div></div>
            <div style="display:flex;flex-direction:column;gap:6px;align-items:flex-end;max-width:60%">
              <select onchange="saveDayType('${d.work_date}', this.value)">${dayTypeOptions(d.day_type, false)}</select>
              <select onchange="saveDayMood('${d.work_date}', this.value)">${moodOptions(d.mood)}</select>
            </div>
          </div>`).join('') : `<div class="empty-note">No days started in the last 7 days.</div>`}
        <button type="button" class="link-btn" onclick="openDayEditor()">Close</button>
      </div>`;
  } catch (err) {
    box.innerHTML = `<div class="day-editor"><div class="empty-note">Couldn't load your days.</div></div>`;
  }
}

async function saveDayMood(date, value) {
  const row = dayEditorRows.find(d => d.work_date === date);
  try {
    await Api.updateWorkdayMood(date === istDate(0) ? 'today' : date, value === '' ? null : Number(value), row && row.mood_note);
    if (row) row.mood = value === '' ? null : Number(value);
    showToast('Saved');
    loadWorkdayPanel();
  } catch (err) {
    showToast(err.message === 'offline' ? "You're offline — couldn't save." : (err.message || 'Could not save'));
  }
}

async function saveDayType(date, type) {
  try {
    await Api.updateWorkdayType(date === istDate(0) ? 'today' : date, type);
    showToast('Saved');
    loadWorkdayPanel();
  } catch (err) {
    showToast(err.message === 'offline' ? "You're offline — couldn't save." : (err.message || 'Could not save'));
  }
}

// ===== Boot =====
function updateOfflineBanner() {
  document.getElementById('offline-banner').classList.toggle('show', !navigator.onLine);
}

const ROLE_LABELS = { mr: 'Medical Representative', super: 'Super User', admin: 'Admin' };
function isAdminRole() { return Api.user?.role === 'admin'; }
function isStaffRole() { return ['admin', 'super'].includes(Api.user?.role); }
// ===== My profile: photo, mobile number, e-mail, birthday =====
function renderAvatar() {
  const btn = document.getElementById('avatar-btn');
  if (!btn) return;
  const u = Api.user || {};
  btn.innerHTML = u.photo_url ? `<img src="${repEsc(thumbUrl(u.photo_url, 96))}" alt="">` : repEsc(initials(u.full_name || '?'));
}

function openProfile() {
  renderProfile();
  showView('profile');
}

function renderProfile() {
  const u = Api.user || {};
  document.getElementById('profile-body').innerHTML = `
    <div class="profile-body">
      <div class="profile-photo">
        <div class="profile-avatar" id="profile-avatar">${u.photo_url ? `<img src="${repEsc(thumbUrl(u.photo_url, 300))}" alt="">` : repEsc(initials(u.full_name || '?'))}</div>
        <input type="file" id="profile-file" accept="image/*" style="display:none" onchange="onProfilePhoto(event)">
        <button type="button" class="action-btn secondary" id="profile-photo-btn" onclick="document.getElementById('profile-file').click()">${u.photo_url ? 'Change photo' : 'Add photo'}</button>
        <div class="profile-name">${repEsc(u.full_name || '')}</div>
        <div class="profile-role">${repEsc(ROLE_LABELS[u.role] || '')}</div>
      </div>
      <div class="form-field"><label>Username</label><input type="text" value="${repEsc(u.username || '')}" readonly></div>
      <div class="form-field"><label>Mobile number</label><input type="tel" id="pf-phone" inputmode="tel" maxlength="20" value="${repEsc(u.phone || '')}"></div>
      <div class="form-field"><label>E-mail</label><input type="email" id="pf-email" maxlength="120" value="${repEsc(u.email || '')}"></div>
      <div class="form-field"><label>Birthday</label><input type="date" id="pf-birthday" max="${istDate(0)}" value="${repEsc(u.birthday || '')}"></div>
      <button class="action-btn primary" id="pf-save" style="width:100%;padding:13px 0" onclick="saveProfile()">Save</button>
    </div>`;
}

function applyProfile(me) {
  Api.user = { ...Api.user, phone: me.phone, email: me.email, birthday: me.birthday, photo_url: me.photo_url };
  try { localStorage.setItem('zv_user', JSON.stringify(Api.user)); } catch (e) { /* kept for this session only */ }
  renderAvatar();
}

async function onProfilePhoto(event) {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  const btn = document.getElementById('profile-photo-btn');
  btn.disabled = true; btn.textContent = 'Uploading…';
  try {
    const url = await Api.uploadPhoto(file, { maxDim: 512, quality: 0.8 }); // a profile picture does not need to be big
    const me = await Api.updateProfile({ photo_url: url });
    applyProfile(me);
    renderProfile();
    showToast('Photo updated');
  } catch (err) {
    showToast(err.message === 'offline' ? "You're offline — couldn't upload." : (err.message || 'Could not upload the photo'));
    btn.disabled = false; btn.textContent = (Api.user && Api.user.photo_url) ? 'Change photo' : 'Add photo';
  }
}

async function saveProfile() {
  const val = (id) => document.getElementById(id).value.trim();
  const phone = val('pf-phone'), email = val('pf-email'), birthday = val('pf-birthday');
  if (phone && !/^\+?\d{7,15}$/.test(phone.replace(/[\s-]/g, ''))) return showToast('Enter a valid mobile number');
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return showToast('Enter a valid e-mail address');
  const btn = document.getElementById('pf-save');
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    const me = await Api.updateProfile({ phone, email, birthday }); // an empty box clears that detail
    applyProfile(me);
    showToast('Profile saved');
  } catch (err) {
    showToast(err.message === 'offline' ? "You're offline — couldn't save." : (err.message || 'Could not save'));
  } finally { btn.disabled = false; btn.textContent = 'Save'; }
}

function updateWelcome() {
  const el = document.getElementById('welcome-name');
  if (el) el.textContent = [Api.user?.full_name, ROLE_LABELS[Api.user?.role]].filter(Boolean).join(' · ');
  renderAvatar();
}

function boot() {
  updateWelcome();
  Api.refreshMe().then(updateWelcome); // pick up any role change made since last login
  const nav = readNav();                     // where you were before a refresh
  applyHomeNav(nav);
  showView('list', true); // replace: don't leave the login screen as a back-target
  setTab(nav && nav.tab ? nav.tab : 'doctor');
  loadWorkdayPanel();
  resumeAfterCamera(); // the phone closed the app while the camera was open? go back to that doctor
  restoreNav(nav);                           // ...otherwise go back to the page you were on
  loadHomeCards();                           // today's plan, reminders and my month
  initHomePager();                           // the Wall is page 1, Doctor / Chemist Calls page 2
  loadLocalityNames();                       // the locality list for the doctor / chemist forms
  loadWall();
  updateOutboxBar();
  Api.syncOutbox();                          // anything saved on the phone while offline
}

window.addEventListener('online', () => { updateOfflineBanner(); Api.syncOutbox(); });
setInterval(() => { if (navigator.onLine && Api.isLoggedIn()) Api.syncOutbox(); }, 45000);   // waiting calls upload by themselves
window.addEventListener('offline', updateOfflineBanner);

document.addEventListener('DOMContentLoaded', () => {
  updateOfflineBanner();
  document.getElementById('login-form').addEventListener('submit', handleLogin);

  if (Api.isLoggedIn()) {
    boot();
  } else {
    showView('login', true);
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
});

// ===== Change owner: any team member can hand a doctor / chemist to another team member (the audit log records who did it) =====
async function openOwnerSheet(type, id) {
  openSheet('Change owner', '<div class="loading-row">Loading…</div>');
  const t = await loadTeam();
  const rec = (state.currentEntity && state.currentEntity.rec) || {};
  const cur = ownerName(rec) || '';
  const me = Api.user ? Api.user.id : null;
  const curId = rec.owner_id != null ? rec.owner_id : rec.created_by;
  const others = (t.everyone || []).filter(u => u.id !== curId);
  setSheetBody(`
    <div class="own-sheet">
      <div class="own-cur">Current owner: <b>${repEsc(cur || 'nobody')}</b></div>
      ${curId !== me ? `<button type="button" class="action-btn primary" style="width:100%" onclick="setOwner('${type}', ${Number(id)}, ${Number(me)})">🙋 Make me the owner</button>
      <div class="own-or">or give it to</div>` : '<div class="own-or">Give it to</div>'}
      <select id="own-sel" aria-label="New owner">${others.map(u => `<option value="${u.id}">${repEsc(u.full_name)}${u.role !== 'mr' ? ' (' + (u.role === 'admin' ? 'Admin' : 'Manager') + ')' : ''}</option>`).join('')}</select>
      <button type="button" class="action-btn secondary" style="width:100%;margin-top:8px" onclick="setOwner('${type}', ${Number(id)}, Number(document.getElementById('own-sel').value))">Change owner</button>
      <div class="own-note">The new owner sees this ${type} in their lists and gets its open reminders. Calls by anyone still count for coverage.</div>
    </div>`);
}
async function setOwner(type, id, ownerId) {
  if (!ownerId) return showToast('Choose the new owner');
  try {
    const r = await Api.changeOwner(type, id, ownerId);
    closeSheet();
    showToast(`Owner changed to ${r.owner_name}`);
    needsListReload = true;
    if (covState) covState.loaded = false;
    openDetail(type, id, { replace: true });
  } catch (err) {
    showToast(err.message === 'offline' ? "You're offline — couldn't change the owner." : (err.message || 'Could not change the owner'));
  }
}
