const crypto = require('crypto');
const {
  generateAuthUrl,
  handleOAuthCallback,
  activateGmailWatch
} = require('../services/googleAuthService');
const { supabase } = require('../config/supabase');
const { hashPassword, verifyPassword, needsRehash } = require('../lib/password');
const { signToken, verifyToken } = require('../lib/session');
const { parseString, isEmail, isVpa, isFamPayVpa } = require('../lib/validation');

const MIN_PASSWORD_LENGTH = 8;
const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));

// Fields that are safe to return to the browser after login.
function publicMerchant(m) {
  return {
    id: m.id,
    name: m.name,
    email: m.email,
    upi_id: m.upi_id,
    upi_name: m.upi_name,
    brand_color: m.brand_color || '#0052ff',
    logo_url: m.logo_url || '',
    checkout_title: m.checkout_title || '',
    checkout_subtitle: m.checkout_subtitle || '',
    support_contact: m.support_contact || '',
    webhook_url: m.webhook_url || null,
    google_email: m.google_email || null,
    gmail_watch_expiry: m.gmail_watch_expiry || null,
    onboarding_completed: Boolean(
      m.onboarding_completed ||
      (m.upi_id && m.upi_name && m.upi_id.toLowerCase().endsWith('@fam') && m.google_email)
    ),
    created_at: m.created_at
  };
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Merchant signup.
 */
async function merchantSignup(req, res) {
  try {
    const name = parseString(req.body.name, 120);
    const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const password = req.body.password;
    const upiId = (req.body.upi_id || req.body.upiId) ? String(req.body.upi_id || req.body.upiId).trim() : '';

    if (!name) return res.status(400).json({ error: 'Business name is required (max 120 characters)' });
    if (!isEmail(email)) return res.status(400).json({ error: 'Enter a valid email address' });
    if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH || password.length > 200) {
      return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
    }
    if (upiId && !isFamPayVpa(upiId)) return res.status(400).json({ error: 'Enter a valid FamPay UPI ID ending with @fam, for example yourhandle@fam' });

    const { data: existing } = await supabase
      .from('merchants')
      .select('id')
      .eq('email', email)
      .maybeSingle();

    if (existing) {
      return res.status(409).json({ error: 'An account with this email already exists. Please sign in.' });
    }

    const { data: merchant, error } = await supabase
      .from('merchants')
      .insert({
        name,
        email,
        api_key: `sk_live_${crypto.randomBytes(24).toString('base64url')}`,
        test_api_key: `sk_test_${crypto.randomBytes(24).toString('base64url')}`,
        webhook_secret: `whsec_${crypto.randomBytes(24).toString('base64url')}`,
        test_webhook_secret: `whsec_test_${crypto.randomBytes(24).toString('base64url')}`,
        password_hash: hashPassword(password),
        upi_id: upiId || null,
        upi_name: upiId ? name : null,
        onboarding_completed: false,
        brand_color: '#0052ff',
        checkout_title: `Pay ${name}`,
        checkout_subtitle: 'Scan with any UPI app to pay'
      })
      .select()
      .single();

    if (error) {
      console.error('[AUTH] Signup insert error:', error.message);
      return res.status(500).json({ error: 'Could not create the account. Please try again.' });
    }

    return res.status(201).json({
      success: true,
      token: signToken({ mid: merchant.id }),
      merchant: publicMerchant(merchant)
    });
  } catch (err) {
    console.error('[AUTH] Signup error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * Merchant login with email and password. Returns a session token.
 */
async function merchantLogin(req, res) {
  try {
    const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const password = typeof req.body.password === 'string' ? req.body.password : '';

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const { data: merchant } = await supabase
      .from('merchants')
      .select('*')
      .eq('email', email)
      .maybeSingle();

    // Always run one hash comparison so response timing does not reveal which emails exist.
    const storedHash = merchant ? merchant.password_hash : DUMMY_HASH;
    const valid = verifyPassword(password, storedHash);

    if (!merchant || !merchant.password_hash || !valid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    if (needsRehash(merchant.password_hash)) {
      await supabase
        .from('merchants')
        .update({ password_hash: hashPassword(password) })
        .eq('id', merchant.id);
    }

    return res.json({
      success: true,
      token: signToken({ mid: merchant.id }),
      merchant: publicMerchant(merchant)
    });
  } catch (err) {
    console.error('[AUTH] Login error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * Returns the signed-in merchant. Requires authenticate middleware.
 */
function getCurrentMerchant(req, res) {
  return res.json({ success: true, merchant: publicMerchant(req.merchant) });
}

/**
 * Starts Google OAuth for the signed-in merchant and returns the consent URL.
 */
function getGoogleAuthUrl(req, res) {
  try {
    const url = generateAuthUrl(req.merchant.id);
    return res.json({ url });
  } catch (err) {
    console.error('[AUTH CONTROLLER] Error generating auth URL:', err.message);
    return res.status(500).json({ error: 'Google sign-in is not configured on the server' });
  }
}

/**
 * Google OAuth callback. The merchant comes from the signed `state`, never from the query string.
 */
async function handleGoogleCallback(req, res) {
  const page = (title, message, ok) => `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title></head>
<body style="font-family:system-ui,sans-serif;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f8fafc;color:#0f172a">
<main style="max-width:420px;padding:32px;background:#fff;border:1px solid #e2e8f0;border-radius:12px">
<h1 style="font-size:20px;font-weight:600;margin:0 0 8px">${escapeHtml(title)}</h1>
<p style="font-size:14px;color:#475569;line-height:1.5;margin:0 0 20px">${escapeHtml(message)}</p>
<button onclick="window.close()" style="font:inherit;font-size:14px;padding:10px 16px;border-radius:8px;border:0;background:${ok ? '#0052ff' : '#334155'};color:#fff;cursor:pointer">Close window</button>
</main></body></html>`;

  try {
    const { code, state, error } = req.query;
    if (error) {
      return res.status(400).send(page('Google sign-in cancelled', 'No Gmail account was connected.', false));
    }

    const claims = verifyToken(state);
    if (!claims || claims.purpose !== 'google_oauth' || !claims.mid || typeof code !== 'string') {
      return res.status(400).send(page('Link expired', 'Start the Gmail connection again from the dashboard.', false));
    }

    const result = await handleOAuthCallback(code, claims.mid);

    return res.send(page(
      'Gmail connected',
      `Your Gmail account (${result.userEmail}) is linked to UPI Flow. Incoming FamApp receipts will now verify orders.`,
      true
    ));
  } catch (err) {
    console.error('[AUTH CONTROLLER] Callback error:', err.message);
    return res.status(500).send(page('Connection failed', 'We could not finish connecting Gmail. Try again.', false));
  }
}

/**
 * Renews the Gmail watch for the signed-in merchant.
 */
async function renewGmailWatch(req, res) {
  try {
    const watch = await activateGmailWatch(req.merchant);
    return res.json({ success: true, watch });
  } catch (err) {
    console.error('[AUTH] Gmail watch renewal failed:', err.message);
    return res.status(400).json({ error: 'Could not renew the Gmail watch. Reconnect Gmail and try again.' });
  }
}

module.exports = {
  publicMerchant,
  merchantSignup,
  merchantLogin,
  getCurrentMerchant,
  getGoogleAuthUrl,
  handleGoogleCallback,
  renewGmailWatch
};
