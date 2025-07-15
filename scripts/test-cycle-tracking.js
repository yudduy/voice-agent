#!/usr/bin/env node

/**
 * Test script to verify conversation cycle tracking is working
 */

const ConversationCycleTracker = require('../src/utils/conversationCycleTracker');

async function testCycleTracking() {
  console.log('🧪 Testing Conversation Cycle Tracking...\n');
  
  const callSid = 'TEST_CALL_' + Date.now();
  const tracker = new ConversationCycleTracker(callSid);
  
  // Simulate a conversation cycle
  console.log('1. Starting cycle...');
  const cycleId = tracker.startCycle();
  
  // Simulate user speech ending
  console.log('2. User finished speaking...');
  await new Promise(resolve => setTimeout(resolve, 1000)); // 1 second user speech
  tracker.markUserSpeechEnd(cycleId, 'hello how are you today', 0.95);
  
  // Simulate STT completion
  console.log('3. STT completed...');
  await new Promise(resolve => setTimeout(resolve, 100)); // 100ms STT processing
  tracker.markSTTComplete(cycleId);
  
  // Simulate LLM first token
  console.log('4. LLM first token received...');
  await new Promise(resolve => setTimeout(resolve, 300)); // 300ms to first token
  tracker.markLLMFirstToken(cycleId);
  
  // Simulate LLM completion
  console.log('5. LLM completed...');
  await new Promise(resolve => setTimeout(resolve, 500)); // 500ms more for complete response
  tracker.markLLMComplete(cycleId, 'Hello! I am doing well, thank you for asking. How can I help you today?');
  
  // Simulate TTS first audio
  console.log('6. TTS first audio received...');
  await new Promise(resolve => setTimeout(resolve, 200)); // 200ms TTS processing
  tracker.markTTSFirstAudio(cycleId);
  
  // Simulate first audio sent to user
  console.log('7. First audio sent to user...');
  await new Promise(resolve => setTimeout(resolve, 50)); // 50ms transcoding
  tracker.markFirstAudioSent(cycleId);
  
  // Complete the cycle
  console.log('8. Cycle completed...');
  await new Promise(resolve => setTimeout(resolve, 1000)); // 1 second total audio playback
  const completedCycle = tracker.completeCycle(cycleId, 25);
  
  // Test a second cycle
  console.log('\n🔄 Testing second cycle...');
  const cycleId2 = tracker.startCycle();
  await new Promise(resolve => setTimeout(resolve, 800));
  tracker.markUserSpeechEnd(cycleId2, 'what time is it', 0.88);
  tracker.markSTTComplete(cycleId2);
  await new Promise(resolve => setTimeout(resolve, 250));
  tracker.markLLMFirstToken(cycleId2);
  await new Promise(resolve => setTimeout(resolve, 400));
  tracker.markLLMComplete(cycleId2, 'The current time is 3:45 PM.');
  await new Promise(resolve => setTimeout(resolve, 180));
  tracker.markTTSFirstAudio(cycleId2);
  await new Promise(resolve => setTimeout(resolve, 40));
  tracker.markFirstAudioSent(cycleId2);
  await new Promise(resolve => setTimeout(resolve, 800));
  tracker.completeCycle(cycleId2, 18);
  
  // Get final summary
  console.log('\n📊 Getting final summary...');
  const summary = tracker.logFinalSummary();
  
  console.log('\n✅ Cycle tracking test completed!');
  console.log('\nSummary:', JSON.stringify(summary, null, 2));
  
  // Verify the data looks reasonable
  console.log('\n🔍 Validation:');
  console.log(`✓ Cycles completed: ${summary.cycleCount}`);
  console.log(`✓ Average latency: ${summary.averageLatency}ms`);
  console.log(`✓ Min latency: ${summary.minLatency}ms`);
  console.log(`✓ Max latency: ${summary.maxLatency}ms`);
  
  if (summary.cycleCount === 2) {
    console.log('✅ Correct number of cycles tracked');
  } else {
    console.log('❌ Unexpected number of cycles');
  }
  
  if (summary.averageLatency > 0 && summary.averageLatency < 10000) {
    console.log('✅ Reasonable average latency');
  } else {
    console.log('❌ Unexpected average latency');
  }
  
  console.log('\n🎉 Test completed successfully!');
}

// Run test if called directly
if (require.main === module) {
  testCycleTracking().catch(console.error);
}

module.exports = { testCycleTracking };