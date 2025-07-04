/**
 * SMS Handler with User Onboarding Support
 * File: src/services/smsHandler.js
 */

const supabase = require('../config/supabase');
const cacheService = require('./cacheService');
const { buildMessages } = require('../utils/promptBuilder');
const logger = require('../utils/logger');
const openai = require('../config/ai').openai;
const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const SMS_SYSTEM_PROMPT = "You are VERIES, a friendly and helpful AI assistant. Keep your responses concise and conversational, suitable for SMS. Use the user's name when appropriate to personalize the conversation.";

/**
 * Main SMS webhook handler with onboarding support
 */
async function handleIncomingSms(twilioPayload) {
  if (!twilioPayload || !twilioPayload.From || !twilioPayload.Body || !twilioPayload.MessageSid) {
    throw new Error('Invalid Twilio payload');
  }
  
  const { From: fromNumber, Body: messageContent, MessageSid: messageSid } = twilioPayload;
  logger.info(`Received SMS from ${fromNumber}: "${messageContent}"`);

  try {
    // Find user by phone number with profile data
    const { data: phoneLink, error: phoneError } = await supabase
      .from('phone_links')
      .select(`
        *,
        user_profiles!inner(*)
      `)
      .eq('phone_number', fromNumber)
      .single();

    if (phoneError || !phoneLink) {
      await handleUnknownNumber(fromNumber, messageContent, messageSid);
      return;
    }

    const userProfile = phoneLink.user_profiles;
    logger.info(`SMS from known user: ${userProfile.first_name} ${userProfile.last_name} (${userProfile.onboarding_status})`);

    // Route based on onboarding status
    switch (userProfile.onboarding_status) {
      case 'sms_sent':
        await handleOnboardingResponse(phoneLink, userProfile, messageContent, messageSid);
        break;
      case 'completed':
        await handleRegularConversation(phoneLink, userProfile, messageContent, messageSid);
        break;
      case 'pending':
      case 'failed':
        await handlePendingUser(phoneLink, userProfile, messageContent, messageSid);
        break;
      default:
        logger.warn(`Unknown onboarding status: ${userProfile.onboarding_status}`);
        await handleRegularConversation(phoneLink, userProfile, messageContent, messageSid);
    }

  } catch (error) {
    logger.error('Error in handleIncomingSms:', error);
    await sendErrorResponse(fromNumber);
  }
}

/**
 * Handle SMS from unknown phone numbers
 */
async function handleUnknownNumber(phoneNumber, messageContent, messageSid) {
  logger.info(`SMS from unknown number: ${phoneNumber}`);
  
  const responseMessage = "Hi! 👋 To use VERIES, please sign up at our website first. Once you create an account with this phone number, I'll be ready to assist you!";
  
  await sendSmsResponse(phoneNumber, responseMessage);
  
  // Log the interaction for analytics
  await logUnknownNumberInteraction(phoneNumber, messageContent, messageSid);
}

/**
 * Handle first response after onboarding SMS was sent
 */
async function handleOnboardingResponse(phoneLink, userProfile, messageContent, messageSid) {
  logger.info(`Processing onboarding response from ${userProfile.first_name} ${userProfile.last_name}`);
  
  try {
    // Complete the onboarding process
    const { error: completeError } = await supabase
      .rpc('complete_user_onboarding', { p_user_id: userProfile.user_id });
    
    if (completeError) {
      logger.error('Error completing onboarding:', completeError);
      throw completeError;
    }

    // Log the SMS that completed onboarding
    await logSmsHistory({
      user_id: userProfile.user_id,
      phone_number: phoneLink.phone_number,
      message_sid: messageSid,
      direction: 'inbound',
      content: messageContent,
    });

    // Send personalized welcome message
    const welcomeMessage = `Hi ${userProfile.first_name}! 🎉 Welcome to VERIES! I'm your AI assistant and I'm excited to help you.`;
    let followUpMessage;

    // Check if user's first message was a greeting or question
    if (isGreeting(messageContent)) {
      followUpMessage = `What can I help you with today? You can ask me questions, have a conversation, or just say what's on your mind!`;
    } else {
      // User asked a question right away - answer it
      followUpMessage = await generateAiResponse(messageContent, userProfile, []);
    }

    // Send welcome message
    await sendSmsResponse(phoneLink.phone_number, welcomeMessage);
    
    // Send follow-up message
    await sendSmsResponse(phoneLink.phone_number, followUpMessage);

    // Initialize conversation cache if answering a question
    if (!isGreeting(messageContent)) {
      const conversation = [
        { role: 'user', content: messageContent },
        { role: 'assistant', content: followUpMessage }
      ];
      await cacheService.setConversation(userProfile.user_id, conversation);
    }

    logger.info(`Onboarding completed for user: ${userProfile.first_name} ${userProfile.last_name}`);
    
  } catch (error) {
    logger.error('Error in handleOnboardingResponse:', error);
    await sendErrorResponse(phoneLink.phone_number);
  }
}

