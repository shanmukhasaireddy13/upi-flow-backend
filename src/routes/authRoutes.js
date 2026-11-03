const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/authenticate');
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
router.get('/me', authenticate, getCurrentMerchant);

router.get('/google/connect', authenticate, getGoogleAuthUrl);
router.get('/google/callback', handleGoogleCallback);
router.post('/google/watch', authenticate, renewGmailWatch);

module.exports = router;
