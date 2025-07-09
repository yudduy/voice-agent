/**
 * Streaming Voice Handler
 * Coordinates streaming STT → LLM → TTS pipeline for ultra-low latency
 */
const logger = require('../utils/logger');
const { createStreamingHandler } = require('./streamingConversation');
const { createTTSQueue } = require('./ttsQueue');
const conversationService = require('./conversation');
const cacheService = require('./cacheService');
const EventEmitter = require('events');

/**
 * StreamingVoiceHandler - Main coordinator for streaming voice pipeline
 */
class StreamingVoiceHandler extends EventEmitter {
  constructor(callSid) {
    super();
    this.callSid = callSid;
    this.userId = null;
    this.ttsQueue = null;
    this.streamingHandler = null;
    this.audioUrls = [];
    this.isProcessing = false;
    this.startTime = null;
    
    // Performance metrics
    this.metrics = {
      sttLatency: null,
      llmFirstChunkLatency: null,
      ttsFirstAudioLatency: null,
      totalLatency: null,
      perceivedLatency: null, // Time to first audio playback
      sentenceCount: 0,
      audioChunks: 0
    };
  }

  /**
   * Initialize the handler with user context
   * @param {string} userId - User ID from conversation mapping
   */
  async initialize(userId) {
    this.userId = userId;
    this.startTime = Date.now();
    
    // Create TTS queue with optimized settings
    this.ttsQueue = createTTSQueue({
      maxConcurrent: 3, // Process up to 3 TTS jobs in parallel
    });

    // Set up TTS queue event handlers
    this.ttsQueue.on('completed', (item) => {
      this.handleTTSCompletion(item);
    });

    this.ttsQueue.on('failed', (item) => {
      logger.error('[StreamingVoiceHandler] TTS generation failed', {
        callSid: this.callSid,
        itemId: item.id,
        error: item.error
      });
    });

    logger.info('[StreamingVoiceHandler] Initialized', {
      callSid: this.callSid,
      userId: this.userId
    });
  }

