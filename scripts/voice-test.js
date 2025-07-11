#!/usr/bin/env node

/**
 * Voice Test Script
 * Tests the voice pipeline with the new cost-effective models
 * 
 * Usage:
 *   node scripts/voice-test.js +1234567890
 */

// CRITICAL: Load environment variables from the project root, not the scripts directory
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// DIAGNOSTIC: Log the critical environment variable immediately
console.log('🔍 [ENV CHECK] ENABLE_MEDIA_STREAMS:', process.env.ENABLE_MEDIA_STREAMS);
console.log('🔍 [ENV CHECK] Current working directory:', process.cwd());
console.log('🔍 [ENV CHECK] Script directory:', __dirname);

const { performance } = require('perf_hooks');
const logger = require('../src/utils/logger');
const { bootstrapUser, deleteUser } = require('../tests/utils/bootstrapUser');
// Twilio setup
const twilio = require('twilio');

class VoiceTest {
  constructor() {
    this.phoneNumber = null;
    this.twilioClient = null;
    this.ngrokUrl = null;
    this.testUserId = null;
    this.callSid = null;
    this.startTime = null;
    this.metrics = {
      totalTime: 0,
      conversationTurns: 0
    };
  }

  async initialize() {
    logger.info('Starting voice test...');
    
    // Validate environment
    await this.validateEnvironment();
    
    // Setup test infrastructure
    await this.setupInfrastructure();
    
    logger.info('Voice test initialized successfully');
  }

  async validateEnvironment() {
    logger.info('Validating environment...');
    
    // Show current mode
    const isStreamingEnabled = process.env.ENABLE_MEDIA_STREAMS === 'true';
    logger.info(`🎙️ Mode: ${isStreamingEnabled ? 'REAL-TIME STREAMING (Deepgram)' : 'BATCH PROCESSING (Twilio STT)'}`);
    
    // Check required environment variables
    const required = [
      'TWILIO_ACCOUNT_SID',
      'TWILIO_AUTH_TOKEN', 
      'TWILIO_PHONE_NUMBER',
      'OPENAI_API_KEY',
      'ELEVENLABS_API_KEY'
    ];
    
    // Add Deepgram requirement if streaming is enabled
    if (isStreamingEnabled) {
      required.push('DEEPGRAM_API_KEY');
    } else {
      required.push('GROQ_API_KEY');
    }
    
    for (const envVar of required) {
      if (!process.env[envVar]) {
        throw new Error(`Missing required environment variable: ${envVar}`);
      }
    }
    
    // Test API connections
    logger.info('Testing API connections...');
    this.twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    
    try {
      await this.twilioClient.api.accounts(process.env.TWILIO_ACCOUNT_SID).fetch();
      logger.info('✓ Twilio API connection successful');
    } catch (error) {
      throw new Error(`Twilio API test failed: ${error.message}`);
    }
    
    logger.info('Environment validation complete');
  }

  async setupInfrastructure() {
    logger.info('Setting up test infrastructure...');
    
    // Create test user
    logger.info('Creating test user...');
    const { v4: uuidv4 } = require('uuid');
    const testUserId = uuidv4();
    const testName = `Test User ${Date.now()}`;
    
    const user = await bootstrapUser({ id: testUserId, phone: this.phoneNumber, name: testName });
    this.testUserId = user.id;
    logger.info(`✓ Test user created/ensured: ${this.testUserId}`);
    
    // Setup ngrok tunnel
    logger.info('Setting up ngrok tunnel...');
    await this.setupNgrok();
    
    logger.info('Infrastructure setup complete');
  }

  async setupNgrok() {
    logger.info('Checking if main app server is running...');
    
    // Check if server is running on port 3000
    const axios = require('axios');
    try {
      await axios.get('http://localhost:3000/health');
      logger.info('✓ Main app server is running on port 3000');
    } catch (error) {
      throw new Error('Main app server is not running. Please start with: npm start');
    }
    
    // Use existing ngrok URL from .env
    this.ngrokUrl = process.env.WEBHOOK_BASE_URL || process.env.BASE_URL;
    if (!this.ngrokUrl) {
      throw new Error(
        'WEBHOOK_BASE_URL or BASE_URL not found in .env file.\n\n' +
        'To set up ngrok:\n' +
        '1. Install ngrok: https://ngrok.com/download\n' +
        '2. Run: ngrok http 3000\n' +
        '3. Copy the HTTPS URL (e.g., https://abc123.ngrok-free.app)\n' +
        '4. Set in .env: WEBHOOK_BASE_URL=https://abc123.ngrok-free.app\n' +
        '5. Restart this test\n\n' +
        'Note: The ngrok URL must be accessible from the internet for Twilio webhooks to work.'
      );
    }
    
    logger.info(`✓ Using existing ngrok tunnel from .env: ${this.ngrokUrl}`);
    
    // Verify ngrok connection and check webhook configuration
    try {
      await axios.get(`${this.ngrokUrl}/health`);
      logger.info('✓ Ngrok tunnel connection verified');
      
      // Check current Twilio webhook configuration
      const twilioWebhookManager = require('../src/services/twilioWebhookManager');
      const currentConfig = await twilioWebhookManager.getCurrentConfig();
      logger.info(`📞 Twilio webhooks configured for: ${currentConfig.mode.toUpperCase()} mode`);
      logger.info(`   Voice URL: ${currentConfig.voiceUrl}`);
      
    } catch (error) {
      throw new Error(`Ngrok tunnel verification failed: ${error.message}`);
    }
  }

