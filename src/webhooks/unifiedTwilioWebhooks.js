/**
 * Unified Twilio Webhooks
 * Consolidated webhook handler supporting all features with clean architecture
 */
const express = require('express');
const router = express.Router();
const VoiceResponse = require('twilio').twiml.VoiceResponse;
const logger = require('../utils/logger');
const conversationService = require('../services/conversation');
const { createStreamingHandler } = require('../services/streamingConversation');
const speechToText = require('../services/speechToText');
const textToSpeech = require('../services/textToSpeech');
const aiConfig = require('../config/ai');
const telephonyConfig = require('../config/telephony');

// Active handlers storage
const activeHandlers = new Map();

/**
 * Feature flags for different processing modes
 */
const FEATURES = {
  STREAMING: aiConfig.speechPreferences.enableStreaming,
  SPECULATIVE: aiConfig.speculativeConfig.enabled,
  BACKCHANNELS: aiConfig.backchannelConfig.enabled,
  WEBRTC: aiConfig.webrtcConfig.enabled
};

/**
 * Processing mode selector based on enabled features
 */
const getProcessingMode = () => {
  if (FEATURES.SPECULATIVE && FEATURES.BACKCHANNELS) {
    return 'ADVANCED';
  } else if (FEATURES.STREAMING) {
    return 'STREAMING';
  } else {
    return 'STANDARD';
  }
};

/**
 * Check if Groq STT should be used
 */
const shouldUseGroq = (recordingUrl) => {
  return aiConfig.speechPreferences.sttPreference === 'groq' && 
         aiConfig.groqConfig.enabled && 
         recordingUrl;
};

/**
 * Unified STT processing
 */
const processSTT = async (userInput, recordingUrl, confidence, callSid) => {
  let processedInput = null;
  const sttStartTime = Date.now();

  logger.info('[Unified STT] Processing speech input', {
    callSid,
    hasUserInput: !!userInput,
    hasRecordingUrl: !!recordingUrl,
    confidence,
    userInput: userInput ? userInput.substring(0, 100) + (userInput.length > 100 ? '...' : '') : null,
    recordingUrl: recordingUrl ? recordingUrl.substring(0, 80) + '...' : null
  });

  // Try Groq STT first if available
  if (shouldUseGroq(recordingUrl)) {
    logger.debug('[Unified STT] Attempting Groq STT', { callSid });
    try {
      const groqResult = await speechToText.transcribeWithGroq(recordingUrl);
      if (groqResult && speechToText.validateSpeechResult(groqResult)) {
        processedInput = groqResult;
        logger.info('[Unified STT] Used Groq STT', {
          callSid,
          textLength: groqResult.length,
          preview: groqResult.substring(0, 50) + '...'
        });
      }
    } catch (error) {
      logger.warn('[Unified STT] Groq STT failed', {
        callSid,
        error: error.message
      });
    }
  }

  // Fallback to Twilio STT
  if (!processedInput && userInput && speechToText.validateSpeechResult(userInput, confidence)) {
    processedInput = speechToText.processTwilioSpeechResult(userInput);
    logger.info('[Unified STT] Used Twilio STT', {
      callSid,
      textLength: processedInput.length,
      preview: processedInput.substring(0, 50) + '...'
    });
  }

  const sttLatency = Date.now() - sttStartTime;
  return { processedInput, sttLatency };
};

/**
 * Unified audio response generation
 */
const generateAudioResponse = async (response, content, options = {}) => {
  if (!content) return;

  // Handle different content types
  if (Array.isArray(content)) {
    // Multiple audio items (streaming/backchannel case)
    for (const item of content) {
      await addSingleAudioItem(response, item, options);
    }
  } else {
    // Single content item
    await addSingleAudioItem(response, content, options);
  }
};

/**
 * Add single audio item to response
 */
