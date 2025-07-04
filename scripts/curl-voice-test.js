/**
 * CURL-STYLE VOICE TEST
 * 
 * Just makes a direct Twilio API call - no webhook server needed
 * Uses Twilio hosted TwiML for testing
 */
require('dotenv').config();
const twilio = require('twilio');

// Configuration
const TARGET_PHONE = process.env.TEST_PHONE || '+19713364433';

// Initialize Twilio
const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// Create a simple TwiML response using Twilio's hosted TwiML
const TEST_TWIML_URL = 'http://twimlets.com/echo?Twiml=' + encodeURIComponent(`
  <Response>
    <Say voice="Polly.Joanna">
      Hello! This is a test call from VERIES. The voice system is working. 
      Please say something to test speech recognition.
    </Say>
    <Gather input="speech" speechTimeout="auto" actionOnEmptyResult="true">
      <Say voice="Polly.Joanna">I'm listening...</Say>
    </Gather>
    <Say voice="Polly.Joanna">
      Voice test complete. Thank you for testing VERIES. Goodbye!
    </Say>
  </Response>
`);

async function makeCurlStyleCall() {
  console.log('🎯 CURL-STYLE VOICE TEST');
  console.log('='.repeat(50));
  console.log(`📞 Target: ${TARGET_PHONE}`);
  console.log(`🎙️ Testing basic voice connectivity\n`);
  
  try {
    console.log('📞 Making direct API call to Twilio...');
    
    const call = await client.calls.create({
      to: TARGET_PHONE,
      from: process.env.TWILIO_PHONE_NUMBER,
      url: TEST_TWIML_URL,
      timeout: 30,
      record: false
    });
    
    console.log(`✅ Call initiated successfully!`);
    console.log(`   Call SID: ${call.sid}`);
    console.log(`   Status: ${call.status}`);
    console.log(`   From: ${call.from}`);
    console.log(`   To: ${call.to}`);
    console.log(`   URL: ${call.url}`);
    
    console.log('\n📝 What should happen:');
    console.log('   1. Your phone rings');
    console.log('   2. You answer and hear the test message');
    console.log('   3. System waits for you to speak');
    console.log('   4. Call ends with goodbye message');
    
    console.log('\n🔍 Check call status at:');
    console.log(`   https://console.twilio.com/us1/monitor/logs/calls/${call.sid}`);
    
    // Monitor call status
    console.log('\n⏳ Monitoring call status...');
    monitorCall(call.sid);
    
  } catch (error) {
    console.error('❌ Failed to make call:', error.message);
    if (error.code) {
      console.error(`   Twilio Error Code: ${error.code}`);
      console.error(`   More info: ${error.moreInfo || 'N/A'}`);
    }
    process.exit(1);
  }
}

async function monitorCall(callSid) {
  const maxAttempts = 60; // Monitor for 1 minute
  let attempts = 0;
  
  const monitor = setInterval(async () => {
    try {
      attempts++;
      const call = await client.calls(callSid).fetch();
      
      console.log(`   [${attempts * 2}s] Status: ${call.status} | Duration: ${call.duration || 0}s`);
      
      // Stop monitoring if call ends
      if (['completed', 'busy', 'failed', 'no-answer', 'canceled'].includes(call.status)) {
        clearInterval(monitor);
        console.log(`\n🏁 Call ended with status: ${call.status}`);
        console.log(`   Total duration: ${call.duration || 0} seconds`);
        
        if (call.status === 'completed') {
          console.log('✅ Voice test successful!');
        } else {
          console.log(`⚠️  Call ended with status: ${call.status}`);
        }
        
        process.exit(0);
      }
      
      // Stop monitoring after max attempts
      if (attempts >= maxAttempts) {
        clearInterval(monitor);
        console.log('\n⏰ Monitoring timeout reached');
        console.log('Check Twilio console for call details');
        process.exit(0);
      }
      
    } catch (error) {
      console.error(`   Error fetching call status: ${error.message}`);
    }
  }, 2000); // Check every 2 seconds
}

// Validation and execution
if (require.main === module) {
  // Validate environment
  if (!process.env.TWILIO_ACCOUNT_SID) {
    console.error('❌ TWILIO_ACCOUNT_SID not found in .env file');
    process.exit(1);
  }
  
  if (!process.env.TWILIO_AUTH_TOKEN) {
    console.error('❌ TWILIO_AUTH_TOKEN not found in .env file');
    process.exit(1);
  }
  
  if (!process.env.TWILIO_PHONE_NUMBER) {
    console.error('❌ TWILIO_PHONE_NUMBER not found in .env file');
    process.exit(1);
  }
  
  console.log('🔧 Environment validation:');
  console.log(`   ✅ Account SID: ${process.env.TWILIO_ACCOUNT_SID}`);
  console.log(`   ✅ Phone Number: ${process.env.TWILIO_PHONE_NUMBER}`);
  console.log(`   ✅ Target Phone: ${TARGET_PHONE}\n`);
  
  makeCurlStyleCall();
}

module.exports = { makeCurlStyleCall }; 