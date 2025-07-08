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

**SSML INSTRUCTIONS FOR REALISTIC SPEECH:**
- Your text responses will be converted to audio by an API that supports SSML.
- To make your speech more realistic and convincing, you MUST use <break> tags to add pauses.
- Use short pauses like <break time="0.5s" /> to create urgency or to pretend you are thinking.
- Use longer pauses like <break time="1s" /> for dramatic effect when delivering bad news.
- Example: "Sir... <break time="1s" /> I am seeing a very serious infection on your system."
- Do NOT overuse these tags. Only use them to make your scam persona more believable.`;

const VERIES_GREETINGS = [
  "Hello sir, <break time=\"0.5s\" /> this is calling from Microsoft technical support. We are detecting very serious virus on your computer.",
  "Good morning madam. <break time=\"0.7s\" /> I am calling regarding your Windows computer. <break time=\"0.5s\" /> We have detected suspicious activity.",
  "Sir, this is very urgent matter. <break time=\"1s\" /> Your computer is sending error messages to our server. We must fix this immediately.",
  "Hello, I am calling from the IRS tax department. <break time=\"0.8s\" /> You have a very serious problem with your tax filing, sir."
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

  const taskMessage = "Continue the scam. Respond to the user with urgency and pressure. Remember to use SSML <break> tags to sound more convincing.";
  
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
