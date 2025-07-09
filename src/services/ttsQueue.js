/**
 * TTS Queue Management System
 * Handles prioritized, parallel TTS generation with sequential playback
 */
const logger = require('../utils/logger');
const textToSpeech = require('./textToSpeech');
const EventEmitter = require('events');
const crypto = require('crypto');

/**
 * Priority levels for TTS generation
 */
const PRIORITY_LEVELS = {
  BACKCHANNEL: 5,     // Highest priority for backchannels
  ULTRA_HIGH: 4,      // First sentence of response
  HIGH: 3,            // Early sentences
  NORMAL: 2,          // Middle sentences
  LOW: 1              // Later sentences
};

/**
 * TTSQueueItem - Represents a single TTS job
 */
class TTSQueueItem {
  constructor(text, options = {}) {
    this.id = crypto.randomBytes(8).toString('hex');
    this.text = text;
    this.priority = options.priority || PRIORITY_LEVELS.NORMAL;
    this.index = options.index || 0;
    this.isFirst = options.isFirst || false;
    this.isLast = options.isLast || false;
    this.isBackchannel = options.isBackchannel || false;
    this.backchannelType = options.backchannelType || null;
    this.status = 'pending'; // pending, processing, completed, failed
    this.audioUrl = null;
    this.error = null;
    this.createdAt = Date.now();
    this.startedAt = null;
    this.completedAt = null;
    this.retryCount = 0;
    this.maxRetries = options.maxRetries || 2;
    this.provider = options.provider || 'elevenlabs'; // elevenlabs, hyperbolic, twilio
    this.conflictAvoidance = options.conflictAvoidance || false;
  }

  get latency() {
    if (!this.completedAt || !this.startedAt) return null;
    return this.completedAt - this.startedAt;
  }

  get totalLatency() {
    if (!this.completedAt) return null;
    return this.completedAt - this.createdAt;
  }
}

/**
 * TTSQueue - Manages parallel TTS generation with prioritization
 */
class TTSQueue extends EventEmitter {
  constructor(options = {}) {
    super();
    this.queue = [];
    this.processing = new Map(); // id -> TTSQueueItem
    this.completed = new Map(); // id -> TTSQueueItem
    this.failed = new Map(); // id -> TTSQueueItem
    
    this.maxConcurrent = options.maxConcurrent || 3;
    this.isProcessing = false;
    
    // Metrics
    this.metrics = {
      totalQueued: 0,
      totalProcessed: 0,
      totalFailed: 0,
      averageLatency: 0,
      firstSentenceLatency: null
    };

    // Provider-specific configurations
    this.providerConfig = {
      elevenlabs: {
        chunkThreshold: 2500,
        useFlash: true, // Use Flash v2.5 for ultra-low latency
        priority: 1
      },
      hyperbolic: {
        chunkThreshold: 150,
        priority: 2
      },
      twilio: {
        priority: 3 // Fallback
      }
    };
  }

  /**
   * Add text to the queue for TTS generation
   * @param {string} text - Text to synthesize
   * @param {object} options - Queue options
   * @returns {string} - Queue item ID
   */
  enqueue(text, options = {}) {
    // Determine priority based on position and type
    if (options.isBackchannel) {
      options.priority = PRIORITY_LEVELS.BACKCHANNEL;
    } else if (options.isFirst) {
      options.priority = PRIORITY_LEVELS.ULTRA_HIGH;
    } else if (options.index < 3) {
      options.priority = PRIORITY_LEVELS.HIGH;
    }

    const item = new TTSQueueItem(text, options);
    
    // Special handling for backchannels
    if (item.isBackchannel) {
      return this.enqueueBackchannel(item);
    }
    
    // Insert into queue based on priority
    const insertIndex = this.queue.findIndex(q => q.priority < item.priority);
    if (insertIndex === -1) {
      this.queue.push(item);
    } else {
      this.queue.splice(insertIndex, 0, item);
    }

    this.metrics.totalQueued++;

    logger.debug('[TTSQueue] Item enqueued', {
      id: item.id,
      priority: item.priority,
      index: item.index,
      isFirst: item.isFirst,
      isBackchannel: item.isBackchannel,
      textLength: text.length,
      queueLength: this.queue.length
    });

    // Emit enqueue event
    this.emit('enqueued', item);

    // Start processing if not already running
    if (!this.isProcessing) {
      this.process();
    }

    return item.id;
  }

