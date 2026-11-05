const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const express = require('express');
const orderRoutes = require('./routes/orderRoutes');
const webhookRoutes = require('./routes/webhookRoutes');
const merchantRoutes = require('./routes/merchantRoutes');
const authRoutes = require('./routes/authRoutes');
const { corsMiddleware, securityHeaders } = require('./middleware/security');
const { ImapIdleService } = require('./services/imapIdleService');
const { checkSchema } = require('./lib/schemaCheck');
const { renewExpiringWatches } = require('./services/googleAuthService');

const app = express();
const PORT = process.env.PORT || 5000;
const WATCH_RENEWAL_INTERVAL_MS = 6 * 60 * 60 * 1000;

app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : false);
app.use(securityHeaders);
app.use(corsMiddleware);
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: false, limit: '100kb' }));

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', gateway: 'UPI Flow Engine', timestamp: new Date().toISOString() });
});

app.use('/api/orders', orderRoutes);
app.use('/api/webhooks', webhookRoutes);
app.use('/api/merchant', merchantRoutes);
app.use('/api/auth', authRoutes);

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Malformed JSON and oversized bodies land here. Stack traces stay in the server log only.
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Request body must be valid JSON' });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request body is too large' });
  }
  console.error('[SERVER] Unhandled error:', err);
  return res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`UPI Flow backend listening on port ${PORT}`);
  checkSchema();

  // IMAP IDLE push daemon runs only when IMAP credentials are configured
  const imapService = new ImapIdleService();
  imapService.start();

  if (process.env.GOOGLE_PUBSUB_TOPIC) {
    renewExpiringWatches();
    setInterval(renewExpiringWatches, WATCH_RENEWAL_INTERVAL_MS).unref();
  }
});
