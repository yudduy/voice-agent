/**
 * DEBUG VOICE INTEGRATION TEST
 * 
 * This script tests the complete voice pipeline:
 * - ElevenLabs TTS (primary)
 * - Groq STT with recording enabled
 * - Fallback to Hyperbolic TTS if ElevenLabs fails
 * - Final fallback to Twilio TTS
 */
require('dotenv').config();
const { bootstrapUser } = require('./tests/utils/bootstrapUser');
const logger = require('./src/utils/logger');
const aiConfig = require('./src/config/ai');
const textToSpeech = require('./src/services/textToSpeech');
const speechToText = require('./src/services/speechToText');

// Debug configuration check
function checkConfiguration() {
  console.log('\n🔧 CONFIGURATION CHECK');
  console.log('='.repeat(50));
  
  // ElevenLabs configuration
  console.log('📢 ElevenLabs TTS:');
  console.log(`   API Key: ${process.env.ELEVENLABS_API_KEY ? '✅ Set' : '❌ Missing'}`);
  console.log(`   Voice ID: ${process.env.ELEVENLABS_VOICE_ID || 'Using default (Bella)'}`);
  console.log(`   Enabled: ${aiConfig.elevenLabs.enabled ? '✅ Yes' : '❌ No'}`);
  console.log(`   Preference: ${aiConfig.speechPreferences.ttsPreference}`);
  
  // Groq STT configuration
  console.log('\n🎤 Groq STT:');
  console.log(`   API Key: ${process.env.GROQ_API_KEY ? '✅ Set' : '❌ Missing'}`);
  console.log(`   Model: ${aiConfig.groqConfig.whisperModel}`);
  console.log(`   Enabled: ${aiConfig.groqConfig.enabled ? '✅ Yes' : '❌ No'}`);
  console.log(`   Preference: ${aiConfig.speechPreferences.sttPreference}`);
  console.log(`   Recording: ${aiConfig.speechPreferences.enableRecording ? '✅ Enabled' : '❌ Disabled'}`);
  
  // Fallback providers
  console.log('\n🔄 Fallback Providers:');
  console.log(`   Hyperbolic: ${aiConfig.hyperbolic.enabled ? '✅ Available' : '❌ Unavailable'}`);
  console.log(`   OpenAI: ${process.env.OPENAI_API_KEY ? '✅ Available' : '❌ Unavailable'}`);
  
  // Twilio configuration
  console.log('\n📞 Twilio:');
  console.log(`   Account SID: ${process.env.TWILIO_ACCOUNT_SID ? '✅ Set' : '❌ Missing'}`);
  console.log(`   Auth Token: ${process.env.TWILIO_AUTH_TOKEN ? '✅ Set' : '❌ Missing'}`);
  console.log(`   Phone Number: ${process.env.TWILIO_PHONE_NUMBER || '❌ Missing'}`);
  console.log(`   Webhook Base URL: ${process.env.WEBHOOK_BASE_URL || '❌ Missing'}`);
  
  // Required for testing
  console.log('\n🧪 Test Configuration:');
  console.log(`   Test Phone: ${process.env.TEST_PHONE || '❌ Missing'}`);
  console.log(`   Base URL: ${process.env.BASE_URL || '❌ Missing'}`);
}

// Test ElevenLabs TTS generation
async function testElevenLabsTTS() {
  console.log('\n📢 TESTING ELEVENLABS TTS');
  console.log('='.repeat(50));
  
  if (!aiConfig.elevenLabs.enabled) {
    console.log('❌ ElevenLabs TTS is disabled - check API key');
    return false;
  }
  
  try {
    const testText = "Hello! This is a test of the ElevenLabs text-to-speech integration for VERIES voice calling.";
    console.log(`🔄 Generating audio for: "${testText}"`);
    
    const startTime = Date.now();
    const audioUrl = await textToSpeech.generateElevenLabsAudio(testText);
    const duration = Date.now() - startTime;
    
    if (audioUrl) {
      console.log(`✅ ElevenLabs TTS Success!`);
      console.log(`   Duration: ${duration}ms`);
      console.log(`   Audio URL: ${audioUrl}`);
      return true;
    } else {
      console.log('❌ ElevenLabs TTS failed to generate audio');
      return false;
    }
  } catch (error) {
    console.log(`❌ ElevenLabs TTS Error: ${error.message}`);
    return false;
  }
}

// Test the main TTS function (ElevenLabs -> Hyperbolic -> Twilio fallback)
async function testMainTTS() {
  console.log('\n🔄 TESTING MAIN TTS FUNCTION');
  console.log('='.repeat(50));
  
  try {
    const testText = "Testing the main TTS function with ElevenLabs priority and Hyperbolic fallback.";
    console.log(`🔄 Generating audio for: "${testText}"`);
    
    const startTime = Date.now();
    const audioUrl = await textToSpeech.generateAudio(testText);
    const duration = Date.now() - startTime;
    
    if (audioUrl) {
      console.log(`✅ Main TTS Success!`);
      console.log(`   Duration: ${duration}ms`);
      console.log(`   Audio URL: ${audioUrl}`);
      return true;
    } else {
      console.log('⚠️  Main TTS returned null - will use Twilio TTS as fallback');
      return false;
    }
  } catch (error) {
    console.log(`❌ Main TTS Error: ${error.message}`);
    return false;
  }
}

