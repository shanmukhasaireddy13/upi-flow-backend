const { supabase } = require('../config/supabase');
const { dispatchMerchantWebhook } = require('./webhookService');
const { isPaymentReference } = require('../lib/validation');

/**
 * Compares two names by extracting meaningful tokens (> 2 characters).
 * e.g., "Aarav Sharma" matches "SHARMA AARAV KUMAR"
 */
function compareNames(customerName, senderName) {
  if (!customerName || !senderName) return false;

  const clean = (str) =>
    str
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, '')
      .split(/\s+/)
      .filter((t) => t.length > 2);

  const custTokens = clean(customerName);
  const senderTokens = clean(senderName);

  return custTokens.some((token) => senderTokens.includes(token));
}

/**
 * Checks if an order's customer name or email handle matches the sender name in the bank receipt.
 */
function matchesPayer(order, senderName) {
  if (!order || !senderName) return false;
  if (compareNames(order.customer_name, senderName)) return true;

  // Also check customer email prefix tokens (e.g., "aarav.sharma@gmail.com" matches "SHARMA")
  if (order.customer_email) {
    const handle = String(order.customer_email).split('@')[0].replace(/[._-]/g, ' ');
    if (compareNames(handle, senderName)) return true;
  }
  return false;
}

async function markOrderPaid(order, transactionId, utr) {
  const { data: reconciled, error } = await supabase.rpc('reconcile_fampay_payment', {
    p_order_id: order.id,
    p_transaction_id: transactionId,
    p_utr: utr
  });
  // The function ran: its answer is final. `false` means the payment or the order was already taken.
  if (!error) {
    return reconciled ? { ok: true } : { ok: false, error: 'Payment already claimed or order not payable' };
  }

  console.warn('[MATCHER] RPC error executing reconcile_fampay_payment:', error.message, '- applying guarded reconciliation');

  // Fallback without the database function. Each step only succeeds if the row is still in the expected
  // state, so two concurrent requests cannot both claim one payment or both pay one order.
  // 1. Claim the payment.
  const { data: claimedRows, error: claimErr } = await supabase
    .from('fampay_ledger')
    .update({ claimed: true, order_id: order.id })
    .eq('transaction_id', transactionId)
    .eq('claimed', false)
    .select('transaction_id');

  if (claimErr || !claimedRows || claimedRows.length === 0) {
    return { ok: false, error: claimErr ? claimErr.message : 'Payment already claimed' };
  }

  // 2. Pay the order, only if it is still unpaid.
  const { data: paidRows, error: orderUpdateErr } = await supabase
    .from('orders')
    .update({
      status: 'PAID',
      transaction_id: transactionId,
      utr: utr || null,
      updated_at: new Date().toISOString()
    })
    .eq('id', order.id)
    .in('status', ['PENDING', 'EXPIRED'])
    .select('id');

  if (orderUpdateErr || !paidRows || paidRows.length === 0) {
    // Release the payment so it can still be matched to the right order.
    await supabase
      .from('fampay_ledger')
      .update({ claimed: false, order_id: null })
      .eq('transaction_id', transactionId)
      .eq('order_id', order.id);
    if (orderUpdateErr) console.error('[MATCHER] Direct order update error:', orderUpdateErr.message);
    return { ok: false, error: orderUpdateErr ? orderUpdateErr.message : 'Order is no longer payable' };
  }

  return { ok: true };
}

/**
 * Reconciles an incoming parsed FamApp payment with pending orders of ONE merchant.
 * The merchant must be known (resolved from the receiving Gmail account or the authenticated caller).
 * Without it we cannot tell whose payment this is, so it is stored unclaimed rather than matched.
 */
