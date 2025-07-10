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
};\n\n/**\n * Sophisticated audio response generation with interruption handling\n */\nconst generateSophisticatedAudioResponse = async (response, content, callSid, options = {}) => {\n  if (!content) return;\n\n  logger.info('[Sophisticated Audio] Generating response with interruption handling', {\n    callSid,\n    contentType: typeof content,\n    isArray: Array.isArray(content)\n  });\n\n  // Split content into sentences for better interruption handling\n  const sentences = splitIntoSentences(content);\n  \n  // Generate each sentence as a separate audio item\n  for (let i = 0; i < sentences.length; i++) {\n    const sentence = sentences[i].trim();\n    if (!sentence) continue;\n\n    logger.debug('[Sophisticated Audio] Processing sentence', {\n      callSid,\n      sentenceIndex: i,\n      totalSentences: sentences.length,\n      sentence: sentence.substring(0, 50) + '...'\n    });\n\n    // Generate TTS for this sentence\n    const audioUrl = await textToSpeech.generateAudio(sentence);\n    if (audioUrl) {\n      const fullUrl = `${process.env.WEBHOOK_BASE_URL}${audioUrl}`;\n      response.play(fullUrl);\n    } else {\n      // Fallback to Twilio TTS\n      response.say({\n        voice: telephonyConfig.voice,\n        language: telephonyConfig.language\n      }, sentence);\n    }\n\n    // Add brief pause between sentences for natural flow\n    if (i < sentences.length - 1) {\n      response.pause({ length: 0.3 });\n    }\n  }\n\n  logger.info('[Sophisticated Audio] Response generation completed', {\n    callSid,\n    sentencesProcessed: sentences.length\n  });\n};\n\n/**\n * Split text into sentences for better interruption handling\n */\nconst splitIntoSentences = (text) => {\n  if (typeof text !== 'string') {\n    return [String(text)];\n  }\n\n  // Split on sentence boundaries while preserving punctuation\n  const sentences = text.split(/([.!?]+)/).reduce((acc, part, index, array) => {\n    if (index % 2 === 0) {\n      // Text part\n      const nextPart = array[index + 1];\n      if (nextPart) {\n        acc.push(part + nextPart);\n      } else {\n        acc.push(part);\n      }\n    }\n    return acc;\n  }, []);\n\n  return sentences.filter(s => s.trim().length > 0);\n};\n\n/**
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

    // Play greeting first
    const audioUrl = await textToSpeech.generateAudio(greetingText);
    if (audioUrl) {
      const fullUrl = `${process.env.WEBHOOK_BASE_URL}${audioUrl}`;
      response.play(fullUrl);
    } else {
      // Fallback to Twilio TTS
      response.say({
        voice: telephonyConfig.voice,
        language: telephonyConfig.language
      }, greetingText);
    }

    // Choose recording method based on STT preference
    if (aiConfig.speechPreferences.enableRecording && 
        aiConfig.speechPreferences.sttPreference === 'groq') {
      logger.info('[Unified /connect] Using Groq STT with recording', { callSid });
      
      // Use Record verb for Groq STT
      response.record({
        action: '/api/calls/process-recording',
        method: 'POST',
        maxLength: 30,
        timeout: 5,
        playBeep: false,
        recordingStatusCallback: '/api/calls/recording-status',
        recordingStatusCallbackMethod: 'POST'
      });
    } else {
      logger.info('[Unified /connect] Using Twilio STT with Gather', { callSid });
      
      // Use Gather for Twilio STT
      response.gather({
        input: ['speech'],
        speechTimeout: 'auto',
        speechModel: 'default',
        language: 'en-US',
        action: '/api/calls/respond',
        method: 'POST',
        actionOnEmptyResult: true,
        timeout: 30
      });
    }

    // Add a fallback if no input is received
    response.say({
      voice: telephonyConfig.voice,
      language: telephonyConfig.language
    }, "I didn't hear anything. Please try speaking now.");
    
    // Redirect back to connect
    response.redirect('/api/calls/connect');

    logger.info('[Unified /connect] Setup complete', { 
      callSid, 
      userId: user.id, 
      usedElevenLabs: !!audioUrl,
      usingGroqSTT: aiConfig.speechPreferences.sttPreference === 'groq' && aiConfig.speechPreferences.enableRecording
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
 * Process recording endpoint - handles Groq STT from recordings
 */
router.post('/process-recording', async (req, res) => {
  const startTs = Date.now();
  const {
    CallSid: callSid,
    RecordingUrl: recordingUrl,
    RecordingStatus: recordingStatus
  } = req.body;

  const response = new VoiceResponse();
  const processingMode = getProcessingMode();

  try {
    logger.info('[Unified /process-recording] Processing Groq STT recording', {
      callSid,
      recordingUrl,
      recordingStatus,
      processingMode
    });

    // Get or create conversation handler
    let handler = activeHandlers.get(callSid);
    if (!handler) {
      const userId = await conversationService.getUserIdByCallSid(callSid);
      if (!userId) {
        logger.error('[Unified /process-recording] No user ID mapping found', { callSid });
        response.say("I apologize, there was an error retrieving our conversation state.");
        response.hangup();
        return res.type('text/xml').send(response.toString());
      }

      handler = await createConversationHandler(callSid, userId, processingMode);
      activeHandlers.set(callSid, handler);
    }

    // Process recording with Groq STT
    const { processedInput, sttLatency } = await processSTT(
      null, // No userInput from Twilio
      recordingUrl,
      1.0, // High confidence for recordings
      callSid
    );

    // Handle no valid input
    if (!processedInput) {
      logger.warn('[Unified /process-recording] No valid speech detected from recording', { 
        callSid, 
        recordingUrl,
        sttLatency 
      });
      
      // Start new recording session
      const audioUrl = await textToSpeech.generateAudio("I'm sorry, I didn't catch that. Could you please repeat?");
      if (audioUrl) {
        const fullUrl = `${process.env.WEBHOOK_BASE_URL}${audioUrl}`;
        response.play(fullUrl);
      } else {
        response.say({
          voice: telephonyConfig.voice,
          language: telephonyConfig.language
        }, "I'm sorry, I didn't catch that. Could you please repeat?");
      }

      // Record again
      response.record({
        action: '/api/calls/process-recording',
        method: 'POST',
        maxLength: 30,
        timeout: 5,
        playBeep: false,
        recordingStatusCallback: '/api/calls/recording-status',
        recordingStatusCallbackMethod: 'POST'
      });

      return res.type('text/xml').send(response.toString());
    }

    // Process input based on mode
    let result;
    if (processingMode === 'ADVANCED' && handler.processCompleteInput) {
      result = await handler.processCompleteInput(processedInput, 1.0);
    } else if (processingMode === 'STREAMING' && handler.processStreamingResponse) {
      result = await handler.processStreamingResponse(processedInput);
    } else {
      result = await handler.processInput(processedInput);
    }

    // Generate sophisticated audio response with interruption handling
    const audioContent = result.audioUrls || result.fullResponse;
    if (audioContent) {
      await generateSophisticatedAudioResponse(response, audioContent, callSid);
    }

    // Handle conversation end
    if (result.shouldHangup) {
      logger.info('[Unified /process-recording] Conversation ended', { callSid });
      response.hangup();
      
      // Cleanup handler
      if (handler.cleanup) {
        handler.cleanup();
      }
      activeHandlers.delete(callSid);
    } else {
      // Continue conversation with new recording
      response.record({
        action: '/api/calls/process-recording',
        method: 'POST',
        maxLength: 30,
        timeout: 5,
        playBeep: false,
        recordingStatusCallback: '/api/calls/recording-status',
        recordingStatusCallbackMethod: 'POST'
      });
      
      // Add timeout fallback
      response.say({
        voice: telephonyConfig.voice,
        language: telephonyConfig.language
      }, "I'm still here. Please let me know how I can help you.");
      
      response.hangup();
    }

    // Log performance metrics
    const elapsedMs = Date.now() - startTs;
    logger.info('[Unified /process-recording] Response completed', {
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
    logger.error('[Unified Process Recording Webhook Error]', {
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
 * Recording status webhook
 */
router.post('/recording-status', async (req, res) => {
  const {
    CallSid: callSid,
    RecordingStatus: status,
    RecordingUrl: recordingUrl
  } = req.body;

  logger.info('[Unified Recording Status]', {
    callSid,
    status,
    recordingUrl
  });

  res.sendStatus(200);
});

/**
 * Main /respond endpoint - handles all processing modes\n */
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
      await generateSophisticatedAudioResponse(gather, "I'm sorry, I didn't catch that. Could you please repeat?", callSid);

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

    // Generate sophisticated audio response with interruption handling
    const audioContent = result.audioUrls || result.fullResponse;
    if (audioContent) {
      await generateSophisticatedAudioResponse(response, audioContent, callSid);
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