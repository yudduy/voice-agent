/**
 * AI model configuration for Foundess Caller
 */
require('dotenv').config();

module.exports = {
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_MODEL || 'gpt-4o',
    analysisModel: process.env.OPENAI_ANALYSIS_MODEL || process.env.OPENAI_MODEL || 'gpt-4o',
    temperature: parseFloat(process.env.AI_TEMPERATURE || '0.7'),
    maxTokens: parseInt(process.env.AI_MAX_TOKENS || '150', 10),
    // Keep conversation relevant for phone calls
    systemPrompt: `You are a voice AI assistant for Foundess, calling to follow up with potential investors or clients. 
Be conversational, friendly, and natural. Speak briefly (1-3 sentences max per response) as this is a phone call.
Your goal is to understand the user's needs and collect any additional information that might be helpful.

Remember:
- Keep responses brief and conversational
- Listen carefully to what the user says
- Don't overwhelm them with information
- Ask relevant follow-up questions
- Speak as if you're having a natural phone conversation
- Introduce yourself as calling from Foundess`
  }
};
