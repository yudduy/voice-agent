/**
 * Speech to text service
 * 
 * Note: This service is optional since Twilio's <Gather> verb provides speech recognition.
 * However, we're including it for future extensibility or to implement custom speech recognition.
 */
const logger = require('../utils/logger');

/**
 * Process Twilio speech recognition result
 * @param {string} speechResult - Twilio's SpeechResult
 * @returns {string} - Processed text
 */
const processTwilioSpeechResult = (speechResult) => {
  // Process and clean up the text if needed
  const processedText = speechResult.trim();
  return processedText;
};

/**
 * Validate speech recognition result
 * @param {string} speechResult - Transcribed text
 * @returns {boolean} - Whether the result is valid
 */
const validateSpeechResult = (speechResult) => {
  // Check if the result is valid (not empty, not just noise, etc.)
  if (!speechResult || speechResult.trim().length === 0) {
    return false;
  }
  
  // You could add more sophisticated validation here
  
  return true;
};

module.exports = {
  processTwilioSpeechResult,
  validateSpeechResult
};
