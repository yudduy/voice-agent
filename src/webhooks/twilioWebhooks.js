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
const contactMonitor = require('../services/contactMonitor'); // Import monitor service
const { formatPhoneForCalling } = require('../utils/phoneFormatter'); // Import formatter
const { isSafeToCall } = require('../utils/phoneSafety'); // Import safety check

/**
 * Webhook called when call is connected
 */
router.post('/connect', async (req, res) => {
  const callSid = req.body.CallSid;
  const toPhoneNumber = req.body.To;
  
  // --- Log Incoming Request --- 
  logger.info('[/connect] Received request from Twilio', {
      callSid,
      to: req.body.To,
      from: req.body.From,
      callStatus: req.body.CallStatus,
      // Log other potentially useful fields from req.body if needed
      // requestBody: req.body // Uncomment for full request body if debugging complex issues
  });
  // --- End Request Logging ---

  try {
    const response = new VoiceResponse();
    let contact = null; // Initialize contact in the outer scope
    let isTestCall = false;
    let call = null; // Initialize call in the outer scope

    logger.debug('[/connect] Finding call record...', { callSid });
    call = await Call.findOne({ callSid }).exec(); // Assign to outer scope variable

    if (!call) {
      logger.warn('[/connect] Call record not found initially. Checking DB for contact by phone...', { callSid, toPhoneNumber });
      const normalizedToPhone = toPhoneNumber.startsWith('+') ? toPhoneNumber.substring(1) : toPhoneNumber;
      logger.debug('[/connect] Finding potential contact by phone...', { normalizedToPhone });
      const potentialContact = await Contact.findOne({ phone: { $regex: normalizedToPhone + '$' } }).exec(); 

      if (potentialContact) {
        // Found a contact but no Call record - this is the error state we saw!
        logger.error('[/connect] Data Integrity Error: Found contact by phone but NO matching call record.', { 
            callSid, 
            contactId: potentialContact._id 
        });
        // Send specific error TwiML and stop
        response.say('We\'re sorry, there was an issue linking this call to your record. Please contact support.');
        response.hangup();
        res.type('text/xml');
        return res.status(500).send(response.toString()); // STOP execution
      } else {
        // No Call record AND no matching Contact found - treat as a temporary test call
        logger.info('[/connect] Proceeding as temporary test call (no DB record or matching contact).', { callSid });
        isTestCall = true;
        // Assign to the outer scope contact variable
        contact = {
          _id: `test-${callSid}`,
          name: 'Test User',
          phone: toPhoneNumber
        };
      }
    } else {
      // Call record WAS found. Now find the linked contact.
      const linkedContactId = call.contactId;
      logger.debug('[/connect] Call record found. Finding linked contact...', { callSid, contactId: linkedContactId });
      
      // Assign to the outer scope contact variable
      contact = await Contact.findById(linkedContactId).exec();
      
      if (!contact) {
        // If the linked contact is NOT found - data integrity issue.
        logger.error('[/connect] Data Integrity Error: Call record found, but linked contact missing in DB.', { 
            callSid, 
            searchedContactId: linkedContactId 
        });
        response.say('We\'re sorry, there was an issue retrieving your details for this call. Please contact support.');
        response.hangup();
        res.type('text/xml');
        return res.status(500).send(response.toString()); // STOP execution
      }
      logger.debug('[/connect] Linked contact found successfully.', { contactId: contact._id });
    }
    
    // --- Call Processing Logic --- 
    // If execution reaches here, the 'contact' variable MUST be populated (either real or temporary)
    logger.debug('[/connect] Starting full call processing logic', { callSid, isTestCall, contactId: contact?._id }); // Log contact ID

    logger.debug('[/connect] Updating call status (if not test call)...', { callSid });
    if (!isTestCall && call) { // Ensure call record exists for status update
      await databaseService.updateCallStatus(callSid, 'in-progress');
    }
    
    // Initialize conversation directly
    logger.debug('[/connect] Initializing conversation...', { callSid });
    conversationService.initializeConversation(callSid, contact); 
    
    logger.debug('[/connect] Initializing transcript (if not test call)...', { callSid });
    // Ensure contactId is valid before initializing transcript
    if (!isTestCall && contact._id && mongoose.Types.ObjectId.isValid(contact._id)) {
       try {
           await transcriptService.initializeTranscript(callSid, contact._id);
       } catch (transcriptError) {
           logger.error('[/connect] Error initializing transcript', { callSid, contactId: contact._id, error: transcriptError.message });
           // Decide if this is fatal or just log and continue?
           // For now, log and continue.
       }
    } else if (!isTestCall) {
        logger.warn('[/connect] Skipping transcript initialization due to invalid/missing contact ID', { callSid, contactId: contact?._id });
    }
    
    logger.debug('[/connect] Getting initial greeting...', { callSid });
    const greeting = conversationService.getInitialGreeting(contact); // Pass the found/created contact
    
    logger.debug('[/connect] Formatting greeting for speech...', { callSid });
    const formattedGreeting = textToSpeech.formatTextForSpeech(greeting);
    
     logger.debug('[/connect] Adding greeting to transcript (if not test call)...', { callSid });
    if (!isTestCall && contact._id && mongoose.Types.ObjectId.isValid(contact._id)) {
        try {
            await transcriptService.addTranscriptEntry(callSid, 'assistant', greeting);
        } catch (transcriptError) {
            logger.error('[/connect] Error adding greeting to transcript', { callSid, error: transcriptError.message });
        }
    } else if (!isTestCall) {
         logger.warn('[/connect] Skipping adding greeting to transcript due to invalid/missing contact ID', { callSid, contactId: contact?._id });
    }
    
    logger.debug('[/connect] Generating full TwiML...', { callSid });
    // --- Original TwiML Generation --- 
    response.say({
      voice: telephonyConfig.voice || 'Polly.Joanna', // Use config, provide default
    }, formattedGreeting);
    
    response.gather({
      input: ['speech'],
      speechTimeout: telephonyConfig.speechTimeout || 'auto',
      speechModel: telephonyConfig.speechModel || 'phone_call',
      action: '/api/calls/respond',
      method: 'POST',
      language: telephonyConfig.language || 'en-US',
    });
    
    // Fallback if first gather fails
    response.say({ voice: telephonyConfig.voice || 'Polly.Joanna' }, 'I didn\'t hear anything. Can you please speak again?');
    response.gather({
       input: ['speech'],
       speechTimeout: telephonyConfig.speechTimeout || 'auto',
       speechModel: telephonyConfig.speechModel || 'phone_call',
       action: '/api/calls/respond',
       method: 'POST',
       language: telephonyConfig.language || 'en-US',
    });
    
    // Fallback if second gather fails
    response.say({ voice: telephonyConfig.voice || 'Polly.Joanna' }, 'I\'m sorry, but I still can\'t hear you. I\'ll have someone from our team call you back soon. Thank you!');
    response.hangup();
    // --- End Original TwiML Generation --- 
    
    const twimlString = response.toString();
    logger.debug('[/connect] Sending TwiML:', { twiml: twimlString }); // Log TwiML
    
    res.type('text/xml');
    res.send(twimlString);

  } catch (error) {
    // Log error in detail
    logger.error('[Connect Webhook Error - TwiML Generation Phase]', { 
      callSid, 
      errorMessage: error.message, 
      errorType: error.constructor.name, 
      errorStack: error.stack 
    });
    
    // Send back a minimal valid TwiML error response
    const fallbackResponse = new VoiceResponse();
    fallbackResponse.say('An application error occurred during call setup. Goodbye.');
    fallbackResponse.hangup();
    res.type('text/xml');
    res.status(500).send(fallbackResponse.toString()); 
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
    
    // Get AI response (now returns an object)
    const { text: aiResponseText, shouldHangup } = await conversationService.getResponse(processedInput, callSid);
    
    // Ensure we have a valid response before proceeding
    if (!aiResponseText || aiResponseText.trim().length === 0) {
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
    
    // Format for speech - Use a different name to avoid conflict
    const formattedAiText = textToSpeech.formatTextForSpeech(aiResponseText);
    
    // Check if response needs to be split (Twilio has limits)
    const responseChunks = textToSpeech.splitIntoSpeechChunks(formattedAiText);
    
    // Speak the AI response
    responseChunks.forEach(chunk => {
      response.say({
        voice: telephonyConfig.voice || 'Polly.Joanna',
      }, chunk);
    });
    
    // --- Decide whether to Hangup or Gather --- 
    if (shouldHangup) {
        logger.info('[/respond] AI indicated hangup. Ending call.', { callSid });
        response.hangup();
    } else {
        logger.debug('[/respond] AI did not indicate hangup. Gathering next input.', { callSid });
        // Continue the conversation: Gather next input
        response.gather({
          input: ['speech'],
          speechTimeout: telephonyConfig.speechTimeout || 'auto',
          speechModel: telephonyConfig.speechModel || 'phone_call',
          action: '/api/calls/respond',
          method: 'POST',
          language: telephonyConfig.language || 'en-US',
        });
        
        // Fallback if gather fails (optional, could be removed if hangup logic is reliable)
        response.say({ voice: telephonyConfig.voice || 'Polly.Joanna' }, 'Are you still there? Could you please respond?');
        response.gather({
           input: ['speech'],
           speechTimeout: telephonyConfig.speechTimeout || 'auto',
           speechModel: telephonyConfig.speechModel || 'phone_call',
           action: '/api/calls/respond',
           method: 'POST',
           language: telephonyConfig.language || 'en-US',
        });
        
        // Final fallback before hangup if still no input
        response.say({ voice: telephonyConfig.voice || 'Polly.Joanna' }, 'I\'m sorry, but I haven\'t heard from you. I\'ll have someone from our team follow up with you soon. Thank you for your time!');
        response.hangup();
    }
    // --- End Hangup/Gather Decision ---
    
    const twimlString = response.toString();
    logger.debug('[/respond] Sending TwiML:', { twiml: twimlString });

    res.type('text/xml');
    res.send(twimlString);

  } catch (error) {
    logger.error('[Respond Webhook Error]', { 
      callSid, 
      userInput: req.body.SpeechResult ? req.body.SpeechResult.substring(0,30) + '...' : 'N/A',
      errorMessage: error.message,
      errorType: error.constructor.name,
      errorStack: error.stack
    });
    
    // Fallback response
    const fallbackResponse = new VoiceResponse();
    fallbackResponse.say({
        voice: telephonyConfig.voice, // Use configured voice if possible
      }, "I'm sorry, an internal error occurred. We will follow up shortly. Thank you.");
    fallbackResponse.hangup();
    
    res.type('text/xml');
     // Send the fallback response
    res.status(500).send(fallbackResponse.toString());
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
      
      // --- Delete contact after successful completion and analysis trigger ---
      // Ensure we have the contact ID before attempting deletion
      const contactIdToDelete = updatedCall.contactId;
      if (contactIdToDelete && mongoose.Types.ObjectId.isValid(contactIdToDelete)) {
          logger.info(`Attempting to delete contact record after completed call`, { contactId: contactIdToDelete, callSid });
          // Run deletion in background, don't need to wait for it
          Contact.findByIdAndDelete(contactIdToDelete)
              .then(deletedContact => {
                  if (deletedContact) {
                      logger.info(`Successfully deleted contact record`, { contactId: contactIdToDelete, callSid });
                  } else {
                      logger.warn(`Contact record not found for deletion, may have been deleted already`, { contactId: contactIdToDelete, callSid });
                  }
              })
              .catch(deleteError => {
                  logger.error(`Error deleting contact record after call completion`, { contactId: contactIdToDelete, callSid, error: deleteError.message });
              });
      } else {
           logger.warn(`Cannot delete contact after call completion - Invalid or missing contactId in call record`, { callSid, contactId: contactIdToDelete });
      }
      // --- End contact deletion --- 

    } else if (callStatus === 'completed' && !updatedCall) {
        logger.warn('Call completed but no call record found in DB to analyze or delete contact.', { callSid });
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

/**
 * Directly initiates a call to a specific contact, bypassing monitor eligibility checks.
 * Includes basic safety validation.
 * USE WITH CAUTION - intended for debugging/manual intervention.
 */
router.post('/direct/:contactId', async (req, res) => {
    const { contactId } = req.params;
    logger.info(`Direct call requested for contactId: ${contactId}`);

    // Security/Environment Check (adjust as needed)
    if (process.env.NODE_ENV === 'production') {
        return res.status(403).json({ message: 'Direct call endpoint disabled in production.' });
    }
    
    // 1. Validate Contact ID format
    if (!mongoose.Types.ObjectId.isValid(contactId)) {
        logger.warn('Invalid contactId format provided for direct call', { contactId });
        return res.status(400).json({ error: 'Invalid contactId format.' });
    }
    
    try {
        // 2. Fetch Contact
        const contact = await Contact.findById(contactId).lean();
        if (!contact) {
            logger.warn('Contact not found for direct call', { contactId });
            return res.status(404).json({ error: 'Contact not found.' });
        }
        if (!contact.phone) {
             logger.warn('Contact found but has no phone number', { contactId });
            return res.status(400).json({ error: 'Contact has no phone number.' });
        }

        // 3. Format Phone Number
        const phoneNumberToCall = formatPhoneForCalling(contact.phone);
        if (!phoneNumberToCall) {
            logger.error('Invalid phone number format for direct call', { contactId, originalPhone: contact.phone });
            return res.status(400).json({ error: `Invalid phone number format: ${contact.phone}` });
        }

        // 4. Safety Check
        const safetyResult = isSafeToCall(phoneNumberToCall);
        if (!safetyResult.isSafe) {
            logger.warn(`Direct call blocked - phone number deemed unsafe: ${safetyResult.reason}`, { contactId, phone: phoneNumberToCall });
            return res.status(400).json({ error: `Call blocked for safety reasons: ${safetyResult.reason}` });
        }

        logger.info('Contact found and number safe, attempting direct call initiation...', { contactId, phone: phoneNumberToCall });

        // 5. Initiate Call (using callerService)
        // Note: callerService.initiateCall already has its own error handling (incl. Twilio trial checks)
        const call = await callerService.initiateCall(contact); // Pass the full contact object
        
        res.status(200).json({ 
            message: 'Direct call initiated successfully.', 
            callSid: call.sid, // Assuming initiateCall returns the Twilio call object
            contactId: contactId,
            phoneCalled: phoneNumberToCall
        });

    } catch (error) {
        // Catch errors from findById, initiateCall, etc.
        logger.error('Error during direct call initiation', { 
            contactId, 
            errorMessage: error.message, 
            errorStack: error.stack 
        });
        // Provide a generic error to the client
        res.status(500).json({ message: 'Failed to initiate direct call due to an internal error.', error: error.message });
    }
});

/**
 * Endpoint to directly process a contact by ID, bypassing monitor eligibility checks.
 * Useful for testing and manual triggering.
 */
router.post('/contacts/:contactId/process', async (req, res) => {
    const { contactId } = req.params;
    logger.info(`Direct processing requested for contactId: ${contactId}`);

    // Optional: Security/Environment Check
    if (process.env.NODE_ENV === 'production') {
        return res.status(403).json({ message: 'Direct processing endpoint disabled in production.' });
    }

    if (!mongoose.Types.ObjectId.isValid(contactId)) {
        return res.status(400).json({ error: 'Invalid contactId format.' });
    }

    try {
        const contact = await Contact.findById(contactId);
        if (!contact) {
            return res.status(404).json({ error: 'Contact not found.' });
        }
        
        logger.info('Contact found, attempting direct processing...', { contactId, name: contact.name });

        // Call processContact directly (includes safety checks)
        // processContact handles its own error logging and status updates
        await contactMonitor.processContact(contact.toObject()); // Pass plain object

        // Fetch updated status to return
        const updatedContact = await Contact.findById(contactId, 'monitorStatus callStatus lastCallSid notes').lean();

        res.status(200).json({ 
            message: 'Direct processing initiated.',
            contactId: contactId,
            // Return current status after processing attempt
            statusInfo: updatedContact || { error: 'Could not fetch updated status' }
        });

    } catch (error) {
        logger.error('Error during direct contact processing request', { 
            contactId, 
            errorMessage: error.message, 
            errorStack: error.stack 
        });
        res.status(500).json({ message: 'Failed to initiate direct processing due to an internal error.', error: error.message });
    }
});

// --- Debugging/Utility Endpoints ---

/**
 * Manually trigger a rescan of existing contacts by the monitor service.
 * (Use with caution in production)
 */
router.post('/force-rescan', async (req, res) => {
    // Optional: Add security/environment check
    if (process.env.NODE_ENV === 'production') {
        return res.status(403).json({ message: 'Endpoint disabled in production.' });
    }
    try {
        logger.info('Manual force-rescan requested.');
        // Assuming scanExistingContacts is exposed or part of startWatcher logic
        // Forcing a reset is often the easiest way to trigger scan
        if (contactMonitor.resetWatcher) {
            await contactMonitor.resetWatcher();
            res.status(200).json({ message: 'Monitor reset initiated, scan will run.' });
        } else {
             logger.warn('resetWatcher function not found on contactMonitor service.');
             res.status(500).json({ message: 'Monitor service does not support reset.' });
        }
    } catch (error) {
        logger.error('Error during manual force-rescan', { error: error.message });
        res.status(500).json({ message: 'Failed to trigger rescan.' });
    }
});

/**
 * Get the current status of the contact monitor service.
 */
router.get('/monitor-status', (req, res) => {
    // Optional: Add security/environment check
     if (process.env.NODE_ENV === 'production') {
        return res.status(403).json({ message: 'Endpoint disabled in production.' });
    }
    try {
        // Need to expose status from contactMonitor - adding a simple check for now
        // A more robust approach would involve adding a getStatus() method to contactMonitor
        const isRunning = contactMonitor.getIsMonitorRunning ? contactMonitor.getIsMonitorRunning() : false;
        const config = require('../config/monitor');
        res.status(200).json({
            monitorEnabled: config.enabled,
            isWatcherCurrentlyRunning: isRunning, // Use the getter function
            // Add more details if available from contactMonitor
        });
    } catch (error) {
         logger.error('Error retrieving monitor status', { error: error.message });
         res.status(500).json({ message: 'Failed to get monitor status.' });
    }
});

module.exports = router;
