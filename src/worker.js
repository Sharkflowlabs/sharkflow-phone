// Sharkflow Phone: a one-person texting + calling inbox on Twilio and Cloudflare.
import Anthropic from '@anthropic-ai/sdk';
// One Worker serves the UI (from /public), a JSON API under /api, and Twilio webhooks under /twilio.

const STAGES = [
  'Prospects', 'Attempt to connect', 'Connected', 'Interested', 'In build', 'Closed won + site live', 'LTO', 'Lost',
];
const FIRST = 'Prospects';
const ATC = 'Attempt to connect';
// Stages where nobody has answered yet: logging a touch follows the no-reply cadence.
const EARLY = [FIRST, ATC, 'LTO', 'Lost'];
// Pipeline value is counted from Interested onward.
const PIPELINE = ['Interested', 'In build'];
const WON = 'Closed won + site live';
// Tasks created automatically when a deal moves into a stage: [title, days from today].
const STAGE_TASKS = {
  'Connected': [['Send the demo link', 1]],
  'Interested': [['Send mockup and pricing', 1], ['Chase the payment', 4]],
  'In build': [['Collect logo, photos and content', 1], ['Deliver the site', 7]],
  'Closed won + site live': [['Ask for a review and a referral', 3]],
};
// A deal is "stale" when it sits in one of these stages longer than this many days with no activity.
const STALE_DAYS = { 'Connected': 3, 'Interested': 5, 'In build': 7 };
const OUTCOMES = {
  no_answer: 'No answer', voicemail: 'Left voicemail', connected: 'Connected', interested: 'Interested',
  not_interested: 'Not interested', callback: 'Call back later', bad_number: 'Wrong number',
};
// Days to wait after outreach touch 1, 2 and 3. After touch 4 with no reply the deal goes to Lost (No response) with a 90 day retry.
const TOUCH_GAPS = [2, 3, 5];
const MAX_TOUCHES = 4;
const LOST_REASONS = ['No response', 'Not interested', 'Too expensive', 'Went with someone else', 'Other'];
const STOP_WORDS = ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'OPTOUT', 'REVOKE'];
const START_WORDS = ['START', 'UNSTOP', 'YES'];
const OPT_IN_CHANNELS = ['Instagram DM', 'Phone call', 'Email', 'Website form', 'In person', 'Texted us first', 'Other'];
const CLIENT_IDENTITY = 'owner';
const COOKIE = 'sfp_session';
const SESSION_DAYS = 30;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith('/twilio/')) return await handleTwilio(request, env, url);
      if (url.pathname === '/public/optin' || url.pathname === '/public/lead') return await handlePublicLead(request, env, url);
      if (url.pathname.startsWith('/api/')) return await handleApi(request, env, url);
      return env.ASSETS.fetch(request);
    } catch (err) {
      console.error(err && err.stack || err);
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      return json({ error: 'Server error' }, 500);
    }
  },
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ---------- helpers ----------

const enc = new TextEncoder();

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

function twiml(inner) {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`, {
    headers: { 'content-type': 'text/xml; charset=utf-8' },
  });
}

function xmlEscape(s) {
  return String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}

function nowIso() { return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'); }

const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
function addDays(day, n) {
  const d = new Date(day + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
// The browser sends its local date so "today" matches the user's day, not UTC.
function todayFrom(v) { return isDate(v) ? v : nowIso().slice(0, 10); }

// Accepts @handle, handle, or an instagram.com URL and returns the bare handle.
export function igHandle(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  const m = s.match(/instagram\.com\/([A-Za-z0-9._]+)/i);
  if (m) s = m[1];
  s = s.replace(/^@/, '').replace(/[/?#].*$/, '');
  return /^[A-Za-z0-9._]{1,30}$/.test(s) ? s.toLowerCase() : '';
}

export function normalizePhone(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  const digits = s.replace(/\D/g, '');
  if (s.startsWith('+')) return digits.length >= 8 && digits.length <= 15 ? '+' + digits : null;
  if (s.startsWith('00') && digits.length > 10) return '+' + digits.slice(2);
  if (digits.length === 10) return '+1' + digits;                    // US/Canada without country code
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  return null;
}

function b64(bytes) {
  let bin = '';
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin);
}
function b64url(input) {
  const s = typeof input === 'string' ? btoa(unescape(encodeURIComponent(input))) : b64(input);
  return s.replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function hmac(algo, key, data) {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: algo }, false, ['sign']);
  return crypto.subtle.sign('HMAC', k, enc.encode(data));
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = enc.encode(a), y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

function requireEnv(env, ...names) {
  const missing = names.filter((n) => !env[n]);
  if (missing.length) throw new HttpError(500, `Missing setting: ${missing.join(', ')}`);
}

function twilioAuthHeader(env) {
  return 'Basic ' + btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`);
}

// ---------- auth ----------

async function makeSession(env) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400;
  const sig = b64url(await hmac('SHA-256', env.SESSION_SECRET, String(exp)));
  return `${exp}.${sig}`;
}

async function isLoggedIn(request, env) {
  const cookie = request.headers.get('cookie') || '';
  const m = cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!m || !env.SESSION_SECRET) return false;
  const [exp, sig] = m[1].split('.');
  if (!exp || !sig || Number(exp) < Date.now() / 1000) return false;
  const expected = b64url(await hmac('SHA-256', env.SESSION_SECRET, exp));
  return safeEqual(sig, expected);
}

