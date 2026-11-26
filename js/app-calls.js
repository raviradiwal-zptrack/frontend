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
