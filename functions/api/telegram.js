// Cloudflare Pages Function. Secrets belong in Cloudflare, never in this file.
// Required: DB (D1), TELEGRAM_BOT_TOKEN, TELEGRAM_SETUP_KEY (32+ characters).
const BASE = 'https://josevascencelos.pages.dev';
const ENDPOINT = BASE + '/api/telegram';
const BOT = 'JoseTakip2026_bot';
const UPDATES = ['message', 'my_chat_member', 'chat_member', 'chat_join_request'];
const enc = new TextEncoder();
const now = () => Math.floor(Date.now() / 1000);
const isAdmin = m => ['creator', 'administrator'].includes(m?.status);
const isMember = m => ['creator', 'administrator', 'member'].includes(m?.status) || (m?.status === 'restricted' && m.is_member === true);
const headers = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY'
};
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' } });

async function equal(a, b) {
  const hashes = await Promise.all([a, b].map(s => crypto.subtle.digest('SHA-256', enc.encode(String(s || '')))));
  const x = new Uint8Array(hashes[0]), y = new Uint8Array(hashes[1]);
  let difference = 0;
  for (let i = 0; i < x.length; i++) difference |= x[i] ^ y[i];
  return difference === 0;
}

async function sign(env, text) {
  const key = await crypto.subtle.importKey('raw', enc.encode(env.TELEGRAM_SETUP_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(text)));
  return Array.from(bytes, x => x.toString(16).padStart(2, '0')).join('');
}

async function api(env, method, args = {}) {
  let r;
  try {
    r = await fetch('https://api.telegram.org/bot' + env.TELEGRAM_BOT_TOKEN + '/' + method, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args), signal: AbortSignal.timeout(12000)
    });
  } catch { throw new Error('Telegram bağlantısı kurulamadı. Tekrar deneyin.'); }
  let result;
  try { result = await r.json(); } catch { throw new Error('Telegram yanıtı okunamadı.'); }
  if (!r.ok || !result.ok) {
    if (r.status === 401 || result.error_code === 401) throw new Error('Bot tokenı geçersiz. Cloudflare sırrını kontrol edip yeniden dağıtın.');
    throw new Error('Telegram ' + method + ' işlemini kabul etmedi (' + (result.error_code || r.status) + '). Botun kanal yetkilerini kontrol edin.');
  }
  return result.result;
}

async function init(env) {
  await env.DB.batch([
    env.DB.prepare('CREATE TABLE IF NOT EXISTS jose_bot_config (id INTEGER PRIMARY KEY CHECK(id=1), owner_id TEXT NOT NULL, channel_id TEXT NOT NULL, title TEXT NOT NULL, started_at INTEGER NOT NULL)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS jose_bot_events (update_id INTEGER PRIMARY KEY, happened_at INTEGER NOT NULL, kind TEXT NOT NULL, subject TEXT NOT NULL, link_key TEXT NOT NULL, link_name TEXT NOT NULL)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS jose_bot_events_time ON jose_bot_events(happened_at)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS jose_bot_commands (update_id INTEGER PRIMARY KEY, handled_at INTEGER NOT NULL)')
  ]);
}
const config = env => env.DB.prepare('SELECT * FROM jose_bot_config WHERE id=1').first();

async function report(env, cfg) {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const start = Math.floor(Date.parse(day + 'T00:00:00+03:00') / 1000);
  const rows = (await env.DB.prepare('SELECT kind, COUNT(*) AS total, SUM(CASE WHEN happened_at >= ? THEN 1 ELSE 0 END) AS today FROM jose_bot_events GROUP BY kind').bind(start).all()).results;
  const counts = Object.fromEntries(rows.map(r => [r.kind, r]));
  const count = (kind, column) => Number(counts[kind]?.[column] || 0);
  let members = 'alınamadı';
  try { members = String(await api(env, 'getChatMemberCount', { chat_id: cfg.channel_id })); } catch {}
  const since = new Date(cfg.started_at * 1000).toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' });
  const links = (await env.DB.prepare("SELECT link_key, link_name, COUNT(*) AS n FROM jose_bot_events WHERE kind='join' AND happened_at >= ? GROUP BY link_key, link_name ORDER BY n DESC LIMIT 8").bind(start).all()).results;
  const detail = links.map(l => '• ' + (l.link_name || (l.link_key ? 'Davet ' + l.link_key.slice(0, 6) : 'Bağlantı bilgisi yok')) + ': ' + l.n).join('\n');
  return cfg.title + '\n\nBUGÜN (Türkiye saati)\nKatılma isteği: ' + count('request', 'today') + '\nGerçek katılım: ' + count('join', 'today') + '\nAyrılma: ' + count('leave', 'today') + '\n\nKAYIT BAŞLANGICINDAN BERİ\nKatılma isteği: ' + count('request', 'total') + '\nGerçek katılım: ' + count('join', 'total') + '\nAyrılma: ' + count('leave', 'total') + '\nŞu an toplam üye: ' + members + '\n\nBaşlangıç: ' + since + '\n' + (detail ? '\nBugünkü katılımların davet bağlantıları:\n' + detail + '\n' : '') + '\nİstekler katılım sayılmaz. Ayrılıp yeniden katılan kişi yeni bir katılım hareketidir. Eski hareketler ve reklam atfı bu rapora dahil değildir.';
}