/**
 * Handle regular conversation for fully onboarded users
 */
async function handleRegularConversation(phoneLink, userProfile, messageContent, messageSid) {
  logger.info(`Processing regular conversation for ${userProfile.first_name} ${userProfile.last_name}`);
  
  try {
    // Log incoming message
    await logSmsHistory({
      user_id: userProfile.user_id,
      phone_number: phoneLink.phone_number,
      message_sid: messageSid,
      direction: 'inbound',
      content: messageContent,
    });

    // Get conversation history
    const history = await cacheService.getConversation(userProfile.user_id);
    
    // Generate AI response with user context
    const aiResponse = await generateAiResponse(messageContent, userProfile, history);
    
    // Send response
    const responseMessage = await sendSmsResponse(phoneLink.phone_number, aiResponse);
    
    // Update conversation cache
    await cacheService.appendConversation(userProfile.user_id, { role: 'user', content: messageContent });
    await cacheService.appendConversation(userProfile.user_id, { role: 'assistant', content: aiResponse });

    // Log outbound message
    await logSmsHistory({
      user_id: userProfile.user_id,
      phone_number: phoneLink.phone_number,
      message_sid: responseMessage.sid,
      direction: 'outbound',
      content: aiResponse,
    });

  } catch (error) {
    logger.error('Error in handleRegularConversation:', error);
    await sendErrorResponse(phoneLink.phone_number);
  }
}

/**
 * Handle users who haven't completed onboarding yet
 */
async function handlePendingUser(phoneLink, userProfile, messageContent, messageSid) {
  logger.info(`SMS from pending user: ${userProfile.first_name} ${userProfile.last_name}`);
  
  const message = `Hi ${userProfile.first_name}! I see you've signed up for VERIES. Let me send you a proper welcome message to get started!`;
  
  await sendSmsResponse(phoneLink.phone_number, message);
  
  // Trigger onboarding SMS (update status to trigger the flow)
  await supabase
    .from('user_profiles')
    .update({ 
      onboarding_status: 'pending',
      updated_at: new Date().toISOString() 
    })
    .eq('user_id', userProfile.user_id);
  
  // Process pending onboarding messages
  await processOnboardingQueue();
}

/**
 * Generate AI response with user context
 */
async function generateAiResponse(messageContent, userProfile, conversationHistory) {
  try {
    // Build context-aware system prompt
    const contextualPrompt = `${SMS_SYSTEM_PROMPT}\n\nUser Context:\n- Name: ${userProfile.first_name} ${userProfile.last_name}\n- Location: ${userProfile.location || 'Unknown'}\n\nProvide helpful, personalized responses based on this context.`;
    
    // Prepare conversation with user context
    const currentTurn = { role: 'user', content: messageContent };
    const history = [...conversationHistory, currentTurn];
    const messages = buildMessages(contextualPrompt, history);
    
    const completion = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: messages,
      max_tokens: 150,
      temperature: 0.7,
    });
    
    return completion.choices[0].message.content.trim();
    
  } catch (error) {
    logger.error('Error generating AI response:', error);
    return `Hi ${userProfile.first_name}! I'm having a little trouble processing your message right now. Please try again in a moment.`;
  }
}

