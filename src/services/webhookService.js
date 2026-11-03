const crypto = require('crypto');
const { isSafeOutboundUrl } = require('../lib/validation');

/**
 * Signs a payload as HMAC-SHA256 over "<timestamp>.<body>".
 * Merchants should reject requests whose timestamp is more than a few minutes old (replay protection).
 */
function signPayload(secret, timestamp, bodyString) {
  return crypto.createHmac('sha256', secret).update(`${timestamp}.${bodyString}`).digest('hex');
}

function buildEnvelope(eventType, order) {
  return {
    id: `evt_${crypto.randomBytes(12).toString('base64url')}`,
    event: eventType,
    environment: order.environment || 'production',
    created_at: new Date().toISOString(),
    data: {
      order_id: order.id,
      amount: order.amount,
      currency: 'INR',
      customer_name: order.customer_name,
      customer_email: order.customer_email || null,
      status: order.status,
      transaction_id: order.transaction_id || null,
      utr: order.utr || null,
      success_url: order.success_url || null,
      cancel_url: order.cancel_url || null,
      metadata: order.metadata || {},
      environment: order.environment || 'production'
    }
  };
}

/**
 * Sends a signed event to the merchant's webhook URL. Returns the outcome so callers can report it.
 */
async function deliverWebhook(merchant, envelope, environment = 'production') {
  const isDev = environment === 'dev' || envelope?.environment === 'dev' || envelope?.data?.environment === 'dev';
  const targetUrl = isDev && merchant.test_webhook_url ? merchant.test_webhook_url : merchant.webhook_url;
  const targetSecret = isDev && merchant.test_webhook_secret ? merchant.test_webhook_secret : merchant.webhook_secret;

  if (!merchant || !targetUrl) {
    return { delivered: false, reason: 'No webhook URL configured' };
  }
  if (!isSafeOutboundUrl(targetUrl)) {
    return { delivered: false, reason: 'Webhook URL is not allowed' };
  }

  const bodyString = JSON.stringify(envelope);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = signPayload(targetSecret || merchant.webhook_secret, timestamp, bodyString);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch(targetUrl, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'Content-Type': 'application/json',
        'X-Gateway-Timestamp': timestamp,
        'X-Gateway-Signature': signature,
        'X-Gateway-Environment': isDev ? 'dev' : 'production',
        'User-Agent': 'UPIFlow-Webhook/1.0'
      },
      body: bodyString,
      signal: controller.signal
    });
    return { delivered: response.ok, status: response.status };
  } catch (err) {
    return { delivered: false, reason: err.name === 'AbortError' ? 'Timed out' : err.message };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Dispatches an order event (e.g. order.paid) to the merchant. Failures are logged, never thrown,
 * so a broken merchant endpoint cannot roll back a payment that was already reconciled.
 */
async function dispatchMerchantWebhook(merchant, eventType, order) {
  const result = await deliverWebhook(merchant, buildEnvelope(eventType, order), order.environment || 'production');
  if (result.delivered) {
    console.log(`[WEBHOOK] ${eventType} for ${order.id} delivered (HTTP ${result.status})`);
  } else {
    console.error(`[WEBHOOK] ${eventType} for ${order.id} not delivered: ${result.reason || result.status}`);
  }
  return result;
}

/**
 * Sends a test event so merchants can verify their endpoint and signature check.
 */
async function sendTestWebhook(merchant, environment = 'production') {
  const envelope = {
    id: `evt_${crypto.randomBytes(12).toString('base64url')}`,
    event: 'webhook.test',
    environment,
    created_at: new Date().toISOString(),
    data: {
      message: 'This is a test event from UPI Flow.',
      environment
    }
  };
  return deliverWebhook(merchant, envelope, environment);
}

module.exports = { dispatchMerchantWebhook, sendTestWebhook, signPayload };
