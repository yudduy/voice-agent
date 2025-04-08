/**
 * Scheduling service for automated calls
 */
const schedule = require('node-schedule');
const database = require('./database');
const caller = require('./caller');
const logger = require('../utils/logger');

/**
 * Schedule calls during business hours
 * @returns {Object} - Node-schedule job object
 */
const schedulePhoneCalls = () => {
  logger.info('Setting up automated call scheduler');
  
  // Run every hour during business hours (9 AM - 5 PM, Monday-Friday)
  // Cron syntax: second minute hour day month weekday
  // 0 0 9-17 * * 1-5 = At the top of every hour from 9 AM to 5 PM, Monday through Friday
  const job = schedule.scheduleJob('0 0 9-17 * * 1-5', async () => {
    try {
      logger.info('Starting scheduled call batch');
      
      // Get contacts that need to be called
      const contacts = await database.getContactsToCall(5); // Process 5 at a time
      
      if (contacts.length === 0) {
        logger.info('No contacts to call at this time');
        return;
      }
      
      // Process each contact
      for (const contact of contacts) {
        try {
          await caller.initiateCall(contact);
          // Wait between calls to avoid overwhelming the system
          await new Promise(resolve => setTimeout(resolve, 60000)); // 1 minute
        } catch (error) {
          logger.error(`Error calling contact ${contact._id}`, {
            error: error.message,
            stack: error.stack
          });
        }
      }
      
      logger.info(`Completed batch of ${contacts.length} calls`);
    } catch (error) {
      logger.error('Error in scheduled call job', {
        error: error.message,
        stack: error.stack
      });
    }
  });
  
  return job;
};

/**
 * Manually trigger a batch of calls (for testing or immediate processing)
 * @param {number} limit - Maximum number of calls to initiate
 * @returns {Promise<Array>} - Array of call results
 */
const triggerManualCallBatch = async (limit = 1) => {
  try {
    logger.info(`Starting manual call batch (limit: ${limit})`);
    
    // Get contacts that need to be called
    const contacts = await database.getContactsToCall(limit);
    
    if (contacts.length === 0) {
      logger.info('No contacts to call at this time');
      return [];
    }
    
    const results = [];
    
    // Process each contact
    for (const contact of contacts) {
      try {
        const call = await caller.initiateCall(contact);
        results.push({
          contact: contact._id,
          callSid: call.sid,
          status: 'initiated'
        });
        
        // Wait between calls
        await new Promise(resolve => setTimeout(resolve, 30000)); // 30 seconds
      } catch (error) {
        logger.error(`Error calling contact ${contact._id}`, error);
        results.push({
          contact: contact._id,
          status: 'failed',
          error: error.message
        });
      }
    }
    
    logger.info(`Completed manual batch of ${contacts.length} calls`);
    return results;
  } catch (error) {
    logger.error('Error in manual call batch', error);
    throw error;
  }
};

module.exports = {
  schedulePhoneCalls,
  triggerManualCallBatch
};
