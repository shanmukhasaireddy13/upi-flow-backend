const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/authenticate');
const { createRateLimiter } = require('../lib/rateLimit');
const {
  createOrder,
  getOrderStatus,
  verifyUtrFallback,
  listOrders
} = require('../controllers/orderController');

const createLimiter = createRateLimiter({ name: 'order-create', windowMs: 60 * 1000, max: 60 });
const statusLimiter = createRateLimiter({ name: 'order-status', windowMs: 60 * 1000, max: 240 });
const verifyLimiter = createRateLimiter({ name: 'order-verify', windowMs: 60 * 1000, max: 15 });
// Per order as well, so guessing UTRs against one order does not get easier with many IP addresses.
const verifyOrderLimiter = createRateLimiter({
  name: 'order-verify-order',
  windowMs: 10 * 60 * 1000,
  max: 20,
  keyFrom: (req) => String(req.body.order_id).slice(0, 80)
});

router.post('/create', createLimiter, authenticate, createOrder);
router.post('/', createLimiter, authenticate, createOrder);
router.get('/list', authenticate, listOrders);
// Public, read-only status for the hosted checkout page. Order IDs are unguessable.
router.get('/status/:id', statusLimiter, getOrderStatus);
router.get('/:id', statusLimiter, getOrderStatus);
router.post('/verify-utr', verifyLimiter, verifyOrderLimiter, verifyUtrFallback);

module.exports = router;
