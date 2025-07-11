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
const { ensureTwiMLSafe } = require('../utils/textSanitizer');

// Active handlers storage
const activeHandlers = new Map();

/**
 * Create a clean Gather options object with no recording attributes
 * @param {string} action - The action URL
 * @returns {object} - Clean gather options
 */
const createCleanGatherOptions = (action = '/api/calls/respond') => {
  // Create base options with ONLY valid Gather attributes
  const options = {
    input: 'speech',  // Changed from array to string for consistency
    speechTimeout: telephonyConfig.speechTimeout || 5,
    speechModel: telephonyConfig.speechModel || 'phone_call',
    enhanced: true,
    language: telephonyConfig.language || 'en-US',
    action: action,
    method: 'POST',
    actionOnEmptyResult: true,
    timeout: 30
  };
  
  // Log that we're creating clean options
  logger.debug('[TwiML] Creating clean Gather options (no recording attributes)', {
    options: JSON.stringify(options)
  });
  
  // Return a frozen object to prevent accidental modification
  return Object.freeze(options);
};

/**
 * Create a clean Record options object
 * @param {string} action - The action URL
 * @returns {object} - Clean record options
 */
const createCleanRecordOptions = (action = '/api/calls/process-recording') => {
  return {
    action: action,
    method: 'POST',
    maxLength: 30,
    timeout: 5,
    playBeep: false
    // Note: recordingStatusCallback can be added here if needed for Record verb
  };
};

/**
 * Validate TwiML response before sending
 * @param {string} twimlString - TwiML XML string
 * @returns {boolean} - True if valid
 */
const validateTwiML = (twimlString) => {
  // Check for invalid Gather attributes specifically - THIS CAUSES ERROR 12200
  const gatherMatches = twimlString.match(/<Gather[^>]*>/g);
  if (gatherMatches) {
    for (const gather of gatherMatches) {
      const invalidAttributes = [
        'record=', 'recordingStatus', 'transcribe=', 
        'recordingCallback', 'transcribeCallback'
      ];
      
      for (const attr of invalidAttributes) {
        if (gather.includes(attr)) {
          logger.error('CRITICAL: Invalid attribute in Gather verb - This causes Error 12200', {
            invalidAttribute: attr,
            gatherTag: gather,
            fullTwiML: twimlString,
            error: 'TwiML XML Validation Error 12200'
          });
          return false;
        }
      }
    }
  }
  
  // Check for other invalid patterns
  const invalidPatterns = [
    /<break/i, /<prosody/i, /<voice/i, /<speak/i,
    /<say-as/i, /<emphasis/i, /<sub/i, /<phoneme/i,
    /\[.*?\]/
  ];
  
  for (const pattern of invalidPatterns) {
    if (pattern.test(twimlString)) {
      logger.error('Invalid TwiML pattern detected', {
        pattern: pattern.toString(),
        twimlSnippet: twimlString.substring(0, 200)
      });
      return false;
    }
  }
  
  logger.debug('[TwiML] Validation passed - no invalid attributes detected');
  return true;
};

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
 * CRITICAL FIX: Force STANDARD mode to prevent audio interruption
 */