  /**
   * Process user input through the streaming pipeline
   * @param {string} userInput - Transcribed user speech
   * @param {number} sttLatency - STT processing time in ms
   * @returns {Promise<{audioUrls: Array, shouldHangup: boolean, metrics: object}>}
   */
  async processUserInput(userInput, sttLatency = null) {
    try {
      this.isProcessing = true;
      this.metrics.sttLatency = sttLatency;

      logger.info('[StreamingVoiceHandler] Starting streaming pipeline', {
        callSid: this.callSid,
        userId: this.userId,
        inputLength: userInput.length,
        sttLatency
      });

      // Create streaming conversation handler
      this.streamingHandler = createStreamingHandler(this.userId, this.callSid);

      // Set up streaming event handlers
      this.setupStreamingHandlers();

      // Start streaming LLM processing
      const streamPromise = this.streamingHandler.processStreamingResponse(userInput);

      // Wait for completion or timeout
      const result = await Promise.race([
        streamPromise,
        this.createTimeout(10000) // 10 second timeout
      ]);

      // Calculate final metrics
      this.calculateFinalMetrics();

      logger.info('[StreamingVoiceHandler] Pipeline completed', {
        callSid: this.callSid,
        userId: this.userId,
        audioUrlCount: this.audioUrls.length,
        metrics: this.metrics
      });

      return {
        audioUrls: this.audioUrls,
        shouldHangup: result.shouldHangup || false,
        metrics: this.metrics,
        fullResponse: result.fullResponse
      };

    } catch (error) {
      logger.error('[StreamingVoiceHandler] Pipeline error', {
        callSid: this.callSid,
        userId: this.userId,
        error: error.message,
        stack: error.stack
      });

      // Return fallback response
      return {
        audioUrls: [],
        shouldHangup: false,
        metrics: this.metrics,
        error: error.message
      };

    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Set up event handlers for streaming conversation
   */
  setupStreamingHandlers() {
    // Handle each sentence as it's detected
    this.streamingHandler.on('sentence', (data) => {
      this.handleSentence(data);
    });

    // Handle LLM stream completion
    this.streamingHandler.on('complete', (data) => {
      this.handleStreamComplete(data);
    });

    // Handle errors
    this.streamingHandler.on('error', (error) => {
      logger.error('[StreamingVoiceHandler] Streaming error', {
        callSid: this.callSid,
        error: error.message
      });
      this.emit('error', error);
    });
  }

  /**
   * Handle a detected sentence from the LLM stream
   * @param {object} data - Sentence data
   */
  handleSentence(data) {
    const { text, index, isFirst, isLast, timestamp } = data;

    logger.debug('[StreamingVoiceHandler] Sentence detected', {
      callSid: this.callSid,
      index,
      isFirst,
      textLength: text.length,
      preview: text.substring(0, 50) + '...'
    });

    // Track LLM first chunk latency
    if (isFirst && !this.metrics.llmFirstChunkLatency) {
      this.metrics.llmFirstChunkLatency = timestamp - this.startTime - (this.metrics.sttLatency || 0);
    }

    // Queue for TTS generation
    const itemId = this.ttsQueue.enqueue(text, {
      index,
      isFirst,
      isLast,
      priority: isFirst ? 4 : (index < 3 ? 3 : 2)
    });

    this.metrics.sentenceCount++;

    // Emit sentence event
    this.emit('sentence', {
      text,
      index,
      itemId,
      isFirst
    });
  }

  /**
   * Handle TTS completion
   * @param {object} item - Completed TTS item
   */
  handleTTSCompletion(item) {
    logger.debug('[StreamingVoiceHandler] TTS completed', {
      callSid: this.callSid,
      itemId: item.id,
      index: item.index,
      latency: item.latency,
      provider: item.provider
    });

    // Track first audio latency
    if (item.isFirst && !this.metrics.ttsFirstAudioLatency) {
      this.metrics.ttsFirstAudioLatency = Date.now() - this.startTime;
      this.metrics.perceivedLatency = this.metrics.ttsFirstAudioLatency;
    }

    // Add to audio URLs in order
    this.audioUrls[item.index] = item.audioUrl;
    this.metrics.audioChunks++;

    // Emit audio ready event
    this.emit('audioReady', {
      audioUrl: item.audioUrl,
      index: item.index,
      isFirst: item.isFirst,
      provider: item.provider
    });
  }

  /**
   * Handle LLM stream completion
   * @param {object} data - Stream completion data
   */
  handleStreamComplete(data) {
    logger.info('[StreamingVoiceHandler] LLM stream completed', {
      callSid: this.callSid,
      fullResponseLength: data.fullResponse.length,
      sentenceCount: this.metrics.sentenceCount,
      streamMetrics: data.metrics
    });

    // Wait for all TTS jobs to complete
    this.waitForTTSCompletion();
  }

  /**
   * Wait for all TTS jobs to complete
   */
  async waitForTTSCompletion() {
    const checkInterval = setInterval(() => {
      const status = this.ttsQueue.getStatus();
      
      if (status.pending === 0 && status.processing === 0) {
        clearInterval(checkInterval);
        
        // Clean up audio URLs array (remove any undefined entries)
        this.audioUrls = this.audioUrls.filter(url => url !== undefined);
        
        logger.info('[StreamingVoiceHandler] All TTS jobs completed', {
          callSid: this.callSid,
          totalAudioUrls: this.audioUrls.length,
          queueMetrics: status.metrics
        });

        this.emit('allAudioReady', {
          audioUrls: this.audioUrls,
          metrics: this.metrics
        });
      }
    }, 50);

    // Set a timeout to prevent infinite waiting
    setTimeout(() => {
      clearInterval(checkInterval);
      logger.warn('[StreamingVoiceHandler] TTS completion timeout', {
        callSid: this.callSid,
        status: this.ttsQueue.getStatus()
      });
    }, 5000);
  }

  /**
   * Calculate final performance metrics
   */
  calculateFinalMetrics() {
    this.metrics.totalLatency = Date.now() - this.startTime;
    
    // Get TTS queue metrics
    const ttsMetrics = this.ttsQueue.getStatus().metrics;
    this.metrics.ttsAverageLatency = ttsMetrics.averageLatency;
    this.metrics.ttsFirstSentenceLatency = ttsMetrics.firstSentenceLatency;

    // Calculate perceived latency (time to first audio)
    if (!this.metrics.perceivedLatency && this.metrics.ttsFirstAudioLatency) {
      this.metrics.perceivedLatency = this.metrics.ttsFirstAudioLatency;
    }

    logger.info('[StreamingVoiceHandler] Final metrics', {
      callSid: this.callSid,
      metrics: this.metrics
    });
  }

  /**
   * Create a timeout promise
   * @param {number} ms - Timeout in milliseconds
   * @returns {Promise}
   */
  createTimeout(ms) {
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        reject(new Error(`Pipeline timeout after ${ms}ms`));
      }, ms);
    });
  }

  /**
   * Clean up resources
   */
  cleanup() {
    if (this.ttsQueue) {
      this.ttsQueue.clear();
    }
    this.audioUrls = [];
    this.removeAllListeners();
  }
}

/**
 * Create a streaming voice handler for a call
 * @param {string} callSid - Twilio Call SID
 * @returns {StreamingVoiceHandler}
 */
const createStreamingVoiceHandler = (callSid) => {
  return new StreamingVoiceHandler(callSid);
};

/**
 * Check if streaming is enabled
 * @returns {boolean}
 */
const isStreamingEnabled = () => {
  return process.env.ENABLE_STREAMING === 'true';
};

module.exports = {
  createStreamingVoiceHandler,
  StreamingVoiceHandler,
  isStreamingEnabled
};