// Envelope crypto for the CLI (spec §3.1, §5, §13 "Crypto").
//
// MVP: payloads are encrypted with a sealed-box equivalent built on
// tweetnacl's X25519-XSalsa20-Poly1305 box: an ephemeral keypair per message,
// wire format = ephemeral_pk(32) || nonce(24) || box ciphertext. Envelopes are
// not signed yet (`sig` is empty); the Ed25519 identity keys exist so the
// identity IDs and pairing records already have the final shape.

import nacl from 'tweetnacl';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export const b64 = {
  encode: (u8) => Buffer.from(u8).toString('base64'),
  decode: (s) => new Uint8Array(Buffer.from(s, 'base64')),
};

export function base32(u8) {
  let bits = 0, value = 0, out = '';
  for (const byte of u8) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function generateIdentity() {
  const sign = nacl.sign.keyPair();
  const enc = nacl.box.keyPair();
  return {
    agent_id: base32(sign.publicKey),
    sign_pk: b64.encode(sign.publicKey),
    sign_sk: b64.encode(sign.secretKey),
    enc_pk: b64.encode(enc.publicKey),
    enc_sk: b64.encode(enc.secretKey),
    created_at: Math.floor(Date.now() / 1000),
  };
}

/** Short human-checkable fingerprint of a base64 public key. */
export function fingerprint(pkB64) {
  const h = nacl.hash(b64.decode(pkB64)).subarray(0, 8);
  return [...h].map((x) => x.toString(16).padStart(2, '0')).join('').replace(/(.{4})/g, '$1 ').trim();
}

export function seal(obj, recipientPkB64) {
  const plaintext = new TextEncoder().encode(JSON.stringify(obj));
  const eph = nacl.box.keyPair();
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const ct = nacl.box(plaintext, nonce, b64.decode(recipientPkB64), eph.secretKey);
  const out = new Uint8Array(32 + 24 + ct.length);
  out.set(eph.publicKey, 0);
  out.set(nonce, 32);
  out.set(ct, 56);
  return b64.encode(out);
}

export function open(payloadB64, mySkB64) {
  const data = b64.decode(payloadB64);
  if (data.length < 56 + nacl.box.overheadLength) throw new Error('payload too short');
  const epk = data.subarray(0, 32);
  const nonce = data.subarray(32, 56);
  const ct = data.subarray(56);
  const pt = nacl.box.open(ct, nonce, epk, b64.decode(mySkB64));
  if (!pt) throw new Error('payload decryption failed');
  return JSON.parse(new TextDecoder().decode(pt));
}

export function makeEnvelope({ pairing_id, type, payload, recipientPkB64, msg_id }) {
  return {
    v: 1,
    pairing_id,
    msg_id: msg_id || crypto.randomUUID(),
    type,
    ts: Math.floor(Date.now() / 1000),
    from: 'agent',
    payload: seal(payload, recipientPkB64),
    sig: '',
  };
}
