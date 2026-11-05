// Payment receipts are trusted only when the receiving mail server (Gmail) confirms they really came
// from FamApp. Matching on the subject, body text or the From header alone is not enough: anyone can
// send an email that says "successfully received ₹499" from a forged address.
const SENDER_DOMAINS = (process.env.RECEIPT_SENDER_DOMAINS || 'famapp.in')
  .split(',')
  .map((d) => d.trim().toLowerCase())
  .filter(Boolean);

const TRUSTED_AUTHSERV_ID = (process.env.RECEIPT_AUTHSERV_ID || 'mx.google.com').toLowerCase();

function isSenderDomain(domain) {
  const d = String(domain || '').toLowerCase().replace(/\.$/, '');
  return SENDER_DOMAINS.some((allowed) => d === allowed || d.endsWith(`.${allowed}`));
}

function fromDomain(fromValue) {
  const match = String(fromValue || '').match(/@([A-Za-z0-9.-]+)>?\s*$/);
  return match ? match[1] : null;
}

// Gmail ignores dots and +tags, so a.b+shop@gmail.com and ab@gmail.com are the same mailbox.
function normalizeMailbox(address) {
  const [local, domain] = String(address || '').trim().toLowerCase().split('@');
  if (!local || !domain) return null;
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    return `${local.split('+')[0].replace(/\./g, '')}@gmail.com`;
  }
  return `${local}@${domain}`;
}

function addressesIn(headerValue) {
  return (String(headerValue || '').match(/[^\s<>,;"']+@[^\s<>,;"']+/g) || []).map(normalizeMailbox);
}

/**
 * Checks one Authentication-Results value for an aligned DKIM pass or a DMARC pass for the sender domain.
 */
function hasAlignedPass(results) {
  const methods = results.split(';').slice(1).map((m) => m.trim());
  return methods.some((method) => {
    const dkim = method.match(/^dkim=pass\b.*\bheader\.(?:i=[^\s;]*@|d=)([A-Za-z0-9.-]+)/i);
    if (dkim && isSenderDomain(dkim[1])) return true;
    const dmarc = method.match(/^dmarc=pass\b.*\bheader\.from=([A-Za-z0-9.-]+)/i);
    return Boolean(dmarc && isSenderDomain(dmarc[1]));
  });
}

/**
 * `headers` is the message's header list in order, top first: [{ name, value }].
 * Only the topmost Authentication-Results header is used, because that is the one the receiving
 * server added. Lower ones may have been written by the sender and cannot be trusted.
 *
 * `recipient` is the mailbox being read. A DKIM signature survives resending, so someone with their own
 * FamApp account could send a genuine receipt for a payment THEY received to the merchant's inbox.
 * The signed To header still names them, which is what the recipient check catches.
 * Returns { ok: true } or { ok: false, reason }.
 */
function verifyReceiptSender(headers, { recipient } = {}) {
  const list = Array.isArray(headers) ? headers : [];
  const find = (name) => list.filter((h) => String(h.name).toLowerCase() === name).map((h) => String(h.value).replace(/\s+/g, ' '));

  // Extra headers can be added to a signed message without breaking its signature, so there must be one of each.
  const fromHeaders = find('from');
  const toHeaders = find('to');
  if (fromHeaders.length !== 1 || toHeaders.length !== 1) {
    return { ok: false, reason: 'message must have exactly one From and one To header' };
  }

  const expectedRecipient = normalizeMailbox(recipient);
  if (!expectedRecipient || !addressesIn(toHeaders[0]).includes(expectedRecipient)) {
    return { ok: false, reason: 'receipt is addressed to a different mailbox' };
  }

  const from = fromHeaders[0];
  if (!isSenderDomain(fromDomain(from))) {
    return { ok: false, reason: `sender ${from || '(none)'} is not a FamApp address` };
  }

  const topResults = find('authentication-results')[0];
  if (!topResults) return { ok: false, reason: 'no Authentication-Results header' };

  const authservId = topResults.split(';')[0].trim().toLowerCase();
  if (authservId !== TRUSTED_AUTHSERV_ID) {
    return { ok: false, reason: `Authentication-Results is from ${authservId}, expected ${TRUSTED_AUTHSERV_ID}` };
  }
  if (!hasAlignedPass(topResults)) {
    return { ok: false, reason: 'DKIM/DMARC did not pass for the FamApp domain' };
  }
  return { ok: true };
}

module.exports = { verifyReceiptSender };
