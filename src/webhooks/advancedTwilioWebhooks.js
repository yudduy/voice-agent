/**
 * Advanced Twilio Webhooks
 * Enhanced webhook handler with speculative execution and backchannel support
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

// Store active handlers
const activeHandlers = new Map();

// Configuration
const PARTIAL_STT_THRESHOLD = 15; // Minimum characters to trigger speculation
const STREAMING_CHUNK_SIZE = 10;  // Characters per streaming chunk
const MAX_SPECULATION_TIME = 2000; // Maximum speculation time in ms

/**
 * Helper to check if we should use Groq for STT
 */
const shouldUseGroq = (recordingUrl) => {
  return aiConfig.speechPreferences.sttPreference === 'groq' && 
         aiConfig.groqConfig.enabled && 
         recordingUrl;
};

/**
 * Enhanced speech-to-response with optimized audio playback
 */
const addAdvancedSpeechToResponse = async (response, audioData, options = {}) => {
  if (!audioData) return;

  // Handle array of audio items (streaming + backchannel case)
  if (Array.isArray(audioData)) {
    for (const item of audioData) {
      if (item.isBackchannel) {
        // Handle backchannel with special timing
        await addSingleAudioToResponse(response, item, { isBackchannel: true });
      } else {
        await addSingleAudioToResponse(response, item);
      }
    }
  } else {
    // Single audio item
    await addSingleAudioToResponse(response, audioData, options);
  }
};

/**
 * Add single audio item to response
 */
const addSingleAudioToResponse = async (response, audioItem, options = {}) => {
  if (typeof audioItem === 'string') {
    // Handle plain text
    if (audioItem.startsWith('twilio:')) {
      // Twilio fallback
      const text = audioItem.replace('twilio:', '');
      response.say({
        voice: telephonyConfig.voice,
        language: telephonyConfig.language
      }, text);
    } else {
      // Generate TTS
      const audioUrl = await textToSpeech.generateAudio(audioItem);
      if (audioUrl) {
        const fullUrl = `${process.env.WEBHOOK_BASE_URL}${audioUrl}`;
        response.play(fullUrl);
      } else {
        response.say({
          voice: telephonyConfig.voice,
          language: telephonyConfig.language
        }, audioItem);
      }
    }
  } else if (audioItem.audioUrl) {
    // Handle audio URL object
    if (audioItem.audioUrl.startsWith('twilio:')) {
      const text = audioItem.audioUrl.replace('twilio:', '');
      response.say({
        voice: telephonyConfig.voice,
        language: telephonyConfig.language
      }, text);
    } else {
      const fullUrl = `${process.env.WEBHOOK_BASE_URL}${audioItem.audioUrl}`;
      response.play(fullUrl);
    }
  }
};

/**
 * Advanced /respond webhook with speculative execution
 */
