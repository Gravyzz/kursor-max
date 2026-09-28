// Имитация MAX Bot API (platform-api2.max.ru) для локальной проверки без токена и без сети.
// Реализует методы, которые использует бот Курсора: /me, /me/commands, /subscriptions, /updates, /messages, /answers.
// Не является частью продакшн-развёртывания: в compose.prod.yaml отключена (профиль `mock`).
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

const PORT = Number(process.env.PORT ?? 9090);
const MINIAPP_URL = process.env.MOCK_MINIAPP_URL ?? 'http://localhost:8080/';
const BOT = { user_id: 900001, name: 'Курсор', first_name: 'Курсор', username: 'kursor_demo_bot', is_bot: true, last_activity_time: Date.now() };

// delivered — последний выданный маркер: как и настоящий Bot API, не отдаём повторно уже полученные обновления
const state = { updates: [], marker: 0, delivered: 0, waiters: [], messages: [], answers: [], subscriptions: [], seq: 0 };
const users = new Map();

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify(body));
};

const readBody = (req) =>
  new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
  });

function userObject(userId) {
  const known = users.get(userId) ?? { first_name: 'Студент', last_name: 'Тестовый' };
  return { user_id: userId, name: known.first_name, first_name: known.first_name, last_name: known.last_name, username: null, is_bot: false, last_activity_time: Date.now() };
}

async function pushUpdate(update) {
  state.marker += 1;
  const item = { ...update, timestamp: Date.now(), __marker: state.marker };
  if (state.subscriptions.length > 0) {
    for (const sub of state.subscriptions) {
      const headers = { 'content-type': 'application/json' };
      if (sub.secret) headers['x-max-bot-api-secret'] = sub.secret;
      const { __marker, ...payload } = item;
      fetch(sub.url, { method: 'POST', headers, body: JSON.stringify(payload) }).catch((error) => console.error('webhook delivery failed', error.message));
    }
    return;
  }
  state.updates.push(item);
  const waiters = state.waiters.splice(0);
  waiters.forEach((wake) => wake());
}

function takeUpdates(marker) {
  const list = state.updates.filter((u) => u.__marker > marker);
  if (list.length > 0) {
    state.delivered = Math.max(state.delivered, state.marker);
    // Выданные обновления больше не нужны: после перезапуска бот не получит их второй раз
    state.updates = state.updates.filter((u) => u.__marker > state.delivered);
  }
  return { updates: list.map(({ __marker, ...rest }) => rest), marker: state.marker };
}

