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

// ----- my month: days worked, DA days, leave, calls, and targets (v2.24.0: pick any month) -----
let myMonthSel = null;
const ymShift = (ym, n) => { const d = new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7) - 1 + n, 1)); return d.toISOString().slice(0, 7); };
const ymLabel = (ym) => new Date(ym + '-01T00:00:00Z').toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const dayChip = (d) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
async function openMonthSheet(go) {
  const thisMonth = istDate(0).slice(0, 7);
  if (go === 'prev') myMonthSel = ymShift(myMonthSel || thisMonth, -1);
  else if (go === 'next') myMonthSel = ymShift(myMonthSel || thisMonth, 1);
  else myMonthSel = thisMonth;
  if (myMonthSel > thisMonth) myMonthSel = thisMonth;
  const month = myMonthSel, isNow = month === thisMonth;
  openSheet('My month', '<div class="loading-row">Loading…</div>');
  const [m, d] = await Promise.all([Api.getMyTargets(month).catch(() => null), Api.getMyMonth(month).catch(() => null)]);
  if (month !== myMonthSel) return;                                          // another month was chosen while this one loaded
  if (isNow && m) { homeCards.month = m; try { renderHomeCards(); } catch (e) { /* the Home tile refreshes next time; the sheet must still open */ } }
  if (!m && !d) return setSheetBody('<div class="empty-note">Could not load your month. Check your signal and try again.</div>');
  const nav = `<div class="mm-nav"><button type="button" class="mm-b" aria-label="Previous month" onclick="openMonthSheet('prev')">◀</button><b>${repEsc(ymLabel(month))}</b><button type="button" class="mm-b" aria-label="Next month" ${isNow ? 'disabled' : ''} onclick="openMonthSheet('next')">▶</button></div>`;
  const cell = (n, l) => `<div class="mm-c"><div class="mm-n">${n}</div><div class="mm-l">${l}</div></div>`;
  let days = '';
  if (d && d.found) {
    const nm = d.not_marked_dates || [];
    days = `<div class="mm-grid">${cell(d.worked_days, `Days worked<br><small>of ${d.working_days} working days</small>`)}${cell(d.da_days, 'Daily allowance days')}${cell(d.doctor_calls, 'Doctor calls')}${cell(d.chemist_calls, 'Chemist calls')}${cell(d.paid_leave, 'Leave')}${cell(d.lwp, 'Leave without pay')}</div>`
      + (nm.length ? `<div class="mm-note">⚠ ${nm.length} past working day${nm.length === 1 ? '' : 's'} with no Start Day and no calls: ${nm.slice(0, 8).map(dayChip).join(', ')}${nm.length > 8 ? '…' : ''}. If you were working, tell your manager.</div>` : '')
      + `<div class="mm-fine">These are counted the same way as your month-end pay summary. Your Admin gives the final figure.</div>`;
  } else if (!d) days = '<div class="mm-fine">Your days could not be loaded just now.</div>';
  const rows = m ? (m.metrics || []).map(k => {
    const t = (m.targets || {})[k.key], a = ((m.actual || {})[k.key]) || 0;
    if (!(t > 0)) return `<div class="sh-row"><div class="sh-main"><div class="sh-name">${repEsc(k.label)}</div></div><div>${a}</div></div>`;
    const p = m.pct[k.key], good = p >= m.pace_pct;
    return `<div style="padding:8px 0;border-bottom:1px solid var(--border)"><div style="display:flex;justify-content:space-between"><b>${repEsc(k.label)}</b><span><b>${a}</b> / ${t} · ${p}%</span></div><div class="sh-bar"><div style="width:${Math.min(100, p)}%;background:${good ? '#2E7D3A' : '#C0392B'}"></div></div></div>`;
  }).join('') : '';
  const has = m && m.overall_pct !== null && m.overall_pct !== undefined;
  const targets = !m ? '' : `<h4 class="mm-h">Targets</h4>` + (has
    ? `<div style="font-size:26px;font-weight:800;color:var(--purple)">${m.overall_pct}%</div><div style="font-size:13px;color:var(--text-muted);margin-bottom:6px">${m.on_track ? '✅ On track' : '⚠ Behind'}${isNow ? ` — about ${m.pace_pct}% of the month's working days have passed.` : '.'}</div>`
    : `<div class="empty-note" style="padding:10px 0">No targets were set for you this month. Your Admin sets them in the portal. Here is what you have done:</div>`) + rows;
  setSheetBody(nav + days + targets);
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

  if (isNew) initDupWatch(type);

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
// ----- v2.24.0: a warning on the Add form AS SOON AS the name / mobile matches somebody already in the list (the check at Save stays as the safety net) -----
let dupTimer = null, dupSeq = 0;
function dupFields(type) {
  const g = (id) => { const el = document.getElementById(id); return el ? el.value.trim() : ''; };
  const mob = normalizeMobileClient(g('f-mobile_number'));
  return type === 'doctor'
    ? { name: g('f-name'), hospital_name: g('f-hospital_name'), locality: g('f-locality'), mobile_number: mob.value || '' }
    : { store_name: g('f-store_name'), locality: g('f-locality'), mobile_number: mob.value || '' };
}
function initDupWatch(type) {
  const wrap = document.getElementById('edit-form-fields'); if (!wrap) return;
  const mobField = document.getElementById('f-mobile_number') && document.getElementById('f-mobile_number').closest('.form-field');
  if (!mobField) return;
  let box = document.getElementById('dup-box');
  if (!box) { box = document.createElement('div'); box.id = 'dup-box'; box.setAttribute('role', 'status'); box.setAttribute('aria-live', 'polite'); }
  mobField.insertAdjacentElement('afterend', box); box.innerHTML = '';
  const run = () => { clearTimeout(dupTimer); dupTimer = setTimeout(() => checkDuplicatesLive(type), 450); };
  ['f-name', 'f-store_name', 'f-hospital_name', 'f-mobile_number'].forEach(id => { const el = document.getElementById(id); if (el) { el.addEventListener('input', run); el.addEventListener('blur', run); } });
}
async function checkDuplicatesLive(type) {
  const box = document.getElementById('dup-box'); if (!box || !state.editing || state.editing.id) return;
  const my = ++dupSeq;
  const list = await findExisting(type, dupFields(type));
  if (my !== dupSeq || !document.getElementById('dup-box')) return;                  // a newer check has started, or the form was closed
  if (!list.length) { box.innerHTML = ''; return; }
  const noun = type === 'doctor' ? 'doctor' : 'chemist';
  const rows = list.slice(0, 3).map(x => {
    const nm = type === 'doctor' ? x.name : (x.display_name || x.store_name);
    const why = x.mobile_match && x.name_match ? 'same name and mobile number' : x.mobile_match ? 'same mobile number' : 'same name' + (x.locality ? ' in ' + x.locality : '');
    return `<li><b style="display:inline">${repEsc(nm)}</b>${x.hospital_name ? ' – ' + repEsc(x.hospital_name) : ''}${x.locality ? ' · ' + repEsc(x.locality) : ''}${x.added_by_name ? ' · added by ' + repEsc(x.added_by_name) : ''}<br><small>${why}</small> <button type="button" class="action-btn secondary" style="width:auto;padding:6px 12px;margin:2px 0" onclick="openDetail('${type}', ${Number(x.id)}, { replace: true })">Open this ${noun}</button></li>`;
  }).join('');
  box.innerHTML = `<div class="dup-box"><b>⚠ This ${noun} may already be in the list</b><ul>${rows}</ul>If it is the same one, open it instead of adding a copy. If it is a different one, carry on.</div>`;
}
function similarMessage(type, list) {
  const noun = type === 'doctor' ? 'doctor' : 'chemist';
  const lines = list.slice(0, 3).map(x => `• ${type === 'doctor' ? x.name : (x.display_name || x.store_name)}${x.hospital_name ? ' – ' + x.hospital_name : ''}${x.locality ? ' · ' + x.locality : ''}${x.added_by_name ? ' (added by ' + x.added_by_name + ')' : ''}${x.mobile_match ? ' — same mobile number' : ''}`);
  return `This ${noun} may already be in the list:\n${lines.join('\n')}\n\nOK = open the one in the list\nCancel = add this as a new ${noun} anyway`;
}
