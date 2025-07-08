/**
 * Webhook handlers for Twilio Voice
 */
const express = require('express');
const VoiceResponse = require('twilio').twiml.VoiceResponse;
const router = express.Router();
const logger = require('../utils/logger');
const conversationService = require('../services/conversation');
const callerService = require('../services/caller');
const historyRepository = require('../repositories/historyRepository');
const cacheService = require('../services/cacheService');
const speechToText = require('../services/speechToText');
const textToSpeech = require('../services/textToSpeech');
const telephonyConfig = require('../config/telephony');
const aiConfig = require('../config/ai');
const userRepository = require('../repositories/userRepository');

// Add comprehensive webhook logging middleware
router.use((req, res, next) => {
  const webhookDetails = {
    method: req.method,
    path: req.path,
    headers: req.headers,
    body: req.body,
    query: req.query,
    timestamp: new Date().toISOString(),
    ip: req.ip || req.connection.remoteAddress,
    userAgent: req.headers['user-agent'],
    contentType: req.headers['content-type']
  };
  
  logger.info('=== TWILIO WEBHOOK REQUEST RECEIVED ===', webhookDetails);
  console.log(`🔗 WEBHOOK: ${req.method} ${req.path} from ${req.ip}`);
  
  // Log specific Twilio fields if present
  if (req.body && req.body.CallSid) {
    const twilioDetails = {
      CallSid: req.body.CallSid,
      CallStatus: req.body.CallStatus,
      From: req.body.From,
      To: req.body.To,
      Direction: req.body.Direction,
      ForwardedFrom: req.body.ForwardedFrom,
      CallerName: req.body.CallerName,
      SpeechResult: req.body.SpeechResult,
      RecordingUrl: req.body.RecordingUrl,
      Confidence: req.body.Confidence,
      AccountSid: req.body.AccountSid,
      ApiVersion: req.body.ApiVersion
    };
    
    logger.info('Twilio Call Details', twilioDetails);
    console.log(`📞 CALL: ${twilioDetails.CallSid} - Status: ${twilioDetails.CallStatus} - From: ${twilioDetails.From} - To: ${twilioDetails.To}`);
  }
  
  // Track webhook response time
  const startTime = Date.now();
  const originalSend = res.send;
  res.send = function(data) {
    const responseTime = Date.now() - startTime;
    logger.info('Webhook Response Sent', {
      path: req.path,
      statusCode: res.statusCode,
      responseTimeMs: responseTime,
      responseLength: typeof data === 'string' ? data.length : 0
    });
    console.log(`✅ WEBHOOK RESPONSE: ${res.statusCode} (${responseTime}ms)`);
    return originalSend.call(this, data);
  };
  
  next();
});

// Helper to check if Groq STT should be preferred and is possible
const shouldUseGroq = (recordingUrl) => {
  return aiConfig.speechPreferences.sttPreference === 'groq' &&
         aiConfig.groqConfig.enabled &&
         aiConfig.speechPreferences.enableRecording &&
         recordingUrl;
};

// --- Helper Function to Add Speech to TwiML ---
async function addSpeechToResponse(twimlResponse, text) {
  const formattedText = textToSpeech.formatTextForSpeech(text);
  
  // Try to generate audio with ElevenLabs first, then Hyperbolic, then fall back to Twilio
  try {
    const audioUrl = await textToSpeech.generateAudio(formattedText);
    if (audioUrl) {
      const fullAudioUrl = `${process.env.BASE_URL}${audioUrl}`;
      logger.debug('Using custom TTS (ElevenLabs/Hyperbolic) via <Play>', { url: fullAudioUrl });
      twimlResponse.play({}, fullAudioUrl);
      return;
    }
  } catch (ttsError) {
    logger.error('Error during custom TTS generation, falling back to Twilio TTS', { error: ttsError.message });
  }
  
  logger.debug('Using Twilio TTS via <Say>');
  const twilioOptions = textToSpeech.getTwilioTtsOptions();
  const chunks = textToSpeech.splitIntoSpeechChunks(formattedText, 500);
  chunks.forEach(chunk => {
     twimlResponse.say(twilioOptions, chunk);
  });
}
// --- End Helper Function ---

