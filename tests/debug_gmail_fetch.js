const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { google } = require('googleapis');
const { supabase } = require('../src/config/supabase');
const { getOAuthClient } = require('../src/services/googleAuthService');
const { parseFamPayEmail } = require('../src/services/emailParser');

async function testGmailFetch() {
  const { data: merchant } = await supabase
    .from('merchants')
    .select('*')
    .not('google_refresh_token', 'is', null)
    .limit(1)
    .single();

  if (!merchant || !merchant.google_refresh_token) {
    console.error('No merchant with refresh token found!');
    return;
  }

  const oauth2Client = getOAuthClient();
  oauth2Client.setCredentials({
    refresh_token: merchant.google_refresh_token,
    access_token: merchant.google_access_token
  });

  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

  const listRes = await gmail.users.messages.list({
    userId: 'me',
    q: '"successfully received" "Transaction ID"',
    maxResults: 1
  });

  if (!listRes.data.messages || listRes.data.messages.length === 0) {
    console.log('No messages found');
    return;
  }

  const msgId = listRes.data.messages[0].id;
  const fullMsg = await gmail.users.messages.get({
    userId: 'me',
    id: msgId,
    format: 'full'
  });

  console.log('Snippet:', fullMsg.data.snippet);
  console.log('Payload mimeType:', fullMsg.data.payload.mimeType);

  function decode(payload) {
    let text = '';
    if (payload.body && payload.body.data) {
      text += Buffer.from(payload.body.data, 'base64url').toString('utf8');
    }
    if (payload.parts) {
      for (const p of payload.parts) {
        if (p.body && p.body.data) {
          text += '\n--- PART ' + p.mimeType + ' ---\n';
          text += Buffer.from(p.body.data, 'base64url').toString('utf8');
        }
        if (p.parts) {
          text += decode(p);
        }
      }
    }
    return text;
  }

  const rawDecoded = decode(fullMsg.data.payload);
  console.log('\n--- RAW DECODED PREVIEW (first 500 chars) ---\n', rawDecoded.substring(0, 500));

  const parsed = parseFamPayEmail(rawDecoded);
  console.log('\n--- PARSED RESULT ---\n', parsed);
}

testGmailFetch().catch(console.error);