async function processIncomingPayment(parsedPayment, rawEmail = null, merchantId = null, environment = 'production') {
  const { amount, transactionId, senderName, dateRaw, updatedBalance, utr } = parsedPayment;

  if (!merchantId) {
    console.log(`[MATCHER] Payment ${transactionId} received without merchant attribution. Ignored.`);
    return { status: 'STORED_UNCLAIMED', transactionId };
  }

  // 1. Check if this transaction was already processed and claimed
  const { data: existingLedger } = await supabase
    .from('fampay_ledger')
    .select('*')
    .eq('transaction_id', transactionId)
    .maybeSingle();

  if (existingLedger && existingLedger.claimed) {
    return { status: 'ALREADY_CLAIMED', transactionId };
  }

  // 2. Pending, unexpired orders of this merchant with the same amount and environment.
  let { data: pendingOrders, error: orderError } = await supabase
    .from('orders')
    .select('*, merchants(*)')
    .eq('merchant_id', merchantId)
    .eq('environment', environment)
    .eq('status', 'PENDING')
    .eq('amount', amount)
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: true });

  if (orderError) {
    console.error('[MATCHER] Error querying pending orders:', orderError.message);
    return { status: 'ERROR', error: orderError.message };
  }

  // Grace fallback: search for orders created within the last 60 minutes
  if (!pendingOrders || pendingOrders.length === 0) {
    const sixtyMinutesAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { data: recentOrders } = await supabase
      .from('orders')
      .select('*, merchants(*)')
      .eq('merchant_id', merchantId)
      .eq('environment', environment)
      .in('status', ['PENDING', 'EXPIRED'])
      .eq('amount', amount)
      .gte('created_at', sixtyMinutesAgo)
      .order('created_at', { ascending: false });

    if (recentOrders && recentOrders.length > 0) {
      pendingOrders = recentOrders;
    } else if (environment === 'production') {
      // Check if this merchant created an order in dev mode
      const { data: devOrders } = await supabase
        .from('orders')
        .select('*, merchants(*)')
        .eq('merchant_id', merchantId)
        .eq('environment', 'dev')
        .in('status', ['PENDING', 'EXPIRED'])
        .eq('amount', amount)
        .gte('created_at', sixtyMinutesAgo)
        .order('created_at', { ascending: false });

      if (devOrders && devOrders.length > 0) {
        pendingOrders = devOrders;
      }
    }
  }

  // If no matching order was created for this merchant and amount, IGNORE the receipt.
  // We do NOT write to fampay_ledger for unrelated personal or past payments!
  if (!pendingOrders || pendingOrders.length === 0) {
    console.log(`[MATCHER] Unrelated payment of ₹${amount} (Txn: ${transactionId}) ignored: no active order found for merchant.`);
    return { status: 'IGNORED_NO_MATCHING_ORDER', transactionId };
  }

  // 3. Now that a matching order is confirmed, record in the ledger.
  const targetEnv = pendingOrders[0].environment || environment;
  const { error: ledgerError } = await supabase
    .from('fampay_ledger')
    .upsert(
      {
        transaction_id: transactionId,
        utr,
        amount,
        sender_name: senderName,
        raw_date: dateRaw,
        updated_balance: updatedBalance,
        raw_email: rawEmail,
        merchant_id: merchantId,
        environment: targetEnv
      },
      { onConflict: 'transaction_id', ignoreDuplicates: true }
    );

  if (ledgerError) {
    console.error('[MATCHER] Ledger upsert error:', ledgerError.message);
    return { status: 'ERROR', error: ledgerError.message };
  }

  // 4. Lone order: match. Several orders for the same amount: match on name/email first, then smart recency.
  let matchedOrder = null;
  if (pendingOrders.length === 1) {
    matchedOrder = pendingOrders[0];
  } else {
    // A. Priority 1: Customer name or email handle token match
    matchedOrder = pendingOrders.find((ord) => matchesPayer(ord, senderName)) || null;

    // B. Priority 2: Smart Recency Disambiguation
    if (!matchedOrder) {
      const sortedByRecency = [...pendingOrders].sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      );
      const newest = sortedByRecency[0];
      const secondNewest = sortedByRecency[1];

      const nowMs = Date.now();
      const newestAgeSec = Math.max(0, Math.floor((nowMs - new Date(newest.created_at).getTime()) / 1000));
      const secondAgeSec = Math.max(0, Math.floor((nowMs - new Date(secondNewest.created_at).getTime()) / 1000));
      const ageGapSec = secondAgeSec - newestAgeSec;

      // Match the newest order if it was created within the last 4 minutes (240s) AND either:
      // - The newer order is at least 45 seconds fresher than the older order, OR
      // - The older order was created >= 150 seconds (2.5+ minutes) ago
      if (newestAgeSec <= 240 && (ageGapSec >= 45 || secondAgeSec >= 150)) {
        console.log(`[MATCHER] Smart Recency: Resolved collision for ₹${amount}. Selected newest order ${newest.id} (created ${newestAgeSec}s ago vs older candidate ${secondAgeSec}s ago).`);
        matchedOrder = newest;
      }
    }

    if (!matchedOrder) {
      console.warn(`[MATCHER] Unresolved collision for ₹${amount}. Multiple concurrent orders within tight time window: ${pendingOrders.map((o) => o.id).join(', ')}`);
      return {
        status: 'COLLISION_PENDING_CONFIRMATION',
        transactionId,
        candidateOrders: pendingOrders.map((o) => o.id)
      };
    }
  }

  // Ensure ledger environment matches order environment before atomic reconciliation
  if (targetEnv !== matchedOrder.environment) {
    await supabase
      .from('fampay_ledger')
      .update({ environment: matchedOrder.environment })
      .eq('transaction_id', transactionId);
  }

  // 5. Atomic reconciliation in PostgreSQL.
  const result = await markOrderPaid(matchedOrder, transactionId, utr);
  if (!result.ok) {
    return { status: 'RECONCILIATION_FAILED', error: result.error };
  }

  const paidOrder = { ...matchedOrder, status: 'PAID', transaction_id: transactionId, utr };
  await dispatchMerchantWebhook(matchedOrder.merchants, 'order.paid', paidOrder);
  return { status: 'PAID', orderId: matchedOrder.id, transactionId, utr };
}

