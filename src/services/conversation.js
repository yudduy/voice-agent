/**
 * AI conversation service for managing dialogue
 */
const { OpenAI } = require('openai');
const aiConfig = require('../config/ai');
const promptUtils = require('../utils/prompt');
const logger = require('../utils/logger');
const cacheService = require('./cacheService');
const redis = require('../config/redis');
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
  
  // Check for scam-related responses
  if (conversationHistory.length <= 5) { // Early in conversation
    if (/yes|yeah|yep|yup|i am|i do/i.test(lowerInput)) {
      return { isScamResponse: true, isFallingForIt: true };
    }
    if (/no|nope|nah|i don't have a computer|wrong number/i.test(lowerInput)) {
      return { isScamResponse: true, isFallingForIt: false };
    }
    if (/credit card|payment|buy/i.test(lowerInput)) {
      return { isScamResponse: true, wantsToPay: true };
    }
  }
  
  return { isNormal: true };
};

const getResponse = async (userInput, callSid, userId) => {
  if (!userId) {
      const callSidKey = getCallSidKey(callSid);
      userId = await redis.get(callSidKey);
  }

  if (!userId) {
      logger.error('[getResponse] CRITICAL: No user ID mapping found for callSid. Cannot proceed.', { callSid });
      return { 
          text: "Sorry, I'm having some technical issues right now. This is so frustrating! Let me try to fix this quickly.", 
          shouldHangup: true 
      };
  }
  
  const contact = await userRepository.findUser({ id: userId });
  
  try {
    const conversationHistory = await cacheService.getConversation(userId);
    
    // --- Intent Classification and Contextual System Messages ---
    const userIntent = classifyUserIntent(userInput, conversationHistory);
    const lastAssistantMessage = conversationHistory.filter(m => m.role === 'assistant').pop()?.content;
    const contextualizedHistory = [...conversationHistory];
    const userTurn = { role: 'user', content: userInput };
    contextualizedHistory.push(userTurn);

    if (userIntent.isConfusion && lastAssistantMessage) {
      if (userIntent.requiresRepetition) {
        // User explicitly asked for repetition
        contextualizedHistory.push({
          role: 'system',
          content: `The user didn't hear you. Your last message was: "${lastAssistantMessage}". Repeat it with more urgency.`
        });
      } else if (userIntent.requiresClarification) {
        // User is confused about the situation
        contextualizedHistory.push({
          role: 'system',
          content: `The user is confused. Reassure them you are from Microsoft Support and that their computer is in danger. Be firm and serious.`
        });
      } else if (userIntent.confusionType === 'simple_what') {
        // Just "what?" - could be they didn't hear or are confused
        contextualizedHistory.push({
          role: 'system',
          content: `The user said "${userInput}". Your last message was: "${lastAssistantMessage}". Repeat it more clearly and with more urgency.`
        });
      }
    }
    
    // Handle early scam-related responses
    if (userIntent.isScamResponse) {
      if (userIntent.isFallingForIt) {
        contextualizedHistory.push({
          role: 'system',
          content: `The user is agreeing with you. Reinforce the danger and the need for the firewall.`
        });
      } else if (userIntent.wantsToPay) {
        contextualizedHistory.push({
          role: 'system',
          content: `The user is asking about payment. This is good. Proceed to ask for their credit card information to purchase the firewall.`
        });
      } else {
        contextualizedHistory.push({
          role: 'system',
          content: `The user is denying the problem. Be firm, insist that your servers have detected a virus, and that they are in great danger.`
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
    
    const isConfusionRequest = userIntent.isConfusion || false;
    
    // Check if user is denying the scam
    const denialIndicators = [
      "i don't have a computer", "i don't have a virus", "you are a scammer", 
      "this is a scam", "i'm calling the police"
    ];
    
    const isDenial = denialIndicators.some(indicator => 
      lowerCaseInput.includes(indicator)
    );
    
    // Only hang up if AI decides to give up
    if (lowerCaseResponse.includes('goodbye') || lowerCaseResponse.includes('have a great day')) {
      logger.info('AI response indicates end of conversation, flagging for hangup', { callSid });
      shouldHangup = true;
    }
    
    // Log confusion handling
    if (isConfusionRequest) {
      logger.info('User seems confused - NOT hanging up, will clarify', { 
        callSid, 
        userInput,
        aiResponse: aiResponse.slice(0, 50) + '...',
        lastAssistantMessage: lastAssistantMessage ? lastAssistantMessage.slice(0, 50) + '...' : 'none'
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
 * Get AI response as a stream for real-time generation
 * @param {string} userInput - Transcribed user speech
 * @param {string} callSid - Twilio Call SID
 * @param {string} userId - User ID (optional, will be looked up if not provided)
 * @returns {Promise<AsyncGenerator>} - Async generator yielding text chunks
 */
const getResponseStream = async function* (userInput, callSid, userId) {
  if (!userId) {
    const callSidKey = getCallSidKey(callSid);
    userId = await redis.get(callSidKey);
  }

  if (!userId) {
    logger.error('[getResponseStream] CRITICAL: No user ID mapping found for callSid. Cannot proceed.', { callSid });
    yield "Sorry, I'm having some technical issues right now. This is so frustrating! Let me try to fix this quickly.";
    return;
  }
  
  const contact = await userRepository.findUser({ id: userId });
  
  try {
    const conversationHistory = await cacheService.getConversation(userId);
    
    // --- Intent Classification and Contextual System Messages ---
    const userIntent = classifyUserIntent(userInput, conversationHistory);
    const lastAssistantMessage = conversationHistory.filter(m => m.role === 'assistant').pop()?.content;
    const contextualizedHistory = [...conversationHistory];
    const userTurn = { role: 'user', content: userInput };
    contextualizedHistory.push(userTurn);

    // Add context messages (same as getResponse)
    if (userIntent.isConfusion && lastAssistantMessage) {
      if (userIntent.requiresRepetition) {
        contextualizedHistory.push({
          role: 'system',
          content: `The user didn't hear you. Your last message was: "${lastAssistantMessage}". Repeat it with more urgency.`
        });
      } else if (userIntent.requiresClarification) {
        contextualizedHistory.push({
          role: 'system',
          content: `The user is confused. Reassure them you are from Microsoft Support and that their computer is in danger. Be firm and serious.`
        });
      } else if (userIntent.confusionType === 'simple_what') {
        contextualizedHistory.push({
          role: 'system',
          content: `The user said "${userInput}". Your last message was: "${lastAssistantMessage}". Repeat it more clearly and with more urgency.`
        });
      }
    }
    
    // Handle scam-related responses
    if (userIntent.isScamResponse) {
      if (userIntent.isFallingForIt) {
        contextualizedHistory.push({
          role: 'system',
          content: `The user is agreeing with you. Reinforce the danger and the need for the firewall.`
        });
      } else if (userIntent.wantsToPay) {
        contextualizedHistory.push({
          role: 'system',
          content: `The user is asking about payment. This is good. Proceed to ask for their credit card information to purchase the firewall.`
        });
      } else {
        contextualizedHistory.push({
          role: 'system',
          content: `The user is denying the problem. Be firm, insist that your servers have detected a virus, and that they are in great danger.`
        });
      }
    }
    
    const messages = await promptUtils.generatePersonalizedPrompt(contact, contextualizedHistory, userId);
    
    logger.info('🧠 [LLM-STREAM-INPUT] Starting streaming response', { 
      callSid, 
      userId,
      userInput: userInput,
      inputLength: userInput.length,
      conversationTurns: conversationHistory.length
    });
    
    // --- OpenAI Streaming API Call ---
    const stream = await openai.chat.completions.create({
      model: aiConfig.openAI.model,
      messages: messages,
      temperature: aiConfig.openAI.temperature,
      max_tokens: aiConfig.openAI.maxTokens,
      stream: true // Enable streaming
    });
    
    let fullResponse = '';
    let tokenCount = 0;
    
    // Iterate through the stream
    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content || '';
      if (content) {
        fullResponse += content;
        tokenCount++;
        
        // Yield each chunk as it arrives
        yield content;
        
        // Log progress periodically
        if (tokenCount % 10 === 0) {
          logger.debug('🧠 [LLM-STREAM] Streaming progress', {
            callSid,
            userId,
            tokensGenerated: tokenCount,
            currentLength: fullResponse.length
          });
        }
      }
    }
    
    // Validate the complete response
    const validatedResponse = validateAndFixResponse(fullResponse, userIntent, conversationHistory);
    
    // If validation changed the response, yield the correction
    if (validatedResponse !== fullResponse) {
      logger.warn('⚠️ [VALIDATION] Response was corrected during streaming', {
        callSid,
        original: fullResponse.slice(0, 50),
        corrected: validatedResponse.slice(0, 50)
      });
      // Clear and send corrected version
      yield '\n[CORRECTION]\n';
      yield validatedResponse;
      fullResponse = validatedResponse;
    }
    
    logger.info('🧠 [LLM-STREAM-OUTPUT] Streaming completed', {
      callSid,
      userId,
      responseLength: fullResponse.length,
      totalTokens: tokenCount
    });
    
    // Update conversation history with complete response
    const assistantTurn = { role: 'assistant', content: fullResponse };
    await cacheService.appendConversation(userId, userTurn);
    await cacheService.appendConversation(userId, assistantTurn);
    
    // Cache the complete response
    await cacheService.setCachedResponse(userInput, conversationHistory, fullResponse);
    
    // Return metadata about hangup detection
    const shouldHangup = fullResponse.toLowerCase().includes('goodbye') || 
                        fullResponse.toLowerCase().includes('have a great day');
    
    // Store metadata for orchestrator to use
    stream.metadata = { 
      fullResponse, 
      shouldHangup,
      userIntent 
    };
    
  } catch (error) {
    logger.error('[getResponseStream] Error in streaming AI response', { 
      callSid, 
      userId, 
      error: error.message, 
      stack: error.stack 
    });
    yield "Ugh, I'm having some technical difficulties! This is so annoying. I'll get someone to follow up with you soon!";
  }
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
  if (conversationHistory.length < 4) { // Early in conversation
    if (!/microsoft|support|virus|computer/i.test(lowerResponse)) {
      logger.warn('⚠️ [VALIDATION] AI response is off-character early in the conversation', {
        originalResponse: response.slice(0, 50)
      });
      return "Hello, this is Ben from Microsoft Support. We have detected a virus on your computer.";
    }
  }

  // Ensure hangup responses are appropriate
  if (/wrong\s+number/i.test(lowerResponse)) {
    return "My apologies, I will update my records. Have a good day.";
  }
  
  return response;
};

module.exports = {
  getUserIdByCallSid,
  initializeConversation,
  getResponse,
  getResponseStream,
  getInitialGreeting,
  clearConversation
};