router.post('/respond', async (req, res) => {
  const startTs = Date.now();
  const { 
    CallSid: callSid, 
    SpeechResult: userInput, 
    RecordingUrl: recordingUrl, 
    Confidence: twilioConfidence,
    // Enhanced fields for partial STT
    PartialResult: partialResult,
    SpeechFinal: isFinal,
    Sequence: sequence
  } = req.body;
  
  const response = new VoiceResponse();
  
  try {
    // Get or create advanced handler
    let handler = activeHandlers.get(callSid);
    if (!handler) {
      const userId = await conversationService.getUserIdByCallSid(callSid);
      if (!userId) {
        logger.error('[Advanced /respond] No user ID mapping found', { callSid });
        response.say("I apologize, there was an error retrieving our conversation state.");
        response.hangup();
        return res.type('text/xml').send(response.toString());
      }

      handler = createStreamingHandler(userId, callSid);
      activeHandlers.set(callSid, handler);
    }

    // Handle partial STT input for speculative execution
    if (partialResult && aiConfig.speculativeConfig.enabled && partialResult.length >= PARTIAL_STT_THRESHOLD) {
      logger.debug('[Advanced /respond] Processing partial STT input', {
        callSid,
        partialResult: partialResult.substring(0, 30) + '...',
        confidence: twilioConfidence,
        sequence
      });

      // Process partial input
      const speculationResult = await handler.processPartialInput(
        partialResult,
        parseFloat(twilioConfidence) || 0.8
      );

      // Return early response for partial input
      if (speculationResult.shouldSpeculate) {
        logger.info('[Advanced /respond] Speculation started', {
          callSid,
          partialInput: partialResult.substring(0, 30) + '...'
        });
        
        // Send minimal response to keep connection alive
        response.gather({
          input: ['speech'],
          speechTimeout: 'auto',
          action: '/api/calls/advanced/respond',
          method: 'POST',
          actionOnEmptyResult: true,
          partialResultCallback: '/api/calls/advanced/partial',
          partialResultCallbackMethod: 'POST'
        });
        
        return res.type('text/xml').send(response.toString());
      }
    }

    // Handle complete STT input
    let processedInput = null;
    let sttStartTime = Date.now();

    logger.debug('[Advanced /respond] Processing complete STT input', {
      callSid,
      hasUserInput: !!userInput,
      hasRecordingUrl: !!recordingUrl,
      isFinal: isFinal !== 'false',
      sequence
    });

    // Try Groq STT first
    if (shouldUseGroq(recordingUrl)) {
      logger.debug('[Advanced /respond] Attempting Groq STT', { callSid, recordingUrl });
      const groqResult = await speechToText.transcribeWithGroq(recordingUrl);
      if (groqResult && speechToText.validateSpeechResult(groqResult)) {
        processedInput = groqResult;
        logger.info('Used Groq STT for transcription', {
          callSid,
          textLength: groqResult.length,
          text: groqResult.substring(0, 100) + '...'
        });
      }
    }

    // Fallback to Twilio STT
    if (!processedInput && userInput && speechToText.validateSpeechResult(userInput, twilioConfidence)) {
      processedInput = speechToText.processTwilioSpeechResult(userInput);
      logger.info('Used Twilio STT for transcription', {
        callSid,
        textLength: processedInput.length,
        text: processedInput.substring(0, 100) + '...'
      });
    }

    const sttLatency = Date.now() - sttStartTime;

    // Handle no valid input
    if (!processedInput) {
      logger.warn('[Advanced /respond] No valid speech input detected', { callSid });
      await addAdvancedSpeechToResponse(response, "I'm sorry, I didn't catch that. Could you please repeat?");
      
      response.gather({
        input: ['speech'],
        speechTimeout: 'auto',
        action: '/api/calls/advanced/respond',
        method: 'POST',
        actionOnEmptyResult: true,
        partialResultCallback: '/api/calls/advanced/partial',
        partialResultCallbackMethod: 'POST'
      });
      
      return res.type('text/xml').send(response.toString());
    }

    // Process complete input (may use speculation results)
    const result = await handler.processCompleteInput(
      processedInput,
      parseFloat(twilioConfidence) || 0.8
    );

    // Handle audio output
    const audioItems = [];
    
    // Add backchannel audio if any
    if (result.backchannels && result.backchannels.length > 0) {
      audioItems.push(...result.backchannels);
    }
    
    // Add main response audio
    if (result.audioUrls && result.audioUrls.length > 0) {
      audioItems.push(...result.audioUrls.map(url => ({ audioUrl: url })));
    } else if (result.fullResponse) {
      audioItems.push(result.fullResponse);
    }

    // Add audio to response
    if (audioItems.length > 0) {
      await addAdvancedSpeechToResponse(response, audioItems);
    }

    // Handle conversation end
    if (result.shouldHangup) {
      logger.info('[Advanced /respond] AI requested hangup', { callSid });
      response.hangup();
      activeHandlers.delete(callSid);
    } else {
      // Continue conversation
      response.gather({
        input: ['speech'],
        speechTimeout: 'auto',
        action: '/api/calls/advanced/respond',
        method: 'POST',
        actionOnEmptyResult: true,
        partialResultCallback: '/api/calls/advanced/partial',
        partialResultCallbackMethod: 'POST'
      });
    }

    // Log performance metrics
    const elapsedMs = Date.now() - startTs;
    logger.info('[Advanced /respond] Response completed', {
      callSid,
      elapsedMs,
      sttLatency,
      speculative: result.speculative || false,
      corrected: result.corrected || false,
      backchannelCount: result.backchannels?.length || 0,
      audioChunks: result.audioUrls?.length || 0,
      enhancedMetrics: handler.getEnhancedMetrics()
    });

    res.type('text/xml').send(response.toString());

  } catch (error) {
    logger.error('[Advanced Respond Webhook Error]', {
      callSid,
      error: error.message,
      stack: error.stack
    });

    // Clean up handler
    const handler = activeHandlers.get(callSid);
    if (handler) {
      handler.cleanup();
      activeHandlers.delete(callSid);
    }

    // Emergency fallback
    const fallbackResponse = new VoiceResponse();
    fallbackResponse.say(aiConfig.advancedOptimizations.emergencyResponseText || 
      "I'm sorry, an internal error occurred. Please try again.");
    fallbackResponse.hangup();

    res.type('text/xml').send(fallbackResponse.toString());
  }
});

