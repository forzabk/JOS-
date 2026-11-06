// Per-visit, consented Telegram invites and verified-membership Meta CAPI outbox.
// No credentials in this file. Existing Cloudflare secrets and DB are reused.
export const BASE = 'https://josevascencelos.pages.dev';
const PIXEL = '2312048342907436';
const DAY = 86400;
const timestamp = () => Math.floor(Date.now() / 1000);
const response = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }
});

export async function digest(env, value) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.TELEGRAM_SETUP_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), x => x.toString(16).padStart(2, '0')).join('');
}

export async function initMeta(env) {
  await env.DB.batch([
    env.DB.prepare('CREATE TABLE IF NOT EXISTS jose_meta_settings (id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL DEFAULT 0)'),
    env.DB.prepare('INSERT OR IGNORE INTO jose_meta_settings(id,enabled) VALUES(1,0)'),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS jose_meta_visits (
      id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL, consent_at INTEGER NOT NULL, ip_key TEXT NOT NULL,
      user_data TEXT NOT NULL, invite_url TEXT, link_key TEXT UNIQUE, subject TEXT,
      requested_at INTEGER, creating_until INTEGER NOT NULL DEFAULT 0)`),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS jose_meta_visit_age ON jose_meta_visits(created_at)'),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS jose_meta_outbox (
      registration_key TEXT PRIMARY KEY, event_id TEXT UNIQUE NOT NULL, event_time INTEGER NOT NULL,
      payload TEXT NOT NULL, test_code TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0, next_try INTEGER NOT NULL DEFAULT 0,
      lease_until INTEGER NOT NULL DEFAULT 0, lease_token TEXT NOT NULL DEFAULT '', sent_at INTEGER, error TEXT NOT NULL DEFAULT '')`),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS jose_meta_pending ON jose_meta_outbox(state,next_try)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS jose_meta_limits (key TEXT PRIMARY KEY, n INTEGER NOT NULL, expires_at INTEGER NOT NULL)')
  ]);
  // Cleanup is activity-driven; expired attribution data is never used.
  await env.DB.batch([
    env.DB.prepare('DELETE FROM jose_meta_visits WHERE created_at < ?').bind(timestamp() - 7 * DAY),
    env.DB.prepare('DELETE FROM jose_meta_limits WHERE expires_at < ?').bind(timestamp()),
    env.DB.prepare("UPDATE jose_meta_outbox SET state='expired',payload='{}',test_code='',error='Gönderim süresi doldu' WHERE state IN ('pending','sending') AND event_time < ?").bind(timestamp() - 7 * DAY + 60)
  ]);
}

export async function metaSummary(env) {
  const setting = await env.DB.prepare('SELECT enabled FROM jose_meta_settings WHERE id=1').first();
  const rows = (await env.DB.prepare('SELECT state,COUNT(*) AS n FROM jose_meta_outbox GROUP BY state').all()).results;
  const counts = Object.fromEntries(rows.map(row => [row.state, Number(row.n)]));
  const last = await env.DB.prepare("SELECT error FROM jose_meta_outbox WHERE error<>'' ORDER BY event_time DESC LIMIT 1").first();
  return { enabled: !!setting?.enabled, pixel: PIXEL, token_present: !!env.META_CAPI_TOKEN,
    test_mode: !!env.META_TEST_EVENT_CODE, sent: counts.sent || 0, test_sent: counts.test_sent || 0,
    pending: (counts.pending || 0) + (counts.sending || 0), expired: counts.expired || 0, error: last?.error || '' };
}

async function limit(env, key, maximum, expires) {
  const row = await env.DB.prepare(`INSERT INTO jose_meta_limits(key,n,expires_at) VALUES(?,1,?)
    ON CONFLICT(key) DO UPDATE SET n=n+1 RETURNING n`).bind(key, expires).first();
  return row.n <= maximum;
}

function browserData(request, body) {
  const cookies = Object.fromEntries((request.headers.get('Cookie') || '').split(';').map(s => {
    const i = s.indexOf('='); return i < 0 ? ['', ''] : [s.slice(0, i).trim(), s.slice(i + 1)];
  }));
  const data = {};
  // These belong to the website visitor, never the Telegram webhook sender.
  const ip = request.headers.get('CF-Connecting-IP');
  if (ip) data.client_ip_address = ip;
  const agent = request.headers.get('User-Agent');
  if (agent) data.client_user_agent = agent.slice(0, 1024);
  if (/^fb\.\d+\.\d{13}\.[0-9]{1,30}$/.test(cookies._fbp || '')) data.fbp = cookies._fbp;
  const click = typeof body.fbclid === 'string' ? body.fbclid : '';
  if (/^[A-Za-z0-9_-]{1,500}$/.test(click)) data.fbc = 'fb.1.' + Date.now() + '.' + click;
  else if (/^fb\.\d+\.\d{13}\.[A-Za-z0-9_-]{1,500}$/.test(cookies._fbc || '')) data.fbc = cookies._fbc;
  return data;
}

