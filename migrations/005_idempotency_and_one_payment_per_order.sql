-- UPI Flow: safe retries and a database-level guarantee that one payment pays one order.
-- Run once in the Supabase SQL editor. Safe to re-run.

-- 1. Lets merchants retry POST /api/orders with an Idempotency-Key without creating a second order.
alter table orders add column if not exists idempotency_key text;
create unique index if not exists orders_merchant_idempotency_key
  on orders (merchant_id, idempotency_key)
  where idempotency_key is not null;

-- 2. Even if the application has a bug, a transaction can never be recorded on two orders.
create unique index if not exists orders_transaction_id_key
  on orders (transaction_id)
  where transaction_id is not null;
