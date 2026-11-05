const { google } = require('googleapis');
const { supabase } = require('../config/supabase');
const { parseFamPayEmail } = require('./emailParser');
const { processIncomingPayment } = require('./matcher');
const { signToken } = require('../lib/session');
const { verifyReceiptSender } = require('../lib/receiptAuth');

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile'
];

/**
 * Returns a configured Google OAuth2 Client instance.
 */
function getOAuthClient(redirectUri = null) {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    redirectUri || process.env.GOOGLE_REDIRECT_URI
  );
}

/**
 * Generates the Google OAuth authorization URL. The redirect URI comes only from configuration,
 * and `state` is a signed token that binds the consent to one merchant.
 */
function generateAuthUrl(merchantId) {
  if (!merchantId) throw new Error('merchantId is required to start Google OAuth');
  const oauth2Client = getOAuthClient(process.env.GOOGLE_REDIRECT_URI);

  return oauth2Client.generateAuthUrl({
    access_type: 'offline', // Requests refresh_token
    prompt: 'consent',      // Forces consent to guarantee refresh_token
    scope: SCOPES,
    state: signToken({ mid: merchantId, purpose: 'google_oauth' }, 15 * 60 * 1000)
  });
}

/**
 * Handles OAuth callback, saves tokens, and sets up Gmail Pub/Sub watch.
 */
async function handleOAuthCallback(code, merchantId) {
  const oauth2Client = getOAuthClient(process.env.GOOGLE_REDIRECT_URI);
  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);

  // Fetch user profile info
  const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
  const userInfo = await oauth2.userinfo.get();
  const userEmail = userInfo.data.email;

  // Save tokens in Supabase
  const updateData = {
    google_access_token: tokens.access_token,
    google_email: userEmail,
    google_token_expiry: tokens.expiry_date
  };

  if (tokens.refresh_token) {
    updateData.google_refresh_token = tokens.refresh_token;
  }

  // Do not allow multiple accounts to use the same Google Gmail account
  const { data: existingGoogle } = await supabase
    .from('merchants')
    .select('id')
    .ilike('google_email', userEmail.toLowerCase())
    .neq('id', merchantId)
    .maybeSingle();

  if (existingGoogle) {
    throw new Error(`This Gmail account (${userEmail}) is already connected to another merchant account.`);
  }

  const { data: updatedMerchant, error } = await supabase
    .from('merchants')
    .update(updateData)
    .eq('id', merchantId)
    .select()
    .single();

  if (error) {
    console.error('[GOOGLE AUTH] Failed to save tokens to merchant:', error);
    throw new Error('Database error saving tokens: ' + error.message);
  }

  console.log(`[GOOGLE AUTH] ✅ Merchant ${updatedMerchant.name} linked to Google Email: ${userEmail}`);

  // Automatically activate Gmail Watch
  const watchResult = await activateGmailWatch(updatedMerchant);

  return {
    merchant: updatedMerchant,
    userEmail,
    watch: watchResult
  };
}

/**
 * Calls gmail.users.watch to start receiving real-time Pub/Sub push notifications.
 */
async function activateGmailWatch(merchant) {
  if (!merchant.google_refresh_token && !merchant.google_access_token) {
    throw new Error('Merchant has not linked Google OAuth.');
  }

  const oauth2Client = getOAuthClient();
  oauth2Client.setCredentials({
    refresh_token: merchant.google_refresh_token,
    access_token: merchant.google_access_token
  });

  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
  const topicName = process.env.GOOGLE_PUBSUB_TOPIC;
  if (!topicName) throw new Error('GOOGLE_PUBSUB_TOPIC is not configured');

  console.log(`[GMAIL WATCH] Activating watch for ${merchant.google_email} on topic: ${topicName}...`);

  const res = await gmail.users.watch({
    userId: 'me',
    requestBody: {
      topicName: topicName,
      labelIds: ['INBOX']
    }
  });

  // Save historyId and watch expiration timestamp
  await supabase
    .from('merchants')
    .update({
      gmail_history_id: res.data.historyId,
      gmail_watch_expiry: res.data.expiration
    })
    .eq('id', merchant.id);

  console.log(`[GMAIL WATCH] ✅ Watch active! HistoryId: ${res.data.historyId}, Expiration: ${res.data.expiration}`);
  return res.data;
}

/**
 * Gmail stops sending push notifications when a watch expires, after at most 7 days, and nothing reports it:
 * payments just stop confirming. This renews every watch that expires within the next two days.
 */
async function renewExpiringWatches() {
  const { data: merchants, error } = await supabase
    .from('merchants')
    .select('*')
    .not('google_refresh_token', 'is', null);

  if (error) {
    console.error('[GMAIL WATCH] Could not load merchants for renewal:', error.message);
    return;
  }

  const renewBefore = Date.now() + 2 * 24 * 60 * 60 * 1000;
  for (const merchant of merchants) {
    const expiry = Number(merchant.gmail_watch_expiry) || Date.parse(merchant.gmail_watch_expiry) || 0;
    if (expiry > renewBefore) continue;
    try {
      await activateGmailWatch(merchant);
    } catch (err) {
      console.error(`[GMAIL WATCH] Renewal failed for merchant ${merchant.id}:`, err.message);
    }
  }
}

/**
 * Helper to recursively decode Gmail message body parts (uses base64url).
 */
