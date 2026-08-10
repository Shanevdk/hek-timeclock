// Encryption for credentials the app stores on the client's behalf — a mail
// app password, a QuickBooks client secret. These are live keys to someone
// else's systems, so they never sit in the database as plain text.
//
// AES-256-GCM, with the key derived from a server secret that never leaves the
// environment. Each kind of credential derives its own key from its own salt,
// so a value stolen from one place can't be decrypted with the other's key.
//
// Key source, in order: CREDENTIAL_ENCRYPTION_KEY, then MAIL_ENCRYPTION_KEY
// (kept for deployments that already set it), then SESSION_SECRET. Change the
// one in use and stored credentials stop decrypting — which surfaces as "enter
// it again" rather than a crash.

'use strict';

const crypto = require('crypto');

const PLACEHOLDER = 'hek-timeclock-dev-secret-please-change';

function keyFor(purpose) {
  const secret =
    process.env.CREDENTIAL_ENCRYPTION_KEY ||
    process.env.MAIL_ENCRYPTION_KEY ||
    process.env.SESSION_SECRET ||
    '';
  if (!secret || secret === PLACEHOLDER) {
    const err = new Error(
      'Set SESSION_SECRET (or CREDENTIAL_ENCRYPTION_KEY) to a long random value before saving a credential.'
    );
    err.status = 400;
    throw err;
  }
  return crypto.scryptSync(secret, `hek-${purpose}-v1`, 32);
}

// Returns "iv:tag:ciphertext", all base64.
function encrypt(purpose, plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyFor(purpose), iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), enc.toString('base64')].join(':');
}

// Null when the value can't be read — wrong key, or the stored blob was
// tampered with. Callers treat that as "no credential", not as an error.
function decrypt(purpose, blob) {
  const [iv, tag, data] = String(blob || '').split(':');
  if (!iv || !tag || !data) return null;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', keyFor(purpose), Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

// True when a server secret good enough to encrypt with is configured.
function canEncrypt() {
  try {
    keyFor('probe');
    return true;
  } catch {
    return false;
  }
}

module.exports = { encrypt, decrypt, canEncrypt };
