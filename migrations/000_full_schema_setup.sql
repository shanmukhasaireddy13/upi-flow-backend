-- ==============================================================================
-- UPI Flow: Full Database Schema Setup (Dev & Production)
-- Follows Supabase & Postgres Best Practices
-- ==============================================================================

-- 1. EXTENSIONS
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 2. MERCHANTS TABLE
CREATE TABLE IF NOT EXISTS public.merchants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(120) NOT NULL,
    email VARCHAR(255) NOT NULL UNIQUE,
    password_hash TEXT,
    api_key VARCHAR(128) NOT NULL UNIQUE,
    test_api_key VARCHAR(128) UNIQUE,
    webhook_secret VARCHAR(128) NOT NULL,
    test_webhook_secret VARCHAR(128),
    webhook_url TEXT,
    test_webhook_url TEXT,
    upi_id VARCHAR(100),
    upi_name VARCHAR(120),
    google_email VARCHAR(255),
    google_access_token TEXT,
    google_refresh_token TEXT,
    google_token_expiry BIGINT,
    gmail_history_id VARCHAR(100),
    gmail_watch_expiry BIGINT,
    brand_color TEXT DEFAULT '#0052ff',
    logo_url TEXT DEFAULT '',
    checkout_title TEXT DEFAULT 'Complete UPI Payment',
    checkout_subtitle TEXT DEFAULT 'Scan with any UPI app to pay',
    support_contact TEXT DEFAULT '',
    onboarding_completed BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Partial unique indexes preventing handle collisions across accounts
CREATE UNIQUE INDEX IF NOT EXISTS idx_merchants_unique_upi_id
  ON public.merchants (lower(upi_id))
  WHERE upi_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_merchants_unique_google_email
  ON public.merchants (lower(google_email))
  WHERE google_email IS NOT NULL;

-- 3. ORDERS TABLE
CREATE TABLE IF NOT EXISTS public.orders (
    id VARCHAR(64) PRIMARY KEY,
    merchant_id UUID NOT NULL REFERENCES public.merchants(id) ON DELETE CASCADE,
    customer_name VARCHAR(120) NOT NULL,
    customer_email VARCHAR(255),
    amount NUMERIC NOT NULL CHECK (amount > 0),
    status VARCHAR(32) DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PAID', 'EXPIRED')),
    transaction_id VARCHAR(128),
    utr VARCHAR(64),
    environment VARCHAR(32) NOT NULL DEFAULT 'production',
    success_url TEXT,
    cancel_url TEXT,
    metadata JSONB DEFAULT '{}'::jsonb,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS orders_merchant_status_idx 
  ON public.orders (merchant_id, status, expires_at);

-- 4. FAMPAY LEDGER TABLE
CREATE TABLE IF NOT EXISTS public.fampay_ledger (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id UUID REFERENCES public.merchants(id) ON DELETE SET NULL,
    order_id VARCHAR(64),
    transaction_id VARCHAR(128) NOT NULL UNIQUE,
    utr VARCHAR(64),
    amount NUMERIC NOT NULL,
    sender_name VARCHAR(255),
    raw_date VARCHAR(128),
    updated_balance NUMERIC,
    raw_email TEXT,
    claimed BOOLEAN DEFAULT false,
    environment VARCHAR(32) NOT NULL DEFAULT 'production',
    received_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS fampay_ledger_merchant_received_idx 
  ON public.fampay_ledger (merchant_id, received_at DESC);

CREATE INDEX IF NOT EXISTS fampay_ledger_utr_idx 
  ON public.fampay_ledger (utr);

-- 5. ROW LEVEL SECURITY (Lockdown from public anon)
ALTER TABLE public.merchants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fampay_ledger ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.merchants, public.orders, public.fampay_ledger FROM anon, authenticated;

-- 6. ATOMIC RECONCILIATION FUNCTION
CREATE OR REPLACE FUNCTION public.reconcile_fampay_payment(
  p_order_id TEXT,
  p_transaction_id TEXT,
  p_utr TEXT DEFAULT NULL
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE fampay_ledger
     SET claimed = true, order_id = p_order_id
   WHERE transaction_id = p_transaction_id
     AND claimed = false;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  UPDATE orders
     SET status = 'PAID', transaction_id = p_transaction_id, utr = p_utr, updated_at = now()
   WHERE id = p_order_id
     and status in ('PENDING', 'EXPIRED');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'order % is not payable', p_order_id USING errcode = 'P0001';
  END IF;

  RETURN true;
EXCEPTION
  WHEN SQLSTATE 'P0001' THEN
    RETURN false;
END $$;

REVOKE ALL ON FUNCTION public.reconcile_fampay_payment(TEXT, TEXT, TEXT) FROM public, anon, authenticated;
