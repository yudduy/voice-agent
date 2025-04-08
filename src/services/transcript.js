/**
 * Transcript service for managing call transcripts
 */
const logger = require('../utils/logger');
const dbService = require('./database');

/**
 * Initialize a new transcript for a call
 * @param {string} callSid - Twilio Call SID
 * @param {string} contactId - MongoDB ObjectId of the contact
 * @returns {Promise<Object>} - Created transcript document
 */
const initializeTranscript = async (callSid, contactId) => {
  try {
    // Add empty transcript array to call record
    const call = await dbService.updateCallStatus(callSid, 'in-progress', {
      transcript: []
    });
    
    logger.info(`Initialized transcript for call`, { callSid, contactId });
    return call;
  } catch (error) {
    logger.error('Error initializing transcript', { callSid, error });
    throw error;
  }
};

/**
 * Add an entry to the call transcript
 * @param {string} callSid - Twilio Call SID
 * @param {string} speaker - Who is speaking ('user' or 'assistant')
 * @param {string} text - Transcribed text
 * @returns {Promise<Object>} - Updated call document
 */
const addTranscriptEntry = async (callSid, speaker, text) => {
  try {
    // Update call record with new transcript entry
    const call = await dbService.updateCallTranscript(callSid, speaker, text);
    
    logger.debug(`Added transcript entry`, { callSid, speaker });
    return call;
  } catch (error) {
    logger.error('Error adding transcript entry', { callSid, error });
    throw error;
  }
};

/**
 * Get full transcript for a call
 * @param {string} callSid - Twilio Call SID
 * @returns {Promise<Array>} - Array of transcript entries
 */
const getTranscript = async (callSid) => {
  try {
    // Get call document from database
    const Call = require('../models/call');
    const call = await Call.findOne({ callSid });
    
    if (!call || !call.transcript) {
      logger.warn(`No transcript found for call`, { callSid });
      return [];
    }
    
    return call.transcript;
  } catch (error) {
    logger.error('Error getting transcript', { callSid, error });
    throw error;
  }
};

/**
 * Generate a formatted transcript text
 * @param {string} callSid - Twilio Call SID
 * @returns {Promise<string>} - Formatted transcript text
 */
const getFormattedTranscript = async (callSid) => {
  try {
    const transcript = await getTranscript(callSid);
    
    if (transcript.length === 0) {
      return 'No transcript available for this call.';
    }
    
    // Format transcript entries
    let formattedText = 'Call Transcript:\n\n';
    
    transcript.forEach((entry, index) => {
      const speaker = entry.speaker === 'assistant' ? 'Foundess AI' : 'Customer';
      const timestamp = new Date(entry.timestamp).toLocaleTimeString();
      
      formattedText += `[${timestamp}] ${speaker}: ${entry.text}\n\n`;
    });
    
    return formattedText;
  } catch (error) {
    logger.error('Error generating formatted transcript', { callSid, error });
    return 'Error retrieving transcript.';
  }
};

module.exports = {
  initializeTranscript,
  addTranscriptEntry,
  getTranscript,
  getFormattedTranscript
};