function sessionCookie(value, maxAge) {
  return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

// ---------- API ----------

async function readJson(request) {
  if (!(request.headers.get('content-type') || '').includes('application/json')) {
    throw new HttpError(415, 'Expected JSON');
  }
  try { return await request.json(); } catch { throw new HttpError(400, 'Bad JSON'); }
}

async function handleApi(request, env, url) {
  const path = url.pathname;
  const method = request.method;

  if (path === '/api/login' && method === 'POST') {
    requireEnv(env, 'APP_PASSWORD', 'SESSION_SECRET');
    const { password } = await readJson(request);
    if (!safeEqual(String(password || ''), env.APP_PASSWORD)) {
      await new Promise((r) => setTimeout(r, 800));
      return json({ error: 'Wrong password' }, 401);
    }
    return json({ ok: true }, 200, { 'set-cookie': sessionCookie(await makeSession(env), SESSION_DAYS * 86400) });
  }
  if (path === '/api/logout' && method === 'POST') {
    return json({ ok: true }, 200, { 'set-cookie': sessionCookie('', 0) });
  }

  if (!(await isLoggedIn(request, env))) return json({ error: 'Not logged in' }, 401);
  // Mutating requests must be JSON (blocks form-based CSRF on top of SameSite=Strict).
  if (method !== 'GET' && method !== 'HEAD' && !(request.headers.get('content-type') || '').includes('application/json')) {
    return json({ error: 'Expected JSON' }, 415);
  }

  const db = env.DB;
  let m;

  if (path === '/api/me' && method === 'GET') {
    return json({
      stages: STAGES,
      optInChannels: OPT_IN_CHANNELS,
      number: env.TWILIO_NUMBER || null,
      callingReady: Boolean(env.TWILIO_API_KEY_SID && env.TWILIO_API_KEY_SECRET && env.TWILIO_TWIML_APP_SID),
      textingReady: Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_NUMBER),
      optOutLine: optOutLine(env),
      staleDays: STALE_DAYS,
      lostReasons: LOST_REASONS,
      maxTouches: MAX_TOUCHES,
      outcomes: OUTCOMES,
      assistantReady: Boolean(env.AI || env.ANTHROPIC_API_KEY),
      pipelineStages: PIPELINE,
    });
  }

  if (path === '/api/stats' && method === 'GET') {
    const today = todayFrom(url.searchParams.get('today'));
    const month = today.slice(0, 7);
    const r = await db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM contacts WHERE stage IN ('Connected','Interested','In build')) AS active,
        (SELECT COUNT(*) FROM contacts WHERE next_follow_up IS NOT NULL AND next_follow_up <= ? AND stage NOT IN ('Lost')) AS due,
        (SELECT COUNT(*) FROM tasks WHERE done = 0 AND due IS NOT NULL AND due <= ?) AS tasks_due,
        (SELECT COALESCE(SUM(value),0) FROM contacts WHERE stage IN ('Interested','In build')) AS open_value,
        (SELECT COUNT(*) FROM contacts WHERE stage IN ('Interested','In build')) AS open_count,
        (SELECT COALESCE(SUM(value),0) FROM contacts WHERE stage = 'Closed won + site live' AND substr(stage_since,1,7) = ?) AS won_value,
        (SELECT COUNT(*) FROM contacts WHERE stage = 'Closed won + site live' AND substr(stage_since,1,7) = ?) AS won_count,
        (SELECT COUNT(*) FROM activities WHERE kind = 'dial' AND substr(created_at,1,10) = ?) AS dials_today,
        (SELECT COUNT(*) FROM activities WHERE kind = 'dial' AND outcome IN ('connected','interested','not_interested','callback') AND substr(created_at,1,10) = ?) AS connects_today
    `).bind(today, today, month, month, today, today).first();
    const { results } = await db.prepare('SELECT stage, COUNT(*) AS n, COALESCE(SUM(value),0) AS total FROM contacts GROUP BY stage').all();
    return json({ ...r, stages: results });
  }

  if (path === '/api/pipeline' && method === 'GET') {
    const { results } = await db.prepare(`
      SELECT id, name, business, phone, email, website, instagram, stage, value, hot, touches, last_touch, next_step, next_follow_up,
        stage_since, deadline, lost_reason, unread, last_activity_at, created_at
      FROM contacts ORDER BY hot DESC, COALESCE(next_follow_up, '9999') ASC, updated_at DESC LIMIT 2000`).all();
    return json({ contacts: results });
  }

  if (path === '/api/assistant/extract' && method === 'POST') {
    // Lead assistant: read screenshots / pasted text and return the prospect's details for review.
    if (!env.AI && !env.ANTHROPIC_API_KEY) throw new HttpError(503, 'The assistant needs the Workers AI binding (or an ANTHROPIC_API_KEY secret) on the Worker.');
    const body = await readJson(request);
    const lead = await extractLead(env, body);
    return json({ lead, duplicates: await findDuplicates(db, lead) });
  }

  if (path === '/api/prospects' && method === 'POST') {
    // Paste a list of Instagram links or handles (one per line, optional "name" after a comma or tab).
    const { lines, stage } = await readJson(request);
    if (!Array.isArray(lines) || lines.length > 500) throw new HttpError(400, 'Send 1 to 500 lines');
    const st = STAGES.includes(stage) ? stage : FIRST;
    let added = 0, skipped = 0;
    const today = nowIso().slice(0, 10);
    for (const line of lines) {
      const [first, ...rest] = String(line).split(/[,\t]/);
      const handle = igHandle(first);
      if (!handle) { skipped++; continue; }
      const exists = await db.prepare('SELECT 1 FROM contacts WHERE lower(instagram) = ?').bind(handle).first();
      if (exists) { skipped++; continue; }
      await db.prepare('INSERT INTO contacts (name, instagram, stage, stage_since) VALUES (?, ?, ?, ?)')
        .bind(rest.join(' ').trim().slice(0, 200) || handle, handle, st, today).run();
      added++;
    }
    return json({ added, skipped });
  }

  if (path === '/api/tasks' && method === 'GET') {
    const today = todayFrom(url.searchParams.get('today'));
    const contactId = url.searchParams.get('contact');
    const base = `SELECT t.*, c.name AS contact_name, c.business AS contact_business FROM tasks t LEFT JOIN contacts c ON c.id = t.contact_id`;
    if (contactId) {
      const { results } = await db.prepare(`${base} WHERE t.contact_id = ? ORDER BY t.done, COALESCE(t.due,'9999'), t.id`).bind(Number(contactId)).all();
      return json({ tasks: results });
    }
    const [open, done] = await db.batch([
      db.prepare(`${base} WHERE t.done = 0 ORDER BY COALESCE(t.due,'9999'), t.id LIMIT 500`),
      db.prepare(`${base} WHERE t.done = 1 ORDER BY t.done_at DESC LIMIT 20`),
    ]);
    return json({ tasks: open.results, done: done.results, today });
  }

  if (path === '/api/tasks' && method === 'POST') {
    const body = await readJson(request);
    const title = String(body.title || '').trim().slice(0, 300);
    if (!title) throw new HttpError(400, 'Task needs a title');
    const due = isDate(body.due) ? body.due : null;
    const cid = body.contact_id ? Number(body.contact_id) : null;
    const task = await db.prepare('INSERT INTO tasks (contact_id, title, due) VALUES (?, ?, ?) RETURNING *').bind(cid, title, due).first();
    return json({ task }, 201);
  }

  if ((m = path.match(/^\/api\/tasks\/(\d+)$/))) {
    const id = Number(m[1]);
    if (method === 'PATCH') {
      const body = await readJson(request);
      const sets = [], args = [];
      if ('title' in body) { sets.push('title = ?'); args.push(String(body.title || '').trim().slice(0, 300) || 'Untitled'); }
      if ('due' in body) { sets.push('due = ?'); args.push(isDate(body.due) ? body.due : null); }
      if ('done' in body) { sets.push('done = ?', 'done_at = ?'); args.push(body.done ? 1 : 0, body.done ? nowIso() : null); }
      if (!sets.length) throw new HttpError(400, 'Nothing to update');
      const task = await db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ? RETURNING *`).bind(...args, id).first();
      if (!task) throw new HttpError(404, 'Not found');
      return json({ task });
    }
    if (method === 'DELETE') {
      await db.prepare('DELETE FROM tasks WHERE id = ?').bind(id).run();
      return json({ ok: true });
    }
  }

  if ((m = path.match(/^\/api\/contacts\/(\d+)\/notes$/)) && method === 'POST') {
    // Log a note, an email or a DM on the contact's activity timeline.
    const id = Number(m[1]);
    const body = await readJson(request);
    const kind = ['note', 'email', 'dm'].includes(body.kind) ? body.kind : 'note';
    const text = String(body.body || '').trim().slice(0, 4000);
    if (!text) throw new HttpError(400, 'Write something first');
    const ts = nowIso();
    await db.batch([
      db.prepare('INSERT INTO activities (contact_id, kind, body, created_at) VALUES (?, ?, ?, ?)').bind(id, kind, text, ts),
      db.prepare('UPDATE contacts SET last_activity_at = ?, updated_at = ? WHERE id = ?').bind(ts, ts, id),
    ]);
    return json({ ok: true });
  }

  if ((m = path.match(/^\/api\/contacts\/(\d+)\/disposition$/)) && method === 'POST') {
    // Dialer outcome: logs the dial on the timeline and moves the deal along.
    const id = Number(m[1]);
    const body = await readJson(request);
    const today = todayFrom(body.today);
    const outcome = body.outcome;
    if (!OUTCOMES[outcome]) throw new HttpError(400, 'Pick an outcome');
    const c = await db.prepare('SELECT * FROM contacts WHERE id = ?').bind(id).first();
    if (!c) throw new HttpError(404, 'Not found');
    const note = String(body.note || '').trim().slice(0, 4000);
    const ts = nowIso();
    await db.prepare("INSERT INTO activities (contact_id, kind, outcome, body, created_at) VALUES (?, 'dial', ?, ?, ?)").bind(id, outcome, note, ts).run();
    if (outcome === 'no_answer' || outcome === 'voicemail') {
      const r = await logTouchFor(db, c, today, '');
      return json({ contact: r });
    }
    if (outcome === 'connected' && EARLY.includes(c.stage)) await changeStage(db, id, 'Connected', today);
    if (outcome === 'interested' && c.stage !== 'Interested' && !['In build', WON].includes(c.stage)) await changeStage(db, id, 'Interested', today);
    const sets = ['last_activity_at = ?', 'updated_at = ?'];
    const args = [ts, ts];
    if (outcome === 'connected' || outcome === 'interested') { sets.push('next_follow_up = ?', "lost_reason = ''"); args.push(addDays(today, outcome === 'interested' ? 1 : 2)); }
    if (outcome === 'not_interested') { sets.push("stage = 'Lost'", "lost_reason = 'Not interested'", 'next_follow_up = NULL', 'stage_since = ?'); args.push(today); }
    if (outcome === 'callback') { sets.push('next_follow_up = ?'); args.push(isDate(body.callback) ? body.callback : addDays(today, 1)); }
    if (outcome === 'bad_number') { sets.push("notes = CASE WHEN notes = '' THEN ? ELSE notes || char(10) || ? END"); args.push(`${today}: wrong number ${c.phone || ''}`, `${today}: wrong number ${c.phone || ''}`); }
    const contact = await db.prepare(`UPDATE contacts SET ${sets.join(', ')} WHERE id = ? RETURNING *`).bind(...args, id).first();
    return json({ contact });
  }

  if ((m = path.match(/^\/api\/contacts\/(\d+)\/touch$/)) && method === 'POST') {
    // Log one outreach attempt (DM, email, call with no answer) and schedule the next one.
    const id = Number(m[1]);
    const body = await readJson(request);
    const c = await db.prepare('SELECT * FROM contacts WHERE id = ?').bind(id).first();
    if (!c) throw new HttpError(404, 'Not found');
    const contact = await logTouchFor(db, c, todayFrom(body.today), body.note);
    return json({ contact });
  }

  if ((m = path.match(/^\/api\/contacts\/(\d+)\/replied$/)) && method === 'POST') {
    // They answered: stop the touch cadence and move them into discussion.
    const id = Number(m[1]);
    const today = todayFrom((await readJson(request)).today);
    const c = await db.prepare('SELECT stage FROM contacts WHERE id = ?').bind(id).first();
    if (!c) throw new HttpError(404, 'Not found');
    const early = EARLY.includes(c.stage);
    if (early) await changeStage(db, id, 'Connected', today);
    const contact = await db.prepare(`UPDATE contacts SET touches = 0, lost_reason = '', next_follow_up = ?, last_activity_at = ?, updated_at = ? WHERE id = ? RETURNING *`)
      .bind(addDays(today, 1), nowIso(), nowIso(), id).first();
    return json({ contact });
  }

  if (path === '/api/contacts' && method === 'GET') {
    const where = [];
    const args = [];
    const stage = url.searchParams.get('stage');
    const q = url.searchParams.get('q');
    const view = url.searchParams.get('view');
    const today = url.searchParams.get('today') || nowIso().slice(0, 10);
    if (stage) { where.push('c.stage = ?'); args.push(stage); }
    if (q) {
      where.push('(c.name LIKE ? OR c.business LIKE ? OR c.phone LIKE ? OR c.notes LIKE ? OR c.instagram LIKE ? OR c.email LIKE ?)');
      const like = `%${q}%`;
      args.push(like, like, like, like, like, like);
    }
    if (view === 'due') { where.push('c.next_follow_up IS NOT NULL AND c.next_follow_up <= ?'); args.push(today); }
    if (view === 'unread') where.push('c.unread > 0');
    if (view === 'hot') where.push('c.hot = 1');
    const sql = `
      SELECT c.*,
        (SELECT body FROM messages WHERE contact_id = c.id ORDER BY id DESC LIMIT 1) AS last_body,
        (SELECT direction FROM messages WHERE contact_id = c.id ORDER BY id DESC LIMIT 1) AS last_direction
      FROM contacts c
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY ${view === 'due' ? 'c.next_follow_up ASC,' : ''} COALESCE(c.last_activity_at, c.created_at) DESC
      LIMIT 500`;
    const { results } = await db.prepare(sql).bind(...args).all();
    const counts = await db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM contacts WHERE next_follow_up IS NOT NULL AND next_follow_up <= ?) AS due,
        (SELECT COUNT(*) FROM contacts WHERE unread > 0) AS unread`).bind(today).first();
    return json({ contacts: results, counts });
  }

  if (path === '/api/contacts' && method === 'POST') {
    const body = await readJson(request);
    const contact = await createContact(db, body);
    return json({ contact }, 201);
  }

  if (path === '/api/import' && method === 'POST') {
    const { rows } = await readJson(request);
    if (!Array.isArray(rows) || rows.length > 2000) throw new HttpError(400, 'Send 1 to 2000 rows');
    let added = 0, skipped = 0;
    for (const row of rows) {
      try { await createContact(db, row); added++; } catch { skipped++; }
    }
    return json({ added, skipped });
  }

  if ((m = path.match(/^\/api\/contacts\/(\d+)$/))) {
    const id = Number(m[1]);
    if (method === 'GET') {
      const contact = await db.prepare('SELECT * FROM contacts WHERE id = ?').bind(id).first();
      if (!contact) throw new HttpError(404, 'Not found');
      return json({ contact });
    }
    if (method === 'PATCH') {
      const body = await readJson(request);
      const today = todayFrom(body.today);
      const before = await db.prepare('SELECT stage FROM contacts WHERE id = ?').bind(id).first();
      if (!before) throw new HttpError(404, 'Not found');
      if ('instagram' in body) body.instagram = igHandle(body.instagram) || String(body.instagram || '').trim();
      const fields = ['name', 'business', 'email', 'website', 'instagram', 'next_follow_up', 'deadline', 'last_touch', 'notes', 'next_step', 'lost_reason'];
      const sets = [];
      const args = [];
      for (const f of fields) {
        if (!(f in body)) continue;
        let v = body[f];
        if (['next_follow_up', 'deadline', 'last_touch'].includes(f)) {
          if (v === '' || v === null) v = null;
          else if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new HttpError(400, 'Date must be YYYY-MM-DD');
        } else v = String(v ?? '').slice(0, 5000);
        sets.push(`${f} = ?`);
        args.push(v);
      }
      if ('value' in body) {
        const v = body.value === '' || body.value === null ? null : Math.round(Number(String(body.value).replace(/[$,]/g, '')));
        if (v !== null && !Number.isFinite(v)) throw new HttpError(400, 'Value must be a number');
        sets.push('value = ?'); args.push(v);
      }
      if ('hot' in body) { sets.push('hot = ?'); args.push(body.hot ? 1 : 0); }
      if ('touches' in body) { sets.push('touches = ?'); args.push(Math.max(0, Math.min(20, Number(body.touches) || 0))); }
      if ('stage' in body && !STAGES.includes(body.stage)) throw new HttpError(400, 'Unknown stage');
      if ('opt_in_at' in body) {
        const v = body.opt_in_at;
        if (v === null || v === '') {
          sets.push('opt_in_at = NULL', "opt_in_channel = ''", "opt_in_note = ''");
        } else {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new HttpError(400, 'Opt-in date must be YYYY-MM-DD');
          if (!OPT_IN_CHANNELS.includes(body.opt_in_channel)) throw new HttpError(400, 'Pick where they agreed to get texts');
          sets.push('opt_in_at = ?', 'opt_in_channel = ?', 'opt_in_note = ?');
          args.push(v, body.opt_in_channel, String(body.opt_in_note || '').slice(0, 1000));
        }
      }
      if ('phone' in body) {
        const phone = String(body.phone || '').trim() ? normalizePhone(body.phone) : null;
        if (phone === null && String(body.phone || '').trim()) throw new HttpError(400, 'Phone number not recognized. Use +countrycode for non-US numbers.');
        sets.push('phone = ?');
        args.push(phone);
      }
      if (!sets.length && !('stage' in body)) throw new HttpError(400, 'Nothing to update');
      sets.push('updated_at = ?');
      args.push(nowIso(), id);
      try {
        await db.prepare(`UPDATE contacts SET ${sets.join(', ')} WHERE id = ?`).bind(...args).run();
      } catch (e) {
        if (String(e).includes('UNIQUE')) throw new HttpError(409, 'Another contact already has that number');
        throw e;
      }
      if ('stage' in body && body.stage !== before.stage) await changeStage(db, id, body.stage, today);
      const contact = await db.prepare('SELECT * FROM contacts WHERE id = ?').bind(id).first();
      return json({ contact });
    }
    if (method === 'DELETE') {
      await db.batch([
        db.prepare('DELETE FROM messages WHERE contact_id = ?').bind(id),
        db.prepare('DELETE FROM calls WHERE contact_id = ?').bind(id),
        db.prepare('DELETE FROM tasks WHERE contact_id = ?').bind(id),
        db.prepare('DELETE FROM activities WHERE contact_id = ?').bind(id),
        db.prepare('DELETE FROM contacts WHERE id = ?').bind(id),
      ]);
      return json({ ok: true });
    }
  }

  if ((m = path.match(/^\/api\/contacts\/(\d+)\/timeline$/)) && method === 'GET') {
    const id = Number(m[1]);
    const [msgs, calls, acts] = await db.batch([
      db.prepare('SELECT id, direction, body, status, error, created_at FROM messages WHERE contact_id = ? ORDER BY id DESC LIMIT 300').bind(id),
      db.prepare('SELECT id, direction, status, duration, recording_sid, recording_duration, created_at FROM calls WHERE contact_id = ? ORDER BY id DESC LIMIT 100').bind(id),
      db.prepare('SELECT id, kind, outcome, body, created_at FROM activities WHERE contact_id = ? ORDER BY id DESC LIMIT 200').bind(id),
    ]);
    const items = [
      ...msgs.results.reverse().map((x) => ({ type: 'message', ...x })),
      ...calls.results.reverse().map((x) => ({ type: 'call', ...x, recording_sid: undefined, has_recording: Boolean(x.recording_sid) })),
      ...acts.results.reverse().map((x) => ({ type: 'activity', ...x, outcome_label: OUTCOMES[x.outcome] || '' })),
    ].sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
    return json({ items });
  }

  if ((m = path.match(/^\/api\/contacts\/(\d+)\/read$/)) && method === 'POST') {
    await db.prepare('UPDATE contacts SET unread = 0 WHERE id = ?').bind(Number(m[1])).run();
    return json({ ok: true });
  }

  if ((m = path.match(/^\/api\/contacts\/(\d+)\/messages$/)) && method === 'POST') {
    requireEnv(env, 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_NUMBER');
    const id = Number(m[1]);
    const { body, addOptOut } = await readJson(request);
    const contact = await db.prepare('SELECT * FROM contacts WHERE id = ?').bind(id).first();
    if (!contact) throw new HttpError(404, 'Not found');
    if (contact.opted_out) throw new HttpError(409, 'This contact texted STOP. You cannot text them unless they text START.');
    if (!contact.phone) throw new HttpError(409, 'Add a phone number for this contact first.');
    if (!contact.opt_in_at) throw new HttpError(409, 'Log their OK to be texted first (where and when they agreed).');
    let text = String(body || '').trim();
    if (!text) throw new HttpError(400, 'Message is empty');
    const sentBefore = await db.prepare("SELECT 1 FROM messages WHERE contact_id = ? AND direction = 'out' AND status NOT IN ('failed','undelivered') LIMIT 1").bind(id).first();
    // The first text to anyone always carries the opt-out line; later ones only when asked.
    const line = optOutLine(env);
    if ((!sentBefore || addOptOut) && !/\bSTOP\b/i.test(text)) text = `${text}\n\n${line}`;
    if (text.length > 1600) throw new HttpError(400, 'Message is too long (1600 characters max)');

    const form = new URLSearchParams({
      To: contact.phone,
      From: env.TWILIO_NUMBER,
      Body: text,
      StatusCallback: `${url.origin}/twilio/sms-status`,
    });
    const ts = nowIso();
    let res;
    try {
      res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`, {
        method: 'POST',
        headers: { authorization: twilioAuthHeader(env), 'content-type': 'application/x-www-form-urlencoded' },
        body: form,
      });
    } catch (e) {
      await db.prepare("INSERT INTO messages (contact_id, direction, body, status, error, created_at) VALUES (?, 'out', ?, 'failed', ?, ?)")
        .bind(id, text, 'Could not reach Twilio', ts).run();
      throw new HttpError(502, 'Could not reach Twilio. Try again.');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (data.code === 21610) {
        await db.prepare('UPDATE contacts SET opted_out = 1 WHERE id = ?').bind(id).run();
        throw new HttpError(409, 'This number has opted out (texted STOP). Message not sent.');
      }
      await db.prepare("INSERT INTO messages (contact_id, direction, body, status, error, created_at) VALUES (?, 'out', ?, 'failed', ?, ?)")
        .bind(id, text, `${data.code || res.status}: ${data.message || 'Twilio error'}`, ts).run();
      throw new HttpError(502, `Twilio refused the message: ${data.message || res.status}`);
    }
    await db.batch([
      db.prepare("INSERT INTO messages (contact_id, direction, body, twilio_sid, status, created_at) VALUES (?, 'out', ?, ?, ?, ?)")
        .bind(id, text, data.sid, data.status || 'queued', ts),
      db.prepare("UPDATE contacts SET last_activity_at = ?, stage = CASE WHEN stage = 'Prospects' THEN 'Attempt to connect' ELSE stage END WHERE id = ?").bind(ts, id),
    ]);
    return json({ ok: true, sid: data.sid });
  }

  if (path === '/api/voice-token' && method === 'GET') {
    requireEnv(env, 'TWILIO_ACCOUNT_SID', 'TWILIO_API_KEY_SID', 'TWILIO_API_KEY_SECRET', 'TWILIO_TWIML_APP_SID');
    return json({ token: await voiceToken(env), identity: CLIENT_IDENTITY });
  }

  if ((m = path.match(/^\/api\/calls\/(\d+)\/recording$/)) && method === 'GET') {
    requireEnv(env, 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN');
    const call = await db.prepare('SELECT recording_sid FROM calls WHERE id = ?').bind(Number(m[1])).first();
    if (!call || !call.recording_sid) throw new HttpError(404, 'No recording');
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Recordings/${call.recording_sid}.mp3`, {
      headers: { authorization: twilioAuthHeader(env) },
    });
    if (!res.ok) throw new HttpError(502, 'Could not fetch the recording from Twilio');
    return new Response(res.body, { headers: { 'content-type': 'audio/mpeg', 'cache-control': 'private, max-age=3600' } });
  }

  throw new HttpError(404, 'Not found');
}

function recordingOn(env) {
  return String(env.RECORD_CALLS ?? 'true').toLowerCase() !== 'false';
}
function recordingNotice(env) {
  return xmlEscape(env.RECORDING_NOTICE || 'This call may be recorded.');
}
function dialRecordAttrs(env, origin) {
  return recordingOn(env)
    ? ` record="record-from-answer-dual" recordingStatusCallback="${origin}/twilio/recording" recordingStatusCallbackEvent="completed"`
    : '';
}

function optOutLine(env) {
  return env.OPT_OUT_LINE || 'Reply STOP to opt out.';
}

async function createContact(db, body) {
  const hasPhone = String(body.phone ?? '').trim() !== '';
  const phone = hasPhone ? normalizePhone(body.phone) : null;
  if (hasPhone && !phone) throw new HttpError(400, 'Phone number not recognized. Use +countrycode for non-US numbers.');
  const s = (v) => String(v ?? '').trim().slice(0, 5000);
  const instagram = igHandle(body.instagram) || s(body.instagram);
  if (!phone && !instagram && !s(body.email) && !s(body.name) && !s(body.business)) {
    throw new HttpError(400, 'Add at least a phone, Instagram, email or name');
  }
  const stage = STAGES.includes(body.stage) ? body.stage : FIRST;
  const followUp = isDate(body.next_follow_up) ? body.next_follow_up : null;
  const value = body.value === undefined || body.value === '' || body.value === null ? null : Math.round(Number(String(body.value).replace(/[$,]/g, ''))) || null;
  try {
    return await db.prepare(`INSERT INTO contacts (name, business, phone, email, website, instagram, stage, next_follow_up, notes, value, next_step, stage_since)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`)
      .bind(s(body.name), s(body.business), phone, s(body.email), s(body.website), instagram, stage, followUp, s(body.notes),
        value, s(body.next_step).slice(0, 300), nowIso().slice(0, 10))
      .first();
  } catch (e) {
    if (String(e).includes('UNIQUE')) throw new HttpError(409, 'A contact with that number already exists');
    throw e;
  }
}

async function logTouchFor(db, c, today, note) {
    const touches = (c.touches || 0) + 1;
    let stage = c.stage === FIRST ? ATC : c.stage;
    let follow, reason = c.lost_reason;
    // The no-reply cadence only applies before they've answered; later stages just log the touch.
    const cadence = EARLY.includes(c.stage);
    if (cadence && (c.stage === 'Lost' || c.stage === 'LTO')) stage = c.stage === 'LTO' ? 'LTO' : ATC;
    if (!cadence) follow = addDays(today, 2);
    else if (touches >= MAX_TOUCHES) {
      stage = 'Lost'; reason = 'No response'; follow = addDays(today, 90);
    } else follow = addDays(today, TOUCH_GAPS[touches - 1]);
    if (cadence && stage !== 'Lost') reason = '';
    const text = String(note || '').trim().slice(0, 300);
    const notes = text ? `${c.notes ? c.notes + '\n' : ''}${today} touch ${touches}: ${text}` : c.notes;
    return db.prepare(`UPDATE contacts SET touches = ?, last_touch = ?, stage = ?, lost_reason = ?, next_follow_up = ?,
      stage_since = CASE WHEN stage = ? THEN stage_since ELSE ? END, notes = ?, last_activity_at = ?, updated_at = ? WHERE id = ? RETURNING *`)
      .bind(touches, today, stage, reason, follow, stage, today, notes, nowIso(), nowIso(), c.id).first();
}

const LEAD_FIELDS = ['business', 'name', 'phone', 'email', 'website', 'instagram', 'trade', 'city', 'notes'];
const LEAD_SCHEMA = {
  type: 'object',
  properties: {
    business: { type: 'string', description: 'Business name' },
    name: { type: 'string', description: 'Owner or contact person, if shown' },
    phone: { type: 'string', description: 'Phone number exactly as shown, with country code if shown' },
    email: { type: 'string' },
    website: { type: 'string', description: 'Website domain or URL, not an Instagram link' },
    instagram: { type: 'string', description: 'Instagram handle without @' },
    trade: { type: 'string', description: 'What they do, e.g. Roofing, House painting' },
    city: { type: 'string', description: 'City and state or region' },
    notes: { type: 'string', description: 'One or two short lines useful for a website sales pitch: rating and review count, whether they have a website, services, anything notable' },
  },
  required: LEAD_FIELDS,
  additionalProperties: false,
};
const LEAD_SYSTEM = `You read screenshots and pasted text about local service businesses (Google Business profiles, Google Maps listings, Instagram profiles, Facebook pages, Yelp, websites) and pull out the details needed to add the business as a sales prospect.
Copy details exactly as they appear. Leave a field as an empty string when it isn't visible; never guess a phone number, email or handle.
If several businesses appear, describe the main one and mention the others in notes.`;
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

// Free by default: Cloudflare Workers AI (daily free allowance, no key). If an ANTHROPIC_API_KEY secret is set,
// Claude is used instead, and Workers AI becomes the backup if Claude fails.
const WORKERS_AI_MODEL = '@cf/meta/llama-4-scout-17b-16e-instruct';

async function extractLead(env, body) {
  const images = Array.isArray(body.images) ? body.images.slice(0, 4) : [];
  const text = String(body.text || '').trim().slice(0, 6000);
  if (!images.length && !text) throw new HttpError(400, 'Attach a screenshot or paste some details');
  for (const img of images) {
    if (!IMAGE_TYPES.includes(img.media_type) || typeof img.data !== 'string' || img.data.length > 6_000_000) {
      throw new HttpError(400, 'Images must be JPEG, PNG, WebP or GIF under 4 MB');
    }
  }
  const ask = text ? `Extra details from me:\n${text}` : 'Pull out this lead\'s details.';
  let data;
  if (env.ANTHROPIC_API_KEY) {
    try { data = await extractWithClaude(env, images, ask); }
    catch (e) { if (!env.AI) throw e; data = await extractWithWorkersAi(env, images, ask); }
  } else {
    data = await extractWithWorkersAi(env, images, ask);
  }
  const lead = {};
  for (const f of LEAD_FIELDS) lead[f] = String((data && data[f]) || '').trim().slice(0, f === 'notes' ? 1000 : 300);
  lead.instagram = igHandle(lead.instagram) || lead.instagram.replace(/^@/, '');
  lead.phone_normalized = normalizePhone(lead.phone);
  return lead;
}

function parseLeadJson(raw) {
  if (raw && typeof raw === 'object') return raw;
  const str = String(raw || '');
  try { return JSON.parse(str); } catch { /* fall through */ }
  const m = str.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch { /* fall through */ } }
  throw new HttpError(502, 'The assistant returned something unreadable. Try again.');
}

async function extractWithWorkersAi(env, images, ask) {
  const content = [{ type: 'text', text: `${ask}\nReply with JSON only, with these keys: ${LEAD_FIELDS.join(', ')}.` }];
  for (const img of images) content.push({ type: 'image_url', image_url: { url: `data:${img.media_type};base64,${img.data}` } });
  let out;
  try {
    out = await env.AI.run(WORKERS_AI_MODEL, {
      messages: [{ role: 'system', content: LEAD_SYSTEM }, { role: 'user', content }],
      response_format: { type: 'json_schema', json_schema: LEAD_SCHEMA },
      max_tokens: 1200,
      temperature: 0,
    });
  } catch (e) {
    const msg = String(e && e.message || e);
    if (/4006|daily free allocation|neurons/i.test(msg)) throw new HttpError(429, 'Today\'s free AI allowance is used up. It resets at 5:30 AM India time.');
    if (/429|3040|capacity/i.test(msg)) throw new HttpError(429, 'The assistant is busy. Try again in a minute.');
    throw new HttpError(502, `The assistant failed: ${msg.slice(0, 200)}`);
  }
  return parseLeadJson(out && out.response !== undefined ? out.response : out);
}

async function extractWithClaude(env, images, ask) {
  const content = images.map((img) => ({ type: 'image', source: { type: 'base64', media_type: img.media_type, data: img.data } }));
  content.push({ type: 'text', text: ask });
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  let response;
  try {
    response = await client.beta.messages.create({
      model: 'claude-opus-5-5',
      max_tokens: 4000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: LEAD_SYSTEM,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: LEAD_SCHEMA } },
      messages: [{ role: 'user', content }],
    });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new HttpError(502, 'The Anthropic API key was rejected. Check the ANTHROPIC_API_KEY secret.');
    if (e instanceof Anthropic.RateLimitError) throw new HttpError(429, 'The assistant is busy. Try again in a minute.');
    if (e instanceof Anthropic.APIError) throw new HttpError(502, `The assistant failed: ${e.message}`);
    throw e;
  }
  if (response.stop_reason === 'refusal') throw new HttpError(422, 'The assistant could not read that one. Try a different screenshot.');
  const out = response.content.find((b) => b.type === 'text');
  return parseLeadJson(out ? out.text : '');
}

async function findDuplicates(db, lead) {
  const where = [], args = [];
  if (lead.phone_normalized) { where.push('phone = ?'); args.push(lead.phone_normalized); }
  if (lead.instagram) { where.push('lower(instagram) = ?'); args.push(lead.instagram.toLowerCase()); }
  if (lead.email) { where.push('lower(email) = ?'); args.push(lead.email.toLowerCase()); }
  if (lead.business && lead.business.length >= 4) { where.push('lower(business) = ?'); args.push(lead.business.toLowerCase()); }
  if (!where.length) return [];
  const { results } = await db.prepare(`SELECT id, business, name, phone, instagram, stage FROM contacts WHERE ${where.join(' OR ')} LIMIT 5`).bind(...args).all();
  return results;
}

// Move a deal to a new stage: stamp the date, add that stage's tasks, set a delivery deadline when a build starts.
async function changeStage(db, id, stage, today) {
  const stmts = [db.prepare(`UPDATE contacts SET stage = ?, stage_since = ?,
    deadline = CASE WHEN ? = 'In build' AND deadline IS NULL THEN ? ELSE deadline END,
    next_follow_up = CASE WHEN ? = 'Closed won + site live' THEN NULL ELSE next_follow_up END,
    touches = CASE WHEN ? IN ('Connected','Interested','In build','Closed won + site live') THEN 0 ELSE touches END,
    updated_at = ? WHERE id = ?`).bind(stage, today, stage, addDays(today, 7), stage, stage, nowIso(), id)];
  for (const [title, days] of STAGE_TASKS[stage] || []) {
    stmts.push(db.prepare(`INSERT INTO tasks (contact_id, title, due, auto)
      SELECT ?, ?, ?, 1 WHERE NOT EXISTS (SELECT 1 FROM tasks WHERE contact_id = ? AND title = ? AND done = 0)`)
      .bind(id, title, addDays(today, days), id, title));
  }
  await db.batch(stmts);
}

// Twilio Access Token (JWT) for the Voice JS SDK, signed with an API key secret.
async function voiceToken(env) {
  const now = Math.floor(Date.now() / 1000);
  const header = { typ: 'JWT', alg: 'HS256', cty: 'twilio-fpa;v=1' };
  const payload = {
    jti: `${env.TWILIO_API_KEY_SID}-${now}`,
    iss: env.TWILIO_API_KEY_SID,
    sub: env.TWILIO_ACCOUNT_SID,
    iat: now,
    nbf: now,
    exp: now + 3600,
    grants: {
      identity: CLIENT_IDENTITY,
      voice: {
        incoming: { allow: true },
        outgoing: { application_sid: env.TWILIO_TWIML_APP_SID },
      },
    },
  };
  const unsigned = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = b64url(await hmac('SHA-256', env.TWILIO_API_KEY_SECRET, unsigned));
  return `${unsigned}.${sig}`;
}

// ---------- public opt-in form (on the Sharkflow Labs website) ----------

function allowedOrigin(request, env) {
  const origin = request.headers.get('origin') || '';
  const list = String(env.OPTIN_ORIGINS || 'https://sharkflowlabs.pages.dev').split(',').map((x) => x.trim()).filter(Boolean);
  return list.includes(origin) ? origin : null;
}

async function handlePublicLead(request, env, url) {
  const origin = allowedOrigin(request, env);
  const cors = origin ? { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'content-type', vary: 'origin' } : {};
  if (request.method === 'OPTIONS') return new Response(null, { status: origin ? 204 : 403, headers: cors });
  if (request.method !== 'POST' || !origin) return json({ error: 'Not allowed' }, 403, cors);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Bad request' }, 400, cors); }
  if (body.company_website_hp) return json({ ok: true }, 200, cors); // honeypot: bots fill hidden fields
  // The older text-only form sends `consent`; the quote form sends agree_terms + optional consent_contact.
  const legacy = url.pathname === '/public/optin';
  const agreed = legacy ? body.consent === true : body.agree_terms === true;
  const contactConsent = legacy ? body.consent === true : body.consent_contact === true;
  if (!agreed) return json({ error: legacy ? 'Please tick the box to agree to texts' : 'Please agree to the Privacy Policy and Terms' }, 400, cors);
  const phone = normalizePhone(body.phone);
  if (!phone) return json({ error: 'Please enter a valid phone number (add +44 for UK numbers)' }, 400, cors);
  const s = (v, n) => String(v ?? '').trim().slice(0, n);
  const lead = {
    name: s(body.name, 120), business: s(body.business, 160), email: s(body.email, 200),
    website: s(body.website, 300), trade: s(body.trade, 80), message: s(body.message, 2000),
  };
  if (lead.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lead.email)) return json({ error: 'Please check your email address' }, 400, cors);
  const ts = nowIso();
  const day = ts.slice(0, 10);
  const consentNote = contactConsent ? `${legacy ? 'Text form' : 'Website quote form'}: "${s(body.consent_text, 600)}"` : '';
  const noteLine = [`${day} website form`, lead.trade && `Trade: ${lead.trade}`, lead.message && `Message: ${lead.message}`].filter(Boolean).join(' | ');
  const db = env.DB;
  await db.prepare(`INSERT INTO contacts (phone, name, business, email, website, stage, opt_in_at, opt_in_channel, opt_in_note, unread, last_activity_at, notes)
      VALUES (?, ?, ?, ?, ?, 'Prospects', ?, ?, ?, 1, ?, ?)
    ON CONFLICT(phone) DO UPDATE SET
      name = CASE WHEN contacts.name = '' THEN excluded.name ELSE contacts.name END,
      business = CASE WHEN contacts.business = '' THEN excluded.business ELSE contacts.business END,
      email = CASE WHEN contacts.email = '' THEN excluded.email ELSE contacts.email END,
      website = CASE WHEN contacts.website = '' THEN excluded.website ELSE contacts.website END,
      opt_in_at = COALESCE(excluded.opt_in_at, contacts.opt_in_at),
      opt_in_channel = CASE WHEN excluded.opt_in_at IS NOT NULL THEN excluded.opt_in_channel ELSE contacts.opt_in_channel END,
      opt_in_note = CASE WHEN excluded.opt_in_at IS NOT NULL THEN excluded.opt_in_note ELSE contacts.opt_in_note END,
      notes = CASE WHEN contacts.notes = '' THEN excluded.notes ELSE contacts.notes || char(10) || excluded.notes END,
      unread = contacts.unread + 1, last_activity_at = excluded.last_activity_at`)
    .bind(phone, lead.name, lead.business, lead.email, lead.website,
      contactConsent ? day : null, contactConsent ? 'Website form' : '', consentNote, ts, noteLine).run();
  await emailLead(env, { ...lead, phone, contactConsent, ts }).catch((e) => console.error('lead email failed', e));
  return json({ ok: true }, 200, cors);
}

// Emails each website lead to you through Cloudflare Email Routing (send_email binding LEAD_MAIL).
async function emailLead(env, lead) {
  if (!env.LEAD_MAIL || !env.LEAD_EMAIL_TO || !env.LEAD_EMAIL_FROM) return;
  const { EmailMessage } = await import('cloudflare:email');
  const clean = (v) => String(v || '').replace(/[\r\n]+/g, ' ');
  const lines = [
    `New website lead (${lead.ts})`, '',
    `Name: ${lead.name}`, `Business: ${lead.business}`, `Trade: ${lead.trade}`,
    `Phone: ${lead.phone}`, `Email: ${lead.email}`, `Website: ${lead.website}`, '',
    `Message:`, lead.message || '(none)', '',
    `Agreed to Privacy Policy and Terms: yes`,
    `OK to text and call: ${lead.contactConsent ? 'YES (logged as opt-in in Sharkflow Phone)' : 'no, do not text'}`,
  ];
  const subject = `New lead: ${clean(lead.business || lead.name || lead.phone)}`;
  const raw = [
    `From: Sharkflow Labs website <${env.LEAD_EMAIL_FROM}>`,
    `To: <${env.LEAD_EMAIL_TO}>`,
    ...(lead.email ? [`Reply-To: <${clean(lead.email)}>`] : []),
    `Subject: ${subject}`,
    `Message-ID: <${crypto.randomUUID()}@${env.LEAD_EMAIL_FROM.split('@')[1]}>`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    lines.join('\r\n'),
  ].join('\r\n');
  await env.LEAD_MAIL.send(new EmailMessage(env.LEAD_EMAIL_FROM, env.LEAD_EMAIL_TO, raw));
}

// ---------- Twilio webhooks ----------

// https://www.twilio.com/docs/usage/webhooks/webhooks-security
export async function twilioSignature(authToken, fullUrl, params) {
  const data = fullUrl + Object.keys(params).sort().map((k) => k + params[k]).join('');
  return b64(await hmac('SHA-1', authToken, data));
}

async function handleTwilio(request, env, url) {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  requireEnv(env, 'TWILIO_AUTH_TOKEN');
  const form = await request.formData();
  const p = {};
  for (const [k, v] of form.entries()) p[k] = String(v);
  const expected = await twilioSignature(env.TWILIO_AUTH_TOKEN, request.url, p);
  if (!safeEqual(request.headers.get('x-twilio-signature') || '', expected)) {
    return new Response('Bad signature', { status: 403 });
  }

  const db = env.DB;
  const ts = nowIso();
  const origin = url.origin;

  switch (url.pathname) {
    // Incoming text to the Twilio number.
    case '/twilio/sms': {
      const from = normalizePhone(p.From);
      if (!from) return twiml('');
      const contact = await findOrCreateContact(db, from);
      const word = (p.Body || '').trim().toUpperCase();
      const optType = (p.OptOutType || '').toUpperCase();
      const stmts = [
        db.prepare("INSERT INTO messages (contact_id, direction, body, twilio_sid, status, created_at) VALUES (?, 'in', ?, ?, 'received', ?)")
          .bind(contact.id, p.Body || (Number(p.NumMedia) > 0 ? '[picture or file]' : ''), p.MessageSid || null, ts),
        db.prepare('UPDATE contacts SET unread = unread + 1, last_activity_at = ? WHERE id = ?').bind(ts, contact.id),
      ];
      if (!contact.opt_in_at && !(optType === 'STOP' || STOP_WORDS.includes(word))) {
        // They texted first, so replying to them is expected. Record it so the history is clear.
        stmts.push(db.prepare("UPDATE contacts SET opt_in_at = ?, opt_in_channel = 'Texted us first', opt_in_note = ? WHERE id = ? AND opt_in_at IS NULL")
          .bind(ts.slice(0, 10), `First text: ${(p.Body || '').slice(0, 200)}`, contact.id));
      }
      if (optType === 'STOP' || STOP_WORDS.includes(word)) {
        stmts.push(db.prepare('UPDATE contacts SET opted_out = 1 WHERE id = ?').bind(contact.id));
      } else if (optType === 'START' || START_WORDS.includes(word)) {
        stmts.push(db.prepare('UPDATE contacts SET opted_out = 0 WHERE id = ?').bind(contact.id));
      }
      await db.batch(stmts);
      // Twilio's built-in opt-out handling sends the STOP/START/HELP confirmations, so reply with nothing.
      return twiml('');
    }

    case '/twilio/sms-status': {
      if (p.MessageSid) {
        await db.prepare('UPDATE messages SET status = ?, error = COALESCE(?, error) WHERE twilio_sid = ?')
          .bind(p.MessageStatus || p.SmsStatus || null, p.ErrorCode ? `Error ${p.ErrorCode}` : null, p.MessageSid).run();
        if (p.ErrorCode === '21610') {
          await db.prepare('UPDATE contacts SET opted_out = 1 WHERE id = (SELECT contact_id FROM messages WHERE twilio_sid = ?)').bind(p.MessageSid).run();
        }
      }
      return new Response('', { status: 204 });
    }

    // Someone calls the Twilio number: ring the browser (and your cell, if set), then voicemail.
    case '/twilio/voice-in': {
      const from = normalizePhone(p.From);
      let contactId = null;
      if (from) contactId = (await findOrCreateContact(db, from)).id;
      await db.batch([
        db.prepare("INSERT OR IGNORE INTO calls (contact_id, direction, twilio_sid, status, created_at) VALUES (?, 'in', ?, 'ringing', ?)")
          .bind(contactId, p.CallSid, ts),
        ...(contactId ? [db.prepare('UPDATE contacts SET last_activity_at = ? WHERE id = ?').bind(ts, contactId)] : []),
      ]);
      const forward = normalizePhone(env.FORWARD_TO);
      const callerId = forward ? xmlEscape(p.From || env.TWILIO_NUMBER) : '';
      return twiml(
        (recordingOn(env) ? `<Say voice="Polly.Joanna">${recordingNotice(env)}</Say>` : '') +
        `<Dial timeout="20" answerOnBridge="true" action="${origin}/twilio/voice-after"${callerId ? ` callerId="${callerId}"` : ''}${dialRecordAttrs(env, origin)}>` +
        `<Client>${CLIENT_IDENTITY}</Client>` +
        (forward ? `<Number>${forward}</Number>` : '') +
        `</Dial>`,
      );
    }

    // After the inbound ring attempt. Not answered means voicemail.
    case '/twilio/voice-after': {
      const status = p.DialCallStatus;
      await db.prepare('UPDATE calls SET status = ?, duration = ? WHERE twilio_sid = ?')
        .bind(status === 'completed' ? 'answered' : 'missed', Number(p.DialCallDuration || 0), p.CallSid).run();
      if (status === 'completed') return twiml('<Hangup/>');
      const greeting = xmlEscape(env.VOICEMAIL_GREETING || 'Sorry we missed your call. Please leave your name, number and a short message after the tone.');
      return twiml(
        `<Say voice="Polly.Joanna">${greeting}</Say>` +
        `<Record maxLength="120" playBeep="true" timeout="5" action="${origin}/twilio/voicemail-done" ` +
        `recordingStatusCallback="${origin}/twilio/voicemail" recordingStatusCallbackEvent="completed"/>`,
      );
    }

    case '/twilio/voicemail-done':
      return twiml('<Say voice="Polly.Joanna">Thanks. Goodbye.</Say><Hangup/>');

    case '/twilio/voicemail': {
      if (p.RecordingSid && Number(p.RecordingDuration || 0) > 0) {
        await db.prepare("UPDATE calls SET status = 'voicemail', recording_sid = ?, recording_duration = ? WHERE twilio_sid = ?")
          .bind(p.RecordingSid, Number(p.RecordingDuration), p.CallSid).run();
        await db.prepare('UPDATE contacts SET unread = unread + 1 WHERE id = (SELECT contact_id FROM calls WHERE twilio_sid = ?)').bind(p.CallSid).run();
      }
      return new Response('', { status: 204 });
    }

    // TwiML App Voice URL: the browser places a call.
    case '/twilio/voice-out': {
      if (p.Caller !== `client:${CLIENT_IDENTITY}`) return twiml('<Reject/>');
      const to = normalizePhone(p.To);
      if (!to) return twiml('<Say>That number is not valid.</Say><Hangup/>');
      const contact = await findOrCreateContact(db, to);
      await db.batch([
        db.prepare("INSERT OR IGNORE INTO calls (contact_id, direction, twilio_sid, status, created_at) VALUES (?, 'out', ?, 'calling', ?)")
          .bind(contact.id, p.CallSid, ts),
        db.prepare("UPDATE contacts SET last_activity_at = ?, stage = CASE WHEN stage = 'Prospects' THEN 'Attempt to connect' ELSE stage END WHERE id = ?").bind(ts, contact.id),
      ]);
      return twiml(
        `<Dial callerId="${xmlEscape(env.TWILIO_NUMBER)}" answerOnBridge="true" timeout="30" action="${origin}/twilio/dial-done"${dialRecordAttrs(env, origin)}>` +
        `<Number${recordingOn(env) ? ` url="${origin}/twilio/whisper"` : ''}>${to}</Number></Dial>`,
      );
    }

    // Played to the person you called, as soon as they pick up.
    case '/twilio/whisper':
      return twiml(`<Say voice="Polly.Joanna">${recordingNotice(env)}</Say>`);

    // A call recording (in or out) is ready.
    case '/twilio/recording': {
      if (p.RecordingSid && Number(p.RecordingDuration || 0) > 0) {
        await db.prepare("UPDATE calls SET recording_sid = ?, recording_duration = ? WHERE twilio_sid = ? AND status != 'voicemail'")
          .bind(p.RecordingSid, Number(p.RecordingDuration), p.CallSid).run();
      }
      return new Response('', { status: 204 });
    }

    case '/twilio/dial-done': {
      const map = { completed: 'answered', busy: 'busy', 'no-answer': 'no answer', failed: 'failed', canceled: 'canceled' };
      await db.prepare('UPDATE calls SET status = ?, duration = ? WHERE twilio_sid = ?')
        .bind(map[p.DialCallStatus] || p.DialCallStatus || 'ended', Number(p.DialCallDuration || 0), p.CallSid).run();
      return twiml('<Hangup/>');
    }

    default:
      return new Response('Not found', { status: 404 });
  }
}

async function findOrCreateContact(db, phone) {
  const existing = await db.prepare('SELECT * FROM contacts WHERE phone = ?').bind(phone).first();
  if (existing) return existing;
  return db.prepare("INSERT INTO contacts (phone, stage) VALUES (?, 'Prospects') ON CONFLICT(phone) DO UPDATE SET phone = excluded.phone RETURNING *")
    .bind(phone).first();
}
