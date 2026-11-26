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
  postBtn.textContent = 'Save';
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
  if (blocked) { box.innerHTML = callBlockerHtml(blocked); pendingSelfie = null; const pb0 = document.getElementById('btn-post-comment'); if (pb0) { pb0.disabled = true; pb0.style.opacity = '0.4'; } return; }
  const needed = selfieRequired();
  const _ce = state.currentEntity, canMgr = !!(_ce && _ce.type === 'doctor' && _ce.rec && ['RX', 'POTENTIAL'].includes(_ce.rec.rx_status));   // manager calls are for RX and Potential doctors only
  if (!canMgr) callKind = 'visit';
  box.innerHTML = `
    <div class="call-kind" id="call-kind" role="tablist" style="display:${canMgr ? 'flex' : 'none'}">
      <button type="button" class="ck${callKind === 'visit' ? ' active' : ''}" data-k="visit" onclick="setCallKind('visit')">Visit</button>
      <button type="button" class="ck${callKind === 'manager' ? ' active' : ''}" data-k="manager" onclick="setCallKind('manager')">🧑‍💼 Manager call</button>
    </div>
    <div id="mgr-pick" class="mgr-pick" style="display:${callKind === 'manager' ? 'block' : 'none'}"><label class="field-label" for="mgr-select">Manager with you</label><select id="mgr-select"><option value="">Loading…</option></select></div>
    <div class="field-label" style="margin-top:4px">${_ce && _ce.type === 'chemist' ? 'Did you meet the chemist?' : 'Did you meet the doctor?'} *</div>
    <div class="meet-row" id="meet-row">${meetChipsHtml()}</div>
    <div id="selfie-capture-area">${selfieButtonHtml()}</div>
    <div id="selfie-status" style="font-size:12px;margin-top:6px"></div>
    <label class="field-label" for="comment-input">Comment</label>
    <div class="qr-row" id="qr-row" aria-label="Quick responses"></div>
    <textarea id="comment-input"></textarea>
  `;
  const pb = document.getElementById('btn-post-comment');          // the Save button lives in the form's top bar
  if (pb) { pb.disabled = needed; pb.style.opacity = needed ? '0.4' : '1'; }
  pendingSelfie = null;
  fillQuickResponses();
  if (callKind === 'manager') fillManagerSelect();
}


// ----- quick responses: one-tap phrases for the comment (the Admin controls the list, how many show at first, and On/Off: Portal > Users > Settings) -----
const QR_KEY = 'zv_quick_responses2';
const QR_DEFAULT = { enabled: true, show_first: 4, items: ['Prescriptions on-going', 'Less patient flow', 'Ok. Let’s see', 'Need manager call', 'No requirement. Activity full', 'Stock is full', 'Standard company products only', 'Discuss activity with manager', 'Keep follow-up'] };
let qr = null, qrOpen = false;
function qrSaved() { try { const a = JSON.parse(localStorage.getItem(QR_KEY) || 'null'); return a && Array.isArray(a.items) ? a : null; } catch (e) { return null; } }
async function fillQuickResponses() {
  const row = document.getElementById('qr-row');
  if (!row) return;
  if (!qr) qr = qrSaved() || QR_DEFAULT;
  qrOpen = false;
  const draw = () => {
    const input = document.getElementById('comment-input'), cur = input ? input.value.toLowerCase() : '';
    row.style.display = qr.enabled && qr.items.length ? '' : 'none';
    // the first few, plus anything already picked; "More" shows the rest
    const shown = qr.items.map((t, i) => ({ t, i, on: cur.includes(t.toLowerCase()) })).filter((x, k) => qrOpen || k < qr.show_first || x.on);
    const hidden = qr.items.length - shown.length;
    row.innerHTML = shown.map(x => `<button type="button" class="qr-chip${x.on ? ' on' : ''}" data-i="${x.i}">${repEsc(x.t)}</button>`).join('')
      + (hidden > 0 ? `<button type="button" class="qr-more" data-more="1">More (${hidden}) ▾</button>` : (qrOpen && qr.items.length > qr.show_first ? '<button type="button" class="qr-more" data-more="1">Fewer ▴</button>' : ''));
  };
  draw();
  row.onclick = (e) => {
    const m = e.target.closest('.qr-more'); if (m) { qrOpen = !qrOpen; draw(); return; }
    const b = e.target.closest('.qr-chip'); if (!b) return;
    const input = document.getElementById('comment-input'), t = qr.items[Number(b.dataset.i)];
    if (!input || !t) return;
    const v = input.value, low = v.toLowerCase(), at = low.indexOf(t.toLowerCase());
    if (at >= 0) input.value = (v.slice(0, at) + v.slice(at + t.length)).replace(/^[\s.;,]+/, '').replace(/\s*;\s*;/g, ';').replace(/\s{2,}/g, ' ').trim();   // tap again to take it back out
    else input.value = v.trim() ? v.replace(/[\s;]+$/, '') + '; ' + t : t;
    draw();
  };
  const input = document.getElementById('comment-input'); if (input) input.addEventListener('input', draw);
  try {                                                              // the latest settings from the Admin (kept on the phone for offline use)
    const r = await Api.getQuickResponses();
    if (r && Array.isArray(r.items)) { qr = { enabled: r.enabled !== false, show_first: r.show_first || 4, items: r.items }; try { localStorage.setItem(QR_KEY, JSON.stringify(qr)); } catch (e) { /* kept for this visit only */ } draw(); }
  } catch (e) { /* offline: the saved list stays */ }
}