  async runTest() {
    logger.info('Running voice pipeline test...');
    
    this.startTime = performance.now();
    
    // Place test call
    await this.placeTestCall();
    
    // Monitor call completion
    await this.monitorCall();
    
    // Validate results
    await this.validateResults();
    
    logger.info('✓ Voice test completed');
  }

  async placeTestCall() {
    logger.info(`Placing test call to ${this.phoneNumber}...`);
    
    const callerService = require('../src/services/caller');
    const testContact = {
      _id: this.testUserId,
      phone: this.phoneNumber,
      name: `Test User ${Date.now()}`
    };
    
    try {
      // initiateCall returns the Twilio call object directly on success
      const call = await callerService.initiateCall(testContact);
      
      // Extract the call SID from the Twilio call object
      this.callSid = call.sid;
      logger.info(`✓ Call placed successfully: ${this.callSid}`);
      logger.info(`  Status: ${call.status}`);
      logger.info(`  To: ${call.to}`);
      logger.info(`  From: ${call.from}`);
    } catch (error) {
      // initiateCall throws errors on failure
      logger.error('Call placement failed:', error);
      throw new Error(`Call placement failed: ${error.message}`);
    }
  }

  async monitorCall() {
    logger.info('Monitoring call progress...');
    
    const timeout = 60000; // 60 seconds
    const startTime = Date.now();
    
    return new Promise((resolve, reject) => {
      const checkStatus = async () => {
        try {
          const call = await this.twilioClient.calls(this.callSid).fetch();
          
          if (call.status === 'completed') {
            logger.info(`✓ Call completed with status: ${call.status}`);
            resolve();
          } else if (call.status === 'failed' || call.status === 'busy' || call.status === 'no-answer') {
            reject(new Error(`Call failed with status: ${call.status}`));
          } else if (Date.now() - startTime > timeout) {
            reject(new Error('Call monitoring timeout'));
          } else {
            setTimeout(checkStatus, 1000);
          }
        } catch (error) {
          reject(error);
        }
      };
      
      logger.info(`Waiting for call completion (timeout: ${timeout}ms)...`);
      checkStatus();
    });
  }

  async validateResults() {
    logger.info('Validating conversation history...');
    
    const cacheService = require('../src/services/cacheService');
    const conversationHistory = await cacheService.getConversation(this.testUserId);
    
    if (conversationHistory && conversationHistory.length > 0) {
      this.metrics.conversationTurns = conversationHistory.length;
      logger.info(`✓ Conversation history validated: ${this.metrics.conversationTurns} turns`);
    } else {
      logger.warn('No conversation history found');
    }
  }

  async cleanup() {
    logger.info('Cleaning up test resources...');
    
    if (this.testUserId) {
      await deleteUser(this.testUserId);
      logger.info('✓ Test user cleaned up');
    }
    
    this.metrics.totalTime = performance.now() - this.startTime;
  }

  printResults() {
    const isStreamingEnabled = process.env.ENABLE_MEDIA_STREAMS === 'true';
    logger.info('\n=== Voice Test Results ===');
    logger.info(`Mode: ${isStreamingEnabled ? 'REAL-TIME STREAMING' : 'BATCH PROCESSING'}`);
    logger.info(`STT Provider: ${isStreamingEnabled ? 'Deepgram Nova-3' : 'Twilio Built-in'}`);
    logger.info(`Phone: ${this.phoneNumber}`);
    logger.info(`Total time: ${Math.round(this.metrics.totalTime)}ms`);
    logger.info(`Call SID: ${this.callSid}`);
    logger.info(`Conversation turns: ${this.metrics.conversationTurns}`);
    logger.info('=== Test Complete ===\n');
  }
}

// Main execution
async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    console.error('Usage: node scripts/voice-test.js +1234567890');
    process.exit(1);
  }
  
  const phoneNumber = args[0];
  
  const test = new VoiceTest();
  test.phoneNumber = phoneNumber;
  
  try {
    await test.initialize();
    await test.runTest();
    await test.cleanup();
    test.printResults();
  } catch (error) {
    logger.error('Voice test failed:', error);
    await test.cleanup();
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = VoiceTest;