/**
 * Webhook called when call is connected.
 * By this point, caller.js should have already initialized the conversation mapping.
 * This webhook's job is simply to generate the initial TwiML to greet the user and start listening.
 */
router.post('/connect', async (req, res) => {
  const startTs = Date.now();
  const { CallSid: callSid } = req.body;
  logger.info('[/connect] Received request from Twilio', { callSid });

  try {
    // Check if conversation mapping exists
    const userId = await conversationService.getUserIdByCallSid(callSid);
    if (!userId) {
      logger.warn('[/connect] No conversation mapping found for callSid', { callSid });
      
      // Continue with a generic response rather than failing
      const response = new VoiceResponse();
      response.say("Hello! I'm having a slight technical issue connecting to your account. Please try calling back in a moment.");
      response.hangup();
      
      const elapsedMs = Date.now() - startTs;
      logger.info('[/connect] Responding with no-mapping fallback TwiML', {
        callSid,
        elapsedMs,
        twimlSnippet: response.toString().slice(0, 300)
      });
      
      res.type('text/xml');
      return res.send(response.toString());
    }

    logger.debug('[/connect] Found conversation mapping', { callSid, userId });

    const response = new VoiceResponse();
    // The contact name is not readily available here anymore, so we use a generic greeting.
    const greeting = conversationService.getInitialGreeting({ name: 'there' });
    
    logger.debug('[/connect] Generated greeting', { callSid, greetingLength: greeting.length });
    
    await addSpeechToResponse(response, greeting);
    
    const gatherOptions = {
      input: ['speech'],
      speechTimeout: telephonyConfig.speechTimeout || 'auto',
      speechModel: telephonyConfig.speechModel || 'phone_call',
      action: '/api/calls/respond',
      method: 'POST',
      language: telephonyConfig.language || 'en-US',
      actionOnEmptyResult: true,
    };

    // Enable recording if Groq STT is preferred and recording is enabled
    if (aiConfig.speechPreferences.enableRecording && aiConfig.speechPreferences.sttPreference === 'groq') {
      gatherOptions.record = true;
      gatherOptions.recordingStatusCallback = '/api/calls/recording';
      gatherOptions.recordingStatusCallbackMethod = 'POST';
      logger.debug('Recording enabled for Groq STT', { callSid });
    }
    
    response.gather(gatherOptions);
    
    // --- Debug timing & TwiML ---
    const elapsedMs = Date.now() - startTs;
    logger.info('[/connect] Responding to Twilio', {
      callSid,
      elapsedMs,
      hasRecording: !!gatherOptions.record,
      twimlSnippet: response.toString().slice(0, 300)
    });

    res.type('text/xml');
    res.send(response.toString());

  } catch (error) {
    logger.error('[Connect Webhook Error]', { callSid, error: error.message, stack: error.stack });
    
    // Check if conversation mapping exists for debugging
    try {
      const userId = await conversationService.getUserIdByCallSid(callSid);
      logger.error('[Connect Webhook Debug]', { 
        callSid, 
        userIdMappingExists: !!userId, 
        userId: userId || 'NOT_FOUND',
        errorType: error.constructor.name 
      });
    } catch (debugError) {
      logger.error('[Connect Webhook Debug Failed]', { callSid, debugError: debugError.message });
    }
    
    // Always provide a fallback response to avoid 500 errors
    const fallbackResponse = new VoiceResponse();
    fallbackResponse.say("I'm sorry, there was a technical issue initializing the call. Please try calling back in a moment.");
    fallbackResponse.hangup();
    
    const elapsedMs = Date.now() - startTs;
    logger.info('[/connect] Responding with error fallback TwiML', {
      callSid,
      elapsedMs,
      twimlSnippet: fallbackResponse.toString().slice(0, 300)
    });
    
    res.type('text/xml');
    res.status(200).send(fallbackResponse.toString()); // Return 200 with hangup instead of 500
  }
});

/**
 * Webhook for continuing the conversation.
 */
