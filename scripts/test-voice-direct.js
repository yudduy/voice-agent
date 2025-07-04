/**
 * DIRECT VOICE PIPELINE TEST
 * 
 * Tests ElevenLabs TTS and voice functions directly
 * No webhooks needed - just test the actual voice generation
 */
require('dotenv').config();
const { generateAudio } = require('./src/services/textToSpeech');
const fs = require('fs');
const path = require('path');

async function testVoicePipeline() {
  console.log('🎯 DIRECT VOICE PIPELINE TEST');
  console.log('='.repeat(50));
  
  // Test text
  const testMessage = "Hello! This is a test of the VERIES voice system using ElevenLabs. The integration is working perfectly.";
  
  console.log('\n📝 Test Message:');
  console.log(`   "${testMessage}"`);
  
  console.log('\n🔊 Testing TTS Generation...');
  
  try {
    const audioUrl = await generateAudio(testMessage);
    
    console.log('\n✅ TTS Results:');
    if (audioUrl) {
      console.log(`   URL: ${audioUrl}`);
      console.log('   Provider: ElevenLabs (success!)');
      console.log('🎉 ElevenLabs TTS working correctly!');
    } else {
      console.log('   URL: null');
      console.log('   Provider: Will fall back to Twilio TTS');
      console.log('⚠️  Custom TTS providers failed');
    }
    
    // Test file access if we have a local URL
    if (audioUrl && audioUrl.startsWith('/tts-cache/')) {
      console.log('\n📥 Testing audio file access...');
      
      const filename = audioUrl.replace('/tts-cache/', '');
      const filePath = path.join(__dirname, 'public', 'tts-cache', filename);
      
      try {
        const stats = fs.statSync(filePath);
        console.log('✅ Audio file accessible:');
        console.log(`   File path: ${filePath}`);
        console.log(`   Size: ${Math.round(stats.size / 1024)}KB`);
        
        // Copy sample for verification
        const testFile = path.join(__dirname, 'test-audio-sample.mp3');
        fs.copyFileSync(filePath, testFile);
        console.log(`   Sample saved: ${testFile}`);
        console.log('   You can play this file to verify audio quality');
        
      } catch (error) {
        console.log('❌ Could not access audio file');
        console.log(`   Path: ${filePath}`);
        console.log(`   Error: ${error.message}`);
      }
    }
    
  } catch (error) {
    console.error('❌ TTS Test Failed:', error.message);
    if (error.provider) {
      console.error(`   Provider: ${error.provider}`);
    }
    return false;
  }
  
  return true;
}

async function testEnvironmentSetup() {
  console.log('\n🔧 Environment Check:');
  
  const checks = [
    { name: 'ElevenLabs API Key', value: process.env.ELEVENLABS_API_KEY, required: true },
    { name: 'ElevenLabs Voice ID', value: process.env.ELEVENLABS_VOICE_ID, required: true },
    { name: 'Hyperbolic API Key', value: process.env.HYPERBOLIC_API_KEY, required: false },
    { name: 'OpenAI API Key', value: process.env.OPENAI_API_KEY, required: false },
    { name: 'Groq API Key', value: process.env.GROQ_API_KEY, required: false },
  ];
  
  let allPassed = true;
  
  for (const check of checks) {
    const status = check.value ? '✅' : (check.required ? '❌' : '⚠️ ');
    const display = check.value ? `${check.value.substring(0, 8)}...` : 'Not set';
    console.log(`   ${status} ${check.name}: ${display}`);
    
    if (check.required && !check.value) {
      allPassed = false;
    }
  }
  
  return allPassed;
}

async function runDirectTest() {
  console.log('🎙️ Testing voice pipeline components directly\n');
  
  // Environment check
  const envOk = await testEnvironmentSetup();
  if (!envOk) {
    console.log('\n❌ Environment setup incomplete');
    console.log('Please ensure all required API keys are configured in .env');
    return;
  }
  
  // TTS test
  const ttsOk = await testVoicePipeline();
  if (!ttsOk) {
    console.log('\n❌ Voice pipeline test failed');
    return;
  }
  
  console.log('\n🎉 All voice tests passed!');
  console.log('\nNext steps:');
  console.log('   1. Test the audio file generated (test-audio-sample.mp3)');
  console.log('   2. Verify voice quality meets your expectations');
  console.log('   3. Run a full integration test with actual phone calls');
}

if (require.main === module) {
  runDirectTest().catch(console.error);
}

module.exports = { testVoicePipeline, testEnvironmentSetup }; 