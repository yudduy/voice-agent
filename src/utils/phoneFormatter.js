/**
 * Utility for formatting phone numbers.
 */
const logger = require('./logger'); // Import the logger

/**
 * Formats a phone number for international calling (E.164 standard).
 * Removes non-numeric characters and ensures a leading '+' with country code.
 * Assumes 10-digit numbers without a country code are US/Canada numbers.
 * 
 * @param {string} phoneNumber - Raw phone number in various formats.
 * @param {string} defaultCountryCode - Default country code to prepend if none detected (default: '1').
 * @returns {string | null} - Formatted phone number (e.g., '+19713364433') or null if input is invalid.
 */
const formatPhoneForCalling = (phoneNumber, defaultCountryCode = '1') => {
  if (!phoneNumber || typeof phoneNumber !== 'string') {
    return null; // Invalid input
  }

  // Remove common formatting characters: spaces, (), -, .
  const cleaned = phoneNumber.trim().replace(/[\s\(\)\-\.]/g, '');
  
  // Separate potential leading + from digits
  let digitsOnly = cleaned;
  let hasPlus = false;
  if (cleaned.startsWith('+')) {
    hasPlus = true;
    digitsOnly = cleaned.substring(1);
  }
  
  // Basic validation: Ensure remaining characters are digits
  if (!/^\d+$/.test(digitsOnly)) {
    logger.warn('Phone number contains invalid characters after cleaning', { original: phoneNumber, cleaned: cleaned });
    return null;
  }

  // Add default country code if it looks like a 10-digit US/Canada number AND no plus was present
  if (digitsOnly.length === 10 && !hasPlus && defaultCountryCode === '1') {
    logger.debug('Adding default country code +1 to 10-digit number', { original: phoneNumber, digits: digitsOnly });
    digitsOnly = `${defaultCountryCode}${digitsOnly}`;
  }
  
  // Basic length check (adjust min/max as needed for your target regions)
  if (digitsOnly.length < 10 || digitsOnly.length > 15) { 
      logger.warn('Phone number has invalid length after formatting', { original: phoneNumber, finalDigits: digitsOnly, length: digitsOnly.length });
      return null;
  }

  // Ensure '+' prefix is present
  const finalNumber = `+${digitsOnly}`;
  logger.debug('Formatted phone number result', { original: phoneNumber, formatted: finalNumber });
  return finalNumber;
};

module.exports = {
  formatPhoneForCalling
};
