/**
 * Database service for MongoDB connection and operations
 */
const mongoose = require('mongoose');
const dbConfig = require('../config/database');
const logger = require('../utils/logger');
const Contact = require('../models/contact');
const Call = require('../models/call');

/**
 * Connect to MongoDB database
 * @returns {Promise<void>}
 */
const connectToDatabase = async () => {
  try {
    await mongoose.connect(dbConfig.uri, dbConfig.options);
    logger.info('Connected to MongoDB successfully');
    
    // --- Add diagnostic logging ---
    if (mongoose.connection.readyState === 1) { // Check if connected
      logger.info('Database Connection Details:', {
        uriUsed: dbConfig.uri.substring(0, dbConfig.uri.indexOf('@') + 1) + '****', // Mask credentials
        optionsUsed: { ...dbConfig.options, dbName: mongoose.connection.db.databaseName },
        connectedDbName: mongoose.connection.db.databaseName,
        contactModelCollectionName: Contact.collection.name,
        contactModelNamespace: Contact.collection.namespace
      });
      
      try {
        const collections = await mongoose.connection.db.listCollections().toArray();
        logger.info('Available collections:', {
          collections: collections.map(c => c.name)
        });

        const contactCount = await Contact.countDocuments();
        logger.info('Contact count check:', { count: contactCount });

      } catch (diagError) {
        logger.error('Error during diagnostic checks (listing collections/counting contacts)', { diagError: diagError.message });
      }
    } else {
       logger.warn('Attempted diagnostic logging but connection state is not OPEN (1).', { state: mongoose.connection.readyState });
    }
    // --- End diagnostic logging ---
    
  } catch (error) {
    logger.error('Failed to connect to MongoDB', error);
    throw error;
  }
};

/**
 * Get contacts that haven't been called yet or need follow-up
 * @param {number} limit - Maximum number of contacts to retrieve
 * @returns {Promise<Array>} - Array of contact documents
 */
const getContactsToCall = async (limit = 10) => {
  try {
    // Find contacts with phone numbers that haven't been called or need follow-up
    const contacts = await Contact.find({ 
      phone: { $exists: true, $ne: "" },
      $or: [
        { callStatus: { $exists: false } },
        { callStatus: null },
        { callStatus: 'pending' },
        // Allow for callbacks after 7 days if previous call didn't complete successfully
        { 
          callStatus: { $nin: ['completed'] },
          lastCallTime: { $lt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }
        }
      ]
    })
    .sort({ createdAt: 1 }) // Call oldest contacts first
    .limit(limit);
    
    logger.info(`Retrieved ${contacts.length} contacts to call`);
    return contacts;
  } catch (error) {
    logger.error('Error fetching contacts to call', error);
    throw error;
  }
};

/**
 * Update contact with call information
 * @param {string} contactId - MongoDB ObjectId of the contact
 * @param {string} status - Call status
 * @param {string} callSid - Twilio Call SID
 * @returns {Promise<Object>} - Updated contact document
 */
const updateContactCallStatus = async (contactId, status, callSid) => {
  try {
    const updatedContact = await Contact.findByIdAndUpdate(contactId, {
      $set: {
        callStatus: status,
        lastCallSid: callSid,
        lastCallTime: new Date()
      },
      $inc: { callCount: 1 }
    }, { new: true });
    
    logger.info(`Updated contact ${contactId} with call status ${status}`, { callSid });
    return updatedContact;
  } catch (error) {
    logger.error(`Error updating contact call status`, { contactId, status, error });
    throw error;
  }
};

/**
 * Create a new call record
 * @param {Object} callData - Call data
 * @returns {Promise<Object>} - Created call document
 */
const createCallRecord = async (callData) => {
  try {
    const newCall = new Call(callData);
    await newCall.save();
    
    logger.info(`Created new call record`, { callSid: callData.callSid, contactId: callData.contactId });
    return newCall;
  } catch (error) {
    logger.error('Error creating call record', { callData, error });
    throw error;
  }
};

/**
 * Update call record with transcript information
 * @param {string} callSid - Twilio Call SID
 * @param {string} speaker - Who is speaking ('user' or 'assistant')
 * @param {string} text - Transcribed text
 * @returns {Promise<Object>} - Updated call document
 */