async function receive(env, update) {
  const cfg = await config(env);
  if (!cfg) throw new Error('Kurulum tamamlanmadı.');
  if (!Number.isSafeInteger(update.update_id)) return;
  const member = update.chat_member;
  const request = update.chat_join_request;
  let kind, event, person;
  if (member && String(member.chat?.id) === cfg.channel_id) {
    if (!isMember(member.old_chat_member) && isMember(member.new_chat_member)) kind = 'join';
    if (isMember(member.old_chat_member) && !isMember(member.new_chat_member)) kind = 'leave';
    event = member; person = member.new_chat_member?.user;
  } else if (request && String(request.chat?.id) === cfg.channel_id) {
    kind = 'request'; event = request; person = request.from;
  }
  if (kind && person && !person.is_bot && Number.isSafeInteger(event.date) && event.date >= cfg.started_at) {
    const invite = event.invite_link;
    const linkKey = invite?.invite_link ? await sign(env, 'link:' + invite.invite_link) : '';
    const subject = await sign(env, 'user:' + person.id);
    await env.DB.prepare('INSERT OR IGNORE INTO jose_bot_events (update_id,happened_at,kind,subject,link_key,link_name) VALUES (?,?,?,?,?,?)')
      .bind(update.update_id, event.date, kind, subject, linkKey, String(invite?.name || '').slice(0, 100)).run();
  }
  const message = update.message;
  if (!message || message.chat?.type !== 'private' || String(message.from?.id) !== cfg.owner_id || String(message.chat.id) !== cfg.owner_id || message.date < cfg.started_at) return;
  const command = String(message.text || '').split(/[\s@]/)[0];
  if (!['/start', '/rapor', '/help'].includes(command)) return;
  const handled = await env.DB.prepare('SELECT update_id FROM jose_bot_commands WHERE update_id=?').bind(update.update_id).first();
  if (handled) return;
  const text = command === '/rapor' ? await report(env, cfg) : 'José takip botu bağlı. Katılım raporunu görmek için /rapor yaz. Kayıtlar kurulumdan itibaren tutulur; katılma istekleri otomatik onaylanmaz.';
  await api(env, 'sendMessage', { chat_id: cfg.owner_id, text });
  await env.DB.prepare('INSERT OR IGNORE INTO jose_bot_commands(update_id,handled_at) VALUES (?,?)').bind(update.update_id, now()).run();
  await env.DB.prepare('DELETE FROM jose_bot_commands WHERE handled_at < ?').bind(now() - 7 * 86400).run();
}

