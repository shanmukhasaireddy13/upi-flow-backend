const crypto = require('crypto');

// Signed, expiring dashboard sessions. The secret must be stable across restarts,
// otherwise every merchant is logged out on each deploy.
let SECRET = process.env.SESSION_SECRET;
if (!SECRET) {
  console.warn('[AUTH] SESSION_SECRET is not set. Using a random secret; sessions reset on restart.');
  SECRET = crypto.randomBytes(32).toString('hex');
}

const TTL_MS = 7 * 24 * 60 * 60 * 1000;

function signature(body) {
  return crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
}

/**
 * Creates a token carrying `payload` plus an expiry. Format: v1.<body>.<hmac>
 */
function signToken(payload, ttlMs = TTL_MS) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + ttlMs })).toString('base64url');
  return `v1.${body}.${signature(body)}`;
}

/**
 * Returns the payload of a valid, unexpired token, or null.
 */
function verifyToken(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;

  const [, body, sig] = parts;
  const expected = Buffer.from(signature(body));
  const given = Buffer.from(sig);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch (err) {
    return null;
  }
  if (!payload.exp || payload.exp < Date.now()) return null;
  return payload;
}

module.exports = { signToken, verifyToken, TTL_MS };
