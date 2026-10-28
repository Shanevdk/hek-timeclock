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

// Values that have been published — the old built-in fallback and the
// .env.example placeholder. A secret anyone can read in the repository is no
// secret, so neither is ever accepted. Listed by SHA-256 so this file doesn't
// publish them all over again.
const PUBLISHED = new Set([
  '7637534278bf8b6da8780ce6437b7ca06235ef6212162828579b55c20ce70d23',
  '507f4a36ac60403813911d179e82c5a8c07c6e1475182d56af418ab495029e8b',
]);
const published = (s) => PUBLISHED.has(crypto.createHash('sha256').update(s).digest('hex'));
const MIN_SECRET_LENGTH = 32;
const weak = (s) => !s || s.length < MIN_SECRET_LENGTH || published(s);

// The key that signs every login cookie. There is no fallback: with a known
// key, anyone could sign a cookie that says "admin". Called once at startup,
// so a missing or published value stops the app with a clear message instead
// of running wide open.
function sessionSecret() {
  const secret = process.env.SESSION_SECRET || '';
  if (weak(secret)) {
    const err = new Error(
      'SESSION_SECRET must be set to a long random value (at least 32 characters) and must not be ' +
        'the placeholder from .env.example. Generate one with:\n' +
        '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64url\'))"'
    );
    // A setup mistake, not a crash: safe to show to whoever is deploying.
    err.code = 'CONFIG';
    throw err;
  }
  return secret;
}

// scrypt is deliberately slow (tens of milliseconds, all of it blocking the
// server), and a key only changes when its secret does — so derive each once.
const derived = new Map();

function keyFor(purpose) {
  const secret =
    process.env.CREDENTIAL_ENCRYPTION_KEY ||
    process.env.MAIL_ENCRYPTION_KEY ||
    process.env.SESSION_SECRET ||
    '';
  // Published values only, not the length rule: a deployment that already
  // stores credentials under a shorter dedicated key must keep decrypting them.
  if (!secret || published(secret)) {
    const err = new Error(
      'Set SESSION_SECRET (or CREDENTIAL_ENCRYPTION_KEY) to a long random value before saving a credential.'
    );
    err.status = 400;
    throw err;
  }
  const id = crypto.createHash('sha256').update(`${purpose}\0${secret}`).digest('base64');
  let key = derived.get(id);
  if (!key) {
    key = crypto.scryptSync(secret, `hek-${purpose}-v1`, 32);
    derived.set(id, key);
  }
  return key;
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

module.exports = { encrypt, decrypt, canEncrypt, sessionSecret };