// Test Groq STT (simulation - we can't test recording without actual call)
function testGroqSTT() {
  console.log('\n🎤 TESTING GROQ STT CONFIGURATION');
  console.log('='.repeat(50));
  
  if (!aiConfig.groqConfig.enabled) {
    console.log('❌ Groq STT is disabled - check API key and configuration');
    return false;
  }
  
  console.log('✅ Groq STT Configuration:');
  console.log(`   Client initialized: Yes`);
  console.log(`   Model: ${aiConfig.groqConfig.whisperModel}`);
  console.log(`   Recording enabled: ${aiConfig.speechPreferences.enableRecording}`);
  console.log(`   STT preference: ${aiConfig.speechPreferences.sttPreference}`);
  
  if (aiConfig.speechPreferences.sttPreference === 'groq' && aiConfig.speechPreferences.enableRecording) {
    console.log('✅ Groq STT will be used in voice calls with recording enabled');
    return true;
  } else {
    console.log('⚠️  Groq STT is available but not configured as primary');
    return false;
  }
}

// Test user bootstrapping
async function testUserBootstrap() {
  console.log('\n👤 TESTING USER BOOTSTRAP');
  console.log('='.repeat(50));
  
  try {
    // Generate a test user ID and use the test phone from environment
    const testUserId = '550e8400-e29b-41d4-a716-446655440000'; // Fixed UUID for testing
    const testPhone = process.env.TEST_PHONE || '+19713364433';
    
    const user = await bootstrapUser({
      id: testUserId,
      phone: testPhone,
      name: 'Voice Debug Test User'
    });
    console.log('✅ User Bootstrap Success:');
    console.log(`   User ID: ${user.id}`);
    console.log(`   Name: ${user.name}`);
    console.log(`   Phone: ${user.phone}`);
    return user;
  } catch (error) {
    console.log(`❌ User Bootstrap Error: ${error.message}`);
    return null;
  }
}

// Main debug function
async function runDebugTests() {
  console.log('🎯 VERIES VOICE DEBUG MODE');
  console.log('='.repeat(50));
  console.log('Testing voice pipeline components...\n');
  
  // Configuration check
  checkConfiguration();
  
  // Test TTS components
  const elevenLabsSuccess = await testElevenLabsTTS();
  const mainTtsSuccess = await testMainTTS();
  
  // Test STT configuration
  const groqSuccess = testGroqSTT();
  
  // Test user creation
  const user = await testUserBootstrap();
  
  // Summary
  console.log('\n📊 DEBUG SUMMARY');
  console.log('='.repeat(50));
  console.log(`ElevenLabs TTS: ${elevenLabsSuccess ? '✅ Working' : '❌ Failed'}`);
  console.log(`Main TTS Function: ${mainTtsSuccess ? '✅ Working' : '⚠️  Will use Twilio fallback'}`);
  console.log(`Groq STT Config: ${groqSuccess ? '✅ Ready' : '⚠️  Check configuration'}`);
  console.log(`User Bootstrap: ${user ? '✅ Working' : '❌ Failed'}`);
  
  if (elevenLabsSuccess && groqSuccess && user) {
    console.log('\n🎉 VOICE PIPELINE READY!');
    console.log('You can now run voice calls with:');
    console.log('- ElevenLabs TTS for high-quality speech');
    console.log('- Groq STT for accurate transcription');
    console.log('- Recording enabled for STT processing');
    console.log('\nTo test with an actual call, run:');
    console.log('node tests/test-voice-call.js');
  } else {
    console.log('\n⚠️  ISSUES DETECTED');
    console.log('Please fix the issues above before running voice calls.');
    
    if (!elevenLabsSuccess) {
      console.log('\n💡 ElevenLabs Issues:');
      console.log('- Ensure ELEVENLABS_API_KEY is set in your .env file');
      console.log('- Optionally set ELEVENLABS_VOICE_ID (defaults to Bella)');
      console.log('- Set TTS_PREFERENCE=elevenlabs in your .env file');
    }
    
    if (!groqSuccess) {
      console.log('\n💡 Groq STT Issues:');
      console.log('- Ensure GROQ_API_KEY is set in your .env file');
      console.log('- Set SPEECH_RECOGNITION_PREFERENCE=groq in your .env file');
      console.log('- Set ENABLE_RECORDING=true in your .env file');
      console.log('- Set ENABLE_GROQ_TRANSCRIPTION=true in your .env file');
    }
  }
}

// Run the debug tests
if (require.main === module) {
  runDebugTests().catch(error => {
    console.error('❌ Debug test failed:', error);
    process.exit(1);
  });
}

module.exports = { runDebugTests }; 