/**
 * Conversation prompts and templates for AI
 */
const aiConfig = require('../config/ai');
const { buildMessages } = require('./promptBuilder');

// --- Microsoft Support Persona Greetings ---
const VERIES_PERSONA_PROMPT = aiConfig.openAI.systemPrompt;

const VERIES_GREETINGS = [
  "Hello, my name is Ben calling from Microsoft Support. Am I speaking with the main user of the computer?",
  "Hello, this is Ben from Microsoft Support. Are you the primary computer user at this number?",
  "Good day, my name is Ben from Microsoft Technical Support. Am I speaking with the computer owner?",
  "Hello, Ben here from Microsoft Support. Is this the main computer user I'm speaking with?"
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
  
  const systemMessage = VERIES_PERSONA_PROMPT;

  // No additional task message - let the system prompt handle behavior
  // Enable context optimization by default for faster LLM responses
  
  return buildMessages(systemMessage, conversationHistory, null, optimizeContext);
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
