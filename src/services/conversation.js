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

// Store conversation history by call SID
const conversations = new Map();

/**
 * Initialize a new conversation for a call
 * @param {string} callSid - Twilio Call SID
 * @param {Object} contact - Contact document
 */
const initializeConversation = (callSid, contact) => {
  conversations.set(callSid, []);
  logger.info(`Initialized conversation for call`, { callSid, contactId: contact._id });
};

/**
 * Get AI response based on user input
 * @param {string} userInput - Transcribed user speech
 * @param {string} callSid - Twilio Call SID
 * @param {Object} contact - Contact document (optional)
 * @returns {Promise<string>} - AI response text
 */
const getResponse = async (userInput, callSid, contact = null) => {
  try {
    // Get or initialize conversation history
    if (!conversations.has(callSid)) {
      if (!contact) {
        logger.error('No contact provided for new conversation', { callSid });
        return "I'm sorry, I'm having trouble with this call. Let me connect you with someone from our team.";
      }
      conversations.set(callSid, []);
    }
    
    const conversationHistory = conversations.get(callSid);
    
    // Add user's message to history
    conversationHistory.push({ role: 'user', content: userInput });
    
    // Save user message to transcript
    await databaseService.updateCallTranscript(callSid, 'user', userInput);
    
    // Generate appropriate system prompt
    let systemPrompt;
    if (contact) {
      systemPrompt = promptUtils.generatePersonalizedPrompt(contact);
    } else {
      // Get transcript from database to provide context
      const call = await databaseService.getCallInfo(callSid);
      if (call && call.transcript) {
        systemPrompt = promptUtils.getContextualPrompt(call.transcript);
      } else {
        systemPrompt = aiConfig.openai.systemPrompt;
      }
    }
    
    // Prepare messages payload for OpenAI API
    const messagesPayload = [
      { role: 'system', content: systemPrompt },
      ...conversationHistory.slice(-10) // Keep context manageable
    ];
    
    logger.debug('Sending request to OpenAI', { callSid });
    
    // Get response from OpenAI
    const completion = await openai.chat.completions.create({
      model: aiConfig.openai.model,
      messages: messagesPayload,
      temperature: aiConfig.openai.temperature,
      max_tokens: aiConfig.openai.maxTokens,
    });
    
    const aiResponse = completion.choices[0].message.content.trim();
    
    // Add AI's response to history
    conversationHistory.push({ role: 'assistant', content: aiResponse });
    
    // Save AI response to transcript
    await databaseService.updateCallTranscript(callSid, 'assistant', aiResponse);
    
    // Log the exchange
    logger.info('Conversation exchange', {
      callSid,
      userInput: userInput.substring(0, 50) + (userInput.length > 50 ? '...' : ''),
      aiResponse: aiResponse.substring(0, 50) + (aiResponse.length > 50 ? '...' : '')
    });
    
    return aiResponse;
  } catch (error) {
    logger.error('Error generating AI response', { 
      callSid, 
      error: error.message,
      stack: error.stack
    });
    return "I'm having trouble understanding. Could you please repeat that, or I can have someone from our team call you back?";
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
