// Popup UI: registered agents (add / rename / revoke), pending requests labeled
// by the requesting agent, and the activity log.

const $ = (sel) => document.querySelector(sel);

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

const fmtTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function timeLeft(expiresAtSec) {
  if (typeof expiresAtSec !== 'number') return '';
  const s = expiresAtSec - Math.floor(Date.now() / 1000);
  if (s <= 0) return 'expired';
  if (s < 90) return `${s}s left`;
  if (s < 3600) return `${Math.ceil(s / 60)}m left`;
  return `${Math.floor(s / 3600)}h ${Math.ceil((s % 3600) / 60)}m left`;
}

const CONN_TEXT = { online: 'online', connecting: 'connecting…', offline: 'offline', revoked: 'revoked' };

let busy = false;

function renderSummary(agents) {
  const online = agents.filter((a) => a.conn?.state === 'online').length;
  const dot = $('#summary-dot');
  dot.className = `dot ${online ? 'online' : agents.length ? 'offline' : ''}`;
  $('#summary-text').textContent = agents.length
    ? `${agents.length} agent${agents.length > 1 ? 's' : ''}, ${online} online`
    : 'no agents';
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
    node.querySelector('.from').textContent = `from ${r.agent_name || 'agent'}${r.tier === 2 ? ' · tier 2' : ''}${r.agent_context ? ` · ${r.agent_context}` : ''}`;
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
      // Start is the call to action; Done doesn't apply until a login tab is open.
      status.textContent = `Open the login page and sign in.${r.tier === 2 ? ' (Routed through the relay proxy.)' : ''}`;
      start.textContent = 'Start';
      start.classList.add('primary');
      done.hidden = true;
    } else if (r.state === 'started') {
      // Primary action is now the panel on the login tab; Done here is a fallback.
      status.textContent = 'Sign in on the opened tab, then confirm in the panel there. Or use Done below.';
      start.textContent = 'Reopen';
      start.classList.add('ghost');
      done.classList.remove('primary');
      done.classList.add('ghost');
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
  if (err) err.hidden = true;
  for (const b of node.querySelectorAll('button')) b.disabled = true;
  if (type === 'done') node.querySelector('.status').textContent = 'Exporting cookies and localStorage…';
  try {
    await call(type, { request_id });
  } catch (e) {
    if (err) { err.textContent = e.message; err.hidden = false; }
    for (const b of node.querySelectorAll('button')) b.disabled = false;
  } finally {
    busy = false;
    refresh();
  }
}

function renderAgents(agents) {
  const container = $('#agents');
  container.textContent = '';
  $('#no-agents').hidden = agents.length > 0;
  const tpl = $('#agent-tpl');
  for (const a of agents) {
    const node = tpl.content.firstElementChild.cloneNode(true);
    node.querySelector('.dot').className = `dot ${a.conn?.state || 'connecting'}`;
    node.querySelector('.name').textContent = a.label || a.agent?.display_name || 'agent';
    const fp = a.agent_fingerprint || '';
    node.querySelector('.sub').textContent = `${CONN_TEXT[a.conn?.state] || a.conn?.state || ''} · ${a.relay_http} · ${fp}`;
    node.querySelector('.rename').onclick = () => startRename(node, a);
    node.querySelector('.revoke').onclick = () => revokeAgent(a);
    container.appendChild(node);
  }
}

function startRename(node, agent) {
  const meta = node.querySelector('.meta');
  const input = document.createElement('input');
  input.className = 'rename-input';
  input.value = agent.label || '';
  const nameEl = node.querySelector('.name');
  nameEl.replaceWith(input);
  input.focus();
  input.select();
  const commit = async () => {
    const label = input.value.trim();
    if (label && label !== agent.label) {
      try { await call('rename', { pairing_id: agent.pairing_id, label }); } catch { /* shown on refresh */ }
    }
    refresh();
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') refresh(); });
  input.addEventListener('blur', commit);
}

async function revokeAgent(agent) {
  if (busy) return;
  busy = true;
  try { await call('revoke', { pairing_id: agent.pairing_id }); } catch { /* shown on refresh */ }
  busy = false;
  refresh();
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
    $('#summary-text').textContent = e.message;
    return;
  }
  $('#ext-fp').textContent = state.identity.fingerprint;
  renderSummary(state.agents);
  renderAgents(state.agents);
  renderRequests(state);
  renderLog(state.log);
  // Default the relay field and auto-open the add form when there are no agents.
  if (!$('#relay').value) $('#relay').value = state.default_relay;
  if (!state.agents.length && $('#add-form').hidden) toggleAddForm(true);
}

function toggleAddForm(show) {
  const form = $('#add-form');
  form.hidden = show === undefined ? !form.hidden : !show;
  $('#add-toggle').textContent = form.hidden ? '+ Add agent' : '− Cancel';
}

$('#add-toggle').onclick = () => toggleAddForm();

$('#pair-btn').onclick = async () => {
  const btn = $('#pair-btn');
  const err = $('#pair-error');
  err.hidden = true;
  btn.disabled = true;
  btn.textContent = 'Pairing…';
  try {
    await call('pair', { relay: $('#relay').value.trim(), code: $('#code').value.trim(), label: $('#label').value.trim() });
    $('#code').value = '';
    $('#label').value = '';
    toggleAddForm(false);
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

$('#summary-dot').onclick = async () => { try { await call('reconnect'); } catch { /* ignore */ } refresh(); };

chrome.storage.onChanged.addListener(() => { if (!busy) refresh(); });
setInterval(() => { if (!busy) refresh(); }, 5000);
refresh();
