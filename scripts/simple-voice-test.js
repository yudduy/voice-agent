/**
 * SIMPLE VOICE TEST
 * 
 * Just makes a direct call to test voice functionality
 * No complex setup - just dial and test TTS/STT
 */
require('dotenv').config();
const twilio = require('twilio');
const express = require('express');
const http = require('http');

// Configuration
const TARGET_PHONE = process.env.TEST_PHONE || '+19713364433';
const PORT = 8080;
const BASE_URL = process.env.WEBHOOK_BASE_URL || `http://localhost:${PORT}`;

// Initialize Twilio
const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// Create Express app for webhooks
const app = express();
app.use(express.urlencoded({ extended: false }));

// Simple webhook to handle call connection
app.post('/test-connect', (req, res) => {
  console.log('📞 Call connected! Generating TwiML...');
  
  const VoiceResponse = require('twilio').twiml.VoiceResponse;
  const response = new VoiceResponse();
  
  // Test message
  response.say({
    voice: 'Polly.Joanna',
    language: 'en-US'
  }, 'Hello! This is a test call from VERIES voice system. The integration is working. Please say something to test speech recognition.');
  
  // Listen for user input
  response.gather({
    input: ['speech'],
    speechTimeout: 'auto',
    action: `${BASE_URL}/test-respond`,
    method: 'POST',
    actionOnEmptyResult: true,
    record: true, // Enable recording for STT testing
    recordingStatusCallback: `${BASE_URL}/test-recording`
  });
  
  res.type('text/xml');
  res.send(response.toString());
  console.log('✅ TwiML sent - waiting for user response...');
});

// Handle user speech response
app.post('/test-respond', (req, res) => {
  const { SpeechResult, RecordingUrl, Confidence } = req.body;
  console.log('\n🎤 User spoke:');
  console.log(`   Speech: "${SpeechResult || 'No speech detected'}"`);
  console.log(`   Confidence: ${Confidence || 'N/A'}`);
  console.log(`   Recording URL: ${RecordingUrl || 'N/A'}`);
  
  const VoiceResponse = require('twilio').twiml.VoiceResponse;
  const response = new VoiceResponse();
  
  if (SpeechResult) {
    response.say({
      voice: 'Polly.Joanna',
      language: 'en-US'
    }, `I heard you say: ${SpeechResult}. The voice test is complete. Thank you for testing VERIES voice system. Goodbye!`);
  } else {
    response.say({
      voice: 'Polly.Joanna',
      language: 'en-US'
    }, 'I did not detect any speech, but the call connection is working. Voice test complete. Goodbye!');
  }
  
  response.hangup();
  
  res.type('text/xml');
  res.send(response.toString());
  console.log('✅ Test complete - hanging up...');
});

// Handle recording status
app.post('/test-recording', (req, res) => {
  const { RecordingUrl, RecordingStatus } = req.body;
  console.log(`📹 Recording ${RecordingStatus}: ${RecordingUrl || 'N/A'}`);
  res.sendStatus(200);
});

// Handle call status updates
app.post('/test-status', (req, res) => {
  const { CallStatus, CallDuration } = req.body;
  console.log(`📊 Call Status: ${CallStatus} (Duration: ${CallDuration || 0}s)`);
  
  if (['completed', 'busy', 'failed', 'no-answer'].includes(CallStatus)) {
    console.log('🏁 Call ended. Test complete!');
    setTimeout(() => {
      console.log('Shutting down test server...');
      process.exit(0);
    }, 2000);
  }
  
  res.sendStatus(200);
});

// Start server
const server = http.createServer(app);

async function runSimpleVoiceTest() {
  console.log('🎯 SIMPLE VOICE TEST');
  console.log('='.repeat(50));
  console.log(`📞 Target: ${TARGET_PHONE}`);
  console.log(`🌐 Webhook Base: ${BASE_URL}`);
  console.log(`🎙️ This will test basic voice functionality\n`);
  
  // Start webhook server
  server.listen(PORT, () => {
    console.log(`✅ Webhook server running on port ${PORT}`);
    makeTestCall();
  });
}

async function makeTestCall() {
  try {
    console.log('📞 Making test call...');
    
    const call = await client.calls.create({
      to: TARGET_PHONE,
      from: process.env.TWILIO_PHONE_NUMBER,
      url: `${BASE_URL}/test-connect`,
      statusCallback: `${BASE_URL}/test-status`,
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      record: false, // We'll handle recording in gather
      timeout: 30
    });
    
    console.log(`✅ Call initiated: ${call.sid}`);
    console.log(`   Status: ${call.status}`);
    console.log(`   From: ${call.from} → To: ${call.to}`);
    console.log('\n⏳ Waiting for call to connect...');
    console.log('📝 Expected flow:');
    console.log('   1. Call connects → You hear greeting');
    console.log('   2. Say something → System responds with what it heard');
    console.log('   3. Call ends → Test complete');
    
  } catch (error) {
    console.error('❌ Failed to make call:', error.message);
    if (error.code) {
      console.error(`   Twilio Error Code: ${error.code}`);
    }
    process.exit(1);
  }
}

// Handle cleanup
process.on('SIGINT', () => {
  console.log('\n🛑 Test interrupted by user');
  server.close(() => {
    process.exit(0);
  });
});

// Run the test
if (require.main === module) {
  // Quick validation
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
    console.error('❌ Missing Twilio credentials in .env file');
    process.exit(1);
  }
  
  if (!process.env.TWILIO_PHONE_NUMBER) {
    console.error('❌ Missing TWILIO_PHONE_NUMBER in .env file');
    process.exit(1);
  }
  
  runSimpleVoiceTest();
}

module.exports = { runSimpleVoiceTest }; 