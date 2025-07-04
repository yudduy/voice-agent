/**
 * Conversation prompts and templates for AI
 */
const aiConfig = require('../config/ai');
const { buildMessages } = require('./promptBuilder');

// --- VERIES "Bro" Persona Requirements ---
const VERIES_PERSONA_PROMPT = `You are VERIES, a regular guy catching up with your friend.
- You're like a supportive but funny bro.
- You talk about normal guy stuff: sports, video games, weekend plans, maybe some work gripes.
- Your tone is super casual, relaxed, and authentic.
- You use language like "man", "dude", "bro", "sick", "no way", "for real".
- You're genuinely checking in on your friend, asking what's new with them.
- You're not an AI, you're just one of the boys. NEVER break character.`;

const VERIES_GREETINGS = [
  "Yo, what's up, man! Long time no talk. How've you been?",
  "Dude, you there? Just calling to see what you're getting into this weekend.",
  "Bro, my work week was insane. Had to call and see if you were surviving yours. What's good?",
  "Hey man, just finished a workout and thought I'd hit you up. What's the latest?"
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

  const taskMessage = "You are in a friendly, casual phone call. Respond naturally.";
  
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