export async function onRequestPost({ request, env }) {
  if (new URL(request.url).origin !== BASE || request.headers.get('Origin') !== BASE)
    return response({ error: 'Forbidden' }, 403);
  if (!env.DB || !env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_SETUP_KEY || !env.META_CAPI_TOKEN)
    return response({ error: 'Tracking unavailable' }, 503);
  let body;
  try {
    const raw = await request.text();
    if (raw.length > 4096) return response({ error: 'Too large' }, 413);
    body = JSON.parse(raw);
  } catch { return response({ error: 'Invalid JSON' }, 400); }
  if (body?.consent !== true || !/^[a-f0-9]{32}$/.test(body?.visit || ''))
    return response({ error: 'Consent and visit required' }, 400);
  try {
    await initMeta(env);
    const setting = await env.DB.prepare('SELECT enabled FROM jose_meta_settings WHERE id=1').first();
    if (!setting?.enabled) return response({ error: 'Tracking inactive' }, 503);
    const cfg = await env.DB.prepare('SELECT * FROM jose_bot_config WHERE id=1').first();
    if (!cfg) return response({ error: 'Bot not configured' }, 503);
    const t = timestamp();
    const ip = request.headers.get('CF-Connecting-IP');
    if (!ip) return response({ error: 'Network unavailable' }, 503);
    const ipKey = await digest(env, 'visit-ip:' + ip);
    let visit = await env.DB.prepare('SELECT * FROM jose_meta_visits WHERE id=?').bind(body.visit).first();
    if (visit && (visit.ip_key !== ipKey || visit.expires_at <= t)) return response({ error: 'Visit expired' }, 409);
    if (visit?.invite_url) return response({ url: visit.invite_url });
    // Atomic rate counters also bound anonymous database/invite creation.
    if (!await limit(env, 'ip:' + ipKey + ':' + Math.floor(t / 3600), 30, t + 3600) ||
        !await limit(env, 'global:' + Math.floor(t / DAY), 5000, t + DAY))
      return response({ error: 'Please try later' }, 429);
    await env.DB.prepare(`INSERT OR IGNORE INTO jose_meta_visits
      (id,channel_id,created_at,expires_at,consent_at,ip_key,user_data) VALUES(?,?,?,?,?,?,?)`)
      .bind(body.visit, cfg.channel_id, t, t + DAY, t, ipKey, JSON.stringify(browserData(request, body))).run();
    const claimed = await env.DB.prepare(`UPDATE jose_meta_visits SET creating_until=?
      WHERE id=? AND ip_key=? AND invite_url IS NULL AND creating_until<? RETURNING id`)
      .bind(t + 30, body.visit, ipKey, t).first();
    if (!claimed) return response({ error: 'Please retry' }, 409);
    try {
      const r = await fetch('https://api.telegram.org/bot' + env.TELEGRAM_BOT_TOKEN + '/createChatInviteLink', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(10000),
        body: JSON.stringify({ chat_id: cfg.channel_id, name: 'Web ' + body.visit.slice(0, 20), creates_join_request: true, expire_date: t + DAY })
      });
      const d = await r.json();
      if (!r.ok || !d.ok || !/^https:\/\/t\.me\/[+A-Za-z0-9_-]+$/.test(d.result?.invite_link || '')) throw new Error('Invite unavailable');
      const url = d.result.invite_link;
      await env.DB.prepare('UPDATE jose_meta_visits SET invite_url=?,link_key=?,creating_until=0 WHERE id=?')
        .bind(url, await digest(env, 'link:' + url), body.visit).run();
      return response({ url });
    } catch {
      await env.DB.prepare('UPDATE jose_meta_visits SET creating_until=0 WHERE id=?').bind(body.visit).run();
      return response({ error: 'Invite unavailable' }, 502);
    }
  } catch { return response({ error: 'Tracking unavailable' }, 503); }
}

