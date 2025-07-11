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
async function appendConversation(userId, turn, maxTurns = 30) {
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

/**
 * Response caching for common AI responses
 */
const RESPONSE_CACHE_TTL = parseInt(process.env.RESPONSE_CACHE_TTL || '3600'); // 1 hour default
const RESPONSE_CACHE_PREFIX = 'response:';

/**
 * Generates a cache key for an AI response based on user input and context
 * @param {string} userInput - The user's input text
 * @param {Array} conversationHistory - Recent conversation history for context
 * @returns {string} The cache key
 */
const generateResponseCacheKey = (userInput, conversationHistory = []) => {
  const crypto = require('crypto');
  
  // Normalize the input (lowercase, trim whitespace)
  const normalizedInput = userInput.toLowerCase().trim();
  
  // Get last 2 turns for context (to distinguish same question in different contexts)
  const contextString = conversationHistory
    .slice(-2)
    .map(turn => `${turn.role}:${turn.content}`)
    .join('|');
  
  // Create a hash from input + context
  const hash = crypto.createHash('md5')
    .update(normalizedInput + contextString)
    .digest('hex');
  
  return `${RESPONSE_CACHE_PREFIX}${hash}`;
};

/**
 * Get a cached AI response if available
 * @param {string} userInput - The user's input text
 * @param {Array} conversationHistory - Recent conversation history
 * @returns {Promise<string|null>} The cached response or null
 */
async function getCachedResponse(userInput, conversationHistory = []) {
  try {
    if (process.env.ENABLE_RESPONSE_CACHING !== 'true') {
      return null;
    }
    
    const cacheKey = generateResponseCacheKey(userInput, conversationHistory);
    const cachedResponse = await redis.get(cacheKey);
    
    if (cachedResponse) {
      logger.info('💾 [CACHE-HIT] Found cached AI response', {
        userInput: userInput.substring(0, 50),
        cacheKey,
        responseLength: cachedResponse.length
      });
      return cachedResponse;
    }
    
    return null;
  } catch (error) {
    logger.error('Error retrieving cached response:', error.message);
    return null;
  }
}

/**
 * Cache an AI response
 * @param {string} userInput - The user's input text
 * @param {Array} conversationHistory - Recent conversation history
 * @param {string} response - The AI response to cache
 * @param {number} ttl - Optional TTL override (seconds)
 * @returns {Promise<void>}
 */
async function setCachedResponse(userInput, conversationHistory, response, ttl = RESPONSE_CACHE_TTL) {
  try {
    if (process.env.ENABLE_RESPONSE_CACHING !== 'true') {
      return;
    }
    
    // Only cache responses that are likely to be reused
    const shouldCache = isCacheableResponse(userInput, response);
    if (!shouldCache) {
      return;
    }
    
    const cacheKey = generateResponseCacheKey(userInput, conversationHistory);
    await redis.set(cacheKey, response, { ex: ttl });
    
    logger.info('💾 [CACHE-SET] Cached AI response', {
      userInput: userInput.substring(0, 50),
      cacheKey,
      responseLength: response.length,
      ttl
    });
  } catch (error) {
    logger.error('Error caching response:', error.message);
  }
}

/**
 * Determines if a response should be cached based on heuristics
 * @param {string} userInput - The user's input
 * @param {string} response - The AI response
 * @returns {boolean} Whether to cache the response
 */
function isCacheableResponse(userInput, response) {
  // Don't cache confusion/repetition requests
  const confusionPatterns = [
    /what\?/i, /pardon/i, /repeat/i, /didn't\s+(hear|catch)/i,
    /say\s+that\s+again/i, /excuse\s+me/i, /confused/i,
    /wait\s+wait/i, /hold\s+on/i, /what's\s+going\s+on/i
  ];
  
  const isConfusionRequest = confusionPatterns.some(pattern => pattern.test(userInput));
  if (isConfusionRequest) {
    return false; // Never cache confusion requests
  }
  
  // Common patterns that are good for caching
  const cacheablePatterns = [
    /^(hi|hello|hey|good\s+(morning|afternoon|evening))/i,
    /^(yes|no|yeah|nope|sure|okay|ok)$/i,
    /^(thank\s*you|thanks|bye|goodbye|see\s*you)/i,
    /^(what|who|where|when|how)\s+(is|are|do|does)/i,
    /^(can\s*you|could\s*you|would\s*you|will\s*you)/i,
    /^(I\s*need|I\s*want|I\s*would\s*like)/i,
    /^(help|assist|support)/i
  ];
  
  // Check if input matches any cacheable pattern
  const isCommonInput = cacheablePatterns.some(pattern => pattern.test(userInput));
  
  // Don't cache very short or very long responses
  const isGoodLength = response.length >= 10 && response.length <= 200;
  
  // Don't cache responses with specific/dynamic content
  const hasNoDynamicContent = !response.match(/\d{4,}|\$[\d,.]+|today|tomorrow|yesterday/i);
  
  return isCommonInput && isGoodLength && hasNoDynamicContent;
}

/**
 * Clear all cached responses (useful for updates)
 * @returns {Promise<void>}
 */
async function clearResponseCache() {
  try {
    // This would need to be implemented based on your Redis setup
    // For now, we'll log a warning
    logger.warn('Response cache clearing not implemented for current Redis setup');
  } catch (error) {
    logger.error('Error clearing response cache:', error.message);
  }
}

module.exports = {
  getConversation,
  setConversation,
  updateConversation,
  appendConversation,
  clearConversation,
  // Response caching functions
  getCachedResponse,
  setCachedResponse,
  clearResponseCache,
}; 