// Sharkflow Phone: a one-person texting + calling inbox on Twilio and Cloudflare.
// One Worker serves the UI (from /public), a JSON API under /api, and Twilio webhooks under /twilio.

const STAGES = [
  'Leads', 'Contacted', 'In discussion', 'Mockup sent',
  'Pricing & invoicing', 'In build', 'Closed won + site live', 'Lost',
];
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
    });
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
      where.push('(c.name LIKE ? OR c.business LIKE ? OR c.phone LIKE ? OR c.notes LIKE ?)');
      const like = `%${q}%`;
      args.push(like, like, like, like);
    }
    if (view === 'due') { where.push('c.next_follow_up IS NOT NULL AND c.next_follow_up <= ?'); args.push(today); }
    if (view === 'unread') where.push('c.unread > 0');
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
      const fields = ['name', 'business', 'email', 'website', 'instagram', 'stage', 'next_follow_up', 'notes'];
      const sets = [];
      const args = [];
      for (const f of fields) {
        if (!(f in body)) continue;
        let v = body[f];
        if (f === 'stage' && !STAGES.includes(v)) throw new HttpError(400, 'Unknown stage');
        if (f === 'next_follow_up') {
          if (v === '' || v === null) v = null;
          else if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new HttpError(400, 'Date must be YYYY-MM-DD');
        } else v = String(v ?? '').slice(0, 5000);
        sets.push(`${f} = ?`);
        args.push(v);
      }
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
        const phone = normalizePhone(body.phone);
        if (!phone) throw new HttpError(400, 'Phone number not recognized. Use +countrycode for non-US numbers.');
        sets.push('phone = ?');
        args.push(phone);
      }
      if (!sets.length) throw new HttpError(400, 'Nothing to update');
      sets.push('updated_at = ?');
      args.push(nowIso(), id);
      try {
        await db.prepare(`UPDATE contacts SET ${sets.join(', ')} WHERE id = ?`).bind(...args).run();
      } catch (e) {
        if (String(e).includes('UNIQUE')) throw new HttpError(409, 'Another contact already has that number');
        throw e;
      }
      const contact = await db.prepare('SELECT * FROM contacts WHERE id = ?').bind(id).first();
      return json({ contact });
    }
    if (method === 'DELETE') {
      await db.batch([
        db.prepare('DELETE FROM messages WHERE contact_id = ?').bind(id),
        db.prepare('DELETE FROM calls WHERE contact_id = ?').bind(id),
        db.prepare('DELETE FROM contacts WHERE id = ?').bind(id),
      ]);
      return json({ ok: true });
    }
  }

  if ((m = path.match(/^\/api\/contacts\/(\d+)\/timeline$/)) && method === 'GET') {
    const id = Number(m[1]);
    const [msgs, calls] = await db.batch([
      db.prepare('SELECT id, direction, body, status, error, created_at FROM messages WHERE contact_id = ? ORDER BY id DESC LIMIT 300').bind(id),
      db.prepare('SELECT id, direction, status, duration, recording_sid, recording_duration, created_at FROM calls WHERE contact_id = ? ORDER BY id DESC LIMIT 100').bind(id),
    ]);
    const items = [
      ...msgs.results.reverse().map((x) => ({ type: 'message', ...x })),
      ...calls.results.reverse().map((x) => ({ type: 'call', ...x, recording_sid: undefined, has_voicemail: Boolean(x.recording_sid) })),
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
      db.prepare("UPDATE contacts SET last_activity_at = ?, stage = CASE WHEN stage = 'Leads' THEN 'Contacted' ELSE stage END WHERE id = ?").bind(ts, id),
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
    if (!call || !call.recording_sid) throw new HttpError(404, 'No voicemail');
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Recordings/${call.recording_sid}.mp3`, {
      headers: { authorization: twilioAuthHeader(env) },
    });
    if (!res.ok) throw new HttpError(502, 'Could not fetch the recording from Twilio');
    return new Response(res.body, { headers: { 'content-type': 'audio/mpeg', 'cache-control': 'private, max-age=3600' } });
  }

  throw new HttpError(404, 'Not found');
}

function optOutLine(env) {
  return env.OPT_OUT_LINE || 'Reply STOP to opt out.';
}

async function createContact(db, body) {
  const phone = normalizePhone(body.phone);
  if (!phone) throw new HttpError(400, 'Phone number not recognized. Use +countrycode for non-US numbers.');
  const stage = STAGES.includes(body.stage) ? body.stage : 'Leads';
  const followUp = /^\d{4}-\d{2}-\d{2}$/.test(body.next_follow_up || '') ? body.next_follow_up : null;
  const s = (v) => String(v ?? '').trim().slice(0, 5000);
  try {
    return await db.prepare(`INSERT INTO contacts (name, business, phone, email, website, instagram, stage, next_follow_up, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`)
      .bind(s(body.name), s(body.business), phone, s(body.email), s(body.website), s(body.instagram), stage, followUp, s(body.notes))
      .first();
  } catch (e) {
    if (String(e).includes('UNIQUE')) throw new HttpError(409, 'A contact with that number already exists');
    throw e;
  }
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
        `<Dial timeout="20" answerOnBridge="true" action="${origin}/twilio/voice-after"${callerId ? ` callerId="${callerId}"` : ''}>` +
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
        db.prepare("UPDATE contacts SET last_activity_at = ?, stage = CASE WHEN stage = 'Leads' THEN 'Contacted' ELSE stage END WHERE id = ?").bind(ts, contact.id),
      ]);
      return twiml(
        `<Dial callerId="${xmlEscape(env.TWILIO_NUMBER)}" answerOnBridge="true" timeout="30" action="${origin}/twilio/dial-done">` +
        `<Number>${to}</Number></Dial>`,
      );
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
  return db.prepare("INSERT INTO contacts (phone, stage) VALUES (?, 'Leads') ON CONFLICT(phone) DO UPDATE SET phone = excluded.phone RETURNING *")
    .bind(phone).first();
}
