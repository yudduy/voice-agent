/**
 * ElevenLabs WebSocket Streaming Service
 * Provides real-time text-to-speech streaming capabilities
 */

const WebSocket = require('ws');
const { EventEmitter } = require('events');
const logger = require('../utils/logger');
const aiConfig = require('../config/ai');

class ElevenLabsStreamService extends EventEmitter {
  constructor(voiceId = null) {
    super();
    this.voiceId = voiceId || aiConfig.elevenLabs.voiceId;
    this.ws = null;
    this.isConnected = false;
    this.streamId = null;
    this.audioChunksReceived = 0;
    this.textChunksSent = 0;
  }

  /**
   * Connect to ElevenLabs WebSocket streaming endpoint
   * @returns {Promise<void>}
   */
  async connect() {
    return new Promise((resolve, reject) => {
      const model = aiConfig.elevenLabs.defaultOptions.model_id || 'eleven_turbo_v2';
      const wsUrl = `wss://api.elevenlabs.io/v1/text-to-speech/${this.voiceId}/stream-input?model_id=${model}`;
      
      this.ws = new WebSocket(wsUrl, {
        headers: {
          'xi-api-key': aiConfig.elevenLabs.apiKey,
        }
      });

      this.ws.on('open', () => {
        this.isConnected = true;
        this.streamId = `elevenlabs-${Date.now()}`;
        logger.info('🎙️ [ElevenLabs] WebSocket connected', { 
          streamId: this.streamId,
          voiceId: this.voiceId,
          model: model
        });

        // Send initial configuration
        const voiceSettings = aiConfig.elevenLabs.defaultOptions.voice_settings || {};
        this.ws.send(JSON.stringify({
          text: " ",  // Initial silent chunk to establish stream
          voice_settings: {
            stability: voiceSettings.stability || 0.75,
            similarity_boost: voiceSettings.similarity_boost || 0.75,
            style: voiceSettings.style || 0.0,
            use_speaker_boost: voiceSettings.use_speaker_boost !== false
          },
          generation_config: {
            chunk_length_schedule: [50] // Return audio chunks ASAP
          }
        }));

        resolve();
      });

      this.ws.on('message', (data) => {
        try {
          const response = JSON.parse(data.toString());
          
          if (response.audio) {
            this.audioChunksReceived++;
            
            // Emit audio chunk as buffer for downstream processing
            const audioBuffer = Buffer.from(response.audio, 'base64');
            this.emit('audio', audioBuffer);
            
            logger.debug('🔊 [ElevenLabs] Audio chunk received', {
              streamId: this.streamId,
              chunkNumber: this.audioChunksReceived,
              audioSize: audioBuffer.length,
              isFinal: response.isFinal
            });
          }

          if (response.error) {
            logger.error('❌ [ElevenLabs] Stream error', {
              streamId: this.streamId,
              error: response.error
            });
            this.emit('error', new Error(response.error));
          }

          if (response.isFinal) {
            logger.info('✅ [ElevenLabs] Stream completed', {
              streamId: this.streamId,
              totalAudioChunks: this.audioChunksReceived,
              totalTextChunks: this.textChunksSent
            });
            this.emit('end');
          }
        } catch (error) {
          logger.error('❌ [ElevenLabs] Failed to parse message', {
            streamId: this.streamId,
            error: error.message
          });
        }
      });

      this.ws.on('error', (error) => {
        logger.error('❌ [ElevenLabs] WebSocket error', {
          streamId: this.streamId,
          error: error.message
        });
        this.emit('error', error);
        reject(error);
      });

      this.ws.on('close', (code, reason) => {
        this.isConnected = false;
        logger.info('🔌 [ElevenLabs] WebSocket closed', {
          streamId: this.streamId,
          code,
          reason: reason.toString(),
          stats: {
            audioChunksReceived: this.audioChunksReceived,
            textChunksSent: this.textChunksSent
          }
        });
        this.emit('close', code, reason);
      });

      // Timeout connection attempt
      setTimeout(() => {
        if (!this.isConnected) {
          reject(new Error('ElevenLabs WebSocket connection timeout'));
          this.close();
        }
      }, 5000);
    });
  }

  /**
   * Send text chunk to ElevenLabs for synthesis
   * @param {string} text - Text chunk to synthesize
   * @param {boolean} isFinal - Whether this is the final chunk
   */
  sendText(text, isFinal = false) {
    if (!this.isConnected || !this.ws) {
      logger.error('❌ [ElevenLabs] Cannot send text - not connected', {
        streamId: this.streamId
      });
      return false;
    }

    try {
      this.textChunksSent++;
      
      const message = {
        text: text,
        flush: isFinal // Force generation of any pending audio
      };

      if (isFinal) {
        message.text = text + " "; // Add space to ensure final chunk processes
      }

      this.ws.send(JSON.stringify(message));
      
      logger.debug('📝 [ElevenLabs] Text chunk sent', {
        streamId: this.streamId,
        chunkNumber: this.textChunksSent,
        textLength: text.length,
        isFinal,
        textPreview: text.substring(0, 50)
      });

      return true;
    } catch (error) {
      logger.error('❌ [ElevenLabs] Failed to send text', {
        streamId: this.streamId,
        error: error.message
      });
      this.emit('error', error);
      return false;
    }
  }

  /**
   * Close the WebSocket connection
   */
  close() {
    if (this.ws) {
      logger.info('🔌 [ElevenLabs] Closing WebSocket connection', {
        streamId: this.streamId
      });
      
      // Send final empty chunk to flush any pending audio
      if (this.isConnected) {
        try {
          this.ws.send(JSON.stringify({ text: "", flush: true }));
        } catch (error) {
          // Ignore errors during close
        }
      }

      this.ws.close();
      this.ws = null;
      this.isConnected = false;
    }
  }
}

/**
 * Factory function to create a new ElevenLabs streaming session
 * @param {string} voiceId - Optional voice ID override
 * @returns {ElevenLabsStreamService}
 */
function createElevenLabsStream(voiceId = null) {
  return new ElevenLabsStreamService(voiceId);
}

module.exports = {
  ElevenLabsStreamService,
  createElevenLabsStream
};