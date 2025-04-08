/**
 * Utility for formatting phone numbers.
 */

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

  // Remove all non-numeric characters except a potential leading '+'
  let digitsOnly = phoneNumber.trim().replace(/[^+\d]/g, '');

  // Remove leading '+' for initial processing
  const hasPlus = digitsOnly.startsWith('+');
  if (hasPlus) {
    digitsOnly = digitsOnly.substring(1);
  }

  // Add default country code if it looks like a 10-digit US/Canada number
  // This is a simplification; more robust libraries exist for complex international formatting.
  if (digitsOnly.length === 10 && defaultCountryCode === '1') {
    digitsOnly = `${defaultCountryCode}${digitsOnly}`;
  }
  
  // Basic validation: check if it has a reasonable length after cleanup
  if (digitsOnly.length < 10) { // Arbitrary minimum length for international numbers
      return null;
  }

  // Ensure '+' prefix
  return `+${digitsOnly}`;
};

module.exports = {
  formatPhoneForCalling
};
