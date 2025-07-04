/**
 * SIMPLE CALL INITIATOR
 * 
 * Makes a test call to the persistent webhook server
 */
require('dotenv').config();
const twilio = require('twilio');

// Configuration
const TARGET_PHONE = process.env.TEST_PHONE || '+19713364433';
const WEBHOOK_BASE_URL = process.env.WEBHOOK_BASE_URL || 'https://0d2c-2600-4041-59a9-a00-1833-4b73-b77b-22dc.ngrok-free.app';

// Initialize Twilio
const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

async function makeTestCall() {
  console.log('🎯 MAKING TEST CALL TO WEBHOOK SERVER');
  console.log('='.repeat(50));
  console.log(`📞 Target: ${TARGET_PHONE}`);
  console.log(`🌐 Webhook: ${WEBHOOK_BASE_URL}/test-connect`);
  console.log(`📊 Status: ${WEBHOOK_BASE_URL}/test-status`);
  
  try {
    const call = await client.calls.create({
      to: TARGET_PHONE,
      from: process.env.TWILIO_PHONE_NUMBER,
      url: `${WEBHOOK_BASE_URL}/test-connect`,
      statusCallback: `${WEBHOOK_BASE_URL}/test-status`,
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      timeout: 30
    });
    
    console.log('\n✅ Call initiated successfully!');
    console.log(`   Call SID: ${call.sid}`);
    console.log(`   Status: ${call.status}`);
    console.log(`   From: ${call.from} → To: ${call.to}`);
    
    console.log('\n📝 Expected Flow:');
    console.log('   1. Webhook server receives call');
    console.log('   2. ElevenLabs generates greeting');
    console.log('   3. You hear high-quality voice');
    console.log('   4. Say something when prompted');
    console.log('   5. ElevenLabs generates response');
    console.log('   6. Call ends with confirmation');
    
    console.log('\n🔍 Monitor progress:');
    console.log(`   - Check webhook server logs`);
    console.log(`   - Twilio Console: https://console.twilio.com/us1/monitor/logs/calls/${call.sid}`);
    
  } catch (error) {
    console.error('❌ Failed to make call:', error.message);
    if (error.code) {
      console.error(`   Twilio Error Code: ${error.code}`);
      console.error(`   More info: ${error.moreInfo || 'N/A'}`);
    }
    process.exit(1);
  }
}

// Validation
if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
  console.error('❌ Missing Twilio credentials in .env file');
  process.exit(1);
}

if (!process.env.TWILIO_PHONE_NUMBER) {
  console.error('❌ Missing TWILIO_PHONE_NUMBER in .env file');
  process.exit(1);
}

if (require.main === module) {
  makeTestCall();
}

module.exports = { makeTestCall }; 