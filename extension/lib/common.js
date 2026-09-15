// Shared helpers for the extension (service worker + popup).
// Mirrors cli/src/crypto.js: sealed-box equivalent on tweetnacl box,
// wire format ephemeral_pk(32) || nonce(24) || ciphertext. No signatures in MVP.
/* global nacl */

(function (root) {
  const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

  const b64 = {
    encode(u8) {
      let s = '';
      const CHUNK = 0x8000;
      for (let i = 0; i < u8.length; i += CHUNK) s += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
      return btoa(s);
    },
    decode(str) {
      const bin = atob(str);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    },
  };

  function base32(u8) {
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

  function generateIdentity() {
    const sign = nacl.sign.keyPair();
    const enc = nacl.box.keyPair();
    return {
      ext_id: base32(sign.publicKey),
      sign_pk: b64.encode(sign.publicKey),
      sign_sk: b64.encode(sign.secretKey),
      enc_pk: b64.encode(enc.publicKey),
      enc_sk: b64.encode(enc.secretKey),
      created_at: Math.floor(Date.now() / 1000),
    };
  }

  function fingerprint(pkB64) {
    const h = nacl.hash(b64.decode(pkB64)).subarray(0, 8);
    return [...h].map((x) => x.toString(16).padStart(2, '0')).join('').replace(/(.{4})/g, '$1 ').trim();
  }

  function seal(obj, recipientPkB64) {
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

  function open(payloadB64, mySkB64) {
    const data = b64.decode(payloadB64);
    if (data.length < 56 + nacl.box.overheadLength) throw new Error('payload too short');
    const pt = nacl.box.open(data.subarray(56), data.subarray(32, 56), data.subarray(0, 32), b64.decode(mySkB64));
    if (!pt) throw new Error('payload decryption failed');
    return JSON.parse(new TextDecoder().decode(pt));
  }

  function makeEnvelope({ pairing_id, type, payload, recipientPkB64 }) {
    return {
      v: 1,
      pairing_id,
      msg_id: crypto.randomUUID(),
      type,
      ts: Math.floor(Date.now() / 1000),
      from: 'ext',
      payload: seal(payload, recipientPkB64),
      sig: '',
    };
  }

  /** http(s)://host[:port] -> ws(s)://host[:port]/v1/ext */
  function wsUrlFor(httpUrl) {
    const u = new URL(httpUrl);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    u.pathname = '/v1/ext';
    u.search = '';
    return u.toString();
  }

  root.HandoffCommon = { b64, base32, generateIdentity, fingerprint, seal, open, makeEnvelope, wsUrlFor };
})(typeof self !== 'undefined' ? self : globalThis);
