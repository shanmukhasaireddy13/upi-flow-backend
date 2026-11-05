const { supabase } = require('../config/supabase');
const { dispatchMerchantWebhook } = require('./webhookService');
const { isPaymentReference } = require('../lib/validation');

// How long after an order is created a payment can still settle it (late payments, delayed emails).
const MATCH_WINDOW_MS = 60 * 60 * 1000;
// Order times come from the database clock and receipt times from Gmail or this server. They can
// differ by a few seconds, which must not make a fast payment look older than its order.
const CLOCK_TOLERANCE_MS = 30 * 1000;

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

// Delivery retries in the background, so a slow merchant endpoint cannot hold up the payer's request.
function notifyMerchant(merchant, paidOrder) {
  dispatchMerchantWebhook(merchant, 'order.paid', paidOrder).catch((err) => {
    console.error(`[WEBHOOK] order.paid for ${paidOrder.id} failed:`, err.message);
  });
}

/**
 * Reconciles an incoming parsed FamApp payment with pending orders of ONE merchant.
 * The merchant must be known (resolved from the receiving Gmail account or the authenticated caller).
 * Without it we cannot tell whose payment this is, so it is stored unclaimed rather than matched.
 * `paidAt` is when the mail server received the receipt, when known.
 */
async function processIncomingPayment(parsedPayment, rawEmail = null, merchantId = null, environment = 'production', paidAt = null) {
  const { amount, transactionId, senderName, dateRaw, updatedBalance, utr } = parsedPayment;

  if (!merchantId) {
    console.log(`[MATCHER] Payment ${transactionId} received without merchant attribution. Ignored.`);
    return { status: 'STORED_UNCLAIMED', transactionId };
  }

  // 1. A payment is only ever used once, and only by the merchant it belongs to.
  const { data: existingLedger } = await supabase
    .from('fampay_ledger')
    .select('*')
    .eq('transaction_id', transactionId)
    .maybeSingle();

  if (existingLedger && existingLedger.claimed) {
    return { status: 'ALREADY_CLAIMED', transactionId };
  }
  if (existingLedger && existingLedger.merchant_id && existingLedger.merchant_id !== merchantId) {
    return { status: 'OTHER_MERCHANT', transactionId };
  }

  // 2. Unpaid orders of this merchant with the same amount that existed when this payment was made.
  //    The window is anchored to the payment, not to the current time, so an old receipt (which can be
  //    looked at again on every Gmail sync) can never settle an order created after it.
  const receivedAt = new Date(paidAt || (existingLedger && existingLedger.received_at) || Date.now());
  const { data: candidates, error: orderError } = await supabase
    .from('orders')
    .select('*, merchants(*)')
    .eq('merchant_id', merchantId)
    .eq('environment', environment)
    .in('status', ['PENDING', 'EXPIRED'])
    .eq('amount', amount)
    .gte('created_at', new Date(receivedAt.getTime() - MATCH_WINDOW_MS).toISOString())
    .lte('created_at', new Date(receivedAt.getTime() + CLOCK_TOLERANCE_MS).toISOString())
    .order('created_at', { ascending: true });

  if (orderError) {
    console.error('[MATCHER] Error querying pending orders:', orderError.message);
    return { status: 'ERROR', error: orderError.message };
  }

  // If no matching order was created for this merchant and amount, IGNORE the receipt.
  // We do NOT write to fampay_ledger for unrelated personal or past payments!
  if (!candidates || candidates.length === 0) {
    console.log(`[MATCHER] Unrelated payment of ₹${amount} (Txn: ${transactionId}) ignored: no matching order for merchant.`);
    return { status: 'IGNORED_NO_MATCHING_ORDER', transactionId };
  }

  // 3. Now that a matching order is confirmed, record in the ledger.
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
        environment,
        ...(paidAt ? { received_at: receivedAt.toISOString() } : {})
      },
      { onConflict: 'transaction_id', ignoreDuplicates: true }
    );

  if (ledgerError) {
    console.error('[MATCHER] Ledger upsert error:', ledgerError.message);
    return { status: 'ERROR', error: ledgerError.message };
  }

  // 4. Only an unambiguous match is automatic. With several orders for one amount the receipt cannot say
  //    whose payment this is. Guessing from the customer name or the newest order would let a customer
  //    choose a name, or open a fresh order, to get another person's payment applied to their own order.
  //    Those orders stay open and the real payer confirms with the UTR, which only they know.
  if (candidates.length > 1) {
    console.warn(`[MATCHER] ${candidates.length} open orders for ₹${amount}; waiting for the payer's UTR on ${transactionId}`);
    return {
      status: 'COLLISION_PENDING_CONFIRMATION',
      transactionId,
      candidateOrders: candidates.map((o) => o.id)
    };
  }

  const matchedOrder = candidates[0];

  // 5. Atomic reconciliation in PostgreSQL.
  const result = await markOrderPaid(matchedOrder, transactionId, utr);
  if (!result.ok) {
    return { status: 'RECONCILIATION_FAILED', error: result.error };
  }

  const paidOrder = { ...matchedOrder, status: 'PAID', transaction_id: transactionId, utr };
  notifyMerchant(matchedOrder.merchants, paidOrder);
  return { status: 'PAID', orderId: matchedOrder.id, transactionId, utr };
}

/**
 * Manual fallback: the customer types the UTR or FamPay transaction ID of a payment they made.
 * Only payments attributed to the order's own merchant and with the exact amount can be claimed.
 */
async function verifyOrderByUtrOrTxnId(orderId, referenceInput) {
  const reference = typeof referenceInput === 'string' ? referenceInput.trim() : '';
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
    return { success: true, message: 'This order is already paid', orderId: order.id };
  }
  const isRecent = Date.now() - new Date(order.created_at).getTime() <= MATCH_WINDOW_MS;
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

  // Same answer for every failure, so nobody can use this endpoint to learn what other payers paid.
  // A payment made before this order existed, or for a different amount, cannot settle it.
  const ledger = entries && entries[0];
  const isValidClaim = !ledgerError && ledger &&
    Number(ledger.amount) === Number(order.amount) &&
    new Date(ledger.received_at).getTime() + CLOCK_TOLERANCE_MS >= new Date(order.created_at).getTime();

  if (!isValidClaim) {
    return {
      success: false,
      message: 'No matching payment found for this order. Check the UTR and the amount you paid. If you just paid, wait a few seconds and try again.'
    };
  }

  const result = await markOrderPaid(order, ledger.transaction_id, ledger.utr);
  if (!result.ok) {
    return { success: false, message: 'This payment was already claimed by another order' };
  }

  const paidOrder = { ...order, status: 'PAID', transaction_id: ledger.transaction_id, utr: ledger.utr };
  notifyMerchant(order.merchants, paidOrder);

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
  verifyOrderByUtrOrTxnId
};
