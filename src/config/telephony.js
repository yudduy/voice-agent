/**
 * Twilio configuration for VERIES
 *
 * This file configures the Twilio client using credentials from environment variables.
 */
require('dotenv').config();

module.exports = {
  accountSid: process.env.TWILIO_ACCOUNT_SID,
  authToken: process.env.TWILIO_AUTH_TOKEN,
  phoneNumber: process.env.TWILIO_PHONE_NUMBER,
  webhookBaseUrl: process.env.WEBHOOK_BASE_URL,
  // Voice configuration
  voice: 'Polly.Joanna', // Amazon Polly voice
  language: 'en-US',
  speechTimeout: 'auto',
  speechModel: 'phone_call'
};