const updateCallTranscript = async (callSid, speaker, text) => {
  try {
    // First, check if the call record exists
    const callExists = await Call.findOne({ callSid }, '_id').lean(); // Use lean for efficiency
    if (!callExists) {
      logger.warn('Attempted to update transcript for non-existent call record (likely test call)', { callSid });
      return null; // Indicate no update occurred
    }

    // If call exists, proceed with the update
    const updatedCall = await Call.findOneAndUpdate(
      { callSid },
      {
        $push: {
          transcript: {
            timestamp: new Date(),
            speaker,
            text
          }
        }
      },
      { new: true }
    );

    logger.debug(`Updated call transcript`, { callSid, speaker });
    return updatedCall;
  } catch (error) {
    logger.error('Error updating call transcript', { callSid, error });
    throw error;
  }
};

/**
 * Update call status
 * @param {string} callSid - Twilio Call SID
 * @param {string} status - Call status
 * @param {Object} additionalData - Additional data to update
 * @returns {Promise<Object>} - Updated call document
 */
const updateCallStatus = async (callSid, status, additionalData = {}) => {
  try {
    // Find the call record first
    let call = await Call.findOne({ callSid });

    if (!call) {
      // If the call record doesn't exist (e.g., test call never created one)
      // and the status indicates completion, just log and exit gracefully.
      if (['completed', 'failed', 'no-answer', 'busy'].includes(status)) {
        logger.info(`Received final status '${status}' for call without DB record (likely test call). No DB update needed.`, { callSid });
        return null;
      } else {
        // For other statuses, it might indicate an issue if the record is missing
        logger.warn(`Call record not found when trying to update status to '${status}'`, { callSid });
        return null;
      }
    }
    
    // --- Call record exists, proceed with updates ---
    
    const updateData = {
      status,
      ...additionalData
    };
    
    // Add timestamps for specific statuses
    if (status === 'in-progress' && !additionalData.startTime) {
      updateData.startTime = new Date();
    } else if (['completed', 'failed', 'no-answer', 'busy'].includes(status) && !additionalData.endTime) {
      updateData.endTime = new Date();
      
      // Calculate duration if we have both start and end times
      const call = await Call.findOne({ callSid }, 'startTime');
      if (call && call.startTime) {
        updateData.duration = Math.round((new Date() - call.startTime) / 1000);
      }
    }
    
    const updatedCall = await Call.findOneAndUpdate(
      { callSid },
      { $set: updateData },
      { new: true }
    );
    
    // Also update the contact's call status, only if contactId is valid
    if (updatedCall && updatedCall.contactId && mongoose.Types.ObjectId.isValid(updatedCall.contactId)) {
      let contactStatus = status;
      if (status === 'completed') {
        contactStatus = 'completed';
      } else if (['failed', 'no-answer', 'busy'].includes(status)) {
        contactStatus = 'pending'; // Allow retrying later
      }
      
      await Contact.findByIdAndUpdate(updatedCall.contactId, {
        $set: { callStatus: contactStatus }
      });
    }
    
    logger.info(`Updated call status to ${status}`, { callSid });
    return updatedCall;
  } catch (error) {
    logger.error('Error updating call status', { callSid, status, error });
    throw error;
  }
};

/**
 * Get call information by Call SID
 * @param {string} callSid - Twilio Call SID
 * @returns {Promise<Object|null>} - Call document or null if not found
 */
const getCallInfo = async (callSid) => {
  try {
    const call = await Call.findOne({ callSid }).exec();
    if (!call) {
      logger.warn('Call record not found by getCallInfo', { callSid });
      return null;
    }
    logger.debug('Retrieved call info by SID', { callSid });
    return call;
  } catch (error) {
    logger.error('Error fetching call info by SID', { callSid, error });
    throw error; // Re-throw or handle as appropriate for the calling function
  }
};

/**
 * Disconnect from MongoDB
 * @returns {Promise<void>}
 */
const disconnect = async () => {
  try {
    await mongoose.disconnect();
    logger.info('Disconnected from MongoDB.');
  } catch (error) {
    logger.error('Error disconnecting from MongoDB', { error });
    throw error;
  }
};

module.exports = {
  connectToDatabase,
  getContactsToCall,
  updateContactCallStatus,
  createCallRecord,
  updateCallTranscript,
  updateCallStatus,
  getCallInfo,
  disconnect
};
