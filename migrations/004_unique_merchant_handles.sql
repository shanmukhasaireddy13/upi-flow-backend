-- UPI Flow: Enforce unique FamPay UPI ID and Google Gmail account per merchant.
-- Multiple accounts cannot share or duplicate the same receiving UPI ID or Gmail notification inbox.

CREATE UNIQUE INDEX IF NOT EXISTS idx_merchants_unique_upi_id
  ON merchants (lower(upi_id))
  WHERE upi_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_merchants_unique_google_email
  ON merchants (lower(google_email))
  WHERE google_email IS NOT NULL;
