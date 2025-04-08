/**
 * Webhook handlers for Twilio
 */
const express = require('express');
const VoiceResponse = require('twilio').twiml.VoiceResponse;
const router = express.Router();
const logger = require('../utils/logger');
const conversationService = require('../services/conversation');
const callerService = require('../services/caller');
const databaseService = require('../services/database');
const speechToText = require('../services/speechToText');
const textToSpeech = require('../services/textToSpeech');
const transcriptService = require('../services/transcript');
const telephonyConfig = require('../config/telephony');
const Call = require('../models/call');
const Contact = require('../models/contact');
const mongoose = require('mongoose');

/**
 * Webhook called when call is connected
 */
router.post('/connect', async (req, res) => {
  const callSid = req.body.CallSid;
  const toPhoneNumber = req.body.To; // Get the number called
  
  try {
    logger.info('Call connected', { callSid, toPhoneNumber });
    const response = new VoiceResponse();
    
    // Try to find the call record
    let call = await Call.findOne({ callSid }).exec();
    let contact;
    let isTestCall = false;

    if (!call) {
      logger.warn('Call record not found initially. Checking if its a test call.', { callSid, toPhoneNumber });
      // Attempt to find contact by the phone number that was called
      // Normalize phone number from request if necessary (e.g., remove +)
      const normalizedToPhone = toPhoneNumber.startsWith('+') ? toPhoneNumber.substring(1) : toPhoneNumber;
      const potentialContact = await Contact.findOne({ phone: { $regex: normalizedToPhone + '$' } }).exec(); // Match ending with number

      if (potentialContact) {
        // Found a contact but no Call record - likely a race condition or creation error
        logger.error('Found contact but no call record. Possible DB issue.', { callSid, contactId: potentialContact._id });
        response.say('We\'re sorry, there was an internal error processing this call. Goodbye.');
        response.hangup();
        res.type('text/xml');
        return res.send(response.toString());
      } else {
        // No Call record and no matching Contact found - treat as a test call
        logger.info('Proceeding as a temporary test call (no DB record).', { callSid });
        isTestCall = true;
        // Create a temporary contact object for this call flow
        contact = {
          _id: `test-${callSid}`, // Use callSid to make it unique but identifiable
          name: 'Test User',
          phone: toPhoneNumber
        };
      }
    } else {
      // Call record found, proceed to find contact via contactId
      contact = await Contact.findById(call.contactId).exec();
      if (!contact) {
        // Call record exists but linked contact doesn't - data integrity issue
        logger.error('Call record found, but linked contact not found in DB.', { callSid, contactId: call.contactId });
        response.say('We\'re sorry, there was an error retrieving call details. Goodbye.');
        response.hangup();
        res.type('text/xml');
        return res.send(response.toString());
      }
    }
    
    // --- Call Processing Logic (common for real and test calls) ---
    
    // Update call status only if it's not a test call
    if (!isTestCall) {
      await databaseService.updateCallStatus(callSid, 'in-progress');
    }
    
    // Initialize conversation (works for both real and temp contact objects)
    conversationService.initializeConversation(callSid, contact);
    
    // Initialize transcript only if it's not a test call
    if (!isTestCall && contact._id) {
       // Ensure contact._id is valid before initializing transcript
       if (mongoose.Types.ObjectId.isValid(contact._id)) {
         await transcriptService.initializeTranscript(callSid, contact._id);
       } else {
         logger.warn('Skipping transcript initialization due to invalid contact ID format', { callSid, contactId: contact._id });
       }
    }
    
    // Get initial greeting (works for both real and temp contact objects)
    const greeting = conversationService.getInitialGreeting(contact);
    
    // Format for speech
    const formattedGreeting = textToSpeech.formatTextForSpeech(greeting);
    
    // Add to transcript only if it's not a test call
    if (!isTestCall) {
      await transcriptService.addTranscriptEntry(callSid, 'assistant', greeting);
    }
    
    // Start the conversation
    response.say({
      voice: telephonyConfig.voice,
    }, formattedGreeting);
    
    // Listen for user response
    response.gather({
      input: ['speech'],
      speechTimeout: telephonyConfig.speechTimeout,
      speechModel: telephonyConfig.speechModel,
      action: '/api/calls/respond',
      method: 'POST',
      language: telephonyConfig.language,
    });
    
    // If no input is received, prompt again
    response.say({
      voice: telephonyConfig.voice,
    }, 'I didn\'t hear anything. Can you please speak again?');
    
    response.gather({
      input: ['speech'],
      speechTimeout: telephonyConfig.speechTimeout,
      speechModel: telephonyConfig.speechModel,
      action: '/api/calls/respond',
      method: 'POST',
      language: telephonyConfig.language,
    });
    
    // If still no input, end the call gracefully
    response.say({
      voice: telephonyConfig.voice,
    }, "I'm sorry, but I still can't hear you. I'll have someone from our team call you back soon. Thank you!");
    
    response.hangup();
    
    res.type('text/xml');
    res.send(response.toString());
  } catch (error) {
    logger.error('Error in /connect webhook', {
      callSid,
      errorMessage: error.message,
      errorType: error.constructor.name,
      errorStack: error.stack
    });
    
    // Fallback response
    const response = new VoiceResponse();
    response.say('We\'re sorry, there was an error with this call. Please try again later.');
    response.hangup();
    
    res.type('text/xml');
    res.send(response.toString());
  }
});