// ===== The "Add call" screen: a full-screen form (visit or manager call, who was met, quick responses, comment, selfie) =====
let meetStatus = null;
function meetChipsHtml() {
  const ce = state.currentEntity, who = ce && ce.type === 'chemist' ? ['chemist', 'staff'] : ['doctor', 'assistant'];
  const opts = [['met', `✔ Met ${who[0]}`], ['not_met', `✖ Did not meet ${who[0]}`], ['assistant', `👥 Met ${who[1]}`]];
  return opts.map(([k, t]) => `<button type="button" class="meet-chip ${k}${meetStatus === k ? ' on' : ''}" data-m="${k}" onclick="setMeetStatus('${k}')">${t}</button>`).join('');
}
function setMeetStatus(k) {
  meetStatus = meetStatus === k ? null : k;
  const row = document.getElementById('meet-row'); if (row) row.innerHTML = meetChipsHtml();
}
let callSheetOpen = false;
function openCallSheet() {
  if (!state.currentEntity || document.getElementById('call-sheet')) return;
  meetStatus = null;
  if (!(state.currentEntity.type === 'doctor' && state.currentEntity.rec && ['RX', 'POTENTIAL'].includes(state.currentEntity.rec.rx_status))) callKind = 'visit';
  const el = document.createElement('div');
  el.id = 'call-sheet'; el.className = 'call-sheet';
  el.innerHTML = `<div class="cs-head"><button type="button" class="cs-x" aria-label="Close" onclick="closeCallSheet()">✕</button><div class="cs-title">Add call<small>${repEsc(state.currentLabel || '')}</small></div><button type="button" class="cs-save" id="btn-post-comment" onclick="postComment()" disabled style="opacity:0.4">Save</button></div>
    <div class="cs-body"><div class="comment-composer"><div id="comment-composer-body"></div></div></div>`;
  document.body.appendChild(el);
  document.body.classList.add('cs-open');
  callSheetOpen = true;
  try { history.pushState(Object.assign({}, history.state || {}, { sheet: 1 }), '', location.hash); } catch (e) { /* the ✕ button still closes it */ }
  renderCommentComposerBody();
}
function closeCallSheet(fromBack) {
  const el = document.getElementById('call-sheet');
  if (el) el.remove();
  document.body.classList.remove('cs-open');
  if (!callSheetOpen) return;
  callSheetOpen = false;
  if (!fromBack) { try { if (history.state && history.state.sheet) history.back(); } catch (e) { /* ignore */ } }   // take our own history step back off
}
window.addEventListener('popstate', () => { if (callSheetOpen) closeCallSheet(true); });   // the phone's Back button closes the form first
