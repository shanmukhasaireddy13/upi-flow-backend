/**
 * Fixed-window rate limiter keyed by client IP, or by `keyFrom(req)` when given. Keeps state in memory, which is fine for a single
 * instance. Put a shared store in front of it if the backend is scaled out.
 */
function createRateLimiter({ name, windowMs, max, keyFrom = (req) => req.ip }) {
  const hits = new Map();

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (entry.reset <= now) hits.delete(key);
    }
  }, windowMs);
  sweep.unref();

  return function rateLimit(req, res, next) {
    const key = `${name}:${keyFrom(req)}`;
    const now = Date.now();
    const entry = hits.get(key);

    if (!entry || entry.reset <= now) {
      hits.set(key, { count: 1, reset: now + windowMs });
      return next();
    }

    entry.count += 1;
    if (entry.count > max) {
      res.setHeader('Retry-After', Math.ceil((entry.reset - now) / 1000));
      return res.status(429).json({ error: 'Too many requests. Please try again shortly.' });
    }
    return next();
  };
}

module.exports = { createRateLimiter };