/**
 * Webhook for continuing conversation
 */
router.post('/respond', async (req, res) => {
  const callSid = req.body.CallSid;
  const userInput = req.body.SpeechResult;
  
  try {
    logger.info('Received user speech', { 
      callSid, 
      input: userInput ? userInput.substring(0, 50) + (userInput.length > 50 ? '...' : '') : 'none'
    });
    
    const response = new VoiceResponse();
    
    // Validate speech result
    if (!userInput || !speechToText.validateSpeechResult(userInput)) {
      response.say({
        voice: telephonyConfig.voice,
      }, 'I\'m sorry, I didn\'t catch that. Could you please repeat?');
      
      response.gather({
        input: ['speech'],
        speechTimeout: telephonyConfig.speechTimeout,
        speechModel: telephonyConfig.speechModel,
        action: '/api/calls/respond',
        method: 'POST',
        language: telephonyConfig.language,
      });
      
      res.type('text/xml');
      return res.send(response.toString());
    }
    
    // Process speech result
    const processedInput = speechToText.processTwilioSpeechResult(userInput);
    
    // Get AI response
    const aiResponse = await conversationService.getResponse(processedInput, callSid);
    
    // Ensure we have a valid response before proceeding
    if (!aiResponse || aiResponse.trim().length === 0) {
      logger.warn('Received empty AI response', { callSid });
      // Ask user to repeat or indicate an issue
      response.say({
        voice: telephonyConfig.voice,
      }, "I'm sorry, I had trouble processing that. Could you please say that again?");
      
      response.gather({
        input: ['speech'],
        speechTimeout: telephonyConfig.speechTimeout,
        speechModel: telephonyConfig.speechModel,
        action: '/api/calls/respond',
        method: 'POST',
        language: telephonyConfig.language,
      });
      
      res.type('text/xml');
      return res.send(response.toString());
    }
    
    // Format for speech
    const formattedResponse = textToSpeech.formatTextForSpeech(aiResponse);
    
    // Check if response needs to be split (Twilio has limits)
    const responseChunks = textToSpeech.splitIntoSpeechChunks(formattedResponse);
    
    // Speak the AI response
    responseChunks.forEach(chunk => {
      response.say({
        voice: telephonyConfig.voice,
      }, chunk);
    });
    
    // Continue the conversation
    response.gather({
      input: ['speech'],
      speechTimeout: telephonyConfig.speechTimeout,
      speechModel: telephonyConfig.speechModel,
      action: '/api/calls/respond',
      method: 'POST',
      language: telephonyConfig.language,
    });
    
    // If no input is received, prompt again
    response.say({
      voice: telephonyConfig.voice,
    }, 'Are you still there? Could you please respond?');
    
    response.gather({
      input: ['speech'],
      speechTimeout: telephonyConfig.speechTimeout,
      speechModel: telephonyConfig.speechModel,
      action: '/api/calls/respond',
      method: 'POST',
      language: telephonyConfig.language,
    });
    
    // If still no input, end the call gracefully
    response.say({
      voice: telephonyConfig.voice,
    }, 'I\'m sorry, but I haven\'t heard from you. I\'ll have someone from our team follow up with you soon. Thank you for your time!');
    
    response.hangup();
    
    res.type('text/xml');
    res.send(response.toString());
  } catch (error) {
    logger.error('Error in /respond webhook', {
      callSid,
      errorMessage: error.message,
      errorType: error.constructor.name,
      errorStack: error.stack
    });
    
    // Fallback response
    const response = new VoiceResponse();
    response.say({
      voice: telephonyConfig.voice,
    }, 'I\'m sorry, I\'m having some technical difficulties. I\'ll have someone from our team call you back. Thank you!');
    
    response.hangup();
    
    res.type('text/xml');
    res.send(response.toString());
  }
});

