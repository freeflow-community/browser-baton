// Popup UI: pairing form, pending requests (Start / Done / Decline), activity log.

const $ = (sel) => document.querySelector(sel);

// Opened as a standalone window (auto-popped on a request) vs. the toolbar popup.
if (new URLSearchParams(location.search).has('window')) document.body.classList.add('windowed');

function call(type, extra = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, ...extra }, (res) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!res) return reject(new Error('no response from service worker'));
      if (!res.ok) return reject(new Error(res.error));
      resolve(res.result);
    });
  });
}

function fmtTime(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function timeLeft(expiresAtSec) {
  if (typeof expiresAtSec !== 'number') return '';
  const s = expiresAtSec - Math.floor(Date.now() / 1000);
  if (s <= 0) return 'expired';
  if (s < 90) return `${s}s left`;
  if (s < 3600) return `${Math.ceil(s / 60)}m left`;
  return `${Math.floor(s / 3600)}h ${Math.ceil((s % 3600) / 60)}m left`;
}

let busy = false;

function renderConn(conn) {
  const dot = $('#conn-dot');
  const text = $('#conn-text');
  const state = conn?.state || 'unpaired';
  dot.className = `dot ${state}`;
  text.textContent = {
    online: 'connected to relay',
    connecting: 'connecting…',
    offline: `offline — retrying${conn?.reason ? ` (${conn.reason})` : ''}`,
    revoked: 'pairing revoked',
    unpaired: 'not paired',
  }[state] || state;
}

function renderRequests(state) {
  const container = $('#requests');
  container.textContent = '';
  const list = Object.values(state.requests || {}).sort((a, b) => b.received_at - a.received_at);
  $('#no-requests').hidden = list.length > 0;
  const tpl = $('#request-tpl');
  for (const r of list) {
    const node = tpl.content.firstElementChild.cloneNode(true);
    node.dataset.id = r.request_id;
    if (r.state === 'sent') node.classList.add('sent');
    if (r.state === 'reported') node.classList.add(r.result?.ok ? 'reported-ok' : 'reported-bad');
    node.querySelector('.label').textContent = r.task_label || 'Agent needs a session';
    node.querySelector('.expires').textContent = r.state === 'pending' || r.state === 'started' ? timeLeft(r.expires_at) : fmtTime(r.sent_at || r.received_at);
    const ul = node.querySelector('.origins');
    for (const o of r.origins) {
      const li = document.createElement('li');
      li.textContent = o;
      ul.appendChild(li);
    }
    const status = node.querySelector('.status');
    const start = node.querySelector('.start');
    const done = node.querySelector('.done');
    const decline = node.querySelector('.decline');
    const dismiss = node.querySelector('.dismiss');
    if (r.state === 'pending') {
      status.textContent = `Tier ${r.tier}. Click Start to open the login page, log in, then click Done.`;
    } else if (r.state === 'started') {
      status.textContent = 'Log in in the opened tab, then click Done to send the session.';
      start.textContent = 'Reopen';
    } else if (r.state === 'sent') {
      status.textContent = `Sent ${r.summary || 'bundle'}. Waiting for the agent to report…`;
      start.hidden = done.hidden = decline.hidden = true;
      dismiss.hidden = false;
    } else if (r.state === 'reported') {
      status.textContent = r.result?.ok ? '✓ Agent confirmed the session works.' : `✗ Agent reported failure: ${r.result?.reason || 'unspecified'}`;
      start.hidden = done.hidden = decline.hidden = true;
      dismiss.hidden = false;
    }
    start.onclick = () => act(node, 'start', r.request_id);
    done.onclick = () => act(node, 'done', r.request_id);
    decline.onclick = () => act(node, 'decline', r.request_id);
    dismiss.onclick = () => act(node, 'dismiss', r.request_id);
    container.appendChild(node);
  }
}

async function act(node, type, request_id) {
  if (busy) return;
  busy = true;
  const err = node.querySelector('.req-error');
  err.hidden = true;
  for (const b of node.querySelectorAll('button')) b.disabled = true;
  if (type === 'done') node.querySelector('.status').textContent = 'Exporting cookies and localStorage…';
  try {
    await call(type, { request_id });
  } catch (e) {
    err.textContent = e.message;
    err.hidden = false;
    for (const b of node.querySelectorAll('button')) b.disabled = false;
  } finally {
    busy = false;
    refresh();
  }
}

function renderLog(log) {
  const ul = $('#log');
  ul.textContent = '';
  for (const e of (log || []).slice(0, 12)) {
    const li = document.createElement('li');
    if (e.kind === 'report') li.className = e.ok ? 'ok' : 'bad';
    if (e.kind === 'error' || e.kind === 'denylist' || e.kind === 'revoked') li.className = 'bad';
    const when = document.createElement('span');
    when.className = 'when';
    when.textContent = fmtTime(e.at);
    const text = document.createElement('span');
    text.textContent = e.text;
    li.append(when, text);
    ul.appendChild(li);
  }
}

async function refresh() {
  let state;
  try {
    state = await call('getState');
  } catch (e) {
    $('#conn-text').textContent = e.message;
    return;
  }
  renderConn(state.conn);
  $('#ext-fp').textContent = state.identity.fingerprint;
  const paired = Boolean(state.pairing);
  $('#pair-view').hidden = paired;
  $('#paired-view').hidden = !paired;
  if (!paired) {
    if (!$('#relay').value) $('#relay').value = state.default_relay;
    return;
  }
  $('#agent-name').textContent = state.pairing.agent?.display_name || state.pairing.agent?.agent_id;
  $('#agent-fp').textContent = state.pairing.agent_fingerprint;
  $('#relay-text').textContent = `via ${state.pairing.relay_http}`;
  $('#revoked-note').hidden = !state.pairing.revoked;
  renderRequests(state);
  renderLog(state.log);
}

$('#pair-btn').onclick = async () => {
  const btn = $('#pair-btn');
  const err = $('#pair-error');
  err.hidden = true;
  btn.disabled = true;
  btn.textContent = 'Pairing…';
  try {
    await call('pair', { relay: $('#relay').value.trim(), code: $('#code').value.trim() });
    $('#code').value = '';
  } catch (e) {
    err.textContent = e.message;
    err.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Pair';
    refresh();
  }
};
$('#code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#pair-btn').click(); });
$('#unpair-btn').onclick = async () => {
  try { await call('unpair'); } catch (e) { $('#conn-text').textContent = e.message; }
  refresh();
};
$('#reconnect-btn').onclick = async () => {
  try { await call('reconnect'); } catch { /* shown via state */ }
  refresh();
};

chrome.storage.onChanged.addListener(() => { if (!busy) refresh(); });
setInterval(() => { if (!busy) refresh(); }, 5000);
refresh();
