/**
 * PERSISTENT WEBHOOK SERVER FOR VOICE TESTING
 * 
 * Runs a webhook server that stays up for testing voice calls
 * Tests ElevenLabs TTS integration in real phone calls
 */
require('dotenv').config();
const express = require('express');
const twilio = require('twilio');
const { generateAudio } = require('./src/services/textToSpeech');
const VoiceResponse = twilio.twiml.VoiceResponse;

// Configuration
const PORT = 8080;
const app = express();

// Middleware
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Basic logging middleware
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// Main webhook endpoint for incoming calls
app.post('/test-connect', async (req, res) => {
  console.log('\n🎉 INCOMING CALL WEBHOOK TRIGGERED!');
  console.log('Request body:', JSON.stringify(req.body, null, 2));
  
  const response = new VoiceResponse();
  
  // Test message using ElevenLabs
  const testMessage = "Hello! This is VERIES calling with ElevenLabs voice synthesis. The integration is working perfectly. Please say something after the beep.";
  
  console.log('\n🔊 Generating ElevenLabs TTS...');
  try {
    const audioUrl = await generateAudio(testMessage);
    
    if (audioUrl) {
      console.log(`✅ ElevenLabs TTS generated: ${audioUrl}`);
      
      // Use our custom TTS - get base URL from environment or use localhost for testing
      const baseUrl = process.env.WEBHOOK_BASE_URL || `http://localhost:${PORT}`;
      response.play(`${baseUrl}${audioUrl}`);
      
    } else {
      console.log('⚠️  ElevenLabs failed, using Twilio TTS');
      response.say({
        voice: 'Polly.Joanna',
        language: 'en-US'
      }, testMessage);
    }
    
  } catch (error) {
    console.error('❌ TTS Error:', error);
    response.say({
      voice: 'Polly.Joanna',
      language: 'en-US'
    }, "Hello! This is a fallback message. TTS generation failed.");
  }
  
  // Listen for user input
  response.gather({
    input: ['speech'],
    speechTimeout: 'auto',
    timeout: 10,
    action: '/test-respond',
    method: 'POST',
    actionOnEmptyResult: true,
    record: true,
    recordingStatusCallback: '/test-recording'
  });
  
  // Fallback if no input
  response.say('Thank you for testing. Goodbye!');
  response.hangup();
  
  res.type('text/xml');
  res.send(response.toString());
  console.log('📤 TwiML response sent');
});

// Handle user speech response
app.post('/test-respond', async (req, res) => {
  const { SpeechResult, RecordingUrl, Confidence } = req.body;
  
  console.log('\n🎤 USER SPEECH DETECTED:');
  console.log(`   Speech: "${SpeechResult || 'No speech detected'}"`);
  console.log(`   Confidence: ${Confidence || 'N/A'}`);
  console.log(`   Recording: ${RecordingUrl || 'N/A'}`);
  
  const response = new VoiceResponse();
  
  // Generate response using ElevenLabs
  let responseMessage;
  if (SpeechResult) {
    responseMessage = `Perfect! I heard you say: ${SpeechResult}. The ElevenLabs voice system is working correctly. Test complete!`;
  } else {
    responseMessage = "I didn't detect any speech, but the call connection is working. ElevenLabs voice test complete!";
  }
  
  console.log('\n🔊 Generating response with ElevenLabs...');
  try {
    const audioUrl = await generateAudio(responseMessage);
    
    if (audioUrl) {
      console.log(`✅ Response TTS generated: ${audioUrl}`);
      const baseUrl = process.env.WEBHOOK_BASE_URL || `http://localhost:${PORT}`;
      response.play(`${baseUrl}${audioUrl}`);
    } else {
      console.log('⚠️  Using Twilio TTS for response');
      response.say({
        voice: 'Polly.Joanna',
        language: 'en-US'
      }, responseMessage);
    }
    
  } catch (error) {
    console.error('❌ Response TTS Error:', error);
    response.say({
      voice: 'Polly.Joanna',
      language: 'en-US'
    }, "Response generated successfully. Goodbye!");
  }
  
  response.hangup();
  
  res.type('text/xml');
  res.send(response.toString());
  console.log('📤 Response TwiML sent - call will end');
});

// Handle recording status
app.post('/test-recording', (req, res) => {
  const { RecordingUrl, RecordingStatus, CallSid } = req.body;
  console.log(`\n📹 Recording ${RecordingStatus}:`);
  console.log(`   URL: ${RecordingUrl || 'N/A'}`);
  console.log(`   Call: ${CallSid}`);
  res.sendStatus(200);
});

// Handle call status updates
app.post('/test-status', (req, res) => {
  const { CallStatus, CallDuration, CallSid } = req.body;
  console.log(`\n📊 Call Status: ${CallStatus} (Duration: ${CallDuration || 0}s)`);
  console.log(`   Call SID: ${CallSid}`);
  res.sendStatus(200);
});

// Serve static TTS files
app.use('/tts-cache', express.static('public/tts-cache'));

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    message: 'VERIES Voice Test Server Running' 
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.send(`
    <h1>🎙️ VERIES Voice Test Server</h1>
    <p>Server is running and ready for voice call testing.</p>
    <p>Endpoints:</p>
    <ul>
      <li><code>POST /test-connect</code> - Main call webhook</li>
      <li><code>POST /test-respond</code> - Speech response handler</li>
      <li><code>POST /test-status</code> - Call status updates</li>
      <li><code>GET /health</code> - Health check</li>
    </ul>
    <p>Time: ${new Date().toISOString()}</p>
  `);
});

// Start server
const server = app.listen(PORT, () => {
  console.log('🎯 VERIES VOICE TEST SERVER');
  console.log('='.repeat(50));
  console.log(`🌐 Server running on port ${PORT}`);
  console.log(`📞 Ready for Twilio webhook calls`);
  console.log(`🔊 ElevenLabs TTS integration enabled`);
  console.log(`⏰ Started at ${new Date().toISOString()}`);
  console.log('\n🚀 To test:');
  console.log('   1. Make sure ngrok is running: ngrok http 8080');
  console.log('   2. Update WEBHOOK_BASE_URL in your call script');
  console.log('   3. Make a test call to trigger webhooks');
  console.log('\n💡 Server will stay running until stopped with Ctrl+C');
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down voice test server...');
  server.close(() => {
    console.log('✅ Server closed gracefully');
    process.exit(0);
  });
});

module.exports = app; 