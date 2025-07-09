const redis = require('../config/redis');
const logger = require('../utils/logger');
const { cache: cacheConfig } = require('../config');

const CONVERSATION_TTL = cacheConfig.conversation.ttl;

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
    const historyData = await redis.get(key);
    
    if (!historyData) {
      return [];
    }
    
    // Handle different data types from Upstash Redis
    if (typeof historyData === 'string') {
      return JSON.parse(historyData);
    } else if (Array.isArray(historyData)) {
      return historyData;
    } else if (typeof historyData === 'object') {
      logger.warn(`Unexpected object type from Redis for user ${userId}, resetting conversation`, { 
        dataType: typeof historyData,
        data: historyData 
      });
      // Clear the corrupted data and return empty array
      await clearConversation(userId);
      return [];
    } else {
      logger.error(`Unexpected data type from Redis for user ${userId}:`, {
        dataType: typeof historyData,
        data: historyData
      });
      return [];
    }
  } catch (error) {
    logger.error(`Error getting conversation for user ${userId} from Redis:`, error.message);
    // Return empty array on error to prevent cascade failures
    return [];
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
    
    // Ensure turn is a valid object
    if (!turn || typeof turn !== 'object' || !turn.role || !turn.content) {
      logger.error(`Invalid turn object for user ${userId}:`, turn);
      return;
    }
    
    history.push(turn);
    
    // Trim the history to the maximum number of turns
    const trimmedHistory = history.slice(-maxTurns);
    
    // Ensure we're storing as JSON string for consistency
    const jsonString = JSON.stringify(trimmedHistory);
    await redis.set(key, jsonString, { ex: CONVERSATION_TTL });
    
    logger.debug(`Appended conversation turn for user ${userId}`, {
      turnRole: turn.role,
      historyLength: trimmedHistory.length
    });
  } catch (error) {
    logger.error(`Error appending conversation for user ${userId} to Redis:`, error.message);
    // Don't throw to prevent cascade failures
  }
}

/**
 * Sets the complete conversation history for a user.
 * @param {string} userId - The user's unique identifier.
 * @param {Array<object>} conversation - The complete conversation history.
 * @returns {Promise<void>}
 */
async function setConversation(userId, conversation) {
  try {
    const key = getConversationKey(userId);
    
    // Validate conversation array
    if (!Array.isArray(conversation)) {
      logger.error(`Invalid conversation array for user ${userId}:`, conversation);
      return;
    }
    
    const jsonString = JSON.stringify(conversation);
    await redis.set(key, jsonString, { ex: CONVERSATION_TTL });
    
    logger.debug(`Set conversation history for user ${userId}`, {
      historyLength: conversation.length
    });
  } catch (error) {
    logger.error(`Error setting conversation for user ${userId} to Redis:`, error.message);
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
    logger.debug(`Cleared conversation history for user ${userId}`);
  } catch (error) {
    logger.error(`Error clearing conversation for user ${userId} from Redis:`, error.message);
  }
}

/**
 * Updates the conversation history for a user (alias for setConversation).
 * @param {string} userId - The user's unique identifier.
 * @param {Array<object>} conversation - The complete conversation history.
 * @returns {Promise<void>}
 */
async function updateConversation(userId, conversation) {
  return setConversation(userId, conversation);
}

module.exports = {
  getConversation,
  setConversation,
  updateConversation, // Add the missing alias
  appendConversation,
  clearConversation,
}; 