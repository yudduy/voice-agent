/**
 * Twilio Webhook Manager
 * Internal service for managing webhook configuration based on streaming mode
 */

const twilio = require('twilio');
const logger = require('../utils/logger');

class TwilioWebhookManager {
  constructor() {
    this.client = twilio(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN
    );
    this.phoneNumber = process.env.TWILIO_PHONE_NUMBER;
    this.baseUrl = process.env.WEBHOOK_BASE_URL || process.env.BASE_URL;
  }

  /**
   * Update webhooks based on streaming preference
   */
  async updateWebhooks(useStreaming = false) {
    try {
      logger.info('🔄 [Webhook Manager] Updating Twilio webhooks', { 
        phoneNumber: this.phoneNumber, 
        mode: useStreaming ? 'streaming' : 'batch',
        baseUrl: this.baseUrl 
      });

      // Find the phone number resource
      const phoneNumbers = await this.client.incomingPhoneNumbers.list({
        phoneNumber: this.phoneNumber
      });

      if (phoneNumbers.length === 0) {
        throw new Error(`Phone number ${this.phoneNumber} not found`);
      }

      const phoneNumberSid = phoneNumbers[0].sid;

      // Configure webhook URLs based on mode
      const voiceUrl = useStreaming 
        ? `${this.baseUrl}/api/media-stream/connect`
        : `${this.baseUrl}/api/calls/connect`;
      
      const statusCallback = useStreaming
        ? `${this.baseUrl}/api/media-stream/status`
        : `${this.baseUrl}/api/calls/status`;

      // Update the phone number configuration
      const updatedNumber = await this.client.incomingPhoneNumbers(phoneNumberSid)
        .update({
          voiceUrl: voiceUrl,
          voiceMethod: 'POST',
          statusCallback: statusCallback,
          statusCallbackMethod: 'POST',
          voiceFallbackUrl: `${this.baseUrl}/api/calls/connect`, // Always use batch as fallback
          voiceFallbackMethod: 'POST'
        });

      logger.info('✅ [Webhook Manager] Twilio webhooks updated successfully', {
        phoneNumber: updatedNumber.phoneNumber,
        voiceUrl: updatedNumber.voiceUrl,
        statusCallback: updatedNumber.statusCallback,
        mode: useStreaming ? 'streaming' : 'batch'
      });

      return {
        success: true,
        phoneNumber: updatedNumber.phoneNumber,
        voiceUrl: updatedNumber.voiceUrl,
        mode: useStreaming ? 'streaming' : 'batch'
      };

    } catch (error) {
      logger.error('❌ [Webhook Manager] Failed to update Twilio webhooks', { 
        error: error.message,
        stack: error.stack 
      });
      throw error;
    }
  }

  /**
   * Check current webhook configuration
   */
  async getCurrentConfig() {
    try {
      const phoneNumbers = await this.client.incomingPhoneNumbers.list({
        phoneNumber: this.phoneNumber
      });

      if (phoneNumbers.length === 0) {
        throw new Error(`Phone number ${this.phoneNumber} not found`);
      }

      const phoneNumber = phoneNumbers[0];
      const isStreaming = phoneNumber.voiceUrl && phoneNumber.voiceUrl.includes('/media-stream/');

      return {
        phoneNumber: phoneNumber.phoneNumber,
        voiceUrl: phoneNumber.voiceUrl,
        statusCallback: phoneNumber.statusCallback,
        mode: isStreaming ? 'streaming' : 'batch',
        isStreaming
      };

    } catch (error) {
      logger.error('❌ [Webhook Manager] Failed to get current config', { 
        error: error.message 
      });
      throw error;
    }
  }

  /**
   * Automatically configure webhooks based on environment
   */
  async autoConfigureWebhooks() {
    // Always use streaming when ENABLE_MEDIA_STREAMS is true
    const useStreaming = process.env.ENABLE_MEDIA_STREAMS === 'true';
    
    if (!useStreaming) {
      logger.warn('⚠️ [Webhook Manager] Media Streams disabled - using legacy batch processing');
      return null;
    }
    
    try {
      const currentConfig = await this.getCurrentConfig();
      
      // Always ensure streaming is configured when enabled
      if (!currentConfig.isStreaming) {
        logger.info('🔄 [Webhook Manager] Configuring webhooks for streaming mode', {
          current: currentConfig.mode,
          target: 'streaming'
        });
        
        return await this.updateWebhooks(true);
      } else {
        logger.info('✅ [Webhook Manager] Webhooks already configured for streaming', {
          voiceUrl: currentConfig.voiceUrl
        });
        return currentConfig;
      }
    } catch (error) {
      logger.error('❌ [Webhook Manager] Auto-configuration failed', { 
        error: error.message 
      });
      // Don't throw - allow app to start even if webhook update fails
      return null;
    }
  }
}

// Export singleton instance
module.exports = new TwilioWebhookManager();