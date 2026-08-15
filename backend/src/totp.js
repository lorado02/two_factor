'use strict';
/**
 * totp.js — minimal TOTP (RFC 6238) helper using only Node's built-in
 * `crypto` module.  Avoids the @scure/base ESM dependency that otplib v13
 * pulls in (which breaks Jest's CommonJS transform).
 *
 * Implements HMAC-SHA1 + base32 decode inline — the smallest surface we need.
 */

const crypto = require('crypto');

// ── Base32 alphabet (RFC 4648) ───────────────────────────────────────────────
const B32_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const B32_MAP = Object.fromEntries([...B32_CHARS].map((c, i) => [c, i]));

/** Decode a base32 string to a Buffer. */
function base32Decode(str) {
  const s = str.toUpperCase().replace(/=+$/, '');
  const bits = [...s].map(c => {
    const v = B32_MAP[c];
    if (v === undefined) throw new Error(`Invalid base32 char: ${c}`);
    return v.toString(2).padStart(5, '0');
  }).join('');
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

/** Encode a Buffer to a base32 string (no padding). */
function base32Encode(buf) {
  const bits = [...buf].map(b => b.toString(2).padStart(8, '0')).join('');
  const chunks = [];
  for (let i = 0; i < bits.length; i += 5) {
    const chunk = bits.slice(i, i + 5).padEnd(5, '0');
    chunks.push(B32_CHARS[parseInt(chunk, 2)]);
  }
  return chunks.join('');
}

/**
 * Generate a cryptographically-random base32 TOTP secret (20 bytes = 160 bits).
 * @returns {string} base32 string
 */
function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}

/**
 * Generate the current TOTP token for a given secret.
 * @param {string} secret  base32-encoded secret
 * @param {object} [opts]
 * @param {number} [opts.window=0]  counter window offset (e.g. use -1, 0, +1 for ±1 step)
 * @returns {string} 6-digit zero-padded token
 */
function generate(secret, opts = {}) {
  const { window: w = 0 } = opts;
  const epoch = Math.floor(Date.now() / 1000);
  const counter = Math.floor(epoch / 30) + w;
  return _hotp(secret, counter);
}

/**
 * Verify a TOTP token against a secret with a ±window tolerance.
 * @param {string} token   6-digit string
 * @param {string} secret  base32-encoded secret
 * @param {object} [opts]
 * @param {number} [opts.window=1]  steps to check on each side (default 1 = ±1)
 * @returns {boolean}
 */
function verify(token, secret, opts = {}) {
  const { window: w = 1 } = opts;
  const epoch = Math.floor(Date.now() / 1000);
  const step = Math.floor(epoch / 30);
  for (let i = -w; i <= w; i++) {
    if (_hotp(secret, step + i) === token) return true;
  }
  return false;
}

/**
 * Generate an otpauth:// URI for QR code rendering.
 */
function keyuri(email, issuer, secret) {
  const label = encodeURIComponent(`${issuer}:${email}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

// ── Internal HMAC-based OTP ──────────────────────────────────────────────────
function _hotp(secret, counter) {
  const key = base32Decode(secret);
  const msg = Buffer.alloc(8);
  // Write 64-bit big-endian counter
  const hi = Math.floor(counter / 2 ** 32);
  const lo = counter >>> 0;
  msg.writeUInt32BE(hi, 0);
  msg.writeUInt32BE(lo, 4);
  const hmac = crypto.createHmac('sha1', key).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac[offset] & 0x7f) << 24)
    | (hmac[offset + 1] << 16)
    | (hmac[offset + 2] << 8)
    | hmac[offset + 3];
  return (code % 1_000_000).toString().padStart(6, '0');
}

module.exports = { generateSecret, generate, verify, keyuri };