function extractBodyFromPayload(payload) {
  let text = '';

  if (payload.body && payload.body.data) {
    text += Buffer.from(payload.body.data, 'base64url').toString('utf8');
  }

  if (payload.parts && payload.parts.length > 0) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body && part.body.data) {
        text += '\n' + Buffer.from(part.body.data, 'base64url').toString('utf8');
      } else if (part.mimeType === 'text/html' && !text && part.body && part.body.data) {
        text += '\n' + Buffer.from(part.body.data, 'base64url').toString('utf8');
      } else if (part.parts) {
        text += extractBodyFromPayload(part);
      }
    }
  }

  return text;
}

/**
 * Triggered by Pub/Sub push notification ({ emailAddress, historyId }).
 * Automatically fetches new FamApp emails using merchant's OAuth tokens.
 */
async function processGmailPushNotification(emailAddress, historyId) {
  console.log(`[GMAIL SYNC] Checking new emails for ${emailAddress} (HistoryId: ${historyId})...`);

  // Look up merchant by google_email
  const { data: merchants, error } = await supabase
    .from('merchants')
    .select('*')
    .eq('google_email', emailAddress)
    .order('created_at', { ascending: false })
    .limit(1);

  if (error) {
    console.error('[GMAIL SYNC] Merchant lookup error:', error.message);
  }

  const merchant = merchants && merchants[0];
  if (error || !merchant || !merchant.google_refresh_token) {
    console.warn(`[GMAIL SYNC] No merchant found with Google Email: ${emailAddress}`);
    return;
  }

  // Check for active or recently created pending orders for this merchant in the last 15 minutes.
  // If no order was created, we never scan or import personal emails.
  const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const { data: pendingOrders, error: orderLookupErr } = await supabase
    .from('orders')
    .select('id, amount, created_at')
    .eq('merchant_id', merchant.id)
    // EXPIRED counts too: the checkout marks orders expired after 5 minutes, and a customer who paid
    // just after that must still be confirmed instead of losing their money to a skipped scan.
    .in('status', ['PENDING', 'EXPIRED'])
    .gte('created_at', fifteenMinutesAgo);

  if (orderLookupErr) {
    console.error('[GMAIL SYNC] Error checking active orders:', orderLookupErr.message);
  }

  if (!pendingOrders || pendingOrders.length === 0) {
    console.log(`[GMAIL SYNC] No active pending orders in the last 15 minutes for ${emailAddress}. Skipping inbox scan.`);
    return;
  }

  const earliestOrderTimeMs = Math.min(...pendingOrders.map((o) => new Date(o.created_at).getTime()));
  const afterEpochSec = Math.floor((earliestOrderTimeMs - 60 * 1000) / 1000);

  const oauth2Client = getOAuthClient();
  oauth2Client.setCredentials({
    refresh_token: merchant.google_refresh_token,
    access_token: merchant.google_access_token
  });

  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

  // Query only receipts that arrived after the earliest active order was created
  const listRes = await gmail.users.messages.list({
    userId: 'me',
    q: `from:famapp.in "successfully received" after:${afterEpochSec}`,
    maxResults: 25
  });

  const messages = listRes.data.messages || [];
  if (messages.length === 0) {
    console.log(`[GMAIL SYNC] No matching FamApp receipts found since ${new Date(earliestOrderTimeMs).toISOString()}.`);
    return;
  }

  console.log(`[GMAIL SYNC] Found ${messages.length} FamApp email(s) during active order window. Processing...`);

  for (const msg of messages) {
    const fullMsg = await gmail.users.messages.get({
      userId: 'me',
      id: msg.id,
      format: 'full'
    });

    // Check email arrival timestamp against order creation window
    const msgInternalDate = parseInt(fullMsg.data.internalDate, 10);
    if (!isNaN(msgInternalDate) && msgInternalDate < (earliestOrderTimeMs - 60 * 1000)) {
      console.log(`[GMAIL SYNC] Skipped email ${msg.id}: arrived at ${new Date(msgInternalDate).toISOString()} prior to active orders.`);
      continue;
    }

    const sender = verifyReceiptSender(fullMsg.data.payload.headers, { recipient: merchant.google_email });
    if (!sender.ok) {
      console.warn(`[GMAIL SYNC] Ignored message ${msg.id}: ${sender.reason}`);
      continue;
    }

    const bodyText = extractBodyFromPayload(fullMsg.data.payload);
    const parsedPayment = parseFamPayEmail(bodyText);

    if (parsedPayment) {
      // Amount pre-filter: only process if the receipt amount matches an active order
      const matchesAmount = pendingOrders.some((o) => parseFloat(o.amount) === parseFloat(parsedPayment.amount));
      if (!matchesAmount) {
        console.log(`[GMAIL SYNC] Skipped email ${msg.id}: amount ₹${parsedPayment.amount} does not match any active order.`);
        continue;
      }

      console.log(`[GMAIL SYNC] Parsed matching FamApp payment: ₹${parsedPayment.amount} (${parsedPayment.transactionId})`);
      const paidAt = isNaN(msgInternalDate) ? null : new Date(msgInternalDate);
      await processIncomingPayment(parsedPayment, bodyText, merchant.id, 'production', paidAt);
    }
  }
}

module.exports = {
  SCOPES,
  getOAuthClient,
  generateAuthUrl,
  handleOAuthCallback,
  activateGmailWatch,
  renewExpiringWatches,
  processGmailPushNotification
};
