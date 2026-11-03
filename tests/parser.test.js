const assert = require('assert');
const { parseFamPayEmail } = require('../src/services/emailParser');
const { compareNames, matchesPayer } = require('../src/services/matcher');

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

// Test Case 3: Name token matching (Fuzzy token comparison)
assert.strictEqual(
  compareNames('Aarav Sharma', 'SHARMA AARAV KUMAR'),
  true,
  'Customer "Aarav Sharma" should match bank sender "SHARMA AARAV KUMAR"'
);
assert.strictEqual(
  compareNames('Rahul', 'SHARMA AARAV KUMAR'),
  false,
  'Customer "Rahul" should NOT match "SHARMA AARAV KUMAR"'
);
assert.strictEqual(
  compareNames('Amit Kumar', 'AMIT SINGH'),
  true,
  '"Amit Kumar" shares token "amit" with "AMIT SINGH"'
);
console.log('✅ Test 3 Passed: Name token matching works as expected.');

// Test Case 4: matchesPayer evaluates both customer_name and customer_email
assert.strictEqual(
  matchesPayer(
    { customer_name: 'test_user', customer_email: 'aarav.sharma@gmail.com' },
    'SHARMA AARAV KUMAR'
  ),
  true,
  'Email handle with matching name tokens should match payer'
);
assert.strictEqual(
  matchesPayer(
    { customer_name: 'ihackers143', customer_email: 'ihackers143@gmail.com' },
    'SHARMA AARAV KUMAR'
  ),
  false,
  'Unrelated handle should not match'
);
console.log('✅ Test 4 Passed: matchesPayer email handle token fallback works as expected.');

console.log('\n🎉 ALL TESTS PASSED SUCCESSFULLY!');
