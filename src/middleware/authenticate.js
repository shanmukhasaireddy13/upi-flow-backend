const { supabase } = require('../config/supabase');
const { verifyToken } = require('../lib/session');

/**
 * Accepts either:
 *  - Authorization: Bearer <session token>   (dashboard, issued at login)
 *  - x-api-key: sk_test_... or sk_live_...   (server-to-server integrations)
 * Loads the merchant into req.merchant and sets req.environment ('dev' or 'production').
 */
async function authenticate(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const bearer = /^Bearer\s+/i.test(authHeader) ? authHeader.replace(/^Bearer\s+/i, '').trim() : null;
  const apiKeyHeader = req.headers['x-api-key'] ? String(req.headers['x-api-key']).trim() : null;

  let query = supabase.from('merchants').select('*');
  let environment = 'production';

  const session = bearer ? verifyToken(bearer) : null;
  if (session) {
    query = query.eq('id', session.mid);
    const envHeader = (req.headers['x-environment'] || 'dev').toLowerCase();
    environment = envHeader === 'production' ? 'production' : 'dev';
  } else if (apiKeyHeader) {
    if (apiKeyHeader.startsWith('sk_test_')) {
      query = query.eq('test_api_key', apiKeyHeader);
      environment = 'dev';
    } else if (apiKeyHeader.startsWith('sk_live_') || apiKeyHeader.startsWith('sk_')) {
      query = query.eq('api_key', apiKeyHeader);
      environment = 'production';
    } else {
      return res.status(401).json({ error: 'Invalid API key format' });
    }
  } else if (bearer && bearer.startsWith('sk_')) {
    if (bearer.startsWith('sk_test_')) {
      query = query.eq('test_api_key', bearer);
      environment = 'dev';
    } else {
      query = query.eq('api_key', bearer);
      environment = 'production';
    }
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
    return next();
  } catch (err) {
    return next(err);
  }
}

module.exports = { authenticate };
