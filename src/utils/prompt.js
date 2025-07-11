/**
 * Conversation prompts and templates for AI
 */
const aiConfig = require('../config/ai');
const { buildMessages } = require('./promptBuilder');

// --- COLE FAN Persona Greetings ---
const VERIES_PERSONA_PROMPT = aiConfig.openAI.systemPrompt;

const VERIES_GREETINGS = [
  "Hi this is Duy, is this Zoey?",
  "Hey, this is Duy. Is this Zoey?",
  "Hi, Duy here. Is this Zoey?",
  "Hey this is Duy, am I talking to Zoey?"
];

/**
 * Generate a personalized conversation prompt for a specific contact
 * @param {Object} contact - The contact information
 * @param {Array} conversationHistory - Recent history for context
 * @param {string} userId - The user's ID
 * @returns {Array<object>} - A structured message array for the LLM
 */
const generatePersonalizedPrompt = async (contact, conversationHistory = [], userId) => {
  const name = contact.name && contact.name !== 'Guest User' ? contact.name.split(' ')[0] : 'there';
  
  const systemMessage = VERIES_PERSONA_PROMPT;

  // No additional task message - let the system prompt handle behavior
  
  return buildMessages(systemMessage, conversationHistory);
};

/**
 * Get the initial greeting for a new call
 * @param {Object} contact - The contact information
 * @returns {String} - Opening greeting
 */
const getInitialGreeting = (contact) => {
  // The name is not used in the new greetings, but keeping the param for consistency
  return VERIES_GREETINGS[Math.floor(Math.random() * VERIES_GREETINGS.length)];
};

module.exports = {
  generatePersonalizedPrompt,
  getInitialGreeting,
};