const chatIdFor = (userId) => 700000 + Number(userId);

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' });
    return res.end();
  }

  // ----- панель управления имитацией -----
  if (path === '/__mock' || path === '/__mock/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(PAGE.replace('__MINIAPP_URL__', MINIAPP_URL));
  }
  if (path === '/__mock/start' && req.method === 'POST') {
    const body = await readBody(req);
    const userId = Number(body.user_id ?? 100500);
    users.set(userId, { first_name: body.first_name ?? 'Анна', last_name: body.last_name ?? 'Демидова' });
    state.messages.push({ direction: 'in', user_id: userId, text: `/start ${body.payload ?? ''}`.trim(), timestamp: Date.now(), mid: randomUUID() });
    await pushUpdate({ update_type: 'bot_started', chat_id: chatIdFor(userId), user: userObject(userId), payload: body.payload ?? null, user_locale: 'ru' });
    return json(res, 200, { ok: true });
  }
  if (path === '/__mock/text' && req.method === 'POST') {
    const body = await readBody(req);
    const userId = Number(body.user_id ?? 100500);
    const mid = randomUUID();
    state.messages.push({ direction: 'in', user_id: userId, text: body.text, timestamp: Date.now(), mid });
    await pushUpdate({
      update_type: 'message_created',
      message: {
        sender: userObject(userId),
        recipient: { chat_id: chatIdFor(userId), chat_type: 'dialog', user_id: BOT.user_id },
        timestamp: Date.now(),
        body: { mid, seq: ++state.seq, text: body.text, attachments: [] },
      },
      user_locale: 'ru',
    });
    return json(res, 200, { ok: true });
  }
  if (path === '/__mock/callback' && req.method === 'POST') {
    const body = await readBody(req);
    const userId = Number(body.user_id ?? 100500);
    const callback_id = randomUUID();
    const original = state.messages.find((m) => m.mid === body.mid);
    await pushUpdate({
      update_type: 'message_callback',
      callback: { timestamp: Date.now(), callback_id, payload: body.payload, user: userObject(userId) },
      message: original ? { sender: BOT, recipient: { chat_id: chatIdFor(userId), chat_type: 'dialog', user_id: userId }, timestamp: original.timestamp, body: { mid: original.mid, seq: 1, text: original.text, attachments: original.attachments } } : null,
      user_locale: 'ru',
    });
    return json(res, 200, { ok: true, callback_id });
  }
  if (path === '/__mock/messages' && req.method === 'GET') {
    const userId = url.searchParams.get('user_id');
    const list = userId ? state.messages.filter((m) => String(m.user_id) === userId) : state.messages;
    return json(res, 200, { messages: list, answers: state.answers.slice(-20) });
  }
  if (path === '/__mock/reset' && req.method === 'POST') {
    state.updates = [];
    state.messages = [];
    state.answers = [];
    return json(res, 200, { ok: true });
  }

  // ----- Bot API -----
  if (!req.headers.authorization) return json(res, 401, { code: 'verify.token', message: 'Invalid access_token' });

  if (path === '/me' && req.method === 'GET') return json(res, 200, BOT);
  if (path === '/me/commands' && req.method === 'PATCH') return json(res, 200, { ...BOT, commands: (await readBody(req)).commands ?? [] });
  if (path === '/subscriptions') {
    if (req.method === 'GET') return json(res, 200, { subscriptions: state.subscriptions });
    if (req.method === 'POST') {
      const body = await readBody(req);
      state.subscriptions = state.subscriptions.filter((s) => s.url !== body.url).concat({ url: body.url, secret: body.secret, update_types: body.update_types, time: Date.now() });
      return json(res, 200, { success: true });
    }
    if (req.method === 'DELETE') {
      const target = url.searchParams.get('url');
      state.subscriptions = state.subscriptions.filter((s) => s.url !== target);
      return json(res, 200, { success: true });
    }
  }
  if (path === '/updates' && req.method === 'GET') {
    // Без marker (первый запрос после запуска бота) — только ещё не выданные обновления
    const requested = Number(url.searchParams.get('marker'));
    const marker = url.searchParams.has('marker') && Number.isFinite(requested) ? requested : state.delivered;
    const timeout = Math.min(Number(url.searchParams.get('timeout') ?? 25), 25);
    const ready = takeUpdates(marker);
    if (ready.updates.length > 0) return json(res, 200, ready);
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      json(res, 200, takeUpdates(marker));
    };
    state.waiters.push(finish);
    setTimeout(finish, timeout * 1000);
    req.on('close', () => (done = true));
    return;
  }
  if (path === '/messages' && req.method === 'POST') {
    const body = await readBody(req);
    const userId = url.searchParams.get('user_id');
    const chatId = url.searchParams.get('chat_id');
    const targetUser = userId ? Number(userId) : Number(chatId) - 700000;
    const mid = `mid.${randomUUID()}`;
    const message = {
      direction: 'out',
      user_id: targetUser,
      mid,
      text: body.text ?? '',
      format: body.format ?? null,
      attachments: body.attachments ?? [],
      timestamp: Date.now(),
    };
    state.messages.push(message);
    return json(res, 200, {
      message: {
        sender: BOT,
        recipient: { chat_id: chatIdFor(targetUser), chat_type: 'dialog', user_id: targetUser },
        timestamp: message.timestamp,
        body: { mid, seq: ++state.seq, text: message.text, attachments: message.attachments },
      },
    });
  }
  if (path === '/messages' && (req.method === 'PUT' || req.method === 'DELETE')) return json(res, 200, { success: true });
  if (path === '/answers' && req.method === 'POST') {
    const body = await readBody(req);
    state.answers.push({ callback_id: url.searchParams.get('callback_id'), ...body, timestamp: Date.now() });
    return json(res, 200, { success: true });
  }
  return json(res, 404, { code: 'not.found', message: `Mock: ${req.method} ${path} не поддерживается` });
});

server.listen(PORT, () => console.log(JSON.stringify({ level: 'info', scope: 'max-mock', message: `MAX Bot API mock on :${PORT}`, panel: `/__mock/` })));

