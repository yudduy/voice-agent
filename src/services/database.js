/**
 * Lightweight stub for database operations used by the scheduler during local
 * dev / test. In production this should be replaced by a real implementation.
 */

const logger = require('../utils/logger');

/**
 * Return an array of contacts that need to be called. For dev we return an
 * empty array so the scheduler does nothing.
 *
 * @param {number} limit
 * @returns {Promise<Array>} contacts
 */
async function getContactsToCall(limit = 1) {
  logger.debug(`[database stub] getContactsToCall(limit=${limit}) → []`);
  return [];
}

module.exports = { getContactsToCall }; 