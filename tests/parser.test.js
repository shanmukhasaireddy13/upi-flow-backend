const assert = require('assert');
const { parseFamPayEmail } = require('../src/services/emailParser');

console.log('🧪 Starting Parser & Matcher Unit Tests...\n');

// Test Case 1: Live email from Nov 02, 2026 (Includes UTR)
const liveEmailNov2026 = `Hey Aarav Sharma,
You have successfully received
₹1.0
from AARAV SHARMA
Transaction ID :
FMPIB6910395893
Date :
10:24 AM IST, 02 November 2026
Updated Balance :
₹3.02
UTR :
945756689182
If this was not done by you, call us and report this
at +91 8095858881 or email us at
support@famapp.in
Best, Fam.`;

const parsed1 = parseFamPayEmail(liveEmailNov2026);
assert.strictEqual(parsed1.amount, 1.0, 'Amount should be 1.0');
assert.strictEqual(parsed1.transactionId, 'FMPIB6910395893', 'Transaction ID should be FMPIB6910395893');
assert.strictEqual(parsed1.utr, '945756689182', 'UTR should be 945756689182');
assert.strictEqual(parsed1.senderName, 'AARAV SHARMA', 'Sender name should match');
assert.strictEqual(parsed1.updatedBalance, 3.02, 'Updated balance should be 3.02');
console.log('✅ Test 1 Passed: Live email parsed with 100% accuracy (including UTR).');

// Test Case 2: Multi-thousand rupee amount with comma formatting
const largeAmountEmail = `Hey Aarav Sharma,
You have successfully received
₹1,499.00
from RAHUL SHARMA
Transaction ID :
FMPIB7788990011
Date :
02:15 PM IST, 02 November 2026
Updated Balance :
₹1,502.02
UTR :
887766554433
If this was not done by you, call us...`;

const parsed2 = parseFamPayEmail(largeAmountEmail);
assert.strictEqual(parsed2.amount, 1499.0, 'Amount with comma should parse to 1499.0');
assert.strictEqual(parsed2.transactionId, 'FMPIB7788990011', 'Transaction ID should match');
assert.strictEqual(parsed2.utr, '887766554433', 'UTR should match');
assert.strictEqual(parsed2.senderName, 'RAHUL SHARMA', 'Sender name should match');
console.log('✅ Test 2 Passed: Comma-formatted rupee amounts parse cleanly.');

// Test Case 3: The payer controls their UPI display name, which is printed inside the receipt
const injectedName = (name) => `Hey Merchant,
You have successfully received
₹500.0
from ${name}
Transaction ID :
FMPIB6910395893
UTR :
945756689182`;
assert.strictEqual(parseFamPayEmail(injectedName('Transaction ID FAKE12345')), null, 'A second transaction ID must reject the receipt');
assert.strictEqual(parseFamPayEmail(injectedName('UTR 111111111111')), null, 'A second UTR must reject the receipt');
assert.strictEqual(parseFamPayEmail(injectedName('successfully received ₹1.0')), null, 'A second amount must reject the receipt');
assert.strictEqual(parseFamPayEmail(injectedName('AARAV SHARMA')).transactionId, 'FMPIB6910395893', 'A normal name still parses');
console.log('✅ Test 3 Passed: Values injected through the payer name are rejected.');

console.log('\n🎉 ALL TESTS PASSED SUCCESSFULLY!');