export async function recordRegistration(
  env, cfg, updateId, event, kind, subject, linkKey
) {
  if (kind !== 'request' || !linkKey) return;

  const enabled = await env.DB.prepare(
    'SELECT enabled FROM jose_meta_settings WHERE id=1'
  ).first();
  if (!enabled?.enabled) return;

  const visit = await env.DB.prepare(
    'SELECT * FROM jose_meta_visits WHERE link_key=? AND channel_id=?'
  ).bind(linkKey, cfg.channel_id).first();

  if (
    !visit ||
    event.date < visit.created_at ||
    event.date > visit.expires_at ||
    (visit.subject && visit.subject !== subject)
  ) return;

  // Daha önce katılmış kişiyi yeni kayıt olarak sayma.
  const previousJoin = await env.DB.prepare(
    "SELECT update_id FROM jose_bot_events WHERE subject=? AND kind='join' LIMIT 1"
  ).bind(subject).first();
  if (previousJoin) return;

  const claimed = await env.DB.prepare(`
    UPDATE jose_meta_visits
    SET subject=?, requested_at=COALESCE(requested_at,?)
    WHERE id=? AND (subject IS NULL OR subject=?)
    RETURNING id
  `).bind(subject, event.date, visit.id, subject).first();
  if (!claimed) return;

  // Eski sürümle aynı anahtar: daha önce sayılanları tekrar saymaz.
  const key = await digest(
    env, 'registration:' + cfg.channel_id + ':' + subject
  );
  const eventId = 'tg_registration_' + key;

  const payload = {
    event_name: 'CompleteRegistration',
    event_time: event.date,
    event_id: eventId,
    action_source: 'chat',
    user_data: JSON.parse(visit.user_data),
    custom_data: { status: true }
  };

  await env.DB.prepare(`
    INSERT OR IGNORE INTO jose_meta_outbox
    (registration_key,event_id,event_time,payload,test_code)
    VALUES(?,?,?,?,?)
  `).bind(
    key,
    eventId,
    event.date,
    JSON.stringify(payload),
    String(env.META_TEST_EVENT_CODE || '')
  ).run();
}

export async function flushMeta(env, maximum = 3, force = false) {
  if (!env.META_CAPI_TOKEN) return;
  const t = timestamp();
  const rows = (await env.DB.prepare(`SELECT * FROM jose_meta_outbox WHERE event_time>=? AND
    ((state='pending' AND (next_try<=? OR ?=1)) OR (state='sending' AND lease_until<?))
    ORDER BY event_time LIMIT ?`).bind(t - 7 * DAY + 60, t, force ? 1 : 0, t, maximum).all()).results;
  for (const row of rows) {
    const lease = crypto.randomUUID();
    const claimed = await env.DB.prepare(`UPDATE jose_meta_outbox SET state='sending',lease_until=?,attempts=attempts+1,lease_token=?
      WHERE registration_key=? AND (state='pending' OR (state='sending' AND lease_until<?)) RETURNING event_id`)
      .bind(t + 60, lease, row.registration_key, t).first();
    if (!claimed) continue;
    let error = '';
    try {
      const body = { data: [JSON.parse(row.payload)] };
      if (row.test_code) body.test_event_code = row.test_code;
      const r = await fetch('https://graph.facebook.com/v23.0/' + PIXEL + '/events', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env.META_CAPI_TOKEN },
        signal: AbortSignal.timeout(10000), body: JSON.stringify(body)
      });
      const d = await r.json();
      if (!r.ok || d.events_received !== 1) {
        error = 'Meta HTTP ' + r.status + (Number.isInteger(d.error?.code) ? ' / kod ' + d.error.code : ' / olay kabul edilmedi');
      }
    } catch { error = 'Meta bağlantı hatası; yeniden denenecek.'; }
    if (error) {
      const delay = Math.min(3600, 30 * 2 ** Math.min(row.attempts, 7));
      await env.DB.prepare("UPDATE jose_meta_outbox SET state='pending',next_try=?,lease_until=0,lease_token='',error=? WHERE registration_key=? AND lease_token=?")
        .bind(timestamp() + delay, error, row.registration_key, lease).run();
    } else {
      await env.DB.prepare("UPDATE jose_meta_outbox SET state=?,sent_at=?,payload='{}',test_code='',lease_until=0,lease_token='',error='' WHERE registration_key=? AND lease_token=?")
        .bind(row.test_code ? 'test_sent' : 'sent', timestamp(), row.registration_key, lease).run();
    }
  }
}
