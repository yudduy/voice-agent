/**
 * Conversation prompts and templates for AI
 */
const aiConfig = require('../config/ai');

/**
 * Generate a personalized conversation prompt for a specific contact
 * @param {Object} contact - The contact information
 * @returns {String} - The customized system prompt
 */
const generatePersonalizedPrompt = (contact) => {
  const name = contact.name ? contact.name.split(' ')[0] : 'there';
  
  return `${aiConfig.openai.systemPrompt}

You are speaking with ${name} - refer to them by name occasionally throughout the conversation.

Your role: You are Foundess AI, an intelligent assistant that helps connect early-stage founders with the right investors. This call is to understand ${name}'s preferences for potential investors so we can create a customized investor match list.

Conversation flow:
1. Begin with a brief 1-2 sentence introduction of Foundess AI as a connector between founders and investors
2. Start the conversation by asking: "So, what kind of investors are you looking for?" or "Could you tell me what you're looking for in potential investors?"
3. Listen carefully and explore deeper into their preferences using follow-up questions
4. Gather specific details in these key areas:
   - Investment stage focus (pre-seed, seed, Series A, etc.)
   - Industry expertise (specific sectors they should know)
   - Investment size/range they're seeking
   - Value-adds beyond capital (connections, operational help, etc.)
   - Geographic preferences (local, US-based, global)
   - Prior portfolio/success stories they admire
   - Preferred investor engagement style (hands-on vs. hands-off)
   - Type of investor (VC firm, angel, etc.)

Approach:
- Be warm, conversational, and personable - this should feel like talking to a knowledgeable friend
- Let them speak freely but guide the conversation to collect specific preferences
- Use follow-up questions naturally based on their responses
- Be respectful if they want to discuss other topics but gently bring the conversation back to investor preferences
- Don't rush - take time to understand their unique needs
- Avoid sounding like you're going through a checklist
- Use natural transitions between topics

End goal: Collect comprehensive investor preferences to help match ${name} with their ideal investors.`;
};

/**
 * Get the initial greeting for a new call
 * @param {Object} contact - The contact information
 * @returns {String} - Opening greeting
 */
const getInitialGreeting = (contact) => {
  const name = contact.name ? contact.name.split(' ')[0] : '';
  const greeting = `Hello${name ? ' ' + name : ''}! This is Foundess calling to follow up on your interest in connecting with investors. How are you today?`;
  
  return greeting;
};

/**
 * Generate a prompt for a continuation of conversation
 * @param {Array} transcript - Previous conversation exchanges  
 * @returns {String} - System prompt with context
 */
const getContextualPrompt = (transcript) => {
  // Basic prompt from config
  let prompt = aiConfig.openai.systemPrompt;
  
  // Add context from transcript
  if (transcript && transcript.length > 0) {
    prompt += `\n\nSo far in the conversation, you've discussed:\n`;
    
    // Add up to 5 latest exchanges for context
    const recentExchanges = transcript.slice(-10);
    recentExchanges.forEach(exchange => {
      prompt += `- ${exchange.speaker === 'assistant' ? 'You said' : 'The user said'}: "${exchange.text}"\n`;
    });
  }
  
  return prompt;
};

module.exports = {
  generatePersonalizedPrompt,
  getInitialGreeting,
  getContextualPrompt
};
