/**
 * Exact parser for FamPay / FamApp transaction receipt emails.
 * Verified against live production emails received on Nov 02, 2026.
 */

function parseFamPayEmail(emailText) {
  if (!emailText || typeof emailText !== 'string') {
    return null;
  }

  // Normalize line endings and whitespace
  const text = emailText.replace(/\r\n/g, '\n');

  // 1. Amount: handles "₹1.0", "₹1.00", "₹499.0", "₹1,250.00"
  const amountMatch = text.match(/successfully received\s*\n*\s*₹\s*([\d,]+(?:\.\d{1,2})?)/i);

  // 2. Sender Name: handles "from NAME at 11:37 AM" and "from NAME\nTransaction ID"
  const senderMatch = text.match(/from\s+([A-Za-z\s]+?)(?=\s+at\s+\d|\s*Transaction ID|\n\s*Transaction|\s*with transaction)/i);

  // 3. FamPay Transaction ID: handles "Transaction ID :\nFMPIB..." and "with transaction id FMPIB..."
  const txnIdMatch = text.match(/(?:Transaction ID|transaction id)\s*[:\s]+\s*([A-Za-z0-9]+)/i);

  // 4. Date & Time: handles "Date :\n10:24 AM..." and "at 11:37 AM IST, 02 November 2026"
  const dateMatch = text.match(/(?:Date\s*:\s*\n*|at\s+)(\d{1,2}:\d{2}\s*(?:AM|PM)[^\n\r.]+)/i);

  // 5. Updated Balance: handles "Updated Balance :\n₹3.02" and "Your updated balance is ₹5.02"
  const balanceMatch = text.match(/(?:Updated Balance|updated balance is)\s*[:\s]*₹\s*([\d,]+(?:\.\d{1,2})?)/i);

  // 6. 12-Digit Bank UTR: handles "UTR :\n945756689182" and "UTR: 815576951710"
  const utrMatch = text.match(/UTR\s*[:\s]+\s*(\d{12})/i);

  if (!amountMatch || !txnIdMatch) {
    return null; // Not a valid FamApp credit receipt
  }

  return {
    amount: parseFloat(amountMatch[1].replace(/,/g, '')),
    senderName: senderMatch ? senderMatch[1].replace(/\s+/g, ' ').trim() : null,
    transactionId: txnIdMatch[1].trim(),
    dateRaw: dateMatch ? dateMatch[1].trim() : null,
    updatedBalance: balanceMatch ? parseFloat(balanceMatch[1].replace(/,/g, '')) : null,
    utr: utrMatch ? utrMatch[1].trim() : null
  };
}

module.exports = { parseFamPayEmail };