router.post('/respond', async (req, res) => {
  const startTs = Date.now();
  const { CallSid: callSid, SpeechResult: userInput, RecordingUrl: recordingUrl, Confidence: twilioConfidence } = req.body;
  const response = new VoiceResponse();
  
  try {
    let processedInput = null;

    // STT Processing with enhanced logging
    logger.debug('[/respond] Starting STT processing', { 
      callSid, 
      hasUserInput: !!userInput, 
      hasRecordingUrl: !!recordingUrl,
      twilioConfidence: twilioConfidence
    });

    if (shouldUseGroq(recordingUrl)) {
       logger.debug('[/respond] Attempting Groq STT', { callSid, recordingUrl });
       const groqResult = await speechToText.transcribeWithGroq(recordingUrl);
       if (groqResult && speechToText.validateSpeechResult(groqResult)) {
         processedInput = groqResult;
         logger.info('Used Groq STT for transcription', { callSid, textLength: groqResult.length, text: groqResult.substring(0, 100) + '...' });
       } else {
         logger.warn('[/respond] Groq STT failed or returned invalid result', { callSid, groqResult });
       }
    }
    
    if (!processedInput && userInput && speechToText.validateSpeechResult(userInput, twilioConfidence)) {
        processedInput = speechToText.processTwilioSpeechResult(userInput);
        logger.info('Used Twilio STT for transcription', { callSid, textLength: processedInput.length, text: processedInput.substring(0, 100) + '...' });
    }
    
    if (!processedInput) { 
        logger.warn('[/respond] No valid speech input detected', { callSid, userInput, recordingUrl });
        await addSpeechToResponse(response, "I'm sorry, I didn't catch that. Could you please repeat?");
        
        const gatherOptions = {
          input: ['speech'],
          speechTimeout: 'auto',
          action: '/api/calls/respond',
          method: 'POST',
          actionOnEmptyResult: true,
        };

        // Enable recording for retry if Groq STT is preferred
        if (aiConfig.speechPreferences.enableRecording && aiConfig.speechPreferences.sttPreference === 'groq') {
          gatherOptions.record = true;
          gatherOptions.recordingStatusCallback = '/api/calls/recording';
          gatherOptions.recordingStatusCallbackMethod = 'POST';
        }
        
        response.gather(gatherOptions);
        return res.type('text/xml').send(response.toString());
    }

    // AI Response Generation with enhanced logging
    logger.debug('[/respond] Starting AI response generation', { callSid, inputLength: processedInput.length });
    const aiStartTime = Date.now();
    
    const { text: aiResponseText, shouldHangup } = await conversationService.getResponse(processedInput, callSid);
    
    const aiElapsedTime = Date.now() - aiStartTime;
    logger.info('[/respond] AI response generated', { 
      callSid, 
      aiElapsedMs: aiElapsedTime,
      responseLength: aiResponseText.length,
      shouldHangup,
      responsePreview: aiResponseText.substring(0, 100) + '...'
    });
    
    // TTS Generation with enhanced logging
    logger.debug('[/respond] Starting TTS generation', { callSid, textLength: aiResponseText.length });
    const ttsStartTime = Date.now();
    
    await addSpeechToResponse(response, aiResponseText);
    
    const ttsElapsedTime = Date.now() - ttsStartTime;
    logger.info('[/respond] TTS generation completed', { callSid, ttsElapsedMs: ttsElapsedTime });
    
    if (shouldHangup) {
        logger.info('[/respond] AI requested hangup, ending call', { callSid });
        response.hangup();
    } else {
        const gatherOptions = {
          input: ['speech'],
          speechTimeout: 'auto',
          action: '/api/calls/respond',
          method: 'POST',
          actionOnEmptyResult: true,
        };

        // Enable recording for next turn if Groq STT is preferred
        if (aiConfig.speechPreferences.enableRecording && aiConfig.speechPreferences.sttPreference === 'groq') {
          gatherOptions.record = true;
          gatherOptions.recordingStatusCallback = '/api/calls/recording';
          gatherOptions.recordingStatusCallbackMethod = 'POST';
        }
        
        response.gather(gatherOptions);
    }
    
    const elapsedMs = Date.now() - startTs;
    logger.info('[/respond] Responding to Twilio', {
      callSid,
      elapsedMs,
      pipelineBreakdown: {
        aiMs: aiElapsedTime,
        ttsMs: ttsElapsedTime,
        totalMs: elapsedMs
      },
      twimlSnippet: response.toString().slice(0, 300)
    });

    res.type('text/xml').send(response.toString());

  } catch (error) {
    logger.error('[Respond Webhook Error]', { callSid, error: error.message, stack: error.stack });
    
    // Enhanced debugging for respond webhook
    try {
      const userId = await conversationService.getUserIdByCallSid(callSid);
      logger.error('[Respond Webhook Debug]', { 
        callSid, 
        userIdMappingExists: !!userId, 
        userId: userId || 'NOT_FOUND',
        errorType: error.constructor.name,
        userInput: userInput || 'NO_INPUT',
        recordingUrl: recordingUrl || 'NO_RECORDING'
      });
    } catch (debugError) {
      logger.error('[Respond Webhook Debug Failed]', { callSid, debugError: debugError.message });
    }
    
    const fallbackResponse = new VoiceResponse();
    fallbackResponse.say("I'm sorry, an internal error occurred. We will follow up shortly. Thank you.");
    fallbackResponse.hangup();
    
    const elapsedMs = Date.now() - startTs;
    logger.info('[/respond] Responding with error fallback TwiML', {
      callSid,
      elapsedMs,
      twimlSnippet: fallbackResponse.toString().slice(0, 300)
    });
    res.type('text/xml').status(200).send(fallbackResponse.toString()); // Return 200 with hangup instead of 500
  }
});

