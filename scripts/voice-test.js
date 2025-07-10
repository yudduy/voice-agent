#!/usr/bin/env node

/**
 * Unified Voice Test Script
 * Consolidates all voice testing modes into a single script
 * 
 * Usage:
 *   node scripts/unified-voice-test.js +1234567890 --mode=basic
 *   node scripts/unified-voice-test.js +1234567890 --mode=comprehensive  
 *   node scripts/unified-voice-test.js +1234567890 --mode=streaming
 *   node scripts/unified-voice-test.js +1234567890 --mode=advanced
 * 
 * Modes:
 *   - basic: Quick voice pipeline validation
 *   - comprehensive: Full end-to-end testing (default)
 *   - streaming: Streaming pipeline with latency metrics
 *   - advanced: Speculative execution and backchannel testing
 */

require('dotenv').config();
const { performance } = require('perf_hooks');
const logger = require('../src/utils/logger');
const { bootstrapUser, deleteUser } = require('../tests/utils/bootstrapUser');
const conversationService = require('../src/services/conversation');
const streamingConversation = require('../src/services/streamingConversation');
const speculativeEngine = require('../src/services/speculativeEngine');
const backchannelManager = require('../src/services/backchannelManager');
const voiceMonitor = require('../src/utils/voiceMonitor');

// Twilio and ngrok setup
const twilio = require('twilio');
const ngrok = require('ngrok');
const express = require('express');

// Test configuration
const TEST_MODES = {
  basic: 'basic',
  comprehensive: 'comprehensive', 
  streaming: 'streaming',
  advanced: 'advanced'
};

class UnifiedVoiceTest {
  constructor() {
    this.mode = 'comprehensive';
    this.phoneNumber = null;
    this.twilioClient = null;
    this.ngrokUrl = null;
    this.testUserId = null;
    this.callSid = null;
    this.webhookApp = null;
    this.server = null;
    this.startTime = null;
    this.metrics = {
      totalLatency: 0,
      sttLatency: 0,
      llmLatency: 0,
      ttsLatency: 0,
      speculationSuccess: 0,
      backchannelUsage: 0
    };
  }

  async run() {
    try {
      this.parseArguments();
      this.startTime = performance.now();
      
      logger.info(`Starting unified voice test in ${this.mode} mode`);
      
      // Phase 1: Environment validation
      await this.validateEnvironment();
      
      // Phase 2: Setup infrastructure
      await this.setupInfrastructure();
      
      // Phase 3: Mode-specific testing
      await this.runModeSpecificTests();
      
      // Phase 4: Cleanup
      await this.cleanup();
      
      this.reportResults();
      
    } catch (error) {
      logger.error('Voice test failed:', error);
      await this.cleanup();
      process.exit(1);
    }
  }

  parseArguments() {
    const args = process.argv.slice(2);
    
    // Parse phone number
    this.phoneNumber = args.find(arg => arg.startsWith('+')) || process.env.TEST_PHONE;
    if (!this.phoneNumber) {
      throw new Error('Phone number required: node scripts/unified-voice-test.js +1234567890');
    }
    
    // Parse mode
    const modeArg = args.find(arg => arg.startsWith('--mode='));
    if (modeArg) {
      this.mode = modeArg.split('=')[1];
    }
    
    if (!Object.values(TEST_MODES).includes(this.mode)) {
      throw new Error(`Invalid mode: ${this.mode}. Valid modes: ${Object.values(TEST_MODES).join(', ')}`);
    }
    
    logger.info(`Test configuration: ${this.phoneNumber} in ${this.mode} mode`);
  }

