const crypto = require('crypto');
const { isSafeOutboundUrl, resolvesToPublicAddress } = require('../lib/validation');

const RETRY_DELAYS_MS = [30 * 1000, 5 * 60 * 1000, 30 * 60 * 1000];

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
    return { delivered: false, retryable: false, reason: 'No webhook URL configured' };
  }
  if (!isSafeOutboundUrl(targetUrl) || !(await resolvesToPublicAddress(targetUrl))) {
    return { delivered: false, retryable: false, reason: 'Webhook URL is not allowed' };
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
    // Connection details stay in the log: returning them would let merchants probe the network from here.
    console.error('[WEBHOOK] Delivery error:', err.message);
    return { delivered: false, reason: err.name === 'AbortError' ? 'Timed out' : 'Could not connect to the webhook URL' };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Dispatches an order event (e.g. order.paid) to the merchant. Failures are logged, never thrown,
 * so a broken merchant endpoint cannot roll back a payment that was already reconciled.
 * Failed deliveries are retried with the same event id, so merchants can de-duplicate on it.
 * Retries live in memory: a restart drops them, and merchants can still poll the order status.
 */
async function dispatchMerchantWebhook(merchant, eventType, order, envelope = buildEnvelope(eventType, order), attempt = 0) {
  const result = await deliverWebhook(merchant, envelope, order.environment || 'production');
  if (result.delivered) {
    console.log(`[WEBHOOK] ${eventType} for ${order.id} delivered (HTTP ${result.status})`);
    return result;
  }

  console.error(`[WEBHOOK] ${eventType} for ${order.id} not delivered (attempt ${attempt + 1}): ${result.reason || result.status}`);
  if (result.retryable !== false && attempt < RETRY_DELAYS_MS.length) {
    setTimeout(() => {
      dispatchMerchantWebhook(merchant, eventType, order, envelope, attempt + 1).catch((err) => {
        console.error(`[WEBHOOK] Retry for ${order.id} failed:`, err.message);
      });
    }, RETRY_DELAYS_MS[attempt]).unref();
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
