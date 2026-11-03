-- UPI Flow: close the tables to the public Supabase API.
-- Run in the Supabase SQL editor ONLY AFTER the backend is using SUPABASE_SERVICE_ROLE_KEY.
-- The service role bypasses row level security, so the backend keeps working. The anon and
-- authenticated roles (anyone holding the public anon key) lose all access.

alter table merchants     enable row level security;
alter table orders        enable row level security;
alter table fampay_ledger enable row level security;

-- Remove every existing policy on these tables, including any that granted the anon role access.
do $$
declare
  p record;
begin
  for p in
    select schemaname, tablename, policyname
      from pg_policies
     where schemaname = 'public'
       and tablename in ('merchants', 'orders', 'fampay_ledger')
  loop
    execute format('drop policy %I on %I.%I', p.policyname, p.schemaname, p.tablename);
  end loop;
end $$;

-- Belt and braces: no table privileges for the public roles either.
revoke all on merchants, orders, fampay_ledger from anon, authenticated;

-- Check: this should return no rows.
--   select tablename, policyname, roles from pg_policies
--    where tablename in ('merchants', 'orders', 'fampay_ledger');
