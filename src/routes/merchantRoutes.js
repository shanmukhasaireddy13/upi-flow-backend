const express = require('express');
const router = express.Router();
const { authenticate, requireSession } = require('../middleware/authenticate');
const { createRateLimiter } = require('../lib/rateLimit');
const {
  getMerchantProfile,
  getOnboarding,
  updateMerchantSettings,
  rotateApiKey,
  rotateWebhookSecret,
  sendWebhookTest,
  getLedger
} = require('../controllers/merchantController');

const sensitiveLimiter = createRateLimiter({ name: 'merchant-sensitive', windowMs: 60 * 1000, max: 10 });

router.use(authenticate, requireSession);

router.get('/profile', getMerchantProfile);
router.get('/onboarding', getOnboarding);
router.post('/settings', updateMerchantSettings);
router.get('/ledger', getLedger);
router.post('/rotate-api-key', sensitiveLimiter, rotateApiKey);
router.post('/rotate-webhook-secret', sensitiveLimiter, rotateWebhookSecret);
router.post('/webhook-test', sensitiveLimiter, sendWebhookTest);

module.exports = router;
