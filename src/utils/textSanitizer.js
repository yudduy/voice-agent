/**
 * Text sanitization utilities for TwiML compliance
 * Removes all XML/HTML tags and special markup to ensure clean TwiML generation
 */

/**
 * Sanitize text for TwiML response generation
 * Removes all XML/HTML tags, SSML markup, and special formatting
 * @param {string} text - Raw text from AI or other sources
 * @returns {string} - Sanitized plain text safe for TwiML
 */
function sanitizeForTwiML(text) {
  if (!text || typeof text !== 'string') {
    return '';
  }

  return text
    // Remove all XML/HTML tags
    .replace(/<[^>]*>/g, '')
    // Remove common SSML patterns
    .replace(/<break\s*time=['"]\d+[ms'"]\s*\/>/gi, '')
    .replace(/<prosody[^>]*>([^<]*)<\/prosody>/gi, '$1')
    .replace(/<voice[^>]*>([^<]*)<\/voice>/gi, '$1')
    .replace(/<speak[^>]*>([^<]*)<\/speak>/gi, '$1')
    .replace(/<say-as[^>]*>([^<]*)<\/say-as>/gi, '$1')
    .replace(/<emphasis[^>]*>([^<]*)<\/emphasis>/gi, '$1')
    // Remove [pause], [break], etc. patterns
    .replace(/\[pause\]/gi, '')
    .replace(/\[break\]/gi, '')
    .replace(/\[\d+\s*(seconds?|ms|milliseconds?)\]/gi, '')
    .replace(/\[.*?\]/g, '')
    // Remove {action} markers
    .replace(/\{.*?\}/g, '')
    // Remove escaped XML entities
    .replace(/&lt;[^&]*&gt;/g, '')
    // Clean up multiple spaces
    .replace(/\s+/g, ' ')
    // Trim whitespace
    .trim();
}

/**
 * Validate that text contains no TwiML-invalid patterns
 * @param {string} text - Text to validate
 * @returns {boolean} - True if text is safe for TwiML
 */
function isValidForTwiML(text) {
  if (!text || typeof text !== 'string') {
    return true;
  }

  // List of patterns that would cause TwiML validation errors
  const invalidPatterns = [
    /<[^>]+>/,          // Any XML/HTML tags
    /&lt;.*?&gt;/,      // Escaped XML
    /<break/i,          // SSML break tags
    /<prosody/i,        // SSML prosody tags
    /<voice/i,          // SSML voice tags
    /<speak/i,          // SSML speak tags
    /<say-as/i,         // SSML say-as tags
    /<emphasis/i,       // SSML emphasis tags
    /\[pause\]/i,       // Common pause markers
    /\[\d+\s*(?:seconds?|ms)\]/i,  // Time markers
    /record\s*=/,       // Invalid Gather attributes
    /recordingStatus/   // Invalid Gather attributes
  ];

  // Check each pattern
  for (const pattern of invalidPatterns) {
    if (pattern.test(text)) {
      return false;
    }
  }

  return true;
}

/**
 * Sanitize and validate text for TwiML
 * Combines sanitization and validation with logging
 * @param {string} text - Text to process
 * @param {object} logger - Optional logger instance
 * @returns {string} - Sanitized text
 */
function ensureTwiMLSafe(text, logger = null) {
  const sanitized = sanitizeForTwiML(text);
  
  if (logger && text !== sanitized) {
    logger.debug('Text sanitized for TwiML', {
      originalLength: text.length,
      sanitizedLength: sanitized.length,
      hadInvalidContent: true
    });
  }

  if (!isValidForTwiML(sanitized)) {
    if (logger) {
      logger.error('Text still contains invalid TwiML patterns after sanitization', {
        text: sanitized.substring(0, 100)
      });
    }
    // Extra aggressive sanitization
    return sanitized.replace(/[<>]/g, '');
  }

  return sanitized;
}

module.exports = {
  sanitizeForTwiML,
  isValidForTwiML,
  ensureTwiMLSafe
};