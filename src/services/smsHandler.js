const userRepository = require('../repositories/userRepository');
const historyRepository = require('../repositories/historyRepository');
const cacheService = require('../services/cacheService');
const { buildMessages } = require('../utils/promptBuilder');
const logger = require('../utils/logger');
const openai = require('../config/ai').openai;
const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const SMS_SYSTEM_PROMPT = "You are a friendly and helpful AI assistant. Keep your responses concise and conversational, suitable for SMS.";

/**
 * Handles an incoming SMS message payload from Twilio.
 * @param {object} twilioPayload - The parsed payload from Twilio's request body.
 */
async function handleIncomingSms(twilioPayload) {
  if (!twilioPayload || !twilioPayload.From || !twilioPayload.Body || !twilioPayload.MessageSid) {
    throw new Error('Invalid Twilio payload');
  }
  const { From: fromNumber, Body: messageContent, MessageSid: messageSid } = twilioPayload;

  // 1. Find or create a user
  let user = await userRepository.findUserByPhoneNumber(fromNumber);
  if (!user) {
    logger.info(`No user found for ${fromNumber}. Creating guest user.`);
    user = await userRepository.createGuestUserAndLinkPhone(fromNumber);
    // For a real application, you might send a different welcome/sign-up message here.
  }
  
  const userId = user.id;

  // 2. Log the incoming message
  await historyRepository.logSms({
    user_id: userId,
    phone_number: fromNumber,
    message_sid: messageSid,
    direction: 'inbound',
    content: messageContent,
  });

  // 3. Get conversation history from cache
  const history = await cacheService.getConversation(userId);

  // 4. Append the new message to the history for context
  const currentTurn = { role: 'user', content: messageContent };
  history.push(currentTurn);

  // 5. Generate the prompt and get a response from the LLM
  const messages = buildMessages(SMS_SYSTEM_PROMPT, history);
  
  let aiResponseContent;
  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: messages,
      max_tokens: 150,
    });
    aiResponseContent = completion.choices[0].message.content.trim();
  } catch (error) {
    logger.error('Error getting completion from OpenAI:', error);
    aiResponseContent = "Sorry, I'm having a little trouble right now. Please try again in a moment.";
  }

  // 6. Send the response back via Twilio
  const responseMessage = await twilio.messages.create({
    body: aiResponseContent,
    from: process.env.TWILIO_PHONE_NUMBER,
    to: fromNumber,
  });

  // 7. Log the outbound message
  await historyRepository.logSms({
    user_id: userId,
    phone_number: fromNumber,
    message_sid: responseMessage.sid,
    direction: 'outbound',
    content: aiResponseContent,
  });

  // 8. Update the cache with both turns
  await cacheService.appendConversation(userId, currentTurn);
  await cacheService.appendConversation(userId, { role: 'assistant', content: aiResponseContent });
  
  logger.info(`Sent SMS response to ${fromNumber}.`);
}


module.exports = {
  handleIncomingSms,
}; 