// Go-live check: runs the real backend against the REAL Supabase project from backend/.env.
// It creates two throwaway merchants, exercises the full payment flow through HTTP, then deletes
// everything it created and confirms real merchants' data did not change. Real merchants, their
// webhooks and their Gmail accounts are never touched. Takes about a minute.
// Usage: node tests/live_e2e.test.js
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { supabase } = require('../src/config/supabase');
const { signToken } = require('../src/lib/session');

const RUN = Date.now().toString(36);
const PORT = 5600 + Math.floor(Math.random() * 300);
const BASE = `http://localhost:${PORT}`;
const PASSWORD = crypto.randomBytes(18).toString('base64url');
const results = { pass: 0, fail: [], blocked: [] };
const created = { merchants: [], transactions: [] };
let serverLog = '';
let seq = 0;

function check(name, ok, detail = '') {
  if (ok) {
    results.pass += 1;
    console.log(`  ok    ${name}`);
  } else {
    results.fail.push(name);
    console.log(`  FAIL  ${name} ${detail}`);
  }
}

function startServer(env = {}) {
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: path.resolve(__dirname, '..'),
    // Empty values stop this copy from opening the real mailbox or renewing real Gmail watches.
    env: { ...process.env, PORT: String(env.PORT || PORT), IMAP_USER: '', IMAP_PASSWORD: '', GOOGLE_PUBSUB_TOPIC: '', ...env }
  });
  child.stdout.on('data', (d) => { serverLog += d; });
  child.stderr.on('data', (d) => { serverLog += d; });
  return child;
}

