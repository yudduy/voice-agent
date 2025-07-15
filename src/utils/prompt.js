/**
 * Conversation prompts and templates for AI
 */
const aiConfig = require('../config/ai');
const { buildMessages } = require('./promptBuilder');

// --- Professional AI Assistant Greetings ---
const AI_ASSISTANT_PROMPT = aiConfig.openAI.systemPrompt;

const PROFESSIONAL_GREETINGS = [
  "Hello, thank you for calling. How may I assist you today?",
  "Good morning, this is your AI assistant. How can I help you?",
  "Hello, I'm here to help. What can I assist you with today?",
  "Hi there, thank you for reaching out. How may I be of service?"
];

/**
 * Generate a personalized conversation prompt for a specific contact
 * @param {Object} contact - The contact information
 * @param {Array} conversationHistory - Recent history for context
 * @param {string} userId - The user's ID
 * @param {boolean} optimizeContext - Whether to apply context optimization for faster LLM processing
 * @returns {Array<object>} - A structured message array for the LLM
 */
const generatePersonalizedPrompt = (contact, conversationHistory = [], userId, optimizeContext = true) => {
  const name = contact.name && contact.name !== 'Guest User' ? contact.name.split(' ')[0] : 'there';
  
  const systemMessage = AI_ASSISTANT_PROMPT;

  // Use system prompt for professional AI assistant behavior
  // Enable context optimization by default for faster LLM responses
  
  return buildMessages(systemMessage, conversationHistory, null, optimizeContext);
};

/**
 * Get the initial greeting for a new call
 * @param {Object} contact - The contact information
 * @returns {String} - Opening greeting
 */
const getInitialGreeting = (contact) => {
  // Professional greeting selection
  return PROFESSIONAL_GREETINGS[Math.floor(Math.random() * PROFESSIONAL_GREETINGS.length)];
};

module.exports = {
  generatePersonalizedPrompt,
  getInitialGreeting,
};