const addSingleAudioItem = async (response, item, options = {}) => {
  if (typeof item === 'string') {
    // Plain text - generate TTS or use Twilio fallback
    if (item.startsWith('twilio:')) {
      const text = item.replace('twilio:', '');
      response.say({
        voice: telephonyConfig.voice,
        language: telephonyConfig.language
      }, text);
    } else {
      // Generate audio with TTS
      const audioUrl = await textToSpeech.generateAudio(item);
      if (audioUrl) {
        const fullUrl = `${process.env.WEBHOOK_BASE_URL}${audioUrl}`;
        response.play(fullUrl);
      } else {
        // Ultimate fallback
        response.say({
          voice: telephonyConfig.voice,
          language: telephonyConfig.language
        }, item);
      }
    }
  } else if (item && item.audioUrl) {
    // Audio URL object
    if (item.audioUrl.startsWith('twilio:')) {
      const text = item.audioUrl.replace('twilio:', '');
      response.say({
        voice: telephonyConfig.voice,
        language: telephonyConfig.language
      }, text);
    } else {
      const fullUrl = `${process.env.WEBHOOK_BASE_URL}${item.audioUrl}`;
      response.play(fullUrl);
    }
  }
};

/**
 * Create appropriate conversation handler based on processing mode
 */
const createConversationHandler = async (callSid, userId, processingMode) => {
  switch (processingMode) {
    case 'ADVANCED':
    case 'STREAMING':
      return createStreamingHandler(userId, callSid);
    
    case 'STANDARD':
    default:
      // Use standard conversation service
      return {
        processInput: async (input) => {
          const result = await conversationService.getResponse(input, callSid);
          return {
            fullResponse: result.text,
            shouldHangup: result.shouldHangup,
            mode: 'standard'
          };
        },
        cleanup: () => {}
      };
  }
};

/**
 * Call connection endpoint - handles incoming calls
 */
router.post('/connect', async (req, res) => {
  const { CallSid: callSid, From: fromNumber, To: toNumber } = req.body;
  const response = new VoiceResponse();

  try {
    logger.info('[Unified /connect] Call connected', { callSid, fromNumber, toNumber });

    // Get or create user from phone number
    const userRepository = require('../repositories/userRepository');
    let user = await userRepository.findUserByPhoneNumber(fromNumber);
    
    if (!user) {
      logger.info('[Unified /connect] Creating guest user for phone number', { fromNumber, callSid });
      user = await userRepository.createGuestUser(fromNumber);
    }

    // Initialize conversation mapping
    logger.info('[Unified /connect] Initializing conversation', { callSid, userId: user.id });
    await conversationService.initializeConversation(callSid, { _id: user.id });

    // Generate personalized greeting using ElevenLabs TTS
    const greetingText = user.name ? 
      `Hello ${user.name}! How can I help you today?` : 
      "Hello! How can I help you today?";

    const gatherOptions = {
      input: ['speech'],
      speechTimeout: 'auto',
      speechModel: 'default',
      language: 'en-US',
      action: '/api/calls/respond',
      method: 'POST',
      actionOnEmptyResult: true,
      timeout: 30  // Give user 30 seconds to respond
    };

    // Note: Recording for Groq STT needs to be handled differently
    // The <Gather> verb doesn't support recording attributes
    if (aiConfig.speechPreferences.enableRecording && 
        aiConfig.speechPreferences.sttPreference === 'groq') {
      logger.info('[Unified /connect] Groq STT enabled (recording will be handled separately)', { callSid });
    } else {
      logger.info('[Unified /connect] Using Twilio STT only', { callSid });
    }

    // Use Gather with nested content to ensure proper flow
    const gather = response.gather(gatherOptions);
    
    // Add the greeting inside the gather to ensure proper sequencing
    const audioUrl = await textToSpeech.generateAudio(greetingText);
    if (audioUrl) {
      const fullUrl = `${process.env.WEBHOOK_BASE_URL}${audioUrl}`;
      gather.play(fullUrl);
    } else {
      // Fallback to Twilio TTS
      gather.say({
        voice: telephonyConfig.voice,
        language: telephonyConfig.language
      }, greetingText);
    }

    // Add a fallback if no input is received
    response.say({
      voice: telephonyConfig.voice,
      language: telephonyConfig.language
    }, "I didn't hear anything. Please try speaking now.");
    
    // Redirect back to gather more input
    response.redirect('/api/calls/connect');

    logger.info('[Unified /connect] Setup complete', { 
      callSid, 
      userId: user.id, 
      usedElevenLabs: !!audioUrl,
      enabledGroqSTT: gatherOptions.record 
    });

    res.type('text/xml').send(response.toString());

  } catch (error) {
    logger.error('[Unified Connect Webhook Error]', {
      callSid,
      fromNumber,
      error: error.message,
      stack: error.stack
    });

    const fallbackResponse = new VoiceResponse();
    fallbackResponse.say("I'm sorry, there was an error connecting. Please try again.");
    fallbackResponse.hangup();

    res.type('text/xml').send(fallbackResponse.toString());
  }
});

