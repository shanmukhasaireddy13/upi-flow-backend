const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/authenticate');
const { handleEmailWebhook, handlePubSubWebhook } = require('../controllers/webhookController');

// Google Cloud Pub/Sub push endpoint (authenticated with ?token=PUBSUB_VERIFICATION_TOKEN)
router.post('/gmail', handlePubSubWebhook);
router.post('/pubsub', handlePubSubWebhook);

// Inbound email from a trusted forwarder (authenticated with the x-gateway-secret header)
router.post('/email', handleEmailWebhook);
router.post('/fampay', handleEmailWebhook);

module.exports = router;
