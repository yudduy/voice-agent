/**
 * Streaming Twilio Webhooks - Optimized for low latency
 * Handles voice calls with streaming LLM and parallel TTS processing
 */
const express = require('express');
const router = express.Router();
const VoiceResponse = require('twilio').twiml.VoiceResponse;
const logger = require('../utils/logger');
const conversationService = require('../services/conversation');
const { createStreamingVoiceHandler, isStreamingEnabled } = require('../services/streamingVoiceHandler');
const speechToText = require('../services/speechToText');
const textToSpeech = require('../services/textToSpeech');
const aiConfig = require('../config/ai');
const telephonyConfig = require('../config/telephony');

// Store active streaming handlers
const activeHandlers = new Map();

/**
 * Helper to check if we should use Groq for STT
 */
const shouldUseGroq = (recordingUrl) => {
  return aiConfig.speechPreferences.sttPreference === 'groq' && 
         aiConfig.groqConfig.enabled && 
         recordingUrl;
};

/**
 * Add speech to response with optimized audio playback
 * @param {VoiceResponse} response - Twilio VoiceResponse object
 * @param {Array<string>|string} audioUrls - Audio URLs or text for TTS
 * @param {object} options - Options for audio playback
 */
const addOptimizedSpeechToResponse = async (response, audioUrls, options = {}) => {
  if (!audioUrls) return;

  // Handle array of audio URLs (streaming case)
  if (Array.isArray(audioUrls)) {
    for (const audioUrl of audioUrls) {
      if (audioUrl.startsWith('twilio:')) {
        // Twilio fallback - use Say verb
        const text = audioUrl.replace('twilio:', '');
        response.say({
          voice: telephonyConfig.voice,
          language: telephonyConfig.language
        }, text);
      } else {
        // ElevenLabs or Hyperbolic audio URL
        const fullUrl = `${process.env.WEBHOOK_BASE_URL}${audioUrl}`;
        response.play(fullUrl);
      }
    }
  } else if (typeof audioUrls === 'string') {
    // Single text string (non-streaming fallback)
    const audioUrl = await textToSpeech.generateAudio(audioUrls);
    if (audioUrl) {
      const fullUrl = `${process.env.WEBHOOK_BASE_URL}${audioUrl}`;
      response.play(fullUrl);
    } else {
      // Ultimate fallback to Twilio Say
      response.say({
        voice: telephonyConfig.voice,
        language: telephonyConfig.language
      }, audioUrls);
    }
  }
};

/**
 * Streaming /respond webhook - Processes user input with ultra-low latency
 */