/**
 * Main /respond endpoint - handles all processing modes
 */
router.post('/respond', async (req, res) => {
  const startTs = Date.now();
  const {
    CallSid: callSid,
    SpeechResult: userInput,
    RecordingUrl: recordingUrl,
    Confidence: twilioConfidence,
    // Advanced features
    PartialResult: partialResult,
    SpeechFinal: isFinal,
    Sequence: sequence
  } = req.body;

  const response = new VoiceResponse();
  const processingMode = getProcessingMode();

  try {
    // Get or create conversation handler
    let handler = activeHandlers.get(callSid);
    if (!handler) {
      const userId = await conversationService.getUserIdByCallSid(callSid);
      if (!userId) {
        logger.error('[Unified /respond] No user ID mapping found', { callSid });
        response.say("I apologize, there was an error retrieving our conversation state.");
        response.hangup();
        return res.type('text/xml').send(response.toString());
      }

      handler = await createConversationHandler(callSid, userId, processingMode);
      activeHandlers.set(callSid, handler);
    }

    // Handle partial input for advanced modes
    if (partialResult && processingMode === 'ADVANCED' && partialResult.length >= 15) {
      logger.debug('[Unified /respond] Processing partial input', {
        callSid,
        partialResult: partialResult.substring(0, 30) + '...',
        processingMode
      });

      if (handler.processPartialInput) {
        await handler.processPartialInput(partialResult, parseFloat(twilioConfidence) || 0.8);
      }

      // Return minimal response for partial input
      response.gather({
        input: ['speech'],
        speechTimeout: 'auto',
        action: '/api/calls/respond',
        method: 'POST',
        actionOnEmptyResult: true
      });

      return res.type('text/xml').send(response.toString());
    }

    // Process complete STT input
    logger.debug('[Unified /respond] Starting STT processing', { 
      callSid, 
      hasUserInput: !!userInput, 
      hasRecordingUrl: !!recordingUrl,
      twilioConfidence,
      userInputLength: userInput ? userInput.length : 0
    });

    const { processedInput, sttLatency } = await processSTT(
      userInput,
      recordingUrl,
      twilioConfidence,
      callSid
    );

    // Handle no valid input
    if (!processedInput) {
      logger.warn('[Unified /respond] No valid speech input detected', { 
        callSid, 
        userInput, 
        recordingUrl, 
        twilioConfidence,
        sttLatency 
      });
      
      const gatherOptions = {
        input: ['speech'],
        speechTimeout: 'auto',
        action: '/api/calls/respond',
        method: 'POST',
        actionOnEmptyResult: true,
        timeout: 30
      };

      // Note: Recording for Groq STT needs to be handled differently

      const gather = response.gather(gatherOptions);
      await generateAudioResponse(gather, "I'm sorry, I didn't catch that. Could you please repeat?");

      // Fallback if still no input
      response.say({
        voice: telephonyConfig.voice,
        language: telephonyConfig.language
      }, "I'm having trouble hearing you. Goodbye!");
      response.hangup();

      return res.type('text/xml').send(response.toString());
    }

    // Process input based on mode
    let result;
    if (processingMode === 'ADVANCED' && handler.processCompleteInput) {
      // Advanced mode with speculation/backchannels
      result = await handler.processCompleteInput(processedInput, parseFloat(twilioConfidence) || 0.8);
    } else if (processingMode === 'STREAMING' && handler.processStreamingResponse) {
      // Streaming mode
      result = await handler.processStreamingResponse(processedInput);
    } else {
      // Standard mode
      result = await handler.processInput(processedInput);
    }

    // Generate audio response
    const audioContent = result.audioUrls || result.fullResponse;
    if (audioContent) {
      await generateAudioResponse(response, audioContent);
    }

    // Handle conversation end
    if (result.shouldHangup) {
      logger.info('[Unified /respond] Conversation ended', { callSid });
      response.hangup();
      
      // Cleanup handler
      if (handler.cleanup) {
        handler.cleanup();
      }
      activeHandlers.delete(callSid);
    } else {
      // Continue conversation with proper timing
      const gatherOptions = {
        input: ['speech'],
        speechTimeout: 'auto',
        action: '/api/calls/respond',
        method: 'POST',
        actionOnEmptyResult: true,
        timeout: 30
      };

      // Note: Recording for Groq STT needs to be handled differently

      // Add gather for next user input - but don't nest it inside the response audio
      response.gather(gatherOptions);
      
      // Add fallback if no response
      response.say({
        voice: telephonyConfig.voice,
        language: telephonyConfig.language
      }, "I'm still here. Please let me know how I can help you.");
      
      response.hangup(); // End call if still no response
    }

    // Log performance metrics
    const elapsedMs = Date.now() - startTs;
    logger.info('[Unified /respond] Response completed', {
      callSid,
      processingMode,
      elapsedMs,
      sttLatency,
      speculative: result.speculative || false,
      corrected: result.corrected || false,
      metrics: result.metrics || {}
    });

    res.type('text/xml').send(response.toString());

  } catch (error) {
    logger.error('[Unified Respond Webhook Error]', {
      callSid,
      processingMode,
      error: error.message,
      stack: error.stack
    });

    // Cleanup handler on error
    const handler = activeHandlers.get(callSid);
    if (handler && handler.cleanup) {
      handler.cleanup();
    }
    activeHandlers.delete(callSid);

    // Emergency fallback
    const fallbackResponse = new VoiceResponse();
    fallbackResponse.say(
      aiConfig.advancedOptimizations?.emergencyResponseText || 
      "I'm sorry, an internal error occurred. Please try again."
    );
    fallbackResponse.hangup();

    res.type('text/xml').send(fallbackResponse.toString());
  }
});

