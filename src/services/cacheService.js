const redis = require('../config/redis');
const logger = require('../utils/logger');
const { cache: cacheConfig } = require('../config');
const crypto = require('crypto');
const soundex = require('soundex');

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
 * Implements dynamic context management for optimal performance.
 * @param {string} userId - The user's unique identifier.
 * @param {object} turn - The conversation turn to add (e.g., { role: 'user', content: 'Hello' }).
 * @param {number} maxTurns - The maximum number of turns to store (dynamic based on content).
 * @returns {Promise<void>}
 */
async function appendConversation(userId, turn, maxTurns = null) {
  try {
    const key = getConversationKey(userId);
    const history = (await getConversation(userId)) || [];
    
    // Ensure turn is a valid object
    if (!turn || typeof turn !== 'object' || !turn.role || !turn.content) {
      logger.error(`Invalid turn object for user ${userId}:`, turn);
      return;
    }
    
    history.push(turn);
    
    // Dynamic context management: adjust maxTurns based on conversation progress
    if (maxTurns === null) {
      // Start with more context, reduce as conversation progresses
      const totalTurns = history.length;
      if (totalTurns <= 10) {
        maxTurns = 30; // Keep full context early on
      } else if (totalTurns <= 20) {
        maxTurns = 20; // Medium context in middle
      } else {
        maxTurns = 12; // Minimal context for long conversations (6 exchanges)
      }
    }
    
    // Trim the history to the calculated maximum number of turns
    const trimmedHistory = history.slice(-maxTurns);
    
    // Ensure we're storing as JSON string for consistency
    const jsonString = JSON.stringify(trimmedHistory);
    await redis.set(key, jsonString, { ex: CONVERSATION_TTL });
    
    logger.debug(`Appended conversation turn for user ${userId}`, {
      turnRole: turn.role,
      historyLength: trimmedHistory.length,
      totalTurnsEver: history.length,
      maxTurnsApplied: maxTurns,
      contextOptimized: history.length > maxTurns
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
 * Generates a phonetic representation of text for cache matching
 * @param {string} text - The text to convert to phonetic representation
 * @returns {string} Phonetic representation
 */
const generatePhoneticKey = (text) => {
  // Clean and normalize the text
  const cleanText = text.toLowerCase()
    .replace(/[^\w\s]/g, ' ') // Replace punctuation with spaces
    .replace(/\s+/g, ' ') // Normalize multiple spaces
    .trim();
  
  // Split into words and generate soundex codes
  const words = cleanText.split(' ').filter(word => word.length > 0);
  const phoneticCodes = words.map(word => {
    // For very short words or common words, use exact match
    if (word.length <= 2 || ['a', 'an', 'the', 'is', 'are', 'am', 'to', 'of', 'in', 'on', 'at', 'by'].includes(word)) {
      return word;
    }
    // Use soundex for longer words
    return soundex(word);
  });
  
  return phoneticCodes.join(' ');
};

/**
 * Generates a cache key for an AI response based on user input and context
 * Uses phonetic matching for better cache hit rates
 * @param {string} userInput - The user's input text
 * @param {Array} conversationHistory - Recent conversation history for context
 * @param {boolean} usePhonetic - Whether to use phonetic matching (default: true)
 * @returns {string} The cache key
 */
const generateResponseCacheKey = (userInput, conversationHistory = [], usePhonetic = true) => {
  // Determine if this input should use phonetic matching
  const shouldUsePhonetic = usePhonetic && shouldUsePhoneticCaching(userInput);
  
  let processedInput;
  if (shouldUsePhonetic) {
    // Use phonetic representation for better matching
    processedInput = generatePhoneticKey(userInput);
    logger.debug('Using phonetic cache key', {
      original: userInput,
      phonetic: processedInput
    });
  } else {
    // Use exact normalization for specific patterns
    processedInput = userInput.toLowerCase().trim();
  }
  
  // Get last 2 turns for context (to distinguish same question in different contexts)
  const contextString = conversationHistory
    .slice(-2)
    .map(turn => `${turn.role}:${turn.content}`)
    .join('|');
  
  // Create a hash from processed input + context
  const hash = crypto.createHash('md5')
    .update(processedInput + contextString)
    .digest('hex');
  
  const keyType = shouldUsePhonetic ? 'phonetic' : 'exact';
  return `${RESPONSE_CACHE_PREFIX}${keyType}:${hash}`;
};

/**
 * Determines if input should use phonetic caching
 * @param {string} userInput - The user's input
 * @returns {boolean} Whether to use phonetic matching
 */
const shouldUsePhoneticCaching = (userInput) => {
  // Don't use phonetic for very short inputs
  if (userInput.length < 4) {
    return false;
  }
  
  // Don't use phonetic for inputs with numbers or specific technical terms
  if (/\d/.test(userInput) || /microsoft|computer|virus|firewall|credit|card/i.test(userInput)) {
    return false;
  }
  
  // Don't use phonetic for single-word responses
  if (userInput.trim().split(/\s+/).length === 1) {
    return false;
  }
  
  return true;
};

/**
 * Get a cached AI response if available
 * Uses phonetic matching with fallback to exact matching
 * @param {string} userInput - The user's input text
 * @param {Array} conversationHistory - Recent conversation history
 * @returns {Promise<string|null>} The cached response or null
 */
async function getCachedResponse(userInput, conversationHistory = []) {
  try {
    if (process.env.ENABLE_RESPONSE_CACHING !== 'true') {
      return null;
    }
    
    // Try phonetic matching first
    const phoneticCacheKey = generateResponseCacheKey(userInput, conversationHistory, true);
    let cachedResponse = await redis.get(phoneticCacheKey);
    
    if (cachedResponse) {
      logger.info('💾 [PHONETIC-CACHE-HIT] Found cached AI response via phonetic matching', {
        userInput: userInput.substring(0, 50),
        cacheKey: phoneticCacheKey,
        responseLength: cachedResponse.length
      });
      return cachedResponse;
    }
    
    // Fallback to exact matching if phonetic didn't match
    const exactCacheKey = generateResponseCacheKey(userInput, conversationHistory, false);
    cachedResponse = await redis.get(exactCacheKey);
    
    if (cachedResponse) {
      logger.info('💾 [EXACT-CACHE-HIT] Found cached AI response via exact matching', {
        userInput: userInput.substring(0, 50),
        cacheKey: exactCacheKey,
        responseLength: cachedResponse.length
      });
      return cachedResponse;
    }
    
    logger.debug('💾 [CACHE-MISS] No cached response found', {
      userInput: userInput.substring(0, 50),
      phoneticKey: phoneticCacheKey.split(':').pop(),
      exactKey: exactCacheKey.split(':').pop()
    });
    
    return null;
  } catch (error) {
    logger.error('Error retrieving cached response:', error.message);
    return null;
  }
}

/**
 * Cache an AI response
 * Stores both phonetic and exact cache keys for maximum hit rate
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
    
    const keysStored = [];
    
    // Store phonetic cache key if applicable
    if (shouldUsePhoneticCaching(userInput)) {
      const phoneticCacheKey = generateResponseCacheKey(userInput, conversationHistory, true);
      await redis.set(phoneticCacheKey, response, { ex: ttl });
      await redis.sadd('response_cache_keys', phoneticCacheKey);
      keysStored.push('phonetic');
    }
    
    // Always store exact cache key as fallback
    const exactCacheKey = generateResponseCacheKey(userInput, conversationHistory, false);
    await redis.set(exactCacheKey, response, { ex: ttl });
    await redis.sadd('response_cache_keys', exactCacheKey);
    keysStored.push('exact');
    
    logger.info('💾 [CACHE-SET] Cached AI response', {
      userInput: userInput.substring(0, 50),
      keysStored: keysStored.join(', '),
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
 * @returns {Promise<number>} Number of keys deleted
 * @throws {Error} If there's an issue with the Redis operation
 */
async function clearResponseCache() {
  try {
    // Since Upstash Redis doesn't support SCAN, we'll use a different approach
    // We'll track cached keys in a set for easier management
    const cacheKeySet = 'response_cache_keys';
    
    // Get all tracked cache keys
    const cacheKeys = await redis.smembers(cacheKeySet);
    
    if (!cacheKeys || cacheKeys.length === 0) {
      logger.info('No response cache keys to clear');
      return 0;
    }
    
    // Delete all cache keys
    const deletePromises = cacheKeys.map(key => redis.del(key));
    await Promise.all(deletePromises);
    
    // Clear the tracking set
    await redis.del(cacheKeySet);
    
    logger.info(`Cleared ${cacheKeys.length} response cache entries`);
    return cacheKeys.length;
  } catch (error) {
    logger.error('Error clearing response cache:', error.message);
    throw new Error(`Failed to clear response cache: ${error.message}`);
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