  /**
   * Enqueue a backchannel with conflict avoidance
   * @param {TTSQueueItem} item - Backchannel item
   * @returns {string} - Queue item ID
   */
  enqueueBackchannel(item) {
    // Check for conflicts with active processing
    if (this.hasResponseConflict()) {
      logger.debug('[TTSQueue] Backchannel conflict detected, skipping', {
        id: item.id,
        text: item.text
      });
      
      // Emit conflict event
      this.emit('backchannelConflict', {
        item,
        reason: 'Active response processing'
      });
      
      return null;
    }

    // Add to front of queue with highest priority
    this.queue.unshift(item);
    this.metrics.totalQueued++;

    logger.debug('[TTSQueue] Backchannel enqueued', {
      id: item.id,
      type: item.backchannelType,
      text: item.text,
      queueLength: this.queue.length
    });

    // Emit backchannel enqueue event
    this.emit('backchannelEnqueued', item);

    // Start processing immediately
    if (!this.isProcessing) {
      this.process();
    }

    return item.id;
  }

  /**
   * Check for conflicts with active responses
   * @returns {boolean} - Has conflict
   */
  hasResponseConflict() {
    // Check if any active items are first sentences or high priority responses
    for (const [id, item] of this.processing.entries()) {
      if (item.isFirst || item.priority >= PRIORITY_LEVELS.ULTRA_HIGH) {
        return true;
      }
    }
    
    // Check if any queued items are first sentences
    const hasHighPriorityQueued = this.queue.some(item => 
      item.isFirst || item.priority >= PRIORITY_LEVELS.ULTRA_HIGH
    );
    
    return hasHighPriorityQueued;
  }