/**
 * Call status webhook
 */
router.post('/status', async (req, res) => {
  const {
    CallSid: callSid,
    CallStatus: status,
    CallDuration: duration
  } = req.body;

  logger.info('[Unified Status Webhook]', {
    callSid,
    status,
    duration,
    processingMode: getProcessingMode()
  });

  // Cleanup handler when call ends
  if (['completed', 'failed', 'busy', 'no-answer'].includes(status)) {
    const handler = activeHandlers.get(callSid);
    if (handler) {
      if (handler.cleanup) {
        handler.cleanup();
      }
      activeHandlers.delete(callSid);
      logger.info('[Unified Status] Handler cleaned up', { callSid });
    }
  }

  res.sendStatus(200);
});

/**
 * Recording status webhook
 */
router.post('/recording', async (req, res) => {
  const {
    CallSid: callSid,
    RecordingStatus: status,
    RecordingUrl: recordingUrl
  } = req.body;

  logger.info('[Unified Recording Webhook]', {
    callSid,
    status,
    recordingUrl
  });

  res.sendStatus(200);
});

/**
 * Health check endpoint
 */
router.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    processingMode: getProcessingMode(),
    features: FEATURES,
    activeHandlers: activeHandlers.size,
    uptime: process.uptime()
  });
});

/**
 * Metrics endpoint
 */
router.get('/metrics', (req, res) => {
  const metrics = {
    processingMode: getProcessingMode(),
    activeHandlers: activeHandlers.size,
    features: FEATURES,
    handlers: Array.from(activeHandlers.entries()).map(([callSid, handler]) => ({
      callSid,
      hasMetrics: typeof handler.getEnhancedMetrics === 'function',
      metrics: handler.getEnhancedMetrics ? handler.getEnhancedMetrics() : null
    }))
  };

  res.json(metrics);
});

module.exports = router;