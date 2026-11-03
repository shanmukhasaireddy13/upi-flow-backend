const crypto = require('crypto');

const ITERATIONS = 210000;
const KEY_LENGTH = 32;

/**
 * Hashes with PBKDF2-SHA256. Stored as: pbkdf2_sha256$<iterations>$<salt>$<hash>
 */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, ITERATIONS, KEY_LENGTH, 'sha256').toString('hex');
  return `pbkdf2_sha256$${ITERATIONS}$${salt}$${hash}`;
}

/**
 * Verifies a password against the current format and the legacy `salt:hash` format.
 */
function verifyPassword(password, stored) {
  if (!stored || typeof password !== 'string') return false;

  let iterations;
  let salt;
  let expected;
  let digest;
  let length;

  if (stored.startsWith('pbkdf2_sha256$')) {
    const [, iter, s, h] = stored.split('$');
    iterations = parseInt(iter, 10);
    salt = s;
    expected = h;
    digest = 'sha256';
    length = KEY_LENGTH;
  } else {
    const [s, h] = stored.split(':');
    if (!s || !h) return false;
    iterations = 1000;
    salt = s;
    expected = h;
    digest = 'sha512';
    length = 64;
  }

  const computed = Buffer.from(
    crypto.pbkdf2Sync(password, salt, iterations, length, digest).toString('hex')
  );
  const given = Buffer.from(expected || '');
  return given.length === computed.length && crypto.timingSafeEqual(given, computed);
}

/** True when a stored hash uses the legacy format and should be upgraded on next login. */
function needsRehash(stored) {
  return !stored || !stored.startsWith('pbkdf2_sha256$');
}

module.exports = { hashPassword, verifyPassword, needsRehash };
