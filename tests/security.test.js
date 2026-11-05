// Attacks a payer can try, run against an in-memory stand-in for Supabase. No network or real database.
const assert = require('assert');
const path = require('path');

const db = { orders: [], fampay_ledger: [] };

class Query {
  constructor(table) {
    this.table = table;
    this.filters = [];
    this.patch = null;
  }
  select() { return this; }
  order() { return this; }
  limit() { return this; }
  or(expr) {
    const [, value] = expr.match(/^utr\.eq\.([^,]+),/);
    this.filters.push((r) => r.utr === value || r.transaction_id === value);
    return this;
  }
  eq(col, val) { this.filters.push((r) => (col === 'amount' ? Number(r[col]) === Number(val) : r[col] === val)); return this; }
  in(col, vals) { this.filters.push((r) => vals.includes(r[col])); return this; }
  gte(col, val) { this.filters.push((r) => new Date(r[col]) >= new Date(val)); return this; }
  lte(col, val) { this.filters.push((r) => new Date(r[col]) <= new Date(val)); return this; }
  update(patch) { this.patch = patch; return this; }
  upsert(row) {
    if (!db[this.table].some((r) => r.transaction_id === row.transaction_id)) {
      db[this.table].push({ claimed: false, received_at: new Date().toISOString(), ...row });
    }
    return Promise.resolve({ error: null });
  }
  rows() { return db[this.table].filter((r) => this.filters.every((f) => f(r))); }
  maybeSingle() { const rows = this.rows(); return Promise.resolve({ data: rows[0] || null, error: null }); }
  then(resolve) {
    const rows = this.rows();
    if (this.patch) rows.forEach((r) => Object.assign(r, this.patch));
    return resolve({ data: rows.map((r) => ({ ...r, merchants: { id: 'm1' } })), error: null });
  }
}

const fakeSupabase = {
  from: (table) => new Query(table),
  rpc: async (_name, { p_order_id, p_transaction_id, p_utr }) => {
    const ledger = db.fampay_ledger.find((r) => r.transaction_id === p_transaction_id && !r.claimed);
    const order = db.orders.find((o) => o.id === p_order_id && ['PENDING', 'EXPIRED'].includes(o.status));
    if (!ledger || !order) return { data: false, error: null };
    ledger.claimed = true;
    ledger.order_id = p_order_id;
    Object.assign(order, { status: 'PAID', transaction_id: p_transaction_id, utr: p_utr });
    return { data: true, error: null };
  }
};

require.cache[require.resolve(path.join(__dirname, '../src/config/supabase.js'))] = { exports: { supabase: fakeSupabase } };
require.cache[require.resolve(path.join(__dirname, '../src/services/webhookService.js'))] = {
  exports: { dispatchMerchantWebhook: async () => ({ delivered: true }) }
};

const { processIncomingPayment, verifyOrderByUtrOrTxnId } = require('../src/services/matcher');
const { parseAmount, parseMetadata, isValidRedirectUrl, resolvesToPublicAddress } = require('../src/lib/validation');
const { verifyReceiptSender } = require('../src/lib/receiptAuth');

const minutesAgo = (m) => new Date(Date.now() - m * 60000).toISOString();
let seq = 0;

function addOrder({ amount = 499, customer_name = 'Someone', created = 1 }) {
  const order = {
    id: `ord_test_order_${++seq}`,
    merchant_id: 'm1',
    environment: 'production',
    status: 'PENDING',
    amount,
    customer_name,
    created_at: minutesAgo(created)
  };
  db.orders.push(order);
  return order;
}

function payment({ amount = 499, senderName = 'REAL PAYER' } = {}) {
  const n = ++seq;
  return { amount, senderName, transactionId: `FMPIB${n}`, utr: String(100000000000 + n) };
}

function reset() {
  db.orders.length = 0;
  db.fampay_ledger.length = 0;
}