/**
 * Webhook for call status updates
 */
router.post('/status', async (req, res) => {
  const callSid = req.body.CallSid;
  const callStatus = req.body.CallStatus;
  
  try {
    logger.info(`Call status update: ${callStatus}`, { callSid });
    
    // Update status in database
    const updatedCall = await databaseService.updateCallStatus(callSid, callStatus);
    
    // If call is completed and we have a valid updatedCall record, process the transcript
    if (callStatus === 'completed' && updatedCall) {
      logger.info('Call completed, queueing transcript analysis.', { callSid });
      // Import the analyzer service only when needed
      const transcriptAnalyzer = require('../services/transcriptAnalyzer');
      
      // Process async to avoid blocking webhook response
      // Use setImmediate for faster execution than setTimeout with 0ms
      setImmediate(async () => { 
        try {
          await transcriptAnalyzer.analyzeTranscript(callSid);
        } catch (analysisError) {
          // Error is already logged within analyzeTranscript
          logger.error('Background transcript analysis process encountered an error.', { 
            callSid, 
            errorMessage: analysisError.message 
          });
        }
      });
    } else if (callStatus === 'completed' && !updatedCall) {
        logger.warn('Call completed but no call record found in DB to analyze.', { callSid });
    }
    
    // Clean up resources if call ended (regardless of analysis)
    if (['completed', 'failed', 'busy', 'no-answer'].includes(callStatus)) {
      // Clear conversation memory
      conversationService.clearConversation(callSid);
    }
    
    res.sendStatus(200);
  } catch (error) {
    logger.error('Error in /status webhook', { callSid, callStatus, error });
    res.sendStatus(500);
  }
});

/**
 * Webhook for recording status
 */
router.post('/recording', async (req, res) => {
  const callSid = req.body.CallSid;
  const recordingSid = req.body.RecordingSid;
  const recordingUrl = req.body.RecordingUrl;
  const recordingStatus = req.body.RecordingStatus;
  
  try {
    logger.info(`Recording ${recordingStatus}`, { callSid, recordingSid });
    
    // Update call with recording URL if available
    if (recordingStatus === 'completed' && recordingUrl) {
      await callerService.updateCallRecording(callSid, recordingSid, recordingUrl);
    }
    
    res.sendStatus(200);
  } catch (error) {
    // Log the specific error message and type
    logger.error('Error in /recording webhook', { 
      callSid, 
      recordingSid, 
      errorMessage: error.message, 
      errorType: error.constructor.name, 
      errorStack: error.stack 
    });
    res.sendStatus(500);
  }
});

/**
 * Endpoint for manual testing of calls
 */
router.post('/test', async (req, res) => {
  try {
    // Only allow in development environment
    if (process.env.NODE_ENV === 'production') {
      return res.status(403).json({ error: 'Test endpoint disabled in production' });
    }
    
    const { contactId, phone } = req.body;
    
    if (!contactId && !phone) {
      return res.status(400).json({ error: 'Either contactId or phone number is required' });
    }
    
    let contact;
    
    if (contactId) {
      // Validate contactId before querying
      if (!mongoose.Types.ObjectId.isValid(contactId)) {
        logger.warn('Invalid contactId format provided in /test endpoint', { contactId });
        return res.status(400).json({ error: 'Invalid contactId format. Must be a valid MongoDB ObjectId.' });
      }
      
      // Get contact by ID
      contact = await Contact.findById(contactId);
      if (!contact) {
        return res.status(404).json({ error: 'Contact not found' });
      }
    } else {
      // Create temporary contact with provided phone
      contact = {
        _id: 'test-' + Date.now(),
        name: 'Test User',
        phone: phone
      };
    }
    
    // Initiate test call
    const call = await callerService.initiateCall(contact);
    
    res.json({
      message: 'Test call initiated',
      callSid: call.sid,
      contact: contactId ? contact._id : 'temporary',
      phone: contact.phone
    });
  } catch (error) {
    logger.error('Error in test endpoint', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
