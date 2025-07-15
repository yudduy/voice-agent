/**
 * A flexible utility for building model-agnostic prompt structures.
 */

/**
 * Creates a concise summary of conversation context
 * @param {Array<object>} history - Full conversation history
 * @returns {string} Summarized context
 */
function createContextSummary(history) {
  if (!history || history.length === 0) {
    return '';
  }

  // Extract key facts from conversation
  const facts = [];
  const userInputs = history.filter(msg => msg.role === 'user').map(msg => msg.content);
  
  // Detect if user has provided any personal information
  const hasName = userInputs.some(input => /my name is|i'm |i am /i.test(input));
  const hasComputer = userInputs.some(input => /computer|pc|laptop|desktop/i.test(input));
  const hasPayment = userInputs.some(input => /credit card|payment|buy|purchase|money/i.test(input));
  const isConfused = userInputs.some(input => /what|confused|don't understand|scam/i.test(input));
  const isCooperative = userInputs.some(input => /yes|okay|sure|help|virus/i.test(input));
  
  if (hasName) facts.push('User has provided their name');
  if (hasComputer) facts.push('User acknowledges having a computer');
  if (hasPayment) facts.push('Payment/credit card topic discussed');
  if (isConfused) facts.push('User expressed confusion or suspicion');
  if (isCooperative) facts.push('User has been cooperative');
  
  const turnCount = Math.floor(history.length / 2);
  facts.push(`Conversation has ${turnCount} exchanges`);
  
  return facts.length > 0 ? `[Context: ${facts.join(', ')}]` : '';
}

/**
 * Optimizes conversation history using sliding window with summarization
 * @param {Array<object>} history - Full conversation history
 * @param {number} maxRecentTurns - Number of recent turns to keep in full detail
 * @returns {Array<object>} Optimized history with summary
 */
function optimizeConversationHistory(history, maxRecentTurns = 6) {
  if (!history || history.length <= maxRecentTurns) {
    return history || [];
  }

  // Keep recent exchanges in full detail
  const recentHistory = history.slice(-maxRecentTurns);
  
  // Create summary of older context
  const olderHistory = history.slice(0, -maxRecentTurns);
  const contextSummary = createContextSummary(olderHistory);
  
  // If we have a summary, add it as a system message
  if (contextSummary) {
    return [
      { role: 'system', content: contextSummary },
      ...recentHistory
    ];
  }
  
  return recentHistory;
}

/**
 * Builds a message array suitable for OpenAI's Chat Completions API.
 *
 * This builder creates a clear separation between the permanent system instructions,
 * the dynamic conversation history, and any temporary, task-specific instructions.
 * It also optimizes context length for faster LLM processing.
 *
 * @param {string} systemMessage - The core identity and instructions for the AI (e.g., "You are a helpful assistant.").
 * @param {Array<object>} history - The conversation history, an array of objects with `role` and `content`.
 * @param {string} [taskMessage] - An optional, final user message containing specific instructions for the current turn.
 * @param {boolean} [optimizeContext=true] - Whether to apply context optimization
 * @returns {Array<object>} A structured message array for an LLM.
 */
function buildMessages(systemMessage, history, taskMessage, optimizeContext = true) {
  if (!systemMessage) {
    throw new Error('A systemMessage is required to build the prompt.');
  }

  const messages = [
    {
      role: 'system',
      content: systemMessage,
    },
  ];

  if (history && Array.isArray(history)) {
    // Apply context optimization if enabled
    const processedHistory = optimizeContext ? 
      optimizeConversationHistory(history) : 
      history;
    
    messages.push(...processedHistory);
  }

  if (taskMessage) {
    messages.push({
      role: 'user',
      content: taskMessage,
    });
  }

  return messages;
}

module.exports = {
  buildMessages,
  optimizeConversationHistory,
  createContextSummary,
}; 