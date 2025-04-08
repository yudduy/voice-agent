/**
 * AI conversation service for managing dialogue
 */
const { OpenAI } = require('openai');
const aiConfig = require('../config/ai');
const promptUtils = require('../utils/prompt');
const logger = require('../utils/logger');
const databaseService = require('./database');

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: aiConfig.openai.apiKey
});

// Store conversation data (history and contact) by call SID
// Structure: Map<callSid, { history: Array, contact: Object }>
const conversations = new Map();

/**
 * Check if a contact object represents a temporary test call.
 * @param {Object} contact - The contact object.
 * @returns {boolean}
 */
const isTestContact = (contact) => {
    return contact && contact._id && typeof contact._id === 'string' && contact._id.startsWith('test-');
};

/**
 * Initialize a new conversation for a call
 * @param {string} callSid - Twilio Call SID
 * @param {Object} contact - Contact document
 */
const initializeConversation = (callSid, contact) => {
  if (!contact) {
      logger.error('[initializeConversation] Attempted to initialize with null contact', { callSid });
      // Avoid setting null contact, handle potential errors upstream
      conversations.set(callSid, { history: [], contact: null }); // Store null explicitly if it happens
      return;
  }
  // Store both history array and the contact object
  conversations.set(callSid, { history: [], contact: contact });
  logger.info(`Initialized conversation data for call`, { 
      callSid, 
      contactId: contact._id, 
      isTest: isTestContact(contact) 
  });
};

/**
 * Get AI response based on user input
 * @param {string} userInput - Transcribed user speech
 * @param {string} callSid - Twilio Call SID
 * @returns {Promise<{ text: string, shouldHangup: boolean }>} - Object containing AI response text and hangup flag
 */
const getResponse = async (userInput, callSid) => {
  let storedData = conversations.get(callSid);
  let contact = null;
  let conversationHistory = [];

  // Ensure data exists for the callSid
  if (!storedData || !storedData.history) {
      logger.error('[getResponse] CRITICAL: No conversation data found for callSid. Cannot proceed.', { callSid });
      // Cannot generate a meaningful response, force hangup
      return { 
          text: "I apologize, there was an internal error retrieving our conversation state. We will need to end this call.", 
          shouldHangup: true 
      };
  }
  
  // Retrieve contact and history
  contact = storedData.contact;
  conversationHistory = storedData.history;
  
  // Validate if contact is still null (should only happen if init failed badly)
  if (!contact) {
       logger.error('[getResponse] CRITICAL: Contact object is null in stored conversation data.', { callSid });
       // Fallback or create temporary? For safety, fallback and hangup.
        return { 
          text: "I apologize, critical contact information is missing for this call. We will need to end this call.", 
          shouldHangup: true 
      };
  }
  
  // Determine if this is a test call based on the *retrieved* contact object
  const isTest = isTestContact(contact);
  logger.debug(`[getResponse] Retrieved conversation data. isTestCall: ${isTest}`, { callSid, contactId: contact._id });

  try {
    // Add user's message to history (using the retrieved history array)
    conversationHistory.push({ role: 'user', content: userInput });
    
    // --- Conditional Transcript Save (User) --- 
    if (!isTest) {
        logger.debug('[getResponse] Saving user message to transcript...', { callSid });
        // Wrap in try-catch in case updateCallTranscript fails for other reasons
        try {
            await databaseService.updateCallTranscript(callSid, 'user', userInput);
        } catch (transcriptError) {
             logger.error('[getResponse] Failed to save user transcript', { callSid, error: transcriptError.message });
        }
    } else {
        logger.debug('[getResponse] Skipping user transcript save for test call.', { callSid });
    }
    // --- End Conditional Transcript Save --- 
    
    // --- Generate Strict System Prompt --- 
    // Always use the retrieved contact object here
    const recentHistory = conversationHistory.slice(-6);
    const systemPrompt = promptUtils.generatePersonalizedPrompt(contact, recentHistory); 
    // --- End System Prompt Generation ---
    
    // Prepare messages payload: System Prompt + History
    // Ensure history doesn't exceed token limits - prioritize recent messages
    const historyForPayload = conversationHistory.slice(-12); // Limit history size further
    const messagesPayload = [
      { role: 'system', content: systemPrompt },
      ...historyForPayload 
    ];
    
    logger.debug('Sending request to OpenAI', { 
        callSid, 
        messageCount: messagesPayload.length,
    });
    
    // --- OpenAI API Call --- 
    const completion = await openai.chat.completions.create({
      model: aiConfig.openai.model,
      messages: messagesPayload,
      temperature: aiConfig.openai.temperature,
      max_tokens: aiConfig.openai.maxTokens,
    });
    // --- End OpenAI API Call ---
    
    const aiResponse = completion.choices[0].message.content.trim();
    
    // --- Hangup Detection --- 
    let shouldHangup = false;
    const lowerCaseResponse = aiResponse.toLowerCase();
    // Simple keyword check - enhance if needed
    if (lowerCaseResponse.includes('goodbye') || 
        lowerCaseResponse.includes('thank you for your time') ||
        lowerCaseResponse.includes('have a great day')) {
        // More specific checks might be needed to avoid accidental hangup
        logger.info('AI response indicates potential end of conversation, flagging for hangup.', { callSid });
        shouldHangup = true;
    }
    // --- End Hangup Detection --- 

    // Add AI's response to history
    conversationHistory.push({ role: 'assistant', content: aiResponse });
    
    // --- Conditional Transcript Save --- 
    if (!isTest) {
        logger.debug('[getResponse] Saving AI message to transcript...', { callSid });
         try {
            await databaseService.updateCallTranscript(callSid, 'assistant', aiResponse);
         } catch (transcriptError) {
             logger.error('[getResponse] Failed to save AI transcript', { callSid, error: transcriptError.message });
         }
    } else {
        logger.debug('[getResponse] Skipping AI transcript save for test call.', { callSid });
    }
    // --- End Conditional Transcript Save --- 
    
    // Log the exchange
    logger.info('Conversation exchange', {
      callSid,
      userInput: userInput.substring(0, 50) + (userInput.length > 50 ? '...' : ''),
      aiResponse: aiResponse.substring(0, 50) + (aiResponse.length > 50 ? '...' : '')
    });
    
    // Return object with text and hangup flag
    return { text: aiResponse, shouldHangup };
  } catch (error) {
    logger.error('[getResponse] Error generating AI response', { 
        callSid, 
        contactId: contact?._id, // Log contactId from retrieved contact
        errorMessage: error.message, 
        errorStack: error.stack 
    });
    // Return fallback message in the correct structure
    return { 
        text: "I seem to be having technical difficulties connecting to my core functions. Let\'s pause here, and someone from our team will follow up shortly. Thank you.", 
        shouldHangup: true // Force hangup on internal AI error
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
const clearConversation = (callSid) => {
  if (conversations.has(callSid)) {
    conversations.delete(callSid);
    logger.info('Cleared conversation history', { callSid });
  }
};

module.exports = {
  initializeConversation,
  getResponse,
  getInitialGreeting,
  clearConversation
};
