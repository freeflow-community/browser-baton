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

/** MVP: one pairing. Uses --pairing if given, else the most recent. */
export function currentPairing(explicitId) {
  const all = listPairings();
  if (explicitId) return all.find((p) => p.pairing_id === explicitId || p.pairing_id.startsWith(explicitId)) || null;
  return all[0] || null;
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
