/**
 * A flexible utility for building model-agnostic prompt structures.
 */

/**
 * Builds a message array suitable for OpenAI's Chat Completions API.
 *
 * This builder creates a clear separation between the permanent system instructions,
 * the dynamic conversation history, and any temporary, task-specific instructions.
 *
 * @param {string} systemMessage - The core identity and instructions for the AI (e.g., "You are a helpful assistant.").
 * @param {Array<object>} history - The conversation history, an array of objects with `role` and `content`.
 * @param {string} [taskMessage] - An optional, final user message containing specific instructions for the current turn.
 * @returns {Array<object>} A structured message array for an LLM.
 */
function buildMessages(systemMessage, history, taskMessage) {
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
    messages.push(...history);
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
}; 