  /**
   * Process the queue
   */
  async process() {
    if (this.isProcessing) return;
    this.isProcessing = true;

    while (this.queue.length > 0 || this.processing.size > 0) {
      // Process up to maxConcurrent items
      while (this.queue.length > 0 && this.processing.size < this.maxConcurrent) {
        const item = this.queue.shift();
        this.processing.set(item.id, item);
        
        // Process item asynchronously (don't await here)
        this.processItem(item).catch(error => {
          logger.error('[TTSQueue] Error processing item', {
            id: item.id,
            error: error.message
          });
        });
      }

      // Wait a bit before checking again
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    this.isProcessing = false;
    this.emit('idle');
  }

  /**
   * Process a single TTS item
   * @param {TTSQueueItem} item - Item to process
   */
  async processItem(item) {
    try {
      item.status = 'processing';
      item.startedAt = Date.now();

      logger.debug('[TTSQueue] Processing item', {
        id: item.id,
        priority: item.priority,
        provider: item.provider,
        textLength: item.text.length
      });

      // Generate audio based on provider preference
      let audioUrl = null;
      let lastError = null;

      // Try providers in order of preference
      const providers = this.getProviderOrder(item);
      
      for (const provider of providers) {
        try {
          audioUrl = await this.generateWithProvider(item.text, provider, item);
          if (audioUrl) {
            item.provider = provider;
            break;
          }
        } catch (error) {
          lastError = error;
          logger.warn(`[TTSQueue] Provider ${provider} failed`, {
            id: item.id,
            error: error.message
          });
        }
      }

      if (!audioUrl) {
        throw lastError || new Error('All TTS providers failed');
      }

      // Mark as completed
      item.status = 'completed';
      item.audioUrl = audioUrl;
      item.completedAt = Date.now();

      // Move to completed
      this.processing.delete(item.id);
      this.completed.set(item.id, item);

      // Update metrics
      this.updateMetrics(item);

      logger.info('[TTSQueue] Item completed', {
        id: item.id,
        provider: item.provider,
        latency: item.latency,
        totalLatency: item.totalLatency,
        audioUrl: audioUrl
      });

      // Emit completion event
      this.emit('completed', item);

    } catch (error) {
      item.status = 'failed';
      item.error = error.message;
      item.completedAt = Date.now();

      // Move to failed
      this.processing.delete(item.id);
      
      // Retry logic
      if (item.retryCount < item.maxRetries) {
        item.retryCount++;
        item.status = 'pending';
        item.error = null;
        
        // Re-queue with slightly lower priority
        item.priority = Math.max(1, item.priority - 1);
        this.queue.unshift(item);
        
        logger.warn('[TTSQueue] Item failed, retrying', {
          id: item.id,
          retryCount: item.retryCount,
          error: error.message
        });
      } else {
        this.failed.set(item.id, item);
        this.metrics.totalFailed++;
        
        logger.error('[TTSQueue] Item failed permanently', {
          id: item.id,
          error: error.message
        });

        // Emit failure event
        this.emit('failed', item);
      }
    }
  }

  /**
   * Generate audio with a specific provider
   * @param {string} text - Text to synthesize
   * @param {string} provider - Provider name
   * @param {TTSQueueItem} item - Queue item for context
   * @returns {Promise<string>} - Audio URL
   */
  async generateWithProvider(text, provider, item) {
    switch (provider) {
      case 'elevenlabs':
        // Use ElevenLabs Flash for first sentence, regular for others
        const useFlash = item.isFirst || item.priority >= PRIORITY_LEVELS.HIGH;
        return await textToSpeech.generateElevenLabsAudio(text, {
          useFlash,
          priority: item.priority
        });

      case 'hyperbolic':
        return await textToSpeech.generateHyperbolicAudio(text, {
          priority: item.priority
        });

      case 'twilio':
        // Twilio returns TwiML, not audio URL
        return 'twilio:' + text; // Special marker for Twilio fallback

      default:
        throw new Error(`Unknown provider: ${provider}`);
    }
  }

  /**
   * Get provider order based on item priority and configuration
   * @param {TTSQueueItem} item - Queue item
   * @returns {Array<string>} - Ordered list of providers to try
   */
  getProviderOrder(item) {
    if (item.isFirst) {
      // For first sentence, prioritize speed
      return ['elevenlabs', 'hyperbolic', 'twilio'];
    }
    
    // For other sentences, use configured preference
    const preference = process.env.TTS_PREFERENCE || 'elevenlabs';
    const providers = ['elevenlabs', 'hyperbolic', 'twilio'];
    
    // Move preferred provider to front
    const index = providers.indexOf(preference);
    if (index > 0) {
      providers.splice(index, 1);
      providers.unshift(preference);
    }
    
    return providers;
  }

  /**
   * Update queue metrics
   * @param {TTSQueueItem} item - Completed item
   */
  updateMetrics(item) {
    this.metrics.totalProcessed++;
    
    // Update average latency
    const prevAvg = this.metrics.averageLatency || 0;
    const count = this.metrics.totalProcessed;
    this.metrics.averageLatency = ((prevAvg * (count - 1)) + item.latency) / count;
    
    // Track first sentence latency
    if (item.isFirst && !this.metrics.firstSentenceLatency) {
      this.metrics.firstSentenceLatency = item.totalLatency;
    }
  }

  /**
   * Get audio URLs in order for playback
   * @returns {Array<{id: string, audioUrl: string, index: number}>}
   */
  getCompletedInOrder() {
    const completed = Array.from(this.completed.values());
    completed.sort((a, b) => a.index - b.index);
    
    return completed.map(item => ({
      id: item.id,
      audioUrl: item.audioUrl,
      index: item.index,
      provider: item.provider
    }));
  }

  /**
   * Get current queue status
   * @returns {object}
   */
  getStatus() {
    return {
      pending: this.queue.length,
      processing: this.processing.size,
      completed: this.completed.size,
      failed: this.failed.size,
      metrics: this.metrics,
      isProcessing: this.isProcessing
    };
  }

  /**
   * Clear the queue and reset
   */
  clear() {
    this.queue = [];
    this.processing.clear();
    this.completed.clear();
    this.failed.clear();
    this.isProcessing = false;
    
    // Reset metrics
    this.metrics = {
      totalQueued: 0,
      totalProcessed: 0,
      totalFailed: 0,
      averageLatency: 0,
      firstSentenceLatency: null
    };
    
    this.emit('cleared');
  }
}

/**
 * Factory function to create TTS queue
 * @param {object} options - Queue options
 * @returns {TTSQueue}
 */
const createTTSQueue = (options = {}) => {
  return new TTSQueue(options);
};

module.exports = {
  createTTSQueue,
  TTSQueue,
  TTSQueueItem,
  PRIORITY_LEVELS
};