async function admin(env, action, body) {
  await init(env);
  const me = await api(env, 'getMe');
  if (String(me.username).toLowerCase() !== BOT.toLowerCase()) throw new Error('Token @' + BOT + ' botuna ait değil.');
  const hook = await api(env, 'getWebhookInfo');
  if (hook.url && hook.url !== ENDPOINT) throw new Error('Bot başka bir sisteme bağlı. Mevcut bağlantıyı değiştirmeden önce kontrol edin.');
  const cfg = await config(env);
  if (action === 'status') {
    return { configured: !!cfg, bot: me.username, channel: cfg?.title || '', channel_id: cfg?.channel_id || '', owner_id: cfg?.owner_id || '', webhook: hook.url, pending: hook.pending_update_count, last_error: hook.last_error_message || '', last_error_date: hook.last_error_date || null, started_at: cfg?.started_at || null };
  }
  if (action === 'discover') {
    if (hook.url) throw new Error('Webhook zaten kurulu. Durumu kontrol et düğmesini kullanın.');
    const updates = await api(env, 'getUpdates', { timeout: 0, limit: 100, allowed_updates: UPDATES });
    const channels = new Map(), owners = new Map();
    for (const u of updates) {
      const ch = u.my_chat_member?.chat;
      if (ch?.type === 'channel') channels.set(String(ch.id), { id: String(ch.id), name: ch.title });
      const m = u.message;
      if (m?.chat?.type === 'private' && m.from && !m.from.is_bot) {
        owners.set(String(m.from.id), { id: String(m.from.id), name: [m.from.first_name, m.from.last_name, m.from.username ? '@' + m.from.username : ''].filter(Boolean).join(' ') });
        const f = m.forward_origin;
        if (f?.type === 'channel') channels.set(String(f.chat.id), { id: String(f.chat.id), name: f.chat.title });
      }
    }
    return { channels: [...channels.values()], owners: [...owners.values()] };
  }
  if (action !== 'configure') throw new Error('Geçersiz işlem.');
  const owner = String(body.owner || ''), channel = String(body.channel || '');
  if (!/^[1-9]\d{0,15}$/.test(owner) || !/^-100\d{1,15}$/.test(channel)) throw new Error('Kanalı ve kendi Telegram hesabınızı seçin.');
  if (cfg && (cfg.owner_id !== owner || cfg.channel_id !== channel)) throw new Error('Bu veritabanı başka bir kanal veya hesap için yapılandırılmış.');
  const chat = await api(env, 'getChat', { chat_id: channel });
  const botMember = await api(env, 'getChatMember', { chat_id: channel, user_id: me.id });
  const ownerMember = await api(env, 'getChatMember', { chat_id: channel, user_id: Number(owner) });
  if (chat.type !== 'channel' || !isAdmin(botMember) || !botMember.can_invite_users) throw new Error('Botu kanala yönetici ekleyip Kullanıcı Davet Et yetkisini açın.');
  if (!isAdmin(ownerMember)) throw new Error('Seçilen Telegram hesabı kanalın yöneticisi değil.');
  await env.DB.prepare('INSERT INTO jose_bot_config(id,owner_id,channel_id,title,started_at) VALUES (1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title').bind(owner, channel, chat.title, now()).run();
  await api(env, 'setWebhook', { url: ENDPOINT, secret_token: await sign(env, 'webhook'), allowed_updates: UPDATES, max_connections: 1, drop_pending_updates: false });
  return { ok: true, message: 'Bağlantı kuruldu. Telegram botuna /rapor gönderin.' };
}

export async function onRequest({ request, env }) {
  if (request.method === 'GET') {
    const nonce = crypto.randomUUID().replaceAll('-', '');
    return new Response(page(nonce), { headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; script-src 'nonce-" + nonce + "'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" } });
  }
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!env.DB || !env.TELEGRAM_BOT_TOKEN || String(env.TELEGRAM_SETUP_KEY || '').length < 32) return json({ error: 'DB bağlaması, TELEGRAM_BOT_TOKEN veya en az 32 karakterlik TELEGRAM_SETUP_KEY eksik. Cloudflare ayarlarından sonra yeniden dağıtım yapın.' }, 503);
  const url = new URL(request.url);
  const action = url.searchParams.get('action');
  if (action) {
    if (url.origin !== BASE || request.headers.get('Origin') !== BASE || !await equal(request.headers.get('X-Setup-Key'), env.TELEGRAM_SETUP_KEY)) return json({ error: 'Kurulum şifresi veya site adresi yanlış.' }, 403);
  } else if (!await equal(request.headers.get('X-Telegram-Bot-Api-Secret-Token'), await sign(env, 'webhook'))) return json({ error: 'Forbidden' }, 403);
  let body;
  try {
    const text = await request.text();
    if (text.length > 262144) return json({ error: 'İstek çok büyük.' }, 413);
    body = JSON.parse(text);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'Geçersiz veri.' }, 400);
  } catch { return json({ error: 'Geçersiz JSON.' }, 400); }
  try {
    if (action) return json(await admin(env, action, body));
    await receive(env, body);
    return json({ ok: true });
  } catch (error) {
    return json({ error: action && error.message?.startsWith('Telegram') ? error.message : action && !/D1|SQL|fetch|token=/i.test(error.message || '') ? error.message : 'İşlem tamamlanamadı. Ayarları kontrol edip tekrar deneyin.' }, 500);
  }
}