async function waitForHealth(base) {
  for (let i = 0; i < 40; i++) {
    try {
      if ((await fetch(`${base}/health`)).ok) return true;
    } catch (err) { /* still starting */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function api(method, url, { body, headers = {}, base = BASE } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (err) { /* plain text response */ }
  return { status: res.status, body: json, headers: res.headers };
}

const bearer = (t) => ({ Authorization: `Bearer ${t}` });

function receipt(amountText) {
  seq += 1;
  const transactionId = `FMPIBE2E${RUN}${seq}`.toUpperCase();
  const utr = String(900000000000 + ((Date.now() % 90000000) * 1000 + seq) % 99999999999);
  created.transactions.push(transactionId);
  return {
    transactionId,
    utr,
    text: `Hey Test,\nYou have successfully received\n₹${amountText}\nfrom E2E PAYER\nTransaction ID :\n${transactionId}\nDate :\n10:24 AM IST, 02 November 2026\nUpdated Balance :\n₹3.02\nUTR :\n${utr}\nBest, Fam.`
  };
}

const deliverReceipt = (rawEmail, merchantId) => api('POST', '/api/webhooks/email', {
  body: { rawEmail, merchant_id: merchantId },
  headers: { 'x-gateway-secret': process.env.GATEWAY_SECRET }
});

const claim = (order_id, reference) => api('POST', '/api/orders/verify-utr', { body: { order_id, reference } });

async function snapshotRealData(testIds) {
  const notTest = (q) => (testIds.length ? q.not('merchant_id', 'in', `(${testIds.join(',')})`) : q);
  const { data: merchants } = await supabase.from('merchants').select('id, api_key, upi_id, webhook_url, webhook_secret, password_hash, google_email').order('id');
  const { data: orders } = await notTest(supabase.from('orders').select('id, status, amount, transaction_id, updated_at')).order('id');
  const { data: ledger } = await notTest(supabase.from('fampay_ledger').select('transaction_id, claimed, order_id')).order('transaction_id');
  return JSON.stringify({ merchants: merchants.filter((m) => !testIds.includes(m.id)), orders, ledger });
}

async function main() {
  const before = await snapshotRealData([]);

  // Webhook receiver standing in for a merchant's server.
  const hooks = [];
  let failNextHook = 0;
  const receiver = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      hooks.push({ raw, headers: req.headers });
      res.statusCode = failNextHook > 0 ? 500 : 200;
      failNextHook = Math.max(0, failNextHook - 1);
      res.end('ok');
    });
  });
  await new Promise((r) => receiver.listen(0, r));
  const hookUrl = `http://localhost:${receiver.address().port}/hook`;

  const server = startServer();
  try {
    check('backend boots against live Supabase', await waitForHealth(BASE));
    await new Promise((r) => setTimeout(r, 1500));

    console.log('\nAccounts and login');
    const emailA = `e2e-a-${RUN}@upiflow-test.invalid`;
    let r = await api('POST', '/api/auth/signup', { body: { name: `E2E A ${RUN}`, email: emailA, password: PASSWORD } });
    check('signup creates a merchant', r.status === 201 && r.body.token, JSON.stringify(r.body));
    const tokenA = r.body.token;
    const idA = r.body.merchant.id;
    created.merchants.push(idA);
    check('signup response has no secrets', !('password_hash' in r.body.merchant) && !('api_key' in r.body.merchant));

    r = await api('POST', '/api/auth/signup', { body: { name: 'dup', email: emailA, password: PASSWORD } });
    check('duplicate email is refused', r.status === 409);
    r = await api('POST', '/api/auth/login', { body: { email: emailA, password: 'wrong-password' } });
    check('wrong password is refused', r.status === 401);
    r = await api('POST', '/api/auth/login', { body: { email: emailA, password: PASSWORD } });
    check('correct password logs in', r.status === 200 && r.body.token);
    r = await api('GET', '/api/auth/me', { headers: bearer(tokenA) });
    check('session token works', r.status === 200 && r.body.merchant.id === idA);

    const emailB = `e2e-b-${RUN}@upiflow-test.invalid`;
    r = await api('POST', '/api/auth/signup', { body: { name: `E2E B ${RUN}`, email: emailB, password: PASSWORD, upi_id: `e2eb${RUN}@fam` } });
    const tokenB = r.body.token;
    const idB = r.body.merchant.id;
    created.merchants.push(idB);

    console.log('\nLogin bypass attempts');
    r = await api('GET', '/api/orders/list', { headers: { 'x-api-key': `x,email.eq.${emailA}` } });
    check('filter injection in x-api-key is refused', r.status === 401);
    r = await api('GET', '/api/orders/list', { headers: bearer(`sk_x,email.eq.${emailA}`) });
    check('filter injection in Bearer is refused', r.status === 401);
    r = await api('GET', '/api/auth/me', { headers: bearer(signToken({ mid: idA, purpose: 'google_oauth' })) });
    check('OAuth state token cannot log in', r.status === 401);

    console.log('\nSettings and API keys');
    r = await api('POST', '/api/merchant/settings', { headers: bearer(tokenA), body: { upi_id: 'someone@okaxis' } });
    check('non-FamPay UPI ID is refused', r.status === 400);
    r = await api('POST', '/api/merchant/settings', { headers: bearer(tokenA), body: { webhook_url: 'https://127.0.0.1/x' } });
    check('internal webhook URL is refused', r.status === 400);
    r = await api('POST', '/api/merchant/settings', { headers: bearer(tokenA), body: { upi_id: `e2ea${RUN}@fam`, upi_name: 'E2E A', webhook_url: hookUrl } });
    check('valid settings save', r.status === 200, JSON.stringify(r.body));

    r = await api('POST', '/api/orders', { headers: bearer(tokenA), body: { amount: 100, customer_name: 'x' } });
    check('order needs a connected Gmail first', r.status === 400);

    // Connecting Gmail needs a real Google consent, so the test merchants get a placeholder address.
    await supabase.from('merchants').update({ google_email: emailA }).eq('id', idA);
    await supabase.from('merchants').update({ google_email: emailB, upi_name: 'E2E B' }).eq('id', idB);

    r = await api('GET', '/api/merchant/profile', { headers: bearer(tokenA) });
    check('profile returns credentials to the session', r.status === 200 && r.body.merchant.api_key);
    let apiKey = r.body.merchant.api_key;
    const webhookSecret = r.body.merchant.webhook_secret;

    r = await api('GET', '/api/merchant/profile', { headers: { 'x-api-key': apiKey } });
    check('API key cannot read account credentials', r.status === 403);
    r = await api('POST', '/api/merchant/settings', { headers: { 'x-api-key': apiKey }, body: { upi_id: 'thief@fam' } });
    check('API key cannot change the UPI ID', r.status === 403);
    r = await api('POST', '/api/merchant/rotate-api-key', { headers: bearer(tokenA) });
    const oldKey = apiKey;
    apiKey = r.body.api_key;
    r = await api('GET', '/api/orders/list', { headers: { 'x-api-key': oldKey } });
    check('old API key stops working after rotation', r.status === 401);
    r = await api('GET', '/api/orders/list', { headers: { 'x-api-key': apiKey } });
    check('new API key works', r.status === 200);

    console.log('\nOrder payloads');
    for (const bad of ['1e3', '0x10', [100], 0, 0.5, -5, '100.999', 100001, true, null]) {
      r = await api('POST', '/api/orders', { headers: { 'x-api-key': apiKey }, body: { amount: bad, customer_name: 'x' } });
      check(`amount ${JSON.stringify(bad)} is refused`, r.status === 400);
    }
    r = await api('POST', '/api/orders', { headers: { 'x-api-key': apiKey }, body: { amount: 10, customer_name: 'x', metadata: { a: 'x'.repeat(5000) } } });
    check('oversized metadata is refused', r.status === 400);
    r = await api('POST', '/api/orders', { headers: { 'x-api-key': apiKey }, body: { amount: 10, customer_name: 'x', success_url: 'javascript:alert(1)' } });
    check('javascript: success_url is refused', r.status === 400);

    const newOrder = async (amount, extra = {}, auth = { 'x-api-key': apiKey }) => {
      const res = await api('POST', '/api/orders', { headers: auth, body: { amount, customer_name: 'Asha Verma', ...extra } });
      if (res.status !== 201) throw new Error(`order create failed: ${res.status} ${JSON.stringify(res.body)}`);
      return res.body;
    };

    console.log('\nAutomatic confirmation');
    const paidFlow = await newOrder(499, { success_url: 'https://shop.example/ok?o={ORDER_ID}', metadata: { sku: 'internal-1' } });
    check('order has QR, UPI link and checkout URL', paidFlow.qr_code && paidFlow.upi_uri.includes('am=499.00') && paidFlow.checkout_url.includes(paidFlow.order_id));
    r = await api('GET', `/api/orders/status/${paidFlow.order_id}`);
    check('public status hides success_url before payment', r.status === 200 && r.body.success_url === null);
    check('public status hides metadata', r.body.metadata === undefined);
    check('public status has no merchant secrets', !JSON.stringify(r.body).includes(apiKey) && !JSON.stringify(r.body).includes(webhookSecret));

    r = await api('POST', '/api/webhooks/email', { body: { rawEmail: 'x', merchant_id: idA }, headers: { 'x-gateway-secret': 'wrong' } });
    check('email ingestion refuses a wrong secret', r.status === 403);

    const payment = receipt('499.0');
    r = await deliverReceipt(payment.text, idA);
    check('exact payment marks the lone order PAID', r.status === 200 && r.body.result.status === 'PAID', JSON.stringify(r.body));
    r = await api('GET', `/api/orders/status/${paidFlow.order_id}`);
    check('status shows PAID and reveals success_url', r.body.status === 'PAID' && r.body.success_url === `https://shop.example/ok?o=${paidFlow.order_id}`);
    check('status carries the UTR', r.body.payment && r.body.payment.utr === payment.utr);
    r = await api('GET', '/api/merchant/ledger', { headers: bearer(tokenA) });
    check('ledger shows the claimed payment', r.status === 200 && r.body.ledger.some((l) => l.transaction_id === payment.transactionId && l.claimed));
    r = await api('GET', '/api/merchant/ledger', { headers: bearer(tokenB) });
    check('another merchant cannot see the payment', r.status === 200 && !r.body.ledger.some((l) => l.transaction_id === payment.transactionId));
    r = await deliverReceipt(payment.text, idA);
    check('replayed receipt is refused', r.body.result.status === 'ALREADY_CLAIMED', JSON.stringify(r.body));
    r = await deliverReceipt(payment.text, idB);
    check('a used payment cannot pay another merchant', r.body.result.status === 'ALREADY_CLAIMED');

    await new Promise((res) => setTimeout(res, 800));
    const hook = hooks.find((h) => h.raw.includes(paidFlow.order_id));
    check('order.paid webhook delivered', Boolean(hook));
    if (hook) {
      const expected = crypto.createHmac('sha256', webhookSecret).update(`${hook.headers['x-gateway-timestamp']}.${hook.raw}`).digest('hex');
      check('webhook signature verifies', hook.headers['x-gateway-signature'] === expected);
      const event = JSON.parse(hook.raw);
      check('webhook carries amount, UTR and metadata', event.event === 'order.paid' && Number(event.data.amount) === 499 && event.data.utr === payment.utr && event.data.metadata.sku === 'internal-1');
    }

    console.log('\nAmounts in the database');
    for (const [amount, text] of [[19.99, '19.99'], ['1,499.50', '1,499.50'], [0.1 + 1.2, null], [1, '1.0'], [100000, '1,00,000.00']]) {
      if (text === null) continue;
      const order = await newOrder(amount);
      r = await deliverReceipt(receipt(text).text, idA);
      check(`₹${text} matches exactly`, r.body.result && r.body.result.status === 'PAID' && r.body.result.orderId === order.order_id, JSON.stringify(r.body));
    }
    const under = await newOrder(5000);
    const small = receipt('4999.99');
    r = await deliverReceipt(small.text, idA);
    check('underpayment does not match and is not stored', r.body.result.status === 'IGNORED_NO_MATCHING_ORDER', JSON.stringify(r.body));
    const { data: stored } = await supabase.from('fampay_ledger').select('id').eq('transaction_id', small.transactionId);
    check('unrelated payment is not written to the ledger', stored.length === 0);
    r = await api('GET', `/api/orders/status/${under.order_id}`);
    check('underpaid order stays unpaid', r.body.status === 'PENDING');

    console.log('\nTwo open orders for one amount');
    const orderX = await newOrder(777);
    const orderY = await newOrder(777, { customer_name: 'E2E Payer' });
    const shared = receipt('777.0');
    r = await deliverReceipt(shared.text, idA);
    check('nothing auto-confirms, even with a matching name', r.body.result.status === 'COLLISION_PENDING_CONFIRMATION', JSON.stringify(r.body));
    r = await claim(orderX.order_id, '111111111111');
    check('wrong UTR is refused with no amount revealed', r.status === 400 && !r.body.message.includes('₹'));
    r = await claim(orderX.order_id, shared.utr);
    check('real UTR confirms the order', r.status === 200 && r.body.success, JSON.stringify(r.body));
    r = await claim(orderY.order_id, shared.utr);
    check('the same UTR cannot pay a second order', r.status === 400 && !r.body.success);
    r = await api('GET', `/api/orders/status/${orderY.order_id}`);
    check('second order stays unpaid', r.body.status === 'PENDING');

    console.log('\nClaims across merchants and time');
    const foreignOrder = await newOrder(888, {}, bearer(tokenB));
    await newOrder(888);
    await newOrder(888);
    const foreign = receipt('888.0');
    await deliverReceipt(foreign.text, idA);
    r = await claim(foreignOrder.order_id, foreign.utr);
    check("another merchant's customer cannot claim this payment", r.status === 400);

    const staleTxn = receipt('333.0');
    await supabase.from('fampay_ledger').insert({
      transaction_id: staleTxn.transactionId, utr: staleTxn.utr, amount: 333, merchant_id: idA,
      environment: 'production', claimed: false, received_at: new Date(Date.now() - 30 * 60000).toISOString()
    });
    const fresh = await newOrder(333);
    r = await deliverReceipt(staleTxn.text, idA);
    check('old unclaimed payment does not auto-settle a new order', r.body.result.status === 'IGNORED_NO_MATCHING_ORDER', JSON.stringify(r.body));
    r = await claim(fresh.order_id, staleTxn.utr);
    check('old unclaimed payment cannot be claimed by UTR', r.status === 400);

    console.log('\nLate payments');
    const late = await newOrder(222);
    await supabase.from('orders').update({ expires_at: new Date(Date.now() - 60000).toISOString() }).eq('id', late.order_id);
    r = await api('GET', `/api/orders/status/${late.order_id}`);
    check('expired order reports EXPIRED with no QR', r.body.status === 'EXPIRED' && !r.body.qr_code);
    r = await deliverReceipt(receipt('222.0').text, idA);
    check('payment just after expiry still confirms', r.body.result.status === 'PAID', JSON.stringify(r.body));

    console.log('\nSimultaneous claims');
    for (let round = 0; round < 3; round++) {
      const a = await newOrder(600 + round);
      const b = await newOrder(600 + round);
      const race = receipt(`${600 + round}.0`);
      await deliverReceipt(race.text, idA);
      const [one, two] = await Promise.all([claim(a.order_id, race.utr), claim(b.order_id, race.utr)]);
      const wins = [one, two].filter((x) => x.body.success).length;
      check(`one payment raced at two orders pays exactly one (round ${round + 1})`, wins === 1, `${one.status}/${two.status}`);
    }

    console.log('\nDatabase function');
    const rpcOrder = await newOrder(444);
    await deliverReceipt(receipt('444.0').text, idA);
    const orphan = receipt('445.0');
    await supabase.from('fampay_ledger').insert({ transaction_id: orphan.transactionId, utr: orphan.utr, amount: 444, merchant_id: idA, environment: 'production', claimed: false });
    const rpc = await supabase.rpc('reconcile_fampay_payment', { p_order_id: rpcOrder.order_id, p_transaction_id: orphan.transactionId, p_utr: orphan.utr });
    check('function refuses a paid order', !rpc.error && rpc.data === false, JSON.stringify(rpc));
    const { data: orphanRow } = await supabase.from('fampay_ledger').select('claimed').eq('transaction_id', orphan.transactionId).single();
    check('refused payment stays unclaimed (rollback works)', orphanRow.claimed === false);

    console.log('\nPub/Sub endpoint');
    const push = (qs, payload) => api('POST', `/api/webhooks/gmail${qs}`, { body: { message: { data: Buffer.from(JSON.stringify(payload)).toString('base64') } } });
    r = await push('', { emailAddress: emailA, historyId: 1 });
    check('push without a token is refused', r.status === 401);
    r = await push('?token=wrong', { emailAddress: emailA, historyId: 1 });
    check('push with a wrong token is refused', r.status === 401);
    r = await push(`?token=${process.env.PUBSUB_VERIFICATION_TOKEN}`, { emailAddress: `unknown-${RUN}@upiflow-test.invalid`, historyId: 1 });
    check('push with the right token is accepted', r.status === 200);

    console.log('\nCORS');
    const cors = async (url, origin) => (await fetch(BASE + url, { headers: { Origin: origin } })).headers.get('access-control-allow-origin');
    check('dashboard route refuses other Vercel sites', (await cors('/api/merchant/profile', 'https://evil.vercel.app')) === null);
    check('checkout route allows any site', (await cors(`/api/orders/status/${late.order_id}`, 'https://shop.example')) === '*');

    console.log('\nIdempotency');
    const { error: columnError } = await supabase.from('orders').select('idempotency_key').limit(1);
    if (columnError) {
      results.blocked.push('Idempotency-Key: orders.idempotency_key is missing. Run migrations/005 in Supabase.');
      console.log('  BLOCKED  migration 005 has not been run');
      const noKey = await newOrder(11);
      check('orders without the header still work', Boolean(noKey.order_id));
    } else {
      const key = `e2e-${RUN}`;
      const first = await api('POST', '/api/orders', { headers: { 'x-api-key': apiKey, 'Idempotency-Key': key }, body: { amount: 12, customer_name: 'x' } });
      const second = await api('POST', '/api/orders', { headers: { 'x-api-key': apiKey, 'Idempotency-Key': key }, body: { amount: 12, customer_name: 'x' } });
      check('retry returns the same order', first.status === 201 && second.status === 200 && first.body.order_id === second.body.order_id, `${first.status}/${second.status}`);
      const conflict = await api('POST', '/api/orders', { headers: { 'x-api-key': apiKey, 'Idempotency-Key': key }, body: { amount: 13, customer_name: 'x' } });
      check('same key with a different amount is refused', conflict.status === 409);
      const [p, q] = await Promise.all([1, 2].map(() => api('POST', '/api/orders', { headers: { 'x-api-key': apiKey, 'Idempotency-Key': `${key}-race` }, body: { amount: 14, customer_name: 'x' } })));
      check('two identical requests at once create one order', p.body.order_id === q.body.order_id, `${p.status}/${q.status}`);
      const dup = await supabase.from('orders').update({ transaction_id: payment.transactionId }).eq('id', first.body.order_id);
      check('database refuses one transaction on two orders', dup.error && dup.error.code === '23505', JSON.stringify(dup.error));
    }

    console.log('\nWebhook retry (waits 32 seconds)');
    failNextHook = 1;
    const retried = await newOrder(555);
    await deliverReceipt(receipt('555.0').text, idA);
    await new Promise((res) => setTimeout(res, 32000));
    const attempts = hooks.filter((h) => h.raw.includes(retried.order_id));
    check('failed webhook is retried', attempts.length === 2, `attempts=${attempts.length}`);
    check('retry keeps the same event id', attempts.length === 2 && JSON.parse(attempts[0].raw).id === JSON.parse(attempts[1].raw).id);

    console.log('\nProduction mode');
    const prodPort = PORT + 1;
    const prodBase = `http://localhost:${prodPort}`;
    const prod = startServer({ PORT: String(prodPort), NODE_ENV: 'production' });
    try {
      check('backend boots with NODE_ENV=production', await waitForHealth(prodBase));
      r = await api('POST', '/api/auth/login', { base: prodBase, body: { email: emailA, password: PASSWORD } });
      check('login works in production mode', r.status === 200);
      r = await api('POST', '/api/merchant/settings', { base: prodBase, headers: bearer(r.body.token), body: { webhook_url: hookUrl } });
      check('localhost webhooks are refused in production', r.status === 400);
      r = await api('POST', '/api/orders', { base: prodBase, headers: { 'x-api-key': apiKey }, body: { amount: 50, customer_name: 'x' } });
      check('orders work in production mode', r.status === 201, JSON.stringify(r.body));
    } finally {
      prod.kill();
    }

    const schemaLines = serverLog.split('\n').filter((l) => l.includes('[SCHEMA]') || l.includes('Unhandled'));
    console.log('\nServer notes:', [...new Set(schemaLines)].join(' | ') || 'none');
  } finally {
    server.kill();
    receiver.close();
    console.log('\nCleanup');
    if (created.merchants.length) {
      await supabase.from('fampay_ledger').delete().in('merchant_id', created.merchants);
      await supabase.from('fampay_ledger').delete().in('transaction_id', created.transactions);
      await supabase.from('orders').delete().in('merchant_id', created.merchants);
      await supabase.from('merchants').delete().in('id', created.merchants);
    }
    const after = await snapshotRealData([]);
    check('test data removed and real data unchanged', before === after);
  }

  console.log(`\n${results.pass} passed, ${results.fail.length} failed, ${results.blocked.length} blocked`);
  results.fail.forEach((f) => console.log(`  FAILED: ${f}`));
  results.blocked.forEach((b) => console.log(`  BLOCKED: ${b}`));
  if (results.fail.length) {
    const errors = serverLog.split('\n').filter((l) => /error|unhandled/i.test(l)).slice(-15);
    console.log('\nServer errors:\n' + errors.join('\n'));
  }
  process.exit(results.fail.length ? 1 : 0);
}

main().catch((err) => {
  console.error('Test run stopped:', err);
  console.log('Server log tail:\n' + serverLog.slice(-1500));
  process.exit(1);
});
