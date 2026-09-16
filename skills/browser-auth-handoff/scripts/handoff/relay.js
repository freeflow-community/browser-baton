// Thin HTTPS client for the relay's CLI endpoints (spec §4).

export class RelayError extends Error {
  constructor(status, body) {
    super(`relay ${status}: ${body?.error || 'error'}`);
    this.status = status;
    this.body = body;
  }
  get unpaired() {
    return this.status === 401 || this.status === 404 || this.status === 410;
  }
}

export class RelayClient {
  constructor(baseUrl, token = null) {
    this.base = baseUrl.replace(/\/+$/, '');
    this.token = token;
  }

  async call(method, path, { body, timeoutMs = 90_000 } = {}) {
    const headers = { accept: 'application/json' };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    let res;
    try {
      res = await fetch(this.base + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new RelayError(0, { error: `relay unreachable at ${this.base} (${e.cause?.code || e.message})` });
    }
    if (res.status === 204) return null;
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = { error: text }; }
    if (!res.ok) throw new RelayError(res.status, json);
    return json;
  }

  beginPairing(agent) {
    return this.call('POST', '/v1/pairings/begin', { body: agent });
  }
  waitPairing(code, waitS) {
    return this.call('GET', `/v1/pairings/${encodeURIComponent(code)}/wait?wait=${waitS}`, { timeoutMs: (waitS + 30) * 1000 });
  }
  postMessage(pairingId, envelope) {
    return this.call('POST', `/v1/pairings/${pairingId}/messages`, { body: envelope });
  }
  pollMessages(pairingId, waitS) {
    return this.call('GET', `/v1/pairings/${pairingId}/messages?wait=${waitS}`, { timeoutMs: (waitS + 30) * 1000 });
  }
  ackMessages(pairingId, msgIds) {
    return this.call('POST', `/v1/pairings/${pairingId}/messages/ack`, { body: { msg_ids: msgIds } });
  }
  status(pairingId) {
    return this.call('GET', `/v1/pairings/${pairingId}`);
  }
  revoke(pairingId) {
    return this.call('DELETE', `/v1/pairings/${pairingId}`);
  }
}
