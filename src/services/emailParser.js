/**
 * Exact parser for FamPay / FamApp transaction receipt emails.
 * Verified against live production emails received on Nov 02, 2026.
 */

// Every distinct value a pattern captures in the text.
function distinctValues(text, pattern, normalize = (v) => v) {
  return [...new Set([...text.matchAll(pattern)].map((m) => normalize(m[1])))];
}

function parseFamPayEmail(emailText) {
  if (!emailText || typeof emailText !== 'string') {
    return null;
  }

  // Normalize line endings and whitespace
  const text = emailText.replace(/\r\n/g, '\n');
  const toNumber = (value) => parseFloat(value.replace(/,/g, ''));

  // The payer chooses their own UPI display name, and it is printed inside the receipt. A name like
  // "Transaction ID ABC123" or "UTR 111111111111" must not be able to replace the real values, so a
  // receipt carrying two different values for any of these fields is rejected instead of guessed at.

  // 1. Amount: handles "₹1.0", "₹1.00", "₹499.0", "₹1,250.00"
  const amounts = distinctValues(text, /successfully received\s*\n*\s*₹\s*([\d,]+(?:\.\d{1,2})?)/gi, toNumber);

  // 2. Sender Name: handles "from NAME at 11:37 AM" and "from NAME\nTransaction ID"
  const senderMatch = text.match(/from\s+([A-Za-z\s]+?)(?=\s+at\s+\d|\s*Transaction ID|\n\s*Transaction|\s*with transaction)/i);

  // 3. FamPay Transaction ID: handles "Transaction ID :\nFMPIB..." and "with transaction id FMPIB..."
  //    Real IDs contain digits, so ordinary words after the phrase are not treated as IDs.
  const txnIds = distinctValues(text, /(?:Transaction ID|transaction id)\s*[:\s]+\s*([A-Za-z0-9]+)/gi).filter((id) => /\d/.test(id));

  // 4. Date & Time: handles "Date :\n10:24 AM..." and "at 11:37 AM IST, 02 November 2026"
  const dateMatch = text.match(/(?:Date\s*:\s*\n*|at\s+)(\d{1,2}:\d{2}\s*(?:AM|PM)[^\n\r.]+)/i);

  // 5. Updated Balance: handles "Updated Balance :\n₹3.02" and "Your updated balance is ₹5.02"
  const balanceMatch = text.match(/(?:Updated Balance|updated balance is)\s*[:\s]*₹\s*([\d,]+(?:\.\d{1,2})?)/i);

  // 6. 12-Digit Bank UTR: handles "UTR :\n945756689182" and "UTR: 815576951710"
  const utrs = distinctValues(text, /UTR\s*[:\s]+\s*(\d{12})/gi);

  if (amounts.length !== 1 || txnIds.length !== 1 || utrs.length > 1) {
    return null; // Not a valid FamApp credit receipt
  }
  if (!Number.isFinite(amounts[0]) || amounts[0] <= 0) {
    return null;
  }

  return {
    amount: amounts[0],
    senderName: senderMatch ? senderMatch[1].replace(/\s+/g, ' ').trim() : null,
    transactionId: txnIds[0],
    dateRaw: dateMatch ? dateMatch[1].trim() : null,
    updatedBalance: balanceMatch ? parseFloat(balanceMatch[1].replace(/,/g, '')) : null,
    utr: utrs[0] || null
  };
}

module.exports = { parseFamPayEmail };
