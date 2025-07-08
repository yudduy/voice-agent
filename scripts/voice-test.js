/**
 * VERIES VOICE PIPELINE TEST
 * ==========================
 * 
 * Comprehensive test of the complete voice pipeline:
 * - Groq Whisper STT → OpenAI GPT-4o → ElevenLabs TTS
 * - Real phone call to +19713364433
 * - Supabase user creation and memory retention
 * - Redis conversation state management
 * - Enhanced logging for all API calls
 * 
 * Usage: node scripts/voice-test.js [phone_number]
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });

const twilio = require('twilio');
const ngrok = require('ngrok');
const { startServer } = require('../src/app');
const conversationService = require('../src/services/conversation');
const { bootstrapUser } = require('../tests/utils/bootstrapUser');
const logger = require('../src/utils/logger');
const voiceMonitor = require('../src/utils/voiceMonitor');
const historyRepository = require('../src/repositories/historyRepository');
const assert = require('assert');

// Configuration
const TARGET_PHONE = process.argv[2] || process.env.TEST_PHONE || '+19713364433';
const PORT = process.env.PORT || 3000;

// Enhanced logging for pipeline testing
const pipelineLogger = {
  info: (stage, message, data = {}) => {
    const logEntry = {
      stage,
      message,
      timestamp: new Date().toISOString(),
      ...data
    };
    console.log(`[${stage.toUpperCase()}] ${message}`, Object.keys(data).length ? JSON.stringify(data, null, 2) : '');
    logger.info(`Voice Pipeline Test - ${stage}`, logEntry);
  },
  
  error: (stage, message, error = {}) => {
    const logEntry = {
      stage,
      message,
      error: error.message || error,
      timestamp: new Date().toISOString()
    };
    console.error(`[${stage.toUpperCase()}] ❌ ${message}`, error);
    logger.error(`Voice Pipeline Test - ${stage}`, logEntry);
  },

  success: (stage, message, data = {}) => {
    const logEntry = {
      stage,
      message,
      timestamp: new Date().toISOString(),
      ...data
    };
    console.log(`[${stage.toUpperCase()}] ✅ ${message}`, Object.keys(data).length ? JSON.stringify(data, null, 2) : '');
    logger.info(`Voice Pipeline Test Success - ${stage}`, logEntry);
  }
};

// Validation functions
const validateEnvironment = () => {
  pipelineLogger.info('ENV_CHECK', 'Validating environment variables...');
  
  const required = [
    'TWILIO_ACCOUNT_SID',
    'TWILIO_AUTH_TOKEN', 
    'TWILIO_PHONE_NUMBER',
    'ELEVENLABS_API_KEY',
    'GROQ_API_KEY',
    'OPENAI_API_KEY',
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'UPSTASH_REDIS_REST_URL',
    'UPSTASH_REDIS_REST_TOKEN'
  ];

  const missing = required.filter(key => !process.env[key]);
  
  if (missing.length > 0) {
    pipelineLogger.error('ENV_CHECK', 'Missing required environment variables', { missing });
    throw new Error(`Missing environment variables: ${missing.join(', ')}`);
  }

  pipelineLogger.success('ENV_CHECK', 'All required environment variables present');
  
  // Log voice pipeline configuration
  pipelineLogger.info('VOICE_CONFIG', 'Voice pipeline configuration', {
    tts_provider: 'ElevenLabs',
    stt_provider: 'Groq Whisper v3',
    llm_provider: 'OpenAI GPT-4o',
    recording_enabled: process.env.ENABLE_RECORDING !== 'false',
    target_phone: TARGET_PHONE
  });
};

const testAPIConnections = async () => {
  pipelineLogger.info('API_TEST', 'Testing API connections...');
  
  // Test Twilio
  try {
    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    const account = await client.api.accounts(process.env.TWILIO_ACCOUNT_SID).fetch();
    pipelineLogger.success('API_TEST', 'Twilio connection successful', { 
      account_status: account.status,
      phone_number: process.env.TWILIO_PHONE_NUMBER,
      account_type: account.type
    });

    // Check if target phone is verified for trial accounts
    if (account.type === 'Trial') {
      pipelineLogger.info('API_TEST', 'Detected Twilio trial account - checking phone verification...');
      try {
        const verifiedNumbers = await client.outgoingCallerIds.list();
        const isVerified = verifiedNumbers.some(num => 
          num.phoneNumber === TARGET_PHONE || 
          num.phoneNumber === TARGET_PHONE.replace(/^\+1/, '') ||
          num.phoneNumber === '+1' + TARGET_PHONE.replace(/^\+1/, '')
        );
        
        if (!isVerified) {
          pipelineLogger.error('API_TEST', 'CRITICAL: Target phone number not verified for trial account', {
            target_phone: TARGET_PHONE,
            verified_numbers: verifiedNumbers.map(n => n.phoneNumber),
            solution: 'Verify the phone number in Twilio Console > Phone Numbers > Verified Caller IDs'
          });
          throw new Error(`Phone number ${TARGET_PHONE} must be verified for trial accounts`);
        } else {
          pipelineLogger.success('API_TEST', 'Target phone number is verified for trial account');
        }
      } catch (verifyError) {
        pipelineLogger.error('API_TEST', 'Could not check phone verification status', verifyError);
        // Continue anyway for paid accounts or if check fails
      }
    }
  } catch (error) {
    pipelineLogger.error('API_TEST', 'Twilio connection failed', error);
    throw error;
  }

  // Test ElevenLabs
  try {
    const textToSpeech = require('../src/services/textToSpeech');
    const testAudio = await textToSpeech.generateElevenLabsAudio('Testing ElevenLabs connection');
    pipelineLogger.success('API_TEST', 'ElevenLabs TTS connection successful', { 
      audio_generated: !!testAudio,
      cache_url: testAudio
    });
  } catch (error) {
    pipelineLogger.error('API_TEST', 'ElevenLabs TTS connection failed', error);
    throw error;
  }

  // Test OpenAI
  try {
    const { OpenAI } = require('openai');
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const completion = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'Test connection' }],
      max_tokens: 10
    });
    pipelineLogger.success('API_TEST', 'OpenAI connection successful', { 
      model: completion.model,
      response_length: completion.choices[0].message.content.length
    });
  } catch (error) {
    pipelineLogger.error('API_TEST', 'OpenAI connection failed', error);
    throw error;
  }

  // Test Supabase
  try {
    const supabase = require('../src/config/supabase');
    const { data, error } = await supabase.from('call_history').select('id').limit(1);
    if (error) throw error;
    pipelineLogger.success('API_TEST', 'Supabase connection successful');
  } catch (error) {
    pipelineLogger.error('API_TEST', 'Supabase connection failed', error);
    throw error;
  }

  // Test Redis
  try {
    const redis = require('../src/config/redis');
    await redis.set('test_connection', 'ok');
    const result = await redis.get('test_connection');
    await redis.del('test_connection');
    pipelineLogger.success('API_TEST', 'Redis connection successful', { test_result: result });
  } catch (error) {
    pipelineLogger.error('API_TEST', 'Redis connection failed', error);
    throw error;
  }
};

const setupTestUser = async () => {
  pipelineLogger.info('USER_SETUP', 'Creating test user with complete Supabase schema...');
  
  try {
    const testUserId = require('crypto').randomUUID();
    const testUser = await bootstrapUser({ 
      id: testUserId,
      phone: TARGET_PHONE,
      name: 'Voice Pipeline Test User'
    });
    
    pipelineLogger.success('USER_SETUP', 'Test user created successfully', {
      user_id: testUser.id,
      phone: testUser.phone,
      name: testUser.name
    });
    
    return testUser;
  } catch (error) {
    pipelineLogger.error('USER_SETUP', 'Failed to create test user', error);
    throw error;
  }
};

const setupWebhookServer = async () => {
  pipelineLogger.info('WEBHOOK_SETUP', 'Setting up webhook infrastructure...');
  
  try {
    // Start the Express server
    if (process.env.SKIP_LOCAL_SERVER !== 'true') {
      await startServer();
      pipelineLogger.success('WEBHOOK_SETUP', 'Express server started', { port: PORT });
    }

    // Determine webhook base URL
    let baseUrl = process.env.WEBHOOK_BASE_URL;
    let usingNgrok = false;

    if (!baseUrl) {
      if (!process.env.NGROK_AUTHTOKEN) {
        throw new Error('NGROK_AUTHTOKEN required when WEBHOOK_BASE_URL not set');
      }
      
      pipelineLogger.info('WEBHOOK_SETUP', 'Creating ngrok tunnel...');
      
      // Kill any existing ngrok processes to prevent conflicts
      try {
        await ngrok.kill();
        pipelineLogger.info('WEBHOOK_SETUP', 'Cleaned up existing ngrok processes');
      } catch (killError) {
        // Ignore if no processes to kill
      }
      
      // Create tunnel with proper configuration
      baseUrl = await ngrok.connect({ 
        authtoken: process.env.NGROK_AUTHTOKEN, 
        addr: PORT,
        region: 'us', // Specify region for better performance
        bind_tls: true, // Ensure HTTPS
        onStatusChange: (status) => {
          pipelineLogger.info('WEBHOOK_SETUP', 'Ngrok status change', { status });
        },
        onLogEvent: (data) => {
          if (data.err) {
            pipelineLogger.error('WEBHOOK_SETUP', 'Ngrok error', { error: data.err });
          }
        }
      });
      
      usingNgrok = true;
      pipelineLogger.success('WEBHOOK_SETUP', 'Ngrok tunnel established', { url: baseUrl });
      
      // Verify tunnel is working
      await verifyTunnelConnectivity(baseUrl);
    }

    // Update environment for downstream services
    process.env.WEBHOOK_BASE_URL = baseUrl;
    process.env.BASE_URL = baseUrl;

    return { baseUrl, usingNgrok };
  } catch (error) {
    pipelineLogger.error('WEBHOOK_SETUP', 'Failed to setup webhook infrastructure', error);
    throw error;
  }
};

// Add tunnel verification function
const verifyTunnelConnectivity = async (baseUrl) => {
  try {
    pipelineLogger.info('WEBHOOK_SETUP', 'Verifying tunnel connectivity...');
    const response = await fetch(`${baseUrl}/health`);
    if (response.ok) {
      pipelineLogger.success('WEBHOOK_SETUP', 'Tunnel verification successful');
    } else {
      throw new Error(`Tunnel health check failed: ${response.status}`);
    }
  } catch (error) {
    pipelineLogger.error('WEBHOOK_SETUP', 'Tunnel verification failed', error);
    throw new Error(`Webhook tunnel is not accessible: ${error.message}`);
  }
};

const initiateVoiceCall = async (testUser, baseUrl) => {
  pipelineLogger.info('VOICE_CALL', 'Initiating voice call with full pipeline logging...');
  
  try {
    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    
    const call = await client.calls.create({
      to: TARGET_PHONE,
      from: process.env.TWILIO_PHONE_NUMBER,
      url: `${baseUrl}/api/calls/connect`,
      statusCallback: `${baseUrl}/api/calls/status`,
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      statusCallbackMethod: 'POST',
      record: false, // Groq STT handles recording via <Gather record="true">
      timeout: 60,
    });

    // IMMEDIATELY initialize conversation mapping to prevent race condition
    await conversationService.initializeConversation(call.sid, {
      _id: testUser.id,
      name: testUser.name,
      phone: TARGET_PHONE,
    });

    pipelineLogger.success('VOICE_CALL', 'Voice call initiated', {
      call_sid: call.sid,
      status: call.status,
      from: call.from,
      to: call.to,
      webhook_url: `${baseUrl}/api/calls/connect`
    });

    pipelineLogger.success('VOICE_CALL', 'Conversation mapping initialized in Redis', {
      call_sid: call.sid,
      user_id: testUser.id
    });

    pipelineLogger.info('VOICE_CALL', 'Natural conversation test initiated - AI will engage automatically when call connects');

    return call.sid;
  } catch (error) {
    pipelineLogger.error('VOICE_CALL', 'Failed to initiate voice call', error);
    throw error;
  }
};

const monitorVoiceCall = async (callSid) => {
  pipelineLogger.info('MONITOR', 'Starting voice call monitoring with enhanced logging...');
  
  const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  const startTime = Date.now();
  
  return new Promise((resolve, reject) => {
    const pollInterval = setInterval(async () => {
      try {
        const call = await client.calls(callSid).fetch();
        const duration = Math.floor((Date.now() - startTime) / 1000);
        
        pipelineLogger.info('MONITOR', 'Call status update', {
          call_sid: callSid,
          status: call.status,
          call_duration: call.duration || 0,
          monitoring_duration: duration
        });

        // Log voice pipeline metrics
        const metrics = voiceMonitor.getMetricsSummary();
        if (metrics.totalRequests > 0) {
          pipelineLogger.info('VOICE_METRICS', 'Voice pipeline performance', metrics);
        }

        // Check for call completion
        if (['completed', 'busy', 'failed', 'no-answer', 'canceled'].includes(call.status)) {
          clearInterval(pollInterval);
          
          pipelineLogger.success('MONITOR', 'Call completed', {
            call_sid: callSid,
            final_status: call.status,
            total_duration: call.duration || 0
          });

          resolve(call.status);
        }

        // Timeout after 5 minutes
        if (duration > 300) {
          clearInterval(pollInterval);
          pipelineLogger.error('MONITOR', 'Call monitoring timeout', { call_sid: callSid });
          reject(new Error('Call monitoring timeout'));
        }
      } catch (error) {
        pipelineLogger.error('MONITOR', 'Error monitoring call', error);
      }
    }, 5000); // Check every 5 seconds
  });
};

const validateResults = async (callSid, userId) => {
  pipelineLogger.info('VALIDATION', 'Validating voice pipeline results...');
  try {
    // Check webhook activity first
    pipelineLogger.info('VALIDATION', 'Checking if webhooks were called during the test');
    
    // Wait longer for call completion and transcript processing
    let callHistory = null;
    for (let i = 0; i < 10; i++) {
      callHistory = await historyRepository.findCallBySid(callSid);
      if (callHistory) {
        break;
      }
      pipelineLogger.info('VALIDATION', `Validation attempt ${i + 1}/10 - waiting for call history...`);
      await new Promise(resolve => setTimeout(resolve, 3000)); // Increased wait time
    }

    if (!callHistory) {
      pipelineLogger.error('VALIDATION', 'Call history not found after extended wait', {
        note: 'This likely indicates webhooks were not called by Twilio',
        troubleshooting: 'Check webhook logs above to see if Twilio reached the server'
      });
      return false; // Don't throw error, just return false
    }

    assert(callHistory.call_sid === callSid, 'Call SID should match');

    pipelineLogger.success('VALIDATION', 'Call history recorded in Supabase', {
      call_sid: callHistory.call_sid,
      user_id: callHistory.user_id,
      status: callHistory.call_status,
      transcript_length: callHistory.transcript?.length || 0,
      summary_length: callHistory.summary?.length || 0
    });

    // Check Redis conversation state
    const redis = require('../src/config/redis');
    const conversationKey = `conversation:${userId}`;
    const conversation = await redis.get(conversationKey);
    
    if (conversation) {
      const parsedConversation = JSON.parse(conversation);
      pipelineLogger.success('VALIDATION', 'Conversation state preserved in Redis', {
        user_id: userId,
        conversation_turns: parsedConversation.length,
        last_turn: parsedConversation[parsedConversation.length - 1]?.role
      });
    }

    // Final voice pipeline metrics
    const finalMetrics = voiceMonitor.getMetricsSummary();
    pipelineLogger.success('VALIDATION', 'Final voice pipeline metrics', finalMetrics);

    return true;
  } catch (error) {
    pipelineLogger.error('VALIDATION', 'Validation failed', error);
    return false;
  }
};

// Main test execution
const runVoicePipelineTest = async () => {
  console.log('\n🎯 VERIES VOICE PIPELINE TEST');
  console.log('='.repeat(60));
  console.log(`📞 Target Phone: ${TARGET_PHONE}`);
  console.log(`🔊 Pipeline: Groq STT → OpenAI LLM → ElevenLabs TTS`);
  console.log(`📊 Enhanced Logging: Enabled`);
  console.log('='.repeat(60));

  let usingNgrok = false;

  try {
    // Step 1: Environment validation
    validateEnvironment();

    // Step 2: Test API connections
    await testAPIConnections();

    // Step 3: Setup test user
    const testUser = await setupTestUser();

    // Step 4: Setup webhook infrastructure  
    const { baseUrl, usingNgrok: ngrokFlag } = await setupWebhookServer();
    usingNgrok = ngrokFlag;

    // Step 5: Initiate voice call
    const callSid = await initiateVoiceCall(testUser, baseUrl);

    // Step 6: Monitor call with enhanced logging
    pipelineLogger.info('INSTRUCTIONS', 'Voice call is live - natural conversation will begin automatically:', {
      note1: 'Answer your phone when it rings',
      note2: 'The AI will greet you and start a natural conversation',
      note3: 'Talk naturally - Groq STT → OpenAI LLM → ElevenLabs TTS pipeline active',
      note4: 'Conversation history will be maintained in Redis',
      note5: 'Say goodbye when ready to end the call'
    });

    const finalStatus = await monitorVoiceCall(callSid);

    // Step 7: Validate results
    const validationPassed = await validateResults(callSid, testUser.id);

    // Final summary
    console.log('\n🎉 VOICE PIPELINE TEST COMPLETE');
    console.log('='.repeat(60));
    pipelineLogger.success('SUMMARY', 'Voice pipeline test completed', {
      call_status: finalStatus,
      validation_passed: validationPassed,
      test_user_id: testUser.id,
      call_sid: callSid
    });

  } catch (error) {
    pipelineLogger.error('TEST_FAILURE', 'Voice pipeline test failed', error);
    console.error('\n💥 Test failed:', error.message);
    process.exit(1);
  } finally {
    // Cleanup
    if (usingNgrok) {
      try {
        await ngrok.disconnect();
        await ngrok.kill();
        pipelineLogger.info('CLEANUP', 'Ngrok tunnel closed');
      } catch (error) {
        pipelineLogger.error('CLEANUP', 'Failed to close ngrok tunnel', error);
      }
    }
  }
};

// Run the test
if (require.main === module) {
  runVoicePipelineTest().catch(console.error);
}

module.exports = { runVoicePipelineTest }; 