const crypto = require('crypto');
const { supabase } = require('../config/supabase');
const { sendTestWebhook } = require('../services/webhookService');
const { publicMerchant } = require('./authController');
const {
  parseString,
  isVpa,
  isFamPayVpa,
  isHexColor,
  isSafeOutboundUrl,
  isEmail
} = require('../lib/validation');

/**
 * Merchant profile, including the credentials shown on the developers page.
 * Only the signed-in merchant can read these.
 */
async function getMerchantProfile(req, res) {
  try {
    const merchant = req.merchant;
    const env = 'production';

    const { data: orders, error } = await supabase
      .from('orders')
      .select('amount, status')
      .eq('merchant_id', merchant.id);

    if (error) {
      return res.status(500).json({ error: 'Could not load metrics' });
    }

    const totalOrders = orders.length;
    const paid = orders.filter((o) => o.status === 'PAID');
    const totalVolume = paid.reduce((sum, o) => sum + Number(o.amount), 0);
    const successRate = totalOrders > 0 ? ((paid.length / totalOrders) * 100).toFixed(1) : '100.0';

    return res.json({
      environment: env,
      merchant: {
        ...publicMerchant(merchant),
        api_key: merchant.api_key,
        webhook_secret: merchant.webhook_secret
      },
      metrics: {
        total_volume: totalVolume.toFixed(2),
        total_orders: totalOrders,
        successful_orders: paid.length,
        success_rate: `${successRate}%`
      }
    });
  } catch (err) {
    console.error('[MERCHANT] Profile error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * Setup progress, derived from stored data. The dashboard uses this to guide new merchants.
 * Required steps must be done before payments can be verified automatically.
 */
async function getOnboarding(req, res) {
  try {
    const merchant = req.merchant;
    const { count: paidCount, error } = await supabase
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .eq('merchant_id', merchant.id)
      .eq('status', 'PAID');
    if (error) return res.status(500).json({ error: 'Could not check setup progress' });

    const step1Done = Boolean(
      merchant.upi_id &&
      merchant.upi_name &&
      String(merchant.upi_id).trim().toLowerCase().endsWith('@fam')
    );
    const step2Done = Boolean(merchant.google_email);
    const step3Done = Boolean(merchant.webhook_url);
    const step4Done = (paidCount || 0) > 0;

    const steps = [
      {
        key: 'receiving_account',
        label: 'Add your FamPay UPI ID',
        description: 'Customer money is sent to this UPI ID. Must end with @fam.',
        required: true,
        done: step1Done
      },
      {
        key: 'gmail',
        label: 'Connect the Gmail that receives FamApp emails',
        description: 'UPI Flow reads payment receipts in this inbox to confirm orders. Only receipt emails are read.',
        required: true,
        done: step2Done
      },
      {
        key: 'webhook',
        label: 'Add a webhook URL (optional)',
        description: 'Your server gets a signed event when an order is paid. Skip this if you check orders from the dashboard.',
        required: false,
        done: step3Done
      },
      {
        key: 'first_payment',
        label: 'Receive your first payment (optional)',
        description: 'Create a test order and pay it from your phone to confirm the whole flow works.',
        required: false,
        done: step4Done
      }
    ];

    const completed = Boolean(merchant.onboarding_completed || (step1Done && step2Done));
    let nextStep = null;
    if (!step1Done) {
      nextStep = 'receiving_account';
    } else if (!step2Done) {
      nextStep = 'gmail';
    } else if (!step3Done) {
      nextStep = 'webhook';
    } else if (!step4Done) {
      nextStep = 'first_payment';
    }

    return res.json({
      completed,
      next_step: nextStep,
      steps
    });
  } catch (err) {
    console.error('[MERCHANT] Onboarding error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * Updates merchant settings. Every field is validated before it is written.
 */
async function updateMerchantSettings(req, res) {
  try {
    const body = req.body || {};
    const updates = {};
    const errors = [];

    const set = (field, value, message) => {
      if (value === null) errors.push(message);
      else updates[field] = value;
    };

    if (body.name !== undefined) set('name', parseString(body.name, 120), 'Business name must be 1 to 120 characters');
    if (body.upi_id !== undefined) {
      const upi = String(body.upi_id || '').trim();
      if (!upi || !isFamPayVpa(upi)) {
        errors.push('Enter a valid FamPay UPI ID ending with @fam, for example yourhandle@fam');
      } else {
        if (upi.toLowerCase() !== String(req.merchant.upi_id || '').toLowerCase()) {
          const { data: existingUpi } = await supabase
            .from('merchants')
            .select('id')
            .ilike('upi_id', upi.toLowerCase())
            .neq('id', req.merchant.id)
            .maybeSingle();
          if (existingUpi) {
            errors.push('This FamPay UPI ID is already linked to another merchant account.');
          }
        }
        updates.upi_id = upi;
      }
    }
    if (body.upi_name !== undefined) set('upi_name', parseString(body.upi_name, 120), 'Payee name must be 1 to 120 characters');
    if (body.brand_color !== undefined) {
      if (!isHexColor(body.brand_color)) errors.push('Brand color must be a hex value like #0052ff');
      else updates.brand_color = body.brand_color.toLowerCase();
    }
    if (body.webhook_url !== undefined) {
      const url = body.webhook_url ? String(body.webhook_url).trim() : '';
      if (!url) updates.webhook_url = null;
      else if (!isSafeOutboundUrl(url)) errors.push('Webhook URL must be an https:// address on a public host');
      else updates.webhook_url = url;
    }
    if (body.test_webhook_url !== undefined) {
      const url = body.test_webhook_url ? String(body.test_webhook_url).trim() : '';
      if (!url) updates.test_webhook_url = null;
      else if (!isSafeOutboundUrl(url)) errors.push('Test Webhook URL must be an https:// or http:// address');
      else updates.test_webhook_url = url;
    }
    if (body.logo_url !== undefined) {
      const url = body.logo_url ? String(body.logo_url).trim() : '';
      if (url && !isSafeOutboundUrl(url)) errors.push('Logo URL must be an https:// address');
      else updates.logo_url = url;
    }
    if (body.checkout_title !== undefined) set('checkout_title', parseString(body.checkout_title, 80, { optional: true }), 'Checkout heading is at most 80 characters');
    if (body.checkout_subtitle !== undefined) set('checkout_subtitle', parseString(body.checkout_subtitle, 120, { optional: true }), 'Checkout subtitle is at most 120 characters');
    if (body.support_contact !== undefined) {
      const contact = parseString(body.support_contact, 120, { optional: true });
      if (contact === null || (contact && contact.includes('@') && !isEmail(contact))) {
        errors.push('Support contact must be an email address or a phone number');
      } else {
        updates.support_contact = contact;
      }
    }

    const effectiveUpi = updates.upi_id !== undefined ? updates.upi_id : req.merchant.upi_id;
    const effectiveUpiName = updates.upi_name !== undefined ? updates.upi_name : req.merchant.upi_name;
    const effectiveEmail = req.merchant.google_email;

    const step1Done = Boolean(effectiveUpi && effectiveUpiName && String(effectiveUpi).toLowerCase().endsWith('@fam'));
    const step2Done = Boolean(effectiveEmail);

    if (body.onboarding_completed !== undefined) {
      updates.onboarding_completed = Boolean(body.onboarding_completed && step1Done && step2Done);
    } else if (step1Done && step2Done) {
      updates.onboarding_completed = true;
    }

    if (errors.length > 0) {
      return res.status(400).json({ error: errors[0], errors });
    }
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    const { data: updated, error } = await supabase
      .from('merchants')
      .update(updates)
      .eq('id', req.merchant.id)
      .select()
      .single();

    if (error) {
      console.error('[MERCHANT] Settings update error:', error.message);
      return res.status(400).json({ error: 'Could not save settings' });
    }

    return res.json({ success: true, merchant: publicMerchant(updated) });
  } catch (err) {
    console.error('[MERCHANT] Settings error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * Issues a new API key. The old key stops working immediately.
 */
async function rotateApiKey(req, res) {
  const apiKey = `sk_live_${crypto.randomBytes(24).toString('base64url')}`;
  const { error } = await supabase.from('merchants').update({ api_key: apiKey }).eq('id', req.merchant.id);
  if (error) return res.status(500).json({ error: 'Could not rotate the API key' });
  return res.json({ success: true, api_key: apiKey, environment: 'production' });
}

/**
 * Issues a new webhook signing secret. Merchants must update their verifier before the next event.
 */
async function rotateWebhookSecret(req, res) {
  const secret = `whsec_live_${crypto.randomBytes(24).toString('base64url')}`;
  const { error } = await supabase.from('merchants').update({ webhook_secret: secret }).eq('id', req.merchant.id);
  if (error) return res.status(500).json({ error: 'Could not rotate the webhook secret' });
  return res.json({ success: true, webhook_secret: secret, environment: 'production' });
}

/**
 * Sends a signed test event to the configured webhook URL.
 */
async function sendWebhookTest(req, res) {
  const result = await sendTestWebhook(req.merchant, 'production');
  if (result.delivered) {
    return res.json({ success: true, status: result.status, environment: 'production' });
  }
  return res.status(502).json({
    success: false,
    error: result.reason || `Endpoint responded with HTTP ${result.status}`,
    status: result.status || null,
    environment: 'production'
  });
}

/**
 * Payments received for this merchant. Scoped to the signed-in merchant only.
 */
async function getLedger(req, res) {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);

    const { data: ledger, error } = await supabase
      .from('fampay_ledger')
      .select('transaction_id, utr, amount, sender_name, raw_date, updated_balance, claimed, received_at, environment')
      .eq('merchant_id', req.merchant.id)
      .order('received_at', { ascending: false })
      .limit(limit);

    if (error) {
      console.error('[MERCHANT] Ledger error:', error.message);
      return res.status(500).json({ error: 'Could not load payments' });
    }

    return res.json({ ledger });
  } catch (err) {
    return res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = {
  getMerchantProfile,
  getOnboarding,
  updateMerchantSettings,
  rotateApiKey,
  rotateWebhookSecret,
  sendWebhookTest,
  getLedger
};
