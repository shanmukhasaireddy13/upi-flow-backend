const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/authenticate');
const { handleEmailWebhook, handleMockPayment, handlePubSubWebhook } = require('../controllers/webhookController');

// Google Cloud Pub/Sub push endpoint (authenticated with ?token=PUBSUB_VERIFICATION_TOKEN)
router.post('/gmail', handlePubSubWebhook);
router.post('/pubsub', handlePubSubWebhook);

// Inbound email from a trusted forwarder (authenticated with the x-gateway-secret header)
router.post('/email', handleEmailWebhook);
router.post('/fampay', handleEmailWebhook);

// Simulated receipt for development (ALLOW_SIMULATION=true only)
router.post('/mock-payment', authenticate, handleMockPayment);

module.exports = router;
