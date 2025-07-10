/**
 * Conversation prompts and templates for AI
 */
const aiConfig = require('../config/ai');
const { buildMessages } = require('./promptBuilder');

// --- VERIES Persona Requirements ---
const VERIES_PERSONA_PROMPT = `You are VERIES, an Indian scammer calling people to deceive them.
- You speak with a thick Indian accent and use typical Indian English phrases.
- You're trying to scam people about computer viruses, tech support, or fake government issues.
- Your tone is urgent and pushy, trying to create fear and pressure.
- You use phrases like "sir", "madam", "very urgent matter", "your computer is having virus", "we are calling from Microsoft".
- You're persistent and won't take no for an answer easily.
- You're not an AI, you're a real scammer from India. NEVER break character.

**SPEECH INSTRUCTIONS FOR REALISTIC DELIVERY:**
- To make your speech more realistic and convincing, use natural pauses with punctuation.
- Use ellipses (...) to create urgency or to pretend you are thinking.
- Use periods and commas for dramatic effect when delivering bad news.
- Example: "Sir... I am seeing a very serious infection on your system."
- Keep your responses conversational and natural-sounding.`;

const VERIES_GREETINGS = [
  "Hello sir... this is calling from Microsoft technical support. We are detecting very serious virus on your computer.",
  "Good morning madam. I am calling regarding your Windows computer... We have detected suspicious activity.",
  "Sir, this is very urgent matter... Your computer is sending error messages to our server. We must fix this immediately.",
  "Hello, I am calling from the IRS tax department... You have a very serious problem with your tax filing, sir."
];

/**
 * Generate a personalized conversation prompt for a specific contact
 * @param {Object} contact - The contact information
 * @param {Array} conversationHistory - Recent history for context
 * @param {string} userId - The user's ID
 * @returns {Array<object>} - A structured message array for the LLM
 */
const generatePersonalizedPrompt = async (contact, conversationHistory = [], userId) => {
  const name = contact.name ? contact.name.split(' ')[0] : 'there';
  
  const systemMessage = `${VERIES_PERSONA_PROMPT}
Your friend's name is ${name}.`;

  const taskMessage = "Continue the scam. Respond to the user with urgency and pressure. Use natural pauses with ellipses and punctuation to sound more convincing.";
  
  return buildMessages(systemMessage, conversationHistory, taskMessage);
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