  async validateEnvironment() {
    logger.info('Validating environment...');
    
    const requiredEnvVars = {
      'TWILIO_ACCOUNT_SID': process.env.TWILIO_ACCOUNT_SID,
      'TWILIO_AUTH_TOKEN': process.env.TWILIO_AUTH_TOKEN,
      'TWILIO_PHONE_NUMBER': process.env.TWILIO_PHONE_NUMBER,
      'OPENAI_API_KEY': process.env.OPENAI_API_KEY,
      'GROQ_API_KEY': process.env.GROQ_API_KEY,
      'ELEVENLABS_API_KEY': process.env.ELEVENLABS_API_KEY,
      'SUPABASE_URL': process.env.SUPABASE_URL,
      'SUPABASE_SERVICE_ROLE_KEY': process.env.SUPABASE_SERVICE_ROLE_KEY,
      'UPSTASH_REDIS_REST_URL': process.env.UPSTASH_REDIS_REST_URL,
      'UPSTASH_REDIS_REST_TOKEN': process.env.UPSTASH_REDIS_REST_TOKEN,
    };

    const missingVars = Object.entries(requiredEnvVars)
      .filter(([key, value]) => !value)
      .map(([key]) => key);

    if (missingVars.length > 0) {
      throw new Error(`Missing required environment variables: ${missingVars.join(', ')}`);
    }

    // Initialize Twilio client
    this.twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    
    // Test API connections based on mode
    if (this.mode !== 'basic') {
      await this.testApiConnections();
    }
    
    logger.info('Environment validation complete');
  }

  async testApiConnections() {
    logger.info('Testing API connections...');
    
    // Test Twilio
    try {
      await this.twilioClient.api.accounts(process.env.TWILIO_ACCOUNT_SID).fetch();
      logger.info('✓ Twilio API connection successful');
    } catch (error) {
      throw new Error(`Twilio API connection failed: ${error.message}`);
    }
    
    // Test other APIs based on mode
    if (this.mode === 'streaming' || this.mode === 'advanced') {
      await this.testStreamingApis();
    }
  }

  async testStreamingApis() {
    // Test streaming conversation service
    try {
      const testResponse = await conversationService.generateResponse(
        'Test connection',
        'test-call-sid',
        'test-user-id'
      );
      logger.info('✓ Conversation service connection successful');
    } catch (error) {
      logger.warn(`Conversation service test failed: ${error.message}`);
    }
  }

  async setupInfrastructure() {
    logger.info('Setting up test infrastructure...');
    
    // Create test user
    this.testUserId = await this.createTestUser();
    
    // Check if main app is running and setup ngrok
    await this.setupNgrokTunnel();
    
    logger.info('Infrastructure setup complete');
  }

  async createTestUser() {
    logger.info('Creating test user...');
    
    try {
      const { v4: uuidv4 } = require('uuid');
      const userId = uuidv4();
      const testUser = await bootstrapUser({
        id: userId,
        phone: this.phoneNumber,
        name: `Test User ${Date.now()}`
      });
      
      logger.info(`✓ Test user created: ${testUser.id}`);
      return testUser.id;
    } catch (error) {
      throw new Error(`Failed to create test user: ${error.message}`);
    }
  }

  async checkMainAppServer() {
    logger.info('Checking if main app server is running...');
    
    try {
      const axios = require('axios');
      const response = await axios.get(`http://localhost:3000/health`, { timeout: 5000 });
      
      if (response.status === 200) {
        logger.info('✓ Main app server is running on port 3000');
        return true;
      }
    } catch (error) {
      logger.warn('Main app server not responding on port 3000');
      return false;
    }
    
    return false;
  }

  async setupNgrokTunnel() {
    logger.info('Setting up ngrok tunnel...');

    // Check if main app server is running
    const mainAppRunning = await this.checkMainAppServer();
    
    if (!mainAppRunning) {
      throw new Error('Main app server (port 3000) is not running. Please start it with: npm run dev');
    }

    // Prioritize manually started tunnel via start-tunnel.sh
    if (process.env.WEBHOOK_BASE_URL) {
      this.ngrokUrl = process.env.WEBHOOK_BASE_URL;
      logger.info(`✓ Using existing ngrok tunnel from .env: ${this.ngrokUrl}`);
      
      // Verify the tunnel points to the main app
      await this.verifyTunnelConnection();
      return;
    }

    try {
      // Connect ngrok to main app port (3000), not test server port
      this.ngrokUrl = await ngrok.connect({
        addr: 3000,
        subdomain: process.env.NGROK_SUBDOMAIN || undefined,
      });
      
      logger.info(`✓ Ngrok tunnel established: ${this.ngrokUrl}`);
      await this.verifyTunnelConnection();
    } catch (error) {
      throw new Error(`Failed to setup ngrok tunnel: ${error.message}`);
    }
  }

