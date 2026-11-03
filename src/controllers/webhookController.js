const crypto = require('crypto');
const { parseFamPayEmail } = require('../services/emailParser');
const { processIncomingPayment } = require('../services/matcher');
const { supabase } = require('../config/supabase');
const { parseAmount } = require('../lib/validation');

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

async function resolveMerchantIdByEmail(email) {
  if (!email) return null;
  const clean = String(email).trim().toLowerCase();
  const { data } = await supabase
    .from('merchants')
    .select('id')
    .eq('google_email', clean)
    .order('created_at', { ascending: false })
    .limit(1);
  return data && data[0] ? data[0].id : null;
}

/**
 * Ingestion endpoint for a trusted forwarder (Cloudflare Email Worker or similar).
 * Requires GATEWAY_SECRET. If the secret is not configured, the endpoint is disabled.
 */
async function handleEmailWebhook(req, res) {
  try {
    const expectedSecret = process.env.GATEWAY_SECRET;
    if (!expectedSecret) {
      return res.status(503).json({ error: 'Email ingestion is not configured' });
    }

    const provided = req.headers['x-gateway-secret'] || req.headers['x-cloudflare-secret'];
    if (!safeEqual(provided, expectedSecret)) {
      return res.status(403).json({ error: 'Invalid gateway secret' });
    }

    const { rawEmail, text, body, parsedPayment, merchant_email, merchant_id } = req.body || {};
    const emailContent = rawEmail || text || body;
    const paymentData = parsedPayment || (emailContent ? parseFamPayEmail(emailContent) : null);

    if (!paymentData) {
      return res.status(400).json({ error: 'Unable to parse a FamApp payment from the request body' });
    }

    const merchantId = merchant_id || (await resolveMerchantIdByEmail(merchant_email));
    const result = await processIncomingPayment(paymentData, emailContent || null, merchantId);
    return res.status(200).json({ success: true, result });
  } catch (err) {
    console.error('[WEBHOOK] Email ingestion error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * Simulates a FamApp receipt for the signed-in merchant. Only available when ALLOW_SIMULATION=true,
 * so it cannot be used to mark real orders as paid in production.
 */
async function handleMockPayment(req, res) {
  try {
    const isDev = req.environment === 'dev';
    if (!isDev && process.env.ALLOW_SIMULATION !== 'true') {
      return res.status(403).json({ error: 'Simulation is disabled in production environment' });
    }

    const amount = parseAmount(req.body.amount);
    if (!amount) return res.status(400).json({ error: 'Amount must be between ₹1 and ₹1,00,000' });

    const merchant = req.merchant;
    const transactionId = `FMPIB${Math.floor(1000000000 + Math.random() * 9000000000)}`;
    const utr = `${Math.floor(100000000000 + Math.random() * 900000000000)}`;
    const sender = (typeof req.body.sender_name === 'string' && req.body.sender_name.trim()) || 'Developer Test User';
    const now = new Date();

    const emailText = [
      `Hey ${merchant.name},`,
      'You have successfully received',
      `₹${amount}`,
      `from ${sender}`,
      'Transaction ID :',
      transactionId,
      'Date :',
      `${now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })} IST, ${now.toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' })}`,
      'UTR :',
      utr,
      'Best, Fam.'
    ].join('\n');

    const parsed = parseFamPayEmail(emailText);
    const result = await processIncomingPayment(parsed, emailText, merchant.id, 'dev');
    return res.json({ success: true, environment: 'dev', simulated_payment: parsed, result });
  } catch (err) {
    console.error('[MOCK] Error simulating payment:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * Google Cloud Pub/Sub push endpoint. The subscription URL must include ?token=PUBSUB_VERIFICATION_TOKEN.
 * Requests without the token are rejected so nobody can inject payments.
 */
async function handlePubSubWebhook(req, res) {
  try {
    const expected = process.env.PUBSUB_VERIFICATION_TOKEN;
    const token = req.query.token;
    const isTokenValid = Boolean(token && expected && safeEqual(token, expected));

    if (!req.body || !req.body.message || !req.body.message.data) {
      return res.status(400).send('Bad Request: invalid Pub/Sub message');
    }

    const decoded = Buffer.from(req.body.message.data, 'base64').toString('utf8');

    let notification = null;
    try {
      notification = JSON.parse(decoded);
    } catch (err) {
      notification = null;
    }

    if (notification && notification.historyId && notification.emailAddress) {
      // Gmail push notification: { emailAddress, historyId }.
      // This is secure without a URL token because no payment data is accepted from the webhook:
      // the backend fetches the actual email directly via Google Gmail API using the merchant's stored OAuth token.
      console.log(`[PUBSUB] Received Gmail push notification for: ${notification.emailAddress} (HistoryId: ${notification.historyId})`);
      const merchantId = await resolveMerchantIdByEmail(notification.emailAddress);
      if (merchantId) {
        const { processGmailPushNotification } = require('../services/googleAuthService');
        processGmailPushNotification(notification.emailAddress, notification.historyId).catch((err) => {
          console.error('[PUBSUB] Gmail sync failed:', err.message);
        });
      } else {
        console.warn(`[PUBSUB] Gmail push for unknown mailbox ${notification.emailAddress} was ignored`);
      }
      return res.status(200).send('OK');
    }

    // If it is NOT a Gmail push notification (e.g. raw receipt payload), require valid token
    if (!isTokenValid) {
      console.warn('[PUBSUB] Rejected unauthenticated non-Gmail payload');
      return res.status(401).send('Unauthorized');
    }

    // Pasted or forwarded receipt text authenticated via token
    const parsed = parseFamPayEmail(decoded);
    if (parsed) {
      await processIncomingPayment(parsed, decoded, null);
    }

    // Acknowledge so Pub/Sub does not redeliver.
    return res.status(200).send('OK');
  } catch (err) {
    console.error('[PUBSUB] Error processing message:', err.message);
    return res.status(200).send('OK');
  }
}

module.exports = {
  handleEmailWebhook,
  handleMockPayment,
  handlePubSubWebhook
};
