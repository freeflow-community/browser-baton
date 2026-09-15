// Local test site for the MVP success criteria (spec §13):
//   /cookie/app  — cookie-based auth (HttpOnly session cookie set on POST /cookie/login)
//   /ls/app      — token kept in localStorage (POST /ls/login returns a token; page JS stores it)
// Credentials: user "alice", password "wonderland".

import http from 'node:http';
import crypto from 'node:crypto';

const PORT = Number(process.env.PORT || 4321);
const HOST = process.env.HOST || '127.0.0.1';
const USER = 'alice';
const PASS = 'wonderland';
const sessions = new Set();
const tokens = new Set();

const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:520px;margin:48px auto;padding:0 16px}input,button{font:inherit;padding:6px 8px;margin:4px 0}nav a{margin-right:12px}</style>
</head><body><nav><a href="/">home</a><a href="/cookie/app">cookie app</a><a href="/ls/app">localStorage app</a></nav>${body}</body></html>`;

const loginForm = (action, note) => `<h1>Sign in</h1><p>${note}</p>
<form method="post" action="${action}" id="login">
  <label>User <input name="user" value="${USER}"></label><br>
  <label>Password <input name="password" type="password" autofocus></label><br>
  <button type="submit">Sign in</button>
</form>`;

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
  });
}

function html(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(body);
}

function json(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  if (p === '/') return html(res, 200, page('Handoff test site', '<h1>Handoff test site</h1><p>Two toy apps: one keeps its session in an HttpOnly cookie, one in localStorage.</p>'));

  // ---- cookie-based app
  if (p === '/cookie/app') {
    const sid = parseCookies(req).sid;
    if (sid && sessions.has(sid)) {
      return html(res, 200, page('Cookie app', `<h1 id="ok">Welcome back, ${USER} (cookie session)</h1><p>Secret content: <code>cookie-secret-42</code></p><form method="post" action="/cookie/logout"><button>Log out</button></form>`));
    }
    return html(res, 200, page('Cookie app — sign in', loginForm('/cookie/login', 'Session is an HttpOnly cookie named <code>sid</code>.')));
  }
  if (p === '/cookie/login' && req.method === 'POST') {
    const body = new URLSearchParams(await readBody(req));
    if (body.get('user') === USER && body.get('password') === PASS) {
      const sid = crypto.randomBytes(16).toString('hex');
      sessions.add(sid);
      return html(res, 303, '', { 'set-cookie': `sid=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`, location: '/cookie/app' });
    }
    return html(res, 401, page('Sign in failed', loginForm('/cookie/login', '<b>Wrong password.</b>')));
  }
  if (p === '/cookie/logout' && req.method === 'POST') {
    sessions.delete(parseCookies(req).sid);
    return html(res, 303, '', { 'set-cookie': 'sid=; Path=/; Max-Age=0', location: '/cookie/app' });
  }

  // ---- localStorage-token app
  if (p === '/ls/app') {
    return html(res, 200, page('localStorage app', `<div id="root"><p>loading…</p></div>
<script>
(async function render() {
  const root = document.getElementById('root');
  const token = localStorage.getItem('ls_token');
  if (token) {
    const r = await fetch('/ls/me', { headers: { authorization: 'Bearer ' + token } });
    if (r.ok) {
      const me = await r.json();
      root.innerHTML = '<h1 id="ok">Welcome back, ' + me.user + ' (localStorage token)</h1><p>Secret content: <code>ls-secret-99</code></p><button id="logout">Log out</button>';
      document.getElementById('logout').onclick = () => { localStorage.removeItem('ls_token'); location.reload(); };
      return;
    }
    localStorage.removeItem('ls_token');
  }
  root.innerHTML = ${JSON.stringify(loginForm('#', 'Token is stored in <code>localStorage.ls_token</code>.'))};
  document.getElementById('login').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const r = await fetch('/ls/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user: fd.get('user'), password: fd.get('password') }) });
    if (!r.ok) { alert('wrong password'); return; }
    localStorage.setItem('ls_token', (await r.json()).token);
    location.reload();
  };
})();
</script>`));
  }
  if (p === '/ls/login' && req.method === 'POST') {
    let body = {};
    try { body = JSON.parse(await readBody(req)); } catch { /* ignore */ }
    if (body.user === USER && body.password === PASS) {
      const token = crypto.randomBytes(16).toString('hex');
      tokens.add(token);
      return json(res, 200, { token });
    }
    return json(res, 401, { error: 'bad credentials' });
  }
  if (p === '/ls/me') {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    if (m && tokens.has(m[1])) return json(res, 200, { user: USER });
    return json(res, 401, { error: 'unauthorized' });
  }
  html(res, 404, page('Not found', '<h1>Not found</h1>'));
});

server.listen(PORT, HOST, () => console.error(`[testsite] http://${HOST}:${PORT}  (user ${USER} / password ${PASS})`));