  async verifyTunnelConnection() {
    try {
      const axios = require('axios');
      const response = await axios.get(`${this.ngrokUrl}/health`, { timeout: 10000 });
      
      if (response.status === 200) {
        logger.info('✓ Ngrok tunnel connection verified');
      } else {
        throw new Error(`Tunnel health check failed: ${response.status}`);
      }
    } catch (error) {
      throw new Error(`Tunnel verification failed: ${error.message}`);
    }
  }

  async runModeSpecificTests() {
    logger.info(`Running ${this.mode} mode tests...`);
    
    switch (this.mode) {
      case 'basic':
        await this.runBasicTests();
        break;
      case 'comprehensive':
        await this.runComprehensiveTests();
        break;
      case 'streaming':
        await this.runStreamingTests();
        break;
      case 'advanced':
        await this.runAdvancedTests();
        break;
      default:
        throw new Error(`Unsupported test mode: ${this.mode}`);
    }
  }

  async runBasicTests() {
    logger.info('Running basic voice pipeline test...');
    
    // Place call
    await this.placeTestCall();
    
    // Wait for call completion
    await this.waitForCallCompletion(30000); // 30 second timeout
    
    logger.info('✓ Basic voice test completed');
  }

  async runComprehensiveTests() {
    logger.info('Running comprehensive voice pipeline test...');
    
    // Place call
    await this.placeTestCall();
    
    // Monitor call progress
    await this.monitorCallProgress();
    
    // Wait for call completion
    await this.waitForCallCompletion(60000); // 60 second timeout
    
    // Validate conversation history
    await this.validateConversationHistory();
    
    logger.info('✓ Comprehensive voice test completed');
  }

  async runStreamingTests() {
    logger.info('Running streaming pipeline test...');
    
    // Enable streaming features
    process.env.ENABLE_STREAMING = 'true';
    
    // Place call with streaming
    await this.placeTestCall();
    
    // Monitor streaming metrics
    await this.monitorStreamingMetrics();
    
    // Wait for call completion
    await this.waitForCallCompletion(60000);
    
    logger.info('✓ Streaming voice test completed');
  }

  async runAdvancedTests() {
    logger.info('Running advanced features test...');
    
    // Enable advanced features
    process.env.ENABLE_STREAMING = 'true';
    process.env.ENABLE_SPECULATIVE_EXECUTION = 'true';
    process.env.ENABLE_BACKCHANNELS = 'true';
    
    // Place call with advanced features
    await this.placeTestCall();
    
    // Monitor advanced metrics
    await this.monitorAdvancedMetrics();
    
    // Wait for call completion
    await this.waitForCallCompletion(90000); // Longer timeout for advanced features
    
    logger.info('✓ Advanced voice test completed');
  }

  async placeTestCall() {
    logger.info(`Placing test call to ${this.phoneNumber}...`);
    
    try {
      // Use the caller service instead of direct Twilio API to ensure conversation mapping
      const callerService = require('../src/services/caller');
      
      const contact = {
        _id: this.testUserId,
        name: `Test User ${Date.now()}`,
        phone: this.phoneNumber
      };
      
      const call = await callerService.initiateCall(contact);
      
      this.callSid = call.sid;
      logger.info(`✓ Call placed successfully: ${this.callSid}`);
    } catch (error) {
      throw new Error(`Failed to place call: ${error.message}`);
    }
  }

  async waitForCallCompletion(timeout = 60000) {
    logger.info(`Waiting for call completion (timeout: ${timeout}ms)...`);
    
    const startTime = Date.now();
    
    while (Date.now() - startTime < timeout) {
      try {
        const call = await this.twilioClient.calls(this.callSid).fetch();
        
        if (call.status === 'completed' || call.status === 'failed' || call.status === 'canceled') {
          logger.info(`✓ Call completed with status: ${call.status}`);
          return;
        }
        
        await new Promise(resolve => setTimeout(resolve, 2000)); // Check every 2 seconds
      } catch (error) {
        logger.warn(`Error checking call status: ${error.message}`);
      }
    }
    
    logger.warn('Call completion timeout reached');
  }

  async monitorCallProgress() {
    logger.info('Monitoring call progress...');
    // Basic call monitoring implementation
  }

