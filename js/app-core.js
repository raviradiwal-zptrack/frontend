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
    rememberLoginId(username);
    boot();
  } catch (err) {
    errBox.textContent = err.message === 'offline' ? "You're offline — connect and try again." : 'Invalid username or password.';
    errBox.style.display = 'block';
  }
}

// ----- login comfort: show the password, remember the user ID on this phone, and what to do when the password is forgotten -----
const LAST_ID_KEY = 'zv_last_user_id';
function rememberLoginId(username) {
  try {
    const on = document.getElementById('login-remember');
    if (on && on.checked) localStorage.setItem(LAST_ID_KEY, username); else localStorage.removeItem(LAST_ID_KEY);
  } catch (e) { /* private mode: nothing is remembered, signing in still works */ }
}
function initLoginComfort() {
  const pw = document.getElementById('login-password'), show = document.getElementById('pw-show');
  if (!pw || !show) return;
  show.addEventListener('click', () => {
    const hidden = pw.type === 'password';
    pw.type = hidden ? 'text' : 'password';
    show.textContent = hidden ? 'Hide' : 'Show';
    show.setAttribute('aria-pressed', String(hidden)); show.setAttribute('aria-label', hidden ? 'Hide password' : 'Show password');
  });
  const forgot = document.getElementById('login-forgot'), help = document.getElementById('login-help');
  forgot.addEventListener('click', () => {
    const open = help.style.display === 'block';
    help.style.display = open ? 'none' : 'block'; forgot.setAttribute('aria-expanded', String(!open));
  });
  try {
    const last = localStorage.getItem(LAST_ID_KEY);
    if (last) { document.getElementById('login-username').value = last; document.getElementById('login-remember').checked = true; pw.focus(); }
  } catch (e) { /* nothing remembered */ }
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
