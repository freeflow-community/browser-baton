// CLI config dir (spec §8): $HANDOFF_HOME or ~/.handoff/
//   identity.json           agent keypairs
//   pairings/<id>.json      pairing record (relay URL, token, ext keys)
//   pending/<request>.json  in-flight needs_session requests (resume on re-run)
//   origins.json            learned origin data (tier-2 candidates after failed reports)
//   last_request.json       id of the most recent completed request (default for `report`)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateIdentity } from './crypto.js';

export const DEFAULT_RELAY = 'http://127.0.0.1:8787';

export function home() {
  return process.env.HANDOFF_HOME || path.join(os.homedir(), '.handoff');
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true, mode: 0o700 });
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw e;
  }
}

export function writeJson(file, obj) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function loadIdentity() {
  const file = path.join(home(), 'identity.json');
  let id = readJson(file);
  if (!id) {
    id = generateIdentity();
    writeJson(file, id);
  }
  return id;
}

export function pairingsDir() {
  return path.join(home(), 'pairings');
}

export function listPairings() {
  const dir = pairingsDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readJson(path.join(dir, f)))
    .filter(Boolean)
    .sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
}

export function savePairing(p) {
  writeJson(path.join(pairingsDir(), `${p.pairing_id}.json`), p);
}

export function deletePairing(id) {
  try { fs.unlinkSync(path.join(pairingsDir(), `${id}.json`)); } catch { /* ignore */ }
}

/** Resolve a pairing by id-prefix or label; else the default; else the most recent. */
export function currentPairing(selector) {
  const all = listPairings();
  if (selector) {
    const s = selector.toLowerCase();
    return all.find((p) =>
      p.pairing_id === selector
      || p.pairing_id.startsWith(selector)
      || (p.label && p.label.toLowerCase() === s)
      || (p.ext_display_name && p.ext_display_name.toLowerCase() === s),
    ) || null;
  }
  const def = getDefaultPairing();
  if (def) {
    const p = all.find((x) => x.pairing_id === def);
    if (p) return p;
  }
  return all[0] || null;
}

export function getDefaultPairing() {
  return readJson(path.join(home(), 'default.json'))?.pairing_id || null;
}
export function setDefaultPairing(id) {
  writeJson(path.join(home(), 'default.json'), { pairing_id: id });
}

export function pendingDir() {
  return path.join(home(), 'pending');
}

export function listPending() {
  const dir = pendingDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readJson(path.join(dir, f)))
    .filter(Boolean);
}

export function savePending(req) {
  writeJson(path.join(pendingDir(), `${req.request_id}.json`), req);
}

export function deletePending(requestId) {
  try { fs.unlinkSync(path.join(pendingDir(), `${requestId}.json`)); } catch { /* ignore */ }
}

export function loadOrigins() {
  return readJson(path.join(home(), 'origins.json'), { origins: {} });
}

export function saveOrigins(o) {
  writeJson(path.join(home(), 'origins.json'), o);
}

export function setLastRequest(info) {
  writeJson(path.join(home(), 'last_request.json'), info);
}

export function getLastRequest() {
  return readJson(path.join(home(), 'last_request.json'));
}
