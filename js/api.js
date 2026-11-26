// Set this to your deployed API base URL, e.g. "https://api.zivanta.example.com/api"
const API_BASE = window.ZIVANTA_API_BASE || '/api';

// ===== Offline support =====
// 1) READ CACHE: every page of data you open is also kept on the phone, so with no signal the lists and the doctor / chemist pages you
//    have already opened still show (marked "saved data"). Cleared when you sign out.
// 2) OUTBOX: a call (comment, samples, gift) made with no signal is saved ON THE PHONE with its selfie and uploaded when the signal is back —
//    one time only, even if the phone retries (the server recognises each call by its request id).
const CACHE_PREFIX = 'zv_c:', CACHE_MAX_ENTRIES = 80, CACHE_MAX_BYTES = 450000;
const NO_CACHE = /^\/(auth|upload|geocode\/reverse)/;

// where the waiting calls are kept: IndexedDB (it can hold the selfie), or plain memory if the browser has none
function makeOutboxStore() {
  let dbp = null;
  const open = () => dbp || (dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open('zv-outbox', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('items', { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
  }));
  const tx = async (mode, fn) => { const db = await open(); return new Promise((resolve, reject) => { const t = db.transaction('items', mode), s = t.objectStore('items'), r = fn(s); t.oncomplete = () => resolve(r && r.result); t.onerror = () => reject(t.error); }); };
  if (typeof indexedDB === 'undefined') {
    const mem = new Map();
    return { async all() { return [...mem.values()]; }, async put(i) { mem.set(i.id, i); }, async remove(id) { mem.delete(id); } };
  }
  return { all: () => tx('readonly', s => s.getAll()), put: (i) => tx('readwrite', s => s.put(i)), remove: (id) => tx('readwrite', s => s.delete(id)) };
}
const newRequestId = () => (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`);

const Api = {
  token: null,
  user: null,
  outboxStore: makeOutboxStore(),
  syncing: false,
  onOutboxChange: null,    // the app listens, to update the "waiting to upload" bar
  onCacheServed: null,     // the app listens, to say "showing saved data"
  slowAfterMs: 4000,
  onSlow: null,            // the app listens: true when a request has taken over 4 seconds (the free server waking up), false when it is answered
  slowCount: 0,

  cachePut(path, data) {
    try {
      if (NO_CACHE.test(path)) return;
      const s = JSON.stringify({ t: Date.now(), d: data });
      if (s.length > CACHE_MAX_BYTES) return;
      localStorage.setItem(CACHE_PREFIX + path, s);
      const keys = Object.keys(localStorage).filter(k => k.startsWith(CACHE_PREFIX));
      if (keys.length > CACHE_MAX_ENTRIES) {   // drop the oldest ones
        keys.map(k => { let t = 0; try { t = JSON.parse(localStorage.getItem(k)).t; } catch (e) { /* unreadable: oldest */ } return [k, t]; })
          .sort((x, y) => x[1] - y[1]).slice(0, keys.length - CACHE_MAX_ENTRIES).forEach(([k]) => localStorage.removeItem(k));
      }
    } catch (e) { /* storage full or blocked: caching is a bonus */ }
  },
  cacheGet(path) { try { const s = localStorage.getItem(CACHE_PREFIX + path); return s ? JSON.parse(s).d : undefined; } catch (e) { return undefined; } },
  cacheClear() { try { Object.keys(localStorage).filter(k => k.startsWith(CACHE_PREFIX)).forEach(k => localStorage.removeItem(k)); } catch (e) { /* nothing to clear */ } },

  // ----- the outbox -----
  async outboxItems() { try { return (await this.outboxStore.all()).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))); } catch (e) { return []; } },
  async outboxCount() { return (await this.outboxItems()).length; },
  // Save a call on the phone. blob = the selfie / photo (or null). Returns the saved item.
  async queueVisit({ payload, blob, label }) {
    const item = { id: newRequestId(), kind: 'visit', createdAt: new Date().toISOString(), label: label || '', status: 'waiting', error: null, tries: 0,
      blob: blob || null, uploadedUrl: payload.photo_url || null,
      payload: { ...payload, client_request_id: newRequestId(), visited_at: new Date().toISOString() } };
    await this.outboxStore.put(item);
    if (this.onOutboxChange) this.onOutboxChange({ queued: true });
    return item;
  },
  async retryOutboxItem(id) { const it = (await this.outboxItems()).find(x => x.id === id); if (it) { it.status = 'waiting'; it.error = null; await this.outboxStore.put(it); } },
  async discardOutboxItem(id) { await this.outboxStore.remove(id); if (this.onOutboxChange) this.onOutboxChange({}); },
  // Upload what is waiting, oldest first. Stops at the first "no signal"; a call the server refuses is marked "failed" (the person decides).
  async syncOutbox() {
    if (this.syncing || !this.token) return { done: 0, left: 0 };
    this.syncing = true;
    let done = 0;
    try {
      for (const item of await this.outboxItems()) {
        if (item.status === 'failed') continue;
        try {
          let url = item.uploadedUrl || null;
          if (item.blob && !url) {                      // the photo goes up first, once; a retry reuses its link
            const file = new File([item.blob], `selfie-${item.createdAt.replace(/\D/g, '')}.jpg`, { type: item.blob.type || 'image/jpeg' });
            url = await this.uploadPhoto(file, { skipCompress: true, timeoutMs: 60000 });
            item.uploadedUrl = url; await this.outboxStore.put(item);
          }
          await this.addVisit({ ...item.payload, photo_url: url || null });
          await this.outboxStore.remove(item.id); done++;
        } catch (err) {
          if (err && (err.message === 'offline' || err.message === 'timeout' || err.message === 'unauthorized')) break;       // no signal (or signed out): try again later
          if (err && err.status >= 500) { item.tries = (item.tries || 0) + 1; await this.outboxStore.put(item); break; }       // server trouble: try again later
          item.status = 'failed'; item.error = (err && err.message) || 'The server refused it'; await this.outboxStore.put(item);  // refused: needs a person
        }
      }
    } finally { this.syncing = false; }
    const left = await this.outboxCount();
    if (this.onOutboxChange) this.onOutboxChange({ done, left });
    return { done, left };
  },

  init() {
    this.token = localStorage.getItem('zv_token');
    const u = localStorage.getItem('zv_user');
    this.user = u ? JSON.parse(u) : null;
  },

  setSession(token, user) {
    this.token = token;
    this.user = user;
    localStorage.setItem('zv_token', token);
    localStorage.setItem('zv_user', JSON.stringify(user));
  },

  clearSession() {
    this.token = null;
    this.user = null;
    localStorage.removeItem('zv_token');
    localStorage.removeItem('zv_user');
    this.cacheClear();      // saved data belongs to the person who signed in
  },

  // Pull the user's CURRENT role/name from the server — an admin may have
  // changed it since this phone logged in. Silent if offline.
  async refreshMe() {
    try {
      const me = await this.request('/auth/me');
      this.user = { ...this.user, role: me.role, full_name: me.full_name, phone: me.phone, email: me.email, birthday: me.birthday, photo_url: me.photo_url, selfie_mandatory: me.selfie_mandatory !== false, gallery_upload_allowed: !!me.gallery_upload_allowed };
      localStorage.setItem('zv_user', JSON.stringify(this.user));
    } catch (err) { /* keep the cached values */ }
  },

  isLoggedIn() {
    return !!this.token;
  },

  async request(path, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`;
    if (options.body && !(options.body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
    }

    // a request can be given a time limit (photo uploads are): a weak signal ends in a clear "timeout", not a frozen screen
    const ctl = options.timeoutMs && typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), options.timeoutMs) : null;
    // the free server sleeps when idle and takes up to a minute to wake: after 4 seconds the person is told, instead of staring at a frozen screen
    let slow = false;
    const slowTimer = setTimeout(() => { slow = true; this.slowCount = (this.slowCount || 0) + 1; if (this.onSlow) this.onSlow(true); }, this.slowAfterMs || 4000);
    let res;
    try {
      res = await fetch(`${API_BASE}${path}`, { ...options, headers, ...(ctl ? { signal: ctl.signal } : {}) });
    } catch (err) {
      // no signal: for a page of data we already have, show the saved copy instead of an error
      if ((!options.method || options.method === 'GET') && !ctl) {
        const saved = this.cacheGet(path);
        if (saved !== undefined) { if (this.onCacheServed) this.onCacheServed(path); return saved; }
      }
      throw new Error(ctl && ctl.signal.aborted ? 'timeout' : 'offline');
    } finally {
      if (timer) clearTimeout(timer);
      clearTimeout(slowTimer);
      if (slow) { this.slowCount = Math.max(0, (this.slowCount || 1) - 1); if (this.slowCount === 0 && this.onSlow) this.onSlow(false); }
    }

    if (res.status === 401) {
      this.clearSession();
      showView('login');
      throw new Error('unauthorized');
    }

    const isJson = res.headers.get('content-type')?.includes('application/json');
    const data = isJson ? await res.json() : null;

    if (!res.ok) {
      const failure = new Error(data?.error || `Request failed (${res.status})`);
      failure.status = res.status; // so the app can tell "too large" and "server problem" from "you typed something wrong"
      throw failure;
    }
    if (!options.method || options.method === 'GET') this.cachePut(path, data);   // keep a copy for when there is no signal
    return data;
  },

  login(username, password) {
    return this.request('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) });
  },

  // Doctors
  getDoctors(params = {}) {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v));
    return this.request(`/doctors?${qs}`);
  },
  getLocalities(type) { return this.request(type === 'chemist' ? '/chemists/localities' : '/doctors/localities'); },
  getDoctor(id) { return this.request(`/doctors/${id}`); },
  createDoctor(payload) { return this.request('/doctors', { method: 'POST', body: JSON.stringify(payload) }); },
  updateDoctor(id, payload) { return this.request(`/doctors/${id}`, { method: 'PUT', body: JSON.stringify(payload) }); },

  // Chemists
  getChemists(params = {}) {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v));
    return this.request(`/chemists?${qs}`);
  },
  getChemist(id) { return this.request(`/chemists/${id}`); },
  createChemist(payload) { return this.request('/chemists', { method: 'POST', body: JSON.stringify(payload) }); },
  updateChemist(id, payload) { return this.request(`/chemists/${id}`, { method: 'PUT', body: JSON.stringify(payload) }); },

  // Visits / comments
  getVisits(entityType, entityId) { return this.request(`/visits?entity_type=${entityType}&entity_id=${entityId}`); },
  getMyCoverage(params = {}) {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''));
    return this.request(`/reports/my-coverage?${qs}`);
  },
  getTeam() { return this.request('/team'); },
  changeOwner(type, id, ownerId) { return this.request(`/${type === 'doctor' ? 'doctors' : 'chemists'}/${id}/owner`, { method: 'POST', body: JSON.stringify({ owner_id: ownerId }) }); },
  getRecentComments(entityType, entityId, limit = 2) { return this.request(`/visits/recent-comments?entity_type=${entityType}&entity_id=${entityId}&limit=${limit}`); },
  addVisit(payload) { return this.request('/visits', { method: 'POST', body: JSON.stringify(payload) }); },
  deleteVisit(id) { return this.request(`/visits/${id}`, { method: 'DELETE' }); },
  getReplies(visitId) { return this.request(`/visits/${visitId}/replies`); },
  addReply(visitId, message) { return this.request(`/visits/${visitId}/replies`, { method: 'POST', body: JSON.stringify({ message }) }); },

  // Nearby / map
  getNearby(params) {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v));
    return this.request(`/nearby?${qs}`);
  },
  reverseGeocode(lat, lng) {
    return this.request(`/geocode/reverse?lat=${lat}&lng=${lng}`);
  },

  // Reports: this MR's own past visits (the server forces this to the caller)
  getVisitReport(params) {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== '' && v != null));
    return this.request(`/reports/visits?${qs}`);
  },

  // Start Day / End Day
  getClusters() { return this.request('/clusters'); },   // the MR's WORKING clusters (Start Day) — not doctor / chemist localities
  getKnownAreas() { return this.request('/geocode/known'); }, // localities and cities already used on doctors and chemists
  getWorkdayToday() { return this.request('/workday/today'); },
  startWorkday(cluster_ids, lat, lng, day_type, day_note, mood, mood_note, checklist) {
    return this.request('/workday/start', { method: 'POST', body: JSON.stringify({ cluster_ids, lat, lng, day_type, day_note, mood: mood || null, mood_note: mood_note || null, checklist: checklist || undefined }) });
  },
  // my last 8 days, and fixing the type of one of them (date = 'today' or 2026-10-12)
  getRecentWorkdays() { return this.request('/workday/recent'); },
  updateWorkdayType(date, day_type) { return this.request(`/workday/${date}`, { method: 'PUT', body: JSON.stringify({ day_type }) }); },
  updateWorkdayMood(date, mood, mood_note) { return this.request(`/workday/${date}`, { method: 'PUT', body: JSON.stringify({ mood, mood_note: mood_note || null }) }); },
  endWorkday(lat, lng) {
    return this.request('/workday/end', { method: 'POST', body: JSON.stringify({ lat, lng }) });
  },

  // Products
  getProducts(params = {}) {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v));
    return this.request(`/products?${qs}`);
  },
  createProduct(payload) { return this.request('/products', { method: 'POST', body: JSON.stringify(payload) }); },

  // Doctor-chemist-product linking
  linkDoctorChemist(payload) { return this.request('/links/doctor-chemist', { method: 'POST', body: JSON.stringify(payload) }); },
  linkDoctorChemistProduct(payload) { return this.request('/links/doctor-chemist-product', { method: 'POST', body: JSON.stringify(payload) }); },
  unlinkDoctorChemistProduct(id) { return this.request(`/links/doctor-chemist-product/${id}`, { method: 'DELETE' }); },
  // (unlink: removes the link and its product links; the server says 404 if they were not linked)
  unlinkDoctorChemist(doctorId, chemistId) { return this.request(`/links/doctor-chemist/${doctorId}/${chemistId}`, { method: 'DELETE' }); },

  // Chemist stock
  getStock(chemistId) { return this.request(`/chemists/${chemistId}/stock`); },
  getStockLog(chemistId, productId) { return this.request(`/chemists/${chemistId}/stock/log${productId ? `?product_id=${productId}` : ''}`); },
  // tick several products, a quantity each, one save
  logStockBatch(chemistId, payload) { return this.request(`/chemists/${chemistId}/stock/batch`, { method: 'POST', body: JSON.stringify(payload) }); },
  logStock(chemistId, payload) { return this.request(`/chemists/${chemistId}/stock`, { method: 'POST', body: JSON.stringify(payload) }); },

  // Upload
  // Phone photos are several MB; the app only needs about 1280px. Shrinking
  // here (before upload) saves mobile data and keeps storage small.
  fitDimensions(w, h, maxDim) {
    const scale = Math.min(1, maxDim / Math.max(w, h));
    return { width: Math.round(w * scale), height: Math.round(h * scale), scale };
  },
  // A 12–50 megapixel camera photo takes 50–200 MB of memory to decode in full — enough to
  // make a phone with little free RAM close the app (it is already squeezed while the camera
  // is open). So: read the photo's size cheaply, then ask the browser to decode it straight
  // at the size we need. The result is { source, width, height } ready for a canvas.
  async loadScaled(file, maxDim) {
    let dims = null;
    const url = URL.createObjectURL(file);
    try {
      dims = await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
        img.onerror = reject;
        img.src = url;
      });
    } catch (e) { dims = null; } finally { URL.revokeObjectURL(url); }

    if (dims && dims.w && dims.h) {
      const { width, height, scale } = this.fitDimensions(dims.w, dims.h, maxDim);
      try {
        const source = await createImageBitmap(file, scale < 1 ? { resizeWidth: width, resizeHeight: height, resizeQuality: 'medium' } : undefined);
        return { source, width: source.width || width, height: source.height || height, scaled: scale < 1 };
      } catch (e) { /* an older browser: fall through to the plain way */ }
    }
    const source = await createImageBitmap(file); // last resort: decode in full
    const { width, height } = this.fitDimensions(source.width, source.height, maxDim);
    return { source, width, height, scaled: false };
  },
  async compressImage(file, { maxDim = 1280, quality = 0.75, keepBelowBytes = 250 * 1024 } = {}) {
    if (!file || !/^image\/(jpeg|png|webp)$/i.test(file.type || '')) return file; // PDFs etc. go up untouched
    try {
      const s = await this.loadScaled(file, maxDim);
      if (!s.scaled && file.size <= keepBelowBytes) { if (s.source.close) s.source.close(); return file; } // already small
      const canvas = document.createElement('canvas');
      canvas.width = s.width; canvas.height = s.height;
      canvas.getContext('2d').drawImage(s.source, 0, 0, s.width, s.height);
      if (s.source.close) s.source.close();
      const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', quality));
      return blob && blob.size < file.size ? blob : file;
    } catch (err) {
      return file; // never block an upload because shrinking failed
    }
  },
  // opts.skipCompress: the picture is already small (a selfie made by the app) — do not decode it a second time
  // opts.timeoutMs: give up (and say so) if the upload takes longer than this
  async uploadPhoto(file, opts = {}) {
    const small = opts.skipCompress ? file : await this.compressImage(file, opts);
    const form = new FormData();
    form.append('photo', small, small.name || 'photo.jpg');
    const res = await this.request('/upload', { method: 'POST', body: form, timeoutMs: opts.timeoutMs || 60000 });
    return res.url;
  },
  async uploadEvidence(file) {
    const small = await this.compressImage(file);
    const form = new FormData();
    form.append('photo', small, small.name || 'evidence');
    return this.request('/upload', { method: 'POST', body: form }); // { url, type }
  },

  // Flag as invalid (any MR) / unflag (admin only)
  flagDoctor(id, reason) { return this.request(`/doctors/${id}/flag`, { method: 'POST', body: JSON.stringify({ reason }) }); },
  unflagDoctor(id) { return this.request(`/doctors/${id}/unflag`, { method: 'POST' }); },
  flagChemist(id, reason) { return this.request(`/chemists/${id}/flag`, { method: 'POST', body: JSON.stringify({ reason }) }); },
  unflagChemist(id) { return this.request(`/chemists/${id}/unflag`, { method: 'POST' }); },

  // Payments received from a chemist (any MR records; only an admin edits / deletes)
  // is this doctor / chemist already in the list? (asked before a NEW one is saved)
  findSimilar(type, f) {
    const q = new URLSearchParams(type === 'doctor' ? { name: f.name || '', hospital_name: f.hospital_name || '', locality: f.locality || '', mobile_number: f.mobile_number || '' } : { store_name: f.store_name || '', locality: f.locality || '', mobile_number: f.mobile_number || '' });
    return this.request(`/${type === 'doctor' ? 'doctors' : 'chemists'}/similar?${q}`);
  },
  // Reminders, today's plan, due-for-a-call list, my targets
  getReminders() { return this.request('/reminders'); },
  // The Wall and visit reminders
  // range: today | two | week | month ; scope: mine | team ; mr_id narrows the team view to one person
  getWall(range, opts = {}) {
    const q = new URLSearchParams({ range: ['two', 'week', 'month'].includes(range) ? range : 'today' });
    if (opts.scope) q.set('scope', opts.scope);
    if (opts.scope === 'team' && opts.mr_id) q.set('mr_id', opts.mr_id);
    return this.request(`/wall?${q}`);
  },
  getLocalityNames() { return this.request('/clusters/names'); },                       // the locality list (active working clusters)
  assignDoctorOwner(id, ownerId) { return this.request(`/doctors/${id}`, { method: 'PUT', body: JSON.stringify({ owner_id: ownerId }) }); },
  updateTask(id, payload) { return this.request(`/wall/tasks/${id}`, { method: 'PUT', body: JSON.stringify(payload) }); },
  getEntityReminders(type, id) { return this.request(`/wall/reminders?entity_type=${type}&entity_id=${id}`); },
  addReminder(payload) { return this.request('/wall/reminders', { method: 'POST', body: JSON.stringify(payload) }); },
  updateReminder(id, payload) { return this.request(`/wall/reminders/${id}`, { method: 'PUT', body: JSON.stringify(payload) }); },
  getPlan(date) { return this.request(`/plan${date ? `?date=${date}` : ''}`); },
  getPlanRange(from, to, who) { const q = new URLSearchParams({ from, to }); if (who === 'all') q.set('all', '1'); else if (who) q.set('user_id', who); return this.request(`/plan?${q}`); },
  getDue(params) { return this.request(`/plan/due?${new URLSearchParams(Object.entries(params).filter(([, v]) => v !== '' && v != null))}`); },
  // opts: { dates: ['2026-12-01', ...] , user_id }   (an Admin / Super User can plan for any MR)
  addToPlan(items, date, opts = {}) { return this.request('/plan', { method: 'POST', body: JSON.stringify({ items, ...(date ? { plan_date: date } : {}), ...(opts.dates ? { dates: opts.dates } : {}), ...(opts.user_id ? { user_id: opts.user_id } : {}) }) }); },
  changePlan(id, payload) { return this.request(`/plan/${id}`, { method: 'PUT', body: JSON.stringify(payload) }); },
  removeFromPlan(id) { return this.request(`/plan/${id}`, { method: 'DELETE' }); },
  getMyTargets(month) { return this.request(`/targets/mine${month ? `?month=${month}` : ''}`); },
  getQuickResponses() { return this.request('/settings/quick-responses'); },
  pushKey() { return this.request('/push/key'); },
  pushSubscribe(sub) { return this.request('/push/subscribe', { method: 'POST', body: JSON.stringify(sub) }); },
  pushUnsubscribe(endpoint) { return this.request('/push/unsubscribe', { method: 'POST', body: JSON.stringify({ endpoint }) }); },
  pushTest() { return this.request('/push/test', { method: 'POST', body: '{}' }); },
  getMyMonth(month) { return this.request(`/calendar/my-month${month ? `?month=${month}` : ''}`); },   // days worked, DA days, leave and calls for ONE month of MY own
  getReportFilters() { return this.request('/reports/filters'); }, // the MR list for the Admin's Home filters
  getMySampleStock() { return this.request('/sample-stock/mine'); }, // the samples the Admin has issued to me, and what is left
  getStockEvents(chemistId) { return this.request(`/chemists/${chemistId}/stock/events`); },
  getChemistPayments(chemistId) { return this.request(`/chemists/${chemistId}/payments`); },
  addChemistPayment(chemistId, payload) { return this.request(`/chemists/${chemistId}/payments`, { method: 'POST', body: JSON.stringify(payload) }); },
  deleteChemistPayment(chemistId, paymentId) { return this.request(`/chemists/${chemistId}/payments/${paymentId}`, { method: 'DELETE' }); },

  // My profile (photo, mobile, e-mail, birthday)
  updateProfile(payload) { return this.request('/auth/me/profile', { method: 'PUT', body: JSON.stringify(payload) }); },

  // Products a doctor prescribes (any MR adds; only an admin edits/removes)
  addDoctorProducts(doctorId, items) { return this.request(`/doctors/${doctorId}/products`, { method: 'POST', body: JSON.stringify({ items }) }); },
  addDoctorProduct(doctorId, payload) { return this.request(`/doctors/${doctorId}/products`, { method: 'POST', body: JSON.stringify(payload) }); },
  updateDoctorProduct(doctorId, linkId, payload) { return this.request(`/doctors/${doctorId}/products/${linkId}`, { method: 'PUT', body: JSON.stringify(payload) }); },
  removeDoctorProduct(doctorId, linkId) { return this.request(`/doctors/${doctorId}/products/${linkId}`, { method: 'DELETE' }); },

  // Commission payments (separate ledger, not the visit feed)
  getCommissionPayments(doctorId) { return this.request(`/doctors/${doctorId}/commission-payments`); },
  addCommissionPayment(doctorId, payload) {
    return this.request(`/doctors/${doctorId}/commission-payments`, { method: 'POST', body: JSON.stringify(payload) });
  },
  updateCommissionPayment(doctorId, paymentId, payload) {   // the Admin, or the person who logged it
    return this.request(`/doctors/${doctorId}/commission-payments/${paymentId}`, { method: 'PUT', body: JSON.stringify(payload) });
  },
  deleteCommissionPayment(doctorId, paymentId) {            // the Admin, or the person who logged it
    return this.request(`/doctors/${doctorId}/commission-payments/${paymentId}`, { method: 'DELETE' });
  }
};

Api.init();
