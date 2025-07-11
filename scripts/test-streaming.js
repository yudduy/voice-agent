#!/usr/bin/env node
/**
 * Test script for speculative TTS streaming implementation
 */

require('dotenv').config();
const jest = require('jest-mock');
const { createElevenLabsStream } = require('../src/services/elevenLabsStream');
const conversationService = require('../src/services/conversation');
const logger = require('../src/utils/logger');

async function testElevenLabsStreaming() {
  console.log('\n🧪 Testing ElevenLabs WebSocket Streaming...\n');
  
  const stream = createElevenLabsStream();
  
  try {
    console.log('1. Connecting to ElevenLabs WebSocket...');
    await stream.connect();
    console.log('✅ Connected successfully!\n');
    
    console.log('2. Setting up audio handlers...');
    let audioChunks = 0;
    stream.on('audio', (buffer) => {
      audioChunks++;
      console.log(`   📦 Received audio chunk #${audioChunks} (${buffer.length} bytes)`);
    });
    
    stream.on('error', (error) => {
      console.error('❌ Stream error:', error.message);
    });
    
    stream.on('end', () => {
      console.log('✅ Stream ended successfully!');
    });
    
    console.log('3. Sending test text in chunks...');
    const testText = [
      "Hello, this is Ben from Microsoft Support.",
      "We have detected a critical virus",
      "on your Windows computer.",
      "Please do not hang up",
      "as this is a matter of utmost urgency."
    ];
    
    for (let i = 0; i < testText.length; i++) {
      console.log(`   📝 Sending chunk ${i + 1}: "${testText[i]}"`);
      stream.sendText(testText[i] + " ");
      await new Promise(resolve => setTimeout(resolve, 200)); // Small delay between chunks
    }
    
    console.log('4. Sending final chunk...');
    stream.sendText('', true);
    
    console.log('5. Waiting for stream to complete...');
    await new Promise(resolve => {
      stream.once('end', resolve);
      stream.once('close', resolve);
      setTimeout(resolve, 10000); // 10 second timeout
    });
    
    console.log(`\n✅ Test completed! Received ${audioChunks} audio chunks.\n`);
    
  } catch (error) {
    console.error('❌ Test failed:', error.message);
  } finally {
    stream.close();
  }
}

async function testOpenAIStreaming() {
  console.log('\n🧪 Testing OpenAI Streaming...\n');
  
  // Mock the userRepository to prevent a real database call
  const userRepository = require('../src/repositories/userRepository');
  jest.spyOn(userRepository, 'findUser').mockResolvedValue({
    id: 'mock-uuid-12345',
    user_metadata: {
      name: 'Test User'
    },
    email: 'test@example.com'
  });

  // Mock call data
  const mockCallSid = 'test-call-' + Date.now();
  const mockUserId = 'test-user-' + Date.now();
  
  try {
    console.log('1. Starting OpenAI streaming response...');
    const stream = conversationService.getResponseStream(
      "Yes, I have a computer. What's wrong with it?",
      mockCallSid,
      mockUserId
    );
    
    console.log('2. Reading stream chunks...');
    let fullText = '';
    let chunkCount = 0;
    
    for await (const chunk of stream) {
      chunkCount++;
      fullText += chunk;
      process.stdout.write(chunk); // Write chunks as they arrive
    }
    
    console.log(`\n\n✅ Received ${chunkCount} chunks`);
    console.log(`Total response length: ${fullText.length} characters`);
    
  } catch (error) {
    console.error('❌ Test failed:', error.message);
  }
}

async function testFullPipeline() {
  console.log('\n🧪 Testing Full Streaming Pipeline...\n');
  console.log('This would test the complete flow in a real call scenario.');
  console.log('For safety, this requires an active call context.\n');
}

async function main() {
  console.log('=================================');
  console.log('Speculative TTS Streaming Tests');
  console.log('=================================');
  
  const args = process.argv.slice(2);
  const testType = args[0] || 'all';
  
  if (testType === 'elevenlabs' || testType === 'all') {
    await testElevenLabsStreaming();
  }
  
  if (testType === 'openai' || testType === 'all') {
    await testOpenAIStreaming();
  }
  
  if (testType === 'pipeline') {
    await testFullPipeline();
  }
  
  console.log('\n✅ All tests completed!');
  process.exit(0);
}

// Run tests
main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});