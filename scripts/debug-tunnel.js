/**
 * TUNNEL DEBUG UTILITY
 * ====================
 * 
 * This script helps debug ngrok tunnel issues and test webhook connectivity.
 * Use this to validate tunnel setup before running voice tests.
 * 
 * Usage:
 *   node scripts/debug-tunnel.js           # Test current tunnel
 *   node scripts/debug-tunnel.js --start   # Start new tunnel
 *   node scripts/debug-tunnel.js --test    # Test webhook endpoints
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });

const ngrok = require('ngrok');
const { startServer } = require('../src/app');

const ensureEnv = (key) => {
  if (!process.env[key]) {
    console.error(`❌ Missing required environment variable: ${key}`);
    process.exit(1);
  }
};

const PORT = process.env.PORT || 3000;

// Test current webhook base URL
const testCurrentTunnel = async () => {
  const baseUrl = process.env.WEBHOOK_BASE_URL;
  
  if (!baseUrl) {
    console.log('⚠️  No WEBHOOK_BASE_URL configured');
    return false;
  }
  
  console.log(`🔍 Testing tunnel: ${baseUrl}`);
  
  try {
    const response = await fetch(`${baseUrl}/health`);
    if (response.ok) {
      console.log('✅ Tunnel is accessible');
      return true;
    } else {
      console.log(`❌ Tunnel returned status: ${response.status}`);
      return false;
    }
  } catch (error) {
    console.log(`❌ Tunnel is not accessible: ${error.message}`);
    return false;
  }
};

// Start new tunnel
const startNewTunnel = async () => {
  ensureEnv('NGROK_AUTHTOKEN');
  
  console.log('🧹 Cleaning up existing ngrok processes...');
  try {
    await ngrok.kill();
    console.log('✅ Cleanup complete');
  } catch (error) {
    console.log('ℹ️  No existing processes to clean');
  }
  
  console.log(`🚀 Starting local server on port ${PORT}...`);
  await startServer();
  console.log('✅ Local server started');
  
  console.log('🌐 Creating new ngrok tunnel...');
  const tunnel = await ngrok.connect({
    authtoken: process.env.NGROK_AUTHTOKEN,
    addr: PORT,
    region: 'us',
    bind_tls: true,
    onStatusChange: (status) => {
      console.log(`🔄 Status: ${status}`);
    },
    onLogEvent: (data) => {
      if (data.err) {
        console.error(`❌ Error: ${data.err}`);
      }
    }
  });
  
  console.log(`✅ New tunnel created: ${tunnel}`);
  console.log('📝 Update your .env file:');
  console.log(`WEBHOOK_BASE_URL=${tunnel}`);
  
  // Test the new tunnel
  console.log('🔍 Testing new tunnel...');
  await new Promise(resolve => setTimeout(resolve, 2000)); // Wait for tunnel to stabilize
  
  try {
    const response = await fetch(`${tunnel}/health`);
    if (response.ok) {
      console.log('✅ New tunnel is working correctly');
    } else {
      console.log(`❌ New tunnel test failed: ${response.status}`);
    }
  } catch (error) {
    console.log(`❌ New tunnel test error: ${error.message}`);
  }
  
  return tunnel;
};

// Test webhook endpoints
const testWebhookEndpoints = async () => {
  const baseUrl = process.env.WEBHOOK_BASE_URL;
  
  if (!baseUrl) {
    console.log('❌ No WEBHOOK_BASE_URL configured for testing');
    return;
  }
  
  const endpoints = [
    '/health',
    '/api/calls/connect',
    '/api/calls/respond',
    '/api/calls/status'
  ];
  
  console.log(`🧪 Testing webhook endpoints on ${baseUrl}...`);
  
  for (const endpoint of endpoints) {
    try {
      const response = await fetch(`${baseUrl}${endpoint}`, {
        method: endpoint.includes('/api/calls/') ? 'POST' : 'GET',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: endpoint.includes('/api/calls/') ? 'CallSid=TEST_CALL_SID&From=%2B1234567890&To=%2B1234567890' : undefined
      });
      
      console.log(`${endpoint}: ${response.status} ${response.ok ? '✅' : '❌'}`);
    } catch (error) {
      console.log(`${endpoint}: ERROR ❌ (${error.message})`);
    }
  }
};

// Get tunnel info
const getTunnelInfo = async () => {
  try {
    const tunnels = await ngrok.api.listTunnels();
    console.log('🌐 Active ngrok tunnels:');
    if (tunnels.length === 0) {
      console.log('   No active tunnels');
    } else {
      tunnels.forEach((tunnel, index) => {
        console.log(`   ${index + 1}. ${tunnel.public_url} -> ${tunnel.config.addr}`);
      });
    }
  } catch (error) {
    console.log('❌ Could not list tunnels:', error.message);
  }
};

// Main execution
(async () => {
  const args = process.argv.slice(2);
  
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
🔧 TUNNEL DEBUG UTILITY

Commands:
  node scripts/debug-tunnel.js           # Test current tunnel
  node scripts/debug-tunnel.js --start   # Start new tunnel  
  node scripts/debug-tunnel.js --test    # Test webhook endpoints
  node scripts/debug-tunnel.js --info    # Show tunnel info

Environment Variables:
  WEBHOOK_BASE_URL     # Current tunnel URL to test
  NGROK_AUTHTOKEN      # Required for starting new tunnels
  PORT                 # Local server port (default: 3000)
`);
    return;
  }
  
  if (args.includes('--start')) {
    await startNewTunnel();
  } else if (args.includes('--test')) {
    await testWebhookEndpoints();
  } else if (args.includes('--info')) {
    await getTunnelInfo();
  } else {
    // Default: test current tunnel
    console.log('🔍 TUNNEL CONNECTIVITY TEST');
    console.log('='.repeat(40));
    
    await getTunnelInfo();
    console.log('');
    
    const isWorking = await testCurrentTunnel();
    
    if (!isWorking) {
      console.log('');
      console.log('💡 SUGGESTIONS:');
      console.log('1. Start a new tunnel: node scripts/debug-tunnel.js --start');
      console.log('2. Check if ngrok auth token is valid');
      console.log('3. Ensure local server is running on port', PORT);
    }
  }
})().catch(console.error); 