/**
 * Pipeline Coordinator
 * Advanced coordination for ultra-low latency voice pipeline
 * Manages predictive processing and smart buffering
 */
const logger = require('../utils/logger');
const Redis = require('ioredis');
const EventEmitter = require('events');
const { performance } = require('perf_hooks');

/**
 * Advanced Pipeline Coordinator
 * Uses Redis Streams for message queue coordination
 * Implements predictive audio generation and smart buffering
 */
class PipelineCoordinator extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.callSid = options.callSid;
    this.userId = options.userId;
    
    // Redis Streams configuration
    this.redis = new Redis({
      host: process.env.UPSTASH_REDIS_REST_URL?.replace('redis://', '').replace('https://', ''),
      port: 6379,
      retryDelayOnFailover: 100,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 3
    });
    
    // Pipeline stages
    this.stages = {
      STT: 'stt',
      LLM: 'llm', 
      TTS: 'tts',
      AUDIO: 'audio'
    };
    
    // Stream names for Redis
    this.streamNames = {
      [this.stages.STT]: `pipeline:${this.callSid}:stt`,
      [this.stages.LLM]: `pipeline:${this.callSid}:llm`,
      [this.stages.TTS]: `pipeline:${this.callSid}:tts`,
      [this.stages.AUDIO]: `pipeline:${this.callSid}:audio`
    };
    
    // Consumer groups
    this.consumerGroups = {
      [this.stages.STT]: 'stt-processors',
      [this.stages.LLM]: 'llm-processors',
      [this.stages.TTS]: 'tts-processors',
      [this.stages.AUDIO]: 'audio-processors'
    };
    
    // Pipeline state
    this.state = {
      isActive: false,
      currentTurn: 0,
      pendingProcesses: new Map(),
      completedProcesses: new Map(),
      metrics: {
        totalLatency: 0,
        stageLatencies: {},
        throughput: 0,
        errors: 0
      }
    };
    
    // Predictive processing
    this.predictiveBuffer = new Map();
    this.commonPhrases = new Map();
    this.contextPredictions = new Map();
    
    // Smart buffering
    this.bufferConfig = {
      maxBufferSize: 10,
      prerollMs: 200,
      postrollMs: 100,
      vadThreshold: 0.6
    };
  }

  /**
   * Initialize the pipeline coordinator
   */
  async initialize() {
    try {
      logger.info('[PipelineCoordinator] Initializing', { callSid: this.callSid });
      
      // Create consumer groups for each stage
      for (const [stage, streamName] of Object.entries(this.streamNames)) {
        try {
          await this.redis.xgroup('CREATE', streamName, this.consumerGroups[stage], '$', 'MKSTREAM');
        } catch (error) {
          if (!error.message.includes('BUSYGROUP')) {
            logger.warn(`[PipelineCoordinator] Failed to create consumer group for ${stage}`, { error: error.message });
          }
        }
      }
      
      // Start stream consumers
      this.startStreamConsumers();
      
      // Load predictive models
      await this.loadPredictiveModels();
      
      this.state.isActive = true;
      logger.info('[PipelineCoordinator] Initialized successfully');
      
    } catch (error) {
      logger.error('[PipelineCoordinator] Initialization failed', { error: error.message });
      throw error;
    }
  }

  /**
   * Process audio input through the pipeline
   * @param {ArrayBuffer} audioData - Audio data
   * @param {number} timestamp - Timestamp
   * @returns {Promise<string>} - Process ID
   */
  async processAudioInput(audioData, timestamp) {
    const processId = `${this.callSid}_${++this.state.currentTurn}_${Date.now()}`;
    const startTime = performance.now();
    
    logger.debug('[PipelineCoordinator] Starting audio processing', {
      callSid: this.callSid,
      processId,
      audioSize: audioData.byteLength
    });
    
    // Store process metadata
    this.state.pendingProcesses.set(processId, {
      id: processId,
      startTime,
      audioData,
      timestamp,
      stages: {
        [this.stages.STT]: { status: 'pending', startTime: null, endTime: null },
        [this.stages.LLM]: { status: 'pending', startTime: null, endTime: null },
        [this.stages.TTS]: { status: 'pending', startTime: null, endTime: null },
        [this.stages.AUDIO]: { status: 'pending', startTime: null, endTime: null }
      }
    });
    
    // Add to STT stream
    await this.redis.xadd(
      this.streamNames[this.stages.STT],
      '*',
      'processId', processId,
      'audioData', Buffer.from(audioData).toString('base64'),
      'timestamp', timestamp,
      'stage', this.stages.STT
    );
    
    // Start predictive processing
    this.startPredictiveProcessing(processId);
    
    return processId;
  }

  /**
   * Start predictive processing based on context
   * @param {string} processId - Process ID
   */
  startPredictiveProcessing(processId) {
    const process = this.state.pendingProcesses.get(processId);
    if (!process) return;
    
    // Predict likely responses based on conversation context
    const predictions = this.getPredictedResponses();
    
    // Pre-generate TTS for most likely responses
    predictions.forEach(async (prediction, index) => {
      if (prediction.confidence > 0.7) {
        const cacheKey = `predictive:${this.callSid}:${prediction.hash}`;
        
        if (!this.predictiveBuffer.has(cacheKey)) {
          logger.debug('[PipelineCoordinator] Pre-generating TTS for prediction', {
            processId,
            prediction: prediction.text.substring(0, 50),
            confidence: prediction.confidence
          });
          
          // Generate TTS in background
          this.generatePredictiveTTS(prediction.text, cacheKey);
        }
      }
    });
  }

  /**
   * Generate predictive TTS
   * @param {string} text - Text to generate
   * @param {string} cacheKey - Cache key
   */
  async generatePredictiveTTS(text, cacheKey) {
    try {
      const textToSpeech = require('./textToSpeech');
      const audioUrl = await textToSpeech.generateElevenLabsAudio(text, {
        priority: 'low',
        cache: true
      });
      
      if (audioUrl) {
        this.predictiveBuffer.set(cacheKey, {
          text,
          audioUrl,
          timestamp: Date.now(),
          used: false
        });
        
        // Clean up old predictions
        this.cleanupPredictiveBuffer();
      }
    } catch (error) {
      logger.error('[PipelineCoordinator] Predictive TTS generation failed', {
        text: text.substring(0, 50),
        error: error.message
      });
    }
  }

  /**
   * Get predicted responses based on conversation context
   * @returns {Array<object>} - Predicted responses
   */
  getPredictedResponses() {
    // In a real implementation, this would use ML models
    // For now, return common responses based on context
    return [
      { text: "I understand. Let me help you with that.", confidence: 0.8, hash: 'help_response' },
      { text: "Could you please provide more details?", confidence: 0.7, hash: 'details_request' },
      { text: "Thank you for that information.", confidence: 0.6, hash: 'acknowledgment' },
      { text: "I'm not sure I understand. Could you clarify?", confidence: 0.5, hash: 'clarification' }
    ];
  }

  /**
   * Start stream consumers for each pipeline stage
   */
  startStreamConsumers() {
    // STT Consumer
    this.startConsumer(this.stages.STT, async (message) => {
      await this.processSTTMessage(message);
    });
    
    // LLM Consumer  
    this.startConsumer(this.stages.LLM, async (message) => {
      await this.processLLMMessage(message);
    });
    
    // TTS Consumer
    this.startConsumer(this.stages.TTS, async (message) => {
      await this.processTTSMessage(message);
    });
    
    // Audio Consumer
    this.startConsumer(this.stages.AUDIO, async (message) => {
      await this.processAudioMessage(message);
    });
  }

  /**
   * Start a consumer for a specific stage
   * @param {string} stage - Pipeline stage
   * @param {Function} processor - Message processor function
   */
  startConsumer(stage, processor) {
    const streamName = this.streamNames[stage];
    const consumerGroup = this.consumerGroups[stage];
    const consumerName = `${stage}-${process.pid}`;
    
    const consumeMessages = async () => {
      try {
        const messages = await this.redis.xreadgroup(
          'GROUP', consumerGroup, consumerName,
          'COUNT', 10,
          'BLOCK', 100,
          'STREAMS', streamName, '>'
        );
        
        if (messages && messages.length > 0) {
          for (const [stream, streamMessages] of messages) {
            for (const [messageId, fields] of streamMessages) {
              const message = this.parseRedisMessage(fields);
              message.id = messageId;
              
              try {
                await processor(message);
                
                // Acknowledge message
                await this.redis.xack(streamName, consumerGroup, messageId);
                
              } catch (error) {
                logger.error(`[PipelineCoordinator] Error processing ${stage} message`, {
                  messageId,
                  error: error.message
                });
              }
            }
          }
        }
      } catch (error) {
        if (!error.message.includes('NOGROUP')) {
          logger.error(`[PipelineCoordinator] Consumer error for ${stage}`, {
            error: error.message
          });
        }
      }
      
      // Continue consuming
      if (this.state.isActive) {
        setImmediate(consumeMessages);
      }
    };
    
    consumeMessages();
  }

  /**
   * Process STT message
   * @param {object} message - STT message
   */
  async processSTTMessage(message) {
    const { processId, audioData, timestamp } = message;
    
    logger.debug('[PipelineCoordinator] Processing STT message', { processId });
    
    try {
      // Update process status
      const process = this.state.pendingProcesses.get(processId);
      if (process) {
        process.stages[this.stages.STT].status = 'processing';
        process.stages[this.stages.STT].startTime = performance.now();
      }
      
      // Process with STT service
      const speechToText = require('./speechToText');
      const audioBuffer = Buffer.from(audioData, 'base64');
      
      // For WebRTC, we'd process the audio buffer directly
      // For now, simulate STT processing
      const transcription = await speechToText.processAudioBuffer(audioBuffer);
      
      if (transcription && transcription.text) {
        // Update process status
        if (process) {
          process.stages[this.stages.STT].status = 'completed';
          process.stages[this.stages.STT].endTime = performance.now();
        }
        
        // Forward to LLM stage
        await this.redis.xadd(
          this.streamNames[this.stages.LLM],
          '*',
          'processId', processId,
          'transcription', transcription.text,
          'confidence', transcription.confidence || 1.0,
          'timestamp', timestamp,
          'stage', this.stages.LLM
        );
        
        logger.debug('[PipelineCoordinator] STT completed', {
          processId,
          transcription: transcription.text.substring(0, 50)
        });
      }
      
    } catch (error) {
      logger.error('[PipelineCoordinator] STT processing failed', {
        processId,
        error: error.message
      });
      
      this.handleProcessingError(processId, this.stages.STT, error);
    }
  }

  /**
   * Process LLM message
   * @param {object} message - LLM message
   */
  async processLLMMessage(message) {
    const { processId, transcription, confidence } = message;
    
    logger.debug('[PipelineCoordinator] Processing LLM message', { processId });
    
    try {
      // Update process status
      const process = this.state.pendingProcesses.get(processId);
      if (process) {
        process.stages[this.stages.LLM].status = 'processing';
        process.stages[this.stages.LLM].startTime = performance.now();
      }
      
      // Check for predictive cache hit
      const predictionKey = this.findPredictiveMatch(transcription);
      if (predictionKey) {
        logger.info('[PipelineCoordinator] Using predictive cache', {
          processId,
          predictionKey
        });
        
        const prediction = this.predictiveBuffer.get(predictionKey);
        prediction.used = true;
        
        // Skip to audio stage
        await this.redis.xadd(
          this.streamNames[this.stages.AUDIO],
          '*',
          'processId', processId,
          'audioUrl', prediction.audioUrl,
          'text', prediction.text,
          'predictive', 'true',
          'stage', this.stages.AUDIO
        );
        
        return;
      }
      
      // Process with LLM service (streaming)
      const { createStreamingHandler } = require('./streamingConversation');
      const streamingHandler = createStreamingHandler(this.userId, this.callSid);
      
      // Set up streaming handlers
      streamingHandler.on('sentence', (data) => {
        // Forward each sentence to TTS stage
        this.redis.xadd(
          this.streamNames[this.stages.TTS],
          '*',
          'processId', processId,
          'text', data.text,
          'index', data.index,
          'isFirst', data.isFirst,
          'stage', this.stages.TTS
        );
      });
      
      streamingHandler.on('complete', (data) => {
        // Update process status
        if (process) {
          process.stages[this.stages.LLM].status = 'completed';
          process.stages[this.stages.LLM].endTime = performance.now();
        }
        
        logger.debug('[PipelineCoordinator] LLM completed', {
          processId,
          responseLength: data.fullResponse.length
        });
      });
      
      // Start streaming processing
      await streamingHandler.processStreamingResponse(transcription);
      
    } catch (error) {
      logger.error('[PipelineCoordinator] LLM processing failed', {
        processId,
        error: error.message
      });
      
      this.handleProcessingError(processId, this.stages.LLM, error);
    }
  }

  /**
   * Process TTS message
   * @param {object} message - TTS message
   */
  async processTTSMessage(message) {
    const { processId, text, index, isFirst } = message;
    
    logger.debug('[PipelineCoordinator] Processing TTS message', { processId, index });
    
    try {
      // Update process status
      const process = this.state.pendingProcesses.get(processId);
      if (process) {
        process.stages[this.stages.TTS].status = 'processing';
        process.stages[this.stages.TTS].startTime = performance.now();
      }
      
      // Process with TTS service
      const { createTTSQueue } = require('./ttsQueue');
      const ttsQueue = createTTSQueue();
      
      const itemId = ttsQueue.enqueue(text, {
        index: parseInt(index),
        isFirst: isFirst === 'true',
        priority: isFirst === 'true' ? 4 : 2
      });
      
      // Wait for completion
      ttsQueue.on('completed', (item) => {
        if (item.id === itemId) {
          // Forward to audio stage
          this.redis.xadd(
            this.streamNames[this.stages.AUDIO],
            '*',
            'processId', processId,
            'audioUrl', item.audioUrl,
            'text', text,
            'index', index,
            'isFirst', isFirst,
            'stage', this.stages.AUDIO
          );
          
          logger.debug('[PipelineCoordinator] TTS completed', {
            processId,
            itemId,
            audioUrl: item.audioUrl
          });
        }
      });
      
    } catch (error) {
      logger.error('[PipelineCoordinator] TTS processing failed', {
        processId,
        error: error.message
      });
      
      this.handleProcessingError(processId, this.stages.TTS, error);
    }
  }

  /**
   * Process audio message
   * @param {object} message - Audio message
   */
  async processAudioMessage(message) {
    const { processId, audioUrl, text, index, isFirst } = message;
    
    logger.debug('[PipelineCoordinator] Processing audio message', { processId, index });
    
    try {
      // Update process status
      const process = this.state.pendingProcesses.get(processId);
      if (process) {
        process.stages[this.stages.AUDIO].status = 'completed';
        process.stages[this.stages.AUDIO].endTime = performance.now();
      }
      
      // Emit audio ready event
      this.emit('audioReady', {
        processId,
        audioUrl,
        text,
        index: parseInt(index),
        isFirst: isFirst === 'true'
      });
      
      // Check if process is complete
      this.checkProcessCompletion(processId);
      
    } catch (error) {
      logger.error('[PipelineCoordinator] Audio processing failed', {
        processId,
        error: error.message
      });
      
      this.handleProcessingError(processId, this.stages.AUDIO, error);
    }
  }

  /**
   * Check if a process is complete
   * @param {string} processId - Process ID
   */
  checkProcessCompletion(processId) {
    const process = this.state.pendingProcesses.get(processId);
    if (!process) return;
    
    const allCompleted = Object.values(process.stages).every(stage => 
      stage.status === 'completed'
    );
    
    if (allCompleted) {
      // Calculate metrics
      const totalLatency = performance.now() - process.startTime;
      const stageLatencies = {};
      
      for (const [stage, data] of Object.entries(process.stages)) {
        if (data.startTime && data.endTime) {
          stageLatencies[stage] = data.endTime - data.startTime;
        }
      }
      
      // Move to completed
      this.state.pendingProcesses.delete(processId);
      this.state.completedProcesses.set(processId, {
        ...process,
        completedAt: performance.now(),
        totalLatency,
        stageLatencies
      });
      
      // Emit completion event
      this.emit('processComplete', {
        processId,
        totalLatency,
        stageLatencies
      });
      
      logger.info('[PipelineCoordinator] Process completed', {
        processId,
        totalLatency,
        stageLatencies
      });
    }
  }

  /**
   * Handle processing errors
   * @param {string} processId - Process ID
   * @param {string} stage - Stage where error occurred
   * @param {Error} error - Error object
   */
  handleProcessingError(processId, stage, error) {
    const process = this.state.pendingProcesses.get(processId);
    if (process) {
      process.stages[stage].status = 'failed';
      process.stages[stage].error = error.message;
    }
    
    this.state.metrics.errors++;
    
    this.emit('processError', {
      processId,
      stage,
      error: error.message
    });
  }

  /**
   * Find predictive match for transcription
   * @param {string} transcription - User transcription
   * @returns {string|null} - Prediction key or null
   */
  findPredictiveMatch(transcription) {
    // Simple matching - in production, use semantic similarity
    const lowerTranscription = transcription.toLowerCase();
    
    for (const [key, prediction] of this.predictiveBuffer) {
      if (!prediction.used && lowerTranscription.includes('help')) {
        return key;
      }
    }
    
    return null;
  }

  /**
   * Clean up old predictive buffer entries
   */
  cleanupPredictiveBuffer() {
    const now = Date.now();
    const maxAge = 30000; // 30 seconds
    
    for (const [key, prediction] of this.predictiveBuffer) {
      if (now - prediction.timestamp > maxAge || prediction.used) {
        this.predictiveBuffer.delete(key);
      }
    }
  }

  /**
   * Parse Redis message fields
   * @param {Array} fields - Redis message fields
   * @returns {object} - Parsed message
   */
  parseRedisMessage(fields) {
    const message = {};
    for (let i = 0; i < fields.length; i += 2) {
      message[fields[i]] = fields[i + 1];
    }
    return message;
  }

  /**
   * Load predictive models
   */
  async loadPredictiveModels() {
    // In production, load ML models here
    logger.info('[PipelineCoordinator] Loading predictive models');
    
    // Load common phrases from cache
    try {
      const commonPhrasesData = await this.redis.get(`common_phrases:${this.userId}`);
      if (commonPhrasesData) {
        this.commonPhrases = new Map(JSON.parse(commonPhrasesData));
      }
    } catch (error) {
      logger.warn('[PipelineCoordinator] Failed to load common phrases', {
        error: error.message
      });
    }
  }

  /**
   * Get current metrics
   * @returns {object} - Current metrics
   */
  getMetrics() {
    return {
      ...this.state.metrics,
      pendingProcesses: this.state.pendingProcesses.size,
      completedProcesses: this.state.completedProcesses.size,
      predictiveBufferSize: this.predictiveBuffer.size,
      isActive: this.state.isActive
    };
  }

  /**
   * Clean up resources
   */
  async cleanup() {
    logger.info('[PipelineCoordinator] Cleaning up resources');
    
    this.state.isActive = false;
    
    // Clean up Redis streams
    for (const streamName of Object.values(this.streamNames)) {
      try {
        await this.redis.del(streamName);
      } catch (error) {
        logger.warn('[PipelineCoordinator] Failed to cleanup stream', {
          streamName,
          error: error.message
        });
      }
    }
    
    // Clear buffers
    this.predictiveBuffer.clear();
    this.commonPhrases.clear();
    this.state.pendingProcesses.clear();
    this.state.completedProcesses.clear();
    
    // Close Redis connection
    await this.redis.quit();
    
    this.removeAllListeners();
  }
}

/**
 * Create pipeline coordinator
 * @param {object} options - Options
 * @returns {PipelineCoordinator}
 */
const createPipelineCoordinator = (options) => {
  return new PipelineCoordinator(options);
};

module.exports = {
  createPipelineCoordinator,
  PipelineCoordinator
};