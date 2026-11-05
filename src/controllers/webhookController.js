const crypto = require('crypto');
const { OAuth2Client } = require('google-auth-library');
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

// A forwarder may send an already parsed payment. It is authenticated, but its fields are still checked.
function normalizeForwardedPayment(payment) {
  const amount = parseAmount(payment && payment.amount);
  const transactionId = payment && payment.transactionId;
  if (!amount || typeof transactionId !== 'string' || !/^[A-Za-z0-9]{6,64}$/.test(transactionId)) return null;
  if (payment.utr && !/^\d{12}$/.test(String(payment.utr))) return null;
  return {
    amount: Number(amount),
    transactionId,
    utr: payment.utr ? String(payment.utr) : null,
    senderName: typeof payment.senderName === 'string' ? payment.senderName.slice(0, 120) : null,
    dateRaw: typeof payment.dateRaw === 'string' ? payment.dateRaw.slice(0, 80) : null,
    updatedBalance: Number.isFinite(payment.updatedBalance) ? payment.updatedBalance : null
  };
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
    const paymentData = parsedPayment
      ? normalizeForwardedPayment(parsedPayment)
      : (typeof emailContent === 'string' ? parseFamPayEmail(emailContent) : null);

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

const oidcClient = new OAuth2Client();

/**
 * A push request is genuine when it carries ?token=PUBSUB_VERIFICATION_TOKEN, or a Google-signed OIDC
 * token for PUBSUB_AUDIENCE issued to PUBSUB_SERVICE_ACCOUNT (authenticated push subscriptions).
 */
async function isPubSubRequestAuthorized(req) {
  const expected = process.env.PUBSUB_VERIFICATION_TOKEN;
  if (req.query.token && expected && safeEqual(req.query.token, expected)) return true;

  const audience = process.env.PUBSUB_AUDIENCE;
  const serviceAccount = process.env.PUBSUB_SERVICE_ACCOUNT;
  const authHeader = req.headers.authorization || '';
  if (!audience || !serviceAccount || !/^Bearer\s+/i.test(authHeader)) return false;

  try {
    const ticket = await oidcClient.verifyIdToken({
      idToken: authHeader.replace(/^Bearer\s+/i, '').trim(),
      audience
    });
    const payload = ticket.getPayload() || {};
    return payload.email === serviceAccount && payload.email_verified === true;
  } catch (err) {
    return false;
  }
}

/**
 * Google Cloud Pub/Sub push endpoint. Every request must be authenticated (see isPubSubRequestAuthorized),
 * otherwise anyone could trigger Gmail syncs for any merchant or inject receipt text.
 */
async function handlePubSubWebhook(req, res) {
  try {
    if (!(await isPubSubRequestAuthorized(req))) {
      console.warn('[PUBSUB] Rejected unauthenticated push request');
      return res.status(401).send('Unauthorized');
    }

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
      // Gmail push notification: { emailAddress, historyId }. No payment data is taken from it:
      // the backend fetches the emails itself with the merchant's OAuth token and checks their DKIM.
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
