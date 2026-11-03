-- UPI Flow: atomic payment reconciliation, called by the backend as rpc('reconcile_fampay_payment').
-- Claims one ledger payment for one order in a single transaction. Returns true on success and false
-- when the payment is already claimed or the order is already paid, so a payment can never be used twice.
-- Safe to re-run.

create or replace function reconcile_fampay_payment(
  p_order_id text,
  p_transaction_id text,
  p_utr text default null
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update fampay_ledger
     set claimed = true, order_id = p_order_id
   where transaction_id = p_transaction_id
     and claimed = false;
  if not found then
    return false;
  end if;

  update orders
     set status = 'PAID', transaction_id = p_transaction_id, utr = p_utr, updated_at = now()
   where id = p_order_id
     and status in ('PENDING', 'EXPIRED');
  if not found then
    raise exception 'order % is not payable', p_order_id using errcode = 'P0001';
  end if;

  return true;
exception
  when sqlstate 'P0001' then
    -- The exception rolls back everything in this block, including the ledger claim above.
    return false;
end $$;

-- Only the backend (service role) may call it.
revoke all on function reconcile_fampay_payment(text, text, text) from public, anon, authenticated;
