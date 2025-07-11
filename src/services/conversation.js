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
/**
 * Classify user intent to handle special cases
 * @param {string} userInput - The user's input
 * @param {Array} conversationHistory - Recent conversation history
 * @returns {Object} Intent classification result
 */
const classifyUserIntent = (userInput, conversationHistory) => {
  const lowerInput = userInput.toLowerCase().trim();
  
  // Check for confusion/repetition requests
  const confusionPatterns = [
    { pattern: /^what\?*$/i, type: 'simple_what' },
    { pattern: /^(sorry\s+)?what(\s+did\s+you\s+say)?\?*$/i, type: 'clarification' },
    { pattern: /^pardon\?*$/i, type: 'clarification' },
    { pattern: /can\s+you\s+repeat/i, type: 'repeat_request' },
    { pattern: /didn't\s+(hear|catch)/i, type: 'didnt_hear' },
    { pattern: /say\s+that\s+again/i, type: 'repeat_request' },
    { pattern: /^wait\s+wait/i, type: 'interruption' },
    { pattern: /^hold\s+on/i, type: 'interruption' },
    { pattern: /what's\s+going\s+on/i, type: 'confusion' },
    { pattern: /^hello\?*$/i, type: 'hello_confusion' }
  ];
  
  for (const { pattern, type } of confusionPatterns) {
    if (pattern.test(lowerInput)) {
      return { 
        isConfusion: true, 
        confusionType: type,
        requiresRepetition: ['clarification', 'repeat_request', 'didnt_hear'].includes(type),
        requiresClarification: ['interruption', 'confusion', 'hello_confusion'].includes(type)
      };
    }
  }
  
  // Check for Zoey identification responses
  if (conversationHistory.length <= 5) { // Early in conversation
    if (/^(yes|yeah|yep|yup|mhm|uh\s*huh)$/i.test(lowerInput)) {
      return { isIdentification: true, isZoey: true };
    }
    if (/^(no|nope|nah|not\s+zoey|wrong\s+number)$/i.test(lowerInput)) {
      return { isIdentification: true, isZoey: false };
    }
  }
  
  return { isNormal: true };
};

const getResponse = async (userInput, callSid) => {
  const callSidKey = getCallSidKey(callSid);
  const userId = await redis.get(callSidKey);

  if (!userId) {
      logger.error('[getResponse] CRITICAL: No user ID mapping found for callSid. Cannot proceed.', { callSid });
      return { 
          text: "Sorry, I'm having some technical issues right now. This is so frustrating! Let me try to fix this quickly.", 
          shouldHangup: true 
      };
  }
  
  const user = await userRepository.findUser({ id: userId });
  const contact = user || { name: 'there' };
  
  try {
    const conversationHistory = await cacheService.getConversation(userId);
    
    // Classify the user's intent
    const userIntent = classifyUserIntent(userInput, conversationHistory);
    const isConfusionRequest = userIntent.isConfusion || false;
    
    logger.info('🎯 [INTENT] User intent classification', {
      callSid,
      userId,
      userInput: userInput.substring(0, 50),
      intent: userIntent,
      conversationLength: conversationHistory.length
    });
    
    // Skip cache for confusion requests to ensure context-aware responses
    let cachedResponse = null;
    if (!isConfusionRequest) {
      cachedResponse = await cacheService.getCachedResponse(userInput, conversationHistory);
    }
    
    if (cachedResponse) {
      logger.info('💾 [CACHE-HIT] Using cached response', {
        callSid,
        userId,
        userInput: userInput.substring(0, 50),
        cachedResponseLength: cachedResponse.length
      });
      
      // Use appendConversation for consistency
      const userTurn = { role: 'user', content: userInput };
      const assistantTurn = { role: 'assistant', content: cachedResponse };
      await cacheService.appendConversation(userId, userTurn);
      await cacheService.appendConversation(userId, assistantTurn);
      
      // Check for hangup conditions
      const shouldHangup = cachedResponse.toLowerCase().includes('goodbye') || 
                          cachedResponse.toLowerCase().includes('thank you for your time');
      
      return { text: cachedResponse, shouldHangup };
    }
    
    // No cache hit, proceed with normal flow
    const userTurn = { role: 'user', content: userInput };
    conversationHistory.push(userTurn);

    // --- Transcript logic is removed from here. It will be handled at the end of the call. ---
    
    // --- Generate Prompt with Enhanced Context ---
    // Extract the last assistant message for confusion handling
    let lastAssistantMessage = null;
    for (let i = conversationHistory.length - 1; i >= 0; i--) {
      if (conversationHistory[i].role === 'assistant') {
        lastAssistantMessage = conversationHistory[i].content;
        break;
      }
    }
    
    // Add context based on user intent
    let contextualizedHistory = [...conversationHistory];
    
    if (userIntent.isConfusion && lastAssistantMessage) {
      if (userIntent.requiresRepetition) {
        // User explicitly asked for repetition
        contextualizedHistory.push({
          role: 'system',
          content: `The user didn't hear or wants you to repeat. Your last message was: "${lastAssistantMessage}". Repeat it clearly, you can rephrase slightly for clarity but keep the same meaning.`
        });
      } else if (userIntent.requiresClarification) {
        // User is confused about the situation
        contextualizedHistory.push({
          role: 'system',
          content: `The user seems confused about who you are or why you're calling. Clarify that you're Duy looking for your sister Zoey. Don't just repeat the same question.`
        });
      } else if (userIntent.confusionType === 'simple_what') {
        // Just "what?" - could be they didn't hear or are confused
        contextualizedHistory.push({
          role: 'system',
          content: `The user said "${userInput}". Your last message was: "${lastAssistantMessage}". Either repeat it more clearly OR if you've already asked the same question multiple times, try a different approach.`
        });
      }
    }
    
    // Handle early identification responses
    if (userIntent.isIdentification) {
      if (userIntent.isZoey) {
        contextualizedHistory.push({
          role: 'system',
          content: `The user just confirmed they ARE Zoey! Now get into your demanding younger brother role and ask for help with homework or other sibling stuff.`
        });
      } else {
        contextualizedHistory.push({
          role: 'system',
          content: `The user confirmed they are NOT Zoey. You must apologize for the wrong number and end the call immediately.`
        });
      }
    }
    
    const messages = await promptUtils.generatePersonalizedPrompt(contact, contextualizedHistory, userId);
    
    logger.info('🧠 [LLM-INPUT] User said', { 
      callSid, 
      userId,
      userInput: userInput,
      inputLength: userInput.length,
      conversationTurns: conversationHistory.length
    });
    
    logger.debug('[getResponse] Calling OpenAI API', { 
      callSid, 
      userId, 
      model: aiConfig.openAI.model,
      messageCount: messages.length,
      userInputLength: userInput.length
    });
    
    // --- OpenAI API Call ---
    const completion = await openai.chat.completions.create({
      model: aiConfig.openAI.model,
      messages: messages,
      temperature: aiConfig.openAI.temperature,
      max_tokens: aiConfig.openAI.maxTokens,
    });
    
    let aiResponse = completion.choices[0].message.content.trim();
    
    // Validate and fix response if needed
    aiResponse = validateAndFixResponse(aiResponse, userIntent, conversationHistory);
    
    const assistantTurn = { role: 'assistant', content: aiResponse };

    logger.info('🧠 [LLM-OUTPUT] AI generated', {
      callSid,
      userId,
      aiResponse: aiResponse,
      responseLength: aiResponse.length,
      tokensUsed: completion.usage?.total_tokens || 'unknown',
      validated: true
    });


    // --- Hangup Detection ---
    let shouldHangup = false;
    const lowerCaseResponse = aiResponse.toLowerCase();
    const lowerCaseInput = userInput.toLowerCase();
    
    // isConfusionRequest was already calculated above
    
    // Check if user said they're not Zoey (wrong number scenario)
    // But be more specific to avoid false positives
    const notZoeyIndicators = [
      "i'm not zoey", "not zoey", "wrong number", "you have the wrong", 
      "this isn't zoey", "no zoey here", "she's not here", "zoey's not here"
    ];
    
    // Special handling for simple "no" - only treat as not Zoey if it's the whole response
    // or follows the initial "Is this Zoey?" question
    const isSimpleNo = lowerCaseInput.trim() === 'no' || 
                       lowerCaseInput.trim() === 'nope' ||
                       lowerCaseInput.trim() === 'no it is not';
    
    const isNotZoey = notZoeyIndicators.some(indicator => 
      lowerCaseInput.includes(indicator)
    ) || (isSimpleNo && conversationHistory.length <= 3); // Simple no only counts early in conversation
    
    // Only hang up if user explicitly says they're not Zoey AND they're not just confused
    if (isNotZoey && !isConfusionRequest) {
      logger.info('User clearly indicated they are not Zoey, ending call', { callSid, userInput });
      shouldHangup = true;
    } else if (lowerCaseResponse.includes('wrong number') && lowerCaseResponse.includes('sorry')) {
      // Only hang up if AI explicitly says both "wrong number" AND "sorry"
      logger.info('AI response indicates wrong number scenario, flagging for hangup', { callSid });
      shouldHangup = true;
    } else if (lowerCaseResponse.includes('goodbye') || lowerCaseResponse.includes('have a great day')) {
      // More specific hangup phrases
      logger.info('AI response indicates end of conversation, flagging for hangup', { callSid });
      shouldHangup = true;
    }
    
    // Log confusion handling
    if (isConfusionRequest) {
      logger.info('User seems confused - NOT hanging up, will clarify', { 
        callSid, 
        userInput,
        aiResponse: aiResponse.substring(0, 50) + '...',
        lastAssistantMessage: lastAssistantMessage ? lastAssistantMessage.substring(0, 50) + '...' : 'none'
      });
    }

    // --- Update history in cache ---
    await cacheService.appendConversation(userId, userTurn);
    await cacheService.appendConversation(userId, assistantTurn);

    // --- Cache the response if cacheable ---
    await cacheService.setCachedResponse(userInput, conversationHistory, aiResponse);

    // --- Transcript saving is removed from here. ---
    
    logger.info('Conversation exchange', { callSid, userId });
    
    return { text: aiResponse, shouldHangup };
  } catch (error) {
    logger.error('[getResponse] Error generating AI response', { callSid, userId, error: error.message, stack: error.stack });
    return { 
        text: "Ugh, I'm having some technical difficulties! This is so annoying. I'll get someone to follow up with you soon!", 
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

/**
 * Validates and fixes AI responses to ensure they stay in character
 * @param {string} response - The AI's response
 * @param {Object} userIntent - The classified user intent
 * @param {Array} conversationHistory - The conversation history
 * @returns {string} The validated/fixed response
 */
const validateAndFixResponse = (response, userIntent, conversationHistory) => {
  const lowerResponse = response.toLowerCase();
  
  // Check for off-character responses
  if (conversationHistory.length < 10) { // Early in conversation
    // Ensure we're not talking about math homework before confirming it's Zoey
    const hasConfirmedZoey = conversationHistory.some(turn => 
      turn.role === 'user' && /^(yes|yeah|yep|yup|i\s+am|this\s+is\s+zoey)/i.test(turn.content)
    );
    
    if (!hasConfirmedZoey && /homework|calculus|essay|math\s+problem|college/i.test(lowerResponse)) {
      logger.warn('⚠️ [VALIDATION] Response mentions homework before Zoey confirmation', {
        originalResponse: response.substring(0, 50),
        hasConfirmedZoey
      });
      
      // Replace with identification-focused response
      if (userIntent.isConfusion) {
        return "Sorry, I'm looking for my sister Zoey. Is this her?";
      } else {
        return "Wait, is this Zoey? I need to make sure I have the right number.";
      }
    }
  }
  
  // Check for repetitive "is this Zoey" patterns
  const recentAiResponses = conversationHistory
    .filter(turn => turn.role === 'assistant')
    .slice(-3)
    .map(turn => turn.content.toLowerCase());
  
  const isThisZoeyCount = recentAiResponses.filter(r => 
    /is\s+this\s+zoey|looking\s+for\s+zoey/i.test(r)
  ).length;
  
  if (isThisZoeyCount >= 2 && /is\s+this\s+zoey|looking\s+for\s+zoey/i.test(lowerResponse)) {
    logger.warn('⚠️ [VALIDATION] Too many "is this Zoey" questions', {
      count: isThisZoeyCount,
      recentResponses: recentAiResponses
    });
    
    // Try a different approach
    return "I'm trying to reach my sister Zoey. If this isn't her, I'll just hang up.";
  }
  
  // Ensure wrong number responses are appropriate
  if (/wrong\s+number/i.test(lowerResponse) && !/sorry/i.test(lowerResponse)) {
    return "Oh sorry, wrong number.";
  }
  
  return response;
};

module.exports = {
  getUserIdByCallSid,
  initializeConversation,
  getResponse,
  getInitialGreeting,
  clearConversation
};
