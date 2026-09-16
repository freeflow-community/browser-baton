// Minimal Chrome DevTools Protocol client and credential loader for the shared
// browser (multi-agent shared-service model). Zero deps: Node's global fetch +
// WebSocket. Injects a Session Handoff bundle (spec §6) into a running Chrome so
// its persistent profile holds the session for every attached agent.

/** Connect to the browser-level CDP endpoint at http://127.0.0.1:<port>. */
export async function connectCDP(port, { timeoutMs = 10_000 } = {}) {
  const info = await fetchJson(`http://127.0.0.1:${port}/json/version`, timeoutMs);
  const wsUrl = info.webSocketDebuggerUrl;
  if (!wsUrl) throw new Error('no webSocketDebuggerUrl from CDP');
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error(`CDP websocket failed at ${wsUrl}`));
  });
  let nextId = 1;
  const pending = new Map();
  ws.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(`${m.error.message} (${m.error.code})`)) : resolve(m.result);
    }
  };
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  return { send, close: () => ws.close() };
}

async function fetchJson(url, timeoutMs) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`CDP HTTP ${res.status} at ${url}`);
  return res.json();
}

/** Is a CDP endpoint answering on this port? */
export async function cdpAlive(port, timeoutMs = 1500) {
  try { await fetchJson(`http://127.0.0.1:${port}/json/version`, timeoutMs); return true; }
  catch { return false; }
}

/** Bundle cookies -> CDP CookieParam[]. */
function cdpCookies(bundle) {
  return (bundle.cookies || []).map((c) => {
    const out = { name: c.name, value: c.value, domain: c.domain, path: c.path || '/', secure: Boolean(c.secure), httpOnly: Boolean(c.httpOnly) };
    if (['Strict', 'Lax', 'None'].includes(c.sameSite)) out.sameSite = c.sameSite;
    if (typeof c.expires === 'number' && c.expires > 0) out.expires = c.expires;
    return out;
  });
}

/**
 * Inject a bundle into the running shared browser: cookies browser-wide via
 * Storage.setCookies, localStorage by opening a short-lived tab per origin.
 * Returns a small summary. The browser's persistent profile keeps the session.
 */
export async function loadBundleIntoBrowser(port, bundle) {
  const cdp = await connectCDP(port);
  try {
    const cookies = cdpCookies(bundle);
    if (cookies.length) await cdp.send('Storage.setCookies', { cookies });

    let lsCount = 0;
    for (const o of bundle.origins_storage || []) {
      if (!o.localStorage?.length) continue;
      const { targetId } = await cdp.send('Target.createTarget', { url: o.origin });
      try {
        const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
        await waitForLoad(cdp, sessionId);
        const expr = `(() => { const items = ${JSON.stringify(o.localStorage)};
          for (const it of items) { try { localStorage.setItem(it.name, it.value); } catch (_) {} }
          return items.length; })()`;
        const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true }, sessionId);
        lsCount += Number(r?.result?.value || 0);
      } finally {
        await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
      }
    }
    return { cookies: cookies.length, localStorage: lsCount };
  } finally {
    cdp.close();
  }
}

async function waitForLoad(cdp, sessionId) {
  // Best-effort: poll document.readyState via the attached session.
  for (let i = 0; i < 40; i++) {
    try {
      const r = await cdp.send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true }, sessionId);
      if (r?.result?.value === 'complete' || r?.result?.value === 'interactive') return;
    } catch { /* target not ready yet */ }
    await new Promise((res) => setTimeout(res, 150));
  }
}
