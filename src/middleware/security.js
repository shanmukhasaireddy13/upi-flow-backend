const cors = require('cors');

const allowedOrigins = (process.env.FRONTEND_ORIGINS || 'http://localhost:3000,http://localhost:3001,https://upi-flow-pay.vercel.app')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

// Optional regex for your own preview deployments, e.g. ^https://upi-flow-pay-[a-z0-9-]+-yourteam\.vercel\.app$
// Never allow all of *.vercel.app: anyone can deploy a site there.
const previewOriginPattern = process.env.PREVIEW_ORIGIN_PATTERN ? new RegExp(process.env.PREVIEW_ORIGIN_PATTERN) : null;

/**
 * Dashboard API: only our own frontend may read responses in a browser. Auth is a Bearer header,
 * not a cookie, so credentials are not enabled. Server-to-server calls (merchant backends using
 * sk_ keys, Google Pub/Sub, email forwarders) send no Origin header and are not affected by CORS.
 */
const dashboardCors = cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    if (previewOriginPattern && previewOriginPattern.test(origin)) return callback(null, true);
    return callback(null, false);
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key', 'x-environment', 'X-Environment'],
  maxAge: 600
});

/**
 * Public checkout endpoints carry no secrets and need no auth, so any site may call them
 * (like Stripe's publishable-key endpoints). Auth headers are not allowed here.
 */
const publicCors = cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
  maxAge: 600
});

const PUBLIC_PATHS = [
  /^\/health$/,
  /^\/api\/orders\/(status\/)?ord_[A-Za-z0-9_-]+$/,
  /^\/api\/orders\/verify-utr$/
];

function corsMiddleware(req, res, next) {
  const isPublic = PUBLIC_PATHS.some((pattern) => pattern.test(req.path));
  return (isPublic ? publicCors : dashboardCors)(req, res, next);
}

function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.removeHeader('X-Powered-By');
  next();
}

module.exports = { corsMiddleware, securityHeaders };
