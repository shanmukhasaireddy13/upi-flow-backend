const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const assert = require('assert');
const { supabase } = require('../src/config/supabase');
const { parseFamPayEmail } = require('../src/services/emailParser');
const { processIncomingPayment, verifyOrderByUtrOrTxnId } = require('../src/services/matcher');

async function runIntegrationTest() {
  console.log('🚀 Running End-to-End Gateway Integration Test with Live Supabase...\n');

  const testOrderId = `test_ord_${Date.now().toString(36)}`;
  const testAmount = 50.0;
  const testCustomerName = 'Shanmukha Reddy';
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

  // 1. Fetch Default Merchant
  const { data: merchant, error: mErr } = await supabase
    .from('merchants')
    .select('*')
    .eq('api_key', process.env.DEFAULT_MERCHANT_KEY)
    .single();

  assert.ok(merchant, 'Default merchant should exist in Supabase');
  console.log(`✅ Merchant Verified: ${merchant.name} (UPI: ${merchant.upi_id})`);

  // 2. Insert Test Order
  const { data: order, error: oErr } = await supabase
    .from('orders')
    .insert({
      id: testOrderId,
      merchant_id: merchant.id,
      customer_name: testCustomerName,
      customer_email: 'shanmukha@test.local',
      amount: testAmount,
      status: 'PENDING',
      expires_at: expiresAt
    })
    .select()
    .single();

  assert.ok(!oErr, `Order creation should succeed: ${oErr?.message}`);
  assert.strictEqual(order.status, 'PENDING');
  console.log(`✅ Order Created: ${order.id} for ₹${order.amount} (${order.status})`);

  // 3. Simulate Incoming FamApp Alert Email
  const testTxnId = `FMPIB${Math.floor(1000000000 + Math.random() * 9000000000)}`;
  const testUtr = `${Math.floor(100000000000 + Math.random() * 900000000000)}`;

  const mockEmail = `Hey Sagamreddy Shanmukha Sai Reddy,
You have successfully received
₹${testAmount.toFixed(1)}
from SAGAMREDDY SHANMUKHA SAI REDDY
Transaction ID :
${testTxnId}
Date :
10:45 AM IST, 02 November 2026
Updated Balance :
₹150.00
UTR :
${testUtr}
If this was not done by you, call us...`;

  const parsed = parseFamPayEmail(mockEmail);
  console.log(`📩 Simulated Email: ₹${parsed.amount} | Txn: ${parsed.transactionId} | UTR: ${parsed.utr}`);

  // 4. Process Incoming Payment
  const result = await processIncomingPayment(parsed, mockEmail);
  assert.strictEqual(result.status, 'PAID', 'Payment should reconcile and mark order PAID');
  assert.strictEqual(result.orderId, testOrderId, 'Should match our test order ID');
  console.log(`✅ Auto-Reconciliation Succeeded: Order ${result.orderId} marked PAID!`);

  // 5. Verify Database State
  const { data: updatedOrder } = await supabase
    .from('orders')
    .select('*')
    .eq('id', testOrderId)
    .single();

  assert.strictEqual(updatedOrder.status, 'PAID');
  assert.strictEqual(updatedOrder.transaction_id, testTxnId);
  assert.strictEqual(updatedOrder.utr, testUtr);
  console.log(`✅ Database State Confirmed: Order status=PAID, TxnID=${updatedOrder.transaction_id}, UTR=${updatedOrder.utr}`);

  // 6. Test Replay Attack Prevention
  console.log('🔒 Testing Replay Attack / Double Claim Prevention...');
  const replayResult = await processIncomingPayment(parsed, mockEmail);
  assert.strictEqual(replayResult.status, 'ALREADY_CLAIMED', 'Duplicate payment must be rejected');
  console.log('✅ Replay Attack Blocked: Duplicate payment rejected with ALREADY_CLAIMED!');

  // Cleanup test order
  await supabase.from('orders').delete().eq('id', testOrderId);
  await supabase.from('fampay_ledger').delete().eq('transaction_id', testTxnId);

  console.log('\n🎉 ALL INTEGRATION TESTS PASSED WITH 100% SUCCESS!');
  process.exit(0);
}

runIntegrationTest().catch((err) => {
  console.error('❌ Integration Test Failed:', err);
  process.exit(1);
});
