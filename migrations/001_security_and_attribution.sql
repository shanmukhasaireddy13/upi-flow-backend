-- UPI Flow data model, version 1.
-- Run once in the Supabase SQL editor, before deploying the backend that reads merchant_id.
-- Safe to re-run: every statement checks for an existing object first.

-- 1. Ownership of every payment. Without this column a ledger row belongs to nobody,
--    and merchant-scoped queries cannot tell accounts apart.
alter table fampay_ledger add column if not exists merchant_id uuid;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'fampay_ledger_merchant_fk') then
    alter table fampay_ledger
      add constraint fampay_ledger_merchant_fk
      foreign key (merchant_id) references merchants(id) on delete set null;
  end if;
end $$;

-- 2. Attribute payments that were already claimed to the merchant of their order.
update fampay_ledger l
   set merchant_id = o.merchant_id
  from orders o
 where o.transaction_id = l.transaction_id
   and l.merchant_id is null;

-- 3. Keys that the code looks up on every request must be unique.
create unique index if not exists merchants_api_key_key on merchants (api_key);
create unique index if not exists merchants_email_key on merchants (email);
create unique index if not exists fampay_ledger_transaction_id_key on fampay_ledger (transaction_id);

-- 4. Query paths used by the dashboard and the matcher.
create index if not exists fampay_ledger_merchant_received_idx on fampay_ledger (merchant_id, received_at desc);
create index if not exists fampay_ledger_utr_idx on fampay_ledger (utr);
create index if not exists orders_merchant_status_idx on orders (merchant_id, status, expires_at);

-- 5. An order always belongs to a merchant and has a valid state and amount.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'orders_status_check') then
    alter table orders
      add constraint orders_status_check check (status in ('PENDING', 'PAID', 'EXPIRED'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'orders_amount_check') then
    alter table orders add constraint orders_amount_check check (amount > 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'orders_merchant_fk') then
    alter table orders
      add constraint orders_merchant_fk foreign key (merchant_id) references merchants(id) on delete cascade;
  end if;
end $$;

-- 6. A merchant can exist before its receiving UPI ID is set (onboarding step 1).
alter table merchants alter column upi_id drop not null;

-- 7. Check the result. Each query should return 0.
--    select count(*) from fampay_ledger where merchant_id is null and claimed;   -- claimed rows must have an owner
--    select count(*) from orders where merchant_id is null;
