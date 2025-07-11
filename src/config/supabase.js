const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error('Supabase URL and a valid key are required.');
}

// Configure connection pooling for better performance
const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
  db: {
    // Connection pooling parameters
    max: 10, // Maximum number of connections in pool
    idleTimeoutMillis: 30000, // How long to keep idle connections open
    connectionTimeoutMillis: 2000, // How long to wait for a connection
  },
  global: {
    headers: {
      'x-connection-pool': 'true'
    }
  },
  // Enable connection reuse
  shouldThrowOnError: false,
});

// Warm up the connection pool on startup
if (process.env.NODE_ENV !== 'test') {
  supabase.from('users').select('id').limit(1).then(() => {
    console.log('Supabase connection pool warmed up');
  }).catch(err => {
    console.error('Failed to warm up Supabase connection:', err.message);
  });
}

module.exports = supabase; 