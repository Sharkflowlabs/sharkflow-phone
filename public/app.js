// Sharkflow Phone front end. Plain JS, no build step.
(() => {
  const $ = (id) => document.getElementById(id);
  const state = { me: null, contacts: [], counts: {}, current: null, view: '', stage: '', q: '', device: null, call: null, incoming: null, timer: null };

  // ---------- utils ----------
  const today = (offsetDays = 0) => {
    const d = new Date(); d.setDate(d.getDate() + offsetDays);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtPhone = (p) => {
    const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(p || '');
    return m ? `(${m[1]}) ${m[2]}-${m[3]}` : (p || '');
  };
  const displayName = (c) => c.name || c.business || fmtPhone(c.phone);
  const when = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    const sameDay = d.toDateString() === new Date().toDateString();
    return sameDay ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
      : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  };
  let toastTimer;
  const toast = (msg) => {
    const t = $('toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 4000);
  };

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      method: opts.method || 'GET',
      headers: opts.body !== undefined ? { 'content-type': 'application/json' } : {},
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      credentials: 'same-origin',
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && path !== '/api/login') { showLogin(); throw new Error('Signed out'); }
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  // ---------- auth ----------
  function showLogin() { $('app').hidden = true; $('login').hidden = false; $('password').focus(); }

  $('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('loginError').textContent = '';
    try {
      await api('/api/login', { method: 'POST', body: { password: $('password').value } });
      $('password').value = '';
      start();
    } catch (err) { $('loginError').textContent = err.message; }
  });
  $('logoutBtn').addEventListener('click', async () => {
    await api('/api/logout', { method: 'POST', body: {} }).catch(() => {});
    if (state.device) state.device.destroy();
    location.reload();
  });

  // ---------- boot ----------
  async function start() {
    try { state.me = await api('/api/me'); } catch { return showLogin(); }
    $('login').hidden = true; $('app').hidden = false;
    const opts = state.me.stages.map((s) => `<option>${esc(s)}</option>`).join('');
    $('stageFilter').insertAdjacentHTML('beforeend', opts);
    $('fStage').innerHTML = opts; $('newStage').innerHTML = opts;
    $('oiChannel').innerHTML = '<option value="">Pick one</option>' + state.me.optInChannels.map((s) => `<option>${esc(s)}</option>`).join('');
    $('optOutText').textContent = state.me.optOutLine;
    $('numberLabel').textContent = state.me.number ? fmtPhone(state.me.number) : 'No number set';
    await loadContacts();
    const id = Number(location.hash.slice(1));
    if (id) openContact(id);
    setInterval(poll, 10000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
    if (state.me.callingReady) setupVoice();
    else $('phoneStatus').textContent = 'Calling not set up';
  }

  async function poll() {
    if (document.hidden) return;
    await loadContacts().catch(() => {});
    if (state.current) await loadTimeline(false).catch(() => {});
  }

  // ---------- contact list ----------
  async function loadContacts() {
    const params = new URLSearchParams({ today: today() });
    if (state.view) params.set('view', state.view);
    if (state.stage) params.set('stage', state.stage);
    if (state.q) params.set('q', state.q);
    const data = await api('/api/contacts?' + params);
    state.contacts = data.contacts; state.counts = data.counts;
    renderList();
  }

  function renderList() {
    $('unreadCount').textContent = state.counts.unread || '';
    $('dueCount').textContent = state.counts.due || '';
    const unreadTotal = state.counts.unread || 0;
    document.title = unreadTotal ? `(${unreadTotal}) Sharkflow Phone` : 'Sharkflow Phone';
    const t = today();
    $('contactList').innerHTML = state.contacts.map((c) => {
      const due = c.next_follow_up && c.next_follow_up <= t;
      const snip = c.last_body ? (c.last_direction === 'out' ? 'You: ' : '') + c.last_body : (c.business && c.name ? c.business : fmtPhone(c.phone));
      return `<li data-id="${c.id}" class="${state.current && state.current.id === c.id ? 'active' : ''}">
        <div class="top"><span class="nm ${c.unread ? 'unread' : ''}">${esc(displayName(c))}</span><span class="muted">${esc(when(c.last_activity_at))}</span></div>
        <div class="snip">${esc(snip)}</div>
        <div class="row"><span class="tag">${esc(c.stage)}</span>${c.next_follow_up ? `<span class="tag ${due ? 'due' : ''}">Follow up ${esc(c.next_follow_up.slice(5))}</span>` : ''}${c.opted_out ? '<span class="tag">STOP</span>' : ''}</div>
      </li>`;
    }).join('') || '<li class="muted">No contacts here yet.</li>';
  }

  $('contactList').addEventListener('click', (e) => {
    const li = e.target.closest('li[data-id]');
    if (li) openContact(Number(li.dataset.id));
  });
  document.querySelectorAll('.views .chip').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('.views .chip').forEach((x) => x.classList.toggle('active', x === b));
    state.view = b.dataset.view; loadContacts();
  }));
  $('stageFilter').addEventListener('change', (e) => { state.stage = e.target.value; loadContacts(); });
  let searchTimer;
  $('search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.q = e.target.value.trim(); loadContacts(); }, 250);
  });

  // ---------- contact detail ----------
  async function openContact(id) {
    const { contact } = await api(`/api/contacts/${id}`);
    state.current = contact;
    location.hash = String(id);
    $('app').classList.add('has-contact');
    $('emptyState').hidden = true; $('contactView').hidden = false;
    $('contactView').classList.remove('show-info');
    fillContact();
    await loadTimeline(true);
    if (contact.unread) { await api(`/api/contacts/${id}/read`, { method: 'POST', body: {} }); loadContacts(); }
    else renderList();
  }

  function fillContact() {
    const c = state.current;
    $('cName').textContent = displayName(c);
    $('cSub').textContent = [fmtPhone(c.phone), c.name ? c.business : ''].filter(Boolean).join(' · ');
    $('fStage').value = c.stage; $('fFollow').value = c.next_follow_up || '';
    $('fName').value = c.name; $('fBusiness').value = c.business; $('fPhone').value = c.phone;
    $('fEmail').value = c.email; $('fWebsite').value = c.website; $('fInstagram').value = c.instagram; $('fNotes').value = c.notes;
    $('optedOutBanner').hidden = !c.opted_out;
    const locked = !c.opt_in_at && !c.opted_out;
    $('optInForm').hidden = !locked;
    if (locked) { $('oiChannel').value = ''; $('oiDate').value = today(); $('oiNote').value = ''; }
    $('optInRecord').hidden = !c.opt_in_at;
    $('optInText').textContent = c.opt_in_at ? `${c.opt_in_at} · ${c.opt_in_channel}${c.opt_in_note ? ' · ' + c.opt_in_note : ''}` : '';
    $('msgInput').disabled = $('sendBtn').disabled = Boolean(c.opted_out) || !c.opt_in_at || !state.me.textingReady;
    $('msgInput').placeholder = state.me.textingReady ? 'Write a text…' : 'Texting is not set up yet (see SETUP.md)';
    $('callBtn').disabled = !state.me.callingReady;
    $('saveState').textContent = '';
  }

  async function loadTimeline(scroll) {
    const id = state.current.id;
    const { items } = await api(`/api/contacts/${id}/timeline`);
    if (!state.current || state.current.id !== id) return;
    const tl = $('timeline');
    const atBottom = tl.scrollHeight - tl.scrollTop - tl.clientHeight < 60;
    const hasOut = items.some((i) => i.type === 'message' && i.direction === 'out' && !['failed', 'undelivered'].includes(i.status));
    const box = $('optOutCheck');
    if (!hasOut) { box.checked = true; box.disabled = true; } else if (box.disabled) { box.disabled = false; box.checked = false; }
    tl.innerHTML = items.map((i) => {
      if (i.type === 'message') {
        const failed = ['failed', 'undelivered'].includes(i.status);
        const meta = [when(i.created_at), i.direction === 'out' ? (i.status || '') : '', failed && i.error ? i.error : ''].filter(Boolean).join(' · ');
        return `<li class="${i.direction} ${failed ? 'failed' : ''}"><div class="msg">${esc(i.body)}</div><div class="meta">${esc(meta)}</div></li>`;
      }
      const label = i.direction === 'out' ? 'Outgoing call' : 'Incoming call';
      const dur = i.duration ? ` · ${Math.floor(i.duration / 60)}:${String(i.duration % 60).padStart(2, '0')}` : '';
      const vm = i.has_voicemail ? `<audio controls preload="none" src="/api/calls/${i.id}/recording"></audio>` : '';
      return `<li class="callrow">${label} · ${esc(i.status || '')}${dur} · ${esc(when(i.created_at))}${vm}</li>`;
    }).join('') || '<li class="callrow">No texts or calls yet.</li>';
    if (scroll || atBottom) tl.scrollTop = tl.scrollHeight;
  }

  $('backBtn').addEventListener('click', () => {
    state.current = null; history.replaceState(null, '', location.pathname);
    $('app').classList.remove('has-contact'); $('contactView').hidden = true; $('emptyState').hidden = false; renderList();
  });
  $('infoToggle').addEventListener('click', () => $('contactView').classList.toggle('show-info'));

  // Autosave contact fields.
  const fieldMap = { fStage: 'stage', fFollow: 'next_follow_up', fName: 'name', fBusiness: 'business', fPhone: 'phone', fEmail: 'email', fWebsite: 'website', fInstagram: 'instagram', fNotes: 'notes' };
  async function saveField(key, value) {
    if (!state.current) return;
    $('saveState').textContent = 'Saving…';
    try {
      const { contact } = await api(`/api/contacts/${state.current.id}`, { method: 'PATCH', body: { [key]: value } });
      state.current = contact; $('saveState').textContent = 'Saved';
      $('cName').textContent = displayName(contact);
      $('cSub').textContent = [fmtPhone(contact.phone), contact.name ? contact.business : ''].filter(Boolean).join(' · ');
      loadContacts();
    } catch (err) { $('saveState').textContent = ''; toast(err.message); fillContact(); }
  }
  Object.entries(fieldMap).forEach(([id, key]) => {
    $(id).addEventListener('change', (e) => saveField(key, e.target.value));
  });
  document.querySelectorAll('[data-days]').forEach((b) => b.addEventListener('click', () => {
    const v = today(Number(b.dataset.days)); $('fFollow').value = v; saveField('next_follow_up', v);
  }));
  $('clearFollow').addEventListener('click', () => { $('fFollow').value = ''; saveField('next_follow_up', null); });

  $('deleteBtn').addEventListener('click', async () => {
    if (!state.current) return;
    if (!window.confirm(`Delete ${displayName(state.current)} and all their texts and calls?`)) return;
    await api(`/api/contacts/${state.current.id}`, { method: 'DELETE', body: {} });
    $('backBtn').click(); loadContacts();
  });

  // ---------- opt-in ----------
  $('optInForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const { contact } = await api(`/api/contacts/${state.current.id}`, { method: 'PATCH', body: {
        opt_in_at: $('oiDate').value, opt_in_channel: $('oiChannel').value, opt_in_note: $('oiNote').value.trim(),
      } });
      state.current = contact; fillContact(); $('msgInput').focus();
    } catch (err) { toast(err.message); }
  });
  $('clearOptIn').addEventListener('click', async () => {
    if (!window.confirm('Remove the opt-in? Texting will be locked for this contact.')) return;
    const { contact } = await api(`/api/contacts/${state.current.id}`, { method: 'PATCH', body: { opt_in_at: null } });
    state.current = contact; fillContact();
  });

  // ---------- texting ----------
  const updateCount = () => {
    const extra = $('optOutCheck').checked ? state.me.optOutLine.length + 2 : 0;
    const n = $('msgInput').value.length + extra;
    const segs = n <= 160 ? 1 : Math.ceil(n / 153);
    $('charCount').textContent = n ? `${n} chars · ${segs} text${segs > 1 ? 's' : ''}` : '';
  };
  $('msgInput').addEventListener('input', updateCount);
  $('optOutCheck').addEventListener('change', updateCount);
  $('msgInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) $('composer').requestSubmit();
  });
  $('composer').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = $('msgInput').value.trim();
    if (!body || !state.current) return;
    $('sendBtn').disabled = true;
    try {
      await api(`/api/contacts/${state.current.id}/messages`, { method: 'POST', body: { body, addOptOut: $('optOutCheck').checked } });
      $('msgInput').value = ''; updateCount();
      await loadTimeline(true); loadContacts();
    } catch (err) { toast(err.message); await loadTimeline(true).catch(() => {}); }
    finally { $('sendBtn').disabled = Boolean(state.current && state.current.opted_out); }
  });

  // ---------- new contact + import ----------
  $('newBtn').addEventListener('click', () => { $('newForm').reset(); $('newError').textContent = ''; $('newDialog').showModal(); });
  $('newForm').addEventListener('submit', async (e) => {
    if (e.submitter && e.submitter.value === 'cancel') return;
    e.preventDefault();
    const body = Object.fromEntries(new FormData($('newForm')));
    try {
      const { contact } = await api('/api/contacts', { method: 'POST', body });
      $('newDialog').close(); await loadContacts(); openContact(contact.id);
    } catch (err) { $('newError').textContent = err.message; }
  });

  function parseCsv(text) {
    const rows = []; let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) {
        if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch;
      } else if (ch === '"') q = true;
      else if (ch === ',') { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
      else cell += ch;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows.filter((r) => r.some((c) => c.trim()));
  }
  const headerAliases = {
    phone: ['phone', 'phone number', 'mobile', 'number', 'cell'], name: ['name', 'owner', 'contact', 'contact name', 'first name'],
    business: ['business', 'business name', 'company', 'company name'], email: ['email', 'e-mail'], website: ['website', 'site', 'url'],
    instagram: ['instagram', 'ig', 'instagram handle', 'handle'], stage: ['stage', 'status'], notes: ['notes', 'note'],
  };
  $('importBtn').addEventListener('click', () => { $('importForm').reset(); $('importResult').textContent = ''; $('importDialog').showModal(); });
  $('importForm').addEventListener('submit', async (e) => {
    if (e.submitter && e.submitter.value === 'cancel') return;
    e.preventDefault();
    const file = $('importFile').files[0];
    if (!file) { $('importResult').textContent = 'Pick a file first.'; return; }
    const rows = parseCsv(await file.text());
    const head = rows.shift().map((h) => h.trim().toLowerCase());
    const idx = {};
    for (const [key, names] of Object.entries(headerAliases)) {
      const i = head.findIndex((h) => names.includes(h)); if (i >= 0) idx[key] = i;
    }
    if (idx.phone === undefined) { $('importResult').textContent = 'No phone column found.'; return; }
    const list = rows.map((r) => Object.fromEntries(Object.entries(idx).map(([k, i]) => [k, (r[i] || '').trim()]))).filter((r) => r.phone);
    try {
      const res = await api('/api/import', { method: 'POST', body: { rows: list } });
      $('importResult').textContent = `Added ${res.added}. Skipped ${res.skipped} (duplicates or numbers it could not read).`;
      loadContacts();
    } catch (err) { $('importResult').textContent = err.message; }
  });

  // ---------- calling (Twilio Voice JS SDK) ----------
  async function fetchToken() { return (await api('/api/voice-token')).token; }

  async function setupVoice() {
    const pill = $('phoneStatus');
    if (!window.Twilio || !window.Twilio.Device) { pill.textContent = 'Calling failed to load'; return; }
    try {
      const device = new Twilio.Device(await fetchToken(), { codecPreferences: ['opus', 'pcmu'], closeProtection: true });
      state.device = device;
      device.on('registered', () => { pill.textContent = 'Ready for calls'; pill.classList.add('on'); });
      device.on('unregistered', () => { pill.textContent = 'Calling off'; pill.classList.remove('on'); });
      device.on('error', (err) => { console.error(err); toast(`Calling error: ${err.message}`); });
      device.on('tokenWillExpire', async () => device.updateToken(await fetchToken()));
      device.on('incoming', onIncoming);
      await device.register();
    } catch (err) { pill.textContent = 'Calling off (click to retry)'; console.error(err); }
  }
  $('phoneStatus').addEventListener('click', () => { if (state.me.callingReady && !(state.device && state.device.state === 'registered')) setupVoice(); });

  function nameFor(phone) {
    const c = state.contacts.find((x) => x.phone === phone);
    return c ? displayName(c) : fmtPhone(phone);
  }

  async function placeCall(to, label) {
    if (!state.device) return toast('Calling is not ready yet.');
    if (state.call) return toast('You are already on a call.');
    try {
      const call = await state.device.connect({ params: { To: to } });
      attachCall(call, label || nameFor(to), 'Calling…');
    } catch (err) { toast(err.message); }
  }
  $('callBtn').addEventListener('click', () => state.current && placeCall(state.current.phone, displayName(state.current)));
  $('quickDialBtn').addEventListener('click', () => { const v = $('quickDial').value.trim(); if (v) placeCall(v); });

  function attachCall(call, who, initial) {
    state.call = call;
    $('callWho').textContent = who; $('callState').textContent = initial; $('callTimer').textContent = '';
    $('muteBtn').textContent = 'Mute'; $('keypad').hidden = true; $('callBar').hidden = false;
    call.on('accept', () => {
      $('callState').textContent = 'Connected';
      const t0 = Date.now();
      state.timer = setInterval(() => {
        const s = Math.floor((Date.now() - t0) / 1000);
        $('callTimer').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
      }, 1000);
    });
    const end = () => {
      clearInterval(state.timer); state.call = null; $('callBar').hidden = true;
      setTimeout(() => { loadContacts(); if (state.current) loadTimeline(true); }, 1500);
    };
    call.on('disconnect', end); call.on('cancel', end); call.on('reject', end);
    call.on('error', (err) => { toast(`Call error: ${err.message}`); });
  }
  $('hangupBtn').addEventListener('click', () => state.call && state.call.disconnect());
  $('muteBtn').addEventListener('click', () => {
    if (!state.call) return; const m = !state.call.isMuted(); state.call.mute(m); $('muteBtn').textContent = m ? 'Unmute' : 'Mute';
  });
  $('keypad').innerHTML = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'].map((d) => `<button type="button">${d}</button>`).join('');
  $('keypad').addEventListener('click', (e) => { if (e.target.tagName === 'BUTTON' && state.call) state.call.sendDigits(e.target.textContent); });
  $('keypadBtn').addEventListener('click', () => { $('keypad').hidden = !$('keypad').hidden; });

  function onIncoming(call) {
    if (state.call) { call.reject(); return; }
    state.incoming = call;
    const from = call.parameters.From;
    $('incomingWho').textContent = nameFor(from); $('incoming').hidden = false;
    const clear = () => { $('incoming').hidden = true; state.incoming = null; loadContacts(); };
    call.on('cancel', clear); call.on('disconnect', clear); call.on('reject', clear);
    if (window.Notification && Notification.permission === 'granted' && document.hidden) new Notification('Incoming call', { body: nameFor(from) });
  }
  $('acceptBtn').addEventListener('click', () => {
    const call = state.incoming; if (!call) return;
    $('incoming').hidden = true; state.incoming = null;
    call.accept(); attachCall(call, nameFor(call.parameters.From), 'Connecting…');
  });
  $('rejectBtn').addEventListener('click', () => { if (state.incoming) state.incoming.reject(); });
  document.addEventListener('click', () => { if (window.Notification && Notification.permission === 'default') Notification.requestPermission(); }, { once: true });

  start();
})();
