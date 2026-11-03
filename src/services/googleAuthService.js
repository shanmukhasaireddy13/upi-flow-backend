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

  // Ensure this google_email is not held by another merchant
  await supabase
    .from('merchants')
    .update({ google_email: null, google_access_token: null, google_refresh_token: null })
    .eq('google_email', userEmail)
    .neq('id', merchantId);

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

  const oauth2Client = getOAuthClient();
  oauth2Client.setCredentials({
    refresh_token: merchant.google_refresh_token,
    access_token: merchant.google_access_token
  });

  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

  // Query recent FamApp receipts. The search only narrows the list; each message is still
  // checked for a DKIM/DMARC pass below, because the From header alone can be forged.
  const listRes = await gmail.users.messages.list({
    userId: 'me',
    q: 'from:famapp.in "successfully received"',
    maxResults: 10
  });

  const messages = listRes.data.messages || [];
  if (messages.length === 0) {
    console.log(`[GMAIL SYNC] No matching FamApp emails found for ${emailAddress}.`);
    return;
  }

  console.log(`[GMAIL SYNC] Found ${messages.length} recent FamApp email(s). Processing...`);

  for (const msg of messages) {
    const fullMsg = await gmail.users.messages.get({
      userId: 'me',
      id: msg.id,
      format: 'full'
    });

    const sender = verifyReceiptSender(fullMsg.data.payload.headers);
    if (!sender.ok) {
      console.warn(`[GMAIL SYNC] Ignored message ${msg.id}: ${sender.reason}`);
      continue;
    }

    const bodyText = extractBodyFromPayload(fullMsg.data.payload);
    const parsedPayment = parseFamPayEmail(bodyText);

    if (parsedPayment) {
      console.log(`[GMAIL SYNC] Parsed FamApp payment: ₹${parsedPayment.amount} (${parsedPayment.transactionId})`);
      await processIncomingPayment(parsedPayment, bodyText, merchant.id);
    }
  }
}

module.exports = {
  SCOPES,
  getOAuthClient,
  generateAuthUrl,
  handleOAuthCallback,
  activateGmailWatch,
  processGmailPushNotification
};
