const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
// The backend reads password hashes, API keys and Google tokens, so it must use the service role key.
// The anon key is public by design; if it can read these tables, anyone can.
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseKey = serviceRoleKey || process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment variables.');
  process.exit(1);
}

if (!serviceRoleKey) {
  if (process.env.NODE_ENV === 'production') {
    console.error('❌ SUPABASE_SERVICE_ROLE_KEY is required in production. Refusing to start with the anon key.');
    process.exit(1);
  }
  console.warn('[SUPABASE] SUPABASE_SERVICE_ROLE_KEY is not set; using SUPABASE_ANON_KEY. This only works if row level security lets the public anon role read merchant secrets. Set the service role key and run migrations/002_lock_down_rls.sql.');
}

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  }
});

module.exports = { supabase };