/**
 * Partial STT result handler for speculative execution
 */
router.post('/partial', async (req, res) => {
  const { 
    CallSid: callSid, 
    PartialResult: partialResult,
    Confidence: confidence,
    Sequence: sequence,
    UnstableSpeechResult: unstableResult
  } = req.body;

  try {
    const handler = activeHandlers.get(callSid);
    if (!handler) {
      logger.warn('[Advanced /partial] No handler found for call', { callSid });
      return res.sendStatus(200);
    }

    // Only process if speculative execution is enabled
    if (!aiConfig.speculativeConfig.enabled) {
      return res.sendStatus(200);
    }

    // Process partial result
    if (partialResult && partialResult.length >= PARTIAL_STT_THRESHOLD) {
      logger.debug('[Advanced /partial] Processing partial result', {
        callSid,
        partialResult: partialResult.substring(0, 30) + '...',
        confidence,
        sequence
      });

      await handler.processPartialInput(
        partialResult,
        parseFloat(confidence) || 0.7
      );
    }

    res.sendStatus(200);

  } catch (error) {
    logger.error('[Advanced Partial Webhook Error]', {
      callSid,
      error: error.message
    });
    res.sendStatus(500);
  }
});

/**
 * Enhanced call status webhook
 */
router.post('/status', async (req, res) => {
  const { 
    CallSid: callSid, 
    CallStatus: status,
    CallDuration: duration,
    // Enhanced status fields
    AnsweredBy: answeredBy,
    MachineDetectionDuration: machineDetectionDuration
  } = req.body;

  logger.info('[Advanced Status Webhook]', {
    callSid,
    status,
    duration,
    answeredBy,
    machineDetectionDuration
  });

  // Clean up handler when call ends
  if (['completed', 'failed', 'busy', 'no-answer'].includes(status)) {
    const handler = activeHandlers.get(callSid);
    if (handler) {
      // Get final metrics before cleanup
      const finalMetrics = handler.getEnhancedMetrics();
      
      logger.info('[Advanced Status] Final call metrics', {
        callSid,
        status,
        duration: parseInt(duration) || 0,
        metrics: finalMetrics
      });

      // Cleanup
      handler.cleanup();
      activeHandlers.delete(callSid);
    }
  }

  res.sendStatus(200);
});

/**
 * Health check endpoint for advanced features
 */
router.get('/health', (req, res) => {
  const health = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    features: {
      speculativeExecution: aiConfig.speculativeConfig.enabled,
      backchannels: aiConfig.backchannelConfig.enabled,
      streaming: aiConfig.speechPreferences.enableStreaming,
      webrtc: aiConfig.webrtcConfig.enabled
    },
    activeHandlers: activeHandlers.size,
    uptime: process.uptime()
  };

  res.json(health);
});

/**
 * Metrics endpoint for monitoring
 */
router.get('/metrics', (req, res) => {
  const metrics = {
    activeHandlers: activeHandlers.size,
    handlerMetrics: Array.from(activeHandlers.entries()).map(([callSid, handler]) => ({
      callSid,
      metrics: handler.getEnhancedMetrics()
    }))
  };

  res.json(metrics);
});

module.exports = router;