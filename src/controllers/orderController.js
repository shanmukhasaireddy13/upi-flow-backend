const crypto = require('crypto');
const QRCode = require('qrcode');
const { supabase } = require('../config/supabase');
const { verifyOrderByUtrOrTxnId } = require('../services/matcher');
const { parseAmount, parseString, parseMetadata, isEmail, isOrderId, isValidRedirectUrl, isFamPayVpa } = require('../lib/validation');

const ORDER_TTL_MS = 5 * 60 * 1000;
const CHECKOUT_BASE_URL = (process.env.CHECKOUT_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

function buildUpiUri(upiId, payeeName, amount) {
  return `upi://pay?pa=${encodeURIComponent(upiId)}&pn=${encodeURIComponent(payeeName)}&am=${Number(amount).toFixed(2)}&cu=INR`;
}

function qrOptions() {
  return { width: 320, margin: 2, color: { dark: '#0a0b0d', light: '#ffffff' } };
}

function resolveRedirectUrl(url, orderId) {
  if (!url) return null;
  return url.replace(/\{ORDER_ID\}/g, orderId).replace(/\{CHECKOUT_SESSION_ID\}/g, orderId);
}

async function sendCreatedOrder(res, httpStatus, order, merchant) {
  const upiUri = buildUpiUri(merchant.upi_id, merchant.upi_name || merchant.name, order.amount);
  return res.status(httpStatus).json({
    order_id: order.id,
    amount: order.amount,
    currency: 'INR',
    customer_name: order.customer_name,
    status: order.status,
    expires_at: order.expires_at,
    environment: order.environment,
    upi_uri: upiUri,
    qr_code: await QRCode.toDataURL(upiUri, qrOptions()),
    checkout_url: `${CHECKOUT_BASE_URL}/checkout/${order.id}`,
    success_url: resolveRedirectUrl(order.success_url, order.id),
    cancel_url: order.cancel_url,
    metadata: order.metadata || {}
  });
}

function findOrderByIdempotencyKey(merchantId, key) {
  return supabase
    .from('orders')
    .select('*')
    .eq('merchant_id', merchantId)
    .eq('idempotency_key', key)
    .maybeSingle();
}

/**
 * Creates a payment order for the authenticated merchant and returns its UPI QR code.
 * With an Idempotency-Key header, retrying a request returns the first order instead of creating another.
 */
async function createOrder(req, res) {
  try {
    const merchant = req.merchant;

    const amount = parseAmount(req.body.amount);
    if (!amount) {
      return res.status(400).json({ error: 'Amount must be between ₹1 and ₹1,00,000 with at most 2 decimals' });
    }

    const customerName = parseString(req.body.customer_name, 120);
    if (!customerName) {
      return res.status(400).json({ error: 'Customer name is required (max 120 characters)' });
    }

    let customerEmail = null;
    if (req.body.customer_email) {
      customerEmail = typeof req.body.customer_email === 'string' ? req.body.customer_email.trim().toLowerCase() : '';
      if (!isEmail(customerEmail)) {
        return res.status(400).json({ error: 'Customer email is not valid' });
      }
    }

    let successUrl = null;
    if (req.body.success_url) {
      if (!isValidRedirectUrl(req.body.success_url)) {
        return res.status(400).json({ error: 'success_url must be a valid HTTP or HTTPS URL' });
      }
      successUrl = String(req.body.success_url).trim();
    }

    let cancelUrl = null;
    if (req.body.cancel_url) {
      if (!isValidRedirectUrl(req.body.cancel_url)) {
        return res.status(400).json({ error: 'cancel_url must be a valid HTTP or HTTPS URL' });
      }
      cancelUrl = String(req.body.cancel_url).trim();
    }

    const metadata = parseMetadata(req.body.metadata);
    if (metadata === null) {
      return res.status(400).json({ error: 'metadata must be a JSON object with at most 20 keys and 4 KB in total' });
    }

    const idempotencyKey = req.get('idempotency-key') || null;
    if (idempotencyKey && !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
      return res.status(400).json({ error: 'Idempotency-Key must be 1 to 128 letters, digits, or . _ : -' });
    }

    if (!merchant.upi_id || !isFamPayVpa(merchant.upi_id)) {
      return res.status(400).json({ error: 'Configure your FamPay UPI ID (@fam) in settings before creating payments' });
    }

    if (!merchant.google_email) {
      return res.status(400).json({ error: 'Connect your Gmail account in settings to verify payments before creating payments' });
    }

    if (idempotencyKey) {
      const { data: existing, error: lookupError } = await findOrderByIdempotencyKey(merchant.id, idempotencyKey);
      if (lookupError) {
        console.error('[ORDER] Idempotency lookup error:', lookupError.message);
        return res.status(500).json({ error: 'Could not create the order' });
      }
      if (existing) {
        if (Number(existing.amount) !== Number(amount)) {
          return res.status(409).json({ error: 'This Idempotency-Key was already used for a different amount' });
        }
        return sendCreatedOrder(res, 200, existing, merchant);
      }
    }

    const orderId = `ord_${crypto.randomBytes(12).toString('base64url')}`;
    const expiresAt = new Date(Date.now() + ORDER_TTL_MS).toISOString();
    const env = 'production';
    const { data: order, error } = await supabase
      .from('orders')
      .insert({
        id: orderId,
        merchant_id: merchant.id,
        customer_name: customerName,
        customer_email: customerEmail,
        amount,
        status: 'PENDING',
        expires_at: expiresAt,
        environment: env,
        success_url: successUrl,
        cancel_url: cancelUrl,
        metadata,
        ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {})
      })
      .select()
      .single();

    // Two identical requests at the same moment: the unique index lets one through, the other returns it.
    if (error && error.code === '23505' && idempotencyKey) {
      const { data: winner } = await findOrderByIdempotencyKey(merchant.id, idempotencyKey);
      if (winner) return sendCreatedOrder(res, 200, winner, merchant);
    }

    if (error) {
      console.error('[ORDER] Insert error:', error.message);
      return res.status(500).json({ error: 'Could not create the order' });
    }

    return sendCreatedOrder(res, 201, order, merchant);
  } catch (err) {
    console.error('[ORDER] createOrder error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * Public order state for the hosted checkout page. Exposes only what a payer needs.
 */
async function getOrderStatus(req, res) {
  try {
    const { id } = req.params;
    if (!isOrderId(id)) return res.status(404).json({ error: 'Order not found' });

    const { data: order, error } = await supabase
      .from('orders')
      .select(`
        id, amount, customer_name, status, transaction_id, utr, expires_at, created_at, environment,
        success_url, cancel_url,
        merchants (
          name, upi_id, upi_name, brand_color, logo_url, checkout_title, checkout_subtitle, support_contact
        )
      `)
      .eq('id', id)
      .maybeSingle();

    if (error || !order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    let status = order.status;
    if (status === 'PENDING' && new Date(order.expires_at) < new Date()) {
      status = 'EXPIRED';
      await supabase.from('orders').update({ status }).eq('id', id).eq('status', 'PENDING');
    }

    const merchant = order.merchants || {};
    const timeLeft = Math.max(0, Math.floor((new Date(order.expires_at) - new Date()) / 1000));

    const response = {
      id: order.id,
      amount: order.amount,
      currency: 'INR',
      customer_name: order.customer_name,
      status,
      environment: order.environment || 'production',
      time_left_seconds: status === 'PENDING' ? timeLeft : 0,
      expires_at: order.expires_at,
      // The return URL stays hidden until the order is paid, so a payer cannot open the merchant's
      // success page without paying. metadata is merchant data and is sent in webhooks only.
      success_url: status === 'PAID' ? resolveRedirectUrl(order.success_url, order.id) : null,
      cancel_url: order.cancel_url || null,
      merchant: {
        name: merchant.name || null,
        brand_color: merchant.brand_color || '#0052ff',
        logo_url: merchant.logo_url || '',
        checkout_title: merchant.checkout_title || 'Pay to ' + (merchant.name || 'merchant'),
        checkout_subtitle: merchant.checkout_subtitle || 'Scan with any UPI app to pay',
        support_contact: merchant.support_contact || ''
      }
    };

    if (status === 'PAID') {
      response.payment = { transaction_id: order.transaction_id, utr: order.utr };
    }

    if (status === 'PENDING' && merchant.upi_id) {
      response.payee_upi = merchant.upi_id;
      const upiUri = buildUpiUri(merchant.upi_id, merchant.upi_name || merchant.name, order.amount);
      response.upi_uri = upiUri;
      response.qr_code = await QRCode.toDataURL(upiUri, qrOptions());
    }

    return res.json(response);
  } catch (err) {
    console.error('[ORDER] status error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * Customer fallback: claim a payment by typing its UTR or FamPay transaction ID.
 */
async function verifyUtrFallback(req, res) {
  try {
    const orderId = req.body.order_id;
    if (!isOrderId(orderId)) return res.status(400).json({ success: false, message: 'Invalid order' });

    const result = await verifyOrderByUtrOrTxnId(orderId, req.body.reference);
    return res.status(result.success ? 200 : 400).json(result);
  } catch (err) {
    console.error('[ORDER] verify-utr error:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

/**
 * Lists the signed-in merchant's orders, newest first. Optional status filter and limit.
 */
async function listOrders(req, res) {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const allowedStatus = ['PENDING', 'PAID', 'EXPIRED'];
    const status = allowedStatus.includes(req.query.status) ? req.query.status : null;

    let query = supabase
      .from('orders')
      .select('id, amount, customer_name, customer_email, status, transaction_id, utr, expires_at, created_at, environment')
      .eq('merchant_id', req.merchant.id)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (status) query = query.eq('status', status);

    const { data: orders, error } = await query;
    if (error) {
      console.error('[ORDER] list error:', error.message);
      return res.status(500).json({ error: 'Could not load orders' });
    }

    return res.json({ orders });
  } catch (err) {
    return res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = {
  createOrder,
  getOrderStatus,
  verifyUtrFallback,
  listOrders
};
