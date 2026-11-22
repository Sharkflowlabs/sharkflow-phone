// Sharkflow Phone front end. Plain JS, no build step.
(() => {
  const $ = (id) => document.getElementById(id);
  const state = { me: null, contacts: [], counts: {}, current: null, view: '', stage: '', q: '', device: null, call: null, incoming: null, timer: null,
    mode: 'today', pipeline: [], tasks: [], stats: {}, boardQ: '', showClosed: false };
  const ACTIVE = ['In discussion', 'Mockup sent', 'Pricing & invoicing', 'In build'];

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
  const displayName = (c) => c.business || c.name || (c.instagram ? '@' + c.instagram : '') || fmtPhone(c.phone) || c.email || 'Unnamed';
  const money = (n) => '$' + Number(n || 0).toLocaleString();
  const daysBetween = (a, b) => Math.round((new Date(b + 'T12:00:00') - new Date(a + 'T12:00:00')) / 86400000);
  const shortDate = (d) => d ? new Date(d + 'T12:00:00').toLocaleDateString([], { month: 'short', day: 'numeric' }) : '';
  const igUrl = (h) => h ? (/^https?:/.test(h) ? h : `https://instagram.com/${h.replace(/^@/, '')}`) : '';
  const subline = (c) => [c.name && c.business ? c.name : '', fmtPhone(c.phone), c.instagram ? '@' + c.instagram : ''].filter(Boolean).join(' · ');
  // A deal is stuck when it has sat in an active stage longer than the limit with no touch or activity.
  const staleDays = (c) => {
    const lim = state.me.staleDays[c.stage];
    if (!lim) return 0;
    const last = [c.stage_since, c.last_touch, (c.last_activity_at || '').slice(0, 10)].filter(Boolean).sort().pop();
    if (!last) return 0;
    const d = daysBetween(last, today());
    return d > lim ? d : 0;
  };
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
    $('login').hidden = true; $('shell').hidden = false;
    const opts = state.me.stages.map((s) => `<option>${esc(s)}</option>`).join('');
    $('fLost').insertAdjacentHTML('beforeend', state.me.lostReasons.map((s) => `<option>${esc(s)}</option>`).join(''));
    $('stageFilter').insertAdjacentHTML('beforeend', opts);
    $('fStage').innerHTML = opts; $('newStage').innerHTML = opts;
    $('oiChannel').innerHTML = '<option value="">Pick one</option>' + state.me.optInChannels.map((s) => `<option>${esc(s)}</option>`).join('');
    $('optOutText').textContent = state.me.optOutLine;
    $('numberLabel').textContent = state.me.number ? fmtPhone(state.me.number) : 'No number set';
    await loadContacts();
    const id = Number(location.hash.slice(1));
    if (id) { setMode('inbox'); openContact(id); } else setMode(localStorageGet('mode') || 'today');
    setInterval(poll, 10000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
    if (state.me.callingReady) setupVoice();
    else $('phoneStatus').textContent = 'Calling not set up';
  }

  async function poll() {
    if (document.hidden) return;
    await loadContacts().catch(() => {});
    if (state.mode === 'inbox' && state.current) await loadTimeline(false).catch(() => {});
    if (state.mode === 'today') await loadToday().catch(() => {});
  }

  function localStorageGet(k) { try { return localStorage.getItem('sfc_' + k); } catch { return null; } }
  function localStorageSet(k, v) { try { localStorage.setItem('sfc_' + k, v); } catch { /* private mode */ } }

  // ---------- modes ----------
  function setMode(mode) {
    state.mode = mode; localStorageSet('mode', mode);
    document.querySelectorAll('.modes .mode').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
    $('today').hidden = mode !== 'today'; $('board').hidden = mode !== 'board'; $('app').hidden = mode !== 'inbox';
    if (mode === 'today') loadToday().catch((e) => toast(e.message));
    if (mode === 'board') loadBoard().catch((e) => toast(e.message));
    if (mode === 'inbox') loadContacts().catch(() => {});
  }
  document.querySelectorAll('.modes .mode').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
  function goContact(id) { setMode('inbox'); openContact(id); }

  // ---------- today ----------
  async function loadToday() {
    const t = today();
    const [stats, tasks, pipe] = await Promise.all([
      api('/api/stats?today=' + t), api('/api/tasks?today=' + t), api('/api/pipeline'),
    ]);
    state.stats = stats; state.tasks = tasks.tasks; state.pipeline = pipe.contacts;
    $('tiles').innerHTML = [
      ['Active deals', stats.active, 'In discussion to In build'],
      ['Follow-ups due', stats.due, 'touches to send today'],
      ['Open pipeline', money(stats.open_value), `${stats.open_count} in mockup or pricing`],
      ['Won this month', money(stats.won_value), `${stats.won_count} deal${stats.won_count === 1 ? '' : 's'}`],
    ].map(([k, v, s]) => `<div class="tile"><span class="k">${k}</span><span class="v">${esc(v)}</span><span class="s">${esc(s)}</span></div>`).join('');
    const due = state.tasks.filter((x) => x.due && x.due <= t);
    const noDate = state.tasks.filter((x) => !x.due);
    const soon = state.tasks.filter((x) => x.due && x.due > t && x.due <= today(7));
    $('doList').innerHTML = [...due, ...noDate].map(taskRow).join('') || '<li class="muted">Nothing due. Nice.</li>';
    $('upcomingList').innerHTML = soon.map(taskRow).join('') || '<li class="muted">No tasks in the next 7 days.</li>';
    const follow = state.pipeline.filter((c) => c.next_follow_up && c.next_follow_up <= t && c.stage !== 'Lost' && c.stage !== 'Closed won + site live')
      .sort((a, b) => (b.hot - a.hot) || a.next_follow_up.localeCompare(b.next_follow_up));
    $('followList').innerHTML = follow.map((c) => `<li class="work" data-cid="${c.id}">
      <div class="w-main"><a href="#" class="w-name" data-open="${c.id}">${esc(displayName(c))}</a>${c.hot ? '<span class="tag hot">Hot</span>' : ''}
        <div class="muted">${esc(c.stage)}${['Leads', 'Contacted', 'Later'].includes(c.stage) ? ' · ' + (c.touches ? `touch ${c.touches} of ${state.me.maxTouches} sent` : 'not contacted yet') : ''}${c.next_follow_up < t ? ` · ${daysBetween(c.next_follow_up, t)}d late` : ''}${c.next_step ? ' · ' + esc(c.next_step) : ''}</div></div>
      <div class="w-act">${c.instagram ? `<a class="btn small" target="_blank" rel="noopener" href="${esc(igUrl(c.instagram))}">DM</a>` : ''}<button class="btn small" data-touch="${c.id}">Log touch</button><button class="btn small" data-replied="${c.id}">Replied</button></div>
    </li>`).join('') || '<li class="muted">No follow-ups due today.</li>';
    const stale = state.pipeline.map((c) => [c, staleDays(c)]).filter(([, d]) => d).sort((a, b) => b[1] - a[1]);
    $('staleList').innerHTML = stale.map(([c, d]) => `<li class="work"><div class="w-main"><a href="#" class="w-name" data-open="${c.id}">${esc(displayName(c))}</a>
      <div class="muted">${esc(c.stage)} for ${d} days with no activity${c.value ? ' · ' + money(c.value) : ''}</div></div></li>`).join('') || '<li class="muted">No stuck deals.</li>';
    const n = due.length + follow.length;
    $('todayCount').textContent = n || '';
  }

  function taskRow(x) {
    const late = x.due && x.due < today();
    const who = x.contact_id ? `<a href="#" data-open="${x.contact_id}">${esc(x.contact_business || x.contact_name || 'Contact')}</a>` : '';
    return `<li class="task ${x.done ? 'done' : ''}" data-task="${x.id}">
      <label class="check"><input type="checkbox" data-done="${x.id}" ${x.done ? 'checked' : ''}><span>${esc(x.title)}</span></label>
      <span class="muted">${who}${who && x.due ? ' · ' : ''}${x.due ? `<span class="${late ? 'late' : ''}">${late ? 'Overdue ' : ''}${esc(shortDate(x.due))}</span>` : ''}</span>
      <button type="button" class="link danger" data-deltask="${x.id}" aria-label="Delete task">✕</button>
    </li>`;
  }

  async function logTouch(id) {
    const { contact } = await api(`/api/contacts/${id}/touch`, { method: 'POST', body: { today: today() } });
    toast(contact.stage === 'Lost' ? `${displayName(contact)} moved to Lost (no response). Retry on ${shortDate(contact.next_follow_up)}.`
      : `Touch ${contact.touches} logged. Next follow-up ${shortDate(contact.next_follow_up)}.`);
    return contact;
  }
  async function markReplied(id) {
    const { contact } = await api(`/api/contacts/${id}/replied`, { method: 'POST', body: { today: today() } });
    toast(`${displayName(contact)} is now ${contact.stage}.`);
    return contact;
  }

  // One click handler for task rows, open links and touch buttons on every page.
  document.addEventListener('click', async (e) => {
    const t = e.target;
    try {
      if (t.dataset.open) { e.preventDefault(); goContact(Number(t.dataset.open)); return; }
      if (t.dataset.touch) { await logTouch(Number(t.dataset.touch)); await loadToday(); return; }
      if (t.dataset.replied) { await markReplied(Number(t.dataset.replied)); await loadToday(); return; }
      if (t.dataset.deltask) {
        await api(`/api/tasks/${t.dataset.deltask}`, { method: 'DELETE', body: {} });
        refreshTasks(); return;
      }
    } catch (err) { toast(err.message); }
  });
  document.addEventListener('change', async (e) => {
    const t = e.target;
    if (!t.dataset.done) return;
    try { await api(`/api/tasks/${t.dataset.done}`, { method: 'PATCH', body: { done: t.checked } }); refreshTasks(); }
    catch (err) { toast(err.message); }
  });
  function refreshTasks() {
    if (state.mode === 'today') loadToday().catch(() => {});
    if (state.current) loadContactTasks().catch(() => {});
  }
  $('taskForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/api/tasks', { method: 'POST', body: { title: $('taskTitle').value, due: $('taskDue').value || today() } });
      $('taskForm').reset(); loadToday();
    } catch (err) { toast(err.message); }
  });
  $('prospectForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const lines = $('prospectLines').value.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return;
    try {
      const r = await api('/api/prospects', { method: 'POST', body: { lines } });
      $('prospectResult').textContent = `Added ${r.added}. Skipped ${r.skipped} (already there or not an Instagram link).`;
      $('prospectLines').value = ''; loadToday();
    } catch (err) { toast(err.message); }
  });

  // ---------- pipeline board ----------
  async function loadBoard() {
    const { contacts } = await api('/api/pipeline');
    state.pipeline = contacts; renderBoard();
  }
  function renderBoard() {
    const t = today();
    const q = state.boardQ.toLowerCase();
    const stages = state.me.stages.filter((s) => state.showClosed || (s !== 'Lost' && s !== 'Later'));
    const list = state.pipeline.filter((c) => !q || [c.name, c.business, c.instagram, c.phone, c.next_step].join(' ').toLowerCase().includes(q));
    $('boardCols').innerHTML = stages.map((s) => {
      const cards = list.filter((c) => c.stage === s);
      const total = cards.reduce((n, c) => n + (c.value || 0), 0);
      return `<section class="col" data-stage="${esc(s)}">
        <header><b>${esc(s)}</b><span class="muted">${cards.length}${total ? ' · ' + money(total) : ''}</span></header>
        <div class="cards">${cards.map((c) => {
          const due = c.next_follow_up && c.next_follow_up <= t;
          const st = staleDays(c);
          return `<article class="dcard ${c.hot ? 'is-hot' : ''}" draggable="true" data-id="${c.id}">
            <div class="d-top"><span class="d-name">${esc(displayName(c))}</span>${c.value ? `<span class="d-val">${money(c.value)}</span>` : ''}</div>
            ${c.next_step ? `<div class="d-next">${esc(c.next_step)}</div>` : ''}
            <div class="row wrap">${c.hot ? '<span class="tag hot">Hot</span>' : ''}${c.next_follow_up ? `<span class="tag ${due ? 'due' : ''}">${due ? 'Due' : 'Next'} ${esc(shortDate(c.next_follow_up))}</span>` : ''}${c.touches && s === 'Contacted' ? `<span class="tag">${c.touches}/${state.me.maxTouches} touches</span>` : ''}${st ? `<span class="tag stale">Stuck ${st}d</span>` : ''}${c.deadline && s === 'In build' ? `<span class="tag ${c.deadline <= t ? 'due' : ''}">Deliver ${esc(shortDate(c.deadline))}</span>` : ''}${c.lost_reason && s === 'Lost' ? `<span class="tag">${esc(c.lost_reason)}</span>` : ''}${c.unread ? '<span class="tag due">New text</span>' : ''}</div>
          </article>`;
        }).join('')}</div>
      </section>`;
    }).join('');
  }
  $('boardSearch').addEventListener('input', (e) => { state.boardQ = e.target.value.trim(); renderBoard(); });
  $('showClosed').addEventListener('change', (e) => { state.showClosed = e.target.checked; renderBoard(); });
  $('boardCols').addEventListener('click', (e) => {
    const card = e.target.closest('.dcard'); if (card) goContact(Number(card.dataset.id));
  });
  let dragId = null;
  $('boardCols').addEventListener('dragstart', (e) => {
    const card = e.target.closest('.dcard'); if (!card) return;
    dragId = Number(card.dataset.id); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(dragId));
    card.classList.add('dragging');
  });
  $('boardCols').addEventListener('dragend', (e) => { const c = e.target.closest('.dcard'); if (c) c.classList.remove('dragging'); });
  $('boardCols').addEventListener('dragover', (e) => {
    const col = e.target.closest('.col'); if (!col || dragId === null) return;
    e.preventDefault();
    document.querySelectorAll('.col.over').forEach((x) => x !== col && x.classList.remove('over'));
    col.classList.add('over');
  });
  $('boardCols').addEventListener('drop', async (e) => {
    const col = e.target.closest('.col'); if (!col || dragId === null) return;
    e.preventDefault(); col.classList.remove('over');
    const id = dragId; dragId = null;
    const c = state.pipeline.find((x) => x.id === id);
    if (!c || c.stage === col.dataset.stage) return;
    c.stage = col.dataset.stage; renderBoard();
    try {
      await api(`/api/contacts/${id}`, { method: 'PATCH', body: { stage: col.dataset.stage, today: today() } });
      await loadBoard();
    } catch (err) { toast(err.message); loadBoard(); }
  });

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
    $('inboxCount').textContent = state.counts.unread || '';
    $('dueCount').textContent = state.counts.due || '';
    const unreadTotal = state.counts.unread || 0;
    document.title = unreadTotal ? `(${unreadTotal}) Sharkflow CRM` : 'Sharkflow CRM';
    const t = today();
    $('contactList').innerHTML = state.contacts.map((c) => {
      const due = c.next_follow_up && c.next_follow_up <= t;
      const snip = c.last_body ? (c.last_direction === 'out' ? 'You: ' : '') + c.last_body : (c.next_step || subline(c));
      return `<li data-id="${c.id}" class="${state.current && state.current.id === c.id ? 'active' : ''}">
        <div class="top"><span class="nm ${c.unread ? 'unread' : ''}">${esc(displayName(c))}</span><span class="muted">${esc(when(c.last_activity_at))}</span></div>
        <div class="snip">${esc(snip)}</div>
        <div class="row wrap"><span class="tag">${esc(c.stage)}</span>${c.hot ? '<span class="tag hot">Hot</span>' : ''}${c.value ? `<span class="tag">${money(c.value)}</span>` : ''}${c.next_follow_up ? `<span class="tag ${due ? 'due' : ''}">Follow up ${esc(c.next_follow_up.slice(5))}</span>` : ''}${c.opted_out ? '<span class="tag">STOP</span>' : ''}</div>
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
    await Promise.all([loadTimeline(true), loadContactTasks()]);
    if (contact.unread) { await api(`/api/contacts/${id}/read`, { method: 'POST', body: {} }); loadContacts(); }
    else renderList();
  }

  function fillContact() {
    const c = state.current;
    $('cName').textContent = displayName(c);
    $('cSub').textContent = subline(c);
    $('fStage').value = c.stage; $('fFollow').value = c.next_follow_up || '';
    $('fValue').value = c.value ?? ''; $('fHot').checked = Boolean(c.hot); $('fNext').value = c.next_step || '';
    $('fLost').value = c.lost_reason || ''; $('fDeadline').value = c.deadline || '';
    $('lostWrap').hidden = c.stage !== 'Lost'; $('deadlineWrap').hidden = c.stage !== 'In build';
    $('touchText').textContent = c.touches ? `${c.touches} of ${state.me.maxTouches} touches sent${c.last_touch ? ', last ' + shortDate(c.last_touch) : ''}` : 'No outreach logged yet';
    $('igBtn').hidden = !c.instagram; $('igBtn').href = igUrl(c.instagram);
    $('fName').value = c.name; $('fBusiness').value = c.business; $('fPhone').value = c.phone || '';
    $('fEmail').value = c.email; $('fWebsite').value = c.website; $('fInstagram').value = c.instagram; $('fNotes').value = c.notes;
    $('optedOutBanner').hidden = !c.opted_out;
    const locked = !c.opt_in_at && !c.opted_out;
    $('optInForm').hidden = !locked;
    if (locked) { $('oiChannel').value = ''; $('oiDate').value = today(); $('oiNote').value = ''; }
    $('optInRecord').hidden = !c.opt_in_at;
    $('optInText').textContent = c.opt_in_at ? `${c.opt_in_at} · ${c.opt_in_channel}${c.opt_in_note ? ' · ' + c.opt_in_note : ''}` : '';
    if (!c.phone) $('optInForm').hidden = true;
    $('msgInput').disabled = $('sendBtn').disabled = Boolean(c.opted_out) || !c.opt_in_at || !state.me.textingReady || !c.phone;
    $('msgInput').placeholder = !c.phone ? 'Add a phone number in the details to call or text' : state.me.textingReady ? 'Write a text…' : 'Texting turns on once your number is approved';
    $('callBtn').disabled = !state.me.callingReady || !c.phone;
    $('callBtn').title = !c.phone ? 'No phone number yet' : !state.me.callingReady ? 'Calling turns on once your number is set up' : '';
    $('saveState').textContent = '';
  }

  async function loadContactTasks() {
    if (!state.current) return;
    const id = state.current.id;
    const { tasks } = await api(`/api/tasks?contact=${id}`);
    if (!state.current || state.current.id !== id) return;
    $('cTasks').innerHTML = tasks.map(taskRow).join('') || '<li class="muted">No tasks.</li>';
  }
  $('cTaskForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/api/tasks', { method: 'POST', body: { title: $('cTaskTitle').value, due: $('cTaskDue').value || null, contact_id: state.current.id } });
      $('cTaskForm').reset(); loadContactTasks();
    } catch (err) { toast(err.message); }
  });
  $('touchBtn').addEventListener('click', async () => {
    try { state.current = await logTouch(state.current.id); fillContact(); loadContacts(); } catch (err) { toast(err.message); }
  });
  $('repliedBtn').addEventListener('click', async () => {
    try { state.current = await markReplied(state.current.id); fillContact(); loadContacts(); loadContactTasks(); } catch (err) { toast(err.message); }
  });

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
      const rec = i.has_recording
        ? `<span class="rec-label">${i.status === 'voicemail' ? 'Voicemail' : 'Recording'}</span><audio controls preload="none" src="/api/calls/${i.id}/recording"></audio><a class="link" href="/api/calls/${i.id}/recording" download="call-${i.id}.mp3">Download</a>`
        : '';
      return `<li class="callrow">${label} · ${esc(i.status || '')}${dur} · ${esc(when(i.created_at))}${rec}</li>`;
    }).join('') || `<li class="callrow">${state.current.phone ? 'No texts or calls yet.' : 'No phone number yet. Track this deal with the details on the right.'}</li>`;
    if (scroll || atBottom) tl.scrollTop = tl.scrollHeight;
  }

  $('backBtn').addEventListener('click', () => {
    $('cTasks').innerHTML = '';
    state.current = null; history.replaceState(null, '', location.pathname);
    $('app').classList.remove('has-contact'); $('contactView').hidden = true; $('emptyState').hidden = false; renderList();
  });
  $('infoToggle').addEventListener('click', () => $('contactView').classList.toggle('show-info'));

  // Autosave contact fields.
  const fieldMap = { fStage: 'stage', fFollow: 'next_follow_up', fValue: 'value', fNext: 'next_step', fLost: 'lost_reason', fDeadline: 'deadline', fName: 'name', fBusiness: 'business', fPhone: 'phone', fEmail: 'email', fWebsite: 'website', fInstagram: 'instagram', fNotes: 'notes' };
  async function saveField(key, value) {
    if (!state.current) return;
    $('saveState').textContent = 'Saving…';
    try {
      const { contact } = await api(`/api/contacts/${state.current.id}`, { method: 'PATCH', body: { [key]: value, today: today() } });
      state.current = contact; fillContact(); $('saveState').textContent = 'Saved';
      if (key === 'stage') loadContactTasks();
      loadContacts();
    } catch (err) { $('saveState').textContent = ''; toast(err.message); fillContact(); }
  }
  Object.entries(fieldMap).forEach(([id, key]) => {
    $(id).addEventListener('change', (e) => saveField(key, e.target.value));
  });
  document.querySelectorAll('[data-days]').forEach((b) => b.addEventListener('click', () => {
    const v = today(Number(b.dataset.days)); $('fFollow').value = v; saveField('next_follow_up', v);
  }));
  $('fHot').addEventListener('change', (e) => saveField('hot', e.target.checked));
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
      $('newDialog').close(); goContact(contact.id);
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
    instagram: ['instagram', 'ig', 'instagram handle', 'handle', 'instagram url'], stage: ['stage', 'status'], notes: ['notes', 'note'],
    value: ['value', 'deal value', 'price', 'amount'],
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
    if (idx.phone === undefined && idx.instagram === undefined && idx.email === undefined) { $('importResult').textContent = 'No phone, Instagram or email column found.'; return; }
    const list = rows.map((r) => Object.fromEntries(Object.entries(idx).map(([k, i]) => [k, (r[i] || '').trim()]))).filter((r) => r.phone || r.instagram || r.email);
    try {
      const res = await api('/api/import', { method: 'POST', body: { rows: list } });
      $('importResult').textContent = `Added ${res.added}. Skipped ${res.skipped} (duplicates or numbers it could not read).`;
      if (state.mode !== 'inbox') setMode(state.mode);
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
