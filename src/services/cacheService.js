const redis = require('../config/redis');
const logger = require('../utils/logger');

const CONVERSATION_TTL = 24 * 60 * 60; // 24 hours in seconds

/**
 * Generates the Redis key for a user's conversation history.
 * @param {string} userId - The user's unique identifier.
 * @returns {string} The Redis key.
 */
const getConversationKey = (userId) => `conversation:${userId}`;

/**
 * Retrieves the conversation history for a user.
 * @param {string} userId - The user's unique identifier.
 * @returns {Promise<Array<object>|null>} The conversation history or null if not found.
 */
async function getConversation(userId) {
  try {
    const key = getConversationKey(userId);
    const historyJson = await redis.get(key);
    return historyJson ? JSON.parse(historyJson) : [];
  } catch (error) {
    logger.error(`Error getting conversation for user ${userId} from Redis:`, error);
    throw error;
  }
}

/**
 * Appends a new turn to the conversation history and resets the TTL.
 * @param {string} userId - The user's unique identifier.
 * @param {object} turn - The conversation turn to add (e.g., { role: 'user', content: 'Hello' }).
 * @param {number} maxTurns - The maximum number of turns to store.
 * @returns {Promise<void>}
 */
async function appendConversation(userId, turn, maxTurns = 15) {
  try {
    const key = getConversationKey(userId);
    const history = (await getConversation(userId)) || [];
    
    history.push(turn);
    
    // Trim the history to the maximum number of turns
    const trimmedHistory = history.slice(-maxTurns);
    
    await redis.set(key, JSON.stringify(trimmedHistory), 'EX', CONVERSATION_TTL);
  } catch (error) {
    logger.error(`Error appending conversation for user ${userId} to Redis:`, error);
    throw error;
  }
}

/**
 * Clears the conversation history for a user.
 * @param {string} userId - The user's unique identifier.
 * @returns {Promise<void>}
 */
async function clearConversation(userId) {
  try {
    const key = getConversationKey(userId);
    await redis.del(key);
  } catch (error) {
    logger.error(`Error clearing conversation for user ${userId} from Redis:`, error);
    throw error;
  }
}

module.exports = {
  getConversation,
  appendConversation,
  clearConversation,
}; 