const PAGE = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Имитация чата MAX — Курсор</title>
<style>
:root{--bg:#EDEEF2;--card:#fff;--text:#060708;--muted:rgba(6,7,8,.56);--accent:#007AFF;--line:rgba(12,13,14,.12)}
@media (prefers-color-scheme:dark){:root{--bg:#0F1012;--card:#1C1D21;--text:#F1F2F5;--muted:rgba(241,242,245,.6);--accent:#3D96FF;--line:rgba(255,255,255,.12)}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.45 -apple-system,system-ui,"Segoe UI",Roboto,sans-serif}
header{position:sticky;top:0;background:var(--card);border-bottom:1px solid var(--line);padding:12px 16px;display:flex;gap:8px;flex-wrap:wrap;align-items:center}
header b{margin-right:auto}input,button{font:inherit}input{border:1px solid var(--line);border-radius:10px;padding:8px 10px;background:var(--bg);color:var(--text)}
button{border:0;border-radius:10px;padding:8px 12px;background:var(--accent);color:#fff;cursor:pointer}button.ghost{background:transparent;color:var(--accent);border:1px solid var(--line)}
main{max-width:640px;margin:0 auto;padding:16px;display:grid;gap:10px}
.msg{max-width:85%;background:var(--card);border-radius:14px 14px 14px 4px;padding:10px 12px;white-space:pre-wrap;border:1px solid var(--line)}
.msg.in{margin-left:auto;border-radius:14px 14px 4px 14px;background:var(--accent);color:#fff;border:0}
.kb{display:grid;gap:6px;margin-top:8px}.row{display:flex;gap:6px;flex-wrap:wrap}.row button{flex:1;background:var(--bg);color:var(--accent);border:1px solid var(--line)}
.note{color:var(--muted);font-size:13px}footer{max-width:640px;margin:0 auto;padding:0 16px 24px;display:flex;gap:8px}footer input{flex:1}
</style></head><body>
<header><b>Курсор — чат с ботом (имитация MAX)</b>
<label class="note">user_id <input id="uid" value="100500" size="7"></label>
<button id="demo">Старт: демо</button><button class="ghost" id="start">/start</button><button class="ghost" id="reset">Очистить</button></header>
<main id="chat"><p class="note">Это локальная имитация клиента MAX для проверки без токена. Кнопки мини-приложения открывают его в новой вкладке с тестовым входом.</p></main>
<footer><input id="text" placeholder="Сообщение или код H-XXXX-XXXX"><button id="send">Отправить</button></footer>
<script>
const MINIAPP='__MINIAPP_URL__';const $=(id)=>document.getElementById(id);const uid=()=>$('uid').value.trim()||'100500';
const post=(p,b)=>fetch(p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)});
$('demo').onclick=()=>post('/__mock/start',{user_id:uid(),payload:'demo'});$('start').onclick=()=>post('/__mock/start',{user_id:uid(),payload:null});
$('reset').onclick=()=>post('/__mock/reset',{}).then(load);$('send').onclick=()=>{const t=$('text').value.trim();if(t){post('/__mock/text',{user_id:uid(),text:t});$('text').value='';}};
function esc(s){return s.replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}
function fmt(s){return esc(s).replace(/\\*\\*(.+?)\\*\\*/g,'<b>$1</b>').replace(/_(.+?)_/g,'<i>$1</i>')}
let last='';async function load(){const r=await fetch('/__mock/messages?user_id='+uid());const d=await r.json();const sig=JSON.stringify(d.messages.map(m=>m.mid));if(sig===last)return;last=sig;
const chat=$('chat');chat.innerHTML='';for(const m of d.messages){const el=document.createElement('div');el.className='msg '+(m.direction==='in'?'in':'');el.innerHTML=fmt(m.text||'');
for(const a of (m.attachments||[])){if(a.type!=='inline_keyboard')continue;const kb=document.createElement('div');kb.className='kb';
for(const row of a.payload.buttons){const r=document.createElement('div');r.className='row';for(const b of row){const btn=document.createElement('button');btn.textContent=b.text;
btn.onclick=()=>{if(b.type==='callback')post('/__mock/callback',{user_id:uid(),payload:b.payload,mid:m.mid});
else if(b.type==='open_app'){window.open(MINIAPP+'?dev_user='+uid()+(b.payload?'&startapp='+encodeURIComponent(b.payload):''),'_blank')}
else if(b.type==='link'){const u=new URL(b.url);const sp=u.searchParams.get('startapp');window.open(sp!==null?MINIAPP+'?dev_user='+uid()+(sp?'&startapp='+encodeURIComponent(sp):''):b.url,'_blank')}};r.appendChild(btn)}kb.appendChild(r)}el.appendChild(kb)}
chat.appendChild(el)}window.scrollTo(0,document.body.scrollHeight)}
setInterval(load,1200);load();
</script></body></html>`;
