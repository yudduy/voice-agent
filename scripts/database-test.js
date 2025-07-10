/**
 * Supabase Database Test Script
 *
 * This script connects to the Supabase database and performs a series of checks to ensure
 * that the schema is correctly set up, required tables and functions exist, and the
 * connection is alive.
 *
 * To run this script:
 * node tests/database-test.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const supabase = require('../src/config/supabase');

const REQUIRED_TABLES = [
  'user_profiles',
  'phone_links',
  'onboarding_messages',
  'preferences',
  'call_history',
  'sms_history'
];

const REQUIRED_FUNCTIONS = [
  'get_pending_onboarding_messages',
  'complete_user_onboarding'
];

async function checkDatabaseConnection() {
  console.log('1. Checking database connection...');
  const { error } = await supabase.from('phone_links').select('*', { head: true, count: 'exact' });
  if (error && error.code === '42P01') {
    // Table doesn't exist but connection works
    console.log('   ✅ Connection successful (table checks will follow).');
    return true;
  } else if (error) {
    console.error('   ❌ Database connection failed:', error.message);
    return false;
  }
  console.log('   ✅ Connection successful.');
  return true;
}

async function tableExists(tableName) {
  const { error } = await supabase.from(tableName).select('*', { head: true, count: 'exact' });
  return !error;
}

async function showFirstRowStructure(tableName) {
  const { data, error } = await supabase.from(tableName).select('*').limit(1);
  if (error) {
    console.error(`     - ❌ Unable to query '${tableName}':`, error.message);
    return;
  }
  if (data && data.length > 0) {
    const sampleRow = data[0];
    console.log('     - Sample structure (first row keys):');
    Object.keys(sampleRow).forEach(key => console.log(`       - ${key}`));
  } else {
    console.log('     - Table is empty (no rows to sample).');
  }
}

async function checkTables() {
  console.log('\n2. Verifying required tables...');
  let allGood = true;
  for (const tableName of REQUIRED_TABLES) {
    if (await tableExists(tableName)) {
      console.log(`   ✅ Table '${tableName}' exists.`);
      await showFirstRowStructure(tableName);
    } else {
      console.error(`   ❌ Table '${tableName}' is missing.`);
      allGood = false;
    }
  }
  return allGood;
}

async function functionExists(funcName, params = {}) {
  const { error } = await supabase.rpc(funcName, params);
  if (!error) return true; // Successfully called
  if (error.message && error.message.toLowerCase().includes('not found')) return false;
  // Function exists but call failed due to other reasons (e.g., invalid params)
  return true;
}

async function checkFunctions() {
  console.log('\n3. Verifying required functions...');
  let allGood = true;
  for (const funcName of REQUIRED_FUNCTIONS) {
    const exists = await functionExists(funcName, funcName === 'get_pending_onboarding_messages' ? { limit_count: 1 } : { p_user_id: '00000000-0000-0000-0000-000000000000' });
    if (exists) {
      console.log(`   ✅ Function '${funcName}' exists.`);
    } else {
      console.error(`   ❌ Function '${funcName}' is missing.`);
      allGood = false;
    }
  }
  return allGood;
}

async function testDatabaseFunctions() {
  console.log('\n4. Testing database functions...');
  try {
    const { data, error } = await supabase.rpc('get_pending_onboarding_messages', { limit_count: 5 });
    if (error) throw error;
    console.log(`   ✅ 'get_pending_onboarding_messages' executed. Returned ${data.length} rows.`);
  } catch (err) {
    console.error(`   ❌ Error executing 'get_pending_onboarding_messages':`, err.message);
  }

  console.log("   - Skipping execution of 'complete_user_onboarding' to avoid state changes. Function existence validated above.");
}

async function runTests() {
  console.log('--- Starting Supabase Database Verification ---');

  if (!(await checkDatabaseConnection())) {
    console.error('\nAborting tests due to connection failure.');
    process.exit(1);
  }

  await checkTables();
  await checkFunctions();
  await testDatabaseFunctions();

  console.log('\n--- Verification Complete ---');
  process.exit(0);
}

runTests(); 