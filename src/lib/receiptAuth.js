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
 * Returns { ok: true } or { ok: false, reason }.
 */
function verifyReceiptSender(headers) {
  const list = Array.isArray(headers) ? headers : [];
  const find = (name) => list.filter((h) => String(h.name).toLowerCase() === name).map((h) => String(h.value).replace(/\s+/g, ' '));

  const from = find('from')[0];
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