/**
 * Manual fallback: the customer types the UTR or FamPay transaction ID of a payment they made.
 * Only payments attributed to the order's own merchant and with the exact amount can be claimed.
 */
async function verifyOrderByUtrOrTxnId(orderId, referenceInput) {
  const reference = String(referenceInput || '').trim();
  if (!isPaymentReference(reference)) {
    return { success: false, message: 'Enter the 12-digit UTR or the FamPay transaction ID' };
  }

  const { data: order, error: orderError } = await supabase
    .from('orders')
    .select('*, merchants(*)')
    .eq('id', orderId)
    .maybeSingle();

  if (orderError || !order) {
    return { success: false, message: 'Order not found' };
  }
  if (order.status === 'PAID') {
    return { success: true, message: 'This order is already paid', orderId: order.id, utr: order.utr };
  }
  const sixtyMinutesAgo = new Date(Date.now() - 60 * 60 * 1000);
  const isRecent = new Date(order.created_at) >= sixtyMinutesAgo;
  if (!['PENDING', 'EXPIRED'].includes(order.status) || !isRecent) {
    return { success: false, message: 'This checkout session has expired' };
  }

  // The reference is validated as alphanumeric above, so it is safe inside the PostgREST filter.
  const { data: entries, error: ledgerError } = await supabase
    .from('fampay_ledger')
    .select('*')
    .eq('merchant_id', order.merchant_id)
    .eq('environment', order.environment || 'production')
    .eq('claimed', false)
    .or(`utr.eq.${reference},transaction_id.eq.${reference}`)
    .limit(1);

  if (ledgerError || !entries || entries.length === 0) {
    return {
      success: false,
      message: 'No matching unclaimed payment found. If you just paid, wait a few seconds and try again.'
    };
  }

  const ledger = entries[0];
  if (Number(ledger.amount) !== Number(order.amount)) {
    return {
      success: false,
      message: `This payment is ₹${ledger.amount}, but the order is ₹${order.amount}`
    };
  }

  const result = await markOrderPaid(order, ledger.transaction_id, ledger.utr);
  if (!result.ok) {
    return { success: false, message: 'This payment was already claimed by another order' };
  }

  const paidOrder = { ...order, status: 'PAID', transaction_id: ledger.transaction_id, utr: ledger.utr };
  await dispatchMerchantWebhook(order.merchants, 'order.paid', paidOrder);

  return {
    success: true,
    message: 'Payment verified',
    orderId: order.id,
    transactionId: ledger.transaction_id,
    utr: ledger.utr
  };
}

module.exports = {
  processIncomingPayment,
  verifyOrderByUtrOrTxnId,
  compareNames,
  matchesPayer
};