/**
 * Send SMS response and return Twilio message object
 */
async function sendSmsResponse(phoneNumber, content) {
  const message = await twilio.messages.create({
    body: content,
    from: process.env.TWILIO_PHONE_NUMBER,
    to: phoneNumber,
  });
  
  logger.info(`SMS sent to ${phoneNumber}: "${content}"`);
  return message;
}

/**
 * Send error response to user
 */
async function sendErrorResponse(phoneNumber) {
  const errorMessage = "Sorry, I'm experiencing some technical difficulties. Please try again later!";
  await sendSmsResponse(phoneNumber, errorMessage);
}

/**
 * Log SMS history to database
 */
async function logSmsHistory(smsData) {
  try {
    const { error } = await supabase
      .from('sms_history')
      .insert(smsData);
    
    if (error) {
      logger.error('Error logging SMS history:', error);
    }
  } catch (error) {
    logger.error('Error in logSmsHistory:', error);
  }
}

/**
 * Log interaction from unknown numbers for analytics
 */
async function logUnknownNumberInteraction(phoneNumber, content, messageSid) {
  try {
    // Could be stored in a separate table for analytics
    logger.info(`Unknown number interaction logged: ${phoneNumber}`);
  } catch (error) {
    logger.error('Error logging unknown number interaction:', error);
  }
}

/**
 * Check if message is a greeting
 */
function isGreeting(message) {
  const greetings = ['hi', 'hello', 'hey', 'start', 'begin', 'yes', 'ok'];
  const normalizedMessage = message.toLowerCase().trim();
  return greetings.some(greeting => normalizedMessage.includes(greeting));
}

/**
 * Process pending onboarding messages (call this periodically or on-demand)
 */
async function processOnboardingQueue() {
  try {
    logger.info('Processing onboarding queue...');
    
    const { data: pendingMessages, error } = await supabase
      .rpc('get_pending_onboarding_messages', { limit_count: 10 });
    
    if (error) {
      logger.error('Error fetching pending onboarding messages:', error);
      return;
    }
    
    if (!pendingMessages || pendingMessages.length === 0) {
      logger.info('No pending onboarding messages found');
      return;
    }
    
    logger.info(`Found ${pendingMessages.length} pending onboarding messages`);
    
    for (const message of pendingMessages) {
      await sendOnboardingMessage(message);
      // Add small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
  } catch (error) {
    logger.error('Error in processOnboardingQueue:', error);
  }
}

/**
 * Send individual onboarding message
 */
async function sendOnboardingMessage(onboardingMessage) {
  try {
    logger.info(`Sending onboarding SMS to ${onboardingMessage.user_first_name} ${onboardingMessage.user_last_name} (${onboardingMessage.phone_number})`);
    
    const twilioMessage = await twilio.messages.create({
      body: onboardingMessage.message_content,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: onboardingMessage.phone_number
    });

    // Update message status to sent
    await supabase
      .from('onboarding_messages')
      .update({ 
        status: 'sent', 
        message_sid: twilioMessage.sid,
        sent_at: new Date().toISOString()
      })
      .eq('id', onboardingMessage.message_id);

    // Update user profile onboarding status
    await supabase
      .from('user_profiles')
      .update({ 
        onboarding_status: 'sms_sent',
        onboarding_sent_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('user_id', onboardingMessage.user_id);

    logger.info(`Onboarding SMS sent successfully to ${onboardingMessage.user_first_name} ${onboardingMessage.user_last_name}`);

  } catch (error) {
    logger.error(`Failed to send onboarding SMS to ${onboardingMessage.user_first_name} ${onboardingMessage.user_last_name}:`, error);
    
    // Mark message as failed
    await supabase
      .from('onboarding_messages')
      .update({ 
        status: 'failed',
        error_message: error.message
      })
      .eq('id', onboardingMessage.message_id);
  }
}

module.exports = {
  handleIncomingSms,
  processOnboardingQueue,
  sendOnboardingMessage
};