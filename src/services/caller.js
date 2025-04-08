/**
 * Caller service for initiating and managing phone calls
 */
const twilio = require('twilio');
const telephonyConfig = require('../config/telephony');
const logger = require('../utils/logger');
const databaseService = require('./database');
const mongoose = require('mongoose');
const Call = require('../models/call');
const { formatPhoneForCalling } = require('../utils/phoneFormatter');
const Contact = require('../models/contact');

// Initialize Twilio client
const client = twilio(
  telephonyConfig.accountSid, 
  telephonyConfig.authToken
);

/**
 * Initiate a call to a contact
 * @param {Object} contact - Contact document
 * @returns {Promise<Object>} - Twilio call object
 */
const initiateCall = async (contact) => {
  if (!contact || !contact.phone) {
    logger.error('InitiateCall called with invalid contact object', { contact });
    throw new Error('Invalid contact provided to initiateCall');
  }

  const contactId = contact._id;
  const contactName = contact.name || 'Unknown';

  let phoneNumberToCall = null;
  try {
    phoneNumberToCall = formatPhoneForCalling(contact.phone);
    
    if (!phoneNumberToCall) {
      logger.error(`Invalid phone number format for contact ${contactName}`, { contactId, originalPhone: contact.phone });
      await Contact.findByIdAndUpdate(contactId, { $set: { monitorStatus: 'error', callStatus: 'failed' }, $push: { notes: `Invalid phone format: ${contact.phone}` } });
      throw new Error(`Invalid phone number format: ${contact.phone}`);
    }

    logger.info(`Initiating call to ${contactName}`, { 
      contactId,
      formattedPhone: phoneNumberToCall
    });
    
    // Make the call using Twilio
    const call = await client.calls.create({
      url: `${telephonyConfig.webhookBaseUrl}/api/calls/connect`, 
      to: phoneNumberToCall,
      from: telephonyConfig.phoneNumber,
      statusCallback: `${telephonyConfig.webhookBaseUrl}/api/calls/status`,
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      statusCallbackMethod: 'POST',
      // Optional: record the call
      record: true,
      recordingStatusCallback: `${telephonyConfig.webhookBaseUrl}/api/calls/recording`
    });
    
    logger.info(`Call initiated`, { callSid: call.sid });
    
    // Check if the contact ID is a valid MongoDB ObjectId before attempting DB updates
    const isRealContact = mongoose.Types.ObjectId.isValid(contact._id);
    
    if (isRealContact) {
      // Update contact with call info
      await databaseService.updateContactCallStatus(contact._id, 'initiated', call.sid);
      
      // Create a new call record in the database
      await databaseService.createCallRecord({
        contactId: contact._id,
        callSid: call.sid,
        status: 'initiated'
      });
    } else {
      logger.info(`Skipping database updates for temporary test contact`, { contactId: contact._id });
    }
    
    return call;
  } catch (error) {
    logger.error(`Initial error during call initiation for ${contactName}`, { contactId, error: error.message });

    if (error.code === 21211 || (error.message && error.message.includes('unverified') && error.message.includes('Trial'))) {
      logger.warn(`Cannot call ${contactName} with trial account - number needs verification`, { 
        contactId: contactId,
        phone: phoneNumberToCall,
        solution: "Verify this number in your Twilio console or upgrade to a paid account"
      });
      
      try {
        if (contactId && mongoose.Types.ObjectId.isValid(contactId)) {
          const note = `Call attempt failed (Twilio Trial): Number requires verification. ${new Date().toISOString()}`;
          await Contact.findByIdAndUpdate(contactId, { 
            $set: { callStatus: 'failed' },
            $push: { notes: note } 
          });
          logger.info('Updated contact notes regarding Twilio verification', { contactId });
        } else {
          logger.warn('Skipping contact note update for verification error due to invalid contactId', { contactId });
        }
      } catch (dbError) {
        logger.error('Failed to update contact notes after Twilio verification error', { contactId, dbError: dbError.message });
      }
      return;
    } else {
      logger.error(`Unhandled error initiating call to ${contactName}`, { 
        contactId: contactId, 
        errorMessage: error.message,
        errorStack: error.stack
      });
      
      try {
        if (contactId && mongoose.Types.ObjectId.isValid(contactId)) {
          await Contact.findByIdAndUpdate(contactId, { $set: { callStatus: 'failed', monitorStatus: 'error' } });
        }
      } catch (dbError) {
        logger.error('Failed to mark contact as error after general call initiation failure', { contactId, dbError: dbError.message });
      }
      throw error;
    }
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
 * @param {string} recordingSid - Twilio Recording SID
 * @param {string} recordingUrl - URL to the recording
 * @returns {Promise<Object>} - Updated call document
 */
const updateCallRecording = async (callSid, recordingSid, recordingUrl) => {
  try {
    // Fetch the call first to ensure it exists and get contactId
    const callRecord = await Call.findOne({ callSid }).exec();
    if (!callRecord) {
      logger.warn('Call record not found while trying to update recording', { callSid });
      return null;
    }

    // Check if the contact associated with the call is a real one
    const isRealContact = mongoose.Types.ObjectId.isValid(callRecord.contactId);

    if (isRealContact) {
      const updatedCall = await databaseService.updateCallStatus(callSid, 'completed', {
        recordingUrl
      });
      logger.info(`Updated call with recording information`, { callSid, recordingSid });
      return updatedCall;
    } else {
      // For test contacts, we might just log or handle differently
      logger.info(`Skipping database recording update for temporary test call`, { callSid });
      // Optionally update a temporary store or just return
      return null; // Indicate no DB update occurred
    }

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