/**
 * Webhook for call status updates. This is the final logging point for a call.
 */
router.post('/status', async (req, res) => {
  const { CallSid: callSid, CallStatus: callStatus, CallDuration: duration } = req.body;
  
  const terminalStatuses = ['completed', 'busy', 'failed', 'no-answer'];
  if (!terminalStatuses.includes(callStatus)) {
    return res.sendStatus(200);
  }

  logger.info(`Terminal call status update: ${callStatus}`, { callSid, duration });

  try {
    const userId = await conversationService.getUserIdByCallSid(callSid);
    if (!userId) {
      logger.warn('Received a terminal status for a call with no user mapping.', { callSid });
      return res.sendStatus(200);
    }

    let transcript = '';
    if (callStatus === 'completed') {
      const history = await cacheService.getConversation(userId);
      if (history && history.length > 0) {
        transcript = history
          .map(turn => `${turn.role === 'user' ? 'User' : 'Assistant'}: ${turn.content}`)
          .join('\\n');
      }
    }
    
    // Check if call record exists, create it if it doesn't
    let callRecord = await historyRepository.findCallBySid(callSid);
    
    if (!callRecord) {
      logger.info('Call record not found, creating initial record', { callSid, userId });
      
      // Get user phone number for the record
      const user = await userRepository.findUser({ id: userId });
      const phoneNumber = user?.phone || req.body.To || 'unknown';
      
      callRecord = await historyRepository.logCall({
        user_id: userId,
        phone_number: phoneNumber,
        call_sid: callSid,
        call_status: callStatus,
        duration: parseInt(duration, 10) || 0,
        transcript: transcript,
      });
      
      logger.info('Created call record in /status webhook', { callSid, userId });
    } else {
      // Update existing record
      await historyRepository.updateCall(callSid, {
        call_status: callStatus,
        duration: parseInt(duration, 10) || 0,
        transcript: transcript,
      });
      
      logger.info('Updated existing call record', { callSid, userId });
    }

    await conversationService.clearConversation(callSid);
    res.sendStatus(200);
  } catch (error) {
    logger.error('Error in /status webhook', { callSid, callStatus, error: error.message, stack: error.stack });
    res.sendStatus(500);
  }
});

/**
 * Webhook for recording status.
 */
router.post('/recording', async (req, res) => {
  const { CallSid: callSid, RecordingUrl: recordingUrl, RecordingStatus: recordingStatus } = req.body;
  
  try {
    if (recordingStatus === 'completed' && recordingUrl) {
      await callerService.updateCallRecording(callSid, recordingUrl);
    }
    res.sendStatus(200);
  } catch (error) {
    logger.error('Error in /recording webhook', { callSid, error: error.message });
    res.sendStatus(500);
  }
});

module.exports = router;