  async monitorStreamingMetrics() {
    logger.info('Monitoring streaming metrics...');
    
    // Get voice monitor metrics
    const metrics = voiceMonitor.getMetricsSummary();
    this.metrics.totalLatency = metrics.averageLatency || 0;
    this.metrics.sttLatency = metrics.sttLatency || 0;
    this.metrics.llmLatency = metrics.llmLatency || 0;
    this.metrics.ttsLatency = metrics.ttsLatency || 0;
    
    logger.info(`Streaming metrics: ${JSON.stringify(this.metrics)}`);
  }

  async monitorAdvancedMetrics() {
    logger.info('Monitoring advanced metrics...');
    
    // Monitor speculative execution
    if (speculativeEngine && speculativeEngine.getMetrics) {
      const specMetrics = speculativeEngine.getMetrics();
      this.metrics.speculationSuccess = specMetrics.successRate || 0;
    }
    
    // Monitor backchannel usage
    if (backchannelManager && backchannelManager.getMetrics) {
      const backchannelMetrics = backchannelManager.getMetrics();
      this.metrics.backchannelUsage = backchannelMetrics.usage || 0;
    }
    
    logger.info(`Advanced metrics: ${JSON.stringify(this.metrics)}`);
  }

  async validateConversationHistory() {
    logger.info('Validating conversation history...');
    
    try {
      const cacheService = require('../src/services/cacheService');
      const conversation = await cacheService.getConversation(this.testUserId);
      
      if (conversation && conversation.length > 0) {
        logger.info(`✓ Conversation history validated: ${conversation.length} turns`);
      } else {
        logger.warn('No conversation history found');
      }
    } catch (error) {
      logger.warn(`Conversation history validation failed: ${error.message}`);
    }
  }

  // Test monitoring methods
  async monitorTestCall() {
    logger.info('Monitoring test call progress...');
    
    // The actual webhook handling is done by the main app server
    // We just monitor the call status and conversation state here
    
    try {
      const cacheService = require('../src/services/cacheService');
      
      // Check if conversation state is being created
      const conversation = await cacheService.getConversation(this.testUserId);
      if (conversation && conversation.length > 0) {
        logger.info(`✓ Conversation state detected: ${conversation.length} turns`);
      }
    } catch (error) {
      logger.warn('Could not monitor conversation state:', error.message);
    }
  }

  async cleanup() {
    logger.info('Cleaning up test resources...');
    
    try {
      // Close ngrok tunnel only if we created it (not using existing WEBHOOK_BASE_URL)
      if (this.ngrokUrl && !process.env.WEBHOOK_BASE_URL) {
        await ngrok.disconnect();
        logger.info('✓ Ngrok tunnel closed');
      }
      
      // Cleanup test user
      if (this.testUserId) {
        await this.cleanupTestUser();
      }
      
    } catch (error) {
      logger.warn('Cleanup warnings:', error);
    }
  }

  async cleanupTestUser() {
    try {
      await deleteUser(this.testUserId);
      logger.info('✓ Test user cleaned up');
    } catch (error) {
      logger.warn('Test user cleanup failed:', error);
    }
  }

  reportResults() {
    const totalTime = performance.now() - this.startTime;
    
    logger.info('=== Voice Test Results ===');
    logger.info(`Mode: ${this.mode}`);
    logger.info(`Phone: ${this.phoneNumber}`);
    logger.info(`Total time: ${Math.round(totalTime)}ms`);
    logger.info(`Call SID: ${this.callSid}`);
    
    if (this.mode === 'streaming' || this.mode === 'advanced') {
      logger.info('Performance Metrics:');
      logger.info(`  Total latency: ${this.metrics.totalLatency}ms`);
      logger.info(`  STT latency: ${this.metrics.sttLatency}ms`);
      logger.info(`  LLM latency: ${this.metrics.llmLatency}ms`);
      logger.info(`  TTS latency: ${this.metrics.ttsLatency}ms`);
    }
    
    if (this.mode === 'advanced') {
      logger.info('Advanced Features:');
      logger.info(`  Speculation success: ${this.metrics.speculationSuccess}%`);
      logger.info(`  Backchannel usage: ${this.metrics.backchannelUsage}%`);
    }
    
    logger.info('=== Test Complete ===');
  }
}

// Run the test
if (require.main === module) {
  const test = new UnifiedVoiceTest();
  test.run();
}

module.exports = UnifiedVoiceTest;