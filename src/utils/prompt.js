/**
 * Conversation prompts and templates for AI
 */
const aiConfig = require('../config/ai');

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
 * @returns {String} - The customized system prompt
 */
const generatePersonalizedPrompt = (contact, conversationHistory = []) => {
  const name = contact.name ? contact.name.split(' ')[0] : 'there';
  // Use the base system prompt from config
  const basePrompt = aiConfig.openAI.systemPrompt; 

  // --- Determine Next Logical Question --- 
  let nextTopic = null;
  // Analyze history briefly to see what might have been touched upon
  // (This is a basic version - could use NLP or keyword spotting for better accuracy)
  const historyText = conversationHistory.map(msg => msg.content.toLowerCase()).join(' ');
  
  for (const topic of EXPLORATORY_TOPICS) {
    if (!coveredTopics.has(topic.key)) { 
        // Basic check if keywords related to the topic appear in recent history
        // This helps avoid asking again immediately if user already mentioned it
        let likelyCovered = false;
        if (topic.key === 'customers' && (historyText.includes('customer') || historyText.includes('user'))) likelyCovered = true;
        if (topic.key === 'stage' && (historyText.includes('stage') || historyText.includes('seed') || historyText.includes('series a'))) likelyCovered = true;
        // Add more checks for other topics if needed
        
        if (!likelyCovered) {
            nextTopic = topic; // Found the next likely topic
            break;
        }
    }
  }

  // If all main topics seem covered, move to closing
  if (!nextTopic && !coveredTopics.has('otherComments')) {
      nextTopic = EXPLORATORY_TOPICS.find(t => t.key === 'otherComments');
  }
  
  let nextStepInstruction = "Continue the conversation naturally based on the last exchange. Ask clarifying follow-up questions if needed.";
  if (nextTopic) {
      nextStepInstruction = `Guide the conversation towards understanding the founder's perspective. If appropriate, ask something like: "${nextTopic.question}" or a natural follow-up based on their last response. Mark topic '${nextTopic.key}' as covered once discussed.`;
      // Simple state update (Note: This state is per-prompt generation, not persistent across calls)
      // A more robust state management would be needed outside this function.
      // For now, we'll rely on the AI to track based on prompt instructions.
      // coveredTopics.add(nextTopic.key); // Avoid modifying global state here
  } else {
      nextStepInstruction = "It seems we've covered the main points. Ask if they have any final comments, then provide the closing statement."
  }
  
  // --- Construct the Full Prompt --- 
  return `${basePrompt}

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

--- CURRENT CONTEXT (Last few exchanges) ---
${conversationHistory.slice(-6).map(msg => `- ${msg.role === 'user' ? name : 'You'}: ${msg.content}`).join('\n')}

--- NEXT STEP ---
${nextStepInstruction}
`;
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
