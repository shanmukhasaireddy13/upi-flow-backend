const assert = require('assert');
const { parseFamPayEmail } = require('../src/services/emailParser');
const { compareNames } = require('../src/services/matcher');

console.log('🧪 Starting Parser & Matcher Unit Tests...\n');

// Test Case 1: Live email from Nov 02, 2026 (Includes UTR)
const liveEmailNov2026 = `Hey Sagamreddy Shanmukha Sai Reddy,
You have successfully received
₹1.0
from SAGAMREDDY SHANMUKHA SAI REDDY
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
assert.strictEqual(parsed1.senderName, 'SAGAMREDDY SHANMUKHA SAI REDDY', 'Sender name should match');
assert.strictEqual(parsed1.updatedBalance, 3.02, 'Updated balance should be 3.02');
console.log('✅ Test 1 Passed: Live email parsed with 100% accuracy (including UTR).');

// Test Case 2: Multi-thousand rupee amount with comma formatting
const largeAmountEmail = `Hey Sagamreddy Shanmukha Sai Reddy,
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

// Test Case 3: Name token matching (Fuzzy token comparison)
assert.strictEqual(
  compareNames('Shanmukha Reddy', 'SAGAMREDDY SHANMUKHA SAI REDDY'),
  true,
  'Customer "Shanmukha Reddy" should match bank sender "SAGAMREDDY SHANMUKHA SAI REDDY"'
);
assert.strictEqual(
  compareNames('Rahul', 'SAGAMREDDY SHANMUKHA SAI REDDY'),
  false,
  'Customer "Rahul" should NOT match "SAGAMREDDY SHANMUKHA SAI REDDY"'
);
assert.strictEqual(
  compareNames('Amit Kumar', 'AMIT SINGH'),
  true,
  '"Amit Kumar" shares token "amit" with "AMIT SINGH"'
);
console.log('✅ Test 3 Passed: Name token matching works as expected.');

console.log('\n🎉 ALL TESTS PASSED SUCCESSFULLY!');
