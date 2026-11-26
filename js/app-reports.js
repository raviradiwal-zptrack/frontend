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
const COV_TITLES = { never: 'Doctors never called', rx_due: 'RX doctors due for a call', pot_due: 'Potential doctors due for a follow-up', no_mobile: 'Doctors with no mobile number', rx_no_chemist: 'RX doctors with no chemist linked', mgr_due: 'RX / Potential doctors due a manager call' };
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