router.post('/respond', async (req, res) => {
  const startTs = Date.now();
  const { CallSid: callSid, SpeechResult: userInput, RecordingUrl: recordingUrl, Confidence: twilioConfidence } = req.body;
  const response = new VoiceResponse();
  
  try {
    let processedInput = null;
    let sttStartTime = Date.now();

    // STT Processing
    logger.debug('[Streaming /respond] Starting STT processing', { 
      callSid, 
      hasUserInput: !!userInput, 
      hasRecordingUrl: !!recordingUrl,
      twilioConfidence,
      streamingEnabled: isStreamingEnabled()
    });

    // Try Groq STT first if available
    if (shouldUseGroq(recordingUrl)) {
      logger.debug('[Streaming /respond] Attempting Groq STT', { callSid, recordingUrl });
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
    
    // Handle no input case
    if (!processedInput) { 
      logger.warn('[Streaming /respond] No valid speech input detected', { callSid });
      await addOptimizedSpeechToResponse(response, "I'm sorry, I didn't catch that. Could you please repeat?");
      
      const gatherOptions = {
        input: ['speech'],
        speechTimeout: 'auto',
        action: '/api/calls/streaming/respond',
        method: 'POST',
        actionOnEmptyResult: true,
      };

      if (aiConfig.speechPreferences.enableRecording && aiConfig.speechPreferences.sttPreference === 'groq') {
        gatherOptions.record = true;
        gatherOptions.recordingStatusCallback = '/api/calls/recording';
        gatherOptions.recordingStatusCallbackMethod = 'POST';
      }
      
      response.gather(gatherOptions);
      return res.type('text/xml').send(response.toString());
    }

    // Get or create streaming handler for this call
    let handler = activeHandlers.get(callSid);
    if (!handler) {
      // Get user ID from conversation mapping
      const userId = await conversationService.getUserIdByCallSid(callSid);
      if (!userId) {
        logger.error('[Streaming /respond] No user ID mapping found', { callSid });
        response.say("I apologize, there was an error retrieving our conversation state.");
        response.hangup();
        return res.type('text/xml').send(response.toString());
      }

      // Create new handler
      handler = createStreamingVoiceHandler(callSid);
      await handler.initialize(userId);
      activeHandlers.set(callSid, handler);
    }

    // Process with streaming if enabled
    if (isStreamingEnabled()) {
      logger.info('[Streaming /respond] Using streaming pipeline', { callSid });
      
      // Process user input through streaming pipeline
      const result = await handler.processUserInput(processedInput, sttLatency);
      
      // Add audio URLs to response
      if (result.audioUrls && result.audioUrls.length > 0) {
        await addOptimizedSpeechToResponse(response, result.audioUrls);
      } else if (result.error) {
        // Fallback for errors
        await addOptimizedSpeechToResponse(response, "I apologize, I encountered an error processing your request.");
      }

      // Handle hangup
      if (result.shouldHangup) {
        logger.info('[Streaming /respond] AI requested hangup', { callSid });
        response.hangup();
        activeHandlers.delete(callSid);
      } else {
        // Continue conversation
        const gatherOptions = {
          input: ['speech'],
          speechTimeout: 'auto',
          action: '/api/calls/streaming/respond',
          method: 'POST',
          actionOnEmptyResult: true,
        };

        if (aiConfig.speechPreferences.enableRecording && aiConfig.speechPreferences.sttPreference === 'groq') {
          gatherOptions.record = true;
          gatherOptions.recordingStatusCallback = '/api/calls/recording';
          gatherOptions.recordingStatusCallbackMethod = 'POST';
        }
        
        response.gather(gatherOptions);
      }

      // Log performance metrics
      const elapsedMs = Date.now() - startTs;
      logger.info('[Streaming /respond] Response completed', {
        callSid,
        elapsedMs,
        metrics: result.metrics,
        audioChunks: result.audioUrls?.length || 0
      });

    } else {
      // Fallback to non-streaming mode
      logger.info('[Streaming /respond] Falling back to non-streaming mode', { callSid });
      
      const aiStartTime = Date.now();
      const { text: aiResponseText, shouldHangup } = await conversationService.getResponse(processedInput, callSid);
      const aiElapsedTime = Date.now() - aiStartTime;
      
      const ttsStartTime = Date.now();
      await addOptimizedSpeechToResponse(response, aiResponseText);
      const ttsElapsedTime = Date.now() - ttsStartTime;
      
      if (shouldHangup) {
        response.hangup();
        activeHandlers.delete(callSid);
      } else {
        const gatherOptions = {
          input: ['speech'],
          speechTimeout: 'auto',
          action: '/api/calls/streaming/respond',
          method: 'POST',
          actionOnEmptyResult: true,
        };

        if (aiConfig.speechPreferences.enableRecording && aiConfig.speechPreferences.sttPreference === 'groq') {
          gatherOptions.record = true;
          gatherOptions.recordingStatusCallback = '/api/calls/recording';
          gatherOptions.recordingStatusCallbackMethod = 'POST';
        }
        
        response.gather(gatherOptions);
      }

      const elapsedMs = Date.now() - startTs;
      logger.info('[Streaming /respond] Non-streaming response completed', {
        callSid,
        elapsedMs,
        pipelineBreakdown: {
          sttMs: sttLatency,
          aiMs: aiElapsedTime,
          ttsMs: ttsElapsedTime,
          totalMs: elapsedMs
        }
      });
    }

    res.type('text/xml').send(response.toString());

  } catch (error) {
    logger.error('[Streaming Respond Webhook Error]', { 
      callSid, 
      error: error.message, 
      stack: error.stack 
    });
    
    // Clean up handler on error
    activeHandlers.delete(callSid);
    
    const fallbackResponse = new VoiceResponse();
    fallbackResponse.say("I'm sorry, an internal error occurred. We will follow up shortly. Thank you.");
    fallbackResponse.hangup();
    
    res.type('text/xml').send(fallbackResponse.toString());
  }
});

/**
 * Call status webhook - Clean up handlers when call ends
 */
router.post('/status', async (req, res) => {
  const { CallSid: callSid, CallStatus: status } = req.body;
  
  logger.info('[Streaming Status Webhook]', { callSid, status });
  
  // Clean up handler when call completes
  if (status === 'completed' || status === 'failed' || status === 'busy' || status === 'no-answer') {
    const handler = activeHandlers.get(callSid);
    if (handler) {
      handler.cleanup();
      activeHandlers.delete(callSid);
      logger.info('[Streaming Status] Cleaned up handler', { callSid });
    }
  }
  
  res.sendStatus(200);
});

module.exports = router;