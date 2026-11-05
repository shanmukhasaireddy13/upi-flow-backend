// Run this against real FamApp receipts to confirm the sender checks accept them. It reads the last few
// FamApp emails in the merchant's Gmail and prints only pass/fail. Nothing is changed.
// Usage: node tests/check_receipt_headers.js merchant-gmail@example.com
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { google } = require('googleapis');
const { supabase } = require('../src/config/supabase');
const { getOAuthClient } = require('../src/services/googleAuthService');
const { verifyReceiptSender } = require('../src/lib/receiptAuth');

async function main() {
  const email = process.argv[2];
  if (!email) throw new Error('Pass the merchant Gmail address as the first argument');

  const { data: merchant } = await supabase
    .from('merchants')
    .select('google_email, google_refresh_token, google_access_token')
    .eq('google_email', email)
    .maybeSingle();
  if (!merchant || !merchant.google_refresh_token) throw new Error(`No connected merchant for ${email}`);

  const auth = getOAuthClient();
  auth.setCredentials({ refresh_token: merchant.google_refresh_token, access_token: merchant.google_access_token });
  const gmail = google.gmail({ version: 'v1', auth });

  const { data } = await gmail.users.messages.list({ userId: 'me', q: 'from:famapp.in "successfully received"', maxResults: 5 });
  for (const { id } of data.messages || []) {
    const { data: msg } = await gmail.users.messages.get({ userId: 'me', id, format: 'metadata' });
    const result = verifyReceiptSender(msg.payload.headers, { recipient: merchant.google_email });
    console.log(id, result.ok ? 'ACCEPTED' : `REJECTED: ${result.reason}`);
  }
  if (!(data.messages || []).length) console.log('No FamApp receipts found.');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
