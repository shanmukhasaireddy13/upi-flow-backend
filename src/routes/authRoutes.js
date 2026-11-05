const express = require('express');
const router = express.Router();
const { authenticate, requireSession } = require('../middleware/authenticate');
const { createRateLimiter } = require('../lib/rateLimit');
const {
  merchantSignup,
  merchantLogin,
  getCurrentMerchant,
  getGoogleAuthUrl,
  handleGoogleCallback,
  renewGmailWatch
} = require('../controllers/authController');

const authLimiter = createRateLimiter({ name: 'auth', windowMs: 15 * 60 * 1000, max: 20 });

router.post('/signup', authLimiter, merchantSignup);
router.post('/login', authLimiter, merchantLogin);
router.get('/me', authenticate, requireSession, getCurrentMerchant);

router.get('/google/connect', authenticate, requireSession, getGoogleAuthUrl);
router.get('/google/callback', handleGoogleCallback);
router.post('/google/watch', authenticate, requireSession, renewGmailWatch);

module.exports = router;
