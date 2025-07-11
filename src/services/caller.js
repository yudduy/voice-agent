/**
 * Caller service for initiating and managing phone calls
 */
const twilio = require('twilio');
const telephonyConfig = require('../config/telephony');
const logger = require('../utils/logger');
const historyRepository = require('../repositories/historyRepository');
const conversationService = require('./conversation');
const { formatPhoneForCalling } = require('../utils/phoneFormatter');

// Initialize Twilio client
const client = twilio(
  telephonyConfig.accountSid, 
  telephonyConfig.authToken
);

/**
 * Initiate a call to a contact
 * @param {Object} contact - Contact document, now expecting a simplified object with `_id`, `name`, and `phone`.
 * @returns {Promise<Object>} - Twilio call object
 */
const initiateCall = async (contact) => {
  if (!contact || !contact.phone || !contact._id) {
    logger.error('InitiateCall called with invalid contact object', { contact });
    throw new Error('Invalid contact provided to initiateCall');
  }

  const userId = contact._id.toString();
  const contactName = contact.name || 'Unknown';

  try {
    const phoneNumberToCall = formatPhoneForCalling(contact.phone);
    if (!phoneNumberToCall) {
      throw new Error(`Invalid phone number format: ${contact.phone}`);
    }

    logger.info(`Initiating call to ${contactName}`, { userId, formattedPhone: phoneNumberToCall });
    
    // Always use streaming endpoint - unified webhook is being deprecated
    const connectUrl = `${telephonyConfig.webhookBaseUrl}/api/media-stream/connect`;
    const statusUrl = `${telephonyConfig.webhookBaseUrl}/api/media-stream/status`;
    
    logger.info('Using STREAMING mode with Deepgram STT for outgoing call', { 
      connectUrl,
      statusUrl 
    });
    
    const call = await client.calls.create({
      url: connectUrl,
      to: phoneNumberToCall,
      from: telephonyConfig.phoneNumber,
      statusCallback: statusUrl,
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      statusCallbackMethod: 'POST'
      // NOTE: record and recordingStatusCallback are NOT valid attributes for call creation
      // These should be handled by TwiML verbs (Record or Gather) in the webhooks
    });
    
    logger.info(`[initiateCall] Twilio call initiated successfully`, { callSid: call.sid });
    
    // Initialize conversation mapping for webhook to find
    await conversationService.initializeConversation(call.sid, contact);
    logger.info(`[initiateCall] Conversation mapping created`, { callSid: call.sid, userId });
    
    await historyRepository.logCall({
      user_id: userId,
      phone_number: phoneNumberToCall,
      call_sid: call.sid,
      status: 'initiated'
    });
    
    return call;
  } catch (error) {
    logger.error(`Error during call initiation for ${contactName}`, { userId, error: error.message });
    // Log a failed call attempt if Twilio API fails
    if (error.code) { // Twilio errors have a code
        await historyRepository.logCall({
            user_id: userId,
            phone_number: contact.phone,
            call_sid: `failed-${Date.now()}`, // Create a fake SID for logging
            status: 'failed',
            summary: `Twilio Error ${error.code}: ${error.message}`,
        }).catch(e => logger.error('Failed to log a failed call attempt', e));
    }
    throw error;
  }
};

/**
 * Get information about an ongoing call
 * @param {string} callSid - Twilio Call SID
 * @returns {Promise<Object>} - Twilio call object
 */
const getCallInfo = async (callSid) => {
  try {
    const call = await client.calls(callSid).fetch();
    return call;
  } catch (error) {
    logger.error(`Failed to get call info`, { callSid, error: error.message });
    throw error;
  }
};

/**
 * End an ongoing call
 * @param {string} callSid - Twilio Call SID
 * @returns {Promise<Object>} - Twilio call object
 */
const endCall = async (callSid) => {
  try {
    const call = await client.calls(callSid).update({
      status: 'completed'
    });
    
    logger.info(`Call ended`, { callSid });
    return call;
  } catch (error) {
    logger.error(`Failed to end call`, { callSid, error: error.message });
    throw error;
  }
};

/**
 * Update call recording information
 * @param {string} callSid - Twilio Call SID
 * @param {string} recordingUrl - URL to the recording
 * @returns {Promise<Object>} - Updated call document
 */
const updateCallRecording = async (callSid, recordingUrl) => {
  try {
    const updatedCall = await historyRepository.updateCall(callSid, { recordingUrl });
    logger.info(`Updated call with recording information`, { callSid });
    return updatedCall;
  } catch (error) {
    logger.error(`Failed to update call recording`, { callSid, error: error.message });
    throw error;
  }
};

module.exports = {
  initiateCall,
  getCallInfo,
  endCall,
  updateCallRecording
};
