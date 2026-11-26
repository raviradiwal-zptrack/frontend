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
    <div class="addcall-bar"><button type="button" class="addcall-btn" onclick="openCallSheet()">➕ Add call</button></div>
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
      <div class="comment-composer"><button type="button" class="action-btn primary" style="width:100%" onclick="openCallSheet()">➕ Add call</button></div>
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
  const meetBadge = v.meet_status ? `<span class="meet-badge ${v.meet_status}">${({ met: '✔ Met', not_met: '✖ Not met', assistant: '👥 Met assistant' })[v.meet_status] || ''}</span>` : '';
  const mgrBadge = v.is_manager_call ? `<span class="mgr-badge">🧑‍💼 Manager call${v.manager_name ? ' with ' + repEsc(v.manager_name) : ''}</span>` : '';
  const lines = v.category === 'samples' ? sampleLines(v) : [];
  const text = lines.length ? lines.map(s => `${repEsc(s.product)} × ${s.quantity}`).join(', ') : (v.comment_text ? repEsc(v.comment_text) : '');
  return `
  <div class="comment-item ${rxClass}" id="visit-${v.id}">
    <div class="comment-head">
      <span class="comment-author">${repEsc(v.author_name)}</span>
      <span class="comment-time">${timeAgo(v.visited_at)}</span>
    </div>
    ${categoryBadge || mgrBadge || meetBadge ? `<div style="margin-bottom:5px">${categoryBadge}${mgrBadge}${meetBadge}</div>` : ''}
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
