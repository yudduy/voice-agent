/**
 * Text to speech service
 * 
 * Note: This service is optional since Twilio's <Say> verb provides text-to-speech.
 * However, we're including it for future extensibility or to implement custom TTS solutions.
 */
const logger = require('../utils/logger');
const telephonyConfig = require('../config/telephony');

/**
 * Format text for optimal speech synthesis
 * @param {string} text - The text to format
 * @returns {string} - Formatted text
 */
const formatTextForSpeech = (text) => {
  // Format text to sound more natural when spoken
  // Replace acronyms, format numbers, etc.
  
  // Example: replace "AI" with "A I" for better pronunciation
  let formattedText = text
    .replace(/\bAI\b/g, 'A I')
    .replace(/\bUI\b/g, 'U I')
    .replace(/\bAPI\b/g, 'A P I');
  
  // Format phone numbers for better speech
  formattedText = formattedText.replace(
    /(\d{3})[- ]?(\d{3})[- ]?(\d{4})/g, 
    '$1 $2 $3'
  );
  
  return formattedText;
};

/**
 * Get Twilio TTS configuration
 * @returns {Object} - Twilio TTS options
 */
const getTwilioTtsOptions = () => {
  return {
    voice: telephonyConfig.voice,
    language: telephonyConfig.language
  };
};

/**
 * Split long text into digestible chunks for TTS
 * @param {string} text - Long text
 * @param {number} maxLength - Maximum length of each chunk
 * @returns {Array<string>} - Array of text chunks
 */
const splitIntoSpeechChunks = (text, maxLength = 500) => {
  if (text.length <= maxLength) {
    return [text];
  }
  
  const chunks = [];
  let currentChunk = '';
  
  // Split by sentences
  const sentences = text.split(/(?<=[.!?])\s+/);
  
  for (const sentence of sentences) {
    if (currentChunk.length + sentence.length <= maxLength) {
      currentChunk += (currentChunk ? ' ' : '') + sentence;
    } else {
      chunks.push(currentChunk);
      currentChunk = sentence;
    }
  }
  
  if (currentChunk) {
    chunks.push(currentChunk);
  }
  
  return chunks;
};

module.exports = {
  formatTextForSpeech,
  getTwilioTtsOptions,
  splitIntoSpeechChunks
};
