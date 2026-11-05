const { supabase } = require('../config/supabase');

// Columns the code depends on. If one is missing, the backend cannot attribute payments safely,
// so the check logs a clear message at boot instead of failing later with a vague error.
const REQUIRED = [
  { table: 'fampay_ledger', column: 'merchant_id' },
  { table: 'orders', column: 'merchant_id' },
  { table: 'orders', column: 'idempotency_key' },
  { table: 'merchants', column: 'google_email' }
];

async function checkSchema() {
  const missing = [];
  for (const { table, column } of REQUIRED) {
    const { error } = await supabase.from(table).select(column).limit(1);
    if (error) missing.push(`${table}.${column} (${error.message})`);
  }
  if (missing.length === 0) {
    console.log('[SCHEMA] Database columns are up to date.');
    return true;
  }
  console.error('[SCHEMA] Missing or unreadable columns:');
  missing.forEach((m) => console.error(`  - ${m}`));
  console.error('[SCHEMA] Run the files in backend/migrations in order in the Supabase SQL editor.');
  return false;
}

module.exports = { checkSchema };
