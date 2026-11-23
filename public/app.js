// Sharkflow CRM front end: Home, Dialer, Pipeline, Contacts and contact records. Plain JS, no build step.
(() => {
  const $ = (id) => document.getElementById(id);
  const state = {
    me: null, page: 'home', contacts: [], counts: {}, current: null, view: '', stage: '', source: '', q: '',
    pipeline: [], tasks: [], stats: {}, boardQ: '', showLost: false,
    queue: [], qi: 0, queueFilter: 'due', session: { dials: 0, connects: 0, talk: 0 }, dialCall: null,
    device: null, call: null, incoming: null, timer: null,
  };

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
  const when = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    const sameDay = d.toDateString() === new Date().toDateString();
    return sameDay ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
      : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  };
  const initials = (c) => {
    const words = displayName(c).replace(/^@/, '').split(/[\s._-]+/).filter(Boolean);
    return ((words[0] || '?')[0] + (words[1] ? words[1][0] : '')).toUpperCase();
  };
  const hue = (c) => { let h = 0; for (const ch of displayName(c)) h = (h * 31 + ch.charCodeAt(0)) % 360; return h; };
  const avatar = (c, cls = '') => `<span class="avatar ${cls}" style="--h:${hue(c)}">${esc(initials(c))}</span>`;
  const stageClass = (s) => 'st-' + String(s).toLowerCase().replace(/[^a-z]+/g, '-').replace(/-+$/, '');
  const stagePill = (s) => `<span class="pill-stage ${stageClass(s)}">${esc(s)}</span>`;
  const lsGet = (k) => { try { return localStorage.getItem('sfc_' + k); } catch { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem('sfc_' + k, v); } catch { /* storage blocked */ } };
  let toastTimer;
  const toast = (msg) => {
    const t = $('toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 4000);
  };
  // A deal is stuck when it has sat in an active stage longer than the limit with no touch or activity.
  const staleDays = (c) => {
    const lim = state.me.staleDays[c.stage];
    if (!lim) return 0;
    const last = [c.stage_since, c.last_touch, (c.last_activity_at || '').slice(0, 10)].filter(Boolean).sort().pop();
    if (!last) return 0;
    const d = daysBetween(last, today());
    return d > lim ? d : 0;
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
  function showLogin() { $('shell').hidden = true; $('login').hidden = false; $('password').focus(); }
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
    location.hash = ''; location.reload();
  });

  // ---------- boot + routing ----------
  async function start() {
    try { state.me = await api('/api/me'); } catch { return showLogin(); }
    $('login').hidden = true; $('shell').hidden = false;
    $('aiFab').hidden = false;
    const opts = state.me.stages.map((s) => `<option>${esc(s)}</option>`).join('');
    $('stageFilter').insertAdjacentHTML('beforeend', opts);
    $('fStage').innerHTML = opts; $('newStage').innerHTML = opts;
    const srcOpts = (state.me.sources || []).map((x) => `<option>${esc(x)}</option>`).join('');
    $('fSource').insertAdjacentHTML('beforeend', srcOpts); $('newSource').insertAdjacentHTML('beforeend', srcOpts);
    $('sourceFilter').insertAdjacentHTML('beforeend', srcOpts + '<option value="(none)">Not set</option>');
    $('fLost').insertAdjacentHTML('beforeend', state.me.lostReasons.map((s) => `<option>${esc(s)}</option>`).join(''));
    $('oiChannel').innerHTML = '<option value="">Pick one</option>' + state.me.optInChannels.map((s) => `<option>${esc(s)}</option>`).join('');
    $('optOutText').textContent = state.me.optOutLine;
    $('outcomes').innerHTML = Object.entries(state.me.outcomes).map(([k, v], i) =>
      `<button type="button" class="outcome oc-${k}" data-outcome="${k}"><kbd>${i + 1}</kbd>${esc(v)}</button>`).join('');
    initScript();
    if (window.matchMedia('(max-width: 900px)').matches) document.querySelector('.props').open = false;
    window.addEventListener('hashchange', route);
    route();
    setInterval(poll, 15000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
    if (state.me.callingReady) setupVoice();
    else setPhoneStatus('off', 'Calling turns on once your Twilio number is set up');
  }

  function route() {
    const h = location.hash.slice(1) || lsGet('page') || 'home';
    const m = /^c\/(\d+)$/.exec(h);
    const page = m ? 'record' : (['home', 'dialer', 'pipeline', 'contacts'].includes(h) ? h : 'home');
    state.page = page;
    if (!m) lsSet('page', page);
    document.querySelectorAll('.page').forEach((p) => { p.hidden = p.id !== 'page-' + page; });
    document.querySelectorAll('.rail .nav[data-page]').forEach((a) => a.classList.toggle('active', a.dataset.page === (page === 'record' ? 'contacts' : page)));
    if (page === 'home') loadHome().catch((e) => toast(e.message));
    if (page === 'pipeline') loadBoard().catch((e) => toast(e.message));
    if (page === 'contacts') loadContacts().catch((e) => toast(e.message));
    if (page === 'dialer') loadQueue().catch((e) => toast(e.message));
    if (page === 'record') openContact(Number(m[1])).catch((e) => toast(e.message));
    document.querySelector('.main').scrollTop = 0;
  }
  const goContact = (id) => { location.hash = 'c/' + id; };

  async function poll() {
    if (document.hidden) return;
    const c = await api('/api/contacts?view=unread&today=' + today()).catch(() => null);
    if (c) setCounts(c.counts);
    if (state.page === 'record' && state.current && !state.call) loadTimeline(false).catch(() => {});
    if (state.page === 'contacts') loadContacts().catch(() => {});
  }
  function setCounts(counts) {
    state.counts = counts || {};
    $('unreadCount').textContent = state.counts.unread || '';
    $('dueCount').textContent = state.counts.due || '';
    $('inboxCount').textContent = state.counts.unread || '';
    const n = state.counts.unread || 0;
    document.title = n ? `(${n}) Sharkflow CRM` : 'Sharkflow CRM';
  }

  // ---------- new contact ----------
  document.querySelectorAll('[data-new]').forEach((b) => b.addEventListener('click', () => {
    $('newForm').reset(); $('newError').textContent = ''; $('newDialog').showModal();
  }));
  $('newForm').addEventListener('submit', async (e) => {
    if (e.submitter && e.submitter.value === 'cancel') return;
    e.preventDefault();
    const body = Object.fromEntries(new FormData($('newForm')));
    try {
      const { contact } = await api('/api/contacts', { method: 'POST', body });
      $('newDialog').close(); goContact(contact.id);
    } catch (err) { $('newError').textContent = err.message; }
  });

  // ---------- home ----------
  async function loadHome() {
    const t = today();
    const [stats, tasks, pipe, cnt] = await Promise.all([
      api('/api/stats?today=' + t), api('/api/tasks?today=' + t), api('/api/pipeline'), api('/api/contacts?view=unread&today=' + t),
    ]);
    setCounts(cnt.counts);
    state.stats = stats; state.tasks = tasks.tasks; state.pipeline = pipe.contacts;
    const hr = new Date().getHours();
    $('hello').textContent = hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening';
    $('helloSub').textContent = new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
    $('kpis').innerHTML = [
      ['Pipeline', money(stats.open_value), `${stats.open_count} deal${stats.open_count === 1 ? '' : 's'} in Interested + In build`, 'gold'],
      ['Closed won this month', money(stats.won_value), `${stats.won_count} site${stats.won_count === 1 ? '' : 's'} live`, 'green'],
      ['Calls today', stats.dials_today, `${stats.connects_today} connected`, 'blue'],
      ['Follow-ups due', stats.due, `${stats.tasks_due} task${stats.tasks_due === 1 ? '' : 's'} due too`, 'red'],
    ].map(([k, v, s, c]) => `<div class="kpi kpi-${c}"><span class="k">${k}</span><span class="v">${esc(v)}</span><span class="s">${esc(s)}</span></div>`).join('');
    const by = Object.fromEntries((stats.stages || []).map((x) => [x.stage, x]));
    const board = state.me.stages.filter((s) => s !== 'Lost' && s !== 'LTO');
    const max = Math.max(1, ...board.map((s) => (by[s] || {}).n || 0));
    $('funnel').innerHTML = `<div class="card-head"><h2>Funnel</h2><span class="muted">${(by.LTO || {}).n || 0} LTO · ${(by.Lost || {}).n || 0} lost</span></div><div class="funnel-row">` + board.map((s) => {
      const x = by[s] || { n: 0, total: 0 };
      return `<a class="fstep ${stageClass(s)}" href="#pipeline"><span class="fbar" style="height:${8 + Math.round((x.n / max) * 56)}px"></span><b>${x.n}</b><span>${esc(s)}</span>${state.me.pipelineStages.includes(s) || s === state.me.stages[5] ? `<em>${money(x.total)}</em>` : '<em>&nbsp;</em>'}</a>`;
    }).join('') + '</div>';

    const due = state.tasks.filter((x) => x.due && x.due <= t);
    const noDate = state.tasks.filter((x) => !x.due);
    const soon = state.tasks.filter((x) => x.due && x.due > t && x.due <= today(7));
    $('doList').innerHTML = [...due, ...noDate].map(taskRow).join('') || '<li class="empty-row">Nothing due. Nice.</li>';
    $('upcomingList').innerHTML = soon.map(taskRow).join('') || '<li class="empty-row">No tasks in the next 7 days.</li>';
    $('taskSummary').textContent = due.length ? `${due.length} due` : '';
    const follow = state.pipeline.filter((c) => c.next_follow_up && c.next_follow_up <= t && c.stage !== 'Lost' && c.stage !== 'Closed won + site live')
      .sort((a, b) => (b.hot - a.hot) || a.next_follow_up.localeCompare(b.next_follow_up));
    $('followSummary').textContent = follow.length ? `${follow.length} due` : '';
    $('followList').innerHTML = follow.map(followRow).join('') || '<li class="empty-row">No follow-ups due today.</li>';
    const stale = state.pipeline.map((c) => [c, staleDays(c)]).filter(([, d]) => d).sort((a, b) => b[1] - a[1]);
    $('staleList').innerHTML = stale.map(([c, d]) => `<li class="work">${avatar(c, 'sm')}<div class="w-main"><a href="#c/${c.id}" class="w-name">${esc(displayName(c))}</a>
      <div class="muted">${esc(c.stage)} for ${d} days with no activity${c.value ? ' · ' + money(c.value) : ''}</div></div></li>`).join('') || '<li class="empty-row">No stuck deals.</li>';
    $('homeCount').textContent = (due.length + follow.length) || '';
  }

  function followRow(c) {
    const t = today();
    const early = ['Prospects', 'Attempt to connect'].includes(c.stage);
    return `<li class="work">${avatar(c, 'sm')}
      <div class="w-main"><a href="#c/${c.id}" class="w-name">${esc(displayName(c))}</a>${c.hot ? '<span class="tag hot">Hot</span>' : ''}
        <div class="muted">${esc(c.stage)}${early ? ' · ' + (c.touches ? `touch ${c.touches} of ${state.me.maxTouches} sent` : 'not contacted yet') : ''}${c.next_follow_up < t ? ` · ${daysBetween(c.next_follow_up, t)}d late` : ''}${c.next_step ? ' · ' + esc(c.next_step) : ''}</div></div>
      <div class="w-act">${c.phone ? `<button class="btn small call" data-dial="${c.id}">Call</button>` : ''}${c.instagram ? `<a class="btn small" target="_blank" rel="noopener" href="${esc(igUrl(c.instagram))}">DM</a>` : ''}<button class="btn small" data-touch="${c.id}">Log touch</button><button class="btn small" data-replied="${c.id}">Replied</button></div>
    </li>`;
  }

  function taskRow(x) {
    const late = x.due && x.due < today();
    const who = x.contact_id ? `<a href="#c/${x.contact_id}">${esc(x.contact_business || x.contact_name || 'Contact')}</a>` : '';
    return `<li class="task ${x.done ? 'done' : ''}">
      <label class="check"><input type="checkbox" data-done="${x.id}" ${x.done ? 'checked' : ''}><span>${esc(x.title)}</span></label>
      <span class="muted">${who}${who && x.due ? ' · ' : ''}${x.due ? `<span class="${late ? 'late' : ''}">${late ? 'Overdue ' : ''}${esc(shortDate(x.due))}</span>` : ''}</span>
      <button type="button" class="link danger" data-deltask="${x.id}" aria-label="Delete task">✕</button>
    </li>`;
  }

  async function logTouch(id) {
    const { contact } = await api(`/api/contacts/${id}/touch`, { method: 'POST', body: { today: today() } });
    toast(contact.stage === 'Lost' ? `${displayName(contact)} moved to Lost (no response). Retry on ${shortDate(contact.next_follow_up)}.`
      : `Touch logged. Next follow-up ${shortDate(contact.next_follow_up)}.`);
    return contact;
  }
  async function markReplied(id) {
    const { contact } = await api(`/api/contacts/${id}/replied`, { method: 'POST', body: { today: today() } });
    toast(`${displayName(contact)} is now ${contact.stage}.`);
    return contact;
  }

  // Shared click handlers for buttons rendered in lists.
  document.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-touch],[data-replied],[data-deltask],[data-dial]');
    if (!t) return;
    try {
      if (t.dataset.touch) { await logTouch(Number(t.dataset.touch)); await loadHome(); }
      else if (t.dataset.replied) { await markReplied(Number(t.dataset.replied)); await loadHome(); }
      else if (t.dataset.deltask) { await api(`/api/tasks/${t.dataset.deltask}`, { method: 'DELETE', body: {} }); refreshTasks(); }
      else if (t.dataset.dial) { state.pendingDial = Number(t.dataset.dial); location.hash = 'dialer'; }
    } catch (err) { toast(err.message); }
  });
  document.addEventListener('change', async (e) => {
    const t = e.target;
    if (!t.dataset || !t.dataset.done) return;
    try { await api(`/api/tasks/${t.dataset.done}`, { method: 'PATCH', body: { done: t.checked } }); refreshTasks(); }
    catch (err) { toast(err.message); }
  });
  function refreshTasks() {
    if (state.page === 'home') loadHome().catch(() => {});
    if (state.page === 'record') loadContactTasks().catch(() => {});
  }
  $('taskForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/api/tasks', { method: 'POST', body: { title: $('taskTitle').value, due: $('taskDue').value || today() } });
      $('taskForm').reset(); loadHome();
    } catch (err) { toast(err.message); }
  });
  $('prospectForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const lines = $('prospectLines').value.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return;
    try {
      const r = await api('/api/prospects', { method: 'POST', body: { lines } });
      $('prospectResult').textContent = `Added ${r.added}. Skipped ${r.skipped} (already there or not an Instagram link).`;
      $('prospectLines').value = ''; loadHome();
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
    const stages = state.me.stages.filter((s) => state.showLost || s !== 'Lost');
    const list = state.pipeline.filter((c) => !q || [c.name, c.business, c.instagram, c.phone, c.next_step, c.source].join(' ').toLowerCase().includes(q));
    const pipeTotal = state.pipeline.filter((c) => state.me.pipelineStages.includes(c.stage)).reduce((n, c) => n + (c.value || 0), 0);
    $('boardSub').textContent = `Pipeline ${money(pipeTotal)} (Interested + In build) · drag a card to move it`;
    $('boardCols').innerHTML = stages.map((s) => {
      const cards = list.filter((c) => c.stage === s);
      const total = cards.reduce((n, c) => n + (c.value || 0), 0);
      return `<section class="col ${stageClass(s)}" data-stage="${esc(s)}">
        <header><div class="col-title"><b>${esc(s)}</b><span class="col-n">${cards.length}</span></div></header>
        <div class="cards">${cards.map((c) => {
          const due = c.next_follow_up && c.next_follow_up <= t;
          const st = staleDays(c);
          const tags = [
            c.hot ? '<span class="tag hot">Hot</span>' : '',
            c.next_follow_up && s !== 'Lost' ? `<span class="tag ${due ? 'due' : ''}">${due ? 'Due' : 'Next'} ${esc(shortDate(c.next_follow_up))}</span>` : '',
            c.touches && (s === 'Attempt to connect' || s === 'LTO') ? `<span class="tag">${c.touches}/${state.me.maxTouches} touches</span>` : '',
            st ? `<span class="tag stale">Stuck ${st}d</span>` : '',
            c.deadline && s === 'In build' ? `<span class="tag ${c.deadline <= t ? 'due' : ''}">Deliver ${esc(shortDate(c.deadline))}</span>` : '',
            c.lost_reason && s === 'Lost' ? `<span class="tag">${esc(c.lost_reason)}</span>` : '',
            c.unread ? '<span class="tag due">New text</span>' : '',
          ].join('');
          return `<article class="dcard ${c.hot ? 'is-hot' : ''}" draggable="true" data-id="${c.id}">
            <div class="d-top">${avatar(c, 'sm')}<span class="d-name">${esc(displayName(c))}</span></div>
            <div class="d-amt"><span class="muted">Amount:</span> ${c.value ? money(c.value) : '<span class="muted">-</span>'}</div>
            ${c.next_step ? `<div class="d-next">${esc(c.next_step)}</div>` : ''}
            ${tags ? `<div class="row wrap">${tags}</div>` : ''}
            <div class="d-icons">${c.phone ? '<span title="Has phone">☎</span>' : ''}${c.instagram ? '<span title="Instagram">IG</span>' : ''}${c.email ? '<span title="Email">@</span>' : ''}</div>
          </article>`;
        }).join('') || '<div class="col-empty">No deals</div>'}</div>
        <footer class="col-foot"><span class="muted">Total amount</span><b>${money(total)}</b></footer>
      </section>`;
    }).join('');
  }
  $('boardSearch').addEventListener('input', (e) => { state.boardQ = e.target.value.trim(); renderBoard(); });
  $('showLost').addEventListener('change', (e) => { state.showLost = e.target.checked; renderBoard(); });
  $('boardCols').addEventListener('click', (e) => { const card = e.target.closest('.dcard'); if (card) goContact(card.dataset.id); });
  let dragId = null;
  $('boardCols').addEventListener('dragstart', (e) => {
    const card = e.target.closest('.dcard'); if (!card) return;
    dragId = Number(card.dataset.id); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(dragId));
    card.classList.add('dragging');
  });
  $('boardCols').addEventListener('dragend', (e) => {
    const c = e.target.closest('.dcard'); if (c) c.classList.remove('dragging');
    document.querySelectorAll('.col.over').forEach((x) => x.classList.remove('over'));
  });
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

  // ---------- contacts table ----------
  async function loadContacts() {
    const params = new URLSearchParams({ today: today() });
    if (state.view) params.set('view', state.view);
    if (state.stage) params.set('stage', state.stage);
    if (state.source) params.set('source', state.source);
    if (state.q) params.set('q', state.q);
    const data = await api('/api/contacts?' + params);
    state.contacts = data.contacts; setCounts(data.counts);
    renderTable();
  }
  function renderTable() {
    const t = today();
    $('contactsSub').textContent = `${state.contacts.length} contact${state.contacts.length === 1 ? '' : 's'}`;
    $('contactRows').innerHTML = state.contacts.map((c) => {
      const due = c.next_follow_up && c.next_follow_up <= t;
      return `<tr data-id="${c.id}" class="${c.unread ? 'unread' : ''}">
        <td><div class="name-cell">${avatar(c, 'sm')}<div><a href="#c/${c.id}" class="cname">${esc(displayName(c))}</a>${c.hot ? ' <span class="tag hot">Hot</span>' : ''}${c.unread ? ' <span class="tag due">New text</span>' : ''}
          <div class="muted">${esc(c.last_body ? (c.last_direction === 'out' ? 'You: ' : '') + c.last_body : (c.instagram ? '@' + c.instagram : c.email || ''))}</div></div></div></td>
        <td>${stagePill(c.stage)}</td>
        <td class="hide-s">${c.source ? esc(c.source) : '<span class="muted">-</span>'}</td>
        <td class="num hide-s">${c.value ? money(c.value) : '<span class="muted">-</span>'}</td>
        <td class="hide-s">${esc(fmtPhone(c.phone)) || '<span class="muted">-</span>'}</td>
        <td>${c.next_follow_up ? `<span class="${due ? 'late' : ''}">${esc(shortDate(c.next_follow_up))}</span>` : '<span class="muted">-</span>'}</td>
        <td class="hide-s muted">${esc(when(c.last_activity_at || c.updated_at))}</td>
      </tr>`;
    }).join('') || '<tr><td colspan="7" class="empty-row">No contacts here.</td></tr>';
  }
  $('contactRows').addEventListener('click', (e) => {
    if (e.target.closest('a')) return;
    const tr = e.target.closest('tr[data-id]'); if (tr) goContact(tr.dataset.id);
  });
  document.querySelectorAll('.views .tab').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('.views .tab').forEach((x) => x.classList.toggle('active', x === b));
    state.view = b.dataset.view; loadContacts();
  }));
  $('stageFilter').addEventListener('change', (e) => { state.stage = e.target.value; loadContacts(); });
  $('sourceFilter').addEventListener('change', (e) => { state.source = e.target.value; loadContacts(); });
  let searchTimer;
  $('search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.q = e.target.value.trim(); loadContacts(); }, 250);
  });

  // ---------- contact record ----------
  async function openContact(id) {
    const { contact } = await api(`/api/contacts/${id}`);
    state.current = contact;
    fillContact();
    setTab(contact.unread ? 'texts' : 'activity');
    await Promise.all([loadTimeline(true), loadContactTasks()]);
    if (contact.unread) { await api(`/api/contacts/${id}/read`, { method: 'POST', body: {} }); poll(); }
  }

  function fillContact() {
    const c = state.current;
    $('rAvatar').outerHTML = avatar(c, 'lg').replace('<span ', '<span id="rAvatar" ');
    $('cName').textContent = displayName(c);
    $('cSub').textContent = subline(c);
    $('fStage').value = c.stage; $('fFollow').value = c.next_follow_up || '';
    $('fValue').value = c.value ?? ''; $('fHot').checked = Boolean(c.hot); $('fNext').value = c.next_step || '';
    $('fLost').value = c.lost_reason || ''; $('fDeadline').value = c.deadline || '';
    $('lostWrap').hidden = c.stage !== 'Lost'; $('deadlineWrap').hidden = c.stage !== 'In build';
    const board = state.me.stages.filter((s) => s !== 'Lost' && s !== 'LTO');
    const idx = board.indexOf(c.stage);
    $('stageBar').innerHTML = board.map((s, i) => `<button type="button" class="sb ${i <= idx ? 'on' : ''} ${i === idx ? 'cur' : ''}" data-stage="${esc(s)}" title="${esc(s)}"></button>`).join('')
      + `<span class="sb-label">${c.stage === 'LTO' ? 'LTO' : c.stage === 'Lost' ? 'Lost' + (c.lost_reason ? ': ' + esc(c.lost_reason) : '') : `Step ${idx + 1} of ${board.length}`}</span>`;
    const early = ['Prospects', 'Attempt to connect', 'LTO', 'Lost'].includes(c.stage);
    $('touchText').textContent = early
      ? (c.touches ? `${c.touches} of ${state.me.maxTouches} touches sent${c.last_touch ? ', last ' + shortDate(c.last_touch) : ''}` : 'No outreach logged yet')
      : (c.last_touch ? `Last touch ${shortDate(c.last_touch)}` : 'Log a touch when you follow up');
    $('igBtn').classList.toggle('disabled', !c.instagram); $('igBtn').href = c.instagram ? igUrl(c.instagram) : '#';
    $('mailBtn').classList.toggle('disabled', !c.email); $('mailBtn').href = c.email ? `mailto:${c.email}` : '#';
    $('fName').value = c.name; $('fBusiness').value = c.business; $('fPhone').value = c.phone || '';
    $('fEmail').value = c.email; $('fWebsite').value = c.website; $('fInstagram').value = c.instagram; $('fSource').value = c.source || ''; $('fNotes').value = c.notes;
    $('optedOutBanner').hidden = !c.opted_out;
    const locked = !c.opt_in_at && !c.opted_out && Boolean(c.phone);
    $('optInForm').hidden = !locked;
    if (locked) { $('oiChannel').value = ''; $('oiDate').value = today(); $('oiNote').value = ''; }
    $('optInRecord').hidden = !c.opt_in_at;
    $('optInText').textContent = c.opt_in_at ? `${c.opt_in_at} · ${c.opt_in_channel}${c.opt_in_note ? ' · ' + c.opt_in_note : ''}` : '';
    $('msgInput').disabled = $('sendBtn').disabled = Boolean(c.opted_out) || !c.opt_in_at || !state.me.textingReady || !c.phone;
    $('msgInput').placeholder = !c.phone ? 'Add a phone number to call or text' : state.me.textingReady ? 'Write a text…' : 'Texting turns on once your number is approved';
    const canCall = state.me.callingReady && c.phone;
    $('callBtn').classList.toggle('disabled', !canCall);
    $('callBtn').title = !c.phone ? 'No phone number yet' : !state.me.callingReady ? 'Calling turns on once your number is set up' : 'Call';
    $('saveState').textContent = '';
  }

  function setTab(tab) {
    document.querySelectorAll('.rec-mid .tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    $('tabActivity').hidden = tab !== 'activity'; $('tabTexts').hidden = tab !== 'texts';
    if (tab === 'texts') { const tl = $('timeline'); tl.scrollTop = tl.scrollHeight; }
  }
  document.querySelectorAll('.rec-mid .tab').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
  $('qaNote').addEventListener('click', () => { setTab('activity'); $('noteInput').focus(); });
  $('qaText').addEventListener('click', () => { setTab('texts'); if (!$('msgInput').disabled) $('msgInput').focus(); });
  $('igBtn').addEventListener('click', (e) => { if ($('igBtn').classList.contains('disabled')) { e.preventDefault(); toast('No Instagram handle yet.'); } });
  $('mailBtn').addEventListener('click', (e) => { if ($('mailBtn').classList.contains('disabled')) { e.preventDefault(); toast('No email yet.'); } });
  $('stageBar').addEventListener('click', (e) => {
    const b = e.target.closest('[data-stage]'); if (!b || !state.current || b.dataset.stage === state.current.stage) return;
    $('fStage').value = b.dataset.stage; saveField('stage', b.dataset.stage);
  });

  async function loadContactTasks() {
    if (!state.current) return;
    const id = state.current.id;
    const { tasks } = await api(`/api/tasks?contact=${id}`);
    if (!state.current || state.current.id !== id) return;
    $('cTasks').innerHTML = tasks.map(taskRow).join('') || '<li class="empty-row">No tasks.</li>';
  }
  $('cTaskForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/api/tasks', { method: 'POST', body: { title: $('cTaskTitle').value, due: $('cTaskDue').value || null, contact_id: state.current.id } });
      $('cTaskForm').reset(); loadContactTasks();
    } catch (err) { toast(err.message); }
  });
  $('touchBtn').addEventListener('click', async () => {
    try { state.current = await logTouch(state.current.id); fillContact(); loadTimeline(false); } catch (err) { toast(err.message); }
  });
  $('repliedBtn').addEventListener('click', async () => {
    try { state.current = await markReplied(state.current.id); fillContact(); loadContactTasks(); } catch (err) { toast(err.message); }
  });
  $('noteForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = $('noteInput').value.trim(); if (!body) return;
    const kind = new FormData($('noteForm')).get('kind');
    try {
      await api(`/api/contacts/${state.current.id}/notes`, { method: 'POST', body: { body, kind } });
      $('noteInput').value = ''; loadTimeline(false);
    } catch (err) { toast(err.message); }
  });

  const actLabel = { note: 'Note', dm: 'Instagram DM', email: 'Email', dial: 'Call' };
  async function loadTimeline(scroll) {
    const id = state.current.id;
    const { items } = await api(`/api/contacts/${id}/timeline`);
    if (!state.current || state.current.id !== id) return;
    // Texts tab: SMS conversation only.
    const tl = $('timeline');
    const atBottom = tl.scrollHeight - tl.scrollTop - tl.clientHeight < 60;
    const msgs = items.filter((i) => i.type === 'message');
    const hasOut = msgs.some((i) => i.direction === 'out' && !['failed', 'undelivered'].includes(i.status));
    const box = $('optOutCheck');
    if (!hasOut) { box.checked = true; box.disabled = true; } else if (box.disabled) { box.disabled = false; box.checked = false; }
    tl.innerHTML = msgs.map((i) => {
      const failed = ['failed', 'undelivered'].includes(i.status);
      const meta = [when(i.created_at), i.direction === 'out' ? (i.status || '') : '', failed && i.error ? i.error : ''].filter(Boolean).join(' · ');
      return `<li class="${i.direction} ${failed ? 'failed' : ''}"><div class="msg">${esc(i.body)}</div><div class="meta">${esc(meta)}</div></li>`;
    }).join('') || `<li class="callrow">${state.current.phone ? 'No texts yet.' : 'No phone number yet.'}</li>`;
    if (scroll || atBottom) tl.scrollTop = tl.scrollHeight;
    // Activity tab: everything, newest first.
    $('activity').innerHTML = [...items].reverse().map((i) => {
      if (i.type === 'message') {
        return `<li class="act act-text"><span class="act-ic">✉</span><div class="act-body"><div class="act-head"><b>${i.direction === 'out' ? 'Text sent' : 'Text received'}</b><span class="muted">${esc(when(i.created_at))}</span></div><p>${esc(i.body)}</p></div></li>`;
      }
      if (i.type === 'call') {
        const dur = i.duration ? ` · ${Math.floor(i.duration / 60)}:${String(i.duration % 60).padStart(2, '0')}` : '';
        const rec = i.has_recording ? `<audio controls preload="none" src="/api/calls/${i.id}/recording"></audio><a class="link" href="/api/calls/${i.id}/recording" download="call-${i.id}.mp3">Download recording</a>` : '';
        return `<li class="act act-call"><span class="act-ic">☎</span><div class="act-body"><div class="act-head"><b>${i.direction === 'out' ? 'Outgoing call' : 'Incoming call'}</b><span class="muted">${esc(when(i.created_at))}</span></div><p class="muted">${esc(i.status || '')}${dur}</p>${rec}</div></li>`;
      }
      const head = i.kind === 'dial' ? `Call logged: ${esc(i.outcome_label)}` : `${actLabel[i.kind] || 'Note'}`;
      return `<li class="act act-${esc(i.kind)}"><span class="act-ic">${i.kind === 'dial' ? '☎' : i.kind === 'dm' ? '◎' : i.kind === 'email' ? '@' : '✎'}</span><div class="act-body"><div class="act-head"><b>${head}</b><span class="muted">${esc(when(i.created_at))}</span></div>${i.body ? `<p>${esc(i.body)}</p>` : ''}</div></li>`;
    }).join('') || '<li class="empty-row">No activity yet. Log a note, a DM or a call above.</li>';
  }

  // Autosave contact fields.
  const fieldMap = { fStage: 'stage', fFollow: 'next_follow_up', fValue: 'value', fNext: 'next_step', fLost: 'lost_reason', fDeadline: 'deadline', fName: 'name', fBusiness: 'business', fPhone: 'phone', fEmail: 'email', fWebsite: 'website', fInstagram: 'instagram', fSource: 'source', fNotes: 'notes' };
  async function saveField(key, value) {
    if (!state.current) return;
    $('saveState').textContent = 'Saving…';
    try {
      const { contact } = await api(`/api/contacts/${state.current.id}`, { method: 'PATCH', body: { [key]: value, today: today() } });
      state.current = contact; fillContact(); $('saveState').textContent = 'Saved';
      if (key === 'stage') { loadContactTasks(); toast(`Moved to ${contact.stage}`); }
    } catch (err) { $('saveState').textContent = ''; toast(err.message); fillContact(); }
  }
  Object.entries(fieldMap).forEach(([id, key]) => $(id).addEventListener('change', (e) => saveField(key, e.target.value)));
  $('fHot').addEventListener('change', (e) => saveField('hot', e.target.checked));
  document.querySelectorAll('[data-days]').forEach((b) => b.addEventListener('click', () => {
    const v = today(Number(b.dataset.days)); $('fFollow').value = v; saveField('next_follow_up', v);
  }));
  $('clearFollow').addEventListener('click', () => { $('fFollow').value = ''; saveField('next_follow_up', null); });
  $('deleteBtn').addEventListener('click', async () => {
    if (!state.current) return;
    if (!window.confirm(`Delete ${displayName(state.current)} and all their texts, calls and notes?`)) return;
    await api(`/api/contacts/${state.current.id}`, { method: 'DELETE', body: {} });
    state.current = null; location.hash = 'contacts';
  });

  // ---------- opt-in + texting ----------
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
  const updateCount = () => {
    const extra = $('optOutCheck').checked ? state.me.optOutLine.length + 2 : 0;
    const n = $('msgInput').value.length + extra;
    const segs = n <= 160 ? 1 : Math.ceil(n / 153);
    $('charCount').textContent = n ? `${n} chars · ${segs} text${segs > 1 ? 's' : ''}` : '';
  };
  $('msgInput').addEventListener('input', updateCount);
  $('optOutCheck').addEventListener('change', updateCount);
  $('msgInput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) $('composer').requestSubmit(); });
  $('composer').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = $('msgInput').value.trim();
    if (!body || !state.current) return;
    $('sendBtn').disabled = true;
    try {
      await api(`/api/contacts/${state.current.id}/messages`, { method: 'POST', body: { body, addOptOut: $('optOutCheck').checked } });
      $('msgInput').value = ''; updateCount();
      await loadTimeline(true);
    } catch (err) { toast(err.message); await loadTimeline(true).catch(() => {}); }
    finally { $('sendBtn').disabled = Boolean(state.current && state.current.opted_out); }
  });

  // ---------- dialer ----------
  const DEFAULT_SCRIPT = `<p><b>Opener</b></p>
<p>Hi, is this {name}? This is Sai from Sharkflow Labs. I'll be quick.</p>
<p><b>Reason for the call</b></p>
<p>I build websites for local businesses like {business}. I already put together a free demo homepage for you, no strings attached.</p>
<p><b>The ask</b></p>
<p>Could I text you the link so you can take a look when you have a minute?</p>
<p class="muted">If yes: tick "They said yes to getting texts", then log Interested or Connected.</p>
<p><b>If they already have a site</b></p>
<p>Totally fair. Most owners I talk to say theirs doesn't bring in calls. The demo is built to fix that. Worth a 30 second look?</p>
<p><b>If not interested</b></p>
<p>No problem at all, thanks for your time {name}. Have a good one.</p>
<p class="muted">Call between 8am and 9pm their time. Don't call numbers on the Do Not Call list.</p>`;
  function initScript() {
    $('scriptBox').innerHTML = lsGet('script') || DEFAULT_SCRIPT;
    $('scriptBox').addEventListener('input', () => lsSet('script', $('scriptBox').innerHTML));
    $('scriptReset').addEventListener('click', () => { $('scriptBox').innerHTML = DEFAULT_SCRIPT; lsSet('script', DEFAULT_SCRIPT); renderScriptNames(); });
  }
  function renderScriptNames() {
    const c = state.queue[state.qi];
    $('scriptBox').querySelectorAll('[data-fill]').forEach((n) => n.replaceWith(document.createTextNode(n.dataset.fill)));
    if (!c) return;
    const name = (c.name || '').split(' ')[0] || 'there';
    const walker = document.createTreeWalker($('scriptBox'), NodeFilter.SHOW_TEXT);
    const nodes = []; while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const n of nodes) {
      if (!/\{(name|business)\}/.test(n.nodeValue)) continue;
      const frag = document.createDocumentFragment();
      n.nodeValue.split(/(\{name\}|\{business\})/).forEach((part) => {
        if (part === '{name}' || part === '{business}') {
          const s = document.createElement('mark'); s.dataset.fill = part; s.contentEditable = 'false';
          s.textContent = part === '{name}' ? name : (c.business || 'your business'); frag.appendChild(s);
        } else if (part) frag.appendChild(document.createTextNode(part));
      });
      n.replaceWith(frag);
    }
  }

  async function loadQueue() {
    const { contacts } = await api('/api/pipeline');
    state.pipeline = contacts;
    const f = state.queueFilter; const t = today();
    let q = contacts.filter((c) => c.phone && c.stage !== 'Closed won + site live');
    if (f === 'due') q = q.filter((c) => c.next_follow_up && c.next_follow_up <= t && c.stage !== 'Lost');
    else if (f !== 'all') q = q.filter((c) => c.stage === f);
    q.sort((a, b) => (b.hot - a.hot) || String(a.next_follow_up || '9999').localeCompare(String(b.next_follow_up || '9999')));
    const keep = state.queue[state.qi] && state.queue[state.qi].id;
    state.queue = q;
    state.qi = 0;
    const want = state.pendingDial || keep;
    if (want) {
      let i = q.findIndex((c) => c.id === want);
      if (i < 0 && state.pendingDial) { const c = contacts.find((x) => x.id === want); if (c && c.phone) { q.unshift(c); i = 0; } }
      if (i >= 0) state.qi = i;
    }
    state.pendingDial = null;
    const withPhone = contacts.filter((c) => c.phone).length;
    $('dialerSub').textContent = `${withPhone} of ${contacts.length} contacts have a phone number.`;
    const n = $('dialerNotice');
    n.hidden = state.me.callingReady;
    n.innerHTML = 'Calling turns on once Twilio approves your business profile and you connect a number. Until then you can still work the list: call from your own phone and log each outcome here.';
    renderSession(); renderQueue(); renderDialCard();
  }
  function renderQueue() {
    $('queueCount').textContent = `${state.queue.length} to call`;
    $('queueList').innerHTML = state.queue.map((c, i) => `<li class="${i === state.qi ? 'cur' : ''} ${i < state.qi ? 'past' : ''}" data-qi="${i}">
      ${avatar(c, 'sm')}<div class="grow"><b>${esc(displayName(c))}</b><div class="muted">${esc(c.stage)}${c.next_follow_up ? ' · ' + esc(shortDate(c.next_follow_up)) : ''}</div></div>${c.hot ? '<span class="tag hot">Hot</span>' : ''}</li>`).join('')
      || '<li class="empty-row">No one with a phone number in this list.</li>';
  }
  function renderSession() {
    const s = state.session;
    $('sessionStats').innerHTML = `<div><b>${s.dials}</b><span>Dials</span></div><div><b>${s.connects}</b><span>Connects</span></div><div><b>${Math.floor(s.talk / 60)}m</b><span>Talk time</span></div>`;
  }
  function renderDialCard() {
    const c = state.queue[state.qi];
    $('dialEmpty').hidden = Boolean(c); $('dialCard').hidden = !c;
    if (!c) return;
    $('dAvatar').outerHTML = avatar(c, 'xl').replace('<span ', '<span id="dAvatar" ');
    $('dName').textContent = displayName(c);
    $('dSub').textContent = [c.name && c.business ? c.name : '', c.instagram ? '@' + c.instagram : ''].filter(Boolean).join(' · ');
    $('dTags').innerHTML = stagePill(c.stage) + (c.value ? `<span class="tag">${money(c.value)}</span>` : '') + (c.hot ? '<span class="tag hot">Hot</span>' : '')
      + (['Prospects', 'Attempt to connect'].includes(c.stage) && c.touches ? `<span class="tag">${c.touches}/${state.me.maxTouches} touches</span>` : '');
    $('dPhone').textContent = fmtPhone(c.phone);
    $('dLocal').textContent = 'Call between 8am and 9pm their time';
    $('dOpen').href = '#c/' + c.id;
    $('dNext').textContent = c.next_step || '-';
    $('dLast').textContent = c.last_activity_at ? when(c.last_activity_at) : (c.last_touch ? shortDate(c.last_touch) : 'Never');
    $('dNotes').value = ''; $('dOptIn').checked = false; $('dCallback').value = today(1);
    $('dCall').disabled = !state.me.callingReady;
    $('dCall').title = state.me.callingReady ? 'Call' : 'Calling turns on once your number is set up';
    setDialing(false);
    renderScriptNames();
  }
  function setDialing(on, label = '') {
    $('dCall').hidden = on; $('dHang').hidden = !on; $('dMute').hidden = !on; $('dKeys').hidden = !on;
    $('dState').textContent = label;
    if (!on) $('dKeypad').hidden = true;
  }
  $('queueFilter').addEventListener('change', (e) => { state.queueFilter = e.target.value; state.queue = []; loadQueue().catch((err) => toast(err.message)); });
  $('queueList').addEventListener('click', (e) => {
    const li = e.target.closest('[data-qi]'); if (!li || state.call) return;
    state.qi = Number(li.dataset.qi); renderQueue(); renderDialCard();
  });
  $('dSkip').addEventListener('click', () => { if (state.call) return; nextInQueue(); });
  function nextInQueue() {
    if (state.qi < state.queue.length - 1) state.qi++;
    else { toast('End of the list.'); }
    renderQueue(); renderDialCard();
    const cur = $('queueList').querySelector('.cur'); if (cur) cur.scrollIntoView({ block: 'nearest' });
  }
  $('dCall').addEventListener('click', () => {
    const c = state.queue[state.qi]; if (!c) return;
    state.session.dials++; renderSession();
    placeCall(c.phone, displayName(c), true);
  });
  $('dHang').addEventListener('click', () => state.call && state.call.disconnect());
  $('dMute').addEventListener('click', () => {
    if (!state.call) return; const m = !state.call.isMuted(); state.call.mute(m); $('dMute').textContent = m ? 'Unmute' : 'Mute';
  });
  $('dKeypad').innerHTML = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'].map((d) => `<button type="button">${d}</button>`).join('');
  $('dKeypad').addEventListener('click', (e) => { if (e.target.tagName === 'BUTTON' && state.call) state.call.sendDigits(e.target.textContent); });
  $('dKeys').addEventListener('click', () => { $('dKeypad').hidden = !$('dKeypad').hidden; });
  $('outcomes').addEventListener('click', (e) => { const b = e.target.closest('[data-outcome]'); if (b) logOutcome(b.dataset.outcome); });
  document.addEventListener('keydown', (e) => {
    if (state.page !== 'dialer' || $('dialCard').hidden) return;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName) || e.target.isContentEditable) return;
    const keys = Object.keys(state.me.outcomes);
    const n = Number(e.key);
    if (n >= 1 && n <= keys.length) { e.preventDefault(); logOutcome(keys[n - 1]); }
  });
  async function logOutcome(outcome) {
    const c = state.queue[state.qi]; if (!c) return;
    if (state.call) { toast('Hang up first, then log the outcome.'); return; }
    try {
      if ($('dOptIn').checked) {
        await api(`/api/contacts/${c.id}`, { method: 'PATCH', body: { opt_in_at: today(), opt_in_channel: 'Phone call', opt_in_note: 'Said yes on a call to getting texts' } });
      }
      const { contact } = await api(`/api/contacts/${c.id}/disposition`, { method: 'POST', body: {
        outcome, note: $('dNotes').value, today: today(), callback: $('dCallback').value,
      } });
      if (['connected', 'interested', 'not_interested', 'callback'].includes(outcome)) state.session.connects++;
      renderSession();
      Object.assign(c, contact);
      toast(`${displayName(contact)}: ${state.me.outcomes[outcome]}${contact.stage !== c.stage ? '' : ''} · ${contact.stage}`);
      if ($('autoNext').checked) nextInQueue(); else renderDialCard();
    } catch (err) { toast(err.message); }
  }

  // ---------- CSV import ----------
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
    value: ['value', 'deal value', 'price', 'amount'], source: ['source', 'lead source', 'found on', 'found via'],
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
      route();
    } catch (err) { $('importResult').textContent = err.message; }
  });

  // ---------- calling (Twilio Voice JS SDK) ----------
  function setPhoneStatus(kind, title) {
    const d = $('phoneStatus'); d.className = 'dot ' + kind; d.title = title;
  }
  async function fetchToken() { return (await api('/api/voice-token')).token; }
  async function setupVoice() {
    if (!window.Twilio || !window.Twilio.Device) { setPhoneStatus('off', 'Calling failed to load'); return; }
    try {
      const device = new Twilio.Device(await fetchToken(), { codecPreferences: ['opus', 'pcmu'], closeProtection: true });
      state.device = device;
      device.on('registered', () => setPhoneStatus('on', 'Ready for calls'));
      device.on('unregistered', () => setPhoneStatus('off', 'Calling off (click to retry)'));
      device.on('error', (err) => { console.error(err); toast(`Calling error: ${err.message}`); });
      device.on('tokenWillExpire', async () => device.updateToken(await fetchToken()));
      device.on('incoming', onIncoming);
      await device.register();
    } catch (err) { setPhoneStatus('off', 'Calling off (click to retry)'); console.error(err); }
  }
  $('phoneStatus').addEventListener('click', () => { if (state.me.callingReady && !(state.device && state.device.state === 'registered')) setupVoice(); });

  function nameFor(phone) {
    const c = [...state.pipeline, ...state.contacts].find((x) => x.phone === phone);
    return c ? displayName(c) : fmtPhone(phone);
  }
  async function placeCall(to, label, fromDialer = false, oneOff = false) {
    if (!state.device) return toast('Calling is not ready yet.');
    if (state.call) return toast('You are already on a call.');
    try {
      const call = await state.device.connect({ params: oneOff ? { To: to, OneOff: '1' } : { To: to } });
      attachCall(call, label || nameFor(to), 'Calling…', fromDialer);
    } catch (err) { toast(err.message); }
  }
  $('callBtn').addEventListener('click', () => {
    const c = state.current; if (!c) return;
    if ($('callBtn').classList.contains('disabled')) return toast($('callBtn').title);
    placeCall(c.phone, displayName(c));
  });
  $('quickDialForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('quickDial').value.trim();
    if (!v) return toast('Type a number first.');
    if (state.call) { if (/^[0-9*#]$/.test(v.slice(-1))) state.call.sendDigits(v.slice(-1)); return; }
    placeCall(v, null, false, true);
  });
  $('qdKeys').addEventListener('click', (e) => {
    const b = e.target.closest('[data-k]'); if (!b) return;
    const k = b.dataset.k, input = $('quickDial');
    if (k === 'del') input.value = input.value.slice(0, -1);
    else { input.value += k; if (state.call && k !== '+') state.call.sendDigits(k); }
    input.focus();
  });

  function attachCall(call, who, initial, fromDialer = false) {
    state.call = call;
    const inDialer = fromDialer && state.page === 'dialer';
    if (inDialer) setDialing(true, initial);
    else {
      $('callWho').textContent = who; $('callState').textContent = initial; $('callTimer').textContent = '';
      $('muteBtn').textContent = 'Mute'; $('keypad').hidden = true; $('callBar').hidden = false;
    }
    let t0 = 0;
    call.on('accept', () => {
      t0 = Date.now();
      if (!inDialer) $('callState').textContent = 'Connected';
      state.timer = setInterval(() => {
        const s = Math.floor((Date.now() - t0) / 1000);
        const txt = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
        if (inDialer) $('dState').textContent = 'Connected ' + txt; else $('callTimer').textContent = txt;
      }, 1000);
    });
    const end = () => {
      clearInterval(state.timer); state.call = null; $('callBar').hidden = true;
      if (t0) { state.session.talk += Math.floor((Date.now() - t0) / 1000); renderSession(); }
      if (inDialer) { setDialing(false, t0 ? 'Call ended. Log the outcome.' : 'No answer? Log the outcome.'); $('dMute').textContent = 'Mute'; }
      setTimeout(() => { if (state.page === 'record' && state.current) loadTimeline(true); }, 1500);
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
    const clear = () => { $('incoming').hidden = true; state.incoming = null; poll(); };
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

  // ---------- lead assistant (screenshot -> prospect) ----------
  const ai = { images: [], busy: false };
  const aiLog = (html, cls) => {
    const li = document.createElement('li'); li.className = cls; li.innerHTML = html;
    $('aiLog').appendChild(li); $('aiLog').scrollTop = $('aiLog').scrollHeight; return li;
  };
  function openAi() {
    $('aiPanel').hidden = false; $('aiFab').hidden = true;
    if (!$('aiLog').children.length) {
      aiLog(state.me.assistantReady
        ? 'Hi Sai. Send me a screenshot of a business (Google Maps, Instagram, Facebook, Yelp) or paste their details. I\'ll pull out the name, phone, Instagram and more, check it isn\'t already in your CRM, and add it to Prospects once you OK it.'
        : 'The assistant isn\'t switched on yet. The Worker needs its Workers AI binding; redeploy it, then refresh.', 'ai-msg bot');
    }
    $('aiText').focus();
  }
  $('aiFab').addEventListener('click', openAi);
  $('aiClose').addEventListener('click', () => { $('aiPanel').hidden = true; $('aiFab').hidden = false; });

  // Shrink screenshots in the browser so uploads stay small (long side 1600px, JPEG).
  function shrink(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        const url = c.toDataURL('image/jpeg', 0.85);
        URL.revokeObjectURL(img.src);
        resolve({ media_type: 'image/jpeg', data: url.split(',')[1], url });
      };
      img.onerror = () => reject(new Error('Could not read that image'));
      img.src = URL.createObjectURL(file);
    });
  }
  async function addImages(files) {
    for (const f of files) {
      if (!f.type.startsWith('image/')) continue;
      if (ai.images.length >= 4) { toast('Up to 4 screenshots at a time.'); break; }
      try { ai.images.push(await shrink(f)); } catch (e) { toast(e.message); }
    }
    renderThumbs();
  }
  function renderThumbs() {
    $('aiThumbs').innerHTML = ai.images.map((im, i) => `<span><img src="${im.url}" alt="Screenshot ${i + 1}"><button type="button" data-rmimg="${i}" aria-label="Remove">✕</button></span>`).join('');
  }
  $('aiThumbs').addEventListener('click', (e) => { const b = e.target.closest('[data-rmimg]'); if (b) { ai.images.splice(Number(b.dataset.rmimg), 1); renderThumbs(); } });
  $('aiFile').addEventListener('change', (e) => { addImages([...e.target.files]); e.target.value = ''; });
  $('aiText').addEventListener('paste', (e) => {
    const files = [...(e.clipboardData || {}).items || []].filter((i) => i.kind === 'file').map((i) => i.getAsFile()).filter(Boolean);
    if (files.length) { e.preventDefault(); addImages(files); }
  });
  $('aiForm').addEventListener('dragover', (e) => { e.preventDefault(); $('aiForm').classList.add('drag'); });
  $('aiForm').addEventListener('dragleave', () => $('aiForm').classList.remove('drag'));
  $('aiForm').addEventListener('drop', (e) => { e.preventDefault(); $('aiForm').classList.remove('drag'); addImages([...e.dataTransfer.files]); });
  $('aiText').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('aiForm').requestSubmit(); } });

  $('aiForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (ai.busy) return;
    const text = $('aiText').value.trim();
    if (!text && !ai.images.length) return;
    if (!state.me.assistantReady) { aiLog('The assistant isn\'t switched on yet. Redeploy the Worker, then refresh.', 'ai-msg bot err'); return; }
    const images = ai.images; ai.images = []; renderThumbs(); $('aiText').value = '';
    aiLog(esc(text) + images.map((im) => `<img src="${im.url}" alt="">`).join(''), 'ai-msg me');
    const wait = aiLog('<span class="typing">Reading</span>', 'ai-msg bot');
    ai.busy = true; $('aiSend').disabled = true;
    try {
      const r = await api('/api/assistant/extract', { method: 'POST', body: { text, images: images.map(({ media_type, data }) => ({ media_type, data })) } });
      wait.remove();
      leadCard(r.lead, r.duplicates);
    } catch (err) { wait.className = 'ai-msg bot err'; wait.textContent = err.message; }
    finally { ai.busy = false; $('aiSend').disabled = false; }
  });

  function leadCard(lead, dups) {
    const f = (k, label, full) => `<label${full ? ' style="grid-column:1/-1"' : ''}>${label}<input data-k="${k}" value="${esc(lead[k])}"></label>`;
    const dupHtml = dups.length ? `<div class="ai-dup">Already in your CRM: ${dups.map((d) => `<a href="#c/${d.id}">${esc(d.business || d.name || d.instagram || d.phone)}</a> (${esc(d.stage)})`).join(', ')}. Add anyway only if it's a different business.</div>` : '';
    const li = aiLog(`<div class="row between"><b>Here's what I found</b><span class="muted small">Check it, then add</span></div>
      <div class="grid2">${f('business', 'Business', true)}${f('name', 'Contact')}${f('phone', 'Phone')}${f('instagram', 'Instagram')}${f('email', 'Email')}${f('website', 'Website')}${f('trade', 'Trade')}${f('city', 'City', true)}</div>
      <label>Notes<textarea data-k="notes" rows="3">${esc(lead.notes)}</textarea></label>
      <div class="grid2"><label>Lead source<select data-k="source"><option value="">Not set</option>${(state.me.sources || []).map((x) => `<option ${x === lead.source ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select></label><label>Stage<select data-k="stage">${state.me.stages.map((s) => `<option ${s === 'Prospects' ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select></label><label style="grid-column:1/-1">Amount ($)<input data-k="value" inputmode="numeric"></label></div>
      ${dupHtml}
      <div class="row end"><button type="button" class="btn small" data-act="skip">Discard</button><button type="button" class="btn primary small" data-act="add">${dups.length ? 'Add anyway' : 'Add to CRM'}</button></div>`, 'ai-card');
    li.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-act]'); if (!b) return;
      if (b.dataset.act === 'skip') { li.remove(); aiLog('Discarded.', 'ai-msg bot'); return; }
      const v = Object.fromEntries([...li.querySelectorAll('[data-k]')].map((x) => [x.dataset.k, x.value.trim()]));
      const head = [v.trade, v.city].filter(Boolean).join(' · ');
      const body = { business: v.business, name: v.name, phone: v.phone, instagram: v.instagram, email: v.email, website: v.website, source: v.source,
        stage: v.stage, value: v.value, next_follow_up: today(), notes: [head, v.notes, 'Added by the lead assistant ' + today()].filter(Boolean).join('\n') };
      b.disabled = true;
      try {
        const { contact } = await api('/api/contacts', { method: 'POST', body });
        li.querySelectorAll('input,textarea,select,button').forEach((x) => { x.disabled = true; });
        aiLog(`Added <a href="#c/${contact.id}">${esc(displayName(contact))}</a> to ${esc(contact.stage)}. Follow-up set for today.`, 'ai-msg bot');
        if (['home', 'pipeline', 'contacts'].includes(state.page)) route();
      } catch (err) { b.disabled = false; aiLog(esc(err.message), 'ai-msg bot err'); }
    });
  }

  start();
})();
