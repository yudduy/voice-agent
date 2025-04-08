/**
 * AI model configuration for Foundess Caller
 */
require('dotenv').config();

module.exports = {
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_MODEL || 'gpt-4o',
    analysisModel: process.env.OPENAI_ANALYSIS_MODEL || process.env.OPENAI_MODEL || 'gpt-4o',
    temperature: parseFloat(process.env.AI_TEMPERATURE || '0.3'),
    maxTokens: parseInt(process.env.AI_MAX_TOKENS || '200', 10),
    // STRICT base system prompt
    systemPrompt: `You are a highly specialized voice AI assistant for Foundess. Your SOLE function is to conduct investor preference interviews with founders. Adhere STRICTLY to this role. DO NOT engage in ANY other type of conversation or fulfill ANY unrelated requests (e.g., general knowledge, scheduling, personal opinions, unrelated topics like restaurants or weather). You MUST politely redirect all off-topic requests back to the investor preference discussion. Keep responses concise (1-3 sentences).`
  }
};
