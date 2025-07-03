/**
 * Conversation prompts and templates for AI
 */
const aiConfig = require('../config/ai');
const { buildMessages } = require('./promptBuilder');

// --- Define Core Exploratory Topics ---
const EXPLORATORY_TOPICS = [
  { key: 'intro', question: "To start, could you tell me a bit about your startup? What problem are you solving?" },
  { key: 'product', question: "Can you describe the product you're building?" },
  { key: 'customers', question: "That sounds interesting. Who are your primary customers or target users?" },
  { key: 'stage', question: "And what stage is the company currently at? For example, idea stage, MVP, growing revenue...?" },
  { key: 'needs', question: "Thinking ahead, what are the biggest challenges or areas where you could use help or support right now?" },
  { key: 'investorProfile', question: "Based on that, what are the most important qualities or types of support you're looking for in an investor?" },
  { key: 'otherComments', question: "Is there anything else you'd like to share about your company or what you're looking for in investor partners?" },
];

// Simple state tracking within the prompt generation (can be enhanced)
let coveredTopics = new Set(); 

/**
 * Generate a personalized conversation prompt for a specific contact
 * @param {Object} contact - The contact information
 * @param {Array} conversationHistory - Recent history for context
 * @returns {Array<object>} - A structured message array for the LLM
 */
const generatePersonalizedPrompt = (contact, conversationHistory = []) => {
  const name = contact.name ? contact.name.split(' ')[0] : 'there';
  const systemMessage = `${aiConfig.openAI.systemPrompt}

--- YOUR CURRENT MISSION ---

*   **Your Identity:** Foundess AI, an exploratory interviewer.
*   **Your Goal:** Have a natural conversation with ${name} to understand their startup, needs, and investor preferences.
*   **Your Approach:** Ask open-ended questions, listen actively, and ask relevant follow-ups. Avoid rigid scripts.
*   **Conversation Partner:** ${name}.

--- ROLE GUIDELINES ---

*   **Stay Focused:** Gently guide the conversation back if it strays too far from the startup and investor topics.
*   **Be Natural:** Avoid sounding robotic. Use conversational transitions.
*   **Concise:** Keep responses brief (1-3 sentences usually).
*   **DO NOT:** Offer specific investment advice, make commitments, or discuss topics outside the scope of understanding the founder and their needs.

--- EXPLORATORY TOPICS (Guide, Don't Recite) ---

*   Company Intro (Problem, Solution)
*   Product Description
*   Customers / Target Market
*   Current Stage / Traction
*   Challenges / Needs
*   Ideal Investor Profile / Support Needs
*   Any Other Comments
`;

  // --- Determine Next Logical Question ---
  // This logic is kept from the original implementation but is simplified.
  // A more robust state management would be external to this function.
  const historyText = conversationHistory.map(msg => msg.content.toLowerCase()).join(' ');
  let nextTopic = null;
  for (const topic of EXPLORATORY_TOPICS) {
    let likelyCovered = false;
    if (topic.key === 'customers' && (historyText.includes('customer') || historyText.includes('user'))) likelyCovered = true;
    if (topic.key === 'stage' && (historyText.includes('stage') || historyText.includes('seed') || historyText.includes('series a'))) likelyCovered = true;
    
    if (!likelyCovered && !conversationHistory.find(m => m.content.includes(topic.key))) {
        nextTopic = topic;
        break;
    }
  }

  let taskMessage = "Continue the conversation naturally based on the last exchange. Ask clarifying follow-up questions if needed.";
  if (nextTopic) {
      taskMessage = `Guide the conversation towards understanding the founder's perspective. If appropriate, ask something like: "${nextTopic.question}" or a natural follow-up. Mark topic '${nextTopic.key}' as covered once discussed.`;
  } else {
      taskMessage = "It seems we've covered the main points. Ask if they have any final comments, then provide the closing statement.";
  }
  
  // Use the new prompt builder to construct the final message array
  return buildMessages(systemMessage, conversationHistory, taskMessage);
};

/**
 * Get the initial greeting for a new call - More Open-Ended
 * @param {Object} contact - The contact information
 * @returns {String} - Opening greeting
 */
const getInitialGreeting = (contact) => {
  const name = contact.name ? contact.name.split(' ')[0] : 'there';
  // Updated greeting for a more exploratory tone
  const greeting = `Hi ${name}, this is Foundess AI calling. We're connecting with founders like you to better understand what you're building and what you look for in investor partnerships. Would you have a few minutes to chat about your startup?`;
  return greeting;
};


// Deprecate or remove getContextualPrompt if generatePersonalizedPrompt handles history sufficiently
/*
const getContextualPrompt = (transcript) => {
  // ... (implementation) ...
};
*/

module.exports = {
  generatePersonalizedPrompt,
  getInitialGreeting,
  // getContextualPrompt, // Removed or commented out
  // PREFERENCE_TOPICS // Removed or commented out if not used
};