(async () => {
  // A lone order with an exact payment still confirms automatically.
  reset();
  let order = addOrder({});
  let result = await processIncomingPayment(payment(), null, 'm1');
  assert.strictEqual(result.status, 'PAID');
  assert.strictEqual(order.status, 'PAID');

  // Replaying the same receipt cannot pay a second order.
  reset();
  addOrder({});
  const once = payment();
  await processIncomingPayment(once, null, 'm1');
  const second = addOrder({ created: 0 });
  result = await processIncomingPayment(once, null, 'm1');
  assert.strictEqual(result.status, 'ALREADY_CLAIMED');
  assert.strictEqual(second.status, 'PENDING');
  console.log('✅ Exact payment confirms, and a replayed receipt is refused.');

  // A few seconds of clock difference must not reject a fast payment.
  reset();
  const fastOrder = addOrder({ created: 0 });
  fastOrder.created_at = new Date(Date.now() + 5000).toISOString();
  result = await processIncomingPayment(payment(), null, 'm1');
  assert.strictEqual(result.status, 'PAID');
  console.log('✅ Small clock differences do not reject a payment.');

  // Setting customer_name to the victim's name, or opening the newest order, must not win their payment.
  reset();
  const victim = addOrder({ customer_name: 'Nickname', created: 3 });
  const attacker = addOrder({ customer_name: 'Real Payer', created: 0 });
  const victimPayment = payment();
  result = await processIncomingPayment(victimPayment, null, 'm1');
  assert.strictEqual(result.status, 'COLLISION_PENDING_CONFIRMATION');
  assert.strictEqual(attacker.status, 'PENDING');
  assert.strictEqual(victim.status, 'PENDING');

  // The real payer settles it with their UTR, and the other order cannot then take it.
  result = await verifyOrderByUtrOrTxnId(victim.id, victimPayment.utr);
  assert.strictEqual(result.success, true);
  assert.strictEqual(victim.status, 'PAID');
  result = await verifyOrderByUtrOrTxnId(attacker.id, victimPayment.utr);
  assert.strictEqual(result.success, false);
  assert.strictEqual(attacker.status, 'PENDING');
  console.log('✅ Customer name and order timing cannot capture another payment.');

  // A collision must not resolve itself when the older order ages out of the window.
  reset();
  addOrder({ created: 61 });
  const survivor = addOrder({ created: 40 });
  const stale = payment();
  db.fampay_ledger.push({ ...stale, transaction_id: stale.transactionId, merchant_id: 'm1', environment: 'production', claimed: false, received_at: minutesAgo(45) });
  survivor.created_at = minutesAgo(50);
  result = await processIncomingPayment(stale, null, 'm1');
  assert.strictEqual(result.status, 'COLLISION_PENDING_CONFIRMATION');
  assert.strictEqual(survivor.status, 'PENDING');

  // An old unclaimed payment cannot settle an order created after it, automatically or by UTR.
  reset();
  const old = payment();
  db.fampay_ledger.push({ ...old, transaction_id: old.transactionId, merchant_id: 'm1', environment: 'production', claimed: false, received_at: minutesAgo(30) });
  const newer = addOrder({ created: 1 });
  result = await processIncomingPayment(old, null, 'm1');
  assert.strictEqual(result.status, 'IGNORED_NO_MATCHING_ORDER');
  result = await verifyOrderByUtrOrTxnId(newer.id, old.utr);
  assert.strictEqual(result.success, false);
  assert.strictEqual(newer.status, 'PENDING');

  // The same when the old receipt is seen for the first time: its arrival date decides, not today.
  const firstSeen = payment();
  result = await processIncomingPayment(firstSeen, null, 'm1', 'production', new Date(minutesAgo(30)));
  assert.strictEqual(result.status, 'IGNORED_NO_MATCHING_ORDER');
  assert.strictEqual(db.fampay_ledger.some((r) => r.transaction_id === firstSeen.transactionId), false, 'Unrelated payments are not stored');
  assert.strictEqual(newer.status, 'PENDING');

  // Another merchant's payment cannot be taken.
  const foreign = payment();
  db.fampay_ledger.push({ ...foreign, transaction_id: foreign.transactionId, merchant_id: 'm2', environment: 'production', claimed: false, received_at: minutesAgo(0) });
  result = await processIncomingPayment(foreign, null, 'm1');
  assert.strictEqual(result.status, 'OTHER_MERCHANT');
  console.log('✅ Old unclaimed payments cannot settle newer orders.');

  // Underpaying fails, and the error does not reveal what the other payment was for.
  reset();
  const costly = addOrder({ amount: 5000 });
  const small = payment({ amount: 1 });
  result = await processIncomingPayment(small, null, 'm1');
  assert.strictEqual(result.status, 'IGNORED_NO_MATCHING_ORDER');
  db.fampay_ledger.push({ ...small, transaction_id: small.transactionId, merchant_id: 'm1', environment: 'production', claimed: false, received_at: minutesAgo(0) });
  result = await verifyOrderByUtrOrTxnId(costly.id, small.utr);
  assert.strictEqual(result.success, false);
  assert.ok(!result.message.includes('₹'), 'The amount of another payment must not be revealed');
  assert.strictEqual(costly.status, 'PENDING');

  // Non-string references are refused rather than converted.
  result = await verifyOrderByUtrOrTxnId(costly.id, [small.utr]);
  assert.strictEqual(result.success, false);
  result = await verifyOrderByUtrOrTxnId(costly.id, { $ne: null });
  assert.strictEqual(result.success, false);
  console.log('✅ Underpayment and tampered reference payloads are refused.');

  // Amount payloads
  for (const bad of ['1e3', '0x10', [100], { amount: 1 }, true, null, '-5', '0', '100.999', 'NaN', 'Infinity', 100001, 0.5]) {
    assert.strictEqual(parseAmount(bad), null, `${JSON.stringify(bad)} must be rejected`);
  }
  assert.strictEqual(parseAmount('1,499.50'), '1499.50');
  assert.strictEqual(parseAmount(19.99), '19.99');

  // Other order payloads
  assert.strictEqual(parseMetadata('text'), null);
  assert.strictEqual(parseMetadata([1]), null);
  assert.strictEqual(parseMetadata({ a: 'x'.repeat(5000) }), null);
  assert.deepStrictEqual(parseMetadata(undefined), {});
  for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'https://user:pass@evil.example/']) {
    assert.strictEqual(isValidRedirectUrl(bad), false, `${bad} must be rejected`);
  }
  console.log('✅ Malformed amount, metadata and redirect payloads are rejected.');

  // Receipt authenticity
  const auth = { name: 'Authentication-Results', value: 'mx.google.com; dkim=pass header.i=@famapp.in header.s=s1; dmarc=pass (p=REJECT) header.from=famapp.in' };
  const from = { name: 'From', value: 'FamApp <no-reply@famapp.in>' };
  const to = { name: 'To', value: 'Shop Owner <shop.owner@gmail.com>' };
  const recipient = 'shopowner@gmail.com';
  assert.ok(verifyReceiptSender([auth, from, to], { recipient }).ok, 'A genuine receipt is accepted');
  assert.ok(!verifyReceiptSender([auth, from, { name: 'To', value: 'attacker@gmail.com' }], { recipient }).ok, 'A resent receipt for another account is refused');
  assert.ok(!verifyReceiptSender([auth, from, { name: 'To', value: recipient }, to], { recipient }).ok, 'A second To header is refused');
  assert.ok(!verifyReceiptSender([auth, from], { recipient }).ok, 'A missing To header is refused');
  assert.ok(!verifyReceiptSender([{ name: 'Authentication-Results', value: 'mx.google.com; dkim=fail; dmarc=fail header.from=famapp.in' }, from, to], { recipient }).ok, 'A forged sender is refused');
  assert.ok(!verifyReceiptSender([auth, { name: 'From', value: 'x@famapp.in.evil.com' }, to], { recipient }).ok, 'A lookalike domain is refused');
  console.log('✅ Forged, lookalike and resent receipts are refused.');

  // Webhook targets
  for (const bad of ['https://127.0.0.1/', 'https://[::ffff:127.0.0.1]/', 'https://169.254.169.254/', 'https://[::1]/', 'https://10.1.2.3/']) {
    assert.strictEqual(await resolvesToPublicAddress(bad), false, `${bad} must be blocked`);
  }
  assert.strictEqual(await resolvesToPublicAddress('https://8.8.8.8/'), true);
  console.log('✅ Webhook URLs cannot reach internal addresses.');

  console.log('\n🎉 ALL SECURITY TESTS PASSED!');
})().catch((err) => {
  console.error('❌', err);
  process.exit(1);
});
