const logger = require('./logger');

// Basic list - expand significantly for production use
// Sources: Wikipedia, ITU recommendations, various government sites
const EMERGENCY_NUMBERS = new Set([
    // Common International
    '911', '112', '999', 
    // North America
    '101', // Non-emergency (UK example, context matters)
    // Add more specific numbers for regions you operate in
    // E.g., Australia: 000, Brazil: 190, India: 100, etc.
]);

// Block specific prefixes or numbers (examples)
const BLOCKED_PREFIXES = [
    '+1911', // Ensure variations are caught
    '+44999',
    '+1800555', // Example fake block
    // Add known government / premium rate prefixes if necessary
];

const BLOCKED_NUMBERS = new Set([
    // Add specific known problematic numbers
]);

/**
 * Checks if a formatted E.164 phone number is safe to call.
 * Verifies against emergency numbers and blocklists.
 * 
 * @param {string | null} phoneNumberE164 - Phone number in E.164 format (e.g., '+19713364433').
 * @returns {{ isSafe: boolean, reason: string | null }} - Object indicating safety and reason if unsafe.
 */
const isSafeToCall = (phoneNumberE164) => {
    if (!phoneNumberE164 || typeof phoneNumberE164 !== 'string' || !phoneNumberE164.startsWith('+')) {
        return { isSafe: false, reason: 'Invalid E.164 format for safety check' };
    }

    // 1. Check against exact blocked numbers
    if (BLOCKED_NUMBERS.has(phoneNumberE164)) {
        logger.warn(`Phone number blocked (exact match): ${phoneNumberE164}`);
        return { isSafe: false, reason: 'Blocked number (exact match)' };
    }

    // 2. Check against blocked prefixes
    for (const prefix of BLOCKED_PREFIXES) {
        if (phoneNumberE164.startsWith(prefix)) {
            logger.warn(`Phone number blocked (prefix match: ${prefix}): ${phoneNumberE164}`);
            return { isSafe: false, reason: `Blocked prefix (${prefix})` };
        }
    }

    // 3. Check against common emergency numbers (stripping + and country codes where applicable)
    // This is complex due to varying lengths and country codes. Basic check:
    const digitsOnly = phoneNumberE164.substring(1); // Remove leading '+'
    // Simple check against common short codes - might need refinement
    if (EMERGENCY_NUMBERS.has(digitsOnly.substring(0, 3)) || EMERGENCY_NUMBERS.has(digitsOnly.substring(1, 4))) { // Check common 3-digit codes with/without country code prefix like '1'
         logger.warn(`Phone number potentially matches emergency service pattern: ${phoneNumberE164}`);
         // Decide policy: block or flag? For now, block.
         return { isSafe: false, reason: 'Potential emergency number pattern' };
    }

    return { isSafe: true, reason: null };
};

module.exports = {
    isSafeToCall,
    EMERGENCY_NUMBERS, // Export for potential external use/logging
    BLOCKED_PREFIXES,
    BLOCKED_NUMBERS
};