function page(nonce) {
  return `<!doctype html><html lang="tr"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>José Bot Kurulumu</title>
<style>body{font:17px system-ui;background:#f3f5f8;color:#152238;max-width:650px;margin:40px auto;padding:20px}main{background:white;padding:28px;border-radius:16px}h1{font-size:25px}p{line-height:1.6}label{display:block;margin:18px 0 6px}input,select,button{font:inherit;padding:13px;border:1px solid #bbc6d6;border-radius:8px;box-sizing:border-box;width:100%}button{margin-top:14px;background:#1764c0;color:white;cursor:pointer}button:disabled{opacity:.5;cursor:wait}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#eef3f9;padding:16px;border-radius:8px;font:15px system-ui}small{line-height:1.6;display:block;color:#526077}</style>
<main><h1>José Telegram Takibi</h1><p>Katılma isteklerini, gerçek katılımları ve ayrılmaları kaydet. Raporları kendi Telegram hesabından <b>/rapor</b> komutuyla gör.</p><small>Sayım kurulumdan itibaren başlar. İstekler otomatik onaylanmaz. Meta reklamlarıyla eşleştirme bu aşamaya dahil değildir.</small>
<label for="key">Kurulum şifresi</label><input id="key" type="password" autocomplete="off" placeholder="Cloudflare’a kaydettiğin TELEGRAM_SETUP_KEY">
<p>Önce @JoseTakip2026_bot sohbetinde <b>Başlat</b>’a bas. Takip edeceğin kanaldan bir gönderiyi bota <b>İlet</b>; gönderen kanal bilgisini gizleme. Ardından aşağıdaki düğmeye bas.</p>
<button id="discover">Kanalı ve hesabımı bul</button>
<div id="choices" hidden><label for="channel">Takip edilecek kanal</label><select id="channel"></select><label for="owner">Raporları görecek kendi hesabın</label><select id="owner"></select><button id="configure">Seçilen kanala takibi bağla</button></div>
<button id="status">Durumu kontrol et</button><pre id="result" role="status">Kurulum bekleniyor.</pre></main>
<script nonce="${nonce}">
const $=id=>document.getElementById(id);
async function call(action,body={}) {
 document.querySelectorAll('button').forEach(b=>b.disabled=true); $('result').textContent='Kontrol ediliyor…';
 try {const r=await fetch('/api/telegram?action='+action,{method:'POST',headers:{'Content-Type':'application/json','X-Setup-Key':$('key').value},body:JSON.stringify(body)}); const d=await r.json(); if(!r.ok)throw new Error(d.error||'İşlem tamamlanamadı.'); return d;}
 catch(e){$('result').textContent=e.message;return null;}
 finally{document.querySelectorAll('button').forEach(b=>b.disabled=false);}
}
function fill(id,items){const s=$(id);s.replaceChildren();const p=document.createElement('option');p.value='';p.textContent='Seçiniz';s.append(p);for(const item of items){const o=document.createElement('option');o.value=item.id;o.textContent=item.name+' ('+item.id+')';s.append(o);}if(items.length===1)s.value=items[0].id;}
$('discover').onclick=async()=>{const d=await call('discover');if(!d)return;fill('channel',d.channels);fill('owner',d.owners);$('choices').hidden=false;$('result').textContent=d.channels.length&&d.owners.length?'Kanalı ve hesabını doğrula; ardından takibi bağla.':'Kanal veya hesap bulunamadı. Bot sohbetinde Başlat’a basıp kanaldan bir gönderiyi ilet, sonra tekrar dene.';};
$('configure').onclick=async()=>{if(!$('channel').value||!$('owner').value){$('result').textContent='Kanalı ve hesabını seç.';return;}const d=await call('configure',{channel:$('channel').value,owner:$('owner').value});if(d)$('result').textContent=d.message;};
$('status').onclick=async()=>{const d=await call('status');if(!d)return;if(d.configured){fill('channel',[{id:d.channel_id,name:d.channel}]);fill('owner',[{id:d.owner_id,name:'Kayıtlı rapor hesabı'}]);$('choices').hidden=false;$('configure').textContent='Aynı kanalın bağlantısını yenile';}$('result').textContent='Bot: @'+d.bot+'\\nKanal: '+(d.channel||'Seçilmedi')+'\\nWebhook: '+(d.webhook||'Bağlanmadı')+'\\nBekleyen olay: '+d.pending+(d.last_error?'\\nTelegram’ın son hata kaydı: '+d.last_error+'\\nHata zamanı: '+new Date(d.last_error_date*1000).toLocaleString('tr-TR'):'')+'\\nBağlantı görünmesi tek başına sayımı doğrulamaz. Yeni bir katılımı /rapor ile kontrol edin.';};
</script></html>`;
}
