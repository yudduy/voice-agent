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
  const { CallSid: callSid } = req.body;
  logger.info('[/connect] Received request from Twilio', { callSid });

  try {
    const response = new VoiceResponse();
    // The contact name is not readily available here anymore, so we use a generic greeting.
    const greeting = conversationService.getInitialGreeting({ name: 'there' });
    
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
      logger.debug('Recording enabled for Groq STT');
    }
    
    response.gather(gatherOptions);
    
    res.type('text/xml');
    res.send(response.toString());

  } catch (error) {
    logger.error('[Connect Webhook Error]', { callSid, error: error.message, stack: error.stack });
    const fallbackResponse = new VoiceResponse();
    fallbackResponse.say('An application error occurred. Goodbye.');
    fallbackResponse.hangup();
    res.type('text/xml');
    res.status(500).send(fallbackResponse.toString()); 
  }
});

/**
 * Webhook for continuing the conversation.
 */
router.post('/respond', async (req, res) => {
  const { CallSid: callSid, SpeechResult: userInput, RecordingUrl: recordingUrl, Confidence: twilioConfidence } = req.body;
  const response = new VoiceResponse();
  
  try {
    let processedInput = null;

    if (shouldUseGroq(recordingUrl)) {
       const groqResult = await speechToText.transcribeWithGroq(recordingUrl);
       if (groqResult && speechToText.validateSpeechResult(groqResult)) {
         processedInput = groqResult;
         logger.info('Used Groq STT for transcription', { callSid, textLength: groqResult.length });
       }
    }
    
    if (!processedInput && userInput && speechToText.validateSpeechResult(userInput, twilioConfidence)) {
        processedInput = speechToText.processTwilioSpeechResult(userInput);
        logger.info('Used Twilio STT for transcription', { callSid, textLength: processedInput.length });
    }
    
    if (!processedInput) { 
        await addSpeechToResponse(response, "I'm sorry, I didn't catch that. Could you please repeat?");
        
        const gatherOptions = {
          input: ['speech'],
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

    const { text: aiResponseText, shouldHangup } = await conversationService.getResponse(processedInput, callSid);
    
    await addSpeechToResponse(response, aiResponseText);
    
    if (shouldHangup) {
        response.hangup();
    } else {
        const gatherOptions = {
          input: ['speech'],
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
    
    res.type('text/xml').send(response.toString());

  } catch (error) {
    logger.error('[Respond Webhook Error]', { callSid, error: error.message });
    const fallbackResponse = new VoiceResponse();
    fallbackResponse.say("I'm sorry, an internal error occurred. We will follow up shortly. Thank you.");
    fallbackResponse.hangup();
    res.type('text/xml').status(500).send(fallbackResponse.toString());
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
    
    await historyRepository.updateCall(callSid, {
      status: callStatus,
      duration: parseInt(duration, 10) || 0,
      transcript: transcript,
    });

    await conversationService.clearConversation(callSid);
    res.sendStatus(200);
  } catch (error) {
    logger.error('Error in /status webhook', { callSid, callStatus, error });
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
