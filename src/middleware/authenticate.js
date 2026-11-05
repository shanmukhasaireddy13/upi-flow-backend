const { supabase } = require('../config/supabase');
const { verifyToken } = require('../lib/session');

// API keys are only ever looked up with .eq(), but the format check also rejects junk before it reaches the database.
const API_KEY_PATTERN = /^sk_[A-Za-z0-9_-]{8,128}$/;

/**
 * Accepts either:
 *  - Authorization: Bearer <session token>   (dashboard, issued at login)
 *  - x-api-key: sk_live_... or sk_test_...   (server-to-server integrations)
 *  - Authorization: Bearer sk_...            (same as x-api-key)
 * Loads the merchant into req.merchant and sets req.environment ('production').
 */
async function authenticate(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const bearer = /^Bearer\s+/i.test(authHeader) ? authHeader.replace(/^Bearer\s+/i, '').trim() : null;
  const apiKeyHeader = req.headers['x-api-key'] ? String(req.headers['x-api-key']).trim() : null;

  let query = supabase.from('merchants').select('*');
  const environment = 'production';

  // Tokens signed for another purpose (for example the Google OAuth `state`) are not logins.
  const claims = bearer ? verifyToken(bearer) : null;
  const session = claims && !claims.purpose && claims.mid ? claims : null;
  const apiKey = apiKeyHeader || (bearer && bearer.startsWith('sk_') ? bearer : null);

  if (session) {
    query = query.eq('id', session.mid);
  } else if (apiKey) {
    if (!API_KEY_PATTERN.test(apiKey)) {
      return res.status(401).json({ error: 'Invalid or expired credentials' });
    }
    query = query.eq(apiKey.startsWith('sk_test_') ? 'test_api_key' : 'api_key', apiKey);
  } else {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    const { data: merchant, error } = await query.maybeSingle();
    if (error || !merchant) {
      return res.status(401).json({ error: 'Invalid or expired credentials' });
    }
    req.merchant = merchant;
    req.environment = environment;
    req.authMethod = session ? 'session' : 'api_key';
    return next();
  } catch (err) {
    return next(err);
  }
}

/**
 * For account management. API keys create and read orders only, so a leaked key cannot change
 * the merchant's UPI ID (where customers' money goes), read secrets, or rotate credentials.
 * Must run after authenticate.
 */
function requireSession(req, res, next) {
  if (req.authMethod !== 'session') {
    return res.status(403).json({ error: 'This action requires signing in to the dashboard. API keys cannot be used.' });
  }
  return next();
}

module.exports = { authenticate, requireSession };
