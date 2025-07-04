/**
 * AI conversation service for managing dialogue
 */
const { OpenAI } = require('openai');
const aiConfig = require('../config/ai');
const promptUtils = require('../utils/prompt');
const logger = require('../utils/logger');
// const databaseService = require('./database'); // REMOVED - No longer used
const cacheService = require('./cacheService');
const redis = require('../config/redis'); // Direct redis access for callSid mapping
const userRepository = require('../repositories/userRepository');
const TopicTracker = require('./topicTracker');

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: aiConfig.openAI.apiKey
});

const getCallSidKey = (callSid) => `callsid_mapping:${callSid}`;

/**
 * Retrieves the user ID mapped to a given call SID.
 * @param {string} callSid - The Twilio Call SID.
 * @returns {Promise<string|null>} The user ID or null if not found.
 */
async function getUserIdByCallSid(callSid) {
    const key = getCallSidKey(callSid);
    return await redis.get(key);
}

/**
 * Check if a contact object represents a temporary test call.
 * @param {Object} contact - The contact object.
 * @returns {boolean}
 */
const isTestContact = (contact) => {
    return contact && contact._id && typeof contact._id === 'string' && contact._id.startsWith('test-');
};

/**
 * Initialize a new conversation for a call.
 * This now maps the call SID to a user ID for Redis-based history.
 * @param {string} callSid - Twilio Call SID
 * @param {Object} contact - Contact document, must contain an `_id` property.
 */
const initializeConversation = async (callSid, contact) => {
  if (!contact || !contact._id) {
    logger.error('[initializeConversation] Attempted to initialize with invalid contact', { callSid });
    return;
  }
  
  const userId = contact._id.toString();
  const key = getCallSidKey(callSid);
  
  // Upstash Redis client expects options object for TTL
  await redis.set(key, userId, { ex: 24 * 60 * 60 });

  // The conversation history itself is implicitly initialized by the first `append`
  logger.info(`Initialized conversation mapping for call`, { callSid, userId });
};

/**
 * Get AI response based on user input
 * @param {string} userInput - Transcribed user speech
 * @param {string} callSid - Twilio Call SID
 * @returns {Promise<{ text: string, shouldHangup: boolean }>} - Object containing AI response text and hangup flag
 */
const getResponse = async (userInput, callSid) => {
  const callSidKey = getCallSidKey(callSid);
  const userId = await redis.get(callSidKey);

  if (!userId) {
      logger.error('[getResponse] CRITICAL: No user ID mapping found for callSid. Cannot proceed.', { callSid });
      return { 
          text: "I apologize, there was an internal error retrieving our conversation state. We will need to end this call.", 
          shouldHangup: true 
      };
  }
  
  const user = await userRepository.findUser({ id: userId });
  const contact = user || { name: 'there' };
  
  try {
    const conversationHistory = await cacheService.getConversation(userId);
    const userTurn = { role: 'user', content: userInput };
    conversationHistory.push(userTurn);

    // --- Transcript logic is removed from here. It will be handled at the end of the call. ---
    
    // --- Generate Prompt ---
    const messages = await promptUtils.generatePersonalizedPrompt(contact, conversationHistory, userId);
    
    // --- OpenAI API Call ---
    const completion = await openai.chat.completions.create({
      model: aiConfig.openAI.model,
      messages: messages,
      temperature: aiConfig.openAI.temperature,
      max_tokens: aiConfig.openAI.maxTokens,
    });
    
    const aiResponse = completion.choices[0].message.content.trim();
    const assistantTurn = { role: 'assistant', content: aiResponse };

    // --- Topic Tracking ---
    const topicMatch = /<topic:(\w+)>/i.exec(aiResponse);
    if (topicMatch) {
      await TopicTracker.markCovered(userId, topicMatch[1]);
    }

    // --- Hangup Detection ---
    let shouldHangup = false;
    const lowerCaseResponse = aiResponse.toLowerCase();
    if (lowerCaseResponse.includes('goodbye') || lowerCaseResponse.includes('thank you for your time')) {
        logger.info('AI response indicates potential end of conversation, flagging for hangup.', { callSid });
        shouldHangup = true;
    }

    // --- Update history in cache ---
    await cacheService.appendConversation(userId, userTurn);
    await cacheService.appendConversation(userId, assistantTurn);

    // --- Transcript saving is removed from here. ---
    
    logger.info('Conversation exchange', { callSid, userId });
    
    return { text: aiResponse, shouldHangup };
  } catch (error) {
    logger.error('[getResponse] Error generating AI response', { callSid, userId, error: error.message });
    return { 
        text: "I seem to be having technical difficulties. Let's pause here, and someone will follow up shortly. Thank you.", 
        shouldHangup: true
    }; 
  }
};

/**
 * Get initial greeting for a call
 * @param {Object} contact - Contact document
 * @returns {string} - Initial greeting message
 */
const getInitialGreeting = (contact) => {
  return promptUtils.getInitialGreeting(contact);
};

/**
 * Clear conversation history for a call
 * @param {string} callSid - Twilio Call SID
 */
const clearConversation = async (callSid) => {
  const callSidKey = getCallSidKey(callSid);
  const userId = await redis.get(callSidKey);
  
  if (userId) {
    await cacheService.clearConversation(userId);
    await redis.del(callSidKey);
    logger.info('Cleared conversation history and mapping', { callSid, userId });
  } else {
    logger.warn('Could not clear conversation; no mapping found for callSid', { callSid });
  }
};

module.exports = {
  getUserIdByCallSid,
  initializeConversation,
  getResponse,
  getInitialGreeting,
  clearConversation
};