const getProcessingMode = () => {
  // FORCE standard mode to prevent streaming issues that cause audio cutoffs
  return 'STANDARD';
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
 * Generate complete audio response with proper TwiML structure
 */
const generateAudioResponse = async (response, content, includeGather = true) => {
  if (!content || typeof content !== 'string') return;

  logger.info('🔊 [COMPLETE-AUDIO] Generating complete response audio', {
    textLength: content.length,
    preview: content.substring(0, 100) + '...',
    includeGather
  });

  // Generate complete audio file
  const audioUrl = await textToSpeech.generateAudio(content);
  
  if (includeGather) {
    // Use Gather with nested audio to ensure proper sequencing
    const gather = response.gather(createCleanGatherOptions());
    
    if (audioUrl) {
      const fullUrl = `${process.env.BASE_URL}${audioUrl}`;
      logger.info('📺 [TWIML-GATHER-PLAY] Playing audio within Gather', { audioUrl: fullUrl });
      gather.play(fullUrl);
    } else {
      logger.info('📺 [TWIML-GATHER-SAY] Using Twilio TTS within Gather', { text: content });
      gather.say({
        voice: telephonyConfig.voice,
        language: telephonyConfig.language
      }, content);
    }
    
    // Fallback after gather timeout
    response.say({
      voice: telephonyConfig.voice,
      language: telephonyConfig.language
    }, "I'm still here. Please let me know how I can help you.");
    response.hangup();
    
  } else {
    // Just play audio without gather (for hangup scenarios)
    if (audioUrl) {
      const fullUrl = `${process.env.BASE_URL}${audioUrl}`;
      logger.info('📺 [TWIML-PLAY] Playing complete response', { audioUrl: fullUrl });
      response.play(fullUrl);
    } else {
      logger.info('📺 [TWIML-SAY] Using Twilio TTS for complete response', { text: content });
      response.say({
        voice: telephonyConfig.voice,
        language: telephonyConfig.language
      }, content);
    }
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
      logger.info('📺 [TWIML-SAY] Adding Twilio <Say> to response', {
        text: text,
        voice: telephonyConfig.voice,
        language: telephonyConfig.language
      });
      response.say({
        voice: telephonyConfig.voice,
        language: telephonyConfig.language
      }, text);
    } else {
      // Generate audio with TTS
      const audioUrl = await textToSpeech.generateAudio(item);
      if (audioUrl) {
        const fullUrl = `${process.env.BASE_URL}${audioUrl}`;
        logger.info('📺 [TWIML-PLAY] Adding <Play> to response', {
          audioUrl: fullUrl,
          originalText: item.substring(0, 100) + '...'
        });
        response.play(fullUrl);
      } else {
        // Ultimate fallback
        logger.info('📺 [TWIML-SAY] TTS failed, using Twilio <Say> fallback', {
          text: item,
          voice: telephonyConfig.voice
        });
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
      logger.info('📺 [TWIML-SAY] Adding Twilio <Say> from object', {
        text: text,
        voice: telephonyConfig.voice
      });
      response.say({
        voice: telephonyConfig.voice,
        language: telephonyConfig.language
      }, text);
    } else {
      const fullUrl = `${process.env.BASE_URL}${item.audioUrl}`;
      logger.info('📺 [TWIML-PLAY] Adding <Play> from object', {
        audioUrl: fullUrl
      });
      response.play(fullUrl);
    }
  }
};

/**
 * Create appropriate conversation handler based on processing mode
 * CRITICAL FIX: Always use standard conversation service
 */
const createConversationHandler = async (callSid, userId, processingMode) => {
  // ALWAYS use standard conversation service to prevent audio interruption
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

    // Generate concise greeting using ElevenLabs TTS
    const greetingText = user.name && user.name !== 'Guest User' ? 
      `Hi ${user.name}, this is an AI assistant calling. Is now a good time to chat?` : 
      "Hi, this is an AI assistant calling. Is now a good time to chat?";

    // Play greeting first
    const audioUrl = await textToSpeech.generateAudio(greetingText);
    if (audioUrl) {
      const fullUrl = `${process.env.BASE_URL}${audioUrl}`;
      response.play(fullUrl);
    } else {
      // Fallback to Twilio TTS
      response.say({
        voice: telephonyConfig.voice,
        language: telephonyConfig.language
      }, greetingText);
    }

    // CRITICAL FIX: Always use Twilio STT with Gather - no recording
    logger.info('[Unified /connect] Using Twilio STT with Gather (no recording)', { callSid });
    
    // Use Gather for reliable Twilio STT
    const gatherOptions = createCleanGatherOptions();
    
    // Log what we're about to create
    logger.debug('[Unified /connect] Creating Gather verb with options', { 
      callSid, 
      gatherOptions 
    });
    
    response.gather(gatherOptions);

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
      sttMode: 'twilio-gather',
      recordingDisabled: true
    });

    const twimlString = response.toString();
    
    // Log TwiML for debugging
    logger.debug('[Unified] Generated TwiML', {
      callSid,
      endpoint: req.path,
      twimlLength: twimlString.length,
      hasGather: twimlString.includes('<Gather'),
      hasRecord: twimlString.includes('<Record')
    });
    
    if (!validateTwiML(twimlString)) {
      logger.error('[Unified] TwiML validation failed - This will cause Error 12200', { 
        callSid,
        endpoint: req.path,
        twiml: twimlString 
      });
    }
    res.type('text/xml').send(twimlString);

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
      response.record(createCleanRecordOptions());

      return res.type('text/xml').send(response.toString());
    }

    // Process input based on mode - SIMPLIFIED FOR COMPLETE RESPONSE  
    let result;
    // CRITICAL FIX: Force standard mode only - no streaming/advanced processing
    result = await handler.processInput(processedInput);

    // Generate COMPLETE audio response with proper TwiML structure
    const audioContent = result.fullResponse; // Use complete text only
    if (audioContent && typeof audioContent === 'string') {
      if (result.shouldHangup) {
        // Play final message without gather
        await generateAudioResponse(response, audioContent, false);
        response.hangup();
        
        // Cleanup handler
        if (handler.cleanup) {
          handler.cleanup();
        }
        activeHandlers.delete(callSid);
      } else {
        // Play response then continue with recording
        await generateAudioResponse(response, audioContent, false);
        
        // Continue conversation with new recording after audio completes
        response.record(createCleanRecordOptions());
        
        // Add timeout fallback
        response.say({
          voice: telephonyConfig.voice,
          language: telephonyConfig.language
        }, "I'm still here. Please let me know how I can help you.");
        
        response.hangup();
      }
    } else if (result.shouldHangup) {
      // No content but should hangup
      response.hangup();
      
      if (handler.cleanup) {
        handler.cleanup();
      }
      activeHandlers.delete(callSid);
    } else {
      // No content, continue with recording
      response.record(createCleanRecordOptions());
      
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

    const twimlString = response.toString();
    
    // Log TwiML for debugging
    logger.debug('[Unified] Generated TwiML', {
      callSid,
      endpoint: req.path,
      twimlLength: twimlString.length,
      hasGather: twimlString.includes('<Gather'),
      hasRecord: twimlString.includes('<Record')
    });
    
    if (!validateTwiML(twimlString)) {
      logger.error('[Unified] TwiML validation failed - This will cause Error 12200', { 
        callSid,
        endpoint: req.path,
        twiml: twimlString 
      });
    }
    res.type('text/xml').send(twimlString);

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
    const emergencyText = ensureTwiMLSafe(
      aiConfig.advancedOptimizations?.emergencyResponseText || 
      "I'm sorry, an internal error occurred. Please try again.",
      logger
    );
    fallbackResponse.say(emergencyText);
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
      response.gather(createCleanGatherOptions());

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
      
      // Use clean gather options
      response.gather(createCleanGatherOptions());
      await generateAudioResponse(response, "I'm sorry, I didn't catch that. Could you please repeat?");

      // Fallback if still no input
      response.say({
        voice: telephonyConfig.voice,
        language: telephonyConfig.language
      }, "I'm having trouble hearing you. Goodbye!");
      response.hangup();

      return res.type('text/xml').send(response.toString());
    }

    // Process input based on mode - SIMPLIFIED FOR COMPLETE RESPONSE
    let result;
    // CRITICAL FIX: Force standard mode only - no streaming/advanced processing
    result = await handler.processInput(processedInput);

    // Generate COMPLETE audio response with proper TwiML structure
    const audioContent = result.fullResponse; // Use complete text only
    if (audioContent && typeof audioContent === 'string') {
      if (result.shouldHangup) {
        // Play final message without gather
        await generateAudioResponse(response, audioContent, false);
        response.hangup();
        
        // Cleanup handler
        if (handler.cleanup) {
          handler.cleanup();
        }
        activeHandlers.delete(callSid);
      } else {
        // Play response with gather for next input - audio plays first, then listens
        await generateAudioResponse(response, audioContent, true);
        
        // No additional TwiML needed - generateAudioResponse handles the complete flow
      }
    } else if (result.shouldHangup) {
      // No content but should hangup
      response.hangup();
      
      if (handler.cleanup) {
        handler.cleanup();
      }
      activeHandlers.delete(callSid);
    } else {
      // No content, add empty gather
      response.gather(createCleanGatherOptions());
      response.say({
        voice: telephonyConfig.voice,
        language: telephonyConfig.language
      }, "I'm still here. Please let me know how I can help you.");
      response.hangup();
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

    const twimlString = response.toString();
    
    // Log TwiML for debugging
    logger.debug('[Unified] Generated TwiML', {
      callSid,
      endpoint: req.path,
      twimlLength: twimlString.length,
      hasGather: twimlString.includes('<Gather'),
      hasRecord: twimlString.includes('<Record')
    });
    
    if (!validateTwiML(twimlString)) {
      logger.error('[Unified] TwiML validation failed - This will cause Error 12200', { 
        callSid,
        endpoint: req.path,
        twiml: twimlString 
      });
    }
    res.type('text/xml').send(twimlString);

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
    const emergencyText = ensureTwiMLSafe(
      aiConfig.advancedOptimizations?.emergencyResponseText || 
      "I'm sorry, an internal error occurred. Please try again.",
      logger
    );
    fallbackResponse.say(emergencyText);
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