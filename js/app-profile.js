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
      <div class="rem-box" id="rem-box"><div class="rem-title">🔔 Reminders on this phone</div><div class="rem-sub" id="rem-sub">Checking…</div><div class="rem-actions" id="rem-actions"></div></div>
    </div>`;
  renderReminderBox();
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
  initLoginComfort();

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


// ===== Reminders on this phone (push notifications) =====
const b64ToBytes = (b) => { const p = '='.repeat((4 - b.length % 4) % 4), r = atob((b + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from([...r].map(c => c.charCodeAt(0))); };
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
async function currentSub() { try { const reg = await navigator.serviceWorker.ready; return await reg.pushManager.getSubscription(); } catch (e) { return null; } }
async function renderReminderBox() {
  const sub = document.getElementById('rem-sub'), act = document.getElementById('rem-actions');
  if (!sub) return;
  if (!pushSupported()) { sub.textContent = /iPhone|iPad/.test(navigator.userAgent) ? 'On an iPhone, first add this app to the Home Screen (Share → Add to Home Screen), then open it from there.' : 'This browser cannot show reminders. Use Chrome on Android.'; act.innerHTML = ''; return; }
  if (Notification.permission === 'denied') { sub.textContent = 'Notifications are blocked for this app. Allow them in the phone’s site settings, then come back.'; act.innerHTML = ''; return; }
  const s = await currentSub();
  if (s) { sub.textContent = 'On. You get the tasks the admin gives and your RX / Potential doctors on their call days.'; act.innerHTML = '<button type="button" class="action-btn secondary" onclick="testReminder()">Send me a test</button><button type="button" class="action-btn secondary" onclick="turnRemindersOff()">Turn off</button>'; }
  else { sub.textContent = 'Off. Turn on to be reminded of the tasks the admin gives and of your RX / Potential doctors on their call days.'; act.innerHTML = '<button type="button" class="action-btn primary" onclick="turnRemindersOn()">Turn on reminders</button>'; }
}
async function turnRemindersOn() {
  try {
    const k = await Api.pushKey();
    if (!k.available) return showToast(k.message || 'Reminders are not ready on the server yet');
    if ((await Notification.requestPermission()) !== 'granted') return showToast('Reminders need your permission');
    const reg = await navigator.serviceWorker.ready;
    const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(k.key) });
    await Api.pushSubscribe(sub.toJSON());
    showToast('Reminders are on'); renderReminderBox();
  } catch (err) { showToast(err.message === 'offline' ? "You're offline" : (err.message || 'Could not turn on reminders')); }
}
async function turnRemindersOff() {
  try { const s = await currentSub(); if (s) { await Api.pushUnsubscribe(s.endpoint).catch(() => {}); await s.unsubscribe(); } showToast('Reminders are off'); renderReminderBox(); }
  catch (err) { showToast('Could not turn off reminders'); }
}
async function testReminder() {
  try { await Api.pushTest(); showToast('Test sent — it should appear in a few seconds'); }
  catch (err) { showToast(err.message || 'Could not send the test'); }
}
