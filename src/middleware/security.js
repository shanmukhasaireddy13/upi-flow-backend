const cors = require('cors');

const allowedOrigins = (process.env.FRONTEND_ORIGINS || 'http://localhost:3000,http://localhost:3001,https://upi-flow-pay.vercel.app')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

/**
 * Browsers may call the API from configured origins or Vercel deployments.
 * Server-to-server calls carry no Origin header and are not affected by CORS.
 */
const corsMiddleware = cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    if (origin.endsWith('.vercel.app')) return callback(null, true);
    return callback(null, false);
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key', 'x-environment', 'X-Environment'],
  credentials: true,
  maxAge: 600
});

function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.removeHeader('X-Powered-By');
  next();
}

module.exports = { corsMiddleware, securityHeaders };
